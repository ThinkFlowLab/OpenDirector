"""Editable bundles preserve real resources and recover logical imports."""
from uuid import uuid4
import json
import zipfile
from pathlib import Path
import os
import pytest
from test_creation_canvas_service import project, send, ver
from test_timeline_fonts import timeline_document
from opendirector.domain.projects import ProjectError
from test_creation_assets import import_asset


def service(store):
    from opendirector.application.creation_timeline_packages import CreationTimelinePackages
    return CreationTimelinePackages(store)


def stage(store, pid, session, path):
    from opendirector.application.creation_assets import CreationAssets
    handle = uuid4()
    writer = CreationAssets(store).uploads.begin(pid, handle, session, 'example.timeline.zip', expected_kind='file')
    with path.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            writer.write(chunk)
    info = writer.finish()
    return dict(operationId=uuid4(), uploadHandle=handle, archiveFingerprint=info.fingerprint)


@pytest.mark.parametrize('suffix', ['heic', 'heif'])
def test_package_keeps_heif_extensions_and_original_bytes(project, suffix):
    from opendirector.application.creation_assets import CreationAssets
    from opendirector.application.creation_canvas import asset_ref
    store, pid, session = project
    data = (Path(__file__).parent / 'fixtures' / 'heif' / f'oriented.{suffix}').read_bytes()
    asset, _, _ = import_asset(project, f'photo.{suffix}', data)
    document = dict(id=uuid4(), projectId=pid, kind='timeline', data=dict(width=640, height=360, fps=24,
        importedAssets=[dict(title='Photo', asset=asset_ref(asset))], tracks=[dict(id='visual', kind='visual', title='Visual')]))
    assert send(store, pid, 'editor.create', session=session, document=document).status == 'applied'
    package = service(store).export(pid, document['id'], 1)
    try:
        with zipfile.ZipFile(package) as archive:
            resource, = json.loads(archive.read('manifest.json'))['resources']
            assert resource['path'].endswith('.' + suffix)
            assert archive.read(resource['path']) == data
        target, session2 = uuid4(), str(uuid4())
        assert send(store, target, 'project.create', name='HEIF imported').status == 'applied'
        store.open(target, session2)
        result = service(store).import_package(target, stage(store, target, session2, package), session=session2)
        assert result.status == 'applied', result
        restored, = store.snapshot(target).assets
        assert restored.metadata.mimeType == f'image/{suffix}'
        with CreationAssets(store).open_media(target, restored.id)[0] as stream:
            assert stream.read() == data
    finally:
        package.unlink()


@pytest.mark.anyio
@pytest.mark.parametrize('component', ['work', 'turn', 'agent-runs'])
async def test_agent_package_tools_reject_replaced_execution_root_and_ancestors(project, tmp_path, component):
    import hashlib
    import shutil
    from opendirector.agent.context import RunContext
    from opendirector.agent.gateway import ToolGateway
    from opendirector.agent.tools import AgentTools
    from opendirector.infrastructure.model_configs import ModelConfigs
    from process_helpers import directory_link
    store, pid, session = project
    document, _, _ = timeline_document(project, tmp_path)
    assert send(store, pid, 'editor.create', session=session, document=document).status == 'applied'
    before = store.snapshot(pid)
    folder, turn = store.root / 'Unified', uuid4()
    work = folder / 'agent-runs' / str(turn) / 'work'
    work.mkdir(parents=True)
    anchor = {'work': work, 'turn': work.parent, 'agent-runs': work.parent.parent}[component]
    outside = tmp_path / 'outside'
    outside_work = outside / work.relative_to(anchor)
    outside_work.mkdir(parents=True)
    archive = outside_work / 'input.timeline.zip'
    exported = service(store).export(pid, document['id'], 1)
    try:
        shutil.copyfile(exported, archive)
    finally:
        exported.unlink()
    contents = archive.read_bytes()
    fingerprint = 'sha256:' + hashlib.sha256(contents).hexdigest()
    anchor.rename(anchor.with_name(anchor.name + '-original'))
    directory_link(anchor, outside)
    run = RunContext(runtime='codex', project_id=pid, turn_id=turn, session=session,
        directory=folder, config=None, messages=[], selected_skills=[])
    gateway = ToolGateway(AgentTools(store, None, ModelConfigs(tmp_path)), run)
    try:
        result = await gateway.call('export', 'timeline_package_export', dict(
            editorId=str(document['id']), revision=1, path='output.timeline.zip'))
        assert result.error and not (outside_work / 'output.timeline.zip').exists()
        result = await gateway.call('import', 'timeline_package_import', dict(
            path='input.timeline.zip', operationId=str(uuid4()), archiveFingerprint=fingerprint))
        assert result.error
        assert archive.read_bytes() == contents
        assert store.snapshot(pid) == before
    finally:
        await gateway.close()
        anchor.rmdir() if os.name == 'nt' else anchor.unlink()


