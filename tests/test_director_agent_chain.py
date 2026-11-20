"""The agent tool path walks the whole Director Stage chain with the user's rules."""
import asyncio
import shutil
import subprocess
from uuid import UUID, uuid4

import pytest

from opendirector.agent.context import RunContext
from opendirector.agent.gateway import ToolGateway
from opendirector.agent.tools import AgentTools, COMMANDS, tools
from opendirector.domain.creation.commands import parse_command
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs

CAMERA = dict(position=dict(x=5, y=3.5, z=7), target=dict(x=0, y=1, z=0), fov=45)
TRANSFORM = dict(position=dict(x=0, y=0, z=0), rotation=dict(x=0, y=0, z=0), scale=dict(x=1, y=1, z=1))


@pytest.fixture
def chain(tmp_path):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('requires ffmpeg and ffprobe')
    projects = CreationProjects(LocalProjects(tmp_path))
    pid, turn, session = uuid4(), uuid4(), str(uuid4())
    assert projects.execute(parse_command(dict(projectId=pid, commandId=uuid4(), type='project.create',
                                               payload=dict(name='Agent chain')))).status == 'applied'
    projects.open(pid, session)
    with projects.local.transaction() as db:
        directory, _, _ = projects._load(db, pid)
    work = directory / 'agent-runs' / str(turn) / 'work'
    work.mkdir(parents=True)
    business = AgentTools(projects, None, ModelConfigs(tmp_path))
    run = RunContext(runtime='codex', project_id=pid, turn_id=turn, session=session,
                     directory=directory, config=None, messages=[], selected_skills=[])
    return business, run, work, projects


def mp4(path, seconds=1):
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi',
                    '-i', 'color=c=red:s=1280x720:r=24', '-t', str(seconds),
                    '-pix_fmt', 'yuv420p', str(path)], check=True)
    return path


def director_document(pid, document_id, *, camera_keyframes=()):
    return dict(id=str(document_id), projectId=str(pid), revision=1, kind='director', inputConnections=[], data=dict(
        background='#151923', grid=True, duration=1, aspectRatio='16:9',
        activeCameraId='camera-1', cameraSource='camera', shots=[],
        cameras=[dict(id='camera-1', name='Camera', pose=dict(CAMERA),
                      keyframes=[dict(id=f'key-{index}', time=time, value=dict(CAMERA))
                                 for index, time in enumerate(camera_keyframes)])],
        objects=[dict(id='actor', kind='person', name='Actor', color='#a09af9',
                      keyframes=[], motionClips=[], **TRANSFORM)]))


def call(business, run, call_id, kind, payload, versions=()):
    gateway = ToolGateway(business, run)

    async def run_call():
        response = await gateway.call(call_id, 'execute_command', {
            'type': kind, 'payload': payload,
            **({'expectedVersions': [dict(objectType=entry[0], id=str(entry[1]), revision=entry[2])
                                     for entry in versions]} if versions else {})})
        await gateway.close()
        return response
    return asyncio.run(run_call())


def versions(*pairs):
    return [(kind, value.id, value.revision) for kind, value in pairs]


