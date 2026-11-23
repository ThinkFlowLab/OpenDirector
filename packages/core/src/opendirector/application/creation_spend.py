"""Project-scoped admission. All callers invoke these decisions under the project commit lock."""
from collections import defaultdict
from datetime import datetime, timezone
from uuid import uuid4, uuid5

from opendirector.domain.creation.index import object_index
from opendirector.domain.creation.spend import SpendCall, SpendPolicy, SpendRequest, call_totals, cap_adjustment, spend_decision, spend_math, spend_summary
from opendirector.domain.creation.validation import ContractError
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.creation.spend import SpendObservation, observed_call
from opendirector.domain.projects import ProjectError


def quote_view(snapshot, quote):
    summary = spend_summary(snapshot)
    total = quote.total(summary['policy'].currency)
    with spend_math():
        after = None if total is None or summary['unknown'] else summary['settled'] + summary['held'] + total
    return dict(quote=quote, fingerprint=quote.fingerprint(), amount=total, subtotals=quote.subtotals(), projectAfter=after,
        currency=summary['policy'].currency, reason=spend_decision(summary, quote))


def workflow_status(snapshot, agent_run_id=None):
    requests = defaultdict(list)
    for request in snapshot.spendRequests:
        if request.workflowId and (agent_run_id is None or request.agentRunId == agent_run_id):
            requests[request.workflowId].append(request)
    jobs = defaultdict(list)
    for job in snapshot.jobs:
        if job.batchId in requests:
            jobs[job.batchId].append(job)
    results = []
    for workflow_id, decisions in requests.items():
        first, latest = decisions[0], decisions[-1]
        members = set((*first.groupItems, *first.quote.deferred, *first.quote.skipped))
        admitted = {item for decision in decisions if decision.status == 'accepted' for item in decision.groupItems}
        completed = {job.originItemId for job in jobs[workflow_id] if job.adopted and job.status == 'succeeded'}
        active = {job.originItemId for job in jobs[workflow_id] if job.status in {'queued', 'running'}}
        failed = admitted - completed - active
        skipped = set(latest.quote.skipped)
        if latest.status in {'pending', 'cancelled'}:
            state = 'waiting' if latest.status == 'pending' else 'cancelled'
        elif active or (members - admitted - skipped and not failed):
            state = 'running'
        elif failed or skipped:
            state = 'incomplete'
            skipped = members - admitted
        else:
            state = 'completed'
        results.append(dict(id=workflow_id, items=sorted(members), state=state, completed=len(completed),
                            failed=len(failed), skipped=len(skipped), total=len(members)))
    return results


def review_status(snapshot, agent_run_id=None):
    summary = spend_summary(snapshot)
    policy = summary['policy']
    pending = []
    requests = [request for request in snapshot.spendRequests if request.status == 'pending']
    objects = object_index(snapshot) if any(request.versions for request in requests) else {}
    for request in requests:
        total = request.quote.total(policy.currency)
        reason = spend_decision(summary, request.quote)
        if request.currency and request.currency != policy.currency:
            reason = 'stale'
        elif any(getattr(objects.get((v.objectType, v.id)), 'revision', None) != v.revision for v in request.versions):
            reason = 'stale_inputs'
        shortfall, suggested = cap_adjustment(policy.cap, summary['available'], total) if reason == 'over_cap' else (None, None)
        pending.append(dict(request=request, fingerprint=request.quote.fingerprint(), reason=reason, amount=total,
            subtotals=request.quote.subtotals(), shortfall=shortfall,
            suggestedCap=suggested))
    result = dict(**summary, projectRevision=snapshot.project.revision, pending=pending, workflows=workflow_status(snapshot, agent_run_id))
    settled_owners = {c.ownerId for c in snapshot.spendCalls if c.state == 'completed' and c.line.price is not None
                      and c.line.price.currency == policy.currency and (c.reported is not None or c.calculated is not None)}
    settled_jobs = [job for job in snapshot.jobs if job.id in settled_owners]
    if (settled_jobs and len(settled_jobs) == len(settled_owners)
            and len({job.batchId or job.id for job in settled_jobs}) == 1
            and len({job.execution.kind for job in settled_jobs}) == 1
            and all(job.status == 'succeeded' for job in settled_jobs)):
        result['settledBatch'] = dict(kind=settled_jobs[0].execution.kind, count=len(settled_jobs))
    if agent_run_id is not None:
        owners = {j.id for j in snapshot.jobs if j.agentRunId == agent_run_id}
        calls = [call for call in snapshot.spendCalls if call.ownerId in owners]
        result['turn'] = dict(callCount=len(calls), **call_totals(calls, policy.currency))
    return result


