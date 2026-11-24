import asyncio
import base64
import shutil
from decimal import Decimal
from uuid import uuid4

import httpx
import pytest

from generation_helpers import cancel, command, policy, review
from opendirector.application.creation_generation import CreationGeneration
from opendirector.application.creation_spend import review_status
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.providers import GenerationProviders
from test_creation_canvas_service import project, send, ver
from test_creation_generation_service import anyio_backend
from test_creation_parameters import done, png

pytestmark = pytest.mark.cpu


@pytest.mark.anyio
@pytest.mark.parametrize('cancel_queued', [False, True])
async def test_restart_retains_queued_budget_until_execution_or_cancellation(project, cancel_queued):
    store, pid, session = project
    configs = ModelConfigs(store.local.repository)
    model = configs.save('image', 'http://fixture.invalid/v1', 'fixture', '', connection_type='self_hosted', auth_mode='none')
    configs.set_price(model['id'], dict(rate='0.40', unit='request', currency='USD'))
    runner = CreationGeneration(store, configs)
    entered, hold = asyncio.Event(), asyncio.Event()
    calls = []
    async def provider(request):
        calls.append(request.url.path)
        if len(calls) == 2:
            entered.set()
        await hold.wait()
        return httpx.Response(200, json={'data': [dict(b64_json=base64.b64encode(png((1024,1024))).decode())]})
    runner.provider = GenerationProviders(runner.store, transport=httpx.MockTransport(provider))
    restarted = None
    try:
        await runner.execute(policy(store, pid, cap='1.20'), session=session)
        draft = command(project, model, parameters=dict(size='1024x1024'))
        batch = draft.model_copy(update={'payload': draft.payload.model_copy(update={'count': 3})})
        receipt = await runner.execute(batch, session=session)
        assert receipt.status == 'accepted'
        async with asyncio.timeout(10):
            await entered.wait()
        queued = next(j for j in store.snapshot(pid).jobs if j.phase == 'queued')
        await runner.close()
        reopened = CreationProjects(LocalProjects(store.local.repository))
        snapshot = reopened.snapshot(pid)
        assert [c.state for c in snapshot.spendCalls].count('reserved') == 1
        assert review_status(snapshot)['held'] == Decimal('1.20')
        assert review_status(snapshot)['available'] == 0
        restarted = CreationGeneration(reopened, configs)
        restarted.provider = GenerationProviders(restarted.store, transport=httpx.MockTransport(provider))
        if cancel_queued:
            await cancel(restarted, pid, str(queued.id), session)
            await restarted.recover(str(pid), str(queued.id), explicit=True)
        hold.set()
        await restarted.start()
        await done(restarted)
        final = reopened.snapshot(pid)
        status = review_status(final)
        assert len(calls) == (2 if cancel_queued else 3)
        assert len(final.jobs) == len(final.spendCalls) == 3
        assert status['held'] == Decimal('0.80')  # Submitted calls still require provider reconciliation.
        assert status['settled'] == (0 if cancel_queued else Decimal('0.40'))
        assert status['available'] == (Decimal('0.40') if cancel_queued else 0)
        call = next(c for c in final.spendCalls if c.ownerId == queued.id)
        assert call.state == ('released' if cancel_queued else 'completed')
        if not cancel_queued:
            extra = command((reopened, pid, session), model)
            assert (await restarted.execute(extra, session=session)).status == 'awaiting_confirmation'
            assert len(calls) == 3
    finally:
        hold.set()
        await runner.close()
        if restarted:
            await restarted.close()


