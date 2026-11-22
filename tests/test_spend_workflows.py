import asyncio
import base64
import json
from decimal import Decimal
from uuid import UUID, uuid4

import httpx
import pytest

from generation_helpers import command, policy, review
from opendirector.agent.tools import AgentTools
from opendirector.application.creation_canvas import CreationCanvas
from opendirector.application.creation_generation import CreationGeneration
from opendirector.application.creation_spend import review_status
from opendirector.application.creation_tool_assets import CreationToolAssets
from opendirector.application.tool_spend import tool_quote
from opendirector.application.tool_tasks import ToolTasks
from opendirector.domain.creation.commands import GroupQuoteQuery, SpendStatusQuery, parse_command
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.providers import GenerationProviders
from test_creation_canvas_service import project, send, ver
from test_creation_generation_service import anyio_backend
from test_creation_parameters import done, png
from test_tool_tasks import SAM3, ZIMAGE, configure, images_server, segmentation_server, upload


@pytest.mark.anyio
@pytest.mark.parametrize('dependent', [True, False])
async def test_workflow_prices_the_whole_ready_set_and_keeps_completed_upstream(project, dependent):
    store, pid, session = project
    configs = ModelConfigs(store.local.repository)
    config = configs.save('image', 'http://fixture.invalid/v1', 'fixture', '', connection_type='self_hosted', auth_mode='none')
    configs.set_price(config['id'], dict(unit='request', rate='0.40', currency='USD'))
    runner = CreationGeneration(store, configs)
    posts = []
    def provider(request):
        posts.append(request)
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(png((1024, 1024))).decode()}]})
    runner.provider = GenerationProviders(runner.store, transport=httpx.MockTransport(provider))
    try:
        await runner.execute(policy(store, pid, cap='2', threshold='0.60'), session=session)
        first, second = [command(project, config, prompt=p, parameters={'size': '1024x1024'}) for p in ('first', 'second')]
        a, b = first.payload, second.payload
        if dependent:
            configs.set_price(config['id'], dict(unit='request', rate='0', currency='USD'))
            await runner.execute(first, session=session)
            await done(runner)
            posts.clear()
            configs.set_price(config['id'], dict(unit='request', rate='0.40', currency='USD'))
            before = store.snapshot(pid)
            added = send(store, pid, 'reference.add', session=session, versions=[
                ver('generation_spec', next(s for s in before.generationSpecs if s.id == b.specId)),
                ver('canvas_item', next(i for i in before.canvasItems if i.id == b.originItemId))],
                reference=dict(id=uuid4(), projectId=pid, targetSpecId=b.specId, binding='follow_current',
                               source=dict(id=a.originItemId), role='reference'))
            assert added.status == 'applied', added
        before = store.snapshot(pid)
        group = parse_command(dict(type='generation.group', projectId=pid, commandId=uuid4(),
            expectedVersions=[ver('generation_spec', s) for s in before.generationSpecs] + [ver('canvas_item', i) for i in before.canvasItems],
            payload=dict(members=[dict(itemId=a.originItemId, specId=a.specId),
                                  dict(itemId=b.originItemId, specId=b.specId, after=[a.originItemId] if dependent else [])])))
        query = GroupQuoteQuery(type='generation.groupQuote', queryId=uuid4(), projectId=pid, workflow=group.payload)
        preview = await CreationCanvas(store, runner).query(query)
        assert float(preview['amount']) == (.40 if dependent else .80)
        assert preview['quote'].get('deferred', []) == ([str(b.originItemId)] if dependent else [])
        assert not posts and store.snapshot(pid) == before
        response = await runner.execute(group, session=session)
        assert response.status == 'awaiting_confirmation' and not posts and store.snapshot(pid).jobs == before.jobs, response
        waiting = store.snapshot(pid).spendRequests[-1]
        assert review_status(store.snapshot(pid))['workflows'][0]['state'] == 'waiting'
        assert waiting.quote.total('USD') == (Decimal('.4') if dependent else Decimal('.8'))
        assert preview['fingerprint'] == waiting.quote.fingerprint()
        item = next(i for i in before.canvasItems if i.id == b.originItemId)
        spec = next(s for s in before.generationSpecs if s.id == b.specId)
        separate = parse_command(dict(type='generation.submit', commandId=uuid4(), projectId=pid,
            expectedVersions=[ver('generation_spec', spec), ver('canvas_item', item)],
            payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=item.id)))
        blocked = await runner.execute(separate, session=session)
        assert blocked.issues[0].code == 'spend_quote_changed' and not posts
        accepted = await runner.execute(review(pid, waiting), session=session)
        assert len(accepted.jobIds) == (1 if dependent else 2), accepted
        await done(runner)
        await asyncio.gather(*list(runner.group_workers.values()))
        if dependent:
            before = store.snapshot(pid)
            assert len(posts) == 1 and before.jobs[-1].adopted
            downstream = before.spendRequests[-1]
            assert downstream.groupItems == (b.originItemId,) and downstream.status == 'pending'
            await runner.close()
            runner = CreationGeneration(store, configs)
            runner.provider = GenerationProviders(runner.store, transport=httpx.MockTransport(provider))
            await runner.start()
            approved = await runner.execute(review(pid, downstream), session=session)
            assert len(approved.jobIds) == 1, approved
            await done(runner)
            assert posts[1].url.path.endswith('/edits')
        final = store.snapshot(pid)
        members = [j for j in final.jobs if j.batchId == group.commandId]
        status = review_status(final)['workflows']
        assert len(status) == 1 and status[0]['completed'] == 2 and status[0]['state'] == 'completed'
        assert len(posts) == len(members) == len([c for c in final.spendCalls if c.ownerId in {j.id for j in members}]) == 2
        assert review_status(final)['settled'] == Decimal('.80')
    finally:
        await runner.close()


