"""C04 real bytes, scoped staging and recoverable asset registration."""
from io import BytesIO
import json
from pathlib import Path
import shutil
import subprocess
from uuid import uuid4
import wave

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from opendirector.application.creation_assets import CreationAssets
from opendirector.domain.creation.assets import AssetProvenance, AssetRef
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.creation.project import ProjectSnapshot
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.creation_files import upload_directory
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.creation_uploads import CreationUploads, inspect_file, upload_asset_id
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector_api.main import create_app


def command(project_id, kind='project.create', **payload):
    return parse_command(dict(projectId=project_id, commandId=uuid4(), type=kind, payload=payload))


def png():
    buffer = BytesIO()
    Image.new('RGB', (13, 7), 'purple').save(buffer, format='PNG')
    return buffer.getvalue()


@pytest.fixture
def storage(tmp_path):
    projects = CreationProjects(LocalProjects(tmp_path))
    project_id, session = uuid4(), str(uuid4())
    projects.execute(command(project_id, name='Assets'))
    projects.open(project_id, session)
    return projects, project_id, session


@pytest.mark.skipif(not shutil.which('ffmpeg') or not shutil.which('ffprobe'), reason='requires local FFmpeg')
def test_live_webm_without_container_duration_uses_packet_timestamps(tmp_path):
    # MediaRecorder writes a live WebM: valid packets, but no duration header.
    path = tmp_path / 'trim.webm'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=24',
                    '-t', '2', '-c:v', 'libvpx', '-live', '1', '-f', 'webm', str(path)], check=True)
    kind, metadata = inspect_file(path, 'trim.webm', expected_kind='video')
    assert kind == 'video'
    assert metadata.mimeType == 'video/webm'
    assert (metadata.width, metadata.height) == (64, 48)
    assert 1.5 < metadata.durationSeconds < 2.5


def upload(storage, name='frame.png', data=None):
    projects, project_id, session = storage
    handle = uuid4()
    writer = CreationUploads(projects).begin(project_id, handle, session, name)
    try:
        writer.write(png() if data is None else data)
        return writer.finish()
    finally:
        writer.abort()


def import_command(project_id, info):
    return command(project_id, 'asset.import', uploadHandle=info.id, name=info.name, expectedKind=info.kind)


def import_asset(storage, name='frame.png', data=None):
    projects, project_id, session = storage
    info = upload(storage, name, data)
    operation = import_command(project_id, info)
    receipt = projects.execute(operation, session=session)
    assert receipt.status == 'applied'
    return projects.snapshot(project_id).assets[-1], operation, info


def ref(asset):
    return AssetRef(assetId=asset.id, revision=asset.revision, fingerprint=asset.fingerprint, kind=asset.kind)


def test_staging_does_not_publish_and_import_survives_restart_and_project_rename(storage):
    projects, project_id, session = storage
    info = upload(storage)
    assert info.status == 'ready' and (info.metadata.width, info.metadata.height) == (13, 7)
    assert projects.snapshot(project_id).assets == ()
    assert len(projects.changes(project_id)['events']) == 1
    operation = import_command(project_id, info)
    receipt = projects.execute(operation, session=session)
    asset = CreationAssets(projects).list(project_id)[0]
    folder = upload_directory(projects.state_dir, project_id, info.id)
    assert not (folder / 'content').exists()
    assert CreationUploads(projects).info(project_id, info.id, session).assetId == asset.id
    projects.local.release(session)
    rename = parse_command(dict(projectId=project_id, commandId=uuid4(), type='project.rename', payload=dict(name='Renamed'),
        expectedVersions=[dict(objectType='project', id=project_id, revision=1)]))
    assert projects.execute(rename).status == 'applied'
    restored = CreationProjects(LocalProjects(projects.local.repository))
    assert restored.execute(operation) == receipt  # no stage bytes or lease needed for replay
    stream, actual = CreationAssets(restored).open_media(project_id, asset.id)
    assert stream.read() == png() and actual == asset
    stream.close()
    assert not (projects.root / 'Assets').exists()


