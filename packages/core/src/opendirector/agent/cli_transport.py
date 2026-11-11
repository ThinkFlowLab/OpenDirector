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
                await queue.put({'type': 'tool', 'id': 'cli:' + key, 'name': display_name,
                    'status': 'running', 'arguments': arguments})
                outcome = await gateway.call('cli:' + key, name, arguments)
                response = {'value': outcome.value, 'error': outcome.error}
                if outcome.error and isinstance(outcome.value, dict) and isinstance(outcome.value.get('code'), str):
                    response['code'] = outcome.value['code']
                detail = json.dumps(outcome.value, ensure_ascii=False, indent=2)
                await queue.put({**outcome.event(display_name), 'id': 'cli:' + key,
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
