"""Save and publish segment plans on existing canvas groups."""

from pathlib import Path
from shutil import copyfileobj
from tempfile import TemporaryDirectory
from uuid import uuid4, uuid5

from opendirector.application.creation_assets import CreationAssets
from opendirector.application.creation_canvas import asset_ref, visible_item_ids
from opendirector.domain.creation.assets import Asset, AssetProvenance
from opendirector.domain.creation.canvas import GroupCanvasItem, TextCanvasItem
from opendirector.domain.creation.commands import Command, CommandReceipt, GroupPlanDraft
from opendirector.domain.creation.project import ProjectSnapshot
from opendirector.domain.creation.validation import ContractError
from opendirector.domain.projects import ProjectError
from opendirector.media.probe import count_video_frames
from opendirector.ports.files import AssetFileWrite
from opendirector.ports.gateway import gateway


def validate_plan(snapshot: ProjectSnapshot, payload: GroupPlanDraft) -> GroupCanvasItem:
    items = {item.id: item for item in snapshot.canvasItems}
    group = items.get(payload.groupId)
    if not isinstance(group, GroupCanvasItem) or group.runPlan is not None or group.locked or group.parentId or not group.visible:
        raise ContractError('role_restricted', '请选择可见且未锁定的草稿分组。', payload.groupId)

    source = next((asset for asset in snapshot.assets if asset.id == payload.plan.source.assetId), None)
    if source is None or asset_ref(source) != payload.plan.source:
        raise ContractError('reference_invalid', '计划源片已变更或无法读取。', payload.plan.source.assetId)
    if source.metadata.frameRate is not None and source.metadata.frameRate != payload.plan.fps:
        raise ContractError('reference_invalid', '计划帧率与源片不一致。', source.id)

    entries = payload.plan.by_item()
    clips = payload.assembly.clips
    if tuple(clip.itemId for clip in clips) != tuple(entries):
        raise ContractError('invalid_input', '组装片段须按源片顺序与生成区间对应。', group.id)
    visible = visible_item_ids(snapshot)
    for clip in clips:
        item = items.get(clip.itemId)
        entry = entries[clip.itemId]
        if (item is None or item.kind != 'video' or item.binding.role != 'generation'
                or item.parentId != group.id or item.id not in visible):
            raise ContractError('invalid_input', '生成区间须引用分组内可见的视频生成节点。', clip.itemId)
        if clip.outFrame - clip.inFrame != entry.sourceEnd - entry.sourceStart:
            raise ContractError('invalid_input', '保留帧数须与源片区间长度一致。', clip.itemId)
    timeline = items.get(payload.assembly.timelineItemId)
    if timeline is None or timeline.kind != 'timeline' or timeline.parentId != group.id or timeline.id not in visible:
        raise ContractError('invalid_input', '计划须关联分组内可见的时间线。', group.id)
    return group


def plan_markdown(group: GroupCanvasItem, snapshot: ProjectSnapshot, payload: GroupPlanDraft) -> str:
    chinese = payload.planLocale == 'zh-CN'
    titles = {item.id: item.title.replace('|', '／').replace('\n', ' ') for item in snapshot.canvasItems}
    clips = {clip.itemId: clip for clip in payload.assembly.clips}
    rows = [
        f'# {group.title}', '',
        f'{payload.plan.frameCount} {"帧" if chinese else "frames"} · {payload.plan.fps} fps', '',
        '| 源片帧区间 | 片段 | 导帧 | 保留区间 |' if chinese else '| Source frames | Segment | Guide | Retained frames |',
        '| --- | --- | --- | --- |',
    ]
    for entry in payload.plan.entries:
        interval = f'[{entry.sourceStart}, {entry.sourceEnd})'
        if entry.kind == 'source':
            original = '保留原片' if chinese else 'Original footage'
            rows.append(f'| {interval} | {original} | — | {interval} |')
            continue
        clip = clips[entry.itemId]
        guide = '锚点' if chinese else 'Anchor'
        if entry.step.kind == 'continuation':
            first, last = entry.step.sourceFrames
            guide = f'{titles[entry.step.upstreamItemId]} · {first} / {last}'
        direction = ''
        if clip.reverse:
            direction = ' · 反转后取帧' if chinese else ' · after reversal'
        rows.append(f'| {interval} | {titles[entry.itemId]} | {guide} | [{clip.inFrame}, {clip.outFrame}){direction} |')
    if payload.planNotes.strip():
        rows.extend(['', '## 编排说明' if chinese else '## Planning notes', '', payload.planNotes.strip()])
    return '\n'.join(rows) + '\n'


