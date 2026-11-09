"""Real saved draft/mask -> fixed task input -> atomic publication and reopening."""
import asyncio
from dataclasses import replace
from io import BytesIO
from uuid import UUID, uuid4

from PIL import Image
import pytest

from opendirector.application.creation_canvas import asset_ref
from opendirector.application.creation_history import CreationHistory
from opendirector.application.creation_tool_assets import CreationToolAssets
from opendirector.application.tool_operations import TOOLS, Output
from opendirector.application.tool_tasks import ToolTasks
from opendirector.domain.creation.canvas import media_card_size
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from test_creation_canvas_service import project, send, ver


def png(color='blue', size=(64, 48)):
    out = BytesIO()
    Image.new('RGBA', size, color).save(out, 'PNG')
    return out.getvalue()


def test_media_card_size_matches_pixels_and_compacts_audio():
    assert media_card_size('video', 1080, 1920, 300, 520) == (293, 520)
    assert media_card_size('video', 1920, 1080, 300, 520) == (520, 293)
    assert media_card_size('audio', 1080, 1920, 300, 520) == (300, 112)


def test_result_titles_stay_named_after_their_preset_without_collisions():
    from types import SimpleNamespace

    from opendirector.application.creation_tool_drafts import result_title

    def snapshot(*titles):
        return SimpleNamespace(canvasItems=[SimpleNamespace(id=uuid4(), title=title, visible=True)
                                            for title in titles])

    assert result_title(snapshot(), '面部三视图') == '面部三视图'
    assert result_title(snapshot('面部三视图'), '面部三视图') == '面部三视图 2'
    assert result_title(snapshot('面部三视图', '面部三视图 2'), '面部三视图') == '面部三视图 3'
    # The empty placeholder that is about to receive the result is not a conflict.
    placeholder = snapshot('面部三视图')
    assert result_title(placeholder, '面部三视图', exclude=placeholder.canvasItems[0].id) == '面部三视图'
    # A later run of a numbered preset continues the same series.
    assert result_title(snapshot('连续分镜图 1', '连续分镜图 2'), '连续分镜图 1') == '连续分镜图 3'
    # Outputs of one run are numbered in publication order.
    assert result_title(snapshot(), '连续分镜图 1', ['连续分镜图 1']) == '连续分镜图 2'
    # Unrelated names keep their own family.
    assert result_title(snapshot('超清 4K'), '超清 4K') == '超清 4K 2'


@pytest.mark.parametrize('suffix', ['²', '①', '٢', '２'])
def test_result_titles_treat_unicode_digit_suffixes_as_ordinary_text(suffix):
    from types import SimpleNamespace
    from opendirector.application.creation_tool_drafts import result_title

    title = f'Area m {suffix}'
    snapshot = SimpleNamespace(canvasItems=[
        SimpleNamespace(id=uuid4(), title=name, visible=True)
        for name in ['Preset', f'Preset {suffix}', title]
    ])
    assert result_title(snapshot, 'Preset') == 'Preset 2'
    assert result_title(snapshot, title) == f'{title} 2'