def test_same_handle_does_not_register_twice_and_conflicting_command_identity_is_rejected(storage):
    projects, project_id, session = storage
    asset, operation, info = import_asset(storage)
    receipt = projects.execute(operation, session=session)
    assert receipt.changed[0].id == asset.id
    repeated = import_command(project_id, info)
    assert projects.execute(repeated, session=session).status == 'noop'
    assert len(projects.snapshot(project_id).assets) == 1
    different = parse_command({**operation.model_dump(), 'payload': {**operation.payload.model_dump(), 'name': 'different.png'}})
    with pytest.raises(ProjectError) as error:
        projects.execute(different, session=session)
    assert error.value.code == 'command_conflict'
    assert len(projects.changes(project_id)['events']) == 2


@pytest.mark.parametrize('stage', ['journaled', 'directory_ready', 'asset_installed', 'files_installed', 'bundle_written', 'directory_moved', 'published', 'finished'])
def test_file_and_asset_receipt_recover_together_after_each_commit_interruption(storage, stage):
    projects, project_id, session = storage
    info = upload(storage)
    operation = import_command(project_id, info)
    def crash(current):
        if current == stage:
            raise OSError('simulated abrupt shutdown')
    projects._checkpoint = crash
    with pytest.raises(OSError):
        projects.execute(operation, session=session)
    restored = CreationProjects(LocalProjects(projects.local.repository))
    snapshot = restored.snapshot(project_id)
    assert len(snapshot.assets) == 1 and snapshot.eventCursor == 2
    receipt = restored.execute(operation)
    assert receipt == restored.receipt(project_id, operation.commandId)
    assert len(restored.changes(project_id)['events']) == 2
    stream, asset = CreationAssets(restored).open_media(project_id, snapshot.assets[0].id)
    assert stream.read() == png() and asset.fingerprint == info.fingerprint
    stream.close()


def test_install_failure_leaves_no_partial_asset_and_can_retry_from_journal(storage, monkeypatch):
    from opendirector.infrastructure import creation_files
    projects, project_id, session = storage
    info = upload(storage)
    operation = import_command(project_id, info)
    original = creation_files.rename_path
    def fail(*args):
        raise OSError('disk full')
    monkeypatch.setattr(creation_files, 'rename_path', fail)
    with pytest.raises(OSError):
        projects.execute(operation, session=session)
    assert list((projects.root / 'Assets/assets').iterdir()) == []
    assert (projects.intents / f'{project_id}.json').exists()
    monkeypatch.setattr(creation_files, 'rename_path', original)
    assert len(projects.snapshot(project_id).assets) == 1


def test_pending_or_corrupt_files_cannot_be_exposed_as_a_committed_asset(storage):
    projects, project_id, session = storage
    info = upload(storage)
    operation = import_command(project_id, info)
    def crash(stage):
        if stage == 'journaled':
            raise OSError('shutdown')
    projects._checkpoint = crash
    with pytest.raises(OSError):
        projects.execute(operation, session=session)
    content = upload_directory(projects.state_dir, project_id, info.id) / 'content'
    original = content.read_bytes()
    content.write_bytes(b'wrong content')
    restored = CreationProjects(LocalProjects(projects.local.repository))
    for read in [lambda: restored.snapshot(project_id), lambda: restored.receipt(project_id, operation.commandId),
                 lambda: restored.changes(project_id), lambda: CreationAssets(restored).get(project_id, upload_asset_id(project_id, info.id))]:
        with pytest.raises(ProjectError):
            read()
    assert content.read_bytes() == b'wrong content'
    content.write_bytes(original)
    assert restored.execute(operation).status == 'applied'


def test_cancellation_and_abandoned_uploads_leave_no_project_fact(storage):
    projects, project_id, session = storage
    uploads, handle = CreationUploads(projects), uuid4()
    writer = uploads.begin(project_id, handle, session, 'frame.png')
    writer.write(png()[:10])
    writer.abort()
    folder = upload_directory(projects.state_dir, project_id, handle)
    assert not list(folder.glob('.partial-*'))
    assert uploads.cancel(project_id, handle, session).status == 'cancelled'
    assert projects.snapshot(project_id).assets == ()
    with pytest.raises(ProjectError, match='取消'):
        uploads.begin(project_id, handle, session, 'frame.png')
    cancelled = command(project_id, 'asset.import', uploadHandle=handle, name='frame.png', expectedKind='image')
    with pytest.raises(ProjectError, match='取消'):
        projects.execute(cancelled, session=session)


