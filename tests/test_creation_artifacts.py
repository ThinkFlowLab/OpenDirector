"""Execution files become real project assets through ordinary command receipts."""
from pathlib import Path
import os
import shutil
import subprocess
from uuid import uuid4
import wave

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from opendirector.application.creation_artifacts import publish_artifact
from opendirector.application.creation_assets import CreationAssets
from opendirector.application.creation_canvas import asset_ref
from opendirector.domain.creation.assets import AssetProvenance
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.creation.models import ModelSnapshot
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector_api.main import create_app


@pytest.fixture
def publication(tmp_path):
    projects = CreationProjects(LocalProjects(tmp_path))
    project_id, session = uuid4(), str(uuid4())
    projects.execute(parse_command({'type': 'project.create', 'projectId': project_id,
        'commandId': uuid4(), 'payload': {'name': 'Artifact tests'}}))
    projects.open(project_id, session)
    work = tmp_path / 'execution'
    work.mkdir()
    provenance = AssetProvenance(source='agent_written', agentRunId=uuid4(),
        modelSnapshot=ModelSnapshot(modelConfigId=uuid4(), kind='agent', modelId='test-model',
            url='http://localhost:1/v1', protocol='openai', connectionType='self_hosted'))
    return CreationAssets(projects), project_id, session, work, provenance


def command(publication, path, *, command_id=None, name=None, sources=()):
    _, project_id, _, _, _ = publication
    return parse_command({'type': 'artifact.publish', 'projectId': project_id,
        'commandId': command_id or uuid4(), 'payload': {'path': path,
            'name': name or Path(path).name, 'sources': list(sources)}})


def publish(publication, value):
    assets, _, session, work, provenance = publication
    return publish_artifact(assets, value, execution_directory=work, session=session,
        provenance=provenance)


def test_publish_replay_conflict_and_command_history(publication):
    assets, project_id, _, work, provenance = publication
    output = work / 'plan.md'
    output.write_text('Original plan')
    value = command(publication, 'plan.md')
    first = publish(publication, value)
    assert first.status == 'applied'
    asset = assets.get(project_id, first.changed[0].id)
    assert asset.provenance == provenance
    assert asset.metadata.mimeType == 'text/markdown'
    assert output.read_text() == 'Original plan'
    output.write_text('Changed after publication')
    assert publish(publication, value) == first
    output.unlink()
    assert publish(publication, value) == first
    with pytest.raises(ProjectError, match='不同输入'):
        publish(publication, command(publication, 'other.md', command_id=value.commandId))
    with assets.projects.local.transaction() as db:
        _, _, records = assets.projects._load(db, project_id)
    record = next(record for record in records if record.command.commandId == value.commandId)
    assert record.command.type == 'artifact.publish'
    assert len(assets.projects.snapshot(project_id).assets) == 1


@pytest.mark.parametrize('kind', ['image', 'audio', 'file'])
def test_shared_import_rules_and_source_identity(publication, kind):
    assets, project_id, _, work, _ = publication
    (work / 'source.md').write_text('source')
    source_receipt = publish(publication, command(publication, 'source.md'))
    source = assets.get(project_id, source_receipt.changed[0].id)
    if kind == 'image':
        path = work / 'frame.png'
        Image.new('RGB', (13, 7), 'purple').save(path)
    elif kind == 'audio':
        path = work / 'sound.wav'
        with wave.open(str(path), 'wb') as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(8000)
            audio.writeframes(b'\0\0' * 800)
    else:
        path = work / 'report.html'
        path.write_text('<html>Report</html>')
    receipt = publish(publication, command(publication, str(path), sources=[asset_ref(source)]))
    output = assets.get(project_id, receipt.changed[0].id)
    assert output.kind == kind
    assert output.provenance.sources == (asset_ref(source),)
    with assets.open_media(project_id, output.id)[0] as stream:
        assert stream.read() == path.read_bytes()


def test_file_boundary_links_empty_and_directory_are_rejected(publication, tmp_path):
    assets, project_id, _, work, _ = publication
    outside = tmp_path / 'outside.md'
    outside.write_text('outside')
    for path in [str(outside), '../outside.md']:
        with pytest.raises(ProjectError, match='本轮执行目录'):
            publish(publication, command(publication, path))
    (work / 'empty.md').touch()
    (work / 'folder').mkdir()
    for path in ['empty.md', 'folder']:
        with pytest.raises(ProjectError, match='非空普通文件'):
            publish(publication, command(publication, path))
    assert not assets.projects.snapshot(project_id).assets


def test_publication_rejects_linked_inputs(publication, tmp_path):
    assets, project_id, _, work, _ = publication
    outside = tmp_path / 'outside.md'; outside.write_text('outside')
    if os.name == 'nt':
        import _winapi
        alias = work / 'link-directory'
        _winapi.CreateJunction(str(tmp_path), str(alias))
        paths = ['link-directory/outside.md']
    else:
        (work / 'link.md').symlink_to(outside)
        (work / 'link-directory').symlink_to(tmp_path, target_is_directory=True)
        paths = ['link.md', 'link-directory/outside.md']
    try:
        for path in paths:
            with pytest.raises(OSError):
                publish(publication, command(publication, path))
    finally:
        if os.name == 'nt': alias.rmdir()
    assert not assets.projects.snapshot(project_id).assets


def test_lost_commit_response_is_recoverable(publication, monkeypatch):
    assets, project_id, _, work, _ = publication
    (work / 'plan.md').write_text('plan')
    value = command(publication, 'plan.md')
    register = assets.register
    def lost(*args, **kwargs):
        register(*args, **kwargs)
        raise OSError('lost response')
    monkeypatch.setattr(assets, 'register', lost)
    with pytest.raises(OSError, match='lost response'):
        publish(publication, value)
    monkeypatch.setattr(assets, 'register', register)
    assert publish(publication, value).status == 'applied'
    assert len(assets.projects.snapshot(project_id).assets) == 1


def test_five_video_outputs_can_be_separate_canvas_items(publication):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('requires ffmpeg and ffprobe')
    assets, project_id, session, work, _ = publication
    source = work / 'source.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:r=24',
        '-frames:v', '12', '-pix_fmt', 'yuv420p', str(source)], check=True)
    for index in range(5):
        name = f'segment-{index}.mp4'
        shutil.copyfile(source, work / name)
        published = publish(publication, command(publication, name))
        asset = assets.get(project_id, published.changed[0].id)
        assert asset.metadata.frameRate == 24
        show = parse_command({'type': 'canvas.show', 'projectId': project_id, 'commandId': uuid4(),
            'payload': {'item': {'id': uuid4(), 'projectId': project_id, 'kind': 'video', 'title': name,
                'position': {'x': index * 360, 'y': 0},
                'binding': {'role': 'material', 'objectRef': asset_ref(asset)}}}})
        assert assets.projects.execute(show, session=session).status == 'applied'
    snapshot = assets.projects.snapshot(project_id)
    assert len(snapshot.assets) == len(snapshot.canvasItems) == 5
    assert len({asset.id for asset in snapshot.assets}) == 5


def test_untrusted_http_cannot_choose_execution_context(publication):
    assets, project_id, session, _, _ = publication
    with TestClient(create_app(assets.projects.local), headers={
        'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': session}) as client:
        value = command(publication, '/etc/passwd', name='outside.txt')
        response = client.post(f'/api/creation/projects/{project_id}/commands', json=value.model_dump(mode='json'))
        assert response.status_code == 403
        assert not assets.projects.snapshot(project_id).assets