@pytest.mark.anyio
async def test_threshold_equality_unknown_cancellation_and_price_changes(project):
    store, pid, session = project
    configs = ModelConfigs(store.local.repository)
    model = configs.save('image', 'https://example.invalid/v1', 'fixture', 'key', protocol='openai')
    runner = CreationGeneration(store, configs)
    # This test observes durable admission only. Never dispatch to a model.
    async def no_dispatch(*args, **kwargs):
        pass
    runner.recover = no_dispatch
    try:
        await runner.execute(policy(store, pid, threshold='0.40'), session=session)
        draft = command(project, model)
        assert (await runner.execute(draft, session=session)).status == 'awaiting_confirmation'
        request = store.snapshot(pid).spendRequests[-1]
        assert (await runner.execute(review(pid, request), session=session)).status == 'rejected'
        assert (await runner.execute(review(pid, request, decision='cancel'), session=session)).status == 'applied'
        with pytest.raises(ProjectError) as repeated_review:
            await runner.execute(review(pid, request), session=session)
        assert repeated_review.value.code == 'spend_reviewed'
        assert not store.snapshot(pid).jobs and not store.snapshot(pid).spendCalls
        fresh = draft.model_copy(update={'commandId': uuid4()})
        await runner.execute(fresh, session=session)
        unknown = store.snapshot(pid).spendRequests[-1]
        await runner.execute(policy(store, pid, cap='1'), session=session)
        assert (await runner.execute(review(pid, unknown, acceptUnknown=True), session=session)).status == 'rejected'
        configs.set_price(model['id'], dict(unit='request', currency='USD', rate='0.40'))
        stale = await runner.execute(review(pid, unknown), session=session)
        assert stale.issues[0].code == 'spend_quote_changed'
        await runner.execute(policy(store, pid, threshold='0.40'), session=session)
        assert (await runner.execute(draft.model_copy(update={'commandId': uuid4()}), session=session)).status == 'accepted'
    finally:
        await runner.close()


@pytest.mark.anyio
async def test_changed_review_inputs_require_a_new_quote_but_still_allow_cancellation(project):
    store, pid, session = project
    configs = ModelConfigs(store.local.repository)
    model = configs.save('image', 'http://fixture.invalid/v1', 'fixture', '', connection_type='self_hosted', auth_mode='none')
    configs.set_price(model['id'], dict(rate='0.40', unit='request', currency='USD'))
    runner = CreationGeneration(store, configs)
    try:
        await runner.execute(policy(store, pid, cap='0'), session=session)
        first, second = command(project, model), command(project, model)
        for draft in (first, second):
            assert (await runner.execute(draft, session=session)).status == 'awaiting_confirmation'
        before = store.snapshot(pid)
        item = next(i for i in before.canvasItems if i.id == first.payload.originItemId)
        missing = before.model_copy(update={'canvasItems': tuple(i for i in before.canvasItems if i.id != item.id)})
        assert [p['reason'] for p in review_status(missing)['pending']] == ['stale_inputs', 'over_cap']
        edit = send(store, pid, 'canvas.update', session=session, versions=[ver('canvas_item', item)],
                    itemId=item.id, title='Revised shot')
        assert edit.status == 'applied'
        entries = review_status(store.snapshot(pid))['pending']
        assert [p['reason'] for p in entries] == ['stale_inputs', 'over_cap']
        assert entries[0]['suggestedCap'] is None and entries[1]['suggestedCap'] == Decimal('0.40')
        await runner.execute(policy(store, pid, currency='CNY', cap='0'), session=session)
        assert [p['reason'] for p in review_status(store.snapshot(pid))['pending']] == ['stale', 'stale']
        await runner.execute(policy(store, pid, currency='USD', cap='0'), session=session)
        request = entries[0]['request']
        cancel = parse_command(dict(type='spend.review', commandId=uuid4(), projectId=pid,
            expectedVersions=[ver('spend_request', request)],
            payload=dict(requestId=request.id, fingerprint=entries[0]['fingerprint'], decision='cancel')))
        assert (await runner.execute(cancel, session=session)).status == 'applied'
        final = store.snapshot(pid)
        assert [r.status for r in final.spendRequests] == ['cancelled', 'pending']
        assert not final.jobs and not final.spendCalls
    finally:
        await runner.close()


