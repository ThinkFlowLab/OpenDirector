"""Connection policy reaches retained editor content and survives project reopen."""
from io import BytesIO
import shutil
import subprocess
from uuid import uuid4
import wave

from PIL import Image
import pytest

from opendirector.application.creation_assets import CreationAssets
from opendirector.application.creation_canvas import DOWNSTREAM, asset_ref, resolved_inputs
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from test_creation_canvas_service import project, media, send, ver


def upload_source(project, tmp_path, kind, seconds=1, color='blue'):
    store, pid, session = project
    if kind == 'image':
        buffer = BytesIO()
        Image.new('RGB', (16, 16), color).save(buffer, 'PNG')
        content, name = buffer.getvalue(), 'source.png'
    elif kind == 'audio':
        buffer = BytesIO()
        with wave.open(buffer, 'wb') as output:
            output.setparams((1, 2, 8000, 0, 'NONE', 'not compressed'))
            output.writeframes(b'\0\0' * int(seconds * 8000))
        content, name = buffer.getvalue(), 'source.wav'
    else:
        if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
            pytest.skip('requires local FFmpeg')
        path = tmp_path / f'{uuid4()}.mp4'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
            'color=c=blue:s=16x16:r=1', '-t', str(seconds), '-pix_fmt', 'yuv420p', str(path)], check=True)
        content, name = path.read_bytes(), 'source.mp4'
    handle = uuid4()
    writer = CreationAssets(store).uploads.begin(pid, handle, session, name, expected_kind=kind)
    writer.write(content)
    writer.finish()
    receipt = send(store, pid, 'asset.import', session=session, uploadHandle=handle, name=name, expectedKind=kind)
    assert receipt.status == 'applied', receipt
    asset = store.snapshot(pid).assets[-1]
    item_id = uuid4()
    assert send(store, pid, 'canvas.show', session=session, item=dict(id=item_id, projectId=pid,
        kind=kind, binding=dict(role='material', objectRef=asset_ref(asset)))).status == 'applied'
    return store.snapshot(pid).canvasItems[-1], asset


def editor(project, kind, asset, source, **changes):
    _, pid, _ = project
    if kind == 'subject':
        data, slot = dict(main=asset_ref(asset)), 'main'
    else:
        slot = 'clip'
        clip = dict(id=slot, resource=dict(asset=asset_ref(asset), title=asset.name), inPoint=0,
            outPoint=asset.metadata.durationSeconds or 5)
        audio = asset.kind == 'audio'
        if audio:
            clip['start'] = 0
        tracks = [dict(id='visual', kind='visual', title='Visual', clips=[] if audio else [clip])]
        if audio:
            tracks.append(dict(id='audio', kind='audio', title='Audio', clips=[clip]))
        data = dict(fps=30, width=1920, height=1080, tracks=tracks)
    return dict(id=uuid4(), projectId=pid, kind=kind, data=data,
        inputConnections=[dict(id=uuid4(), sourceId=source.id, slotId=slot, asset=asset_ref(asset))], **changes)


@pytest.mark.parametrize(('source_kind', 'target_kind'), [
    ('image', 'subject'), ('video', 'subject'),
    ('image', 'timeline'), ('video', 'timeline'), ('audio', 'timeline'),
])
def test_assembly_persists_real_content_and_relation_without_generation(project, tmp_path, source_kind, target_kind):
    store, pid, session = project
    source, asset = upload_source(project, tmp_path, source_kind)
    document = editor(project, target_kind, asset, source)
    item_id = uuid4()
    receipt = send(store, pid, 'creation.batch', session=session, versions=[ver('canvas_item', source)], operations=[
        dict(type='editor.create', payload=dict(document=document)),
        dict(type='canvas.show', payload=dict(item=dict(id=item_id, projectId=pid, kind=target_kind,
            binding=dict(role='editor', objectRef=dict(id=document['id'], kind=target_kind))))),
    ])
    assert receipt.status == 'applied', receipt
    current = CreationProjects(LocalProjects(store.local.repository)).snapshot(pid)
    assert not current.references and not current.generationSpecs and not current.jobs
    connection = current.editorDocuments[-1].inputConnections[0]
    assert connection.id == document['inputConnections'][0]['id']
    assert connection.sourceId == source.id and connection.asset.assetId == asset.id
    assert current.canvasItems[-1].binding.role == 'editor'
    # Layout edits do not re-read, import, or reapply the source.
    assert send(store, pid, 'canvas.move', session=session, versions=[ver('canvas_item', source)],
        items=[dict(itemId=source.id, position=dict(x=4, y=9))]).status == 'applied'