def test_package_exports_exact_revision_readonly_and_imports_real_resources(project, tmp_path):
    store, pid, session = project
    document, font, source = timeline_document(project, tmp_path)
    assert send(store, pid, 'editor.create', session=session, document=document).status == 'applied'
    doc = store.snapshot(pid).editorDocuments[0]
    changed = doc.model_dump(mode='json'); changed['data']['overlays'][0]['text'] = 'B'
    assert send(store, pid, 'editor.save', session=session, versions=[ver('editor_document', doc)], document=changed).status == 'applied'
    before = store.snapshot(pid)
    store.local.release(session)
    package = service(store).export(pid, doc.id, 1)
    assert store.snapshot(pid) == before
    with zipfile.ZipFile(package) as archive:
        manifest = json.loads(archive.read('manifest.json'))
        timeline = json.loads(archive.read('timeline.json'))
        assert timeline['overlays'][0]['text'] == 'AB中'
        assert len(manifest['resources']) == 2
        assert any(name.startswith('licenses/') for name in archive.namelist())
        assert all(archive.read(item['path']) for item in manifest['resources'])
        # Our native writer uses per-file ZIP64 local headers even though its
        # bounded central directory is ordinary EOCD. Those remain supported.
        with package.open('rb') as raw:
            raw.seek(archive.getinfo(manifest['resources'][0]['path']).header_offset + 18)
            assert raw.read(8) == b'\xff' * 8
    target, session2 = uuid4(), str(uuid4())
    assert send(store, target, 'project.create', name='Imported').status == 'applied'
    store.open(target, session2)
    request = stage(store, target, session2, package)
    result = service(store).import_package(target, request, session=session2)
    assert result.status == 'applied', result
    imported = store.snapshot(target)
    assert len(imported.assets) == 2 and len(imported.canvasItems) == 1
    restored = imported.editorDocuments[0]
    assert restored.data.overlays[0].text == 'AB中'
    assert restored.data.fonts[0].asset.assetId != font.id
    assert restored.data.overlays[0].sourceAsset.assetId != source.id
    assert restored.inputConnections == ()
    # Terminal replay precedes opening the already-consumed/cancelled upload.
    from opendirector.application.creation_assets import CreationAssets
    CreationAssets(store).uploads.cancel(target, request['uploadHandle'], session2)
    assert service(store).import_package(target, request, session=session2) == result
    assert len(store.snapshot(target).assets) == 2
    exported_again = service(store).export(target, restored.id, 1)
    assert exported_again.is_file()


