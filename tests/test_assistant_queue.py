"""A message sent while a turn runs is queued and runs when that turn ends.

#379: the project accepts one reply at a time, so a supplementary message used
to be refused outright. These cases pin the delivery guarantee: the message is
stored at once, it runs in order after the active turn, and stopping or
rejecting cannot leave a message that runs later by surprise.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import threading
import time
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from opendirector.infrastructure.local_projects import LocalProjects
from opendirector_api.main import create_app
from opendirector_api import agent


def frames(response):
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]


def wait_until(condition, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.01)
    return False


def replay(events, after=0):
    """Collect one chain's replay exactly as a viewer receives it."""
    async def collect():
        return [json.loads(chunk.removeprefix('data: '))
                for chunk in [item async for item in events.follow(after)]]
    return asyncio.run(collect())


async def empty_skills(*args):
    return []


@pytest.fixture
def assistant(tmp_path, monkeypatch):
    """A project whose first turn blocks until the test lets it finish."""
    contexts = []
    gate = {'started': threading.Event(), 'release': threading.Event()}

    async def stream(self, run):
        contexts.append(run.messages)
        gate['started'].set()
        yield {'type': 'delta', 'text': '收到：' + run.messages[-1]['content']}
        await asyncio.to_thread(gate['release'].wait, 10)
        yield {'type': 'delta', 'text': '｜完'}

    monkeypatch.setattr(agent.AgentRuntimes, 'stream', stream)
    monkeypatch.setattr(agent, 'runtime_available', lambda _: True)
    monkeypatch.setattr(agent, 'skills', empty_skills)
    from opendirector.infrastructure.model_configs import ModelConfigs
    monkeypatch.setattr(ModelConfigs, 'resolve', lambda *args: {'id': str(uuid4()), 'modelId': 'test-model'})
    with TestClient(create_app(LocalProjects(tmp_path)), headers={
        'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': str(uuid4())}) as client:
        pid = str(uuid4())
        root = f'/api/creation/projects/{pid}'
        assert client.post(root + '/commands', json={'type': 'project.create', 'projectId': pid,
            'commandId': str(uuid4()), 'payload': {'name': '排队'}}).status_code == 200
        assert client.post(root + '/open').status_code == 200
        try:
            yield client, root + '/assistant', contexts, gate
        finally:
            # A cancelled run is still waiting on this gate in a worker thread;
            # releasing it lets the client shut down without waiting out the wait.
            gate['release'].set()



@pytest.fixture
def gated(tmp_path, monkeypatch):
    """A project whose every turn waits for a release of its own."""
    contexts = []
    gates = {}

    async def stream(self, run):
        text = run.messages[-1]['content']
        contexts.append(text)
        gates.setdefault(text, threading.Event())
        yield {'type': 'delta', 'text': '收到：' + text}
        await asyncio.to_thread(gates[text].wait, 10)
        yield {'type': 'delta', 'text': '｜完'}

    monkeypatch.setattr(agent.AgentRuntimes, 'stream', stream)
    monkeypatch.setattr(agent, 'runtime_available', lambda _: True)
    monkeypatch.setattr(agent, 'skills', empty_skills)
    from opendirector.infrastructure.model_configs import ModelConfigs
    monkeypatch.setattr(ModelConfigs, 'resolve', lambda *args: {'id': str(uuid4()), 'modelId': 'test-model'})
    with TestClient(create_app(LocalProjects(tmp_path)), headers={
        'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': str(uuid4())}) as client:
        pid = str(uuid4())
        root = f'/api/creation/projects/{pid}'
        assert client.post(root + '/commands', json={'type': 'project.create', 'projectId': pid,
            'commandId': str(uuid4()), 'payload': {'name': '续读'}}).status_code == 200
        assert client.post(root + '/open').status_code == 200
        try:
            yield client, root + '/assistant', contexts, gates
        finally:
            for waiting in gates.values():
                waiting.set()

