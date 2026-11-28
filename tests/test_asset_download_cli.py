"""Download real originals through the terminal and the turn-scoped CLI."""
import asyncio
from hashlib import sha256
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
from typing import Literal
from uuid import UUID, uuid4

import httpx
from PIL import Image
from pydantic import JsonValue
import pytest
import uvicorn

import opendirector
from opendirector import cli
from opendirector.agent import cli_transport
from opendirector.agent.context import RunContext
from opendirector.agent.gateway import ToolGateway
from opendirector.agent.tools import AgentTools
from opendirector.domain.creation.assets import Asset
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector_api.main import create_app
from test_creation_assets import import_asset, png
from test_creation_canvas_service import project, send, ver


@pytest.fixture
def cli_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    # Keep subprocess diagnostics independent of the developer's credentials and
    # ensure the child imports the same checkout after changing directories.
    platform_variables = {'COMSPEC', 'HOME', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP',
                          'TMPDIR', 'USERPROFILE', 'WINDIR'}
    for name in set(os.environ) - platform_variables:
        monkeypatch.delenv(name)
    monkeypatch.setenv('PYTHONPATH', str(Path(opendirector.__file__).resolve().parents[1]))


async def invoke(prefix: list[str], env: dict[str, str], cwd: Path, project_id: UUID,
                 asset: Asset, output: str, *, revision: int | None = None,
                 status: int = 0) -> dict[str, JsonValue]:
    process = await asyncio.create_subprocess_exec(*prefix, '--project', str(project_id),
        'asset', 'download', '--id', str(asset.id),
        '--revision', str(asset.revision if revision is None else revision), '--output', output,
        cwd=cwd, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), 15)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    assert process.returncode == status, (stdout, stderr)
    return json.loads(stdout)


async def check_downloads(prefix: list[str], env: dict[str, str], cwd: Path, project_id: UUID,
                          foreign_id: UUID, sources: tuple[tuple[Asset, bytes], ...]) -> None:
    for (asset, original), output in zip(sources, ('original.png', 'original.mp4'), strict=True):
        result = await invoke(prefix, env, cwd, project_id, asset, output)
        target = cwd / output
        assert (cwd / result['path']).resolve() == target.resolve()
        assert result['assetId'] == str(asset.id) and result['revision'] == asset.revision
        assert result['mimeType'] == asset.metadata.mimeType
        assert result['size'] == len(original)
        assert result['fingerprint'] == 'sha256:' + sha256(original).hexdigest()
        assert target.read_bytes() == original

    with Image.open(cwd / 'original.png') as image:
        image.load()
        assert (image.format, image.size, image.getpixel((0, 0))) == ('PNG', (13, 7), (128, 0, 128))
    probe = subprocess.run(['ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'json', str(cwd / 'original.mp4')],
        check=True, capture_output=True, timeout=10)
    video, = json.loads(probe.stdout)['streams']
    assert video == {'width': 64, 'height': 48, 'nb_read_frames': '3'}

    image_asset, image_bytes = sources[0]
    assert (await invoke(prefix, env, cwd, project_id, image_asset, 'missing.png',
        revision=image_asset.revision + 2, status=1))['code'] == 'asset_revision_unavailable'
    assert not (cwd / 'missing.png').exists()
    assert (await invoke(prefix, env, cwd, foreign_id, image_asset, 'foreign.png', status=1))['error']
    assert not (cwd / 'foreign.png').exists()
    assert (await invoke(prefix, env, cwd, project_id, image_asset, 'original.png',
        status=1))['code'] == 'asset_download_destination_exists'
    assert (cwd / 'original.png').read_bytes() == image_bytes


@pytest.mark.merge
@pytest.mark.requires_ffmpeg
@pytest.mark.skipif(not shutil.which('ffmpeg') or not shutil.which('ffprobe'), reason='requires local FFmpeg')
@pytest.mark.usefixtures('cli_environment')
@pytest.mark.parametrize('transport', ['http', 'agent-shell'])
def test_asset_download_exact_originals(project: tuple[CreationProjects, UUID, str], tmp_path: Path,
                                        transport: Literal['http', 'agent-shell']) -> None:
    store, project_id, session = project
    image_bytes = png()
    image, _, _ = import_asset(project, 'before-name-change.png', image_bytes)
    assert send(store, project_id, 'asset.updateMetadata', session=session, versions=[ver('asset', image)],
        assetId=image.id, name='renamed.png').status == 'applied'
    assert store.snapshot(project_id).assets[0].revision == image.revision + 1

    input_video = tmp_path / 'source.mp4'
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=64x48:r=24',
        '-frames:v', '3', '-c:v', 'mpeg4', '-threads', '1', str(input_video)], check=True, timeout=10)
    video_bytes = input_video.read_bytes()
    video, _, _ = import_asset(project, 'source.mp4', video_bytes)
    foreign_id = uuid4()
    assert send(store, foreign_id, 'project.create', name='Different project').status == 'applied'
    before = store.snapshot(project_id)
    store.local.release(session)
    sources = ((image, image_bytes), (video, video_bytes))

    async def check_http() -> None:
        work = tmp_path / 'terminal'
        work.mkdir()
        env = dict(os.environ)
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            host, port = listener.getsockname()
            env['OPENDIRECTOR_API_URL'] = f'http://{host}:{port}'
            app = create_app(store.local)
            server = uvicorn.Server(uvicorn.Config(app, log_level='error', ws='none'))
            serving = asyncio.create_task(server.serve(sockets=[listener]))
            try:
                async with asyncio.timeout(10):
                    while not server.started:
                        if serving.done():
                            await serving
                            pytest.fail('API exited before listening')
                        await asyncio.sleep(0.01)
                await check_downloads([sys.executable, '-m', 'opendirector.cli'], env, work,
                    project_id, foreign_id, sources)
            finally:
                server.should_exit = True
                await asyncio.wait_for(serving, 10)

    async def check_agent_shell() -> None:
        with store.local.transaction() as db:
            directory, _, _ = store._load(db, project_id)
        turn = uuid4()
        work = directory / 'agent-runs' / str(turn) / 'work'
        work.mkdir(parents=True)
        run = RunContext(runtime='codex', project_id=project_id, turn_id=turn, session=session,
            directory=directory, config=None, messages=[], selected_skills=[])
        gateway = ToolGateway(AgentTools(store, None, ModelConfigs(tmp_path)), run)
        gateway.execution_directory = work
        queue = asyncio.Queue()
        with TemporaryDirectory(prefix='od-', dir=None if os.name == 'nt' else '/tmp') as temporary:
            async with cli_transport.turn_environment(work, gateway, queue, temporary) as env:
                env['OPENDIRECTOR_API_URL'] = 'http://127.0.0.1:1'
                launcher = work / '.opendirector-bin' / ('opendirector.cmd' if os.name == 'nt' else 'opendirector')
                prefix = [os.environ['COMSPEC'], '/d', '/c', str(launcher)] if os.name == 'nt' else [str(launcher)]
                await check_downloads(prefix, env, work, project_id, foreign_id, sources)
                outside = work.parent / 'outside.png'
                assert (await invoke(prefix, env, work, project_id, image, str(outside), status=1))['error']
                assert not outside.exists()
        events = [queue.get_nowait() for _ in range(queue.qsize())]
        assert sum(event['name'] == 'opendirector asset download' and event['status'] == 'complete'
                   for event in events) == 2

    asyncio.run(check_http() if transport == 'http' else check_agent_shell())
    assert store.snapshot(project_id) == before