def save_segment_plan(projects, command: Command, *, session: str | None, source: str) -> CommandReceipt:
    payload = command.payload

    def save(snapshot: ProjectSnapshot) -> ProjectSnapshot:
        group = validate_plan(snapshot, payload)
        if (group.draftRunPlan, group.assembly, group.runPlanLocale, group.runPlanNotes) == (
                payload.plan, payload.assembly, payload.planLocale, payload.planNotes):
            return snapshot
        updated = group.model_copy(update={
            'draftRunPlan': payload.plan, 'assembly': payload.assembly, 'runPlanLocale': payload.planLocale,
            'runPlanNotes': payload.planNotes, 'revision': group.revision + 1,
        })
        return snapshot.model_copy(update={'canvasItems': tuple(
            updated if item.id == group.id else item for item in snapshot.canvasItems)})

    return projects.commit(command, save, session=session, source=source)


def publish_segment_plan(projects, command: Command, *, session: str | None, source: str) -> CommandReceipt:
    replay = projects.replay(command)
    if replay is not None:
        return replay
    payload = command.payload
    snapshot = projects.snapshot(command.projectId)
    try:
        group = validate_plan(snapshot, payload)
    except ContractError as error:
        def reject(_: ProjectSnapshot) -> ProjectSnapshot:
            raise error

        return projects.commit(command, reject, session=session, source=source)

    assets = CreationAssets(projects)
    handle = uuid4()
    writer = assets.uploads.begin(command.projectId, handle, session, 'Run plan.md', expected_kind='text')
    try:
        with TemporaryDirectory(prefix='opendirector-segment-plan-') as folder:
            path = Path(folder, 'source')
            stream, _ = assets.open_media(command.projectId, payload.plan.source.assetId, snapshot=snapshot)
            with stream, path.open('wb') as target:
                copyfileobj(stream, target)
            if count_video_frames(path, fps=payload.plan.fps) != payload.plan.frameCount:
                raise ProjectError('计划帧数与实际源片不一致。', 409, code='reference_invalid')
        writer.write(plan_markdown(group, snapshot, payload).encode('utf-8'))
        upload = writer.finish()
    finally:
        writer.abort()
    asset_id = gateway().upload_asset_id(command.projectId, handle)
    asset = Asset(id=asset_id, projectId=command.projectId, kind='text', name='Run plan.md',
                  path=f'assets/{asset_id}', metadata=upload.metadata, fingerprint=upload.fingerprint,
                  provenance=AssetProvenance(source='manual'))
    plan_id = uuid5(command.commandId, 'published-segment-plan')
    card = TextCanvasItem(id=plan_id, projectId=command.projectId, kind='text',
                          title='运行计划' if payload.planLocale == 'zh-CN' else 'Run plan',
                          parentId=group.id, locked=True, position={'x': 32, 'y': 48}, width=640, height=400,
                          binding={'role': 'material', 'objectRef': asset_ref(asset)})
    published = group.model_copy(update={
        'assembly': payload.assembly, 'runPlan': payload.plan, 'draftRunPlan': None,
        'runPlanItemId': plan_id, 'runDefinitionId': command.commandId, 'runPlanLocale': payload.planLocale,
        'runPlanNotes': payload.planNotes, 'revision': group.revision + 1,
    })

    def publish(before: ProjectSnapshot) -> ProjectSnapshot:
        if before != snapshot:
            raise ContractError('revision_conflict', '工程在发布前已更新，请重试。', group.id)
        items = tuple(published if item.id == group.id else item for item in before.canvasItems)
        return before.model_copy(update={'assets': (*before.assets, asset), 'canvasItems': (*items, card)})

    write = AssetFileWrite(assetId=asset_id, uploadHandle=handle, fingerprint=asset.fingerprint, size=asset.metadata.size)
    receipt = projects.commit(command, publish, session=session, source=source, files=(write,))
    if not any(version.id == asset_id for version in receipt.changed):
        try:
            assets.uploads.cancel(command.projectId, handle, session)
        except ProjectError as error:
            if error.code != 'session_expired':
                raise
    return receipt
