"""The messages a dispatched turn hands the runtime are bounded by that turn's own user message.

A queued message is stored after the running turn's streaming placeholder, so the
placeholder is not always the last stored message. These cases record the real
`run.messages` the runtime receives and compare them with the persisted order.
"""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import threading
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector_api.main import create_app
from opendirector_api import agent
from test_assistant_queue import empty_skills, frames, wait_until

NOTE = 'User model preferences'


def shape(messages):
    """(role, first line) of every message; the preference note is marked with a trailing '+note'."""
    return [(item['role'], item['content'].partition('\n')[0] + ('+note' if NOTE in item['content'] else ''))
            for item in messages]


@pytest.fixture
def harness(tmp_path, monkeypatch):
    store = LocalProjects(tmp_path)
    seen, started, held, partial, failing = [], {}, {}, {}, set()

    async def stream(self, run):
        text = [item for item in run.messages if item['role'] == 'user'][-1]['content'].partition('\n')[0]
        seen.append((text, shape(run.messages)))
        started.setdefault(text, threading.Event()).set()
        if text in failing:
            if text in held:
                await asyncio.to_thread(held[text].wait, 10)
            raise RuntimeError('runtime exploded')
        if text in partial:
            yield {'type': 'delta', 'text': partial[text]}
            await asyncio.to_thread(held[text].wait, 10)
            return
        if text in held:
            await asyncio.to_thread(held[text].wait, 10)
        yield {'type': 'delta', 'text': '回复' + text}

    monkeypatch.setattr(agent.AgentRuntimes, 'stream', stream)
    monkeypatch.setattr(agent, 'runtime_available', lambda _: True)
    monkeypatch.setattr(agent, 'skills', empty_skills)
    config = {'id': str(uuid4()), 'modelId': 'test-model', 'kind': 'agent', 'url': 'http://models.test/v1',
              'connectionType': 'api', 'protocol': 'openai', 'authMode': 'none', 'apiKey': ''}
    monkeypatch.setattr(ModelConfigs, 'resolve', lambda *args, **kwargs: dict(config))
    with TestClient(create_app(store), headers={
        'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': str(uuid4())}) as client:
        pid = str(uuid4())
        root = f'/api/creation/projects/{pid}'
        assert client.post(root + '/commands', json={'type': 'project.create', 'projectId': pid,
            'commandId': str(uuid4()), 'payload': {'name': '上下文'}}).status_code == 200
        assert client.post(root + '/open').status_code == 200
        path = root + '/assistant'
        cid = client.get(path).json()['conversationId']
        ids = {}

        def body(text):
            ids[text] = str(uuid4())
            return {'id': ids[text], 'runtime': 'default', 'conversationId': cid, 'text': text,
                    'modelSelections': {'agent': config['id'], 'image': None, 'video': None, 'audio': None}}

        def turn(text):
            return client.post(path + '/turns', json=body(text))

        def queue(text):
            return client.post(path + '/messages', json=body(text))

        def stored():
            return [(item['role'], item['status'], item['text'][:8]) for item in client.get(path).json()['messages']]

        try:
            yield client, path, turn, queue, seen, started, held, partial, failing, ids, stored
        finally:
            for event in held.values():
                event.set()


def user(text, note=False):
    return ('user', text + ('+note' if note else ''))


def reply(text):
    return ('assistant', '回复' + text)


def run_queue(harness, first, *queued):
    """Hold `first`, queue the rest behind it, release, and return the finished chain's events."""
    client, path, turn, queue, seen, started, held, *_ = harness
    held[first] = threading.Event()
    with ThreadPoolExecutor() as pool:
        running = pool.submit(turn, first)
        assert started.setdefault(first, threading.Event()).wait(5)
        for text in queued:
            assert queue(text).status_code == 202
        held[first].set()
        return frames(running.result(timeout=20))


def test_a_single_turn_sees_only_its_own_message(harness):
    client, path, turn, queue, seen, *_ = harness
    frames(turn('一'))
    assert seen == [('一', [user('一', True)])]


def test_a_queued_message_does_not_see_the_placeholder_of_the_running_turn(harness):
    seen = harness[4]
    run_queue(harness, '一', '二')
    assert seen[1][1] == [user('一'), reply('一'), user('二', True)]
    assert ('assistant', '(empty reply)') not in seen[1][1]


def test_three_turns_each_see_only_completed_history_and_themselves(harness):
    seen = harness[4]
    run_queue(harness, '一', '二', '三')
    assert seen == [
        ('一', [user('一', True)]),
        ('二', [user('一'), reply('一'), user('二', True)]),
        ('三', [user('一'), reply('一'), user('二'), reply('二'), user('三', True)]),
    ]


def test_later_queued_messages_never_leak_into_earlier_turns(harness):
    seen, stored = harness[4], harness[-1]
    events = run_queue(harness, '一', '二', '三', '四', '五')
    order = ['一', '二', '三', '四', '五']
    expected = []
    for index, text in enumerate(order):
        history = []
        for earlier in order[:index]:
            history += [user(earlier), reply(earlier)]
        expected.append((text, history + [user(text, True)]))
    assert seen == expected
    # Every turn appears once, in dispatch order, and the stored conversation matches.
    assert [text for text, _ in seen] == order
    assert [event['nextTurnId'] is None for event in events if event['type'] == 'end'] == [False] * 4 + [True]
    assert stored() == [(role, 'complete', text) for earlier in order
                        for role, text in (('user', earlier), ('assistant', '回复' + earlier))]


