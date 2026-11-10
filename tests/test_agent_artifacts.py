import asyncio
import os
from pathlib import Path
import shutil
import subprocess
from uuid import UUID, uuid4, uuid5

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from opendirector.application.creation_artifacts import publish_artifact
from opendirector.application.creation_canvas import asset_ref
from opendirector.domain.creation.assets import AssetProvenance
from opendirector.agent.context import RunContext
from opendirector.agent.gateway import ToolGateway
from opendirector.agent.tools import AgentTools
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector_api.main import create_app


@pytest.fixture
def publication(tmp_path):
    projects = CreationProjects(LocalProjects(tmp_path))
    pid, turn, session = uuid4(), uuid4(), str(uuid4())
    projects.execute(parse_command({'type': 'project.create', 'projectId': pid,
        'commandId': uuid4(), 'payload': {'name': 'Artifact tests'}}))
    directory = projects.open(pid, session)
    with projects.local.transaction() as db:
        directory, _, _ = projects._load(db, pid)
    work = directory / 'agent-runs' / str(turn) / 'work'
    work.mkdir(parents=True)
    business = AgentTools(projects, None, ModelConfigs(tmp_path))
    run = RunContext(runtime='codex', project_id=pid, turn_id=turn, session=session,
        directory=directory, config=None, messages=[], selected_skills=[])
    return business, run, work


def publish(publication, path, *, identity=None, name=None, sources=()):
    business, run, _ = publication
    command = parse_command({'type': 'artifact.publish', 'projectId': run.project_id,
        'commandId': uuid5(run.turn_id, str(identity)) if identity is not None else uuid4(),
        'payload': {'path': path, 'name': name or Path(path).name, 'sources': list(sources)}})
    receipt = publish_artifact(business.assets, command, execution_directory=run.directory / 'agent-runs' / str(run.turn_id) / 'work', session=run.session,
        provenance=AssetProvenance(source='agent_written', agentRunId=run.turn_id, agentRuntime='codex',
            sources=command.payload.sources))
    assert receipt.status == 'applied'
    asset = business.assets.get(run.project_id, receipt.changed[0].id)
    return {**receipt.model_dump(mode='json'), 'asset': asset.model_dump(mode='json'),
        'reference': asset_ref(asset).model_dump(mode='json')}



def test_text_image_publication_replay_and_content_conflict(publication):
    business, run, work = publication
    original = work / 'plan.md'
    original.write_text('A plan')
    identity = 'segment-01'
    result = publish(publication, 'plan.md', identity=identity)
    assert result['status'] == 'applied'
    assert result['asset']['provenance']['agentRunId'] == str(run.turn_id)
    assert result['asset']['metadata']['mimeType'] == 'text/markdown'
    assert publish(publication, 'plan.md', identity=identity)['asset']['id'] == result['asset']['id']
    with pytest.raises(ProjectError, match='不同输入'):
        publish(publication, 'plan.md', identity=identity, name='other.md')
    original.write_text('Changed')
    assert publish(publication, 'plan.md', identity=identity)['asset']['fingerprint'] == result['asset']['fingerprint']
    assert len(business.projects.snapshot(run.project_id).assets) == 1
    assert original.read_text() == 'Changed'
    Image.new('RGB', (13, 7), 'purple').save(work / 'frame.png')
    image = publish(publication, str(work / 'frame.png'), sources=[result['reference']])
    assert image['asset']['metadata']['width'] == 13
    assert image['asset']['provenance']['sources'] == [result['reference']]


def test_file_scope_links_empty_and_other_turn_are_rejected(publication, tmp_path):
    _, _, work = publication
    outside = tmp_path / 'outside.md'
    outside.write_text('outside')
    for path in [str(outside), '../outside.md']:
        with pytest.raises(ProjectError, match='本轮执行目录'):
            publish(publication, path)
    if os.name == 'nt':
        import _winapi
        alias = work / 'directory'
        _winapi.CreateJunction(str(tmp_path), str(alias))
        paths = ['directory/outside.md']
    else:
        (work / 'link.md').symlink_to(outside)
        (work / 'directory').symlink_to(tmp_path, target_is_directory=True)
        paths = ['link.md', 'directory/outside.md']
    try:
        for path in paths:
            with pytest.raises(OSError):
                publish(publication, path)
    finally:
        if os.name == 'nt': alias.rmdir()
    (work / 'empty.md').touch()
    with pytest.raises(ProjectError, match='非空普通文件'):
        publish(publication, 'empty.md')
    (work / 'folder').mkdir()
    with pytest.raises(ProjectError, match='非空普通文件'):
        publish(publication, 'folder', name='directory.md')