@pytest.fixture
def prepared(project, monkeypatch):
    store, pid, session = project
    assets = CreationToolAssets(store)
    def imported(name, data):
        record = assets.import_file(pid, uuid4(), name, data, session)
        return assets.assets.get(pid, record['id'])
    source, mask = imported('source.png', png()), imported('mask.png', png('white'))
    owner_id, target_id, editor_id, target_spec_id = uuid4(), uuid4(), uuid4(), uuid4()
    document = dict(id=editor_id, projectId=pid, kind='media_edit', data=dict(tool='outpaint',
        sourceItems=[owner_id], sources=[asset_ref(source)], parameters={'prompt': 'original'},
        selection=dict(source=asset_ref(source), width=64, height=48, mask=asset_ref(mask), boxes=[dict(x=2, y=3, width=10, height=12)])))
    assert send(store, pid, 'creation.batch', session=session, operations=[
        dict(type='canvas.show', payload=dict(item=dict(id=owner_id, projectId=pid, kind='image', binding=dict(role='material', objectRef=asset_ref(source))))),
        dict(type='generationSpec.create', payload=dict(spec=dict(id=target_spec_id, projectId=pid, kind='image', purpose='draft'))),
        dict(type='canvas.show', payload=dict(item=dict(id=target_id, projectId=pid, kind='image', title='Pending', binding=dict(role='empty', draftSpec=dict(id=target_spec_id))))),
        dict(type='editor.create', payload=dict(document=document)),
        dict(type='canvas.attachEditor', payload=dict(itemId=owner_id, editorId=editor_id)),
    ]).status == 'applied'
    snapshot = store.snapshot(pid)
    owner, target = snapshot.canvasItems
    editor = snapshot.editorDocuments[0]
    value = dict(id=str(uuid4()), tool='outpaint', sourceAssetIds=[str(source.id)], maskAssetId=str(mask.id),
        parameters=dict(editor.data.parameters), boxes=[box.model_dump() for box in editor.data.selection.boxes],
        draft=dict(editorId=str(editor.id), editorRevision=editor.revision, itemId=str(owner.id), itemRevision=owner.revision),
        canvas=dict(nodeId=str(owner.id), sourceNodeIds=[str(owner.id)], targetNodeId=str(target.id), targetKind='image', targetTitle='Pending'))
    seen = []
    async def recipe(context):
        seen.append((context.sources[0].data, context.mask, dict(context.parameters)))
        return [Output('image', png('purple'), 'png', 'Edited result')]
    monkeypatch.setitem(TOOLS, 'outpaint', replace(TOOLS['outpaint'], requires=lambda _: (), recipe=recipe))
    service = ToolTasks(store.local, ModelConfigs(store.local.repository), assets, projects=store)
    return store, pid, session, service, value, source, mask, seen


def test_draft_snapshot_publication_replay_reopen_and_dependency_protection(prepared):
    store, pid, session, service, value, source, mask, seen = prepared
    async def run():
        try:
            await service.submit(str(pid), value, session)
            await asyncio.gather(*service.jobs.values())
            task = service.get(str(pid), value['id'])
            assert task['status'] == 'succeeded', task.get('error')
            assert seen == [(png(), png('white'), {'prompt': 'original'})]
            assert task['draftSnapshot']['data']['selection']['mask']['assetId'] == str(mask.id)
            before = store.snapshot(pid)
            draft = before.editorDocuments[0]
            updated = draft.model_copy(update={'data': draft.data.model_copy(update={'parameters': {'prompt': 'next intent'}})})
            assert send(store, pid, 'editor.save', session=session, versions=[ver('editor_document', draft)], document=updated).status == 'applied'
            assert service.get(str(pid), value['id'])['draftSnapshot']['data']['parameters']['prompt'] == 'original'
            result = service.placement(str(pid), value['id'], 'placed', session)
            assert result['placement'] == 'placed'
            saved = store.snapshot(pid)
            output = next(a for a in saved.assets if str(a.id) == task['outputs'][0]['id'])
            assert output.provenance.source == 'edited'
            assert output.provenance.toolTaskId == UUID(value['id'])
            assert output.provenance.sourceItemId == UUID(value['canvas']['nodeId'])
            assert output.provenance.editorRevision == draft.revision
            assert {r.assetId for r in output.provenance.sources} == {source.id, mask.id}
            target = next(i for i in saved.canvasItems if str(i.id) == value['canvas']['targetNodeId'])
            assert target.binding.objectRef.assetId == output.id
            assert target.width / target.height == pytest.approx(64 / 48)
            assert max(target.width, target.height) == pytest.approx(352)
            continuation = next(d for d in saved.editorDocuments if d.id == target.editors[0].id)
            assert continuation.data.sources[0].assetId == output.id
            assert continuation.data.selection is None
            assert saved.jobs == ()
            assert saved.references == ()  # tool provenance is not generation reference
            assert service.placement(str(pid), value['id'], 'placed', session) == result
            assert store.snapshot(pid) == saved
            replay = await service.submit(str(pid), value, session)
            assert replay['outputs'] == task['outputs'] and len(seen) == 1
            reopened = CreationProjects(LocalProjects(store.local.repository))
            assert reopened.snapshot(pid) == saved
            usage = CreationHistory(store).usage(saved, mask.id, include_history=False)
            assert any(reason['type'] == 'tool_task' for reason in usage['reasons'])
        finally:
            await service.close()
    asyncio.run(run())


