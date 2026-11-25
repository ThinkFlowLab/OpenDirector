"""Selection sources are read-only and subject limits use verified media bytes."""
import base64
from copy import deepcopy
from io import BytesIO
from pathlib import Path
import shutil
import subprocess
import wave
from uuid import uuid4

import pytest
from test_library import app, client, store, png, upload
from test_creation_canvas_service import project, send
from opendirector.application.canvas_sources import CanvasSources
from opendirector.application.creation_canvas import asset_ref
from opendirector.domain.projects import ProjectError
from opendirector.application.creation_tool_assets import CreationToolAssets
from test_creation_canvas_service import ver
from generation_helpers import new_project
from opendirector.infrastructure.creation_projects import CreationProjects
from test_subject_library import register_image


pytestmark = pytest.mark.cpu


def canvas_source(store, kind='image', payload=None):
    projects, owner, session = new_project(store.repository, 'Canvas source')
    assets = CreationToolAssets(projects)
    record = assets.import_file(owner, uuid4(), 'Source.png' if kind == 'image' else 'Source.wav', payload or png('red'), session)
    asset = assets.assets.get(owner, record['id'])
    node_id = uuid4()
    assert send(projects, owner, 'canvas.show', session=session, item=dict(id=node_id, projectId=owner,
        kind=kind, title='Source', binding=dict(role='material', objectRef=asset_ref(asset)))).status == 'applied'
    return str(owner), session, str(node_id), projects, projects.snapshot(owner).canvasItems[0]


def audio(seconds):
    out=BytesIO()
    with wave.open(out,'wb') as stream:
        stream.setnchannels(1);stream.setsampwidth(2);stream.setframerate(8000)
        stream.writeframes(bytes(8000*2*seconds))
    return out.getvalue()


def test_canvas_sources_preserve_identity_and_never_open_a_session(store):
    owner, session, node_id, projects, item = canvas_source(store)
    service = CanvasSources(projects)
    rows = service.list(owner)
    assert rows[0]['nodeId'] == node_id and rows[0]['main']['assetId']
    result = service.prepare(owner, node_id, rows[0]['revision'])
    assert result['media'][0]['kind'] == 'image'
    assert service.media(owner, node_id, rows[0]['revision'], 'main')[0] == png('red')
    assert send(projects, owner, 'canvas.update', session=session, versions=[ver('canvas_item', item)],
        itemId=item.id, title='Edited / frame: 1').status == 'applied'
    with pytest.raises(ProjectError, match='已变化'):
        service.prepare(owner, node_id, rows[0]['revision'])
    fresh = service.list(owner)[0]
    filename = service.prepare(owner, node_id, fresh['revision'])['media'][0]['name']
    assert '/' not in filename and ':' not in filename
    projects.heartbeat(session, owner)


@pytest.mark.parametrize('seconds,allowed',[(15,True),(16,False)])
def test_canvas_audio_limit_is_actual_not_declared_metadata(store,seconds,allowed):
    owner,_,node_id,_,_=canvas_source(store,'audio',audio(seconds))
    service=CanvasSources(CreationProjects(store));row=service.list(owner)[0]
    if allowed:
        result=service.prepare(owner,node_id,row['revision'],'voice')
        assert result['media'][0]['metadata']['durationSeconds']==15
    else:
        with pytest.raises(ProjectError,match='15 秒'):
            service.prepare(owner,node_id,row['revision'],'voice')
    with pytest.raises(ProjectError):service.prepare(owner,node_id,row['revision'],'main')


@pytest.mark.parametrize('seconds,allowed',[(15,True),(16,False)])
def test_library_video_limit_uses_actual_bytes(client,seconds,allowed):
    payload=subprocess.check_output(['ffmpeg','-v','error','-f','lavfi','-i','color=c=blue:s=32x32:r=1','-t',str(seconds),'-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1'])
    item=client.post('/api/library/items/upload',params={'name':'clip.mp4'},content=payload,headers={'Content-Type':'video/mp4'}).json()
    response=client.post(f"/api/library/items/{item['id']}/prepare-subject-media",json={'revision':item['revision'],'slot':'main'})
    assert response.status_code==(200 if allowed else 422),response.text
    choices=client.get('/api/library/subject-media?slot=main').json()
    assert next(row for row in choices if row['id']==item['id'])['available'] is allowed
    assert client.post(f"/api/library/items/{item['id']}/prepare-subject-media",json={'revision':item['revision'],'slot':'auxiliary'}).status_code in {400,422}