def test_supplementary_message_waits_for_the_running_turn_and_then_runs(assistant):
    client, path, contexts, gate = assistant
    cid = client.get(path).json()['conversationId']
    first, second = str(uuid4()), str(uuid4())
    with ThreadPoolExecutor() as pool:
        running = pool.submit(client.post, path + '/turns', json={
            'id': first, 'runtime': 'default', 'conversationId': cid, 'text': '先做这个'})
        assert gate['started'].wait(5)
        sent = client.post(path + '/messages', json={
            'id': second, 'runtime': 'default', 'conversationId': cid, 'text': '再补一句'})
        assert sent.status_code == 202, sent.text
        assert sent.json()['queued']['status'] == 'queued'
        assert sent.json()['queued']['id'] == second and sent.json()['turnId'] == first
        # The viewer sees the supplementary message at once, without waiting.
        waiting = client.get(path).json()
        assert [item['status'] for item in waiting['messages']] == ['complete', 'streaming', 'queued']
        assert waiting['activeTurnId'] == first
        gate['release'].set()
        events = frames(running.result(timeout=10))

    ending = [event for event in events if event['type'] == 'end']
    # The message is queued, not merged: it becomes its own turn on the same stream.
    assert [event['turnId'] for event in ending] == [first, second]
    assert ending[0]['nextTurnId'] == second
    assert ending[-1]['nextTurnId'] is None and ending[-1]['error'] is None
    messages = ending[-1]['conversation']['messages']
    assert [(item['role'], item['status']) for item in messages] == [
        ('user', 'complete'), ('assistant', 'complete'), ('user', 'complete'), ('assistant', 'complete')]
    assert [item['text'] for item in messages if item['role'] == 'assistant'] == [
        '收到：先做这个｜完', '收到：再补一句｜完']
    assert [context[-1]['content'] for context in contexts] == ['先做这个', '再补一句']
    assert 'activeTurnId' not in client.get(path).json()


def test_one_stream_carries_every_turn_and_replays_from_a_cursor():
    events = agent.RunEvents()
    events.put({'type': 'start'})
    events.put({'type': 'end', 'turnId': 't1', 'nextTurnId': 't2'})
    events.put({'type': 'start'})
    events.put({'type': 'end', 'turnId': 't2', 'nextTurnId': None})

    # An end that names the next turn does not close the stream: the queued
    # message runs on the connection the viewer already has open.
    assert [frame['seq'] for frame in replay(events)] == [0, 1, 2, 3]
    assert [frame['seq'] for frame in replay(events, 2)] == [2, 3]
    # A cursor past the end of a finished chain ends at once instead of waiting.
    assert replay(events, 9) == []


def test_events_endpoint_resumes_from_the_cursor_the_viewer_sent(assistant, monkeypatch):
    client, path, _, gate = assistant
    seen = []
    original = agent.RunEvents.follow

    async def recorded(self, after=0):
        seen.append(after)
        async for item in original(self, after):
            yield item

    monkeypatch.setattr(agent.RunEvents, 'follow', recorded)
    cid = client.get(path).json()['conversationId']
    turn = str(uuid4())
    with ThreadPoolExecutor() as pool:
        running = pool.submit(client.post, path + '/turns', json={
            'id': turn, 'runtime': 'default', 'conversationId': cid, 'text': '长任务'})
        assert gate['started'].wait(5)
        tail = pool.submit(client.get, path + f'/turns/{turn}/events?after=1')
        assert wait_until(lambda: len(seen) >= 2), seen
        gate['release'].set()
        resumed = frames(tail.result(timeout=10))
        whole = frames(running.result(timeout=10))

    assert seen == [0, 1]
    # The viewer receives exactly the frames that follow the one it already has.
    assert resumed == whole[1:]


def test_stop_cancels_the_chain_and_leaves_queued_messages_cancelled(assistant):
    client, path, contexts, gate = assistant
    cid = client.get(path).json()['conversationId']
    first, second = str(uuid4()), str(uuid4())
    with ThreadPoolExecutor() as pool:
        running = pool.submit(client.post, path + '/turns', json={
            'id': first, 'runtime': 'default', 'conversationId': cid, 'text': '做到一半'})
        assert gate['started'].wait(5)
        assert client.post(path + '/messages', json={
            'id': second, 'runtime': 'default', 'conversationId': cid, 'text': '还没轮到'}).status_code == 202
        assert client.post(path + f'/turns/{first}/stop').status_code == 200
        events = frames(running.result(timeout=10))

    assert events[-1]['type'] == 'end' and events[-1]['nextTurnId'] is None
    # Stopping ends the whole chain: the queued message never runs, and it stays
    # readable so the user can send it again deliberately.
    assert [item['status'] for item in client.get(path).json()['messages']] == [
        'complete', 'stopped', 'cancelled']
    assert len(contexts) == 1


