"""`opendirector job wait` reports one assistant activity per wait (#131).

Each poll of a wait is a separate gateway query. Before this fix every poll
was streamed as its own tool activity, so one `--timeout 60` wait produced
about sixty "complete" rows, and a job that ended as failed was still shown as
a completed tool call without an error.
"""
import asyncio
import json
import os
import sys
from types import SimpleNamespace
from uuid import uuid4

import pytest

from opendirector.agent.cli_transport import start_server
from opendirector.agent.gateway import ToolResult

pytestmark = pytest.mark.skipif(not hasattr(asyncio, 'start_unix_server'), reason='Unix socket transport')


class FakeGateway:
    """Answers job.get with a scripted status sequence; records gateway call ids."""

    def __init__(self, project_id, statuses, failure=None):
        self.closed = False
        self.run = SimpleNamespace(project_id=project_id)
        self.statuses = list(statuses)
        self.failure = failure
        self.calls = []

    async def call(self, call_id, name, arguments):
        self.calls.append((call_id, name, arguments))
        status = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
        job = {'id': arguments.get('objectId'), 'status': status,
               'phase': 'complete' if status in {'succeeded', 'failed'} else 'poll'}
        if status == 'failed' and self.failure:
            job['errorDetails'] = self.failure
        return ToolResult(value=job)