def test_wrong_kind_names_and_invalid_media_never_publish(storage):
    projects, project_id, session = storage
    for name, data in [('bad.txt', b'\xff'), ('nul.md', b'a\x00b'), ('bad.png', b'broken')]:
        with pytest.raises(ProjectError):
            upload(storage, name, data)
    with pytest.raises(ProjectError):
        upload(storage, '../outside.png')
    info = upload(storage)
    wrong = command(project_id, 'asset.import', uploadHandle=info.id, name=info.name, expectedKind='audio')
    assert projects.execute(wrong, session=session).status == 'rejected'
    assert projects.snapshot(project_id).assets == ()


def test_upload_limits_use_streamed_bytes_and_text_limits_use_utf8(storage, monkeypatch):
    from opendirector.infrastructure import creation_uploads
    projects, project_id, session = storage
    monkeypatch.setattr(creation_uploads, 'MAX_CREATION_ASSET_BYTES', 4)
    writer = CreationUploads(projects).begin(project_id, uuid4(), session, 'file.bin')
    try:
        writer.write(b'123')
        with pytest.raises(ProjectError) as error:
            writer.write(b'45')
        assert error.value.status == 413
    finally:
        writer.abort()
    monkeypatch.undo()
    large_text = command(project_id, 'asset.writeText', name='large.txt', text='字' * 400_000)
    with pytest.raises(ProjectError) as error:
        projects.execute(large_text, session=session)
    assert error.value.status == 413
    assert projects.snapshot(project_id).assets == ()


def test_handle_scope_and_expired_sessions_are_enforced(storage):
    projects, project_id, session = storage
    info = upload(storage)
    second_id, second_session = uuid4(), str(uuid4())
    projects.execute(command(second_id, name='Other'))
    projects.open(second_id, second_session)
    with pytest.raises(ProjectError):
        projects.execute(import_command(second_id, info), session=second_session)
    projects.local.release(session)
    new_session = str(uuid4())
    projects.open(project_id, new_session)
    with pytest.raises(ProjectError, match='会话'):
        projects.execute(import_command(project_id, info), session=new_session)
    with pytest.raises(ProjectError):
        CreationUploads(projects).info(project_id, info.id, session)
    assert projects.snapshot(project_id).assets == ()


def test_text_revision_and_metadata_rename_preserve_original_bytes_and_sources(storage):
    projects, project_id, session = storage
    write = command(project_id, 'asset.writeText', name='script.md', text='# First')
    receipt = projects.execute(write, session=session)
    first = projects.snapshot(project_id).assets[0]
    edit = parse_command(dict(type='asset.writeText', commandId=uuid4(), projectId=project_id,
        payload=dict(name='script.md', text='# Second', previousAsset=ref(first).model_dump(mode='json')),
        expectedVersions=[dict(objectType='asset', id=first.id, revision=1)]))
    assert projects.execute(edit, session=session).status == 'applied'
    second = projects.snapshot(project_id).assets[-1]
    assert first.id != second.id and second.provenance.sources == (ref(first),)
    rename = parse_command(dict(type='asset.updateMetadata', commandId=uuid4(), projectId=project_id,
        payload=dict(assetId=first.id, name='Renamed original.md'), expectedVersions=[dict(objectType='asset', id=first.id, revision=1)]))
    assert projects.execute(rename, session=session).status == 'applied'
    after = projects.snapshot(project_id)
    assert after.assets[0].revision == 2 and after.assets[0].fingerprint == first.fingerprint
    assert after.assets[-1].provenance.sources == (ref(first),)
    for asset, content in [(first, b'# First'), (second, b'# Second')]:
        stream, _ = CreationAssets(projects).open_media(project_id, asset.id)
        assert stream.read() == content
        stream.close()
    assert projects.execute(write, session=session) == receipt
    stale = parse_command({**edit.model_dump(), 'commandId': uuid4()})
    assert projects.execute(stale, session=session).issues[0].code == 'revision_conflict'


