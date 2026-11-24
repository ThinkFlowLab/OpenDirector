import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import threading
from uuid import UUID, uuid4, uuid5

import pytest

from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector_api import agent
from test_assistant_conversations import assistant, frames, send  # noqa: F401


pytestmark = pytest.mark.cpu


def conversation_file(tmp_path):
    return next(tmp_path.rglob('agent-runs/conversation.json'))


def test_trace_lists_executed_turns_in_order_with_their_own_runtime(assistant, tmp_path):
    client, path, _ = assistant
    conversation = client.get(path).json()['conversationId']
    for text in ('第一轮', '第二轮', '第三轮'):
        send(client, path, conversation, text)
    file = conversation_file(tmp_path)
    saved = json.loads(file.read_text())
    ids = [message['id'] for message in saved['messages'] if message['role'] == 'user']
    # Turns keep the runtime persisted with them, not one for the whole conversation.
    saved['messages'][3]['runtime'] = 'codex'
    saved['messages'][5]['runtime'] = 'deepseek'
    file.write_text(json.dumps(saved))

    result = client.get(f'{path}/conversations/{conversation}/trace')
    assert result.status_code == 200
    body = result.json()
    assert body['conversationId'] == conversation and body['active'] is True
    assert [(turn['id'], turn['number'], turn['text'], turn['runtime']) for turn in body['turns']] == [
        (ids[0], 1, '第一轮', 'default'), (ids[1], 2, '第二轮', 'codex'), (ids[2], 3, '第三轮', 'deepseek')]
    assert all(turn['status'] == 'complete' for turn in body['turns'])


def test_trace_ignores_messages_that_never_executed_and_does_not_pair_by_position(assistant, tmp_path):
    client, path, _ = assistant
    conversation = client.get(path).json()['conversationId']
    send(client, path, conversation, '已执行')
    file = conversation_file(tmp_path)
    saved = json.loads(file.read_text())
    executed = saved['messages'][0]['id']
    # A queued or inserted user message sits between executed turns without an assistant record.
    saved['messages'].insert(1, {'id': str(uuid4()), 'role': 'user', 'text': '排队中'})
    saved['messages'].insert(0, {'id': 'not-a-uuid', 'role': 'user', 'text': '坏数据'})
    saved['messages'].append({'id': str(uuid4()), 'role': 'assistant', 'text': '孤立回复', 'status': 'complete'})
    file.write_text(json.dumps(saved))

    turns = client.get(f'{path}/conversations/{conversation}/trace').json()['turns']
    assert [(turn['id'], turn['text']) for turn in turns] == [(executed, '已执行')]


def test_interrupted_streaming_turn_is_not_reported_as_running(assistant, tmp_path):
    client, path, _ = assistant
    conversation = client.get(path).json()['conversationId']
    send(client, path, conversation, '中断')
    file = conversation_file(tmp_path)
    saved = json.loads(file.read_text())
    saved['messages'][1]['status'] = 'streaming'
    file.write_text(json.dumps(saved))
    turns = client.get(f'{path}/conversations/{conversation}/trace').json()['turns']
    assert turns[0]['status'] == 'interrupted'


def test_trace_resolves_archived_and_aliased_conversations_without_activating(assistant, tmp_path):
    client, path, _ = assistant
    first = client.get(path).json()['conversationId']
    send(client, path, first, '旧对话')
    second = str(uuid4())
    assert client.post(path + '/conversations', json={'id': second}).status_code == 200
    send(client, path, second, '新对话')
    before = conversation_file(tmp_path).read_bytes()

    archived = client.get(f'{path}/conversations/{first}/trace').json()
    current = client.get(f'{path}/conversations/{second}/trace').json()
    assert archived['active'] is False and [turn['text'] for turn in archived['turns']] == ['旧对话']
    assert current['active'] is True and [turn['text'] for turn in current['turns']] == ['新对话']
    assert conversation_file(tmp_path).read_bytes() == before
    assert client.get(path + '/conversations').json()['activeId'] == second

    saved = json.loads(before)
    saved['reusedCreateIds'] = [str(uuid4())]
    alias = saved['reusedCreateIds'][0]
    conversation_file(tmp_path).write_text(json.dumps(saved))
    assert client.get(f'{path}/conversations/{alias}/trace').json()['conversationId'] == second


def test_trace_of_unknown_conversation_is_404_and_empty_conversation_has_no_turns(assistant):
    client, path, _ = assistant
    assert client.get(f'{path}/conversations/{uuid4()}/trace').status_code == 404
    conversation = client.get(path).json()['conversationId']
    assert client.get(f'{path}/conversations/{conversation}/trace').json()['turns'] == []


