"""Timeline render publication validates the saved source and real output files."""
import subprocess
from uuid import uuid4

import pytest

from opendirector.application.creation_tool_assets import CreationToolAssets
from opendirector.domain.creation.assets import AssetProvenance
from opendirector.domain.projects import ProjectError
from opendirector.application.creation_canvas import asset_ref
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from test_creation_canvas_service import project, send, ver


def clip(seconds=2, size='64x64'):
    return subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', f'color=blue:s={size}:r=24',
        '-t', str(seconds), '-threads', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'], check=True, capture_output=True).stdout


def prepared(project):
    store, pid, session = project
    assets = CreationToolAssets(store)
    def imported(name, data):
        record = assets.import_file(pid, uuid4(), name, data, session, provenance=AssetProvenance(source="upload"))
        return assets.assets.get(pid, record['id'])
    source, output = imported('source.mp4', clip(4)), imported('render.mp4', clip())
    doc_id, item_id = uuid4(), uuid4()
    document = dict(id=doc_id, projectId=pid, kind='timeline', data=dict(width=64, height=64, fps=24, tracks=[
        dict(id='visual', title='Visual', kind='visual', clips=[dict(id='clip', inPoint=0, outPoint=4, speed=2,
            resource=dict(asset=asset_ref(source), title='Source', durationSeconds=4))])]))
    # FFmpeg and background imports do not renew edit leases. The active UI
    # sends open heartbeats; establish that same precondition before editing.
    store.open(pid, session)
    assert send(store, pid, 'creation.batch', session=session, operations=[
        dict(type='editor.create', payload=dict(document=document)),
        dict(type='canvas.show', payload=dict(item=dict(id=item_id, projectId=pid, kind='timeline',
            binding=dict(role='editor', objectRef=dict(id=doc_id, kind='timeline'))))) ]).status == 'applied'
    snapshot = store.snapshot(pid)
    item, doc = snapshot.canvasItems[0], snapshot.editorDocuments[0]
    versions = [ver('canvas_item', item), ver('editor_document', doc), ver('asset', output)]
    payload = dict(itemId=item.id, editorId=doc.id, asset=asset_ref(output), outputId=uuid4(), title='Rendered')
    return source, output, versions, payload


@pytest.mark.parametrize('actor', ['ui', 'agent'])
def test_publish_replay_reopen_and_undo(project, actor):
    from opendirector.domain.creation.commands import parse_command
    store, pid, session = project
    source, output, versions, payload = prepared(project)
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='timeline.publishRender', expectedVersions=versions, payload=payload))
    receipt = store.execute(command, session=session, source=actor)
    assert receipt.status == 'applied', receipt
    assert store.execute(command, session=session, source=actor) == receipt
    snapshot = store.snapshot(pid)
    asset = next(a for a in snapshot.assets if a.id == output.id)
    assert asset.provenance.source == 'rendered'
    assert asset.provenance.editorDocumentId == snapshot.editorDocuments[0].id
    assert asset.provenance.editorRevision == snapshot.editorDocuments[0].revision == 1
    assert asset.provenance.sources == (asset_ref(source),)
    assert snapshot.canvasItems[-1].binding.objectRef.assetId == output.id
    assert not snapshot.jobs and not snapshot.results
    assert CreationProjects(LocalProjects(store.local.repository)).snapshot(pid) == snapshot
    current_versions = [*[ver('canvas_item', i) for i in snapshot.canvasItems], *[ver('asset', a) for a in snapshot.assets],
                        *[ver('editor_document', d) for d in snapshot.editorDocuments]]
    undo = send(store, pid, 'history.undo', session=session, versions=current_versions, targetCommandId=receipt.commandId)
    assert undo.status == 'applied', undo
    assert sum(i.visible for i in store.snapshot(pid).canvasItems) == 1
    assert next(a for a in store.snapshot(pid).assets if a.id == output.id).provenance.source == "rendered"


