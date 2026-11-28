"""Validate and publish a single, immutable segmented video definition."""

from hashlib import sha256
import json
from pathlib import Path
from shutil import copyfileobj
from tempfile import TemporaryDirectory
from uuid import uuid4, uuid5

from opendirector.application.replacement_prompt import verify_replacement_prompt
from opendirector.application.creation_assets import CreationAssets
from opendirector.application.creation_canvas import CreationCanvas, asset_ref, resolved_inputs, visible_item_ids
from opendirector.domain.creation.assets import Asset, AssetProvenance
from opendirector.domain.creation.canvas import GroupCanvasItem, TextCanvasItem
from opendirector.domain.creation.commands import Command, CommandReceipt, GroupPlanDraft
from opendirector.domain.creation.generation import H3Segment, PinnedReference, validate_generation
from opendirector.domain.creation.models import ModelConfigPublic
from opendirector.domain.creation.project import ProjectSnapshot
from opendirector.domain.creation.validation import ContractError
from opendirector.domain.input_rules import input_rules
from opendirector.domain.projects import ProjectError
from opendirector.domain.video_capabilities import supports_h3_segments
from opendirector.integrations.vllm_omni import FPS
from opendirector.media.workflow_assembly import probe_video_frames
from opendirector.ports.files import AssetFileWrite
from opendirector.ports.gateway import gateway