def test_a_message_queued_while_a_turn_runs_does_not_change_its_context(harness):
    client, path, turn, queue, seen, started, held, *_ = harness
    held['一'], held['二'] = threading.Event(), threading.Event()
    with ThreadPoolExecutor() as pool:
        running = pool.submit(turn, '一')
        assert started.setdefault('一', threading.Event()).wait(5)
        assert queue('二').status_code == 202
        held['一'].set()
        # 二 is running and its context is captured; 三 arrives now.
        assert started.setdefault('二', threading.Event()).wait(5)
        snapshot = list(seen[1][1])
        assert queue('三').status_code == 202
        held['二'].set()
        frames(running.result(timeout=20))
    assert [text for text, _ in seen] == ['一', '二', '三']
    assert seen[1][1] == snapshot == [user('一'), reply('一'), user('二', True)]
    assert seen[2][1] == [user('一'), reply('一'), user('二'), reply('二'), user('三', True)]


def test_a_direct_turn_after_a_finished_chain_inherits_every_reply(harness):
    client, path, turn, queue, seen, *_ = harness
    run_queue(harness, '一', '二')
    frames(turn('三'))
    assert seen[2] == ('三', [user('一'), reply('一'), user('二'), reply('二'), user('三', True)])


def test_an_empty_queue_runs_nothing_extra(harness):
    client, path, turn, queue, seen, started, held, partial, failing, ids, stored = harness
    events = frames(turn('一'))
    assert [event['nextTurnId'] is None for event in events if event['type'] == 'end'] == [True]
    assert [text for text, _ in seen] == ['一']
    assert stored() == [('user', 'complete', '一'), ('assistant', 'complete', '回复一')]


def test_a_turn_submitted_after_stop_treats_the_stopped_reply_as_history(harness):
    client, path, turn, queue, seen, started, held, partial, failing, ids, stored = harness
    held['一'], partial['一'] = threading.Event(), '做到一半'
    with ThreadPoolExecutor() as pool:
        running = pool.submit(turn, '一')
        assert started.setdefault('一', threading.Event()).wait(5)
        assert queue('二').status_code == 202
        assert client.post(path + f"/turns/{ids['一']}/stop").status_code == 200
        frames(running.result(timeout=10))
    assert [text for text, _ in seen] == ['一']
    assert [item[:2] for item in stored()] == [
        ('user', 'complete'), ('assistant', 'stopped'), ('user', 'cancelled')]
    frames(turn('三'))
    third = seen[1]
    assert third[0] == '三'
    # The stopped reply keeps its partial text; the cancelled message was never answered.
    assert third[1] == [user('一'), ('assistant', '做到一半'), user('二'), user('三', True)]
    assert all(text != '(empty reply)' for _, text in third[1])


def test_a_stopped_reply_with_no_text_is_an_empty_reply_not_a_placeholder(harness):
    client, path, turn, queue, seen, started, held, partial, failing, ids, stored = harness
    held['一'], partial['一'] = threading.Event(), ''
    with ThreadPoolExecutor() as pool:
        running = pool.submit(turn, '一')
        assert started.setdefault('一', threading.Event()).wait(5)
        assert client.post(path + f"/turns/{ids['一']}/stop").status_code == 200
        frames(running.result(timeout=10))
    frames(turn('二'))
    assert seen[1] == ('二', [user('一'), ('assistant', '(empty reply)'), user('二', True)])


def test_a_runtime_error_stops_the_chain_and_the_next_turn_keeps_the_boundary(harness):
    client, path, turn, queue, seen, started, held, partial, failing, ids, stored = harness
    failing.add('一')
    run_queue(harness, '一', '二')
    # Only a complete turn continues the chain, so 二 was not dispatched.
    assert [text for text, _ in seen] == ['一']
    assert [item[:2] for item in stored()][:2] == [('user', 'complete'), ('assistant', 'interrupted')]
    failing.clear()
    frames(turn('三'))
    # Look contexts up by each turn's own message. Whether the stranded 二 runs, and
    # in which order relative to 三, is not part of this boundary invariant.
    contexts = {context[-1][1].removesuffix('+note'): context for _, context in seen}
    assert len(contexts) == len(seen)
    assert {'一', '三'} <= set(contexts) <= {'一', '二', '三'}
    assert contexts['一'] == [user('一', True)]
    for text, context in contexts.items():
        assert context[-1] == user(text, True)
        assert [item for item in context if item[0] == 'user' and item[1].removesuffix('+note') == text] == [context[-1]]
        assert reply(text) not in context
        # Nothing persisted after the turn's own message (a later message or its reply) is visible.
        later = {'一': ('二', '三'), '二': ('三',), '三': ()}[text]  # storage order: 一, 二, 三
        assert not any(item[1].removesuffix('+note') in later for item in context)
    # 三 ends at its own message; 二 is stored before it and is kept in persisted order.
    assert contexts['三'] == [user('一'), ('assistant', '(empty reply)'), user('二'), user('三', True)]
    # 二, if it runs, ends at its own message and does not see 三, which is stored after it.
    if '二' in contexts:
        assert contexts['二'] == [user('一'), ('assistant', '(empty reply)'), user('二', True)]