@pytest.mark.ready
@pytest.mark.usefixtures('cli_environment')
@pytest.mark.parametrize('revision_header,body,code', [
    (None, b'original', 'asset_download_version_unconfirmed'),
    ('2', b'original', 'asset_download_version_unconfirmed'),
    ('1', b'wrong!!!', 'asset_download_integrity'),
    ('1', b'short', 'asset_download_integrity'),
], ids=['old-server', 'wrong-revision', 'wrong-fingerprint', 'short-response'])
def test_asset_download_rejects_unconfirmed_http_responses(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str], revision_header: str | None, body: bytes, code: str) -> None:
    project_id, asset_id = uuid4(), uuid4()
    output = tmp_path / 'asset.png'
    original = b'original'

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.method == 'GET'
        assert request.url.path == f'/api/creation/projects/{project_id}/assets/{asset_id}/content'
        assert request.url.params['revision'] == '1'
        headers = {
            'Content-Length': str(len(original)),
            'Content-Type': 'image/png',
            'ETag': '"sha256:' + sha256(original).hexdigest() + '"',
        }
        if revision_header is not None:
            headers['X-OpenDirector-Asset-Revision'] = revision_header
        return httpx.Response(200, headers=headers, content=body)

    client_type = httpx.Client
    monkeypatch.setattr(cli.httpx, 'Client', lambda **options:
        client_type(**options, transport=httpx.MockTransport(respond)))
    monkeypatch.setattr(sys, 'argv', ['opendirector', '--project', str(project_id), '--url', 'http://api.test',
        'asset', 'download', '--id', str(asset_id), '--revision', '1', '--output', str(output)])
    with pytest.raises(SystemExit) as failure:
        cli.main()
    assert failure.value.code == 1
    assert json.loads(capsys.readouterr().out)['code'] == code
    assert not list(tmp_path.iterdir())
