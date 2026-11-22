import asyncio
import base64
from decimal import Decimal
from uuid import uuid4

import httpx
import pytest

from generation_helpers import command
from opendirector.application.creation_generation import CreationGeneration
from opendirector.application.creation_spend import review_status
from opendirector.domain.creation.commands import parse_command
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.providers import GenerationProviders
from test_creation_canvas_service import project, ver
from test_creation_generation_service import anyio_backend
from test_creation_parameters import done, png


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


def policy(store, pid, **values):
    return parse_command(dict(type='spend.policy', commandId=uuid4(), projectId=pid,
        expectedVersions=[ver('project', store.snapshot(pid).project)], payload=values))


def review(pid, request, *, project_record=None, **values):
    return parse_command(dict(type='spend.review', commandId=uuid4(), projectId=pid,
        expectedVersions=[*request.versions, ver('spend_request', request), *([ver('project', project_record)] if project_record else [])],
        payload=dict(requestId=request.id, fingerprint=request.quote.fingerprint(), decision='approve') | values))


@pytest.mark.anyio
async def test_atomic_batch_approval_race_replay_and_cap_raise(project):
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
        first, second = [review(pid, request) for request in snap.spendRequests]
        answers = await asyncio.gather(*(runner.execute(r, session=session) for r in (first, second)))
        assert sorted(r.status for r in answers) == ['accepted', 'rejected'], [r.issues for r in answers]
        winner = next(r for r in answers if r.status == 'accepted')
        repeated = await runner.execute(first if first.commandId == winner.commandId else second, session=session)
        assert repeated.jobIds == winner.jobIds and len(set(repeated.jobIds)) == 3
        status = review_status(store.snapshot(pid))
        assert status['held'] == Decimal('1.20') and status['available'] == Decimal('0.80')
        assert len(status['pending']) == 1 and status['pending'][0]['shortfall'] == Decimal('0.40')
        request = status['pending'][0]['request']
        too_low = await runner.execute(review(pid, request, project_record=store.snapshot(pid).project, newCap='2.1'), session=session)
        assert too_low.status == 'rejected' and store.snapshot(pid).project.spendPolicy.cap == 2
        raised = review(pid, request, project_record=store.snapshot(pid).project, newCap='2.4')
        accepted = await runner.execute(raised, session=session)
        assert accepted.status == 'accepted' and len(accepted.jobIds) == 3
        assert (await runner.execute(raised, session=session)).jobIds == accepted.jobIds
        assert (await runner.execute(batch, session=session)) == waiting
        gate.set()
        await done(runner)
        reopened = CreationProjects(LocalProjects(store.local.repository)).snapshot(pid)
        assert len(calls) == len(reopened.jobs) == len(reopened.spendCalls) == 6
        assert reopened.project.spendPolicy.cap == Decimal('2.4')
    finally:
        gate.set()
        await runner.close()