def test_turn_resolves_to_its_own_conversation_including_archived(assistant):
    client, path, _ = assistant
    first = client.get(path).json()['conversationId']
    send(client, path, first, '旧对话')
    old_turn = client.get(f'{path}/conversations/{first}/trace').json()['turns'][0]['id']
    second = str(uuid4())
    client.post(path + '/conversations', json={'id': second})
    send(client, path, second, '新对话')
    new_turn = client.get(f'{path}/conversations/{second}/trace').json()['turns'][0]['id']
    assert client.get(f'{path}/traces/{old_turn}/conversation').json() == {'conversationId': first}
    assert client.get(f'{path}/traces/{new_turn}/conversation').json() == {'conversationId': second}
    assert client.get(f'{path}/traces/{uuid4()}/conversation').status_code == 404
    assert client.get(path + '/conversations').json()['activeId'] == second


class Clock:
    """Deterministic stand-in for the agent module's time source."""
    def __init__(self):
        self.now = 100.0

    def monotonic(self):
        self.now += 0.25
        return self.now


@pytest.fixture
def clock(monkeypatch):
    fake = Clock()
    monkeypatch.setattr(agent, '_monotonic', fake.monotonic)
    monkeypatch.setattr(agent, '_utc_now', lambda: '2026-01-02T03:04:05.678Z')
    return fake


def trace_turns(client, path):
    conversation = client.get(path).json()['conversationId']
    return client.get(f'{path}/conversations/{conversation}/trace').json()['turns']


def test_complete_turn_persists_timing_and_trace_reports_it(assistant, clock, tmp_path):
    client, path, _ = assistant
    conversation = client.get(path).json()['conversationId']
    events = frames(send(client, path, conversation, '计时'))
    saved = events[-1]['conversation']['messages'][-1]
    assert saved['status'] == 'complete'
    assert saved['startedAt'] == saved['finishedAt'] == '2026-01-02T03:04:05.678Z'
    assert saved['durationMs'] == 250
    assert client.get(path).json()['messages'][-1] == saved
    turn = trace_turns(client, path)[0]
    assert (turn['startedAt'], turn['finishedAt'], turn['durationMs']) == (
        saved['startedAt'], saved['finishedAt'], 250)


def test_stop_route_and_runtime_failure_keep_timing(assistant, clock, monkeypatch):
    client, path, _ = assistant
    started = threading.Event()
    async def hang(self, run):
        yield {'type': 'delta', 'text': '部分'}
        started.set()
        await asyncio.Event().wait()
    monkeypatch.setattr(agent.AgentRuntimes, 'stream', hang)
    turn_id = str(uuid4())
    with ThreadPoolExecutor() as pool:
        pending = pool.submit(client.post, path + '/turns', json={'id': turn_id, 'runtime': 'default', 'text': '停'})
        assert started.wait(5)
        assert client.post(path + f'/turns/{turn_id}/stop').status_code == 200
        pending.result(timeout=5)
    stopped = client.get(path).json()['messages'][-1]
    assert stopped['status'] == 'stopped' and stopped['durationMs'] == 250 and stopped['startedAt']

    async def boom(self, run):
        raise RuntimeError('原始错误')
        yield
    monkeypatch.setattr(agent.AgentRuntimes, 'stream', boom)
    events = frames(send(client, path, client.get(path).json()['conversationId'], '失败'))
    failed = events[-1]['conversation']['messages'][-1]
    assert failed['status'] == 'interrupted' and failed['durationMs'] == 250
    assert events[-1]['error'] is not None


def test_rejected_turns_record_no_timing(assistant, clock):
    client, path, _ = assistant
    conversation = client.get(path).json()['conversationId']
    turn = str(uuid4())
    body = {'id': turn, 'runtime': 'default', 'conversationId': conversation, 'text': '一次'}
    assert client.post(path + '/turns', json=body).status_code == 200
    assert frames(client.post(path + '/turns', json=body))[-1]['error'] is not None
    assert len(client.get(path).json()['messages']) == 2
    other = {'id': str(uuid4()), 'runtime': 'default', 'conversationId': str(uuid4()), 'text': '切换'}
    assert frames(client.post(path + '/turns', json=other))[-1]['error'] is not None
    assert len(client.get(path).json()['messages']) == 2
    assert len(trace_turns(client, path)) == 1


