"""A failed chain must not let a later message overtake older queued work.

#521: when a turn fails, later queued messages stay waiting for an explicit
retry. A new direct submission must not run ahead of them, and the queue must
not start on its own after a failure or a process restart.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import threading
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from opendirector.infrastructure.local_projects import LocalProjects
from opendirector_api.main import create_app
from opendirector_api import agent


def frames(response):
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]


def statuses(client, path):
    return [item['status'] for item in client.get(path).json()['messages']]


def texts(contexts):
    return [context[-1]['content'] for context in contexts]


async def empty_skills(*args):
    return []


@pytest.fixture
def assistant(tmp_path, monkeypatch):
    """A project whose turns can be released or failed by the test."""
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
    config = {'id': str(uuid4()), 'modelId': 'test-model', 'kind': 'agent', 'url': 'http://models.test/v1',
              'connectionType': 'api', 'protocol': 'openai', 'authMode': 'none', 'apiKey': ''}
    monkeypatch.setattr(ModelConfigs, 'resolve', lambda *args, **kwargs: dict(config))
    with TestClient(create_app(LocalProjects(tmp_path)), headers={
        'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': str(uuid4())}) as client:
        pid = str(uuid4())
        root = f'/api/creation/projects/{pid}'
        assert client.post(root + '/commands', json={'type': 'project.create', 'projectId': pid,
            'commandId': str(uuid4()), 'payload': {'name': '排队准入'}}).status_code == 200
        assert client.post(root + '/open').status_code == 200
        try:
            yield client, root + '/assistant', contexts, gate, tmp_path
        finally:
            gate['release'].set()


def fail_first_turn_with_queued(assistant, queued_texts):
    """Run one turn that fails, leaving the given messages queued behind it."""
    client, path, contexts, gate, _ = assistant
    cid = client.get(path).json()['conversationId']
    first = str(uuid4())
    queued_ids = [str(uuid4()) for _ in queued_texts]
    gate['fail'].set()
    gate['started'].clear()
    gate['release'].clear()
    with ThreadPoolExecutor() as pool:
        running = pool.submit(client.post, path + '/turns', json={
            'id': first, 'runtime': 'default', 'conversationId': cid, 'text': '一'})
        assert gate['started'].wait(5)
        for message_id, text in zip(queued_ids, queued_texts):
            sent = client.post(path + '/messages', json={
                'id': message_id, 'runtime': 'default', 'conversationId': cid, 'text': text})
            assert sent.status_code == 202, sent.text
        gate['release'].set()
        events = frames(running.result(timeout=10))
    assert events[-1]['error'] is not None
    assert texts(contexts) == ['一']
    return cid, first, queued_ids


def test_a_new_direct_turn_does_not_run_ahead_of_a_stranded_queue(assistant):
    """A later /turns submission must not execute before the older queued message."""
    client, path, contexts, gate, _ = assistant
    cid, _, [second] = fail_first_turn_with_queued(assistant, ['二'])
    assert statuses(client, path) == ['complete', 'interrupted', 'queued']

    gate['fail'].clear()
    gate['started'].clear()
    gate['release'].clear()
    third = str(uuid4())
    # The UI still starts a new message with /turns when the project looks idle.
    jumped = client.post(path + '/turns', json={
        'id': third, 'runtime': 'default', 'conversationId': cid, 'text': '三'})
    assert jumped.status_code == 409, jumped.text
    assert statuses(client, path) == ['complete', 'interrupted', 'queued', 'queued']
    assert [item['text'] for item in client.get(path).json()['messages'] if item['role'] == 'user'] == [
        '一', '二', '三']
    assert texts(contexts) == ['一']
    assert 'activeTurnId' not in client.get(path).json()

    gate['release'].set()
    continued = client.post(path + '/queue/dispatch')
    assert continued.status_code == 200, continued.text
    ending = [event for event in frames(continued) if event['type'] == 'end']
    assert [event['turnId'] for event in ending] == [second, third]
    assert ending[-1]['error'] is None
    # Context bounding for a dispatched turn is #518; this issue only pins order.
    assert len(contexts) == 3
    messages = ending[-1]['conversation']['messages']
    assert [item['id'] for item in messages if item['role'] == 'user'] == [
        client.get(path).json()['messages'][0]['id'], second, third]
    assert [item['status'] for item in messages if item['role'] == 'user'] == [
        'complete', 'complete', 'complete']
    assert 'activeTurnId' not in client.get(path).json()


def test_idle_message_endpoint_appends_behind_a_stranded_queue_without_starting(assistant):
    client, path, contexts, gate, _ = assistant
    cid, _, [second] = fail_first_turn_with_queued(assistant, ['二'])
    gate['fail'].clear()
    third = str(uuid4())
    sent = client.post(path + '/messages', json={
        'id': third, 'runtime': 'default', 'conversationId': cid, 'text': '三'})
    assert sent.status_code == 202, sent.text
    assert sent.json()['queued']['id'] == third
    assert statuses(client, path) == ['complete', 'interrupted', 'queued', 'queued']
    assert texts(contexts) == ['一']

    continued = client.post(path + '/queue/dispatch')
    assert continued.status_code == 200, continued.text
    ending = [event for event in frames(continued) if event['type'] == 'end']
    assert [event['turnId'] for event in ending] == [second, third]
    assert len(contexts) == 3
    assert statuses(client, path)[-4:] == ['complete', 'complete', 'complete', 'complete']


def test_explicit_retry_runs_multiple_queued_messages_in_submission_order(assistant):
    client, path, contexts, gate, _ = assistant
    cid, _, [second, third] = fail_first_turn_with_queued(assistant, ['二', '三'])
    fourth = str(uuid4())
    assert client.post(path + '/turns', json={
        'id': fourth, 'runtime': 'default', 'conversationId': cid, 'text': '四'}).status_code == 409
    gate['fail'].clear()
    continued = client.post(path + '/queue/dispatch')
    assert continued.status_code == 200, continued.text
    ending = [event for event in frames(continued) if event['type'] == 'end']
    assert [event['turnId'] for event in ending] == [second, third, fourth]
    assert len(contexts) == 4
    assert [item['status'] for item in ending[-1]['conversation']['messages'] if item['role'] == 'user'] == [
        'complete', 'complete', 'complete', 'complete']
    assert client.post(path + '/queue/dispatch').status_code == 409


def test_restart_does_not_replay_a_stranded_queue(assistant, monkeypatch):
    client, path, _, _, root = assistant
    fail_first_turn_with_queued(assistant, ['二'])
    assert statuses(client, path) == ['complete', 'interrupted', 'queued']
    # A new process sees the same files but must not start the leftover queue.
    monkeypatch.setattr(agent, 'runtime_available', lambda _: True)
    monkeypatch.setattr(agent, 'skills', empty_skills)
    from opendirector.infrastructure.model_configs import ModelConfigs
    config = {'id': str(uuid4()), 'modelId': 'test-model', 'kind': 'agent', 'url': 'http://models.test/v1',
              'connectionType': 'api', 'protocol': 'openai', 'authMode': 'none', 'apiKey': ''}
    monkeypatch.setattr(ModelConfigs, 'resolve', lambda *args, **kwargs: dict(config))
    restarted_contexts = []

    async def stream(self, run):
        restarted_contexts.append(run.messages)
        yield {'type': 'delta', 'text': '重启：' + run.messages[-1]['content']}

    monkeypatch.setattr(agent.AgentRuntimes, 'stream', stream)
    with TestClient(create_app(LocalProjects(root)), headers={
        'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': str(uuid4())}) as restarted:
        assert statuses(restarted, path) == ['complete', 'interrupted', 'queued']
        assert restarted_contexts == []
        assert 'activeTurnId' not in restarted.get(path).json()


def test_stop_still_cancels_the_queue_and_does_not_block_a_later_turn(assistant):
    client, path, contexts, gate, _ = assistant
    cid = client.get(path).json()['conversationId']
    first, second, third = str(uuid4()), str(uuid4()), str(uuid4())
    with ThreadPoolExecutor() as pool:
        running = pool.submit(client.post, path + '/turns', json={
            'id': first, 'runtime': 'default', 'conversationId': cid, 'text': '做到一半'})
        assert gate['started'].wait(5)
        assert client.post(path + '/messages', json={
            'id': second, 'runtime': 'default', 'conversationId': cid, 'text': '还没轮到'}).status_code == 202
        assert client.post(path + f'/turns/{first}/stop').status_code == 200
        frames(running.result(timeout=10))
    assert statuses(client, path) == ['complete', 'stopped', 'cancelled']
    assert client.post(path + '/queue/dispatch').status_code == 409
    gate['started'].clear()
    gate['release'].clear()
    with ThreadPoolExecutor() as pool:
        started = pool.submit(client.post, path + '/turns', json={
            'id': third, 'runtime': 'default', 'conversationId': cid, 'text': '重新说'})
        assert gate['started'].wait(5)
        gate['release'].set()
        assert started.result(timeout=10).status_code == 200
    assert texts(contexts) == ['做到一半', '重新说']


def test_duplicate_message_ids_stay_idempotent_on_a_stranded_queue(assistant):
    client, path, contexts, _, _ = assistant
    cid, _, [second] = fail_first_turn_with_queued(assistant, ['二'])
    duplicate = client.post(path + '/turns', json={
        'id': second, 'runtime': 'default', 'conversationId': cid, 'text': '二'})
    assert duplicate.status_code == 409
    assert statuses(client, path) == ['complete', 'interrupted', 'queued']
    again = client.post(path + '/messages', json={
        'id': second, 'runtime': 'default', 'conversationId': cid, 'text': '二'})
    assert again.status_code == 409
    assert texts(contexts) == ['一']


def test_dispatch_is_refused_while_a_turn_is_running(assistant):
    client, path, _, gate, _ = assistant
    cid = client.get(path).json()['conversationId']
    first = str(uuid4())
    with ThreadPoolExecutor() as pool:
        running = pool.submit(client.post, path + '/turns', json={
            'id': first, 'runtime': 'default', 'conversationId': cid, 'text': '一'})
        assert gate['started'].wait(5)
        assert client.post(path + '/queue/dispatch').status_code == 409
        gate['release'].set()
        frames(running.result(timeout=10))
    assert client.post(path + '/queue/dispatch').status_code == 409