@pytest.mark.anyio
async def test_no_budget_runs_independent_group_members_even_when_other_members_form_a_cycle(project):
    store, pid, session = project
    configs = ModelConfigs(store.local.repository)
    config = configs.save('image', 'http://fixture.invalid/v1', 'fixture', '', connection_type='self_hosted', auth_mode='none')
    posts = []
    runner = CreationGeneration(store, configs)
    def provider(request):
        posts.append(request)
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(png((1024,1024))).decode()}]})
    runner.provider = GenerationProviders(runner.store, transport=httpx.MockTransport(provider))
    try:
        items = [command(project, config, parameters={'size': '1024x1024'}).payload for _ in range(3)]
        snapshot = store.snapshot(pid)
        deps = [[], [items[2].originItemId], [items[1].originItemId]]
        plan = parse_command(dict(type='generation.group', commandId=uuid4(), projectId=pid,
            expectedVersions=[ver('generation_spec', s) for s in snapshot.generationSpecs] + [ver('canvas_item', i) for i in snapshot.canvasItems],
            payload=dict(members=[dict(specId=m.specId, itemId=m.originItemId, after=after) for m, after in zip(items, deps)])))
        reply = await runner.execute(plan, session=session)
        assert len(reply.jobIds) == 1, reply
        await done(runner)
        run = review_status(store.snapshot(pid))['workflows'][0]
        assert len(posts) == run['completed'] == 1 and run['skipped'] == 2 and run['state'] == 'incomplete'
    finally:
        await runner.close()


@pytest.mark.anyio
async def test_agent_receives_price_and_human_approval_resumes_its_original_action(project):
    store, pid, session = project
    configs = ModelConfigs(store.local.repository)
    model = configs.save('image', 'http://fixture.invalid/v1', 'fixture', '', connection_type='self_hosted', auth_mode='none')
    configs.set_price(model['id'], dict(unit='request', rate='0.40', currency='USD'))
    runner = CreationGeneration(store, configs)
    async def no_dispatch(*args, **kwargs):
        pass
    runner.recover = no_dispatch
    agent, turn = AgentTools(store, runner, configs), uuid4()
    await runner.execute(policy(store, pid, threshold='1'), session=session)
    spec = command(project, model, parameters={'size': '1024x1024'})
    args = dict(type='generation.submit', payload={**spec.payload.model_dump(mode='json'), 'count': 3},
                expectedVersions=[v.model_dump(mode='json') for v in spec.expectedVersions])
    async def tool(name, values, key):
        return await agent.execute(pid, turn, session, key, name, values, [], None)
    quote = await tool('query', dict(type='generation.quote', specId=str(spec.payload.specId), count=3), 'quote')
    pending = await tool('execute_command', args, 'generate')
    assert Decimal(quote['amount']) == Decimal(pending['spend']['review']['amount']) == Decimal('1.20')
    decision = review(pid, store.snapshot(pid).spendRequests[-1])
    with pytest.raises(ProjectError):
        await tool('execute_command', dict(type='spend.review', payload=decision.payload.model_dump(mode='json')), 'approve')
    assert not store.snapshot(pid).jobs
    allowed = await runner.execute(decision, session=session)
    assert len(allowed.jobIds) == 3
    assert all(j.agentRunId == turn and j.agentCallId == 'generate' for j in store.snapshot(pid).jobs)
    assert Decimal((await tool('query', {'type':'spend.status'}, 'status'))['held']) == Decimal('1.20')
    await runner.close()