@pytest.mark.parametrize('change', ['stale', 'locked', 'size', 'duration', 'missing', 'missing_source'])
def test_rejected_render_does_not_publish_or_change_provenance(project, change):
    store, pid, session = project
    _, output, versions, payload = prepared(project)
    before = store.snapshot(pid)
    if change == 'stale':
        doc = before.editorDocuments[0].model_dump(mode='json')
        doc['data']['tracks'][0]['clips'][0]['speed'] = 1
        assert send(store, pid, 'editor.save', session=session, versions=versions, document=doc).status == 'applied'
    elif change == 'locked':
        item = before.canvasItems[0]
        assert send(store, pid, 'canvas.update', session=session, versions=versions, itemId=item.id, locked=True).status == 'applied'
        versions[0] = ver('canvas_item', store.snapshot(pid).canvasItems[0])
    elif change in {'size', 'duration'}:
        assets = CreationToolAssets(store)
        record = assets.import_file(pid, uuid4(), 'invalid.mp4', clip(3 if change == 'duration' else 2, '128x64' if change == 'size' else '64x64'), session, provenance=AssetProvenance(source='upload'))
        output = assets.assets.get(pid, record['id'])
        payload['asset'] = asset_ref(output)
        versions[-1] = ver('asset', output)
    else:
        missing = before.assets[0] if change == 'missing_source' else output
        (store.root / before.project.name / missing.path).unlink()
    before = store.snapshot(pid)
    receipt = send(store, pid, 'timeline.publishRender', session=session, versions=versions, **payload)
    assert receipt.status == 'rejected', receipt
    assert store.snapshot(pid) == before


def test_timeline_rejects_clip_beyond_actual_duration_even_when_client_claims_longer(project):
    store, pid, session = project
    _, _, versions, _ = prepared(project)
    before = store.snapshot(pid)
    document = before.editorDocuments[0].model_dump(mode='json')
    document['data']['tracks'][0]['clips'][0].update(outPoint=5, resource={**document['data']['tracks'][0]['clips'][0]['resource'], 'durationSeconds': 9})
    receipt = send(store, pid, 'editor.save', session=session, versions=versions, document=document)
    assert receipt.status == 'rejected'
    assert store.snapshot(pid) == before


def test_timeline_accepts_a_clip_rounded_to_the_nearest_millisecond(project):
    """Durations also travel as whole milliseconds, so a clip seeded from that
    rounded value can sit up to half a millisecond past the measured one. A
    121-frame clip at 24 fps lasts 5.041667s and is announced as 5042ms, which is
    5.042s; re-probing the same file on import finds 5.041667 again. The shared
    tolerance has to cover the rounding, or every import of such a clip fails."""
    from opendirector.domain.rule_facts import TIMELINE_DURATION_EPSILON
    measured, rounded = 5.041667, 5.042
    assert rounded - measured <= TIMELINE_DURATION_EPSILON

    store, pid, session = project
    _, _, versions, _ = prepared(project)
    document = store.snapshot(pid).editorDocuments[0].model_dump(mode='json')
    source = document['data']['tracks'][0]['clips'][0]
    # The fixture imports a whole second of video, so shift the clip by the same
    # kind of rounding instead of inventing a new asset.
    source['outPoint'] = 4.000333
    source['resource']['durationSeconds'] = 4.000333
    receipt = send(store, pid, 'editor.save', session=session, versions=versions, document=document)
    assert receipt.status == 'applied', receipt


def test_timeline_skips_the_duration_check_when_the_asset_was_never_measured(project, monkeypatch):
    """A probe that cannot report a duration says nothing about overflow. The
    document boundary and the aggregate validation already skip the comparison
    in that case, so the timeline gate must agree instead of rejecting a
    document the client accepted."""
    from opendirector.application.creation_assets import CreationAssets

    store, pid, session = project
    _, _, versions, _ = prepared(project)
    document = store.snapshot(pid).editorDocuments[0].model_dump(mode='json')
    document['data']['tracks'][0]['clips'][0]['resource']['title'] = 'Source again'

    original = CreationAssets._reference.__func__

    def unmeasured(assets, snapshot, reference):
        asset = original(assets, snapshot, reference)
        return asset.model_copy(update={'metadata': asset.metadata.model_copy(
            update={'durationSeconds': None})})

    monkeypatch.setattr(CreationAssets, '_reference', classmethod(unmeasured))
    receipt = send(store, pid, 'editor.save', session=session, versions=versions, document=document)
    assert receipt.status == 'applied', receipt