def test_canvas_full_subject_retains_every_slot_and_rejects_non_media(project):
    projects, owner, session = project
    assets = CreationToolAssets(projects)
    refs = []
    for name, content in [('main.png', png('red')), ('aux.png', png('blue')), ('voice.wav', audio(15))]:
        record = assets.import_file(owner, uuid4(), name, content, session)
        refs.append(asset_ref(assets.assets.get(owner, record['id'])))
    editor_id, node_id = uuid4(), uuid4()
    assert send(projects, owner, 'creation.batch', session=session, operations=[
        dict(type='editor.create', payload=dict(document=dict(id=editor_id, projectId=owner, kind='subject',
            data=dict(description='User only', category='character', main=refs[0], auxiliaries=[refs[1]], voice=refs[2])))),
        dict(type='canvas.show', payload=dict(item=dict(id=node_id, projectId=owner, kind='subject',
            binding=dict(role='editor', objectRef=dict(id=editor_id, kind='subject')))))
    ]).status == 'applied'
    service = CanvasSources(projects); row = service.list(owner)[0]
    prepared = service.prepare(owner, row['nodeId'], row['revision'])
    assert [item['slot'] for item in prepared['media']] == ['main', 'auxiliary:0', 'voice']
    assert prepared['description'] == 'User only'
    with pytest.raises(ProjectError): service.prepare(owner, row['nodeId'], row['revision'], 'voice')
    before = projects.snapshot(owner)
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        send(projects, owner, 'editor.create', session=session, document=dict(id=uuid4(), projectId=owner, kind='subject',
            data=dict(main=refs[0], auxiliaries=[refs[1]] * 4)))
    assert projects.snapshot(owner) == before


def test_unified_queries_do_not_take_lease_and_read_editor_data(project):
    store,pid,session=project
    asset=register_image(project)
    editor_id,node_id=uuid4(),uuid4()
    result=send(store,pid,'creation.batch',session=session,operations=[
        dict(type='editor.create',payload=dict(document=dict(id=editor_id,projectId=pid,kind='subject',data=dict(main=asset_ref(asset))))),
        dict(type='canvas.show',payload=dict(item=dict(id=node_id,projectId=pid,kind='subject',title='Whole',binding=dict(role='editor',objectRef=dict(id=editor_id,kind='subject')))))])
    assert result.status=='applied'
    sources=CanvasSources(store);row=sources.list(pid)[0]
    assert row['nodeId']==str(node_id) and row['kind']=='subject'
    assert sources.prepare(pid,node_id,row['revision'])['media'][0]['kind']=='image'
    store.heartbeat(str(session), str(pid))


def test_read_only_source_endpoints_preserve_source_lease(client, store):
    owner, session, node_id, projects, _ = canvas_source(store)
    rows = client.get(f'/api/library/canvases/{owner}/sources').json()
    assert rows[0]['nodeId'] == node_id
    response = client.post(f'/api/library/canvases/{owner}/prepare', json=dict(nodeId=node_id, revision=rows[0]['revision'], slot='main'))
    assert response.status_code == 200, response.text
    media = client.get(f'/api/library/canvases/{owner}/nodes/{node_id}/media/main', params=dict(revision=rows[0]['revision']))
    assert media.status_code == 200 and media.content == png('red')
    projects.heartbeat(session, owner)


def test_global_canvas_copy_probes_media_without_subject_duration_limit(store):
    owner,_,node_id,_,_=canvas_source(store,'audio',audio(16))
    sources=CanvasSources(CreationProjects(store))
    row=sources.list(owner)[0]
    value=sources.prepare(owner,node_id,row['revision'],subject=False)
    assert value['media'][0]['metadata']['durationSeconds']==16
    assert value['media'][0]['metadata']['mimeType']=='audio/wav'


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='requires local FFmpeg')
def test_canvas_source_preview_is_a_small_immutable_jpeg(client, store):
    """A grid card asks for `thumb`; the original bytes stay one request away."""
    owner, session, node_id, projects, _ = canvas_source(store, payload=png('red', (1600, 1200)))
    revision = CanvasSources(projects).list(owner)[0]['revision']
    url = f'/api/library/canvases/{owner}/nodes/{node_id}/media/main'
    original = client.get(url, params=dict(revision=revision))
    assert original.status_code == 200 and original.content == png('red', (1600, 1200))
    # Revision-addressed bytes never change, so the browser may keep them.
    assert 'immutable' in original.headers['cache-control']

    preview = client.get(url, params=dict(revision=revision, size='thumb'))
    assert preview.status_code == 200, preview.text
    assert preview.headers['content-type'] == 'image/jpeg'
    assert preview.content[:3] == b'\xff\xd8\xff'
    assert len(preview.content) < len(original.content)

    # The preview is cached by revision, so a second view is the same bytes.
    again = client.get(url, params=dict(revision=revision, size='thumb'))
    assert again.content == preview.content
    projects.heartbeat(session, owner)
