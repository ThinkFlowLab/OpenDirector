"""Render a configured group from its adopted jobs and publish one project commit."""
from dataclasses import dataclass
from pathlib import Path
from shutil import copyfileobj
from tempfile import TemporaryDirectory
from uuid import UUID, uuid4, uuid5

from filelock import FileLock, Timeout

from opendirector.application.creation_canvas import CreationCanvas, asset_ref, current_asset, visible_item_ids
from opendirector.application.creation_segment_run_inputs import selected_segment_asset
from opendirector.domain.creation.assets import Asset, AssetProvenance
from opendirector.domain.creation.canvas import GroupAssembly, TimelineCanvasItem, WorkflowClip
from opendirector.domain.creation.commands import TimelinePublishRender
from opendirector.domain.creation.editors import TimelineClip, TimelineDocument, TimelineResource
from opendirector.domain.creation.project import ProjectSnapshot
from opendirector.domain.creation.validation import ContractError, validate_command, workflow_guide_policy
from opendirector.domain.projects import ProjectError
from opendirector.media.workflow_assembly import assemble_clips, prepare_clip
from opendirector.ports.files import AssetFileWrite
from opendirector.ports.gateway import gateway


@dataclass(frozen=True)
class SourceWindow:
    inFrame: int
    outFrame: int


@dataclass(frozen=True)
class AssemblyInputs:
    recipe: GroupAssembly
    timeline: TimelineCanvasItem
    document: TimelineDocument
    soundtrack: TimelineClip
    sources: tuple[tuple[WorkflowClip | SourceWindow, Asset], ...]

    @property
    def frames(self):
        return sum(window.outFrame - window.inFrame for window, _ in self.sources)


