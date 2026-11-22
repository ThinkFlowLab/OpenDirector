"""Project-scoped admission. All callers invoke these decisions under the project commit lock."""
from datetime import datetime, timezone
from uuid import uuid5

from opendirector.domain.creation.spend import SpendCall, SpendPolicy, SpendRequest, spend_decision, spend_summary
from opendirector.domain.creation.validation import ContractError


def review_status(snapshot):
    summary = spend_summary(snapshot)
    policy = summary['policy']
    pending = []
    for request in snapshot.spendRequests:
        if request.status != 'pending':
            continue
        total = request.quote.total(policy.currency)
        reason = spend_decision(summary, request.quote)
        pending.append(dict(request=request, fingerprint=request.quote.fingerprint(), reason=reason, amount=total,
            shortfall=total-summary['available'] if reason == 'over_cap' else None))
    return dict(**summary, projectRevision=snapshot.project.revision, pending=pending)


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


def decide(before, command, quote, agent_origin, review=None):
    summary = spend_summary(before)
    reason = spend_decision(summary, quote)
    if review is None:
        if reason == 'ready':
            return before
        request = SpendRequest(id=command.commandId, projectId=command.projectId, quote=quote, versions=command.expectedVersions,
            createdAt=datetime.now(timezone.utc), agentRunId=agent_origin[0] if agent_origin else None,
            agentCallId=agent_origin[1] if agent_origin else None)
        return before.model_copy(update={'spendRequests': (*before.spendRequests, request)})
    selection = review.payload
    request = get_request(before, selection.requestId)
    if request.status != 'pending' or selection.fingerprint != request.quote.fingerprint() or selection.fingerprint != quote.fingerprint():
        raise ContractError('spend_quote_changed', 'The request or its price changed. Request a new estimate.')
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


def reserve_calls(owner_id, project_id, quote):
    now = datetime.now(timezone.utc)
    return tuple(SpendCall(id=uuid5(owner_id, f'spend:{slot}'), ownerId=owner_id,
        projectId=project_id, line=line, createdAt=now) for slot, line in enumerate(quote.lines))
