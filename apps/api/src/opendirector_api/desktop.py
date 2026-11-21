"""Private parent-controlled API host for the desktop application."""
import asyncio
from contextlib import redirect_stdout
import json
import logging
import os
import secrets
import shutil
import socket
import subprocess
import sys
import threading
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter
import uvicorn
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Scope, Receive, Send
from starlette.requests import Request

from opendirector_api.localization import localized_error

from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.installation import data_root
from opendirector_api.main import create_app
from opendirector_api.server import logging_config


class DesktopAuthentication:
    """Protect every HTTP resource, including media and the application document."""

    def __init__(self, app: ASGIApp, *, token: str) -> None:
        self.app = app
        self.token = token

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        headers = dict(scope.get('headers', []))
        supplied = headers.get(b'x-opendirector-desktop', b'')
        if not secrets.compare_digest(supplied, self.token.encode('ascii')):
            if scope['type'] == 'websocket':
                await send({'type': 'websocket.close', 'code': 1008})
            elif scope['type'] == 'http':
                await JSONResponse({'detail': localized_error(Request(scope), chinese='桌面连接已失效，请重新打开应用。', status=403, code='desktop_auth_required')}, status_code=403)(scope, receive, send)
            else:
                await self.app(scope, receive, send)
            return
        await self.app(scope, receive, send)


class Initialize(BaseModel):
    model_config = ConfigDict(extra='forbid')
    type: Literal['initialize']
    version: Literal[1]
    token: str = Field(min_length=64, max_length=64, pattern=r'^[a-f0-9]+$')


class Control(BaseModel):
    model_config = ConfigDict(extra='forbid')
    type: Literal['inspect', 'shutdown']
    requestId: int = Field(ge=1)


class SessionRegistration(BaseModel):
    model_config = ConfigDict(extra='forbid')
    type: Literal['session']
    sessionId: UUID


CONTROL = TypeAdapter(Annotated[Control | SessionRegistration, Field(discriminator='type')])


def runtime_check() -> dict[str, str]:
    from opendirector.agent.native import executable
    from opendirector.installation import web_root
    if not (web_root() / 'index.html').is_file():
        raise RuntimeError('Web resources are missing.')
    commands = {'agent': executable('default'), 'ffmpeg': shutil.which('ffmpeg'), 'ffprobe': shutil.which('ffprobe')}
    versions = {'python': sys.version.split()[0]}
    for name, path in commands.items():
        if not path:
            raise RuntimeError(f'{name} is missing from the bundled runtime.')
        result = subprocess.run([path, '--version' if name == 'agent' else '-version'],
                                capture_output=True, text=True, timeout=20, check=True)
        versions[name] = result.stdout.splitlines()[0]
    return versions


async def serve(token: str) -> None:
    output = sys.stdout

    def emit(event: dict[str, object]) -> None:
        output.write(json.dumps(event) + '\n')
        output.flush()

    emit({'type': 'starting', 'version': 1})
    with redirect_stdout(sys.stderr):
        versions = await asyncio.to_thread(runtime_check)
        store = LocalProjects(data_root())
        app = create_app(store)
    app.add_middleware(DesktopAuthentication, token=token)
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(('127.0.0.1', 0))
    listener.listen(128)
    port = listener.getsockname()[1]
    os.environ['OPENDIRECTOR_API_URL'] = f'http://127.0.0.1:{port}'
    sessions: set[str] = set()
    commands: asyncio.Queue[str] = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def read_controls() -> None:
        while line := sys.stdin.readline(65537):
            if len(line) > 65536:
                loop.call_soon_threadsafe(commands.put_nowait, 'invalid\n')
                return
            loop.call_soon_threadsafe(commands.put_nowait, line)
        loop.call_soon_threadsafe(commands.put_nowait, '')

    class DesktopServer(uvicorn.Server):
        async def startup(self, sockets: list[socket.socket] | None = None) -> None:
            await super().startup(sockets)
            if not self.should_exit:
                emit({'type': 'ready', 'version': 1, 'url': f'http://127.0.0.1:{port}', 'runtime': versions})

    server = DesktopServer(uvicorn.Config(app, log_config=logging_config(), access_log=False,
                                         timeout_graceful_shutdown=15))

    async def control() -> None:
        while True:
            line = await commands.get()
            if not line:
                server.should_exit = True
                return
            message = CONTROL.validate_json(line)
            if message.type == 'session':
                sessions.add(str(message.sessionId))
                continue
            if message.type == 'shutdown':
                server.should_exit = True
                return
            emit({'type': 'inspection', 'requestId': message.requestId, **app.state.desktop_activity()})

    threading.Thread(target=read_controls, name='desktop-parent', daemon=True).start()
    reader = asyncio.create_task(control())
    try:
        serving = asyncio.create_task(server.serve(sockets=[listener]))
        done, _ = await asyncio.wait([reader, serving], return_when=asyncio.FIRST_COMPLETED)
        if reader in done and not reader.cancelled() and reader.exception():
            server.should_exit = True
            await serving
            raise reader.exception()
        await serving
    finally:
        reader.cancel()
        await asyncio.gather(reader, return_exceptions=True)
        listener.close()
        for session_id in sessions:
            await asyncio.to_thread(store.release, session_id)
    emit({'type': 'shutdown-complete'})


def main() -> None:
    try:
        message = Initialize.model_validate_json(sys.stdin.readline(65537))
        asyncio.run(serve(message.token))
    except ValueError:
        print(json.dumps({'type': 'fatal', 'version': 1, 'message': 'Invalid desktop control message.'}), flush=True)
        raise SystemExit(1) from None
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        logging.getLogger(__name__).exception('Desktop Host failed')
        print(json.dumps({'type': 'fatal', 'version': 1, 'message': str(error)}), flush=True)
        raise SystemExit(1) from error


if __name__ == '__main__':
    main()