def test_audio_cannot_assemble_into_subject_and_rejection_keeps_project_unchanged(project, tmp_path):
    store, pid, session = project
    source, image = upload_source(project, tmp_path, 'image')
    audio_source, audio = upload_source(project, tmp_path, 'audio', 3)
    document = editor(project, 'subject', image, source)
    document['data']['voice'] = asset_ref(audio)
    document['inputConnections'][0] = dict(id=uuid4(), sourceId=audio_source.id, slotId='voice', asset=asset_ref(audio))
    before = store.snapshot(pid)
    with pytest.raises(ValueError):
        send(store, pid, 'editor.create', session=session, document=document)
    assert store.snapshot(pid) == before


@pytest.mark.parametrize('main_kind', ['image', 'video'])
@pytest.mark.parametrize('target_kind', ['image', 'video', 'audio'])
def test_subject_downstream_depends_on_main_media_on_backend(project, tmp_path, main_kind, target_kind):
    store, pid, session = project
    source, asset = upload_source(project, tmp_path, main_kind)
    document = editor(project, 'subject', asset, source)
    item_id = uuid4()
    assert send(store, pid, 'creation.batch', session=session, operations=[
        dict(type='editor.create', payload=dict(document=document)),
        dict(type='canvas.show', payload=dict(item=dict(id=item_id, projectId=pid, kind='subject',
            binding=dict(role='editor', objectRef=dict(id=document['id'], kind='subject'))))),
    ]).status == 'applied'
    target, spec = media(project, target_kind)
    before = store.snapshot(pid)
    receipt = send(store, pid, 'reference.add', session=session,
        versions=[ver('canvas_item', target), ver('generation_spec', spec)],
        reference=dict(id=uuid4(), projectId=pid, targetSpecId=spec.id, binding='follow_current', source=dict(id=item_id)))
    if main_kind == 'video' and target_kind != 'video':
        assert receipt.status == 'rejected'
        assert store.snapshot(pid) == before
    else:
        assert receipt.status == 'applied', receipt
        assert resolved_inputs(store.snapshot(pid), spec.id)[0].asset.assetId == asset.id


def test_typescript_and_python_publish_the_same_type_matrix():
    import json
    from pathlib import Path
    import re
    code = (Path(__file__).resolve().parents[1] / 'src/canvas/connectionPolicy.ts').read_text(encoding='utf-8')
    table = code.split('> = {', 1)[1].split('};', 1)[0]
    pairs = re.findall(r'(\w+):\s*(\[[^\]]*\])', table)
    assert {kind: set(json.loads(values)) for kind, values in pairs} == DOWNSTREAM
    assert 'subject' not in DOWNSTREAM['audio']
    assert 'timeline' not in DOWNSTREAM


def test_assembled_snapshot_survives_source_replacement_but_stale_new_assembly_is_rejected(project, tmp_path):
    store, pid, session = project
    source, original = upload_source(project, tmp_path, 'image')
    document = editor(project, 'subject', original, source)
    assert send(store, pid, 'editor.create', session=session, document=document).status == 'applied'
    _, replacement = upload_source(project, tmp_path, 'image', color='red')
    assert send(store, pid, 'canvas.materialize', session=session, versions=[ver('canvas_item', source)],
        itemId=source.id, asset=asset_ref(replacement)).status == 'applied'
    current = store.snapshot(pid)
    retained = current.editorDocuments[-1]
    assert retained.data.main.assetId == original.id
    assert retained.inputConnections[0].asset.assetId == original.id
    changed = retained.model_dump(mode='json')
    changed['data']['description'] = 'Keep the original visual identity'
    assert send(store, pid, 'editor.save', session=session, versions=[ver('editor_document', retained)],
        document=changed).status == 'applied'
    before = store.snapshot(pid)
    stale = editor(project, 'subject', original, source)
    receipt = send(store, pid, 'editor.create', session=session, document=stale)
    assert receipt.status == 'rejected'
    assert store.snapshot(pid) == before
