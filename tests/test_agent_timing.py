import asyncio
import json
from types import SimpleNamespace
import time
from uuid import uuid4

import pytest

from capabilities import requires_posix

from opendirector.agent import timing
from opendirector.agent.cli_transport import start_server


def test_a_running_then_finished_call_becomes_one_ledger_entry():
    ledger = {}
    timing.note(ledger, {'type': 'tool', 'id': 'cli:1', 'name': 'generation.submit', 'status': 'running',
                         'timing': {'spawn': 1.2}})
    timing.note(ledger, {'type': 'tool', 'id': 'cli:1', 'name': 'generation.submit', 'status': 'complete',
                         'timing': {'spawn': 1.2, 'work': 0.4}})
    assert list(ledger) == ['cli:1']
    entry = ledger['cli:1']
    assert entry['status'] == 'complete'
    assert (entry['spawn'], entry['work']) == (1.2, 0.4)
    assert entry['endedAt'] >= entry['startedAt']


def test_a_runtime_without_transport_timing_still_records_call_time():
    ledger = {}
    timing.note(ledger, {'type': 'tool', 'id': 'deepseek:a', 'name': 'bash', 'status': 'running'})
    timing.note(ledger, {'type': 'tool', 'id': 'deepseek:a', 'name': 'bash', 'status': 'complete'})
    summary = timing.summary(ledger, turn_seconds=3.0)
    assert summary['calls'] == 1 and summary['measured'] == 1
    assert summary['decomposed'] == 0
    assert summary['spawnSeconds'] == 0


def test_events_without_identity_are_ignored():
    ledger = {}
    timing.note(ledger, {'type': 'tool', 'name': 'bash', 'status': 'complete'})
    assert ledger == {}


def test_summary_separates_call_time_from_start_up_and_work():
    ledger = {}
    for index, spawn in enumerate([1.0, 1.2, 1.4]):
        timing.note(ledger, {'type': 'tool', 'id': f'cli:{index}', 'name': 'read_project',
                             'status': 'running', 'timing': {'spawn': spawn}})
        timing.note(ledger, {'type': 'tool', 'id': f'cli:{index}', 'name': 'read_project',
                             'status': 'complete', 'timing': {'spawn': spawn, 'work': 0.1}})
        ledger[f'cli:{index}']['startedAt'] = 0.0
        ledger[f'cli:{index}']['endedAt'] = 0.5
    summary = timing.summary(ledger, turn_seconds=12.0)
    assert summary['calls'] == 3 and summary['measured'] == 3
    assert round(summary['spawnSeconds'], 3) == 3.6
    assert round(summary['workSeconds'], 3) == 0.3
    assert summary['callSeconds'] == 1.5
    assert summary['p50Seconds'] == summary['p90Seconds'] == 0.5
    assert summary['turnSeconds'] == 12.0


def test_an_empty_turn_writes_nothing(tmp_path):
    assert timing.write(tmp_path, uuid4(), {}, 1.0) is None
    assert not (tmp_path / 'agent-runs').exists()


def test_the_ledger_lands_beside_the_other_runtime_state(tmp_path):
    ledger = {}
    timing.note(ledger, {'type': 'tool', 'id': 'cli:1', 'name': 'bash', 'status': 'complete'})
    turn = uuid4()
    path = timing.write(tmp_path, turn, ledger, 2.5)
    assert path == tmp_path / 'agent-runs' / 'timing' / f'{turn}.json'
    stored = json.loads(path.read_text())
    assert stored['summary']['turnSeconds'] == 2.5
    assert [call['id'] for call in stored['calls']] == ['cli:1']


def test_an_unwritable_ledger_never_raises(tmp_path):
    (tmp_path / 'agent-runs').write_text('not a directory')
    ledger = {}
    timing.note(ledger, {'type': 'tool', 'id': 'cli:1', 'name': 'bash', 'status': 'complete'})
    assert timing.write(tmp_path, uuid4(), ledger, 1.0) is None


class _Outcome:
    value = {'ok': True}
    error = None

    def event(self, name):
        return {'type': 'tool', 'name': name, 'status': 'complete'}


class _Gateway:
    closed = False

    def __init__(self, project_id):
        self.run = SimpleNamespace(project_id=project_id)

    async def call(self, key, name, arguments):
        return _Outcome()


@requires_posix()
def test_the_cli_reports_its_own_start_up_through_the_transport(tmp_path):
    async def scenario():
        queue = asyncio.Queue()
        project = uuid4()
        server, _ = await start_server(_Gateway(project), queue, str(tmp_path / 'cli.sock'), set())
        try:
            reader, writer = await asyncio.open_unix_connection(str(tmp_path / 'cli.sock'))
            writer.write((json.dumps({'id': '1', 'cliCommand': 'opendirector', 'projectId': str(project),
                                      'name': 'read_project', 'arguments': {},
                                      'timing': {'startedAt': time.monotonic() - 1.5}}) + '\n').encode())
            await writer.drain()
            await reader.readline()
            writer.close()
            await writer.wait_closed()
            running = await asyncio.wait_for(queue.get(), 5)
            finished = await asyncio.wait_for(queue.get(), 5)
            return running, finished
        finally:
            server.close()
            await server.wait_closed()

    running, finished = asyncio.run(scenario())
    assert 1.4 <= running['timing']['spawn'] < 10
    assert finished['timing']['spawn'] == running['timing']['spawn']
    assert finished['timing']['work'] >= 0


@requires_posix()
def test_a_clock_disagreement_is_dropped_instead_of_poisoning_the_turn(tmp_path):
    async def scenario():
        queue = asyncio.Queue()
        project = uuid4()
        server, _ = await start_server(_Gateway(project), queue, str(tmp_path / 'cli.sock'), set())
        try:
            reader, writer = await asyncio.open_unix_connection(str(tmp_path / 'cli.sock'))
            writer.write((json.dumps({'id': '1', 'cliCommand': 'opendirector', 'projectId': str(project),
                                      'name': 'read_project', 'arguments': {},
                                      'timing': {'startedAt': time.monotonic() + 60}}) + '\n').encode())
            await writer.drain()
            await reader.readline()
            writer.close()
            await writer.wait_closed()
            running = await asyncio.wait_for(queue.get(), 5)
            finished = await asyncio.wait_for(queue.get(), 5)
            return running, finished
        finally:
            server.close()
            await server.wait_closed()

    running, finished = asyncio.run(scenario())
    assert 'timing' not in running
    assert finished['timing'] == {'spawn': None, 'work': finished['timing']['work']}