def test_agent_walks_the_director_chain_with_user_rules(chain):
    business, run, work, projects = chain
    pid = run.project_id

    document_id, item_id = uuid4(), uuid4()
    created = call(business, run, 'create', 'creation.batch', {'operations': [
        {'type': 'editor.create', 'payload': {'document': director_document(pid, document_id)}},
        {'type': 'canvas.show', 'payload': {'item': dict(id=str(item_id), projectId=str(pid), kind='external',
            title='Agent stage', binding=dict(role='editor', objectRef=dict(id=str(document_id), kind='director')))}},
    ]})
    assert created.error is None, created
    snapshot = projects.snapshot(pid)
    item = next(i for i in snapshot.canvasItems if i.id == item_id)
    document = next(d for d in snapshot.editorDocuments if d.id == document_id)
    assert item.binding.role == 'editor' and document.kind == 'director'

    edited = call(business, run, 'edit', 'editor.save', {'document': director_document(
        pid, document_id, camera_keyframes=(0, 1))}, versions=versions(('editor_document', document)))
    assert edited.error is None, edited
    snapshot = projects.snapshot(pid)
    saved = next(d for d in snapshot.editorDocuments if d.id == document_id)
    assert [frame.time for frame in saved.data.cameras[0].keyframes] == [0.0, 1.0]

    render = mp4(work / 'preview.mp4')
    registered = call(business, run, 'register', 'artifact.publish',
                      {'path': 'preview.mp4', 'name': 'preview.mp4', 'expectedKind': 'video'})
    assert registered.error is None, registered
    asset_id = next(entry['id'] for entry in registered.value['changed'] if entry['objectType'] == 'asset')
    asset = next(a for a in projects.snapshot(pid).assets if str(a.id) == asset_id)
    assert asset.provenance.source == 'agent_written' and asset.kind == 'video'
    reference = dict(assetId=str(asset.id), revision=asset.revision,
                     fingerprint=asset.fingerprint, kind=asset.kind)
    output_id = uuid4()
    execution = {**director_document(pid, uuid4(), camera_keyframes=(0, 1))}
    published = call(business, run, 'publish', 'canvas.publishMedia', {
        'itemId': str(item_id), 'source': None, 'sourceEditorId': str(document_id),
        'document': execution,
        'outputs': [dict(itemId=str(output_id), asset=reference, title='Agent preview',
                         position=dict(x=360, y=0), width=320, height=180)],
    }, versions=versions(('canvas_item', item), ('editor_document', saved), ('asset', asset)))
    assert published.error is None, published
    snapshot = projects.snapshot(pid)
    output = next(i for i in snapshot.canvasItems if i.id == output_id)
    assert output.kind == 'video' and output.binding.role == 'material'
    assert output.binding.objectRef.assetId == asset.id
    assert any(d.id == UUID(execution['id']) for d in snapshot.editorDocuments)

    replay = call(business, run, 'publish', 'canvas.publishMedia', {
        'itemId': str(item_id), 'source': None, 'sourceEditorId': str(document_id),
        'document': execution,
        'outputs': [dict(itemId=str(output_id), asset=reference, title='Agent preview',
                         position=dict(x=360, y=0), width=320, height=180)],
    }, versions=versions(('canvas_item', item), ('editor_document', saved), ('asset', asset)))
    assert replay.error is None and replay.value['commandId'] == published.value['commandId']
    conflicting = call(business, run, 'publish', 'canvas.publishMedia', {
        'itemId': str(item_id), 'source': None, 'sourceEditorId': str(document_id),
        'document': execution,
        'outputs': [dict(itemId=str(uuid4()), asset=reference, title='Other',
                         position=dict(x=0, y=0), width=320, height=180)],
    }, versions=versions(('canvas_item', item), ('editor_document', saved), ('asset', asset)))
    assert conflicting.error or conflicting.value['status'] == 'rejected'

    reused = call(business, run, 'publish-used', 'canvas.publishMedia', {
        'itemId': str(item_id), 'source': None, 'sourceEditorId': str(document_id),
        'document': {**director_document(pid, uuid4(), camera_keyframes=(0, 1))},
        'outputs': [dict(itemId=str(uuid4()), asset=reference, title='Again',
                         position=dict(x=0, y=0), width=320, height=180)],
    }, versions=versions(('canvas_item', item), ('editor_document', saved), ('asset', asset)))
    assert reused.error or reused.value['status'] == 'rejected'
    user_rejection = projects.execute(parse_command(dict(
        projectId=pid, commandId=uuid4(), type='canvas.publishMedia',
        expectedVersions=[dict(objectType=v[0], id=str(v[1]), revision=v[2]) for v in versions(('canvas_item', item), ('editor_document', saved), ('asset', asset))],
        payload=dict(itemId=str(item_id), source=None, sourceEditorId=str(document_id),
                     document={**director_document(pid, uuid4(), camera_keyframes=(0, 1))},
                     outputs=[dict(itemId=str(uuid4()), asset=reference, title='User',
                                   position=dict(x=0, y=0), width=320, height=180)]))), session=run.session)
    assert user_rejection.status == 'rejected'

    timeline_id, timeline_item = uuid4(), uuid4()
    resource = dict(asset=reference, title='Agent shot', durationSeconds=1)
    timeline = call(business, run, 'timeline', 'creation.batch', {'operations': [
        {'type': 'editor.create', 'payload': {'document': dict(
            id=str(timeline_id), projectId=str(pid), revision=1, kind='timeline', inputConnections=[],
            data=dict(fps=30, width=1280, height=720, importedAssets=[resource],
                      tracks=[dict(id='visual', kind='visual', title='Visual',
                                   clips=[dict(id='shot', resource=resource, inPoint=0, outPoint=1)])]))}},
        {'type': 'canvas.show', 'payload': {'item': dict(id=str(timeline_item), projectId=str(pid), kind='timeline',
            title='Agent timeline', binding=dict(role='editor', objectRef=dict(id=str(timeline_id), kind='timeline')))}},
    ]})
    assert timeline.error is None, timeline

    mp4(work / 'render.mp4')
    render_asset = call(business, run, 'register-render', 'artifact.publish',
                        {'path': 'render.mp4', 'name': 'render.mp4', 'expectedKind': 'video'})
    render_id = next(entry['id'] for entry in render_asset.value['changed'] if entry['objectType'] == 'asset')
    render = next(a for a in projects.snapshot(pid).assets if str(a.id) == render_id)
    render_reference = dict(assetId=str(render.id), revision=render.revision,
                            fingerprint=render.fingerprint, kind=render.kind)
    timeline_doc = next(d for d in projects.snapshot(pid).editorDocuments if d.id == timeline_id)
    render_output_id = uuid4()
    rendered = call(business, run, 'publish-render', 'timeline.publishRender', {
        'itemId': str(timeline_item), 'editorId': str(timeline_id), 'asset': render_reference,
        'outputId': str(render_output_id), 'title': 'Timeline render', 'position': dict(x=0, y=360),
    }, versions=versions(('canvas_item', next(i for i in projects.snapshot(pid).canvasItems if i.id == timeline_item)), ('editor_document', timeline_doc), ('asset', render)))
    assert rendered.error is None, rendered
    snapshot = projects.snapshot(pid)
    timeline_item_now = next(i for i in snapshot.canvasItems if i.id == timeline_item)
    assert timeline_item_now.binding.role == 'editor'
    render_output = next(i for i in snapshot.canvasItems if i.id == render_output_id)
    assert render_output.kind == 'video' and render_output.binding.role == 'material'
    assert render_output.binding.objectRef.assetId == render.id
    render_now = next(a for a in snapshot.assets if a.id == render.id)
    assert render_now.provenance.source == 'rendered'
    assert render_now.provenance.editorDocumentId == timeline_id
    reopened = CreationProjects(LocalProjects(projects.local.repository)).snapshot(pid)
    assert any(i.id == output_id and i.binding.objectRef.assetId == asset.id for i in reopened.canvasItems)
    assert any(d.id == timeline_id for d in reopened.editorDocuments)


def test_publish_commands_are_agent_catalog_entries():
    assert {'canvas.publishMedia', 'timeline.publishRender'} <= set(COMMANDS)
    enum = tools()[3]['function']['parameters']['properties']['type']['enum']
    assert {'canvas.publishMedia', 'timeline.publishRender'} <= set(enum)
    batchable = COMMANDS['creation.batch'].model_json_schema()['$defs']['BatchPayload']
    kinds = set(batchable['properties']['operations']['items']['discriminator']['mapping'])
    # Publishing commands commit standalone, like the browser client sends them.
    assert 'canvas.publishMedia' not in kinds and 'timeline.publishRender' not in kinds
    assert 'asset.import' not in set(COMMANDS) and 'canvas.applyEdit' not in set(COMMANDS)