def test_missing_and_changed_files_never_return_empty_or_wrong_content(storage):
    projects, project_id, _ = storage
    asset, _, _ = import_asset(storage)
    service = CreationAssets(projects)
    stream, _ = service.open_media(project_id, asset.id)
    stream.close()  # populate verification cache
    file = projects.root / 'Assets' / asset.path
    file.write_bytes(b'x' * asset.metadata.size)
    with pytest.raises(ProjectError, match='内容已变化'):
        service.open_media(project_id, asset.id)
    file.unlink()
    with pytest.raises(ProjectError, match='文件缺失'):
        service.open_media(project_id, asset.id)
    assert service.get(project_id, asset.id) == asset


def test_symlinked_content_and_asset_paths_are_rejected_without_external_writes(storage, tmp_path):
    import os
    from process_helpers import directory_link
    projects, project_id, session = storage
    info = upload(storage)
    staged = upload_directory(projects.state_dir, project_id, info.id) / 'content'
    outside = tmp_path / 'outside'
    outside.write_bytes(png())
    staged.unlink()
    if os.name == 'nt':
        # A junction redirects the upload directory without requiring the
        # optional Windows privilege for file symlinks.
        redirected = tmp_path / 'outside-upload'
        staged.parent.rename(redirected)
        (redirected / 'content').write_bytes(outside.read_bytes())
        directory_link(staged.parent, redirected)
    else:
        staged.symlink_to(outside)
    with pytest.raises(ProjectError):
        projects.execute(import_command(project_id, info), session=session)
    assert outside.read_bytes() == png()
    if os.name == 'nt':
        assert (redirected / 'content').read_bytes() == png()
        # A redirected ancestor is rejected during staging validation, before
        # journaling. The POSIX final-file symlink fails during installation.
        assert not (projects.intents / f'{project_id}.json').exists()
        assert not projects.snapshot(project_id).assets
    else:
        assert (projects.intents / f'{project_id}.json').exists()


@pytest.mark.skipif(not shutil.which('ffprobe'), reason='requires local FFmpeg')
def test_audio_metadata_comes_from_real_file_and_survives_registration(storage):
    buffer = BytesIO()
    with wave.open(buffer, 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(8000)
        output.writeframes(b'\x00\x00' * 4000)
    asset, _, _ = import_asset(storage, 'voice.wav', buffer.getvalue())
    assert asset.kind == 'audio' and asset.metadata.mimeType == 'audio/wav'
    assert asset.metadata.durationSeconds == pytest.approx(0.5)
    assert asset.metadata.sampleRate == 8000 and asset.metadata.channels == 1


@pytest.mark.skipif(not shutil.which('ffmpeg') or not shutil.which('ffprobe'), reason='requires local FFmpeg')
def test_video_metadata_uses_actual_dimensions_duration_and_audio_tracks(storage, tmp_path):
    file = tmp_path / 'sample.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=10', '-t', '0.5',
                    '-c:v', 'mpeg4', '-an', str(file)], check=True)
    asset, _, _ = import_asset(storage, 'sample.mp4', file.read_bytes())
    assert asset.kind == 'video' and (asset.metadata.width, asset.metadata.height) == (64, 48)
    assert asset.metadata.durationSeconds == pytest.approx(0.5)
    assert asset.metadata.frameRate == 10 and asset.metadata.hasAudio is False


def test_trusted_agent_text_records_actual_run_without_a_fictitious_job(storage):
    projects, project_id, session = storage
    from opendirector.domain.creation.models import ModelSnapshot
    model = ModelSnapshot(modelConfigId=uuid4(), kind='agent', modelId='agent', url='http://model.test/v1', protocol='openai', connectionType='api')
    provenance = AssetProvenance(source='agent_written', agentRunId=uuid4(), modelSnapshot=model, prompt='Write a script')
    operation = command(project_id, 'asset.writeText', name='script.md', text='Real assistant text')
    receipt = CreationAssets(projects).execute(operation, session=session, source='agent', provenance=provenance)
    assert receipt.status == 'applied'
    snapshot = projects.snapshot(project_id)
    assert snapshot.assets[0].provenance == provenance and snapshot.jobs == ()