@pytest.mark.parametrize('change', ['revision', 'parameters', 'source', 'mask', 'locked'])
def test_stale_or_forged_draft_cannot_accept_task(prepared, change):
    store, pid, session, service, value, _, _, seen = prepared
    if change == 'revision': value['draft']['editorRevision'] += 1
    if change == 'parameters': value['parameters'] = {'prompt': 'not saved'}
    if change == 'source': value['canvas']['sourceNodeIds'] = [str(uuid4())]
    if change == 'mask': value['maskAssetId'] = value['sourceAssetIds'][0]
    if change == 'locked':
        owner = store.snapshot(pid).canvasItems[0]
        assert send(store, pid, 'canvas.update', session=session, versions=[ver('canvas_item', owner)], itemId=owner.id, locked=True).status == 'applied'
    with pytest.raises(ProjectError): service._prepare(str(pid), value, session)
    assert service.list(str(pid)) == [] and seen == []


@pytest.mark.parametrize('title_collision', [False, True])
def test_source_change_keeps_candidate_then_explicit_adoption_is_independent(prepared, title_collision):
    store, pid, session, service, value, source, _, _ = prepared
    async def run():
        try:
            await service.submit(str(pid), value, session)
            await asyncio.gather(*service.jobs.values())
            replacement = service.assets.import_file(pid, uuid4(), 'new.png', png('red'), session)
            asset = service.assets.assets.get(pid, replacement['id'])
            owner = store.snapshot(pid).canvasItems[0]
            assert send(store, pid, 'canvas.materialize', session=session, versions=[ver('canvas_item', owner)], itemId=owner.id, asset=asset_ref(asset)).status == 'applied'
            assert service.placement(str(pid), value['id'], 'placed', session)['placement'] == 'unplaced'
            current = store.snapshot(pid)
            target = current.canvasItems[1]
            assert not target.visible
            if title_collision:
                owner = current.canvasItems[0]
                assert send(store, pid, 'canvas.update', session=session, versions=[ver('canvas_item', owner)],
                            itemId=owner.id, title=target.title).status == 'applied'
            adopted = service.placement(str(pid), value['id'], 'placed', session, policy='explicit')
            assert adopted['placement'] == 'placed'
            current = store.snapshot(pid)
            assert current.canvasItems[0].binding.objectRef.assetId == asset.id
            assert current.canvasItems[1].visible
            assert current.canvasItems[1].binding.objectRef.assetId != source.id
            assert current.canvasItems[1].title == ('Pending 2' if title_collision else 'Pending')
            assert service.placement(str(pid), value['id'], 'placed', session, policy='explicit') == adopted
            assert store.snapshot(pid) == current
        finally: await service.close()
    asyncio.run(run())


def test_publication_recovers_after_project_commit_before_ledger_ack(prepared, monkeypatch):
    store, pid, session, service, value, _, _, _ = prepared
    async def run():
        await service.submit(str(pid), value, session)
        await asyncio.gather(*service.jobs.values())
        write = service._write
        monkeypatch.setattr(service, '_write', lambda *args: (_ for _ in ()).throw(OSError('ack lost')))
        with pytest.raises(OSError): service.placement(str(pid), value['id'], 'placed', session)
        committed = store.snapshot(pid)
        monkeypatch.setattr(service, '_write', write)
        assert service.placement(str(pid), value['id'], 'placed', session)['placement'] == 'placed'
        assert store.snapshot(pid) == committed
        await service.close()
    asyncio.run(run())


