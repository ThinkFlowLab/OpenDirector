"""Text handed to a turn that is already running (#379, insert delivery).

Queueing runs a supplement after the reply. Inserting reaches the model inside
the same turn, so the reply keeps the work it has already done. The runtime
decides whether that is possible; the API only forwards and records it.
"""
import asyncio
import threading
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from opendirector.infrastructure.local_projects import LocalProjects
from opendirector_api.main import create_app
from opendirector_api import agent


async def empty_skills(*args):
    return []


@pytest.fixture
def assistant(tmp_path, monkeypatch):
    """A turn that stalls until a supplement arrives, then reports it."""
    ready = threading.Event()
    release = threading.Event()

    async def stream(self, run):
        ready.set()
        yield {'type': 'delta', 'text': '正在做'}
        if run.steer is not None:
            # A refused supplement never arrives; the turn must still end.
            try:
                text = await asyncio.wait_for(run.steer.get(), timeout=5)
            except TimeoutError:
                text = None
            if text is not None:
                yield {'type': 'delta', 'text': f'｜收到补充：{text}'}
        await asyncio.to_thread(release.wait, 10)
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
            'commandId': str(uuid4()), 'payload': {'name': '插入'}}).status_code == 200
        assert client.post(root + '/open').status_code == 200
        try:
            yield client, root + '/assistant', ready, release
        finally:
            release.set()


def start(client, path, runtime='codex', text='先做一个方案'):
    """Open a turn in a worker thread and wait until its runtime is running."""
    from concurrent.futures import ThreadPoolExecutor
    pool = ThreadPoolExecutor(max_workers=1)
    turn_id = str(uuid4())
    pending = pool.submit(client.post, path + '/turns', json={'id': turn_id, 'text': text, 'runtime': runtime})
    return pending, turn_id, pool


def conversation(client, path):
    return client.get(path).json()


def test_an_inserted_message_reaches_the_running_turn(assistant):
    client, path, ready, release = assistant
    pending, turn_id, pool = start(client, path)
    assert ready.wait(5), 'runtime never started'
    inserted = client.post(path + '/messages', json={
        'id': str(uuid4()), 'text': '补一句：用蓝色', 'runtime': 'codex', 'delivery': 'insert'})
    assert inserted.status_code == 202, inserted.text
    body = inserted.json()
    assert body['inserted']['status'] == 'inserted'
    assert body['turnId'] == turn_id
    release.set()
    response = pending.result()
    events = [line[6:] for line in response.text.splitlines() if line.startswith('data: ')]
    assert any('"type": "steered"' in line for line in events), events
    reply = conversation(client, path)['messages'][-1]
    assert '收到补充：补一句：用蓝色' in reply['text']
    statuses = [message['status'] for message in conversation(client, path)['messages']]
    assert statuses == ['complete', 'inserted', 'complete']
    pool.shutdown(wait=False)


def test_an_inserted_message_stays_out_of_the_next_turn(assistant):
    """The supplement is recorded where it happened, not replayed as a new turn."""
    client, path, ready, release = assistant
    pending, _, pool = start(client, path)
    assert ready.wait(5)
    assert client.post(path + '/messages', json={
        'id': str(uuid4()), 'text': '补一句', 'runtime': 'codex', 'delivery': 'insert'}).status_code == 202
    release.set()
    pending.result()
    messages = conversation(client, path)['messages']
    assert [message['role'] for message in messages] == ['user', 'user', 'assistant']
    assert messages[1]['text'] == '补一句'
    pool.shutdown(wait=False)


def test_insert_without_a_running_turn_is_refused(assistant):
    client, path, _, _ = assistant
    response = client.post(path + '/messages', json={
        'id': str(uuid4()), 'text': '补一句', 'runtime': 'codex', 'delivery': 'insert'})
    assert response.status_code == 409
    assert '没有正在执行的回复' in response.json()['detail']


def test_insert_names_the_runtime_that_cannot_steer(assistant):
    client, path, ready, release = assistant
    pending, _, pool = start(client, path)
    assert ready.wait(5)
    response = client.post(path + '/messages', json={
        'id': str(uuid4()), 'text': '补一句', 'runtime': 'claude', 'delivery': 'insert'})
    assert response.status_code == 409
    assert '不支持在回复执行中插入内容' in response.json()['detail']
    release.set()
    pending.result()
    pool.shutdown(wait=False)


def test_insert_refuses_attachments(assistant):
    client, path, ready, release = assistant
    pending, _, pool = start(client, path)
    assert ready.wait(5)
    response = client.post(path + '/messages', json={
        'id': str(uuid4()), 'text': '补一句', 'runtime': 'codex', 'delivery': 'insert',
        'assets': [str(uuid4())]})
    assert response.status_code == 409
    assert '只支持文字' in response.json()['detail']
    release.set()
    pending.result()
    pool.shutdown(wait=False)