def test_a_translation_request_does_not_receive_the_tool_source_video():
    data = dict(unit='input_second', rate='.02', currency='USD')
    def priced(name):
        return dict(id=str(uuid4()), modelId=name, price=data)
    asset = str(uuid4())
    task = dict(id=str(uuid4()), tool='video-matting', sourceAssetIds=[asset], parameters={'prompt': '帆船'},
                modelSnapshots={'video.matting': priced('tracking'), 'text.chat': priced('translation')})
    quote = tool_quote(task, {asset: dict(fingerprint='0' * 64, durationMs=20000)})
    assert [(line.operation, line.amount) for line in quote.lines] == [('video.matting', Decimal('.40')), ('text.chat', None)]
    assert quote.total('USD') is None


@pytest.mark.anyio
async def test_selection_review_reuses_masks_and_accounts_physical_calls(project):
    store, pid, session = project
    configs = configure(store, SAM3)
    model = configs.list()[0]
    configs.set_price(model['id'], dict(unit='request', rate='.40', currency='USD'))
    asset = upload(store, str(pid), session, 'source.png', png())
    requests = []
    service = ToolTasks(store.local, configs, CreationToolAssets(store), projects=store,
        transport=httpx.MockTransport(segmentation_server(requests, {'person':[(.9, (0, 0, 12, 16))]})))
    runner = CreationGeneration(store, configs)
    runner.tools = service
    try:
        await runner.execute(policy(store, pid, threshold='.50'), session=session)
        value = dict(id=str(uuid4()), sourceAssetId=asset, prompt='person, animal')
        answer = await service.selection_preview(str(pid), value, session)
        assert answer['status'] == 'awaiting_confirmation' and not requests and not store.snapshot(pid).spendCalls
        waiting = store.snapshot(pid).spendRequests[-1]
        assert waiting.quote.total('USD') == Decimal('.80')
        await runner.execute(review(pid, waiting), session=session)
        result = await service.selection_preview(str(pid), value, session)
        assert result['instances'] and len(requests) == 2 and not service.list(str(pid))
        assert review_status(store.snapshot(pid))['settled'] == Decimal('.80')
    finally:
        await service.close()
        await runner.close()


@pytest.mark.anyio
async def test_four_edit_calls_survive_a_crash_between_admission_and_task_publication(project, monkeypatch):
    store, pid, session = project
    configs = configure(store, ZIMAGE)
    configs.set_price(configs.list()[0]['id'], dict(unit='request', rate='.40', currency='USD'))
    source = upload(store, str(pid), session, 'source.png', png())
    posts = []
    make = lambda: ToolTasks(store.local, configs, CreationToolAssets(store), projects=store, transport=httpx.MockTransport(images_server(posts)))
    old, runner = make(), CreationGeneration(store, configs)
    runner.tools = old
    value = dict(id=str(uuid4()), tool='image-presets', sourceAssetIds=[source], parameters={'preset':'storyboard'})
    try:
        await runner.execute(policy(store, pid, threshold='1'), session=session)
        before = store.snapshot(pid)
        assert old.quote(str(pid), value, session)['amount'] == Decimal('1.60')
        assert store.snapshot(pid) == before and not old.list(str(pid))
        waiting = await old.submit(str(pid), value, session)
        assert waiting['status'] == 'awaiting_confirmation' and not posts and not store.snapshot(pid).spendCalls
        def interrupted(*args):
            raise OSError('injected worker interruption')
        monkeypatch.setattr(old, '_write', interrupted)
        decision = review(pid, store.snapshot(pid).spendRequests[-1])
        with pytest.raises(OSError, match='interruption'):
            await runner.execute(decision, session=session)
        assert review_status(store.snapshot(pid))['held'] == Decimal('1.60') and not old.list(str(pid)) and not posts
    finally:
        await old.close()
        await runner.close()
    restored = make()
    try:
        await restored.start()
        await asyncio.gather(*list(restored.jobs.values()))
        task = restored.get(str(pid), value['id'])
        assert len(task['outputs']) == len(posts) == len(task['modelCalls']) == 4
        assert {c['spendCallId'] for c in task['modelCalls']} == {str(c.id) for c in store.snapshot(pid).spendCalls}
        assert review_status(store.snapshot(pid))['settled'] == Decimal('1.60')
        # A task written by an older release can have provider call records without a paid rate.
        legacy = dict(task, id=str(uuid4()), modelCalls=[{'id': 'old-physical-call'}])
        restored._write(restored._directory(str(pid)), legacy)
        runner.tools = restored
        status = await CreationCanvas(store, runner).query(SpendStatusQuery(type='spend.status', queryId=uuid4(), projectId=pid))
        assert status['legacy'] == 1 and Decimal(status['settled']) == Decimal('1.60')
    finally:
        await restored.close()