@pytest.mark.parametrize('change', ['target-edit', 'target-lock', 'target-prompt', 'source-hide'])
def test_explicit_publication_preserves_user_changes_and_replays(prepared, monkeypatch, change):
    store, pid, session, service, value, _, _, _ = prepared
    async def run():
        try:
            await service.submit(str(pid), value, session)
            await asyncio.gather(*service.jobs.values())
            snapshot = store.snapshot(pid)
            item = snapshot.canvasItems[0 if change == 'source-hide' else 1]
            if change == 'target-prompt':
                spec = snapshot.generationSpecs[0]
                receipt = send(store, pid, 'generationSpec.setPrompt', session=session, versions=[ver('generation_spec', spec)], specId=spec.id, prompt='Keep my prompt')
            elif change == 'source-hide':
                receipt = send(store, pid, 'canvas.hide', session=session, versions=[ver('canvas_item', item)], itemId=item.id)
            else:
                receipt = send(store, pid, 'canvas.update', session=session, versions=[ver('canvas_item', item)], itemId=item.id,
                               **({'locked': True} if change == 'target-lock' else {'title': 'My manual edit'}))
            assert receipt.status == 'applied'
            assert service.placement(str(pid), value['id'], 'placed', session)['placement'] == 'unplaced'
            preserved = next(i for i in store.snapshot(pid).canvasItems if i.id == item.id)
            # Project commit succeeds, ledger acknowledgement is lost.
            write = service._write
            monkeypatch.setattr(service, '_write', lambda *args: (_ for _ in ()).throw(OSError('ack lost')))
            with pytest.raises(OSError): service.placement(str(pid), value['id'], 'placed', session, policy='explicit')
            committed = store.snapshot(pid)
            monkeypatch.setattr(service, '_write', write)
            result = service.placement(str(pid), value['id'], 'placed', session, policy='explicit')
            assert result['placement'] == 'placed'
            assert store.snapshot(pid) == committed
            assert next(i for i in committed.canvasItems if i.id == item.id) == preserved
            output_id = result['outputs'][0]['canvasItemId']
            assert next(i for i in committed.canvasItems if str(i.id) == output_id).visible
            assert service.placement(str(pid), value['id'], 'placed', session, policy='explicit') == result
            assert store.snapshot(pid) == committed
        finally: await service.close()
    asyncio.run(run())


def test_wrong_actual_mask_dimensions_are_rejected_without_acceptance(prepared):
    store, pid, session, service, value, _, _, _ = prepared
    wrong = service.assets.import_file(pid, uuid4(), 'small.png', png('white', (32, 24)), session)
    value.pop('draft')  # Direct API callers receive the same media validation.
    value['maskAssetId'] = wrong['id']
    with pytest.raises(ProjectError, match='尺寸'):
        service._prepare(str(pid), value, session)
    assert service.list(str(pid)) == []