class CreationWorkflowAssembly:
    def __init__(self, projects):
        self.projects = projects
        self.canvas = CreationCanvas(projects)
        self.assets = self.canvas.assets

    def execute(self, command, *, session=None, source='ui', run_execution_id: UUID | None = None,
                run_result_jobs: dict[UUID, UUID] | None = None):
        if (run_execution_id is not None or run_result_jobs is not None) and source != 'background':
            raise ProjectError('已发布的运行须由后台执行器组装。', 409)
        if run_result_jobs is not None and run_execution_id is None:
            raise ProjectError('选择 Run 结果时必须指定执行。', 409)
        lock = gateway().child(self.projects.state_dir, f'group-assembly-{command.projectId}-{command.commandId}.lock')
        try:
            with FileLock(lock, timeout=0):
                replay = self.projects.replay(command)
                if replay is not None:
                    return replay
                return self._render(command, session, source, run_execution_id, run_result_jobs)
        except Timeout as error:
            raise ProjectError('同一次组装正在进行，请等待结果。', 409, code='workflow_assembly_busy') from error

    def _inputs(self, command, snapshot, run_execution_id: UUID | None = None,
                run_result_jobs: dict[UUID, UUID] | None = None):
        data = snapshot.model_dump(mode='json')
        group_id = command.payload.groupId
        items = {item.id: item for item in snapshot.canvasItems}
        visible = visible_item_ids(snapshot)
        self.canvas._editable(data, group_id)
        group = items.get(group_id)
        if group is None or group.kind != 'group' or group.assembly is None or group.id not in visible:
            raise ContractError('invalid_input', '所选分组没有可运行的组装配置。', group_id)
        if group.draftRunPlan is not None:
            raise ContractError('role_restricted', '请先发布 Run 草稿。', group_id)
        recipe = group.assembly
        plan = group.runPlan
        if plan is not None and run_execution_id is None:
            raise ContractError('role_restricted', '请从已发布的运行启动组装。', group_id)
        if plan is None and run_execution_id is not None:
            raise ContractError('invalid_input', '后台执行需要已发布的运行计划。', group_id)
        planned_steps = plan.by_item() if plan is not None else {}
        timeline = items.get(recipe.timelineItemId)
        if timeline is None or timeline.kind != 'timeline' or timeline.id not in visible:
            raise ContractError('reference_invalid', '组装时间线已不存在或隐藏。', recipe.timelineItemId)
        document = next(doc for doc in snapshot.editorDocuments if doc.id == timeline.binding.objectRef.id)
        self.canvas.require_editable_owner(data, document.id)
        if plan is not None:
            try:
                plan.validate_for(snapshot, group)
            except ValueError as error:
                raise ContractError('reference_invalid', str(error)[:500], group.id) from error
            if document.data.fps != plan.fps:
                raise ContractError('reference_invalid', '运行时间线帧率与冻结源素材不一致。', timeline.id)
        versions = {(v.objectType, v.id): v.revision for v in command.expectedVersions}
        if versions.get(('canvas_item', timeline.id)) != timeline.revision or versions.get(('editor_document', document.id)) != document.revision:
            raise ContractError('revision_conflict', '组装时间线在运行期间已变化。', timeline.id)
        if output := items.get(recipe.outputItemId):
            self.canvas._editable(data, output.id)
            if versions.get(('canvas_item', output.id)) != output.revision:
                raise ContractError('revision_conflict', '成片节点在运行期间已变化。', output.id)
            prior = current_asset(snapshot, output)
            if (output.kind != 'video' or output.binding.role != 'material' or (output.parentId and output.parentId not in visible)
                    or prior is None or prior.provenance.source != 'rendered'
                    or prior.provenance.editorDocumentId != document.id
                    or prior.provenance.sourceItemId not in {None, timeline.id}):
                raise ContractError('reference_invalid', '成片节点不是此时间线的发布目标。', output.id)

        visual, audio = document.data.tracks if len(document.data.tracks) == 2 else (None, None)
        if (visual is None or visual.kind != 'visual' or audio.kind != 'audio' or audio.muted
                or len(audio.clips) != 1 or document.data.overlays):
            raise ContractError('invalid_input', '组装时间线需要一个画面轨和一条原声音轨，且没有字幕叠加。', timeline.id)
        soundtrack = audio.clips[0]
        if (soundtrack.resource.asset.kind != 'audio' or soundtrack.start not in {None, 0}
                or soundtrack.inPoint != 0 or soundtrack.speed != 1 or soundtrack.muted or soundtrack.volume != 1):
            raise ContractError('invalid_input', '原声必须从时间线起点完整播放。', timeline.id)

        jobs = {job.id: job for job in snapshot.jobs}
        by_item = {}
        for job_id in command.payload.jobIds:
            job = jobs.get(job_id)
            if (job is None or job.status != 'succeeded' or job.asset is None or job.originItemId in by_item
                    or (run_result_jobs is None and not job.adopted)):
                raise ContractError('reference_invalid', '组装需要本次运行中已采用的生成结果。', job_id)
            if job.originItemId is None:
                spec_id = job.inputSnapshot.spec.id
                segments = [
                    item for clip in recipe.clips
                    if (item := items.get(clip.itemId)) is not None and item.kind == 'video'
                    and item.binding.role == 'generation' and item.binding.objectRef.id == spec_id
                ]
                if len(segments) == 1:
                    segment = segments[0]
                    name = segment.title.strip() or str(segment.id)
                    raise ContractError('reference_invalid', f'组装片段「{name}」的生成任务缺少来源画布节点（originItemId）。', segment.id)
                raise ContractError('reference_invalid',
                    f'生成任务「{job.id}」（规格 {spec_id}）缺少来源画布节点（originItemId），无法确定对应的组装片段。', job.id)
            by_item[job.originItemId] = job
        if by_item.keys() != {clip.itemId for clip in recipe.clips}:
            raise ContractError('reference_invalid', '生成结果与组装片段没有一一对应。', group.id)
        if run_result_jobs is not None and {item_id: job.id for item_id, job in by_item.items()} != run_result_jobs:
            raise ContractError('reference_invalid', '组装任务与执行选定的片段结果不一致。', group.id)
        sources = []
        specs = {spec.id: spec for spec in snapshot.generationSpecs}
        for window in recipe.clips:
            item = items.get(window.itemId)
            if item is None or item.id not in visible or item.kind != 'video' or item.binding.role != 'generation':
                raise ContractError('reference_invalid', '组装片段必须来自可见的生成视频节点。', window.itemId)
            ancestor = item.parentId
            while ancestor is not None and ancestor != group.id:
                ancestor = items[ancestor].parentId
            job = by_item[item.id]
            if run_result_jobs is not None:
                asset = selected_segment_asset(snapshot, group, item, job)
            else:
                asset = current_asset(snapshot, item)
                if ((plan is None and not recipe.requireTimelineGuides and ancestor != group.id)
                        or job.inputSnapshot.spec.id != item.binding.objectRef.id or asset is None
                        or asset.id != job.asset.assetId or asset.fingerprint != job.asset.fingerprint):
                    raise ContractError('reference_invalid', '生成节点的当前结果已变化。', item.id)
                if plan is not None and job.batchId != run_execution_id:
                    raise ContractError('reference_invalid', '生成任务不属于本次运行。', item.id)
                if plan is not None and asset_ref(asset) != job.asset:
                    raise ContractError('reference_invalid', '生成结果的冻结版本已变化。', item.id)
            basis = job.inputSnapshot
            policy = workflow_guide_policy(snapshot, basis.spec.id, item.id)
            name = item.title.strip() or str(item.id)
            if basis.workflowGuide is not None and policy != (basis.workflowGuide.groupId, basis.workflowGuide.required):
                raise ContractError('reference_invalid', f'片段「{name}」的导帧计划与冻结任务不一致。', item.id)
            step = planned_steps[item.id].step if item.id in planned_steps else None
            required_guide = step.kind == 'continuation' if step is not None else recipe.requires_timeline_guide(item.id)
            try:
                guide = basis.timeline_guide(required=required_guide)
            except ValueError as error:
                raise ContractError('reference_invalid', f'片段「{name}」必须使用有效的 H3 时间线导帧。', item.id) from error
            if step is not None and step.kind == 'continuation':
                upstream = by_item[step.upstreamItemId]
                if (guide is None or guide.sourceVersion is None or guide.sourceVersion.id != upstream.originItemId
                        or guide.asset != upstream.asset or basis.spec.parameters.h3Segment.sourceFrames != step.sourceFrames):
                    raise ContractError('reference_invalid', f'片段「{name}」的导帧与已发布的上游步骤不一致。', item.id)
            elif step is not None:
                spec = specs[item.binding.objectRef.id]
                segment = spec.parameters.h3Segment
                guide_ref = next((ref for ref in snapshot.references if segment is not None
                                  and ref.id == segment.guideReferenceId), None)
                if (guide is not None or guide_ref is not None) and (
                        guide is None or guide.asset.kind != 'image' or guide_ref is None
                        or guide.asset != guide_ref.source or segment != basis.spec.parameters.h3Segment):
                    raise ContractError('reference_invalid', f'锚点「{name}」的冻结图片导帧与发布配置不一致。', item.id)
            if guide is not None:
                frozen_asset = self.assets._reference(snapshot, guide.asset)
                related = jobs.get(frozen_asset.provenance.jobId)
                linked = by_item.get(guide.sourceVersion.id) if guide.sourceVersion else None
                produced = by_item.get(related.originItemId) if related else None
                if any(upstream and upstream.asset != guide.asset for upstream in (linked, produced)):
                    raise ContractError('reference_invalid', f'片段「{name}」的冻结导帧来源与本次采用的上游结果不一致。', item.id)
            sources.append((window, asset))
        if plan is not None:
            original = self.assets._reference(snapshot, plan.source)
            generated = iter(sources)
            sources = [(SourceWindow(entry.sourceStart, entry.sourceEnd), original) if entry.kind == 'source'
                       else next(generated) for entry in plan.entries]
        result = AssemblyInputs(recipe, timeline, document, soundtrack, tuple(sources))
        if abs(soundtrack.outPoint - result.frames / document.data.fps) > 1 / document.data.fps:
            raise ContractError('invalid_input', '原声时长与组装帧数不匹配。', timeline.id)
        return result

    def _copy(self, snapshot, asset, path):
        stream, _ = self.assets.open_media(snapshot.project.id, asset.id, snapshot=snapshot)
        with stream, path.open('wb') as output:
            copyfileobj(stream, output)

    def _stage(self, project_id, path, name, provenance):
        handle = uuid4()
        uploaded = self.assets.stage_output(project_id, handle, name, path, expected_kind='video')
        asset_id = gateway().upload_asset_id(project_id, handle)
        asset = Asset(id=asset_id, projectId=project_id, kind='video', name=name, path=f'assets/{asset_id}',
                      metadata=uploaded.metadata, fingerprint=uploaded.fingerprint, provenance=provenance)
        return asset, AssetFileWrite(assetId=asset_id, uploadHandle=handle, fingerprint=asset.fingerprint,
                                     size=asset.metadata.size)

    def _render(self, command, session, source, run_execution_id, run_result_jobs=None):
        project_id = command.projectId
        if source in {'ui', 'agent'}:
            with self.projects.local.transaction() as db:
                path, _ = self.projects._find(db, project_id)
                self.projects._lease(db, project_id, path, session)
        snapshot = self.projects.snapshot(project_id)
        try:
            validate_command(command, snapshot)
            inputs = self._inputs(command, snapshot, run_execution_id, run_result_jobs)
        except ContractError as error:
            return self._reject(command, error, session, source)
        spec = inputs.document.data
        geometry = dict(fps=spec.fps, width=spec.width, height=spec.height)
        filename = 'Workflow render.mp4'
        with TemporaryDirectory(prefix='opendirector-assembly-') as folder:
            workspace = Path(folder)
            rendered = []
            for index, (window, asset) in enumerate(inputs.sources):
                original = isinstance(window, SourceWindow)
                raw = workspace / ('source.mp4' if original else f'raw-{index}.mp4')
                prepared = workspace / f'clip-{index}.mp4'
                if not raw.exists():
                    self._copy(snapshot, asset, raw)
                prepare_clip(raw, prepared, **geometry, in_frame=window.inFrame, out_frame=window.outFrame,
                             reverse=window.reverse if isinstance(window, WorkflowClip) else False,
                             frame_limit=window.frameLimit if isinstance(window, WorkflowClip) else None,
                             normalize_size=original)
                rendered.append(prepared)
            audio = workspace / 'soundtrack'
            original = self.assets._reference(snapshot, inputs.soundtrack.resource.asset)
            self._copy(snapshot, original, audio)
            final = workspace / 'final.mp4'
            assemble_clips(rendered, audio, final, **geometry, frames=inputs.frames)

            staged = []
            try:
                for index, ((window, raw), prepared) in enumerate(zip(inputs.sources, rendered, strict=True)):
                    provenance = AssetProvenance(source='edited',
                        sourceItemId=window.itemId if isinstance(window, WorkflowClip) else None,
                        editorDocumentId=inputs.document.id, editorRevision=inputs.document.revision + 1, sources=(asset_ref(raw),))
                    staged.append(self._stage(project_id, prepared, f'Segment {index + 1}.mp4', provenance))
                finish, write = self._stage(project_id, final, filename, AssetProvenance(source='upload'))
            except (OSError, ProjectError, ValueError):
                self.projects.discard_uncommitted_files(project_id, tuple(w for _, w in staged))
                raise
            writes = (*[w for _, w in staged], write)
            # A thrown storage error can leave a durable intent. Let its
            # recovery finish before touching any of the staged files.
            receipt = self.projects.commit(command, lambda before: self._publish(
                before, command, inputs, staged, finish, run_execution_id, run_result_jobs),
                session=session, source=source, files=writes)
            if receipt.status in {'rejected', 'noop'}:
                self.projects.discard_uncommitted_files(project_id, writes)
            return receipt

    def _reject(self, command, error, session, source):
        def rejected(_):
            raise error
        return self.projects.commit(command, rejected, session=session, source=source)

    def _publish(self, snapshot, command, inputs, staged, output, run_execution_id, run_result_jobs=None):
        if self._inputs(command, snapshot, run_execution_id, run_result_jobs) != inputs:
            raise ContractError('revision_conflict', '组装输入在渲染期间已变化。', command.payload.groupId)
        document = inputs.document
        visual, audio = document.data.tracks
        resources = tuple(TimelineResource(asset=asset_ref(asset), title=asset.name,
            durationSeconds=(window.outFrame - window.inFrame) / document.data.fps)
            for (window, _), (asset, _) in zip(inputs.sources, staged, strict=True))
        clips = tuple(TimelineClip(id=str(uuid5(command.commandId, f'clip-{i}')), resource=resource,
                                  inPoint=0, outPoint=resource.durationSeconds, muted=True)
                      for i, resource in enumerate(resources))
        old_clips = {clip.resource.asset.assetId for clip in visual.clips}
        library = tuple(entry for entry in document.data.importedAssets if entry.asset.assetId not in old_clips)
        soundtrack = inputs.soundtrack.model_copy(update={'outPoint': inputs.frames / document.data.fps})
        connections = tuple(link for link in document.inputConnections if link.slotId == soundtrack.id)
        updated = document.model_copy(update={'revision': document.revision + 1, 'inputConnections': connections,
            'data': document.data.model_copy(update={'tracks': (visual.model_copy(update={'clips': clips}),
                audio.model_copy(update={'clips': (soundtrack,)})), 'importedAssets': (*library, *resources)})})
        data = snapshot.model_dump(mode='json')
        data['editorDocuments'] = [updated.model_dump(mode='json') if doc['id'] == str(document.id) else doc
                                   for doc in data['editorDocuments']]
        prepared = [*(asset for asset, _ in staged), output]
        data['assets'].extend(asset.model_dump(mode='json') for asset in prepared)
        target = next((item for item in snapshot.canvasItems if item.id == inputs.recipe.outputItemId), None)
        publication = TimelinePublishRender(itemId=inputs.timeline.id, editorId=document.id, asset=asset_ref(output),
            outputId=inputs.recipe.outputItemId, expectedOutputRevision=target.revision if target else None,
            title=f'{inputs.timeline.title[:249]} · MP4' if inputs.timeline.title else output.name,
            position={'x': inputs.timeline.position.x, 'y': inputs.timeline.position.y + inputs.timeline.height + 48})
        self.canvas.publish_render(data, publication, staged={asset.id for asset in prepared})
        if target:
            item = self.canvas._get(data, 'canvas_item', target.id)
            item['visible'] = True
            item['revision'] += 1
        return ProjectSnapshot.model_validate(data)