def test_sse_disconnect_keeps_timing(assistant, clock, monkeypatch):
    client, path, _ = assistant
    release = asyncio.Event()
    started = threading.Event()
    async def slow(self, run):
        yield {'type': 'delta', 'text': '开始'}
        started.set()
        await release.wait()
    monkeypatch.setattr(agent.AgentRuntimes, 'stream', slow)
    turn_id = str(uuid4())
    with ThreadPoolExecutor() as pool:
        pool.submit(client.post, path + '/turns', json={'id': turn_id, 'runtime': 'default', 'text': '断线'})
        assert started.wait(5)
        assert client.post(path + f'/turns/{turn_id}/stop').status_code == 200
    assert client.get(path).json()['messages'][-1]['durationMs'] == 250


def test_archived_conversation_trace_keeps_timing(assistant, clock):
    client, path, _ = assistant
    first = client.get(path).json()['conversationId']
    send(client, path, first, '旧')
    assert client.post(path + '/conversations', json={'id': str(uuid4())}).status_code == 200
    turn = client.get(f'{path}/conversations/{first}/trace').json()['turns'][0]
    assert turn['durationMs'] == 250 and turn['finishedAt'] and turn['startedAt']


def test_legacy_messages_report_null_not_zero_and_trace_is_read_only(assistant, tmp_path):
    client, path, _ = assistant
    conversation = client.get(path).json()['conversationId']
    send(client, path, conversation, '旧数据')
    file = conversation_file(tmp_path)
    saved = json.loads(file.read_text())
    reply = saved['messages'][1]
    for key in ('startedAt', 'finishedAt', 'durationMs'):
        reply.pop(key, None)
    file.write_text(json.dumps(saved))
    before = file.read_bytes()
    turn = client.get(f'{path}/conversations/{conversation}/trace').json()['turns'][0]
    assert (turn['startedAt'], turn['finishedAt'], turn['durationMs']) == (None, None, None)
    reply['durationMs'] = True
    reply['finishedAt'] = 5
    file.write_text(json.dumps(saved))
    turn = client.get(f'{path}/conversations/{conversation}/trace').json()['turns'][0]
    assert (turn['finishedAt'], turn['durationMs']) == (None, None)
    reply['durationMs'] = -1
    file.write_text(json.dumps(saved))
    before = file.read_bytes()
    assert client.get(f'{path}/conversations/{conversation}/trace').json()['turns'][0]['durationMs'] is None
    assert file.read_bytes() == before


def begin_message(turn):
    return {'id': turn, 'role': 'user', 'text': '直接', 'runtime': 'default'}


def finish_message(turn, **extra):
    return {'id': str(uuid5(UUID(turn), 'assistant')), 'role': 'assistant', 'text': '好', 'status': 'complete', **extra}


def test_finish_without_started_at_keeps_the_stored_start(assistant, clock, tmp_path):
    client, path, _ = assistant
    project = UUID(path.split('/projects/')[1].split('/')[0])
    conversations = agent.Conversations(CreationProjects(LocalProjects(tmp_path)))
    turn = str(uuid4())
    started = conversations.update(project, begin=begin_message(turn))['messages'][-1]
    assert started['startedAt'] == '2026-01-02T03:04:05.678Z' and 'durationMs' not in started
    done = conversations.update(project, finish=finish_message(turn))['messages'][-1]
    assert done['startedAt'] == started['startedAt'] and done['durationMs'] == 250
    # Values a future caller already supplied are not overwritten.
    turn = str(uuid4())
    conversations.update(project, begin=begin_message(turn))
    kept = conversations.update(project, finish=finish_message(turn, durationMs=7, finishedAt='x'))['messages'][-1]
    assert (kept['durationMs'], kept['finishedAt']) == (7, 'x')


def test_streaming_and_finish_after_restart_keep_start_without_inventing_duration(assistant, clock, tmp_path):
    client, path, _ = assistant
    project = UUID(path.split('/projects/')[1].split('/')[0])
    turn = str(uuid4())
    agent.Conversations(CreationProjects(LocalProjects(tmp_path))).update(project, begin=begin_message(turn))
    conversation = client.get(path).json()['conversationId']
    streaming = trace_turns(client, path)[0]
    assert streaming['status'] == 'interrupted' and streaming['startedAt']
    assert (streaming['finishedAt'], streaming['durationMs']) == (None, None)
    restarted = agent.Conversations(CreationProjects(LocalProjects(tmp_path)))
    done = restarted.update(project, finish=finish_message(turn))['messages'][-1]
    assert done['startedAt'] == streaming['startedAt']
    assert 'finishedAt' not in done and 'durationMs' not in done
    assert client.get(f'{path}/conversations/{conversation}/trace').json()['turns'][0]['durationMs'] is None


