"""A waiting message can be taken back, and a stalled queue can be continued.

#379: a supplementary message waits for the active turn. These cases pin what
happens around that wait: a message that has not started can be withdrawn, a
message that has started cannot, and a queue left behind by a failed turn waits
for the user instead of running on its own and then can be continued by hand.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import threading
from uuid import UUID, uuid4, uuid5

from fastapi.testclient import TestClient
import pytest

from opendirector.infrastructure.local_projects import LocalProjects
from opendirector_api.main import create_app
from opendirector_api import agent


def frames(response):
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]


async def empty_skills(*args):
    return []


@pytest.fixture
def assistant(tmp_path, monkeypatch):
    """A project whose turns block until the test lets them finish."""
    contexts = []
    gate = {'started': threading.Event(), 'release': threading.Event(), 'fail': threading.Event()}

    async def stream(self, run):
        contexts.append(run.messages)
        gate['started'].set()
        yield {'type': 'delta', 'text': '收到：' + run.messages[-1]['content']}
        await asyncio.to_thread(gate['release'].wait, 10)
        if gate['fail'].is_set():
            raise RuntimeError('provider down')
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
            'commandId': str(uuid4()), 'payload': {'name': '撤回'}}).status_code == 200
        assert client.post(root + '/open').status_code == 200
        yield client, root + '/assistant', contexts, gate


def test_a_queued_message_can_be_taken_back_before_it_runs(assistant):
    client, path, contexts, gate = assistant
    cid = client.get(path).json()['conversationId']
    first, second = str(uuid4()), str(uuid4())
    with ThreadPoolExecutor() as pool:
        running = pool.submit(client.post, path + '/turns', json={
            'id': first, 'runtime': 'default', 'conversationId': cid, 'text': '先做这个'})
        assert gate['started'].wait(5)
        assert client.post(path + '/messages', json={
            'id': second, 'runtime': 'default', 'conversationId': cid, 'text': '再补一句'}).status_code == 202
        taken = client.delete(path + f'/messages/{second}')
        assert taken.status_code == 200, taken.text
        assert taken.json()['retracted'] == second
        # The message is gone from the thread the user is reading, while the
        # turn that is still running keeps its own reply in place.
        assert [item['id'] for item in taken.json()['conversation']['messages']] == [
            first, str(uuid5(UUID(first), 'assistant'))]
        gate['release'].set()
        events = frames(running.result(timeout=10))

    # The turn that was already running is not disturbed, and nothing runs after it.
    assert [event['turnId'] for event in events if event['type'] == 'end'] == [first]
    assert [context[-1]['content'] for context in contexts] == ['先做这个']
    assert [item['status'] for item in client.get(path).json()['messages']] == ['complete', 'complete']


def test_a_message_that_already_started_is_stopped_not_removed(assistant):
    client, path, contexts, gate = assistant
    cid = client.get(path).json()['conversationId']
    first = str(uuid4())
    with ThreadPoolExecutor() as pool:
        running = pool.submit(client.post, path + '/turns', json={
            'id': first, 'runtime': 'default', 'conversationId': cid, 'text': '做到一半'})
        assert gate['started'].wait(5)
        started = client.delete(path + f'/messages/{first}')
        assert started.status_code == 409 and '已经开始执行' in started.json()['detail']
        unknown = client.delete(path + f'/messages/{uuid4()}')
        assert unknown.status_code == 404 and '不在当前对话里' in unknown.json()['detail']
        gate['release'].set()
        frames(running.result(timeout=10))

    # A message that has begun is part of the record: it stays, with its reply.
    assert [item['status'] for item in client.get(path).json()['messages']] == ['complete', 'complete']
    assert len(contexts) == 1


def test_a_failed_turn_leaves_the_queue_to_be_continued_by_hand(assistant):
    client, path, contexts, gate = assistant
    cid = client.get(path).json()['conversationId']
    first, second = str(uuid4()), str(uuid4())
    gate['fail'].set()
    with ThreadPoolExecutor() as pool:
        running = pool.submit(client.post, path + '/turns', json={
            'id': first, 'runtime': 'default', 'conversationId': cid, 'text': '先做这个'})
        assert gate['started'].wait(5)
        assert client.post(path + '/messages', json={
            'id': second, 'runtime': 'default', 'conversationId': cid, 'text': '补一句'}).status_code == 202
        gate['release'].set()
        events = frames(running.result(timeout=10))

    assert events[-1]['error'] is not None
    # A failure does not spend the queue by itself, and it is not silent about it.
    assert [item['status'] for item in client.get(path).json()['messages']] == [
        'complete', 'interrupted', 'queued']
    assert [context[-1]['content'] for context in contexts] == ['先做这个']

    gate['fail'].clear()
    continued = client.post(path + '/queue/dispatch')
    assert continued.status_code == 200, continued.text
    tail = frames(continued)
    assert tail[-1]['conversation']['messages'][-1]['text'] == '收到：补一句｜完'
    # Nothing is left waiting, so continuing again has nothing to start.
    assert client.post(path + '/queue/dispatch').status_code == 409
    assert 'activeTurnId' not in client.get(path).json()