@pytest.mark.anyio
async def test_atomic_batch_approval_race_replay_and_cap_raise(project, tmp_path):
    store, pid, session = project
    configs = ModelConfigs(store.local.repository)
    model = configs.save('image', 'http://fixture.invalid/v1', 'fixture', '', connection_type='self_hosted', auth_mode='none')
    configs.set_price(model['id'], dict(rate='0.40', unit='request', currency='USD'))
    runner = CreationGeneration(store, configs)
    calls = []
    gate = asyncio.Event()
    async def provider(request):
        calls.append(request.url.path)
        await gate.wait()
        return httpx.Response(200, json={'data': [dict(b64_json=base64.b64encode(png((1024,1024))).decode())]})
    runner.provider = GenerationProviders(runner.store, transport=httpx.MockTransport(provider))
    try:
        await runner.execute(policy(store, pid, cap='2', threshold='1'), session=session)
        for _ in range(2):
            draft = command(project, model, parameters=dict(size='1024x1024'))
            batch = draft.model_copy(update={'payload': draft.payload.model_copy(update={'count': 3})})
            waiting = await runner.execute(batch, session=session)
            assert waiting.status == 'awaiting_confirmation' and not waiting.jobIds
        snap = store.snapshot(pid)
        assert not snap.jobs and not snap.spendCalls and not calls
        member = batch.model_copy(update={'commandId': uuid4(), 'payload': batch.payload.model_copy(update={'count': 1, 'batchId': batch.commandId})})
        assert (await runner.execute(member, session=session)).status == 'rejected'
        assert not calls and not store.snapshot(pid).jobs
        first, second = [review(pid, request) for request in snap.spendRequests]
        answers = await asyncio.gather(*(runner.execute(r, session=session) for r in (first, second)))
        assert sorted(r.status for r in answers) == ['accepted', 'rejected'], [r.issues for r in answers]
        winner = next(r for r in answers if r.status == 'accepted')
        repeated = await runner.execute(first if first.commandId == winner.commandId else second, session=session)
        assert repeated.jobIds == winner.jobIds and len(set(repeated.jobIds)) == 3
        status = review_status(store.snapshot(pid))
        assert status['held'] == Decimal('1.20') and status['available'] == Decimal('0.80')
        assert len(status['pending']) == 1 and status['pending'][0]['shortfall'] == Decimal('0.40')
        assert status['pending'][0]['suggestedCap'] == Decimal('2.40')
        assert 'settledBatch' not in status
        request = status['pending'][0]['request']
        too_low = await runner.execute(review(pid, request, project_record=store.snapshot(pid).project, newCap='2.1'), session=session)
        assert too_low.status == 'rejected' and store.snapshot(pid).project.spendPolicy.cap == 2
        raised = review(pid, request, project_record=store.snapshot(pid).project, newCap=status['pending'][0]['suggestedCap'])
        accepted = await runner.execute(raised, session=session)
        assert accepted.status == 'accepted' and len(accepted.jobIds) == 3
        assert (await runner.execute(raised, session=session)).jobIds == accepted.jobIds
        assert (await runner.execute(batch, session=session)) == waiting
        gate.set()
        await done(runner)
        reopened = CreationProjects(LocalProjects(store.local.repository)).snapshot(pid)
        assert len(calls) == len(reopened.jobs) == len(reopened.spendCalls) == 6
        assert reopened.project.spendPolicy.cap == Decimal('2.4')
        assert review_status(reopened)['held'] == 0
        assert review_status(reopened)['settled'] == Decimal('2.40')
        assert 'settledBatch' not in review_status(reopened)
        item = reopened.canvasItems[0]
        changed = send(store, pid, 'canvas.update', session=session, versions=[ver('canvas_item', item)],
                       itemId=item.id, title='Archive check')
        assert changed.status == 'applied'
        item = next(i for i in store.snapshot(pid).canvasItems if i.id == item.id)
        assert send(store, pid, 'history.undo', session=session, versions=[ver('canvas_item', item)],
                    targetCommandId=changed.commandId).status == 'applied'
        assert store.snapshot(pid).spendCalls == reopened.spendCalls
        # A complete project backup retains its identity and historical amounts.
        archive = CreationProjects(LocalProjects(tmp_path / 'restored'))
        original_dir = runner.directory(pid)
        archive.root.mkdir(parents=True, exist_ok=True)
        shutil.copytree(original_dir, archive.root / original_dir.name)
        assert archive.snapshot(pid).spendCalls == reopened.spendCalls
        shutil.copytree(original_dir, archive.root / (original_dir.name + ' copy'))
        assert not archive.list_projects()['projects']
    finally:
        gate.set()
        await runner.close()