def test_finish_payload_cannot_override_the_stored_start(assistant, clock, tmp_path):
    client, path, _ = assistant
    project = UUID(path.split('/projects/')[1].split('/')[0])
    conversations = agent.Conversations(CreationProjects(LocalProjects(tmp_path)))
    turn = str(uuid4())
    started = conversations.update(project, begin=begin_message(turn))['messages'][-1]['startedAt']
    done = conversations.update(project, finish=finish_message(turn, startedAt='1999-01-01T00:00:00.000Z'))['messages'][-1]
    assert done['startedAt'] == started


def test_failed_begin_write_drops_the_monotonic_entry(assistant, tmp_path, monkeypatch):
    client, path, _ = assistant
    project = UUID(path.split('/projects/')[1].split('/')[0])
    conversations = agent.Conversations(CreationProjects(LocalProjects(tmp_path)))
    def fail(*args, **kwargs):
        raise OSError('disk full')
    monkeypatch.setattr(agent, 'durable_json', fail)
    with pytest.raises(OSError):
        conversations.update(project, begin=begin_message(str(uuid4())))
    assert conversations._started == {}


class ManualClock:
    """Monotonic clock that only moves when a test says so, shared by the fake disk and the fake agent."""
    def __init__(self):
        self.now = 1000.0

    def monotonic(self):
        return self.now

    def advance(self, milliseconds):
        self.now += milliseconds / 1000


@pytest.fixture
def manual(monkeypatch):
    fake = ManualClock()
    monkeypatch.setattr(agent, '_monotonic', fake.monotonic)
    return fake


def slow_writes(monkeypatch, manual, delays):
    """Make durable_json cost `delays[n]` ms of clock time on its n-th call (later calls cost 0)."""
    real, calls = agent.durable_json, []
    def write(file, value):
        calls.append(file)
        manual.advance(delays[len(calls) - 1] if len(calls) <= len(delays) else 0)
        return real(file, value)
    monkeypatch.setattr(agent, 'durable_json', write)
    return calls


def new_conversations(assistant, tmp_path):
    _, path, _ = assistant
    return UUID(path.split('/projects/')[1].split('/')[0]), agent.Conversations(CreationProjects(LocalProjects(tmp_path)))


def run_turn(conversations, project, manual, run_ms=250, status='complete'):
    turn = str(uuid4())
    conversations.update(project, begin=begin_message(turn))
    manual.advance(run_ms)
    return conversations.update(project, finish={**finish_message(turn), 'status': status})['messages'][-1]


@pytest.mark.parametrize('delay', [0, 200, 2000])
def test_duration_excludes_the_initial_write_delay(assistant, manual, tmp_path, monkeypatch, delay):
    project, conversations = new_conversations(assistant, tmp_path)
    slow_writes(monkeypatch, manual, [delay])
    assert run_turn(conversations, project, manual)['durationMs'] == 250


def test_duration_is_identical_across_write_delays(assistant, manual, tmp_path, monkeypatch):
    project, conversations = new_conversations(assistant, tmp_path)
    seen = []
    for delay in (0, 200, 2000):
        slow_writes(monkeypatch, manual, [delay])
        seen.append(run_turn(conversations, project, manual)['durationMs'])
    assert seen == [250, 250, 250]


def test_finish_write_delay_is_excluded_too(assistant, manual, tmp_path, monkeypatch):
    project, conversations = new_conversations(assistant, tmp_path)
    slow_writes(monkeypatch, manual, [2000, 3000])
    assert run_turn(conversations, project, manual)['durationMs'] == 250


@pytest.mark.parametrize('status', ['complete', 'stopped', 'interrupted'])
def test_every_terminal_status_excludes_the_initial_write(assistant, manual, tmp_path, monkeypatch, status):
    project, conversations = new_conversations(assistant, tmp_path)
    slow_writes(monkeypatch, manual, [2000])
    done = run_turn(conversations, project, manual, status=status)
    assert done['status'] == status and done['durationMs'] == 250


def test_startedat_is_acceptance_time_and_duration_uses_the_monotonic_clock(assistant, manual, tmp_path, monkeypatch):
    project, conversations = new_conversations(assistant, tmp_path)
    stamps = iter(['2026-01-01T00:00:00.000Z', '2030-05-05T00:00:00.000Z'])
    monkeypatch.setattr(agent, '_utc_now', lambda: next(stamps))
    slow_writes(monkeypatch, manual, [2000])
    turn = str(uuid4())
    conversations.update(project, begin=begin_message(turn))
    manual.advance(250)
    done = conversations.update(project, finish=finish_message(turn))['messages'][-1]
    # Wall-clock fields are 4 years apart; only the monotonic clock decides durationMs.
    assert done['startedAt'] == '2026-01-01T00:00:00.000Z' and done['finishedAt'] == '2030-05-05T00:00:00.000Z'
    assert done['durationMs'] == 250