def prepared_text(project, tmp_path, *, pure_text=False, output_seconds=3):
    from test_timeline_fonts import timeline_document, tiny_font
    store, pid, session = project
    media_source, _, _, _ = prepared(project)
    text_document, font, text_source = timeline_document(project, tmp_path)
    # A retained but unused font is not an input to this render.
    assets = CreationToolAssets(store)
    unused_path = tiny_font(tmp_path / 'unused.ttf', characters='B')
    unused_record = assets.import_file(pid, uuid4(), 'unused.ttf', unused_path.read_bytes(), session,
                                       provenance=AssetProvenance(source='upload'))
    unused = assets.assets.get(pid, unused_record['id'])
    text_document['data']['fonts'].append(dict(id='unused', title='Unused', asset=asset_ref(unused)))
    doc = store.snapshot(pid).editorDocuments[0]
    changed = doc.model_dump(mode='json')
    changed['data'].update(fonts=text_document['data']['fonts'], overlays=text_document['data']['overlays'])
    if pure_text:
        changed['data']['tracks'][0]['clips'] = []
    assert send(store, pid, 'editor.save', session=session,
                versions=[ver('editor_document', doc)], document=changed).status == 'applied'
    assets = CreationToolAssets(store)
    record = assets.import_file(pid, uuid4(), 'text-render.mp4', clip(output_seconds), session,
                                provenance=AssetProvenance(source='upload'))
    output = assets.assets.get(pid, record['id'])
    snapshot = store.snapshot(pid)
    item, doc = snapshot.canvasItems[0], snapshot.editorDocuments[0]
    versions = [ver('canvas_item', item), ver('editor_document', doc), ver('asset', output)]
    payload = dict(itemId=item.id, editorId=doc.id, asset=asset_ref(output), outputId=uuid4(), title='Text render')
    return media_source, font, text_source, output, versions, payload


@pytest.mark.parametrize('actor', ['ui', 'agent'])
@pytest.mark.parametrize('pure_text', [False, True])
def test_text_tail_publication_keeps_exact_input_revision_and_immutable_outputs(project, tmp_path, actor, pure_text):
    from opendirector.application.creation_canvas import CreationCanvas
    from opendirector.domain.creation.commands import ObjectQuery, parse_command
    store, pid, session = project
    media_source, font, text_source, output, versions, payload = prepared_text(project, tmp_path, pure_text=pure_text)
    original = store.snapshot(pid).editorDocuments[0]
    original_bytes = (store.root / 'Unified' / output.path).read_bytes()
    command = parse_command(dict(commandId=uuid4(), projectId=pid, type='timeline.publishRender',
                                 expectedVersions=versions, payload=payload))
    receipt = store.execute(command, session=session, source=actor)
    assert receipt.status == 'applied', receipt
    assert store.execute(command, session=session, source=actor) == receipt
    published = next(a for a in store.snapshot(pid).assets if a.id == output.id)
    expected_sources = (() if pure_text else (asset_ref(media_source),)) + (asset_ref(font), asset_ref(text_source))
    assert published.provenance.sources == expected_sources
    assert published.provenance.editorRevision == original.revision
    changed = original.model_dump(mode='json')
    changed['data']['overlays'][0]['text'] = 'B中'
    assert send(store, pid, 'editor.save', session=session, versions=[ver('editor_document', original)],
                document=changed).status == 'applied'
    current = store.snapshot(pid).editorDocuments[0]
    assets = CreationToolAssets(store)
    record = assets.import_file(pid, uuid4(), 'text-render-B.mp4', clip(3), session,
                                provenance=AssetProvenance(source='upload'))
    output_b = assets.assets.get(pid, record['id'])
    item = store.snapshot(pid).canvasItems[0]
    second = {**payload, 'outputId': uuid4(), 'asset': asset_ref(output_b)}
    assert send(store, pid, 'timeline.publishRender', session=session,
                versions=[ver('canvas_item', item), ver('editor_document', current), ver('asset', output_b)], **second).status == 'applied'
    reopened = CreationProjects(LocalProjects(store.local.repository))
    snapshot = reopened.snapshot(pid)
    assert next(a for a in snapshot.assets if a.id == output.id) == published
    assert output_b.id != output.id
    assert next(a for a in snapshot.assets if a.id == output_b.id).provenance.editorRevision == current.revision
    query = ObjectQuery(queryId=uuid4(), type='object.get', projectId=pid, objectId=original.id, revision=original.revision)
    assert CreationCanvas(reopened).query_snapshot(query) == original
    assert CreationCanvas(reopened).query_snapshot(ObjectQuery(queryId=uuid4(), type='object.get', projectId=pid, objectId=current.id)) == current
    assert (store.root / snapshot.project.name / published.path).read_bytes() == original_bytes
    # Even after the accepted basis changes, an identical delivery replays its
    # first receipt; changing the input under that command ID is rejected.
    assert reopened.execute(command, session=session, source=actor) == receipt
    altered = command.model_copy(update={'payload': command.payload.model_copy(update={'title': 'Different'})})
    with pytest.raises(ProjectError) as conflict:
        reopened.execute(altered, session=session, source=actor)
    assert conflict.value.code == 'command_conflict'