def test_trusted_editor_output_is_registered_with_document_version_and_source_asset(storage, tmp_path):
    projects, project_id, session = storage
    original, _, _ = import_asset(storage)
    doc_id = uuid4()
    document = dict(id=doc_id, projectId=project_id, revision=1, kind='media_edit', data=dict(tool='crop', sources=[ref(original)]))
    save_doc = command(project_id, 'editor.create', document=document)
    projects.commit(save_doc, lambda before: ProjectSnapshot.model_validate({**before.model_dump(), 'editorDocuments': [document]}), session=session)
    output, handle = tmp_path / 'output.png', uuid4()
    output.write_bytes(png())
    service = CreationAssets(projects)
    info = service.stage_output(project_id, handle, 'output.png', output, expected_kind='image')
    operation = import_command(project_id, info)
    provenance = AssetProvenance(source='edited', editorDocumentId=doc_id, editorRevision=1, sources=(ref(original),))
    assert service.register(operation, source='background', provenance=provenance).status == 'applied'
    asset = projects.snapshot(project_id).assets[-1]
    assert asset.provenance == provenance and asset.id != original.id


def test_generated_file_and_job_result_are_recovered_in_one_commit(storage, tmp_path):
    from opendirector.domain.creation.generation import ImageGenerationSpec, InputSnapshot, Job, ResultVersion
    from opendirector.domain.creation.models import ModelSnapshot
    projects, project_id, session = storage
    model_id, spec_id, job_id = uuid4(), uuid4(), uuid4()
    spec = ImageGenerationSpec(id=spec_id, projectId=project_id, kind='image', purpose='generation', modelConfigId=model_id, prompt='A mountain')
    model = ModelSnapshot(modelConfigId=model_id, kind='image', modelId='demo', url='https://model.test/v1', protocol='openai', connectionType='api')
    snapshot = InputSnapshot(spec=spec, model=model)
    job = Job(id=job_id, projectId=project_id, inputSnapshot=snapshot, inputFingerprint=snapshot.fingerprint(), execution=dict(kind='image', size='2K'))
    seed = command(project_id, 'generationSpec.create', spec=spec)
    projects.commit(seed, lambda before: ProjectSnapshot.model_validate({**before.model_dump(), 'generationSpecs': [spec], 'jobs': [job]}), session=session)
    handle, output = uuid4(), tmp_path / 'generated.png'
    output.write_bytes(png())
    service = CreationAssets(projects)
    info = service.stage_output(project_id, handle, 'generated.png', output, expected_kind='image')
    operation = parse_command({**import_command(project_id, info).model_dump(), 'expectedVersions': [dict(objectType='job', id=job_id, revision=1)]})
    provenance = AssetProvenance(source='generated', jobId=job_id, inputFingerprint=snapshot.fingerprint())
    def complete(before, asset):
        data = before.model_dump()
        data['assets'] = [asset]
        data['jobs'][0].update(revision=2, status='succeeded', phase='complete', recovery='done', asset=ref(asset))
        data['results'] = [ResultVersion(id=uuid4(), projectId=project_id, specId=spec_id, jobId=job_id,
                                        asset=ref(asset), inputFingerprint=snapshot.fingerprint())]
        return ProjectSnapshot.model_validate(data)
    def fail(stage):
        if stage == 'files_installed':
            raise OSError('crash after bytes, before job result publication')
    projects._checkpoint = fail
    with pytest.raises(OSError):
        service.register(operation, source='background', provenance=provenance, apply=complete)
    restored = CreationProjects(LocalProjects(projects.local.repository))
    after = restored.snapshot(project_id)
    assert after.jobs[0].status == 'succeeded' and after.jobs[0].asset == ref(after.assets[0])
    assert after.results[0].asset == ref(after.assets[0]) and after.assets[0].provenance == provenance
    assert after.generationSpecs[0].currentResultId is None  # completion is separate from adoption
    assert restored.execute(operation).status == 'applied'