def test_failed_begin_write_is_not_an_accepted_turn(assistant, manual, tmp_path, monkeypatch):
    project, conversations = new_conversations(assistant, tmp_path)
    real = agent.durable_json
    def fail(*args, **kwargs):
        manual.advance(2000)
        raise OSError('disk full')
    monkeypatch.setattr(agent, 'durable_json', fail)
    turn = str(uuid4())
    with pytest.raises(OSError):
        conversations.update(project, begin=begin_message(turn))
    assert conversations._started == {}
    monkeypatch.setattr(agent, 'durable_json', real)
    assert all(message['id'] != turn for message in conversations.update(project)['messages'])
    # Finishing a never-accepted turn invents no duration, and a later retry of the same begin is accepted fresh.
    done = conversations.update(project, finish=finish_message(turn))['messages']
    assert all('durationMs' not in message for message in done)
    conversations.update(project, begin=begin_message(turn))
    manual.advance(250)
    assert conversations.update(project, finish=finish_message(turn))['messages'][-1]['durationMs'] == 250


def test_start_is_not_recorded_until_the_begin_write_returns(assistant, manual, tmp_path, monkeypatch):
    project, conversations = new_conversations(assistant, tmp_path)
    during = []
    real = agent.durable_json
    def spy(file, value):
        during.append(dict(conversations._started))
        return real(file, value)
    monkeypatch.setattr(agent, 'durable_json', spy)
    conversations.update(project, begin=begin_message(str(uuid4())))
    assert during == [{}] and len(conversations._started) == 1


def test_duplicate_begin_does_not_reset_the_running_start(assistant, manual, tmp_path, monkeypatch):
    project, conversations = new_conversations(assistant, tmp_path)
    slow_writes(monkeypatch, manual, [2000])
    turn = str(uuid4())
    conversations.update(project, begin=begin_message(turn))
    manual.advance(100)
    with pytest.raises(agent.ProjectError):
        conversations.update(project, begin=begin_message(turn))
    manual.advance(150)
    assert conversations.update(project, finish=finish_message(turn))['messages'][-1]['durationMs'] == 250


def test_failed_finish_write_keeps_the_start_for_a_retry(assistant, manual, tmp_path, monkeypatch):
    project, conversations = new_conversations(assistant, tmp_path)
    turn = str(uuid4())
    conversations.update(project, begin=begin_message(turn))
    real = agent.durable_json
    monkeypatch.setattr(agent, 'durable_json', lambda *a, **k: (_ for _ in ()).throw(OSError('disk full')))
    manual.advance(250)
    with pytest.raises(OSError):
        conversations.update(project, finish=finish_message(turn))
    monkeypatch.setattr(agent, 'durable_json', real)
    assert conversations.update(project, finish=finish_message(turn))['messages'][-1]['durationMs'] == 250


def test_restart_after_slow_begin_invents_no_duration(assistant, manual, tmp_path, monkeypatch):
    project, conversations = new_conversations(assistant, tmp_path)
    slow_writes(monkeypatch, manual, [2000])
    turn = str(uuid4())
    conversations.update(project, begin=begin_message(turn))
    manual.advance(250)
    restarted = agent.Conversations(CreationProjects(LocalProjects(tmp_path)))
    done = restarted.update(project, finish=finish_message(turn))['messages'][-1]
    assert 'durationMs' not in done and restarted._started == {}


def test_concurrent_turns_keep_independent_durations(assistant, manual, tmp_path, monkeypatch):
    project, conversations = new_conversations(assistant, tmp_path)
    slow_writes(monkeypatch, manual, [2000, 0, 0, 0])
    first, second = str(uuid4()), str(uuid4())
    conversations.update(project, begin=begin_message(first))
    manual.advance(100)
    conversations.update(project, begin=begin_message(second))
    manual.advance(300)
    done = {m['id']: m for m in conversations.update(project, finish=finish_message(first))['messages']}
    assert done[str(uuid5(UUID(first), 'assistant'))]['durationMs'] == 400
    manual.advance(50)
    done = {m['id']: m for m in conversations.update(project, finish=finish_message(second))['messages']}
    assert done[str(uuid5(UUID(second), 'assistant'))]['durationMs'] == 350