@pytest.mark.parametrize('damage', ['traversal', 'duplicate', 'capability', 'hash', 'missing', 'unmapped'])
def test_package_rejects_entire_invalid_archive_before_registration(project, tmp_path, damage):
    store, pid, session = project
    document, _, _ = timeline_document(project, tmp_path)
    assert send(store, pid, 'editor.create', session=session, document=document).status == 'applied'
    package = service(store).export(pid, document['id'], 1)
    with zipfile.ZipFile(package) as archive:
        entries = {name: archive.read(name) for name in archive.namelist()}
    manifest = json.loads(entries['manifest.json'])
    if damage == 'traversal': entries['../escaped'] = b'x'
    if damage == 'capability': manifest['requiredCapabilities'].append('future.unknown')
    if damage == 'hash': entries[manifest['resources'][0]['path']] = b'bad'
    if damage == 'missing': del entries[manifest['resources'][0]['path']]
    if damage == 'unmapped':
        data = json.loads(entries['timeline.json']); data['fonts'][0]['asset']['assetId'] = str(uuid4())
        entries['timeline.json'] = json.dumps(data).encode()
    entries['manifest.json'] = json.dumps(manifest).encode()
    broken = tmp_path / 'broken.zip'
    with zipfile.ZipFile(broken, 'w') as archive:
        for name, content in entries.items(): archive.writestr(name, content)
        if damage == 'duplicate':
            with pytest.warns(UserWarning, match='Duplicate name'):
                archive.writestr('timeline.json', entries['timeline.json'])
    before = store.snapshot(pid)
    request = stage(store, pid, session, broken)
    with pytest.raises(ProjectError): service(store).import_package(pid, request, session=session)
    assert store.snapshot(pid) == before


def test_package_logical_identity_dedup_and_recovery_after_registration(project, tmp_path, monkeypatch):
    from opendirector.application.creation_assets import CreationAssets
    from opendirector.application.creation_canvas import asset_ref
    store, pid, session = project
    document, _, first = timeline_document(project, tmp_path)
    assert send(store, pid, 'asset.writeText', session=session, name='another.txt', text='AB中').status == 'applied'
    second = store.snapshot(pid).assets[-1]
    document['data']['overlays'].append({**document['data']['overlays'][0], 'id': 'second', 'sourceAsset': asset_ref(second)})
    assert send(store, pid, 'editor.create', session=session, document=document).status == 'applied'
    package = service(store).export(pid, document['id'], 1)
    with zipfile.ZipFile(package) as archive:
        resources = json.loads(archive.read('manifest.json'))['resources']
        assert len(resources) == 3 and len(set(item['path'] for item in resources)) == 2
    request = stage(store, pid, session, package)
    packages = service(store)
    original = packages.assets.register
    counter = 0
    def fail_once(*args, **kwargs):
        nonlocal counter
        counter += 1
        if counter == 2: raise OSError('simulated interruption')
        return original(*args, **kwargs)
    monkeypatch.setattr(packages.assets, 'register', fail_once)
    with pytest.raises(OSError): packages.import_package(pid, request, session=session)
    partial = service(store).receipt(pid, request['operationId'])
    assert partial.status == 'registered' and len(partial.registeredAssetIds) == 1
    count = len(store.snapshot(pid).assets)
    CreationAssets(store).uploads.cancel(pid, request['uploadHandle'], session)
    result = service(store).import_package(pid, request, session=session)
    assert result.status == 'applied'
    assert len(store.snapshot(pid).assets) == count + 2
    doc = store.snapshot(pid).editorDocuments[-1]
    assert doc.data.overlays[0].sourceAsset.assetId != doc.data.overlays[1].sourceAsset.assetId
    assert doc.data.overlays[0].sourceAsset.fingerprint == doc.data.overlays[1].sourceAsset.fingerprint
    with pytest.raises(ProjectError):
        service(store).import_package(pid, {**request, 'archiveFingerprint': 'sha256:' + '0' * 64}, session=session)


def test_package_replacement_rejects_stale_revision_without_overwriting(project, tmp_path):
    store, pid, session = project
    document, _, _ = timeline_document(project, tmp_path)
    assert send(store, pid, 'editor.create', session=session, document=document).status == 'applied'
    package = service(store).export(pid, document['id'], 1)
    doc = store.snapshot(pid).editorDocuments[0]
    changed = doc.model_dump(mode='json'); changed['data']['overlays'][0]['text'] = 'B'
    assert send(store, pid, 'editor.save', session=session, versions=[ver('editor_document', doc)], document=changed).status == 'applied'
    request = dict(**stage(store, pid, session, package), replaceEditorId=doc.id, expectedRevision=1)
    result = service(store).import_package(pid, request, session=session)
    assert result.status == 'rejected' and result.receipt.issues[0].code == 'revision_conflict'
    assert store.snapshot(pid).editorDocuments[0].data.overlays[0].text == 'B'
    assert service(store).import_package(pid, request, session=session) == result


