"""Price runnable workflow members together and continue from their adopted outputs."""
import asyncio
import logging
from datetime import datetime, timezone
from graphlib import CycleError, TopologicalSorter
from hashlib import sha256
from uuid import uuid5

from opendirector.application import creation_spend
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.creation.spend import SpendQuote, SpendRequest
from opendirector.domain.creation.validation import ContractError, validate_command


def _member(snapshot, member, workflow):
    spec = next((s for s in snapshot.generationSpecs if s.id == member.specId), None)
    item = next((i for i in snapshot.canvasItems if i.id == member.itemId), None)
    if item is None or spec is None:
        raise ContractError('missing_object', 'A workflow member no longer exists.', member.itemId)
    binding = item.binding
    spec_ref = binding.objectRef if binding.role == 'generation' else getattr(binding, 'draftSpec', None)
    if spec_ref is None or spec_ref.id != spec.id:
        raise ContractError('invalid_input', 'Workflow member does not own this generation specification.', item.id)
    return parse_command(dict(type='generation.submit', projectId=snapshot.project.id, commandId=uuid5(workflow, str(item.id)),
        expectedVersions=[dict(objectType='generation_spec', id=spec.id, revision=spec.revision),
                          dict(objectType='canvas_item', id=item.id, revision=item.revision)],
        payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=item.id, count=member.count, batchId=workflow)))


def _next_members(members, admitted=(), finished=()):
    # graphlib still yields every reachable node after detecting a cycle.
    graph = TopologicalSorter({m.itemId: m.after for m in members})
    try:
        graph.prepare()
    except CycleError:
        pass
    finished = set(finished)
    failed = set(admitted) - finished
    reachable = set()
    while nodes := graph.get_ready():
        ready = [item for item in nodes if item not in failed]
        reachable.update(ready)
        graph.done(*ready)
    remaining = [m for m in members if m.itemId not in admitted]
    ready = [m for m in remaining if m.itemId in reachable and set(m.after) <= finished]
    ready_ids = {m.itemId for m in ready}
    return (ready, [m.itemId for m in remaining if m.itemId in reachable and m.itemId not in ready_ids],
            [m.itemId for m in remaining if m.itemId not in reachable])


def _wave(snapshot, plan):
    workflow = plan.commandId
    decisions = [r for r in snapshot.spendRequests if r.workflowId == workflow]
    jobs = [j for j in snapshot.jobs if j.batchId == workflow]
    if any(r.status != 'accepted' for r in decisions) or any(j.status in {'queued', 'running'} for j in jobs):
        return [], [], []
    admitted = {item for request in decisions for item in request.groupItems}
    finished = {j.originItemId for j in jobs if j.adopted and j.status == 'succeeded'}
    return _next_members(plan.payload.members, admitted, finished)


def _price_members(runtime, before, workflow, members, deferred, skipped, *, checks=None, origin=None, from_upstream=False):
    draft = before
    lines, prints = [], []
    candidates = 0
    for m in members:
        member = _member(before, m, workflow)
        validate_command(member, before)
        data, job, config, task, records = runtime._propose_job(draft, member, agent_origin=origin, checks=checks.get(m.itemId) if checks is not None else None)
        if m.count > 1 and job.inputSnapshot.spec.kind not in {'image', 'video'}:
            raise ContractError('invalid_input', 'Multiple candidates require an image or video model.', m.specId)
        quote = runtime._quote_job(job, config, task, records, m.count)
        if checks is not None:
            draft = runtime._append_candidates(draft, data, member, job, config, quote)
        lines.extend(quote.lines * m.count)
        prints.append(str(m.itemId) + ':' + quote.fingerprint())
        candidates += m.count
    quote = SpendQuote(count=1, candidates=candidates, deferred=deferred, skipped=skipped, fromUpstream=from_upstream,
        inputFingerprint=sha256('|'.join(prints).encode()).hexdigest(), lines=lines)
    return draft, quote


def preview(runtime, query):
    before = runtime.projects.snapshot(query.projectId)
    ready, deferred, skipped = _next_members(query.workflow.members)
    _, quote = _price_members(runtime, before, query.queryId, ready, deferred, skipped)
    return creation_spend.quote_view(before, quote)