def test_supplementary_message_that_cannot_run_is_rejected_before_it_is_queued(assistant, monkeypatch):
    client, path, contexts, gate = assistant
    cid = client.get(path).json()['conversationId']
    first = str(uuid4())
    with ThreadPoolExecutor() as pool:
        running = pool.submit(client.post, path + '/turns', json={
            'id': first, 'runtime': 'default', 'conversationId': cid, 'text': '先做'})
        assert gate['started'].wait(5)
        before = len(client.get(path).json()['messages'])
        monkeypatch.setattr(agent, 'runtime_available', lambda _: False)
        missing = client.post(path + '/messages', json={
            'id': str(uuid4()), 'runtime': 'codex', 'conversationId': cid, 'text': '发不出去'})
        assert missing.status_code == 503 and '未安装' in missing.json()['detail']
        monkeypatch.setattr(agent, 'runtime_available', lambda _: True)
        stale = client.post(path + '/messages', json={
            'id': str(uuid4()), 'runtime': 'default', 'conversationId': str(uuid4()), 'text': '发错会话'})
        assert stale.status_code == 409
        # A rejected message is visible to the sender now, not after the active turn:
        # the queue never holds work that was known to be unsendable.
        assert len(client.get(path).json()['messages']) == before
        gate['release'].set()
        frames(running.result(timeout=10))
    assert len(contexts) == 1


def test_idle_message_endpoint_starts_a_turn_and_keeps_message_ids_unique(assistant):
    client, path, _, gate = assistant
    cid = client.get(path).json()['conversationId']
    turn = str(uuid4())
    with ThreadPoolExecutor() as pool:
        started = pool.submit(client.post, path + '/messages', json={
            'id': turn, 'runtime': 'default', 'conversationId': cid, 'text': '直接说'})
        assert gate['started'].wait(5)
        gate['release'].set()
        response = started.result(timeout=10)

    # With nothing running the same endpoint starts the turn, so a client never
    # has to guess whether the active turn has already finished.
    assert response.status_code == 200
    events = frames(response)
    assert events[0]['type'] == 'start'
    assert events[-1]['conversation']['messages'][-1]['text'] == '收到：直接说｜完'
    duplicate = client.post(path + '/messages', json={
        'id': turn, 'runtime': 'default', 'conversationId': cid, 'text': '重复发送'})
    assert duplicate.status_code == 409


def test_a_viewer_that_lost_the_stream_resumes_through_the_turn_it_remembers(gated):
    """Reconnecting between two turns still finds the chain.

    The viewer knows the turn it was watching, not the one that started while it
    was away. Refusing that turn would leave it with a frozen conversation until
    it thought to reload.
    """
    client, path, contexts, gates = gated
    cid = client.get(path).json()['conversationId']
    first, second = str(uuid4()), str(uuid4())
    with ThreadPoolExecutor() as pool:
        running = pool.submit(client.post, path + '/turns', json={
            'id': first, 'runtime': 'default', 'conversationId': cid, 'text': '先做这个'})
        assert wait_until(lambda: '先做这个' in gates)
        assert client.post(path + '/messages', json={
            'id': second, 'runtime': 'default', 'conversationId': cid, 'text': '再补一句'}).status_code == 202
        gates['先做这个'].set()
        assert wait_until(lambda: '再补一句' in gates), contexts
        # A turn from somewhere else is still refused: only this chain's own
        # finished turn is enough to find this chain.
        assert client.get(path + f'/turns/{uuid4()}/events').status_code == 404
        with client.stream('GET', path + f'/turns/{first}/events') as response:
            assert response.status_code == 200
            gates['再补一句'].set()
            lines = [line for line in response.iter_lines() if line.startswith('data: ')]
        resumed = [json.loads(line[6:]) for line in lines]
        whole = frames(running.result(timeout=10))

    assert resumed == whole
    assert [context for context in contexts] == ['先做这个', '再补一句']