def test_api_cli_package_roundtrip(project, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    import httpx
    from typer.testing import CliRunner
    from opendirector import cli
    from opendirector_api.main import create_app
    store, pid, session = project
    document, _, _ = timeline_document(project, tmp_path)
    assert send(store, pid, 'editor.create', session=session, document=document).status == 'applied'
    api = TestClient(create_app(store.local), headers={'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': session})
    exported = api.get(f'/api/creation/projects/{pid}/timelines/{document["id"]}/package?revision=1')
    assert exported.status_code == 200
    path = tmp_path / 'api.timeline.zip'; path.write_bytes(exported.content)
    original_client = httpx.Client
    def forward(request):
        response = api.request(request.method, str(request.url), headers=dict(request.headers), content=request.read())
        return httpx.Response(response.status_code, headers=response.headers, content=response.content)
    monkeypatch.setattr(cli.httpx, 'Client', lambda **kwargs: original_client(**kwargs, transport=httpx.MockTransport(forward)))
    runner = CliRunner()
    prefix = ['--project', str(pid), '--session', session]
    identity = str(uuid4())
    result = runner.invoke(cli.app, prefix + ['timeline', 'import', str(path), '--operation-id', identity])
    assert result.exit_code == 0, result.exception
    imported = json.loads(result.output)
    assert imported['status'] == 'applied'
    from uuid import UUID, uuid5
    handle = uuid5(UUID(identity), 'archive-upload')
    assert api.delete(f'/api/creation/projects/{pid}/uploads/{handle}').status_code == 200
    replay = runner.invoke(cli.app, prefix + ['timeline', 'import', str(path), '--operation-id', identity])
    assert replay.exit_code == 0, replay.exception
    assert json.loads(replay.output) == imported
    target = tmp_path / 'cli.timeline.zip'
    result = runner.invoke(cli.app, prefix + ['timeline', 'export', '--editor-id', imported['editorId'], '--revision', '1', '--output', str(target)])
    assert result.exit_code == 0, result.exception
    request = stage(store, pid, session, target)
    response = api.post(f'/api/creation/projects/{pid}/timeline-package-imports', json={k: str(v) for k, v in request.items()})
    assert response.status_code == 200 and response.json()['status'] == 'applied'
    receipt = api.get(f'/api/creation/projects/{pid}/timeline-package-imports/{request["operationId"]}')
    assert receipt.json() == response.json()


@pytest.mark.anyio
@pytest.mark.merge
async def test_live_agent_gateway_package_roundtrip_scopes_files_without_large_json(project, tmp_path):
    import asyncio
    from opendirector.agent.context import RunContext
    from opendirector.agent.gateway import ToolGateway
    from opendirector.agent.tools import AgentTools
    from opendirector.agent.cli_transport import turn_environment
    from opendirector.infrastructure.model_configs import ModelConfigs
    from opendirector.infrastructure.creation_files import file_identity
    store, pid, session = project
    from test_timeline_fonts import tiny_font
    big_font = tiny_font(tmp_path / 'large.ttf', characters='AB中')
    with big_font.open('ab') as stream: stream.truncate(5 * 1024 * 1024)
    document, _, _ = timeline_document(project, tmp_path, font_bytes=big_font.read_bytes())
    assert send(store, pid, 'editor.create', session=session, document=document).status == 'applied'
    turn = uuid4()
    directory = store.root / 'Unified'
    work = directory / 'agent-runs' / str(turn) / 'work'; work.mkdir(parents=True)
    run = RunContext(runtime='codex', project_id=pid, turn_id=turn, session=session,
        directory=directory, config=None, messages=[], selected_skills=[])
    gateway = ToolGateway(AgentTools(store, None, ModelConfigs(tmp_path)), run)
    exported = await gateway.call('export', 'timeline_package_export', dict(editorId=str(document['id']), revision=1, path='saved.timeline.zip'))
    assert exported.error is None, exported
    archive = work / 'saved.timeline.zip'
    fingerprint, size = file_identity(archive)
    assert size > 4 * 1024 * 1024  # Exceeds gateway JSON envelope; bytes must stay on disk.
    arguments = dict(path='saved.timeline.zip', operationId=str(uuid4()), archiveFingerprint=fingerprint)
    imported = await gateway.call('import', 'timeline_package_import', arguments)
    assert imported.error is None and imported.value['status'] == 'applied', imported
    replay = await gateway.call('replay', 'timeline_package_import', arguments)
    assert replay.error is None and replay.value == imported.value
    assert (await gateway.call('overwrite', 'timeline_package_export',
        dict(editorId=str(document['id']), revision=1, path='saved.timeline.zip'))).error
    assert file_identity(archive) == (fingerprint, size)
    outside = await gateway.call('outside', 'timeline_package_export', dict(editorId=str(document['id']), revision=1, path=str(tmp_path / 'outside.zip')))
    assert outside.error and not (tmp_path / 'outside.zip').exists()
    if os.name == 'nt':
        import _winapi
        alias = work / 'junction'; _winapi.CreateJunction(str(work), str(alias))
        alias_path = 'junction/saved.timeline.zip'
    else:
        alias = work / 'symlink.zip'; alias.symlink_to(archive)
        alias_path = 'symlink.zip'
    try:
        assert (await gateway.call('symlink', 'timeline_package_import', {**arguments, 'operationId': str(uuid4()), 'path': alias_path})).error
    finally:
        alias.rmdir() if os.name == 'nt' else alias.unlink()
    # Actual CLI subprocess uses the turn socket; an invalid HTTP URL makes bypass visible.
    import tempfile
    socket_dir = tempfile.TemporaryDirectory(prefix='od-', dir=None if os.name == 'nt' else '/tmp')
    async with turn_environment(work, gateway, asyncio.Queue(), socket_dir.name) as env:
        env['OPENDIRECTOR_API_URL'] = 'http://127.0.0.1:1'
        launcher = work / '.opendirector-bin' / ('opendirector.cmd' if os.name == 'nt' else 'opendirector')
        prefix = [os.environ['COMSPEC'], '/d', '/c', str(launcher)] if os.name == 'nt' else [str(launcher)]
        process = await asyncio.create_subprocess_exec(*prefix,
            'timeline', 'export', '--editor-id', imported.value['editorId'], '--revision', '1', '--output', 'cli.timeline.zip',
            cwd=work, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await process.communicate()
        assert process.returncode == 0, (stdout.decode(), stderr.decode())
        assert (work / 'cli.timeline.zip').is_file()
        # The read-only export does not renew edit ownership. Refresh this
        # live session through the real open operation before the next mutation,
        # as the UI heartbeat does; keep lease expiry and ownership checks intact.
        store.open(pid, session)
        process = await asyncio.create_subprocess_exec(*prefix,
            'timeline', 'import', 'cli.timeline.zip', '--operation-id', str(uuid4()),
            cwd=work, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await process.communicate()
        assert process.returncode == 0, (stdout.decode(), stderr.decode())
        assert json.loads(stdout)['status'] == 'applied'

    socket_dir.cleanup()


def test_package_retry_after_process_restart_and_new_session_recovers_staged_resource(project, tmp_path, monkeypatch):
    from opendirector.infrastructure.creation_projects import CreationProjects
    from opendirector.infrastructure.local_projects import LocalProjects
    store, pid, session = project
    document, _, _ = timeline_document(project, tmp_path)
    assert send(store, pid, 'editor.create', session=session, document=document).status == 'applied'
    request = stage(store, pid, session, service(store).export(pid, document['id'], 1))
    packages = service(store)
    def interrupted(*args, **kwargs): raise OSError('interrupted before register commit')
    monkeypatch.setattr(packages.assets, 'register', interrupted)
    with pytest.raises(OSError): packages.import_package(pid, request, session=session)
    store.local.release(session)
    replacement = str(uuid4()); store.open(pid, replacement)
    reloaded = CreationProjects(LocalProjects(store.local.repository))
    result = service(reloaded).import_package(pid, request, session=replacement)
    assert result.status == 'applied'
    assert len(reloaded.snapshot(pid).assets) == 4


@pytest.mark.parametrize('language,expected', [('zh-CN', '可编辑时间线包无效或格式不受支持。'), ('en-US', 'Invalid or unsupported editable timeline package.')])
def test_package_errors_are_localized(project, tmp_path, language, expected):
    from fastapi.testclient import TestClient
    from opendirector_api.main import create_app
    store, pid, session = project
    invalid_zip = tmp_path / 'invalid.zip'; invalid_zip.write_bytes(b'not a zip')
    request = stage(store, pid, session, invalid_zip)
    api = TestClient(create_app(store.local), headers={'X-OpenDirector-Request':'1', 'X-OpenDirector-Session':session, 'Accept-Language':language})
    response = api.post(f'/api/creation/projects/{pid}/timeline-package-imports', json={k:str(v) for k,v in request.items()})
    assert response.status_code == 400
    assert response.json()['detail'] == expected


@pytest.mark.parametrize('damage', ['blank_source', 'duplicate_json', 'symlink', 'crc'])
def test_package_malformed_content_is_rejected_before_asset_writes(project, tmp_path, damage):
    from hashlib import sha256
    import struct
    store, pid, session = project
    document, _, _ = timeline_document(project, tmp_path)
    assert send(store, pid, 'editor.create', session=session, document=document).status == 'applied'
    package = service(store).export(pid, document['id'], 1)
    with zipfile.ZipFile(package) as archive:
        entries = {name:archive.read(name) for name in archive.namelist()}
    manifest = json.loads(entries['manifest.json'])
    if damage == 'blank_source':
        source = next(r for r in manifest['resources'] if r['kind'] == 'text')
        del entries[source['path']]
        content = b'   '
        fingerprint = 'sha256:' + sha256(content).hexdigest()
        source.update(path=f'assets/{fingerprint[7:]}.txt', fingerprint=fingerprint, size=len(content))
        source['source']['fingerprint'] = fingerprint
        entries[source['path']] = content
        data = json.loads(entries['timeline.json']); data['overlays'][0]['sourceAsset']['fingerprint'] = fingerprint
        entries['timeline.json'] = json.dumps(data).encode()
        entries['manifest.json'] = json.dumps(manifest).encode()
    if damage == 'duplicate_json':
        entries['manifest.json'] = entries['manifest.json'].replace(b'{', b'{"version":99,', 1)
    broken = tmp_path / 'bad.zip'
    with zipfile.ZipFile(broken, 'w') as archive:
        for name, content in entries.items():
            info = zipfile.ZipInfo(name)
            if damage == 'symlink' and name.startswith('assets/'):
                info.create_system = 3; info.external_attr = (0o120777 << 16)
            archive.writestr(info, content)
    if damage == 'crc':
        with zipfile.ZipFile(broken) as archive:
            info = archive.getinfo(manifest['resources'][0]['path'])
        raw = bytearray(broken.read_bytes())
        name_len, extra_len = struct.unpack_from('<HH', raw, info.header_offset + 26)
        raw[info.header_offset + 30 + name_len + extra_len + 10] ^= 1
        broken.write_bytes(raw)
    request = stage(store, pid, session, broken)
    before = store.snapshot(pid)
    with pytest.raises(ProjectError): service(store).import_package(pid, request, session=session)
    assert store.snapshot(pid) == before


@pytest.mark.anyio
async def test_export_response_removes_temporary_package_when_client_disconnects(tmp_path):
    from opendirector_api.creation import TemporaryPackageResponse
    path = tmp_path / 'temporary.timeline.zip'; path.write_bytes(b'zip')
    response = TemporaryPackageResponse(path, media_type='application/zip')
    async def disconnected_send(message): raise OSError('disconnected')
    async def receive(): return {'type':'http.disconnect'}
    with pytest.raises(OSError):
        await response({'type':'http', 'method':'GET', 'headers':[], 'extensions':{}, 'asgi':{'spec_version':'2.4'}}, receive, disconnected_send)
    assert not path.exists()


def test_package_rejects_excessive_declared_entry_count_before_directory_parsing(project, tmp_path):
    import struct
    store, pid, session = project
    document, _, _ = timeline_document(project, tmp_path)
    assert send(store, pid, 'editor.create', session=session, document=document).status == 'applied'
    package = service(store).export(pid, document['id'], 1)
    raw = bytearray(package.read_bytes())
    eocd = raw.rfind(b'PK\x05\x06')
    struct.pack_into('<HH', raw, eocd + 8, 5000, 5000)
    package.write_bytes(raw)
    request = stage(store, pid, session, package)
    before = store.snapshot(pid)
    with pytest.raises(ProjectError): service(store).import_package(pid, request, session=session)
    assert store.snapshot(pid) == before


def test_package_keeps_unused_library_media_and_validates_real_audio_before_registering(project, tmp_path):
    from io import BytesIO
    import wave
    from opendirector.application.creation_tool_assets import CreationToolAssets
    from opendirector.application.creation_assets import CreationAssets
    from opendirector.application.creation_canvas import asset_ref
    from opendirector.domain.creation.assets import AssetProvenance
    store, pid, session = project
    document, _, _ = timeline_document(project, tmp_path)
    wav = BytesIO()
    with wave.open(wav, 'wb') as stream:
        stream.setnchannels(1); stream.setsampwidth(2); stream.setframerate(48000)
        stream.writeframes(b'\x00\x00' * 4800)
    imported = CreationToolAssets(store).import_file(pid, uuid4(), 'unused.wav', wav.getvalue(), session,
        provenance=AssetProvenance(source='upload'))
    audio = CreationAssets(store).get(pid, imported['id'])
    document['data']['importedAssets'] = [dict(asset=asset_ref(audio), title='Unused audio', durationSeconds=.1)]
    assert send(store, pid, 'editor.create', session=session, document=document).status == 'applied'
    package = service(store).export(pid, document['id'], 1)
    result = service(store).import_package(pid, stage(store, pid, session, package), session=session)
    assert result.status == 'applied'
    restored = next(d for d in store.snapshot(pid).editorDocuments if d.id == result.editorId)
    assert restored.data.importedAssets[0].asset.assetId != audio.id
    assert restored.data.importedAssets[0].asset.fingerprint == audio.fingerprint
    with zipfile.ZipFile(package) as archive:
        entries = {name:archive.read(name) for name in archive.namelist()}
    data = json.loads(entries['timeline.json'])
    resource = {**data['importedAssets'][0], 'durationSeconds': 100}
    data['tracks'].append(dict(id='audio', kind='audio', title='Audio', clips=[dict(id='badclip', resource=resource, start=0, inPoint=0, outPoint=1)]))
    entries['timeline.json'] = json.dumps(data).encode()
    corrupt = tmp_path / 'overlong.zip'
    with zipfile.ZipFile(corrupt, 'w') as archive:
        for name, content in entries.items(): archive.writestr(name, content)
    before = store.snapshot(pid)
    with pytest.raises(ProjectError): service(store).import_package(pid, stage(store, pid, session, corrupt), session=session)
    assert store.snapshot(pid) == before


@pytest.mark.parametrize('override', ['zip64', 'adjusted_offset'])
def test_package_rejects_effective_directory_override_before_constructing_zipfile(project, tmp_path, monkeypatch, override):
    """The directory zipfile would allocate must be the directory we bounded."""
    from io import BytesIO
    import struct
    fixture = BytesIO()
    with zipfile.ZipFile(fixture, 'w') as archive:
        archive.writestr('x', b'')
    native = fixture.getvalue()
    end = native.rfind(b'PK\x05\x06')
    directory_size, directory_offset = struct.unpack_from('<LL', native, end + 12)
    entry = native[directory_offset:directory_offset + directory_size]
    actual = entry * 4097
    if override == 'zip64':
        prefix = native[:end]
        actual_offset = len(prefix)
        zip64_offset = actual_offset + len(actual)
        zip64_end = struct.pack('<4sQ2H2L4Q', b'PK\x06\x06', 44, 45, 45, 0, 0,
            4097, 4097, len(actual), actual_offset)
        locator = struct.pack('<4sLQL', b'PK\x06\x07', 0, zip64_offset, 1)
        ordinary = struct.pack('<4s4H2LH', b'PK\x05\x06', 0, 0, 1, 1, directory_size, directory_offset, 0)
        payload = prefix + actual + zip64_end + locator + ordinary
    else:
        # One long decoy entry occupies the same number of bytes as 4097 short
        # actual entries. Python's concat adjustment selects the latter.
        decoy = bytearray(entry[:46])
        name_size, extra_size = 65535, 65535
        comment_size = len(actual) - 46 - name_size - extra_size
        struct.pack_into('<3H', decoy, 28, name_size, extra_size, comment_size)
        decoy.extend(b'x' * (name_size + extra_size + comment_size))
        ordinary = struct.pack('<4s4H2LH', b'PK\x05\x06', 0, 0, 1, 1, len(decoy), 0, 0)
        payload = bytes(decoy) + actual + ordinary
    path = tmp_path / f'{override}.zip'; path.write_bytes(payload)
    assert len(payload) < 400000
    original = zipfile.ZipFile
    with original(path) as archive:
        assert len(archive.infolist()) == 4097  # Actual standard-library interpretation.
    constructions = []
    def observed_zipfile(*args, **kwargs):
        constructions.append(args[0])
        return original(*args, **kwargs)
    monkeypatch.setattr(zipfile, 'ZipFile', observed_zipfile)
    with pytest.raises(ProjectError): service(project[0])._validate(path, tmp_path)
    assert constructions == [], 'Untrusted directory must be bounded before ZipInfo allocation'


def test_package_recovers_final_batch_commit_before_terminal_journal_write(project, tmp_path, monkeypatch):
    from uuid import uuid5
    from opendirector.infrastructure.creation_projects import CreationProjects
    from opendirector.infrastructure.local_projects import LocalProjects
    store, pid, session = project
    document, _, _ = timeline_document(project, tmp_path)
    assert send(store, pid, 'editor.create', session=session, document=document).status == 'applied'
    request = stage(store, pid, session, service(store).export(pid, document['id'], 1))
    before = store.snapshot(pid)
    packages = service(store)
    original_write = packages.imports.write
    def interrupt_terminal_write(project_id, fixed_request, receipt):
        if receipt.status == 'applied':
            raise OSError('simulated process loss after final batch commit')
        return original_write(project_id, fixed_request, receipt)
    monkeypatch.setattr(packages.imports, 'write', interrupt_terminal_write)
    with pytest.raises(OSError, match='after final batch commit'):
        packages.import_package(pid, request, session=session)
    committed = store.snapshot(pid)
    final_receipt = store.receipt(pid, uuid5(request['operationId'], 'apply'))
    assert final_receipt.status == 'applied'
    assert len(committed.editorDocuments) == len(before.editorDocuments) + 1
    assert len(committed.canvasItems) == len(before.canvasItems) + 1
    asset_ids = tuple(asset.id for asset in committed.assets)
    editor_ids = tuple(editor.id for editor in committed.editorDocuments)
    canvas_ids = tuple(item.id for item in committed.canvasItems)
    assert packages.receipt(pid, request['operationId']).status == 'registered'
    store.local.release(session)
    replacement = str(uuid4())
    reloaded = CreationProjects(LocalProjects(store.local.repository))
    reloaded.open(pid, replacement)
    recovered = service(reloaded).import_package(pid, request, session=replacement)
    assert recovered.status == 'applied'
    assert recovered.receipt == final_receipt
    after = reloaded.snapshot(pid)
    assert tuple(asset.id for asset in after.assets) == asset_ids
    assert tuple(editor.id for editor in after.editorDocuments) == editor_ids
    assert tuple(item.id for item in after.canvasItems) == canvas_ids
    assert after == committed
    assert service(reloaded).receipt(pid, request['operationId']) == recovered