def test_retry_after_lost_commit_response_does_not_duplicate(publication, monkeypatch):
    business, run, work = publication
    (work / 'plan.md').write_text('plan')
    execute = business.assets.register
    def lost(*args, **kwargs):
        execute(*args, **kwargs)
        raise OSError('lost response')
    identity = uuid4()
    monkeypatch.setattr(business.assets, 'register', lost)
    with pytest.raises(OSError, match='lost response'):
        publish(publication, 'plan.md', identity=identity)
    monkeypatch.setattr(business.assets, 'register', execute)
    assert publish(publication, 'plan.md', identity=identity)['status'] == 'applied'
    assert len(business.projects.snapshot(run.project_id).assets) == 1


def test_five_video_artifacts_become_independent_assets(publication):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('requires ffmpeg and ffprobe')
    business, run, work = publication
    source = work / 'source.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:r=24',
        '-frames:v', '12', '-pix_fmt', 'yuv420p', str(source)], check=True)
    original = publish(publication, 'source.mp4')
    gateway = ToolGateway(business, run)
    async def publish_segments():
        for index in range(5):
            name = f'segment-{index}.mp4'
            shutil.copyfile(source, work / name)
            response = await gateway.call(str(index), 'execute_command', {'type': 'artifact.publish',
                'payload': {'path': name, 'name': name, 'sources': [original['reference']]}})
            assert response.error is None, response
            asset = business.assets.get(run.project_id, response.value['changed'][0]['id'])
            assert asset.metadata.frameRate == 24
            shown = await gateway.call(f'canvas-{index}', 'execute_command', {
                'type': 'canvas.show', 'payload': {'item': {'id': str(uuid4()),
                    'projectId': str(run.project_id), 'kind': 'video', 'title': name,
                    'position': {'x': index * 360, 'y': 0},
                    'binding': {'role': 'material', 'objectRef': asset_ref(asset).model_dump(mode='json')}}}})
            assert shown.error is None, shown
        await gateway.close()
    asyncio.run(publish_segments())
    assets = business.projects.snapshot(run.project_id).assets
    assert len(assets) == 6
    assert len({asset.id for asset in assets}) == 6
    assert all(asset.kind == 'video' for asset in assets)
    assert len(business.projects.snapshot(run.project_id).canvasItems) == 5


def test_generic_file_and_audio_follow_shared_import_rules(publication):
    import wave
    _, _, work = publication
    (work / 'report.html').write_text('<html>Report</html>')
    report = publish(publication, 'report.html')
    assert report['asset']['kind'] == 'file'
    with wave.open(str(work / 'sound.wav'), 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b'\0\0' * 800)
    assert publish(publication, 'sound.wav')['asset']['kind'] == 'audio'


def test_publication_is_a_command_not_a_separate_tool():
    from opendirector.agent.tools import tools, COMMANDS
    assert 'publish_artifact' not in {tool['function']['name'] for tool in tools()}
    schema = COMMANDS['artifact.publish'].model_json_schema()
    assert 'commandId' in schema['properties']
    payload = schema['$defs']['ArtifactPublish']['properties']
    assert set(payload) == {'path', 'name', 'expectedKind', 'sources'}


def test_publication_replay_does_not_require_original_output_file(publication):
    business, run, work = publication
    (work / 'plan.md').write_text('plan')
    first = publish(publication, 'plan.md', identity='same-command')
    (work / 'plan.md').unlink()
    replay = publish(publication, 'plan.md', identity='same-command')
    assert first == replay
    with business.projects.local.transaction() as db:
        _, _, records = business.projects._load(db, run.project_id)
    record = next(record for record in records if str(record.command.commandId) == first['commandId'])
    assert record.command.type == 'artifact.publish'
    assert not list(business.projects.state_dir.glob('agent-publication-*.json'))


def test_http_cannot_supply_its_own_execution_context(publication):
    from fastapi.testclient import TestClient
    from opendirector_api.main import create_app
    business, run, _ = publication
    with TestClient(create_app(business.projects.local), headers={
        'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': run.session}) as client:
        response = client.post(f'/api/creation/projects/{run.project_id}/commands', json={
            'type': 'artifact.publish', 'projectId': str(run.project_id), 'commandId': str(uuid4()),
            'payload': {'path': '/etc/passwd', 'name': 'outside.txt'}})
        assert response.status_code == 403
        assert business.projects.snapshot(run.project_id).assets == ()