def test_large_project_file_is_not_restricted_by_chat_attachment_limit(storage):
    projects, project_id, session = storage
    uploads, handle = CreationUploads(projects), uuid4()
    writer = uploads.begin(project_id, handle, session, 'large.bin')
    try:
        block = b'x' * (1024 * 1024)
        for _ in range(51):
            writer.write(block)
        info = writer.finish()
    finally:
        writer.abort()
    assert info.metadata.size == 51 * 1024 * 1024
    operation = import_command(project_id, info)
    assert projects.execute(operation, session=session).status == 'applied'
    assert (projects.root / 'Assets/assets' / str(upload_asset_id(project_id, handle))).stat().st_size == info.metadata.size


@pytest.fixture
def api(storage):
    projects, project_id, session = storage
    with TestClient(create_app(projects.local), headers={'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': session}) as client:
        yield client, f'/api/creation/projects/{project_id}', projects, project_id


def api_upload(client, base, *, data=None, name='frame.png'):
    handle = str(uuid4())
    response = client.put(base + '/uploads/' + handle, content=png() if data is None else data, headers={'X-Asset-Name': name})
    assert response.status_code == 200, response.text
    info = response.json()
    body = dict(type='asset.import', commandId=str(uuid4()), projectId=base.rsplit('/', 1)[-1],
                payload=dict(uploadHandle=handle, name=name, expectedKind=info['kind']))
    response = client.post(base + '/commands', json=body)
    assert response.status_code == 200 and response.json()['status'] == 'applied', response.text
    return info, body, response.json()['changed'][0]['id']


def test_public_upload_metadata_content_ranges_and_replay(api):
    client, base, projects, _ = api
    info, body, asset_id = api_upload(client, base)
    asset = client.get(base + '/assets/' + asset_id).json()
    assert asset['metadata']['width'] == 13 and asset['metadata']['height'] == 7
    assert asset['fingerprint'] == info['fingerprint']
    url = base + '/assets/' + asset_id + '/content'
    response = client.get(url)
    assert response.status_code == 200 and response.content == png()
    assert response.headers['content-type'] == 'image/png'
    assert response.headers['x-content-type-options'] == 'nosniff'
    partial = client.get(url, headers={'Range': 'bytes=2-9'})
    assert partial.status_code == 206 and partial.content == png()[2:10]
    assert partial.headers['content-range'] == f'bytes 2-9/{len(png())}'
    assert client.get(url, headers={'Range': 'bytes=-8'}).content == png()[-8:]
    assert client.get(url, headers={'Range': 'bytes=8-'}).content == png()[8:]
    for invalid in ['bytes=900000-', 'bytes=9-1', 'bytes=-0', 'bytes=0-1,3-4', 'not-a-range']:
        assert client.get(url, headers={'Range': invalid}).status_code == 416
    assert client.get(url, headers={'If-None-Match': response.headers['etag']}).status_code == 304
    assert client.get(base + '/uploads/' + info['id']).json()['assetId'] == asset_id
    assert client.delete(base + '/uploads/' + info['id']).json()['status'] == 'cancelled'
    assert client.post(base + '/commands', json=body).json()['status'] == 'applied'
    assert client.get(url).content == png()
    assert len(client.get(base + '/assets').json()) == 1


def test_public_sources_and_file_paths_cannot_be_forged(api):
    client, base, projects, _ = api
    project_id = base.rsplit('/', 1)[-1]
    for extra in [dict(provenance=dict(source='generated', jobId=str(uuid4()))), dict(path='/etc/passwd'), dict(apiKey='private-test-key')]:
        body = dict(type='asset.writeText', projectId=project_id, commandId=str(uuid4()), payload=dict(name='note.txt', text='text', **extra))
        response = client.post(base + '/commands', json=body)
        assert response.status_code == 422 and 'private-test-key' not in response.text
    assert client.get(base + '/assets').json() == []
    assert client.put(base + '/uploads/' + str(uuid4()), content=png(), headers={'X-Asset-Name': 'wrong.png', 'X-Asset-Kind': 'video'}).status_code == 400