def save_policy(before, policy):
    if policy == (before.project.spendPolicy or SpendPolicy()):
        return before
    return before.model_copy(update={'project': before.project.model_copy(update={
        'spendPolicy': policy, 'revision': before.project.revision + 1})})


def get_request(snapshot, request_id):
    request = next((r for r in snapshot.spendRequests if r.id == request_id), None)
    if request is None:
        raise ContractError('missing_object', 'Spend request does not exist.', request_id)
    return request


def pending_workflow_specs(snapshot):
    item_ids = {item_id for request in snapshot.spendRequests if request.workflowId and request.status == 'pending'
                for item_id in (*request.groupItems, *request.quote.deferred)}
    specs = set()
    for item in snapshot.canvasItems:
        if item.id in item_ids:
            binding = item.binding
            ref = binding.objectRef if binding.role == 'generation' else getattr(binding, 'draftSpec', None)
            if ref:
                specs.add(ref.id)
    return specs


def decide(before, command, quote, agent_origin, review=None):
    summary = spend_summary(before)
    reason = spend_decision(summary, quote)
    if review is None:
        if reason == 'ready':
            return before
        request = SpendRequest(id=command.commandId, projectId=command.projectId, quote=quote, versions=command.expectedVersions,
            currency=summary['policy'].currency, specId=getattr(command.payload, 'specId', None), batchId=getattr(command.payload, 'batchId', None),
            createdAt=datetime.now(timezone.utc), agentRunId=agent_origin[0] if agent_origin else None,
            agentCallId=agent_origin[1] if agent_origin else None)
        return before.model_copy(update={'spendRequests': (*before.spendRequests, request)})
    selection = review.payload
    request = get_request(before, selection.requestId)
    if request.currency is not None and request.currency != summary['policy'].currency:
        raise ContractError('spend_quote_changed', 'The project currency changed. Request a new estimate.')
    if request.status != 'pending' or selection.fingerprint != request.quote.fingerprint() or selection.fingerprint != quote.fingerprint():
        raise ContractError('spend_quote_changed', 'The request or its price changed. Request a new estimate.')
    if reason == 'prior_unknown':
        raise ContractError('spend_unknown', 'Earlier charges cannot be totalled in the project currency.')
    if reason == 'unpriced' or (reason == 'unknown_confirmation' and not selection.acceptUnknown):
        raise ContractError('spend_unknown', 'A bounded price in the project currency is required.')
    if selection.newCap is not None:
        policy = summary['policy']
        if reason != 'over_cap' or policy.cap is None or selection.newCap <= policy.cap:
            raise ContractError('spend_quote_changed', 'The available budget changed. Review the current balance.')
        before = save_policy(before, policy.model_copy(update={'cap': selection.newCap}))
        reason = spend_decision(spend_summary(before), quote)
    if reason == 'over_cap':
        raise ContractError('spend_cap', 'The batch exceeds the available project budget.')
    return resolve(before, request, review.commandId, 'accepted')


def resolve(before, request, decision_id, status):
    updated = request.model_copy(update=dict(revision=request.revision + 1, decisionId=decision_id, status=status))
    return before.model_copy(update={'spendRequests': tuple(updated if r.id == request.id else r for r in before.spendRequests)})


def observe(projects, project_id, call_id, state, **facts):
    observation = SpendObservation(callId=call_id, state=state, **facts)
    with projects.local.transaction():
        snapshot = projects.snapshot(project_id)
        call = next((c for c in snapshot.spendCalls if c.id == observation.callId), None)
        if call is None:
            return  # Historical jobs have no agreed rate.
        edited = observed_call(call, observation)
        if edited == call:
            return
        command = parse_command(dict(commandId=uuid4(), projectId=project_id, type='spend.observe', payload=observation,
            expectedVersions=[dict(objectType='spend_call', id=call.id, revision=call.revision)]))
        def apply(current):
            return current.model_copy(update={'spendCalls': tuple(edited if c.id == call.id else c for c in current.spendCalls)})
        receipt = projects.commit(command, apply, source='background')
        if receipt.status == 'rejected':
            raise ProjectError(receipt.issues[0].message, 409)


def reserve_calls(owner_id, project_id, quote):
    now = datetime.now(timezone.utc)
    return tuple(SpendCall(id=uuid5(owner_id, f'spend:{slot}'), ownerId=owner_id,
        projectId=project_id, line=line, createdAt=now) for slot, line in enumerate(quote.lines))