@pytest.mark.parametrize('change', ['duration', 'missing_font', 'missing_text_source', 'stale', 'parent_locked'])
def test_text_render_publish_rechecks_resources_versions_and_parent_lock(project, tmp_path, change):
    store, pid, session = project
    _, font, text_source, output, versions, payload = prepared_text(project, tmp_path,
        output_seconds=2 if change == 'duration' else 3)
    if change in {'missing_font', 'missing_text_source'}:
        missing = font if change == 'missing_font' else text_source
        (store.root / 'Unified' / missing.path).unlink()
    elif change == 'stale':
        doc = store.snapshot(pid).editorDocuments[0]
        changed = doc.model_dump(mode='json'); changed['data']['overlays'][0]['text'] = 'B'
        assert send(store, pid, 'editor.save', session=session,
                    versions=[ver('editor_document', doc)], document=changed).status == 'applied'
    elif change == 'parent_locked':
        parent_id = uuid4()
        item = store.snapshot(pid).canvasItems[0]
        assert send(store, pid, 'creation.batch', session=session, versions=[ver('canvas_item', item)], operations=[
            dict(type='canvas.show', payload=dict(item=dict(id=parent_id, projectId=pid, kind='group'))),
            dict(type='canvas.update', payload=dict(itemId=item.id, parentId=parent_id)),
        ]).status == 'applied'
        snapshot = store.snapshot(pid)
        versions[0] = ver('canvas_item', snapshot.canvasItems[0])
        parent = next(i for i in snapshot.canvasItems if i.id == parent_id)
        assert send(store, pid, 'canvas.update', session=session, versions=[ver('canvas_item', parent)],
                    itemId=parent.id, locked=True).status == 'applied'
    before = store.snapshot(pid)
    receipt = send(store, pid, 'timeline.publishRender', session=session, versions=versions, **payload)
    assert receipt.status == 'rejected', receipt
    assert store.snapshot(pid) == before
    assert next(a for a in before.assets if a.id == output.id).provenance.source == 'upload'
    stream, _ = CreationToolAssets(store).assets.open_media(pid, output.id)
    with stream:
        assert stream.read() == clip(2 if change == 'duration' else 3)


@pytest.mark.parametrize('omitted', ['editor_document', 'canvas_item'])
def test_publication_requires_captured_source_versions_for_every_actor(project, omitted):
    from pydantic import ValidationError
    store, pid, session = project
    _, _, versions, payload = prepared(project)
    before = store.snapshot(pid)
    with pytest.raises(ValidationError, match='expectedVersions missing current versions'):
        send(store, pid, 'timeline.publishRender', session=session,
             versions=[value for value in versions if value['objectType'] != omitted], **payload)
    assert store.snapshot(pid) == before


def test_atomic_text_save_and_publication_is_rejected_before_it_can_change_render_basis(project, tmp_path):
    from pydantic import ValidationError
    store, pid, session = project
    _, _, _, output, versions, payload = prepared_text(project, tmp_path)
    original = store.snapshot(pid).editorDocuments[0]
    changed = original.model_dump(mode='json'); changed['data']['overlays'][0]['text'] = 'B'
    before = store.snapshot(pid)
    with pytest.raises(ValidationError, match='union_tag_invalid'):
        send(store, pid, 'creation.batch', session=session, versions=versions, operations=[
            dict(type='timeline.publishRender', payload=payload),
            dict(type='editor.save', payload=dict(document=changed)),
        ])
    assert store.snapshot(pid) == before
    assert next(a for a in before.assets if a.id == output.id).provenance.source == 'upload'