@pytest.mark.parametrize('changed', [False, True])
def test_accepted_model_selection_is_fixed_and_reconfiguration_cannot_redirect_call(prepared, monkeypatch, changed):
    from opendirector.domain.capabilities import MediaResult
    from opendirector.integrations.model_adapters import OpenAIImages
    store, pid, session, service, value, _, _, _ = prepared
    selected = service.configs.save('image', 'http://fixture.invalid/v1', 'Qwen/Qwen-Image-2.1', '', connection_type='self_hosted', protocol='openai')
    calls = []
    async def image(self, config, request):
        calls.append(config['id'])
        return MediaResult(png('purple'), 'png')
    monkeypatch.setattr(OpenAIImages, 'image', image)
    async def recipe(context):
        result = await context.edit(Image.open(BytesIO(context.sources[0].data)), 'original', .5)
        data = BytesIO()
        result.save(data, 'PNG')
        return [Output('image', data.getvalue(), 'png', 'Edited')]
    monkeypatch.setitem(TOOLS, 'outpaint', replace(TOOLS['outpaint'], requires=lambda _: ('image.edit',), recipe=recipe))
    async def run():
        service.limit = asyncio.Semaphore(0)
        try:
            task = await service.submit(str(pid), value, session)
            assert task['modelConfigIds']['image.edit'] == selected['id']
            assert 'apiKey' not in task['modelSnapshots']['image.edit']
            service.configs.save('image', 'http://another.invalid/v1', 'Qwen/Qwen-Image-2.1', '',
                                config_id=selected['id'] if changed else None, connection_type='self_hosted', protocol='openai')
            service.limit.release()
            await asyncio.gather(*service.jobs.values())
            final = service.get(str(pid), value['id'])
            assert final['status'] == ('failed' if changed else 'succeeded'), final.get('error')
            assert calls == ([] if changed else [selected['id']])
            if changed: assert '模型配置已变化' in final['error']
        finally: await service.close()
    asyncio.run(run())

@pytest.mark.parametrize('edit',['none','move','prompt','lock','upload','hide'])
def test_unsuccessful_tool_keeps_its_target_and_preserves_user_edits(prepared,edit):
    store,pid,session,service,value,source,mask,seen=prepared
    task,_,_=service._prepare(str(pid),value,session)
    snapshot=store.snapshot(pid)
    target=snapshot.canvasItems[1]
    versions=[ver('canvas_item',target)]
    if edit=='move':assert send(store,pid,'canvas.move',session=session,versions=versions,items=[dict(itemId=target.id,position=dict(x=123,y=45))]).status=='applied'
    elif edit=='prompt':
        spec=snapshot.generationSpecs[0]
        assert send(store,pid,'generationSpec.setPrompt',session=session,versions=[ver('generation_spec',spec)],specId=spec.id,prompt='Keep me').status=='applied'
    elif edit=='lock':assert send(store,pid,'canvas.update',session=session,versions=versions,itemId=target.id,locked=True).status=='applied'
    elif edit=='upload':assert send(store,pid,'canvas.materialize',session=session,versions=versions,itemId=target.id,asset=asset_ref(source)).status=='applied'
    elif edit=='hide':assert send(store,pid,'canvas.hide',session=session,versions=versions,itemId=target.id).status=='applied'
    task.update(status='cancelled')
    service._write(service._directory(str(pid)),task)
    settled=service._settle_terminal(str(pid),task['id'],session)
    assert settled['placement']=='unplaced'
    after=store.snapshot(pid)
    actual=next(i for i in after.canvasItems if i.id==target.id)
    assert actual.visible==(edit!='hide')
    assert service._settle_terminal(str(pid),task['id'],session)==settled
    assert store.snapshot(pid)==after

@pytest.mark.parametrize('status',['failed','cancelled','interrupted'])
def test_unsuccessful_tool_recovers_ledger_ack_without_hiding_target(prepared,monkeypatch,status):
    store,pid,session,service,value,*_=prepared
    task,directory,_=service._prepare(str(pid),value,session)
    task.update(status=status)
    service._write(directory,task)
    original=service._write
    def fail(*args):raise OSError('lost ledger ack')
    monkeypatch.setattr(service,'_write',fail)
    with pytest.raises(OSError,match='lost ledger ack'):
        service._settle_terminal(str(pid),task['id'],session)
    committed=store.snapshot(pid)
    assert committed.canvasItems[1].visible
    monkeypatch.setattr(service,'_write',original)
    # Reads expose the pending acknowledgement without repairing it.
    assert service.get(str(pid),task['id'],session)['placement']=='pending'
    asyncio.run(service.recover())
    recovered=service.get(str(pid),task['id'],session)
    assert recovered['placement']=='unplaced'
    assert recovered['status']==status
    assert store.snapshot(pid)==committed