def test_copy_stages_another_projects_asset_on_the_server(api):
    client, base, projects, source_id = api
    _, _, source_asset = api_upload(client, base)
    target_id = uuid4()
    projects.execute(command(target_id, name='Target'))
    session = client.headers['X-OpenDirector-Session']
    projects.open(target_id, session)
    target = f'/api/creation/projects/{target_id}'
    handle = str(uuid4())
    fingerprint = client.get(base + '/assets/' + source_asset).json()['fingerprint']
    source = dict(projectId=str(source_id), assetId=source_asset, fingerprint=fingerprint)
    response = client.put(target + '/uploads/' + handle + '/copy', json=source)
    assert response.status_code == 200, response.text
    info = response.json()
    assert info['status'] == 'ready' and info['name'] == 'frame.png' and info['kind'] == 'image'
    # A retry of the same copy answers with the same staged upload.
    assert client.put(target + '/uploads/' + handle + '/copy', json=source).json() == info
    body = dict(type='asset.import', commandId=str(uuid4()), projectId=str(target_id),
                payload=dict(uploadHandle=handle, name=info['name'], expectedKind=info['kind']))
    receipt = client.post(target + '/commands', json=body).json()
    assert receipt['status'] == 'applied', receipt
    copied = client.get(target + '/assets/' + receipt['changed'][0]['id']).json()
    assert copied['projectId'] == str(target_id) and copied['provenance']['source'] == 'upload'
    assert copied['fingerprint'] == fingerprint
    assert client.get(target + '/assets/' + copied['id'] + '/content').content == png()
    assert len(client.get(base + '/assets').json()) == 1


def test_copy_requires_an_existing_source_and_an_open_target(api):
    client, base, projects, source_id = api
    _, _, source_asset = api_upload(client, base)
    _, _, other = api_upload(client, base, data=png()[:-1] + b'\x00', name='other.png')
    target_id = uuid4()
    projects.execute(command(target_id, name='Target'))
    target = f'/api/creation/projects/{target_id}/uploads/'
    source = dict(projectId=str(source_id), assetId=source_asset)
    # The target must be open in this session, as for a browser upload.
    assert client.put(target + str(uuid4()) + '/copy', json=source).status_code == 409
    projects.open(target_id, client.headers['X-OpenDirector-Session'])
    missing = dict(projectId=str(source_id), assetId=str(uuid4()))
    assert client.put(target + str(uuid4()) + '/copy', json=missing).status_code == 404
    assert client.put(target + str(uuid4()) + '/copy', json={**source, 'path': '/etc/passwd'}).status_code == 422
    assert client.put(target + str(uuid4()) + '/copy', json={**source, 'fingerprint': 'sha256:' + '0' * 64}).status_code == 409
    # A handle used for one source cannot be reused for different content.
    handle = str(uuid4())
    assert client.put(target + handle + '/copy', json=source).status_code == 200
    assert client.put(target + handle + '/copy', json=dict(projectId=str(source_id), assetId=other)).status_code == 409


def test_upload_response_loss_and_request_retry_keep_same_handle(api, monkeypatch):
    from opendirector.infrastructure import creation_uploads
    client, base, _, _ = api
    handle = str(uuid4())
    original = creation_uploads.durable_json
    fired = []
    def lose_response(path, value):
        original(path, value)
        if path.name == 'ready.json' and not fired:
            fired.append(True)
            raise OSError('lost upload response')
    monkeypatch.setattr(creation_uploads, 'durable_json', lose_response)
    url, headers = base + '/uploads/' + handle, {'X-Asset-Name': 'frame.png'}
    assert client.put(url, content=png(), headers=headers).status_code == 503
    assert client.get(url).json()['status'] == 'ready'
    retried = client.put(url, content=png(), headers=headers)
    assert retried.status_code == 200 and retried.json()['id'] == handle
    assert client.put(url, content=b'other', headers={'X-Asset-Name': 'frame.png'}).status_code == 400
    assert client.get(base + '/assets').json() == []