def _prepare(runtime, command, plan, session, source, origin, review):
    projects = runtime.projects
    replay = projects.replay(review or command)
    if replay is not None:
        return replay
    initial = projects.snapshot(command.projectId)
    if review:
        request = creation_spend.get_request(initial, review.payload.requestId)
        members = [m for m in plan.payload.members if m.itemId in request.groupItems]
        deferred, skipped = request.quote.deferred, request.quote.skipped
    else:
        members, deferred, skipped = _wave(initial, plan)
    checks = {m.itemId: runtime._submission_checks(_member(initial, m, plan.commandId), initial) for m in members}
    def apply(before):
        if review:
            validate_command(command, before)
        if review is None:
            spec_ids = {m.specId for m in plan.payload.members}
            pending_specs = creation_spend.pending_workflow_specs(before)
            pending_specs.update(r.specId for r in before.spendRequests if r.status == 'pending')
            if command.type == 'generation.group':
                pending_specs.update(j.inputSnapshot.spec.id for j in before.jobs if j.batchId and j.status in {'queued', 'running'})
            if spec_ids.intersection(pending_specs):
                raise ContractError('spend_quote_changed', 'Review the pending request for these workflow members first.')
        if not members:
            raise ContractError('invalid_input', 'No workflow step has all its upstream results.')
        ready_ids = tuple(m.itemId for m in members)
        if command.type == 'spend.advanceGroup' and set(ready_ids) != set(command.payload.items):
            raise ContractError('revision_conflict', 'The runnable workflow steps have changed.')
        draft, quote = _price_members(runtime, before, plan.commandId, members, deferred, skipped, checks=checks,
            origin=origin, from_upstream=command.type == 'spend.advanceGroup')
        decision = creation_spend.decide(before, command, quote, origin, review)
        if review is None and decision is not before:
            waiting = decision.spendRequests[-1].model_copy(update=dict(workflowId=plan.commandId, groupItems=ready_ids))
            return decision.model_copy(update={'spendRequests': (*decision.spendRequests[:-1], waiting)})
        requests = decision.spendRequests
        if review is None:
            requests = (*requests, SpendRequest(id=command.commandId, projectId=command.projectId, versions=command.expectedVersions,
                createdAt=datetime.now(timezone.utc), status='accepted', workflowId=plan.commandId, groupItems=ready_ids,
                agentRunId=origin[0] if origin else None, agentCallId=origin[1] if origin else None, quote=quote))
        return draft.model_copy(update={'project': decision.project, 'spendRequests': requests})
    return projects.commit(review or command, apply, session=session, source=source)


def _plan(projects, project_id, workflow):
    return next(r.command for r in projects.records(project_id) if r.command.commandId == workflow)


async def execute(runtime, command, *, session, source, agent_origin=None, review=None):
    plan = command if command.type == 'generation.group' else await asyncio.to_thread(
        _plan, runtime.projects, command.projectId, command.payload.workflowId)
    async def accept():
        receipt = await asyncio.to_thread(_prepare, runtime, command, plan, session, source, agent_origin, review)
        for job in receipt.jobIds:
            await runtime.recover(str(command.projectId), str(job))
        if receipt.jobIds:
            watch(runtime, command.projectId, plan.commandId)
        return receipt
    key = (str(command.projectId), str((review or command).commandId))
    work = asyncio.create_task(accept())
    runtime.accepting[key] = work
    def completed(done):
        if runtime.accepting.get(key) is done:
            runtime.accepting.pop(key)
        if not done.cancelled():
            done.exception()
    work.add_done_callback(completed)
    return await asyncio.shield(work)


def watch(runtime, project_id, workflow):
    if workflow in runtime.group_workers:
        return
    async def advance():
        plan = await asyncio.to_thread(_plan, runtime.projects, project_id, workflow)
        while True:
            snapshot = await asyncio.to_thread(runtime.projects.snapshot, project_id)
            current = [j for j in snapshot.jobs if j.batchId == workflow and j.status in {'queued', 'running'}]
            if current:
                futures = [runtime.jobs[str(j.id)].future for j in current if str(j.id) in runtime.jobs]
                if futures:
                    await asyncio.gather(*(asyncio.shield(f) for f in futures), return_exceptions=True)
                else:
                    await asyncio.sleep(1)
                continue
            members, _, _ = _wave(snapshot, plan)
            if not members:
                return
            ids = [m.itemId for m in members]
            versions = [v for m in members for v in _member(snapshot, m, workflow).expectedVersions]
            command = parse_command(dict(type='spend.advanceGroup', projectId=project_id,
                commandId=uuid5(workflow, 'advance:' + ','.join(map(str, ids))), expectedVersions=versions,
                payload=dict(workflowId=workflow, items=ids)))
            initial = creation_spend.get_request(snapshot, workflow)
            origin = (initial.agentRunId, initial.agentCallId) if initial.agentRunId else None
            receipt = await execute(runtime, command, session=None, source='background', agent_origin=origin)
            if not receipt.jobIds:
                return
    worker = asyncio.create_task(advance())
    runtime.group_workers[workflow] = worker
    def finished(done):
        runtime.group_workers.pop(workflow, None)
        if not done.cancelled() and (error := done.exception()) is not None:
            logging.getLogger(__name__).error('Workflow continuation failed: %s', workflow, exc_info=error)
    worker.add_done_callback(finished)
