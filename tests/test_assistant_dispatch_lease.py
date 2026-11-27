"""#509: dispatch starts an Agent write session only for a message it takes.

The turn that ends the queue used to insert an `agent:` session row before it
looked for a queued message, so an empty dispatch left a row nobody released
until the lease expired. These cases count the rows on the real service path.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import sqlite3
import threading
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from opendirector.infrastructure import local_projects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector_api.main import create_app
from opendirector_api import agent
from test_assistant_queue import empty_skills, frames, wait_until


def rows(store):
    with sqlite3.connect(store.database) as db:
        return sorted(item[0] for item in db.execute("SELECT id FROM sessions WHERE id LIKE 'agent:%'"))


@pytest.fixture
def leased(tmp_path, monkeypatch):
    """Every turn records the agent rows it ran under; a turn waits only if held."""
    store = LocalProjects(tmp_path)
    seen, held, started = [], {}, {}

    async def stream(self, run):
        text = [item for item in run.messages if item['role'] == 'user'][-1]['content']
        # A turn that runs must own an unexpired write session of its own.
        seen.append((text, run.session, store.agent_session_key(run.session) in rows(store), rows(store)))
        started.setdefault(text, threading.Event()).set()
        yield {'type': 'delta', 'text': '收到：' + text}
        if text in held:
            await asyncio.to_thread(held[text].wait, 10)
        yield {'type': 'delta', 'text': '｜完'}

    monkeypatch.setattr(agent.AgentRuntimes, 'stream', stream)
    monkeypatch.setattr(agent, 'runtime_available', lambda _: True)
    monkeypatch.setattr(agent, 'skills', empty_skills)
    from opendirector.infrastructure.model_configs import ModelConfigs
    config = {'id': str(uuid4()), 'modelId': 'test-model', 'kind': 'agent', 'url': 'http://models.test/v1',
              'connectionType': 'api', 'protocol': 'openai', 'authMode': 'none', 'apiKey': ''}
    monkeypatch.setattr(ModelConfigs, 'resolve', lambda *args, **kwargs: dict(config))
    with TestClient(create_app(store), headers={
        'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': str(uuid4())}) as client:
        pid = str(uuid4())
        root = f'/api/creation/projects/{pid}'
        assert client.post(root + '/commands', json={'type': 'project.create', 'projectId': pid,
            'commandId': str(uuid4()), 'payload': {'name': '租约'}}).status_code == 200
        assert client.post(root + '/open').status_code == 200
        path = root + '/assistant'
        cid = client.get(path).json()['conversationId']

        def turn(text):
            return client.post(path + '/turns', json={
                'id': str(uuid4()), 'runtime': 'default', 'conversationId': cid, 'text': text})

        def queue(text):
            return client.post(path + '/messages', json={
                'id': str(uuid4()), 'runtime': 'default', 'conversationId': cid, 'text': text})

        try:
            yield client, path, store, turn, queue, seen, held, started
        finally:
            for event in held.values():
                event.set()


def test_a_single_turn_leaves_no_agent_session_row(leased):
    client, path, store, turn, queue, seen, held, started = leased
    response = turn('只做一件事')
    assert response.status_code == 200
    assert frames(response)[-1]['nextTurnId'] is None
    assert wait_until(lambda: rows(store) == []), rows(store)


def test_queued_messages_run_in_order_each_under_its_own_session(leased):
    client, path, store, turn, queue, seen, held, started = leased
    held['一'] = threading.Event()
    with ThreadPoolExecutor() as pool:
        running = pool.submit(turn, '一')
        assert started.setdefault('一', threading.Event()).wait(5)
        assert queue('二').status_code == 202
        assert queue('三').status_code == 202
        held['一'].set()
        events = frames(running.result(timeout=10))
    assert [text for text, *_ in seen] == ['一', '二', '三']
    assert len({session for _, session, *_ in seen}) == 3
    # While a turn ran, its own row existed and no stale row from another turn did.
    assert all(own and len(live) == 1 for _, _, own, live in seen), seen
    assert [event['nextTurnId'] is None for event in events if event['type'] == 'end'] == [False, False, True]
    assert wait_until(lambda: rows(store) == []), rows(store)


def test_a_message_queued_as_the_last_turn_ends_is_not_lost_and_leaks_no_row(leased, monkeypatch):
    client, path, store, turn, queue, seen, held, started = leased
    original = agent.Conversations.dispatch
    before_exhaustion = threading.Event()
    queued = {}

    def dispatch(self, project_id, session=None, agent_session=None):
        # The first dispatch that finds nothing runs while a message arrives: the
        # admission lock must hold the message back until the slot is released.
        if not before_exhaustion.is_set():
            before_exhaustion.set()
            queued['response'] = threading.Thread(target=lambda: queued.setdefault('r', queue('迟到')))
            queued['response'].start()
            queued['response'].join(0.3)
        return original(self, project_id, session, agent_session)

    monkeypatch.setattr(agent.Conversations, 'dispatch', dispatch)
    first = turn('先做')
    events = frames(first)
    queued['response'].join(10)
    response = queued['r']
    assert response.status_code in (200, 202), response.text
    if response.status_code == 202:
        assert [text for text, *_ in seen] == ['先做', '迟到']
    else:
        assert wait_until(lambda: [text for text, *_ in seen] == ['先做', '迟到']), seen
        frames(response)
    assert wait_until(lambda: rows(store) == []), rows(store)


def test_stop_during_a_chained_turn_leaves_no_row(leased):
    client, path, store, turn, queue, seen, held, started = leased
    held['一'], held['二'] = threading.Event(), threading.Event()
    with ThreadPoolExecutor() as pool:
        running = pool.submit(turn, '一')
        assert wait_until(lambda: '一' in started)
        assert queue('二').status_code == 202
        assert queue('三').status_code == 202
        held['一'].set()
        assert started['二'].wait(5) if wait_until(lambda: '二' in started) else False
        turn_id = [item for item in client.get(path).json()['messages'] if item['role'] == 'user'][1]['id']
        assert client.post(path + f'/turns/{turn_id}/stop').status_code == 200
        frames(running.result(timeout=10))
    assert [text for text, *_ in seen] == ['一', '二']
    assert wait_until(lambda: rows(store) == []), rows(store)


def test_a_failed_dispatch_write_rolls_back_its_row_and_spares_other_sessions(leased, monkeypatch):
    client, path, store, turn, queue, seen, held, started = leased
    other = str(uuid4())
    held['一'] = threading.Event()
    real = agent.durable_json
    failures = []

    armed = threading.Event()

    def flaky(file, value):
        # Only the write that turns a queued message into a running turn fails.
        if armed.is_set() and not any(item.get('status') == 'queued' for item in value.get('messages', [])):
            failures.append(file)
            raise OSError('disk full')
        return real(file, value)

    monkeypatch.setattr(agent, 'durable_json', flaky)
    with ThreadPoolExecutor() as pool:
        running = pool.submit(turn, '一')
        assert started.setdefault('一', threading.Event()).wait(5)
        assert queue('二').status_code == 202
        # Another live agent session of this project, owned by someone else.
        with store.transaction() as db:
            store.start_agent_session(db, path.split('/')[4], store.root, other)
        armed.set()
        held['一'].set()
        try:
            frames(running.result(timeout=10))
        except Exception:
            pass
    assert failures, 'the dispatch write was never reached'
    assert wait_until(lambda: rows(store) == [store.agent_session_key(other)]), rows(store)
    assert [text for text, *_ in seen] == ['一']