async def run_cli(socket_path, project_id, *args):
    env = {**os.environ, 'OPENDIRECTOR_AGENT_SOCKET': socket_path}
    env.pop('OPENDIRECTOR_AGENT_HOST', None)
    process = await asyncio.create_subprocess_exec(
        sys.executable, '-m', 'opendirector.cli', '--project', str(project_id), *args,
        env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    stdout, stderr = await asyncio.wait_for(process.communicate(), 60)
    return process.returncode, stdout.decode(), stderr.decode()


def drain(queue):
    events = []
    while not queue.empty():
        events.append(queue.get_nowait())
    return events


def collapse(events):
    """Mirror the API's activity list: a later event with the same id replaces the row."""
    rows = {}
    for event in events:
        rows[event['id']] = event
    return list(rows.values())


@pytest.fixture
def transport(tmp_path):
    async def serve(gateway):
        queue, pending = asyncio.Queue(), set()
        path = str(tmp_path / 'cli.sock')
        server, _ = await start_server(gateway, queue, path, pending)
        return server, queue, path
    return serve


def test_job_wait_polls_collapse_into_one_failed_activity(transport):
    async def scenario():
        project, job = uuid4(), uuid4()
        failure = {'category': 'provider', 'stage': 'poll', 'message': 'Provider rejected the video task (1027).',
                   'suggestion': 'Change the prompt and retry.', 'providerCode': '1027'}
        gateway = FakeGateway(project, ['running', 'running', 'running', 'failed'], failure)
        server, queue, path = await transport(gateway)
        try:
            code, stdout, stderr = await run_cli(path, project, 'job', 'wait', str(job), '--timeout', '30')
        finally:
            server.close(); await server.wait_closed()
        assert code == 1, (stdout, stderr)
        assert json.loads(stdout)['status'] == 'failed'
        # Every poll still reaches the gateway with its own call id, so no poll replays a cached answer.
        assert len(gateway.calls) == 4
        assert len({call_id for call_id, _, _ in gateway.calls}) == 4
        events = drain(queue)
        assert len(events) == 8
        rows = collapse(events)
        assert len(rows) == 1, rows
        row = rows[0]
        assert row['name'].endswith('job wait')
        assert row['status'] == 'failed'
        assert row['error'] == 'Job failed: Provider rejected the video task (1027).'
        assert json.loads(row['result'])['status'] == 'failed'
    asyncio.run(scenario())


def test_job_wait_success_is_one_complete_activity(transport):
    async def scenario():
        project, job = uuid4(), uuid4()
        gateway = FakeGateway(project, ['queued', 'running', 'succeeded'])
        server, queue, path = await transport(gateway)
        try:
            code, stdout, stderr = await run_cli(path, project, 'job', 'wait', str(job), '--timeout', '30')
        finally:
            server.close(); await server.wait_closed()
        assert code == 0, (stdout, stderr)
        rows = collapse(drain(queue))
        assert len(rows) == 1
        assert rows[0]['status'] == 'complete' and 'error' not in rows[0]
        assert json.loads(rows[0]['result'])['status'] == 'succeeded'
    asyncio.run(scenario())


@pytest.mark.parametrize('status', ['cancelled', 'interrupted'])
def test_job_wait_other_unsuccessful_endings_fail_the_activity(transport, status):
    async def scenario():
        project, job = uuid4(), uuid4()
        gateway = FakeGateway(project, ['running', status])
        server, queue, path = await transport(gateway)
        try:
            code, _, _ = await run_cli(path, project, 'job', 'wait', str(job), '--timeout', '30')
        finally:
            server.close(); await server.wait_closed()
        assert code == 1
        rows = collapse(drain(queue))
        assert len(rows) == 1 and rows[0]['status'] == 'failed'
        assert rows[0]['error'] == f'Job {status}.'
    asyncio.run(scenario())


def test_job_wait_timeout_is_one_complete_activity_and_separate_waits_stay_separate(transport):
    async def scenario():
        project, job = uuid4(), uuid4()
        gateway = FakeGateway(project, ['running'])
        server, queue, path = await transport(gateway)
        try:
            first = await run_cli(path, project, 'job', 'wait', str(job), '--timeout', '1.5')
            second = await run_cli(path, project, 'job', 'wait', str(job), '--timeout', '0')
        finally:
            server.close(); await server.wait_closed()
        assert first[0] == 2 and second[0] == 2
        assert len(gateway.calls) >= 3
        rows = collapse(drain(queue))
        # A timed-out wait is not a failed tool call: the agent is told to wait again.
        assert len(rows) == 2, rows
        assert all(row['status'] == 'complete' for row in rows)
        assert all(json.loads(row['result'])['status'] == 'running' for row in rows)
    asyncio.run(scenario())


def test_job_show_keeps_one_activity_per_read_and_does_not_fail_on_a_failed_job(transport):
    async def scenario():
        project, job = uuid4(), uuid4()
        gateway = FakeGateway(project, ['failed'])
        server, queue, path = await transport(gateway)
        try:
            for _ in range(2):
                code, stdout, _ = await run_cli(path, project, 'job', 'show', str(job))
                assert code == 0 and json.loads(stdout)['status'] == 'failed'
        finally:
            server.close(); await server.wait_closed()
        rows = collapse(drain(queue))
        assert len(rows) == 2
        assert all(row['status'] == 'complete' for row in rows)
    asyncio.run(scenario())


@pytest.mark.parametrize('activity', [
    7, '', 'x' * 513, {'id': 'a'}, ['a'],
])
def test_transport_ignores_malformed_activity_ids(transport, activity):
    async def scenario():
        project = uuid4()
        gateway = FakeGateway(project, ['running'])
        server, queue, path = await transport(gateway)
        try:
            reader, writer = await asyncio.open_unix_connection(path)
            key = str(uuid4())
            writer.write((json.dumps({'id': key, 'cliCommand': 'opendirector job wait', 'projectId': str(project),
                                      'name': 'query', 'arguments': {'type': 'job.get', 'objectId': str(uuid4())},
                                      'activity': {'id': activity, 'kind': 'job.wait'}}) + '\n').encode())
            await writer.drain()
            response = json.loads(await reader.readline())
            writer.close(); await writer.wait_closed()
        finally:
            server.close(); await server.wait_closed()
        assert response['error'] is None
        events = drain(queue)
        assert {event['id'] for event in events} == {'cli:' + key}
    asyncio.run(scenario())


def test_transport_does_not_fail_unrelated_queries_tagged_as_job_wait(transport):
    """Only a job.get result decides a job.wait activity's status."""
    async def scenario():
        project = uuid4()

        class Gateway(FakeGateway):
            async def call(self, call_id, name, arguments):
                self.calls.append(call_id)
                return ToolResult(value={'status': 'failed', 'note': 'not a job read'})

        gateway = Gateway(project, ['failed'])
        server, queue, path = await transport(gateway)
        try:
            reader, writer = await asyncio.open_unix_connection(path)
            writer.write((json.dumps({'id': str(uuid4()), 'cliCommand': 'opendirector query', 'projectId': str(project),
                                      'name': 'read_project', 'arguments': {},
                                      'activity': {'id': 'wait-1', 'kind': 'job.wait'}}) + '\n').encode())
            await writer.drain()
            await reader.readline()
            writer.close(); await writer.wait_closed()
        finally:
            server.close(); await server.wait_closed()
        rows = collapse(drain(queue))
        assert len(rows) == 1 and rows[0]['status'] == 'complete'
    asyncio.run(scenario())