def test_empty_text_and_generic_files_have_safe_content_access(api):
    client, base, _, project_id = api
    body = dict(type='asset.writeText', projectId=str(project_id), commandId=str(uuid4()), payload=dict(name='empty.txt', text=''))
    receipt = client.post(base + '/commands', json=body).json()
    asset_id = receipt['changed'][0]['id']
    url = base + '/assets/' + asset_id + '/content'
    assert client.get(url).status_code == 200 and client.get(url).content == b''
    assert client.get(url, headers={'Range': 'bytes=0-'}).status_code == 416
    _, _, file_id = api_upload(client, base, data=b'<script>example</script>', name='page.html')
    response = client.get(base + '/assets/' + file_id + '/content')
    assert response.headers['content-type'] == 'application/octet-stream'
    assert response.headers['content-disposition'].startswith('attachment;')


def test_clipboard_image_without_suffix_is_inspected_from_its_bytes(api):
    client, base, _, _ = api
    info, _, asset_id = api_upload(client, base, name='clipboard')
    assert info['kind'] == 'image' and info['metadata']['mimeType'] == 'image/png'
    assert client.get(base + '/assets/' + asset_id + '/content').content == png()


def test_interrupted_http_upload_releases_lock_and_partial_bytes(storage):
    import asyncio
    import httpx
    from starlette.requests import ClientDisconnect
    projects, project_id, session = storage
    handle = uuid4()
    app = create_app(projects.local)
    async def run():
        async def chunks():
            yield png()[:10]
            raise ClientDisconnect()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver',
                headers={'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': session, 'X-Asset-Name': 'frame.png'}) as client:
            with pytest.raises(ClientDisconnect):
                await client.put(f'/api/creation/projects/{project_id}/uploads/{handle}', content=chunks())
    asyncio.run(run())
    folder = upload_directory(projects.state_dir, project_id, handle)
    assert not list(folder.glob('.partial-*')) and not (folder / 'ready.json').exists()
    assert projects.snapshot(project_id).assets == ()
    # The request's handle lock was also released, so the original upload can retry.
    writer = CreationUploads(projects).begin(project_id, handle, session, 'frame.png')
    try:
        writer.write(png())
        assert writer.finish().status == 'ready'
    finally:
        writer.abort()


def test_thumbnail_is_bounded_cached_and_revalidates_source(storage):
    projects, pid, _ = storage
    output = BytesIO()
    Image.new('RGB', (1800, 1200), 'orange').save(output, format='PNG')
    asset, _, _ = import_asset(storage, data=output.getvalue())
    service = CreationAssets(projects)
    preview, returned = service.thumbnail(pid, asset.id)
    assert returned == asset
    with Image.open(BytesIO(preview)) as image:
        assert image.format == 'WEBP' and image.size == (480, 320)
    assert service.thumbnail(pid, asset.id)[0] is preview
    (projects.root / 'Assets' / asset.path).write_bytes(b'tampered')
    with pytest.raises(ProjectError, match='内容已变化'):
        service.thumbnail(pid, asset.id)


def test_media_read_basis_cannot_cross_projects(storage):
    projects, pid, _ = storage
    asset, _, _ = import_asset(storage)
    snapshot = projects.snapshot(pid)
    with pytest.raises(ProjectError, match='不属于'):
        CreationAssets(projects).open_media(uuid4(), asset.id, snapshot=snapshot)


def test_imported_assets_record_the_archive_source_they_came_from():
    """An archive is evidence: it may say the bytes were generated, but the
    claim has to be explicit and cannot leak onto ordinary assets."""
    imported = AssetProvenance(source='imported', importedFrom='generated')
    assert imported.importedFrom == 'generated'
    assert AssetProvenance(source='imported', importedFrom='edited').importedFrom == 'edited'

    # Without the original source the record would be an unexplained import.
    with pytest.raises(ValueError, match='record the source'):
        AssetProvenance(source='imported')
    # Only imported assets may carry an archive source.
    with pytest.raises(ValueError, match='Only imported'):
        AssetProvenance(source='upload', importedFrom='generated')
    # A generated asset still needs real job evidence, not just a claim.
    with pytest.raises(ValueError, match='job and input identity'):
        AssetProvenance(source='generated', importedFrom='generated')