@pytest.mark.parametrize('kind', ['image', 'video', 'audio'])
def test_asset_id_preview_is_bounded_and_preserves_project(publication, kind):
    business, run, work = publication
    if kind == 'image':
        source = work / 'image.png'
        Image.new('RGB', (1000, 600), 'red').save(source)
    else:
        if not shutil.which('ffmpeg'):
            pytest.skip('requires FFmpeg')
        source = work / ('video.mp4' if kind == 'video' else 'audio.wav')
        command = ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
            'color=red:s=160x120:r=5' if kind == 'video' else 'sine=frequency=440', '-t', '1']
        subprocess.run([*command, str(source)], check=True)
    published = publish(publication, source.name)
    asset_id = UUID(published['asset']['id'])
    before = business.projects.snapshot(run.project_id)
    gateway = ToolGateway(business, run)
    result = asyncio.run(gateway.call('preview', 'query', {'type': 'asset.preview', 'objectId': str(asset_id)}))
    assert not result.error, result
    preview = Path(result.value['preview']['path'])
    assert preview.is_relative_to(work / 'previews') and preview.stat().st_size > 0
    assert preview.stem == asset_id.hex  # Keep Windows execution paths bounded.
    if kind != 'audio':
        with Image.open(preview) as image:
            assert max(image.size) <= (480 if kind == 'image' else 960)
    else:
        import wave
        with wave.open(str(preview)) as audio:
            assert audio.getnframes() / audio.getframerate() <= 30
    assert business.projects.snapshot(run.project_id) == before
    missing = asyncio.run(gateway.call('missing', 'query', {'type': 'asset.preview', 'objectId': str(uuid4())}))
    assert missing.error


@pytest.mark.anyio
async def test_public_queries_share_http_and_agent_results(publication, tmp_path):
    business, run, work = publication
    source = work / 'query-source.png'
    Image.new('RGB', (24, 32), 'blue').save(source)
    asset = publish(publication, source.name)['asset']
    item_id = uuid4()
    business.projects.execute(parse_command({'type': 'canvas.show', 'projectId': run.project_id,
        'commandId': uuid4(), 'payload': {'item': {'id': item_id, 'projectId': run.project_id,
            'kind': 'image', 'binding': {'role': 'material', 'objectRef': asset_ref(business.assets.get(run.project_id, UUID(asset['id'])))}}}}), session=run.session)
    before = business.projects.snapshot(run.project_id)
    gateway = ToolGateway(business, run)
    path = f'/api/creation/projects/{run.project_id}'
    with TestClient(create_app(business.projects.local), headers={'X-OpenDirector-Request': '1'}) as client:
        for kind, extra in [('project.get', {}), ('object.get', {'objectId': str(item_id)}),
                            ('canvas.status', {'objectId': str(item_id), 'waitSeconds': 0}),
                            ('asset.search', {'text': 'query-source', 'limit': 1}),
                            ('asset.usage', {'objectId': asset['id']})]:
            args = {'type': kind, **extra}
            result = await gateway.call(kind, 'query', args)
            response = client.post(path + '/queries', json={**args, 'projectId': str(run.project_id), 'queryId': str(uuid4())})
            assert response.status_code == 200, response.text
            assert not result.error, result
            assert result.value == response.json()
        args = {'type': 'asset.preview', 'objectId': asset['id']}
        preview = await gateway.call('preview-shared', 'query', args)
        assert not preview.error
        assert Path(preview.value['preview']['path']).is_relative_to(work / 'previews')
        response = client.post(path + '/queries', json={**args, 'projectId': str(run.project_id), 'queryId': str(uuid4())})
        assert response.status_code == 200, response.text
        value = response.json()
        assert 'path' not in value['preview']
        media = client.get(value['preview']['url'])
        assert media.status_code == 200 and media.headers['content-type'] == 'image/webp'
        assert media.content == Path(preview.value['preview']['path']).read_bytes()
        assert value['metadata'] == preview.value['metadata']
    wrong = await gateway.call('wrong-fields', 'query', {'type': 'object.get', 'objectId': str(item_id), 'waitSeconds': 1})
    assert wrong.error and 'waitSeconds' in wrong.error
    missing = await gateway.call('missing-id', 'query', {'type': 'canvas.status'})
    assert missing.error and 'objectId' in missing.error
    destination = Path(preview.value['preview']['path'])
    destination.unlink()
    if os.name == 'nt':
        import _winapi
        outside = tmp_path / 'outside-previews'; outside.mkdir()
        protected_file = outside / destination.name
        protected_file.write_bytes(b'outside preview must not be overwritten')
        destination.parent.rmdir()
        _winapi.CreateJunction(str(outside), str(destination.parent))
    else:
        destination.symlink_to(source)
    original = source.read_bytes()
    protected = await gateway.call('preview-symlink', 'query', {'type': 'asset.preview', 'objectId': asset['id']})
    assert protected.error and source.read_bytes() == original
    if os.name == 'nt':
        assert protected_file.read_bytes() == b'outside preview must not be overwritten'
        destination.parent.rmdir()
    scoped = await gateway.call('wrong-scope', 'query', {'type': 'project.get', 'projectId': str(uuid4())})
    assert scoped.error
    assert business.projects.snapshot(run.project_id) == before
    await gateway.close()