def run_model_fingerprint(config):
    # A credential may rotate independently of the selected deployment.
    settings = {key: value for key, value in config.items() if key != 'apiKey'}
    return sha256(json.dumps(settings, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _has_unfinished_job(jobs, spec_id):
    completed_at = {}
    for job in jobs:
        if (job.inputSnapshot.spec.id == spec_id and job.status == 'succeeded'
                and job.externalTaskId and job.asset and job.inputFingerprint):
            fingerprint = job.inputFingerprint
            completed_at[fingerprint] = max(job.createdAt, completed_at.get(fingerprint, job.createdAt))

    for job in jobs:
        if job.inputSnapshot.spec.id != spec_id:
            continue
        if job.status in {'queued', 'running'} or job.resumeAllowed:
            return True
        if (job.recovery == 'review' and job.errorDetails
                and job.errorDetails.category == 'submission_unknown'):
            # A later, completed attempt with identical inputs can unblock publication.
            # Keep the old job unresolved so the original submission remains auditable.
            newer_attempt = completed_at.get(job.inputFingerprint)
            if job.externalTaskId or newer_attempt is None or newer_attempt <= job.createdAt:
                return True
    return False


def _verify_inputs(snapshot, group, configs, *, probe_reference=None):
    try:
        group.runPlan.validate_for(snapshot, group)
    except ValueError as error:
        raise ContractError('invalid_input', str(error), group.id) from error
    fingerprints = {}
    items = {item.id: item for item in snapshot.canvasItems}
    specs = {spec.id: spec for spec in snapshot.generationSpecs}
    recipe = group.assembly
    visible = visible_item_ids(snapshot)
    timeline = items.get(recipe.timelineItemId)
    if (timeline is None or timeline.kind != 'timeline' or timeline.id not in visible
            or recipe.outputItemId in items):
        raise ContractError('invalid_input', '发布 Run 需要可见时间线和未使用的成片节点。', group.id)
    document = next(doc for doc in snapshot.editorDocuments if doc.id == timeline.binding.objectRef.id)
    data = snapshot.model_dump(mode='json')
    CreationCanvas.require_editable_owner(data, document.id)
    if any(isinstance(item, GroupCanvasItem) and item.runPlan is not None and item.id != group.id
           and (item.assembly.outputItemId == recipe.outputItemId
                or items[item.assembly.timelineItemId].binding.objectRef.id == document.id)
           for item in snapshot.canvasItems):
        raise ContractError('role_restricted', '此时间线或成片节点已属于其他 Run。', group.id)
    tracks = document.data.tracks
    if (document.data.fps != group.runPlan.fps or len(tracks) != 2 or tracks[0].kind != 'visual'
            or tracks[1].kind != 'audio' or tracks[1].muted or len(tracks[1].clips) != 1
            or document.data.overlays):
        raise ContractError('invalid_input', 'Run 时间线须匹配帧率，并配置画面轨与原声音轨。', timeline.id)
    audio = tracks[1].clips[0]
    if (audio.resource.asset.kind != 'audio' or audio.start not in {None, 0} or audio.inPoint != 0
            or audio.speed != 1 or audio.muted or audio.volume != 1
            or abs(audio.outPoint - group.runPlan.frameCount / group.runPlan.fps) > 1 / group.runPlan.fps):
        raise ContractError('invalid_input', 'Run 原声须覆盖完整交付区间。', timeline.id)
    for item_id, entry in group.runPlan.by_item().items():
        item = items[item_id]
        spec = specs[item.binding.objectRef.id]
        verify_replacement_prompt(entry, spec, item)
        if item_id not in visible:
            raise ContractError('reference_invalid', 'Run 需要可见的片段节点。', item_id)
        CreationCanvas._editable(data, item_id)
        if (item.binding.materialOverride is not None or spec.parameters.seed is None
                or _has_unfinished_job(snapshot.jobs, spec.id)):
            raise ContractError('invalid_input', '发布前须固定随机种子、清除素材覆盖并等待已有任务结束。', item_id)
        guide = spec.parameters.h3Segment
        guide_id = guide.guideReferenceId if guide else None
        if any(ref.active and ref.targetSpecId == spec.id and ref.id != guide_id
               and not isinstance(ref, PinnedReference) for ref in snapshot.references):
            raise ContractError('reference_invalid', '发布 Run 前须固定素材和肖像的引用版本。', item_id)
        config = configs.resolve(str(spec.modelConfigId), 'video')
        rules = input_rules(config)
        if rules['profile'] != 'fasth3-omni':
            raise ContractError('h3_timeline_guides_unsupported', '分段 Run 需要 FastH3 部署。', item_id)
        if guide_id and not supports_h3_segments(
                rules['profile'], (rules.get('videoCapabilities') or {}).get('timelineGuides')):
            raise ContractError('h3_timeline_guides_unsupported', 'Run 导帧需要支持时间线导帧的部署。', item_id)
        model = ModelConfigPublic.model_validate({key: value for key, value in config.items() if key != 'apiKey'} | {'inputRules': rules})
        pending_video_guide = entry.step.kind == 'continuation'
        references = resolved_inputs(snapshot, spec.id, model.inputRules,
                                     excluded_ids={guide_id} if pending_video_guide else set())
        videos = [ref.asset for ref in references if ref.asset.kind == 'video' and ref.transmission == 'content']
        if len(videos) != 1:
            raise ContractError('reference_invalid', '每个分段须固定一个源视频引用。', item_id)
        static_spec = spec.model_copy(update={'parameters': spec.parameters.model_copy(update={'h3Segment': H3Segment()})}) if pending_video_guide else spec
        try:
            validate_generation(static_spec, model, references, submitting=True)
        except (ValueError, ProjectError) as error:
            raise ContractError.from_error(error, item_id) from error
        if probe_reference is not None:
            duration = spec.parameters.durationSeconds
            requested = round(duration * FPS) if duration is not None else 120
            try:
                actual = probe_reference(videos[0])
            except ProjectError as error:
                raise ContractError('invalid_input', f'片段「{item.title}」无法按 24 FPS 解码数帧。', item_id) from error
            if actual != requested or requested < 107 or (requested - 5) % 17:
                raise ContractError(
                    'invalid_input',
                    f'片段「{item.title}」实测输入 {actual} 帧，请求 {requested} 帧。'
                    '两者须一致且满足 17k+5（k >= 6，至少 107 帧）。',
                    item_id,
                )
        fingerprints[item_id] = run_model_fingerprint(config)
    return fingerprints


def _plan_text(group, snapshot, locale, notes):
    chinese = locale == 'zh-CN'
    items = {item.id: item for item in snapshot.canvasItems}
    assets = {asset.id: asset for asset in snapshot.assets}
    specs = {spec.id: spec for spec in snapshot.generationSpecs}
    cuts = iter(group.assembly.clips)

    def cell(text):
        return text.replace('|', '／').replace('\n', ' ')

    rows = [f'# {group.title}', '',
            f'`{group.runPlan.frameCount}` {"帧" if chinese else "frames"} · `{group.runPlan.fps}` fps', '',
            '| 源片帧区间 | 片段 | 导帧 | 保留区间 | 是否满足 17k+5 |' if chinese else '| Source frames | Segment | Guide | Retained frames | Meets 17k+5 |',
            '| --- | --- | --- | --- | --- |']
    for entry in group.runPlan.entries:
        interval = f'[{entry.sourceStart}, {entry.sourceEnd})'
        if entry.kind == 'source':
            rows.append(f'| {interval} | {"保留原片" if chinese else "Original footage"} | — | {interval} | — |')
            continue
        label = cell(items[entry.itemId].title)
        guide = '锚点' if chinese else 'Anchor'
        if entry.step.kind == 'continuation':
            donor = cell(items[entry.step.upstreamItemId].title)
            frames = ' / '.join(map(str, entry.step.sourceFrames))
            guide = f'{donor} · {frames}'
        else:
            segment = specs[items[entry.itemId].binding.objectRef.id].parameters.h3Segment
            if segment is not None and segment.outputFrame is not None:
                guide = f'图片 → 第 {segment.outputFrame} 帧' if chinese else f'Image → frame {segment.outputFrame}'
        cut = next(cuts)
        direction = (' · 反转后取帧' if chinese else ' · after reversal') if cut.reverse else ''
        duration = specs[items[entry.itemId].binding.objectRef.id].parameters.durationSeconds
        alignment = '未指定' if chinese else 'Unspecified'
        if duration is not None:
            frames = round(duration * FPS)
            aligned = (frames - 5) % 17 == 0
            status = ('是' if aligned else '否') if chinese else ('Yes' if aligned else 'No')
            alignment = f'{status}（{frames} 帧）' if chinese else f'{status} ({frames} frames)'
        rows.append(f'| {interval} | {label} | {guide} | [{cut.inFrame}, {cut.outFrame}){direction} | {alignment} |')
    image_refs = {}
    for item_id in group.runPlan.by_item():
        spec_id = items[item_id].binding.objectRef.id
        image_refs[item_id] = [assets[ref.source.assetId].name for ref in sorted(snapshot.references, key=lambda ref: ref.order)
            if isinstance(ref, PinnedReference) and ref.targetSpecId == spec_id and ref.active and ref.source.kind == 'image']
    if any(image_refs.values()):
        rows.extend(['', '## 人物与图像引用' if chinese else '## Image references'])
        rows.extend(f'- {cell(items[item_id].title)} · {", ".join(cell(name) for name in names)}'
                    for item_id, names in image_refs.items() if names)
    if notes.strip():
        rows.extend(['', '## 编排说明' if chinese else '## Planning notes', '', notes.strip()])
    return '\n'.join(rows) + '\n'


def publish_segment_run(projects, configs, command, *, session, source):
    replay = projects.replay(command)
    if replay is not None:
        return replay
    payload = command.payload
    with projects.local.transaction() as db:
        path, _ = projects._find(db, command.projectId)
        projects._lease(db, command.projectId, path, session)
    snapshot = projects.snapshot(command.projectId)
    draft = next((item for item in snapshot.canvasItems if item.id == payload.groupId), None)
    if (not isinstance(draft, GroupCanvasItem) or draft.runPlan is not None or draft.locked
            or draft.parentId is not None or not draft.visible):
        raise ContractError('role_restricted', '请选择未发布且未锁定的 Run 草稿。', payload.groupId)
    plan_item_id = uuid5(command.commandId, 'published-segment-plan')
    group = draft.model_copy(update={'assembly': payload.assembly, 'runPlan': payload.plan,
                                     'runPlanItemId': plan_item_id, 'draftRunPlan': None, 'autoLayout': 'run',
                                     'runDefinitionId': command.commandId, 'runPlanLocale': payload.planLocale,
                                     'runPlanNotes': payload.planNotes,
                                     'revision': draft.revision + 1})
    assets = CreationAssets(projects)
    with TemporaryDirectory() as temp:
        counts = {}

        def probe_reference(ref):
            if ref.assetId not in counts:
                path = Path(temp, str(ref.assetId))
                stream, asset = assets.open_media(command.projectId, ref.assetId, snapshot=snapshot)
                if asset_ref(asset) != ref:
                    stream.close()
                    raise ProjectError('Reference asset version changed.', 409)
                with stream, path.open('wb') as target:
                    copyfileobj(stream, target)
                counts[ref.assetId] = probe_video_frames(path, fps=FPS)
            return counts[ref.assetId]

        try:
            fingerprints = _verify_inputs(snapshot, group, configs, probe_reference=probe_reference)
        except ProjectError as error:
            raise ContractError.from_error(error, group.id) from error
    group = group.model_copy(update={'runModelFingerprints': fingerprints})
    handle = uuid4()
    with TemporaryDirectory() as temp:
        original = Path(temp, 'source')
        stream, asset = assets.open_media(command.projectId, payload.plan.source.assetId, snapshot=snapshot)
        with stream, original.open('wb') as target:
            copyfileobj(stream, target)
        if asset_ref(asset) != payload.plan.source or probe_video_frames(
                original, fps=payload.plan.fps) != payload.plan.frameCount:
            raise ContractError('reference_invalid', 'Run 帧数或帧率与实际源片不一致。', asset.id)
        text_path = Path(temp, 'plan.md')
        text_path.write_text(_plan_text(group, snapshot, payload.planLocale, payload.planNotes), encoding='utf-8')
        uploaded = assets.stage_output(command.projectId, handle, 'Segment plan.md', text_path, expected_kind='text')
    asset_id = gateway().upload_asset_id(command.projectId, handle)
    text = Asset(id=asset_id, projectId=command.projectId, kind='text', name='Segment plan.md', path=f'assets/{asset_id}',
                 metadata=uploaded.metadata, fingerprint=uploaded.fingerprint, provenance=AssetProvenance(source='manual'))
    title = '分段计划' if payload.planLocale == 'zh-CN' else 'Segment plan'
    item = TextCanvasItem(id=plan_item_id, projectId=command.projectId, kind='text', title=title,
                          parentId=group.id, position={'x': 32, 'y': 48}, width=640, height=400,
                          binding={'role': 'material', 'objectRef': asset_ref(text)})
    write = AssetFileWrite(assetId=asset_id, uploadHandle=handle, fingerprint=text.fingerprint, size=text.metadata.size)

    def commit(before):
        if before != snapshot:
            raise ContractError('revision_conflict', '工程在核对期间已更新，请重新发布 Run。', group.id)
        if _verify_inputs(before, group, configs) != fingerprints:
            raise ContractError('revision_conflict', '模型配置在核对期间已更新，请重新发布 Run。', group.id)
        return ProjectSnapshot.model_validate({**before.model_dump(), 'assets': (*before.assets, text),
            'canvasItems': (*tuple(group if node.id == group.id else node for node in before.canvasItems), item)})

    receipt = projects.commit(command, commit, session=session, source=source, files=(write,))
    if receipt.status == 'rejected' or not any(version.id == asset_id for version in receipt.changed):
        projects.discard_uncommitted_files(command.projectId, (write,))
    return receipt


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

    entries = tuple(entry for entry in payload.plan.entries if entry.kind == 'generated')
    clips = payload.assembly.clips
    if tuple(clip.itemId for clip in clips) != tuple(entry.itemId for entry in entries):
        raise ContractError('invalid_input', '组装片段须按源片顺序与生成区间对应。', group.id)
    visible = visible_item_ids(snapshot)
    for clip, entry in zip(clips, entries):
        item = items.get(clip.itemId)
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
    clips = iter(payload.assembly.clips)
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
        clip = next(clips)
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
