"""Turn-scoped transport and executable environment for the business CLI."""
import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import shlex
import sys

from opendirector.domain.projects import ProjectError


def environment(work, socket, bridge_env=None):
    env = dict(os.environ)
    env['PWD'] = str(work)
    env.update(bridge_env or {'OPENDIRECTOR_AGENT_SOCKET': socket})
    cli_bin = work / '.opendirector-bin'
    cli_bin.mkdir(exist_ok=True)
    if os.name == 'nt':
        (cli_bin / 'opendirector.cmd').write_text(f'@"{sys.executable}" -m opendirector.cli %*\n')
    else:
        launcher = cli_bin / 'opendirector'
        launcher.write_text('#!/bin/sh\nexec ' + shlex.join([sys.executable, '-m', 'opendirector.cli']) + ' "$@"\n')
        launcher.chmod(0o700)
    env['PATH'] = str(cli_bin) + os.pathsep + env.get('PATH', '')
    return env


def activity(request):
    """Return the CLI's (activity id, kind) when it groups several gateway calls.

    One `job wait` polls `job.get` about once a second. Each poll stays a
    separate gateway call (a replayed call id would return a stale answer), but
    the assistant shows them as one activity updated in place.
    """
    value = request.get('activity')
    if not isinstance(value, dict):
        return None, None
    identity, kind = value.get('id'), value.get('kind')
    if not isinstance(identity, str) or not 0 < len(identity) <= 512:
        return None, None
    return 'activity:' + identity, kind if kind == 'job.wait' else None


def unsuccessful_job(name, arguments, value):
    """Describe a job read that ended without success, for a job wait activity.

    The wording is the stable receipt. The assistant renders it from
    `assistant.activity.jobWait*` in zh-CN and en-US; keep these sentences
    aligned with that catalog.
    """
    if name != 'query' or not isinstance(arguments, dict) or arguments.get('type') != 'job.get':
        return None
    job = value.get('job', value) if isinstance(value, dict) else None
    status = job.get('status') if isinstance(job, dict) else None
    if status not in {'failed', 'cancelled', 'interrupted'}:
        return None
    details = job.get('errorDetails')
    message = details.get('message') if isinstance(details, dict) else None
    return f'Job {status}: {message}' if isinstance(message, str) and message else f'Job {status}.'


async def start_server(gateway, queue, endpoint, pending):
    async def connection(reader, writer):
        task = asyncio.current_task()
        pending.add(task)
        try:
            try:
                request = json.loads(await asyncio.wait_for(reader.readline(), 15))
                if gateway.closed:
                    raise ProjectError('Agent run is closed', 409)
                if request.get('projectId') and request['projectId'] != str(gateway.run.project_id):
                    raise ProjectError('CLI project does not match the active agent project.', 403)
                key, name, arguments = str(request['id']), request['name'], request.get('arguments', {})
                display_name = request['cliCommand']
                activity_id, activity_kind = activity(request)
                event_id = 'cli:' + (activity_id or key)
                await queue.put({'type': 'tool', 'id': event_id, 'name': display_name,
                    'status': 'running', 'arguments': arguments})
                outcome = await gateway.call('cli:' + key, name, arguments)
                response = {'value': outcome.value, 'error': outcome.error}
                if outcome.error and isinstance(outcome.value, dict) and isinstance(outcome.value.get('code'), str):
                    response['code'] = outcome.value['code']
                detail = json.dumps(outcome.value, ensure_ascii=False, indent=2)
                event = outcome.event(display_name)
                if activity_kind == 'job.wait' and not outcome.error:
                    failure = unsuccessful_job(name, arguments, outcome.value)
                    if failure:
                        event = {**event, 'status': 'failed', 'error': failure}
                await queue.put({**event, 'id': event_id,
                    'arguments': arguments, 'result': detail[:65536],
                    'resultTruncated': len(detail) > 65536})
            except (ProjectError, ValueError, KeyError, OSError, TimeoutError) as failure:
                response = {'error': str(failure)}
            writer.write(json.dumps(response, ensure_ascii=False).encode() + b'\n')
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()
            pending.discard(task)

    if hasattr(asyncio, 'start_unix_server'):
        return await asyncio.start_unix_server(connection, endpoint, limit=4 * 1024 * 1024), None
    server = await asyncio.start_server(connection, '127.0.0.1', 0, limit=4 * 1024 * 1024)
    host, port = server.sockets[0].getsockname()[:2]
    return server, {'OPENDIRECTOR_AGENT_HOST': str(host), 'OPENDIRECTOR_AGENT_PORT': str(port)}


@asynccontextmanager
async def turn_environment(work, gateway, queue, temporary):
    endpoint = str(Path(temporary) / 'cli.sock')
    calls = set()
    server, bridge_env = await start_server(gateway, queue, endpoint, calls)
    try:
        env = environment(work, endpoint, bridge_env)
        env['OPENDIRECTOR_PROJECT_ID'] = str(gateway.run.project_id)
        yield env
    finally:
        await gateway.close()
        server.close()
        await server.wait_closed()
        await asyncio.gather(*calls, return_exceptions=True)
