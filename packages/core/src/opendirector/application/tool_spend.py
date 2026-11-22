"""Price the model calls in a frozen tool recipe, including optional translation."""
from datetime import datetime, timezone
from decimal import Decimal
from uuid import UUID, uuid5

from opendirector.application import creation_spend
from opendirector.application.tool_context import CONCEPTS, concept_parts
from opendirector.application.tool_image_edits import PRESETS
from opendirector.application.tool_image_segments import SMART_LAYERS
from opendirector.domain.creation.base import digest
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.creation.spend import SpendCall, SpendQuote, SpendRequest, ToolSpendInput, price_line
from opendirector.domain.projects import ProjectError


def tool_quote(task, records):
    models = task['modelSnapshots']
    parameters = task['parameters']
    tool = task['tool']
    prompt = parameters.get('prompt', '')
    prompt = prompt.strip() if isinstance(prompt, str) else ''
    parts = concept_parts(prompt)
    boxes = task.get('boxes') or []
    counts = {capability: 1 for capability in models}
    if 'text.chat' in counts:
        counts['text.chat'] = 0
    if tool in {'cutout', 'layer-decompose', 'video-matting', 'selection-preview'}:
        if tool == 'layer-decompose':
            mode = parameters.get('mode', 'smart')
            parts = parts if mode == 'description' else []
            boxes = boxes if mode == 'boxes' else []
        if 'image.segment' in counts:
            counts['image.segment'] = len(boxes) or len(parts) or len(SMART_LAYERS)
        if 'text.chat' in counts and not boxes:
            counts['text.chat'] = sum(not part.isascii() and part not in CONCEPTS for part in parts)
    elif tool in {'video-edit', 'video-partial-reshoot', 'video-subtitle-erasure', 'dynamic-poster'} and 'text.chat' in counts:
        counts['text.chat'] = int(bool(prompt) and not prompt.isascii())
    if tool == 'image-presets' and 'image.edit' in counts:
        preset = PRESETS.get(parameters.get('preset', 'three-view'))
        if preset is not None:
            counts['image.edit'] = len(preset.prompts)
    if tool == 'image-hd' and 'image.edit' in counts:
        counts['image.edit'] = len(task['sourceAssetIds'])
    pieces = (task.get('videoExecution') or {}).get('pieces', ())
    if pieces and 'video.edit' in counts:
        counts['video.edit'] = len(pieces)
    source = records[task['sourceAssetIds'][0]]
    lines = []
    for capability, count in counts.items():
        for index in range(count):
            units = {}
            if source.get('durationMs') is not None:
                units['input_second'] = Decimal(source['durationMs']) / 1000
            if capability == 'video.edit' and pieces:
                start, end = pieces[index]
                units['input_second'] = units['requested_second'] = Decimal(str(round(end-start, 6)))
            elif capability == 'video.first_frame' and tool == 'dynamic-poster':
                units['requested_second'] = 5
            lines.append(price_line(models[capability], capability, units))
    inputs = {key: value for key, value in task.items() if key in {
        'id', 'tool', 'sourceAssetIds', 'maskAssetId', 'annotationAssetId', 'boxes', 'parameters', 'modelConfigIds',
        'modelSnapshots', 'imageExecution', 'videoExecution', 'inputSnapshot', 'draftBinding', 'canvas'}}
    inputs['fingerprints'] = {key: records[key]['fingerprint'] for key in
        [*task['sourceAssetIds'], task.get('maskAssetId'), task.get('annotationAssetId')] if key}
    return SpendQuote(count=1, inputFingerprint=digest(ToolSpendInput(request=inputs)), lines=lines)


def pending_receipt(task, admission):
    return dict(id=task['id'], projectId=task['projectId'], status='awaiting_confirmation', spendRequestId=str(admission.id))


def admit(projects, value, task, records, session, review=None):
    owner = UUID(task['id'])
    pid = UUID(task['projectId'])
    command = parse_command(dict(type='spend.tool', projectId=pid, commandId=uuid5(owner, 'tool-spend'),
                                 payload=dict(request=value)))
    quote = tool_quote(task, records)
    if not quote.lines and review is None:
        return None
    def apply(before):
        decided = creation_spend.decide(before, command, quote, None, review)
        if review is not None:
            return decided.model_copy(update={'spendCalls': (*decided.spendCalls, *creation_spend.reserve_calls(owner, pid, quote))})
        if decided is before:
            record = SpendRequest(id=command.commandId, projectId=pid, versions=(), quote=quote, toolTask=task,
                status='accepted', createdAt=datetime.now(timezone.utc))
            return before.model_copy(update={'spendRequests': (*before.spendRequests, record),
                'spendCalls': (*before.spendCalls, *creation_spend.reserve_calls(owner, pid, quote))})
        queued = decided.spendRequests[-1].model_copy(update={'toolTask': task})
        return decided.model_copy(update={'spendRequests': (*decided.spendRequests[:-1], queued)})
    receipt = projects.commit(review or command, apply, session=session)
    if receipt.status == 'rejected':
        raise ProjectError(receipt.issues[0].message, 409, code=receipt.issues[0].code)
    return creation_spend.get_request(projects.snapshot(pid), command.commandId)


def begin_call(projects, project_id, task_id, capability, ordinal, model=None):
    snapshot = projects.snapshot(project_id)
    calls = [call for call in snapshot.spendCalls if str(call.ownerId) == task_id and call.line.operation == capability]
    if not calls and not any(r.id == uuid5(UUID(task_id), 'tool-spend') for r in snapshot.spendRequests):
        return None
    if ordinal >= len(calls) and model is not None:
        line = price_line(model(), capability, {})
        if line.amount == 0:
            # A free extension can arise in older tool recipes. Keep the physical call visible.
            owner = UUID(task_id)
            call = SpendCall(id=uuid5(owner, f'extra:{capability}:{ordinal}'), projectId=project_id, ownerId=owner,
                line=line, state='submitted', createdAt=datetime.now(timezone.utc))
            record = parse_command(dict(type='spend.observe', projectId=project_id, commandId=uuid5(call.id, 'submitted'),
                payload=dict(callId=call.id, state='submitted')))
            receipt = projects.commit(record, lambda before: before.model_copy(update={'spendCalls': (*before.spendCalls, call)}),
                source='background')
            if receipt.status != 'rejected':
                return call.id
    if ordinal >= len(calls):
        raise ProjectError('The tool needs an additional model call outside its accepted estimate.', 409, code='spend_quote_changed')
    call = calls[ordinal]
    if call.state != 'reserved':
        raise ProjectError('This tool model call has already been submitted.', 409)
    creation_spend.observe(projects, project_id, call.id, 'submitted')
    return call.id


def release_unused(projects, project_id, task_id):
    for call in projects.snapshot(project_id).spendCalls:
        if str(call.ownerId) == task_id and call.state == 'reserved':
            creation_spend.observe(projects, project_id, call.id, 'released')
