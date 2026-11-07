"""Unified jobs, fixed provider inputs and atomic result publication.

ProviderMedia reads immutable assets for the protocol adapters. Execution uses
GenerationRuntime; every business write publishes a creation commit.
"""
import asyncio
from contextvars import ContextVar
from datetime import datetime, timezone
import hashlib
import re
from uuid import uuid4, uuid5

from filelock import FileLock, Timeout

from opendirector.application.creation_assets import CreationAssets
from opendirector.application.creation_canvas import CreationCanvas, asset_ref, current_generation_inputs, visible_item_ids
from opendirector.application.voice_library import VoiceLibrary
from opendirector.application.generation_runtime import GenerationRuntime, _self_hosted_video
from opendirector.domain.creation.assets import AssetProvenance
from opendirector.domain.creation.canvas import TextCanvasItem, ImageCanvasItem, VideoCanvasItem, AudioCanvasItem
from opendirector.domain.creation.base import ObjectVersion
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.creation.generation import (DEFAULT_MUSIC_SECONDS, InputSnapshot, Job, ResultVersion, execution_spec,
                                                     reference_music_seconds, validate_generation)
from opendirector.domain.creation.models import ModelConfigPublic, ModelSnapshot
from opendirector.domain.creation.project import ProjectSnapshot
from opendirector.domain.creation.validation import ContractError
from opendirector.domain.input_rules import input_rules
from opendirector.domain.projects import ProjectError
from opendirector.domain.video_output import apply_video_resolution
from opendirector.ports.gateway import gateway
from opendirector.integrations.http_settings import MODEL_JOB_CONTEXT
from opendirector.integrations.fasth3 import video_parameters
from opendirector.integrations.model_adapters import capabilities_of
from opendirector.integrations.providers import GenerationProviders
from opendirector.media.filenames import with_extension

_INPUTS = ContextVar('creation_generation_inputs', default=None)
# Connection facts a job freezes for a helper model; credentials stay in the model settings.
SNAPSHOT_KEYS = ('kind', 'modelId', 'url', 'protocol', 'connectionType')


def version(kind, obj):
    return ObjectVersion(objectType=kind, id=obj.id, revision=obj.revision)


def media_record(asset):
    meta = asset.metadata
    return dict(id=str(asset.id), name=asset.name, kind=asset.kind, type=meta.mimeType, size=meta.size,
        fingerprint=asset.fingerprint, width=meta.width, height=meta.height,
        durationMs=round(meta.durationSeconds * 1000) if meta.durationSeconds is not None else None,
        frameRate=meta.frameRate, hasAudio=meta.hasAudio, sampleRate=meta.sampleRate, channels=meta.channels,
        generationTaskId=str(asset.provenance.jobId) if asset.provenance.jobId else None)


class ProviderMedia:
    def __init__(self, runtime):
        self.runtime = runtime

    def asset(self, project_id, asset_id):
        stream, asset = self.runtime.assets.open_media(project_id, asset_id)
        with stream:
            metadata = media_record(asset)
            job = _INPUTS.get()
            if job and str(job.projectId) == str(project_id):
                frozen = next((r for r in job.inputSnapshot.references if str(r.asset.assetId) == str(asset_id)), None)
                if frozen and frozen.name:
                    metadata['name'] = frozen.name
            return stream.read(), metadata

    def generation_task(self, project_id, job_id):
        return self.runtime.task(self.runtime.get_job(project_id, job_id))

    def frozen_model(self, frozen):
        """Credentials for a helper model an accepted job froze, while its connection is unchanged."""
        config = self.runtime.configs.resolve(frozen['id'], frozen['kind'])
        if any(config.get(key) != frozen.get(key) for key in SNAPSHOT_KEYS):
            raise ProjectError('已接受任务的扒谱模型配置已变化，请新建尝试。', 409)
        return config


class CreationGeneration(GenerationRuntime):
    def __init__(self, projects, configs, provider=None):
        super().__init__()
        self.projects, self.configs = projects, configs
        self.assets = CreationAssets(projects)
        self.store = ProviderMedia(self)
        self.settings = gateway().settings(projects.local.repository)
        self.provider = provider or GenerationProviders(self.store)
        self.voices = VoiceLibrary(configs)

    def directory(self, project_id):
        with self.projects.local.transaction() as db:
            return self.projects._find(db, project_id)[0]

    def get_job(self, project_id, job_id):
        return next(
            (j for j in self.projects.snapshot(project_id).jobs if str(j.id) == str(job_id)), None)

    def task(self, job):
        spec, model = job.inputSnapshot.spec, job.inputSnapshot.model
        assets = {a.id: a for a in self.projects.snapshot(job.projectId).assets}
        reference_ids = list(dict.fromkeys(str(r.asset.assetId) for r in job.inputSnapshot.references if r.transmission != 'context_only'))
        content = None
        if spec.promptContent is not None:
            content = []
            for part in spec.promptContent:
                if part.type == 'text':
                    content.append(dict(type='text', text=part.text))
                else:
                    for ref in job.inputSnapshot.references:
                        if ref.referenceId == part.referenceId and ref.transmission != 'context_only':
                            asset = assets[ref.asset.assetId]
                            content.append(dict(type='reference', assetId=str(asset.id), name=ref.sourceTitle or ref.name or asset.name))
        return dict(schemaVersion=1, id=str(job.id), projectId=str(job.projectId), nodeId=str(job.originItemId or spec.id),
            kind=spec.kind, status=job.status, phase=job.phase, recovery=job.recovery, resumeAllowed=job.resumeAllowed,
            modelConfigId=str(model.modelConfigId), model=model.modelId, baseURL=model.url, protocol=model.protocol,
            title=spec.prompt[:80] or spec.kind, prompt=spec.prompt, promptContent=content, referenceIds=reference_ids,
            referenceRoles=[{'assetId': str(r.asset.assetId), 'role': r.role} for r in job.inputSnapshot.references if r.transmission != 'context_only'],
            referenceInputs={'profile': input_rules({**model.model_dump(), 'kind': model.kind})['profile']},
            videoMode=spec.parameters.videoMode if spec.kind == 'video' else 'first_frame', parameters=job.adapterParameters,
            externalTaskId=job.externalTaskId, assetId=str(job.asset.assetId) if job.asset else None,
            adopted=job.adopted, error=None, errorDetails=job.errorDetails.model_dump(mode='json') if job.errorDetails else None,
            inputSnapshot={'references': {str(r.asset.assetId): r.asset.fingerprint for r in job.inputSnapshot.references}},
            technicalCheck=job.technicalCheck.model_dump(mode='json') if job.technicalCheck else None)

    def _parameters(self, spec, config, node, records):
        params = {'text': {'thinking': 'auto', 'max_tokens': 8192},
            'image': {'size': '2K', 'response_format': 'url', 'output_format': 'png'},
            'video': {'duration': 5, 'ratio': 'adaptive', 'generate_audio': True},
            'audio': {'speaker': 'zh_female_vv_uranus_bigtts', 'audio_params': {'format': 'mp3', 'sample_rate': 24000}}}[spec.kind]
        intent = spec.parameters.model_dump(exclude_none=True)
        if spec.kind == 'text':
            params.update(thinking=intent['thinking'], max_tokens=intent['maxTokens'])
        if spec.kind == 'image':
            from opendirector.domain.image_output import resolve_image_output
            params['size'] = resolve_image_output(config, input_rules(config), intent)
        if spec.kind == 'audio' and intent['creationType'] == 'music':
            # The adapter snapshot fixes what is sent: style (prompt), lyrics and length cap.
            params = {'creation_type': 'music', 'lyrics': intent.get('lyrics', ''),
                      'duration': intent.get('durationSeconds') or DEFAULT_MUSIC_SECONDS}
            if node['referenceIds']:
                # The reference recording is transcribed into a score first, by
                # the transcription model chosen now, not one configured later.
                score = self._score_model()
                params.update(score_mode=intent.get('scoreMode', 'melody'),
                              score_model={'id': score['id'], **{key: score.get(key) for key in SNAPSHOT_KEYS}})
                recording = next(records[asset_id] for asset_id in node['referenceIds'] if records[asset_id]['kind'] == 'audio')
                if intent.get('durationFromReference', True) and recording['durationMs']:
                    params['duration'] = reference_music_seconds(recording['durationMs'] / 1000)
        elif spec.kind == 'audio' and intent.get('voice'):
            params['voice' if config['protocol'] == 'openai' else 'speaker'] = intent['voice']
        if spec.kind == 'video':
            rules = input_rules(config)
            if config['protocol'] == 'volcengine':
                params['generate_audio'] = intent['generateAudio']
            else:
                params.pop('generate_audio', None)
            seconds = intent.get('durationSeconds')
            if rules['profile'] == 'fasth3-omni':
                params = video_parameters(node, records, duration_seconds=seconds)
                # FastH3's wire contract sends duration; its derived frame
                # estimate is not an explicitly submitted execution parameter.
                params.pop('num_frames', None)
            elif rules['profile'] == 'standard-video':
                params = {}
            if seconds is None and config.get('videoCapabilities'):
                seconds = rules['videoCapabilities']['defaultDuration']
            if seconds is not None:
                params['duration'] = seconds
            if intent.get('aspectRatio'):
                params['ratio'] = intent['aspectRatio']
            output = dict(intent)
            if output.get('resolution') == 'auto' and output.get('aspectRatio') and rules['profile'] in {'standard-video', 'fasth3-omni', 'vllm-omni-h3'}:
                if node.get('videoMode') == 'continuation':
                    raise ProjectError('接续沿用上一段视频的画幅，请将比例设为自动。', 422)
                caps = rules.get('videoCapabilities') or {}
                choices = [item for item in caps.get('outputs', []) if seconds is None or seconds in item['durations']]
                if not choices:
                    raise ProjectError('指定视频比例前，请在模型接入中配置输出规格。', 422)
                preferred = next((item for item in choices if item['resolution'] == caps.get('defaultResolution')), choices[0])
                output['resolution'] = preferred['resolution']
            if config['protocol'] == 'minimax_video_v2':
                params['resolution'] = (intent.get('resolution') if intent.get('resolution') != 'auto' else None) or rules['videoCapabilities']['defaultResolution']
                has_frames = node['videoMode'] == 'first_frame' and any(records[key]['kind'] == 'image' for key in node['referenceIds'])
                if has_frames:
                    params['ratio'] = 'adaptive'
                elif params['ratio'] == 'adaptive' and not any(records[key]['kind'] in {'image', 'video', 'audio'} for key in node['referenceIds']):
                    params['ratio'] = '16:9'
            else:
                apply_video_resolution(params, node, records, config, output)
            if rules['profile'] == 'vllm-omni-h3':
                from opendirector.integrations.vllm_omni import FPS, h3_frames
                params.update(fps=FPS, num_frames=h3_frames(params['duration']))
        if spec.kind in {'image', 'video'} and config['protocol'] == 'volcengine':
            params['watermark'] = not self.settings.get()['removeWatermark']
        if spec.kind == 'image' and input_rules(config)['profile'] == 'moss-image':
            params.update(prompt_enhance=False, watermark=not self.settings.get()['removeWatermark'])
        if spec.kind == 'audio' and input_rules(config)['profile'] == 'moss-speech':
            params = dict(voice=intent['voice'], response_format='mp3', delivery_method='url', stream=False)
        return params

    @staticmethod
    def _execution(kind, parameters, config):
        if kind == 'text':
            return dict(kind=kind, thinking=parameters['thinking'], maxTokens=parameters['max_tokens'])
        if kind == 'image':
            profile = input_rules(config)['profile']
            return dict(kind=kind, size=parameters['size'],
                responseFormat='b64_json' if profile in {'vllm-omni-image', 'vllm-omni-qwen-image'} else 'url' if config['protocol'] == 'volcengine' or profile == 'moss-image' else None,
                outputFormat='png', watermark=parameters.get('watermark'))
        if kind == 'audio' and parameters.get('creation_type') == 'music':
            return dict(kind=kind, creationType='music', format='mp3', maxDurationSeconds=parameters['duration'],
                        scoreMode=parameters.get('score_mode'))
        if kind == 'audio':
            if input_rules(config)['profile'] == 'moss-speech':
                return dict(kind=kind, voice=parameters['voice'], format='mp3')
            return dict(kind=kind, voice=parameters.get('voice') or ('default' if config['connectionType'] == 'self_hosted' else 'alloy') if config['protocol'] == 'openai' else None,
                speaker=parameters.get('speaker') if config['protocol'] != 'openai' else None,
                format='mp3', sampleRate=24000 if config['protocol'] != 'openai' else None)
        mapping = {'durationSeconds': 'duration', 'size': 'size', 'resolution': 'resolution', 'fps': 'fps',
            'numFrames': 'num_frames', 'numInferenceSteps': 'num_inference_steps', 'guidanceScale': 'guidance_scale',
            'seed': 'seed', 'watermark': 'watermark', 'generateAudio': 'generate_audio'}
        return dict(kind=kind, **{key: parameters[source] for key, source in mapping.items() if source in parameters})

    def _score_model(self):
        """The first configured transcription model, in settings order."""
        config = next((item for item in self.configs.list() if 'audio.score' in capabilities_of(item)), None)
        if config is None:
            raise ProjectError('参照音乐需要先把参照扒成乐谱，请在“模型接入”中添加扒谱模型（vLLM-Omni 扒谱接口）。', 409)
        return config

    async def _run(self, task, pinned, config, mode='submit'):
        # A durable job can be discovered by more than one API process. OS locks
        # prevent both workers from treating the same queued checkpoint as a
        # fresh paid submission; process death releases the claim automatically.
        folder = gateway().directory(gateway().child(self.projects.state_dir, 'creation-job-locks'))
        folder.mkdir(exist_ok=True)
        claim = FileLock(gateway().child(folder, f"{task['projectId']}-{task['id']}.lock"), timeout=0, thread_local=False)
        remote = None
        try:
            claim.acquire()
        except Timeout:
            return
        token = None
        try:
            if _self_hosted_video(task):
                endpoint = hashlib.sha256(task['baseURL'].rstrip('/').encode()).hexdigest()
                remote = FileLock(gateway().child(folder, f'service-{endpoint}.lock'), timeout=0, thread_local=False)
                while True:
                    try:
                        remote.acquire()
                        break
                    except Timeout:
                        await asyncio.sleep(.1)  # Outside worker capacity and execution timeout.
            latest = self.get_job(task['projectId'], task['id'])
            if latest is None or latest.status == 'succeeded':
                return
            task = self.task(latest)
            mode = self.recovery(task, pinned)
            if mode not in {'submit', 'remote', 'download', 'local'} or latest.cancelRequested and (latest.remoteCancellation == 'confirmed' or mode == 'submit'):
                return
            if mode in {'submit', 'remote'} and config is None:
                config = self.configs.resolve(task['modelConfigId'], 'agent' if task['kind'] == 'text' else task['kind'])
            token = _INPUTS.set(latest)
            await super()._run(task, pinned, config, mode)
        finally:
            if token is not None:
                _INPUTS.reset(token)
            if remote is not None:
                remote.release()
            claim.release()

    def prepare(self, command, *, session=None, source='ui'):
        replay = self.projects.replay(command)
        if replay is not None:
            return replay
        # Voice registries are remote services. Probe outside the catalog/file
        # transaction, then compare the exact spec and private configuration
        # again under commit so a slow/offline provider cannot freeze editing.
        initial = self.projects.snapshot(command.projectId)
        voice_spec = next((spec for spec in initial.generationSpecs if spec.id == command.payload.specId), None)
        voice_config, voice_failure = None, None
        if voice_spec is not None and voice_spec.kind == 'audio' and voice_spec.parameters.creationType == 'audio':
            try:
                voice_config = self.configs.resolve(str(voice_spec.modelConfigId), 'audio')
                public = ModelConfigPublic.model_validate({key: value for key, value in voice_config.items() if key != 'apiKey'} | {'inputRules': input_rules(voice_config)})
                prepared_spec, references = current_generation_inputs(initial, voice_spec, public.inputRules)
                validate_generation(prepared_spec, public, references)
                self.voices.validate_selection(voice_config, prepared_spec.parameters.voice, prepared_spec.parameters.voiceSelection)
            except (ValueError, ProjectError) as error:
                voice_failure = error
        def accept(before):
            data = before.model_dump(mode='json')
            spec_data = CreationCanvas._get(data, 'generation_spec', command.payload.specId)
            if sum(j.inputSnapshot.spec.id == command.payload.specId and j.status in {'queued', 'running'} for j in before.jobs) >= 8:
                raise ContractError('revision_conflict', '该配置的排队任务已达上限，请等待或取消原任务。', command.payload.specId)
            if command.payload.previousJobId:
                previous = next((j for j in before.jobs if j.id == command.payload.previousJobId), None)
                if previous is None or previous.inputSnapshot.spec.id != command.payload.specId:
                    raise ContractError('invalid_input', '新尝试必须关联同一生成配置的原任务。', command.payload.previousJobId)
            origin = command.payload.originItemId
            material = None
            if origin:
                item = CreationCanvas._editable(data, origin)
                material = item['binding'].get('materialOverride')
                spec_data['purpose'] = 'generation'
                item['binding'] = dict(role='generation', objectRef=dict(objectType='generation_spec', id=spec_data['id']), materialOverride=material)
                if item != next(i.model_dump(mode='json') for i in before.canvasItems if i.id == origin):
                    item['revision'] += 1
            elif spec_data['purpose'] == 'draft':
                spec_data['purpose'] = 'generation'
            # Promote every owner of this draft together, including hidden ones.
            for item in data['canvasItems']:
                # An empty binding serialises draftSpec as null, not absent.
                if (item['binding'].get('draftSpec') or {}).get('id') == spec_data['id']:
                    item['binding'] = dict(role='generation', objectRef=dict(objectType='generation_spec', id=spec_data['id']))
                    item['revision'] += 1
            old = next(s for s in before.generationSpecs if s.id == command.payload.specId)
            if spec_data['purpose'] != old.purpose:
                spec_data['revision'] += 1
            intermediate = ProjectSnapshot.model_validate(data)
            spec = next(s for s in intermediate.generationSpecs if s.id == old.id)
            config = self.configs.resolve(str(spec.modelConfigId), 'agent' if spec.kind == 'text' else spec.kind)
            public = ModelConfigPublic.model_validate({key: value for key, value in config.items() if key != 'apiKey'} | {'inputRules': input_rules(config)})
            spec, resolved = current_generation_inputs(intermediate, spec, public.inputRules)
            spec = execution_spec(spec, resolved, public.inputRules)
            try:
                validate_generation(spec, public, resolved)
                if spec.kind == 'audio' and spec.parameters.creationType == 'audio':
                    if old != voice_spec or config != voice_config:
                        raise ContractError('revision_conflict', '音色验证期间生成配置或模型服务已变化，请重新提交。', spec.id)
                    if voice_failure is not None:
                        raise voice_failure
            except (ValueError, ProjectError) as error:
                raise ContractError.from_error(error, spec.id) from error
            for reference in resolved:
                if reference.transmission != 'context_only':
                    self.assets.reference_available(command.projectId, reference.asset.assetId)
            self.provider.validate(spec.kind, config)
            snapshot = InputSnapshot(spec=spec.model_copy(update={'currentResultId': None}),
                model=ModelSnapshot(modelConfigId=public.id, inputRules=public.inputRules,
                    **{k: getattr(public, k) for k in ('kind', 'modelId', 'url', 'protocol', 'connectionType', 'proxyMode', 'videoAdapter')}), references=resolved)
            # Use the same rendering, protocol validation and parameter resolver
            # as the established adapters, with immutable media from the facade.
            stub = Job(id=uuid5(command.commandId, 'job'), projectId=command.projectId, inputSnapshot=snapshot,
                createdAt=datetime.now(timezone.utc),
                inputFingerprint=snapshot.fingerprint(), execution={'kind': spec.kind, **({'size': '2K'} if spec.kind == 'image' else {'format': 'mp3', 'sampleRate': 24000} if spec.kind == 'audio' else {})},
                originItemId=origin, previousJobId=command.payload.previousJobId,
                adoptionPolicy=command.payload.adoptionPolicy, adoptionResultId=old.currentResultId, adoptionMaterial=material,
                batchId=command.payload.batchId, showAdditionalResult=command.payload.showAdditionalResult)
            task = self.task(stub)
            records = {str(a.id): media_record(a) for a in before.assets}
            try:
                if hasattr(self.provider, 'prepare_inputs'):
                    self.provider.prepare_inputs(str(command.projectId), task, config)
                parameters = self._parameters(spec, config, task, records)
            except ProjectError as error:
                raise ContractError.from_error(error, spec.id) from error
            job = Job.model_validate({**stub.model_dump(), 'adapterParameters': parameters, 'execution': self._execution(spec.kind, parameters, config)})
            data['jobs'].append(job.model_dump(mode='json'))
            return ProjectSnapshot.model_validate(data)
        return self.projects.commit(command, accept, session=session, source=source)

    async def execute(self, command, *, session=None, source='ui'):
        if command.type == 'generation.submit':
            pending = asyncio.create_task(asyncio.to_thread(self.prepare, command, session=session, source=source))
            async def finish():
                try:
                    receipt = await pending
                    for job_id in receipt.jobIds:
                        await self.recover(str(command.projectId), str(job_id))
                    return receipt
                finally:
                    self.accepting.pop((str(command.projectId), str(command.commandId)), None)
            # The continuation outlives a disconnected HTTP request.
            continuation = asyncio.create_task(finish())
            continuation.add_done_callback(lambda future: future.exception() if not future.cancelled() else None)
            self.accepting[(str(command.projectId), str(command.commandId))] = continuation
            return await asyncio.shield(continuation)
        if command.type not in {'job.cancel', 'job.recover'}:
            raise ProjectError('无效的任务命令。')
        # Persist control intent/receipt before any remote action. Replays do not
        # reissue cancellation or start a new paid attempt.
        def control(before):
            job = self.get_job(command.projectId, command.payload.jobId)
            if job is None:
                raise ContractError('missing_object', '任务不存在。', command.payload.jobId)
            if command.type == 'job.cancel' and job.status not in {'succeeded', 'cancelled'}:
                job = job.model_copy(update={'cancelRequested': True, 'revision': job.revision + 1})
                return before.model_copy(update={'jobs': tuple(job if j.id == job.id else j for j in before.jobs)})
            return before
        replay = self.projects.replay(command)
        if replay:
            return replay
        receipt = await asyncio.to_thread(self.projects.commit, command, control, session=session, source=source)
        if receipt.status != 'rejected':
            if command.type == 'job.cancel':
                await self.cancel(str(command.projectId), str(command.payload.jobId), session)
            else:
                await self.recover(str(command.projectId), str(command.payload.jobId), explicit=True)
        return receipt

    def checkpoint(self, project_id, task, pinned):
        before = self.projects.snapshot(project_id)
        job = next(j for j in before.jobs if str(j.id) == task['id'])
        if job.status == 'succeeded':
            return
        changes = {key: task[key] for key in ('status', 'phase', 'recovery', 'resumeAllowed', 'externalTaskId', 'errorDetails', 'technicalCheck') if key in task}
        changes['adopted'] = task.get('adopted', job.adopted)
        if changes['status'] == 'cancelled' and job.cancelRequested:
            changes['remoteCancellation'] = ('unknown' if task.get('errorDetails') else 'requested') if task.get('externalTaskId') else 'not_requested'
            if changes['recovery'] == 'submit':
                changes['resumeAllowed'] = False
        if job.cancelRequested and (task.get('errorDetails') or {}).get('providerStatus') == 'cancelled':
            changes.update(status='cancelled', remoteCancellation='confirmed', resumeAllowed=False, recovery='retry')
        updated = Job.model_validate({**job.model_dump(), **changes, 'revision': job.revision + 1})
        if updated.model_copy(update={'revision': job.revision}) == job:
            return
        command = parse_command(dict(commandId=uuid4(), projectId=project_id, type='job.checkpoint',
            expectedVersions=[version('job', job)], payload=dict(job=updated)))
        def apply(current):
            return current.model_copy(update={'jobs': tuple(updated if j.id == job.id else j for j in current.jobs)})
        receipt = self.projects.commit(command, apply, source='background')
        if receipt.status == 'rejected':
            raise ProjectError('任务状态发生并发修改，请重新读取原任务。', 409)

    def _result_asset(self, task, directory):
        job = self.get_job(task['projectId'], task['id'])
        if job and job.asset:
            stream, asset = self.assets.open_media(job.projectId, job.asset.assetId)
            stream.close()
            return media_record(asset)
        return None

    def _commit_output(self, task, pinned, suffix, data):
        existing = self._result_asset(task, pinned)
        if existing:
            return existing
        job = self.get_job(task['projectId'], task['id'])
        handle = uuid5(job.id, 'output-upload')
        name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', task['title']).strip(' .')[:180] or job.execution.kind
        self.assets.stage_output(job.projectId, handle, with_extension(name, suffix),
            gateway().results(pinned, task['id']).directory / 'output', expected_kind=job.execution.kind)
        # Sibling results or user edits may advance the same spec between our
        # read and commit. Retry only registration of these already saved bytes;
        # eligibility is recalculated from each new snapshot, never by resending
        # the provider request or reusing an obsolete adoption decision.
        for attempt in range(16):
            try:
                return self._register_output(task, pinned, suffix, handle, name)
            except ProjectError as error:
                if error.code != 'revision_conflict' or attempt == 15:
                    raise

    def _register_output(self, task, pinned, suffix, handle, name):
        before = self.projects.snapshot(task['projectId'])
        job = next(j for j in before.jobs if str(j.id) == task['id'])
        if job.status == 'succeeded':
            return self._result_asset(task, pinned)
        spec = next(s for s in before.generationSpecs if s.id == job.inputSnapshot.spec.id)
        origin = next((i for i in before.canvasItems if i.id == job.originItemId), None)
        command = parse_command(dict(commandId=uuid5(job.id, f'register-result:{job.revision}:{spec.revision}:{origin.revision if origin else 0}'), projectId=job.projectId, type='asset.import',
            expectedVersions=[version('job', job), version('generation_spec', spec), *([version('canvas_item', origin)] if origin else [])],
            payload=dict(uploadHandle=handle, name=with_extension(name, suffix), expectedKind=job.execution.kind)))
        def apply(current, asset):
            current_job = next(j for j in current.jobs if j.id == job.id)
            current_spec = next(s for s in current.generationSpecs if s.id == spec.id)
            eligible = not current_job.cancelRequested
            same_selection = current_spec.currentResultId == current_job.adoptionResultId
            try:
                projected_spec, references = current_generation_inputs(current, current_spec, current_job.inputSnapshot.model.inputRules)
                effective = execution_spec(projected_spec, references, current_job.inputSnapshot.model.inputRules)
                now = InputSnapshot(spec=effective.model_copy(update={'purpose': 'generation', 'currentResultId': None}),
                    model=current_job.inputSnapshot.model, references=references)
                eligible = eligible and now.fingerprint() == current_job.inputFingerprint
            except (ValueError, ContractError):
                eligible = False
            if current_job.originItemId:
                try:
                    CreationCanvas._editable(current.model_dump(mode='json'), current_job.originItemId)
                except ContractError:
                    eligible = False
            try:
                selected = self.configs.resolve(str(current_spec.modelConfigId), current_job.inputSnapshot.model.kind)
                model = current_job.inputSnapshot.model
                eligible = eligible and (selected['url'], selected['modelId'], selected['protocol'], selected.get('videoAdapter', 'auto')) == (model.url, model.modelId, model.protocol, model.videoAdapter)
            except ProjectError:
                eligible = False
            item = next((i for i in current.canvasItems if i.id == current_job.originItemId), None)
            if item and item.binding.role == 'generation':
                eligible = eligible and item.binding.materialOverride == current_job.adoptionMaterial
            adopt = eligible and same_selection and current_job.adoptionPolicy == 'if_current'
            selected_result = next((r for r in current.results if r.id == current_spec.currentResultId), None)
            selected_job = next((j for j in current.jobs if selected_result and j.id == selected_result.jobId), None)
            own_batch = current_job.batchId is not None and selected_job is not None and selected_job.batchId == current_job.batchId
            additional = self._additional_item(current, item, asset, current_job) if eligible and current_job.showAdditionalResult and (same_selection or own_batch) and item and item.id in visible_item_ids(current) else None
            result = ResultVersion(id=uuid5(job.id, 'result'), projectId=job.projectId, specId=spec.id, jobId=job.id,
                asset=asset_ref(asset), inputFingerprint=job.inputFingerprint)
            check = self._technical_check(media_record(asset))
            completed = Job.model_validate({**current_job.model_dump(), 'status': 'succeeded', 'phase': 'complete',
                'recovery': 'done', 'resumeAllowed': False, 'asset': asset_ref(asset), 'adopted': adopt,
                'technicalCheck': check, 'errorDetails': None, 'revision': current_job.revision + 1})
            adopted_spec = current_spec.model_copy(update={'currentResultId': result.id, 'revision': current_spec.revision + 1}) if adopt else current_spec
            adopted_item = item
            if adopt and item:
                width, height = self._media_size(item, asset)
                binding = item.binding.model_copy(update={'materialOverride': None}) if item.binding.role == 'generation' else item.binding
                editors = tuple(ref for ref in item.editors if ref.kind not in {'layers', 'image_crop'})
                if (width, height, binding, editors) != (item.width, item.height, item.binding, item.editors):
                    adopted_item = item.model_copy(update={'binding': binding, 'editors': editors, 'width': width, 'height': height, 'revision': item.revision + 1})
            return current.model_copy(update={'assets': (*current.assets, asset), 'results': (*current.results, result),
                'jobs': tuple(completed if j.id == job.id else j for j in current.jobs),
                'canvasItems': (*tuple(adopted_item if item and i.id == item.id else i for i in current.canvasItems), *([additional] if additional else [])),
                'generationSpecs': tuple(adopted_spec if s.id == spec.id else s for s in current.generationSpecs)})
        provenance = AssetProvenance(source='generated', jobId=job.id, inputFingerprint=job.inputFingerprint,
            sources=tuple({r.asset.assetId: r.asset for r in job.inputSnapshot.references}.values()))
        receipt = self.assets.register(command, source='background', provenance=provenance, apply=apply)
        if receipt.status == 'rejected':
            # The bytes and original job survive; recovery retries local commit,
            # never the provider submission. A fresh CAS is safe on recovery.
            conflict = all(issue.code == 'revision_conflict' for issue in receipt.issues)
            raise ProjectError('结果登记未完成，原结果已保留。', 409,
                code='revision_conflict' if conflict else 'operation_rejected')
        result = self._result_asset(task, pinned)
        task['adopted'] = self.get_job(job.projectId, job.id).adopted
        return result

    @staticmethod
    def _media_size(origin, asset):
        width, height = origin.width, origin.height
        if asset.kind in {'image', 'video'} and asset.metadata.width and asset.metadata.height:
            edge, ratio = max(width, height), asset.metadata.width / asset.metadata.height
            width, height = (edge, edge / ratio) if ratio >= 1 else (edge * ratio, edge)
            width, height = max(160, width), max(120, height)
        return width, height

    @classmethod
    def _additional_item(cls, snapshot, origin, asset, job):
        models = {'text': TextCanvasItem, 'image': ImageCanvasItem, 'video': VideoCanvasItem, 'audio': AudioCanvasItem}
        width, height = cls._media_size(origin, asset)
        siblings = [i for i in snapshot.canvasItems if i.parentId == origin.parentId]
        x, y = origin.position.x + origin.width + 64, origin.position.y
        for index in range(1024):
            x = origin.position.x + (max(width, origin.width) + 64) * (1 + index % 8)
            y = origin.position.y + (max(height, origin.height) + 64) * (index // 8)
            if not any(x < i.position.x + i.width + 16 and x + width + 16 > i.position.x
                       and y < i.position.y + i.height + 16 and y + height + 16 > i.position.y for i in siblings):
                break
        return models[asset.kind](id=uuid5(job.id, 'display-item'), projectId=job.projectId, kind=asset.kind, title=origin.title,
            position={'x': x, 'y': y}, width=width, height=height, parentId=origin.parentId,
            binding={'role': 'material', 'objectRef': asset_ref(asset)})

    async def recover(self, project_id, job_id, session=None, *, explicit=False):
        job = self.get_job(project_id, job_id)
        if job is None or job.status == 'succeeded':
            return job
        worker = self.jobs.get(str(job_id))
        if worker and not worker.future.done():
            return job
        if job.cancelRequested and not explicit:
            return job
        task = self.task(job)
        pinned = str(self.directory(project_id))
        mode = self.recovery(task, pinned)
        if job.cancelRequested and (job.remoteCancellation == 'confirmed' or mode not in {'remote', 'download', 'local'}):
            return job  # Stop intent can be reconciled, never turned into a fresh submission.
        if mode not in {'submit', 'remote', 'download', 'local'}:
            task.update(status='interrupted', recovery=mode, resumeAllowed=False)
            await asyncio.to_thread(self.checkpoint, project_id, task, pinned)
            return job
        config = None
        if mode != 'local':
            try:
                config = self.configs.resolve(task['modelConfigId'], 'agent' if task['kind'] == 'text' else task['kind'])
                valid = (config['url'], config['modelId'], config['protocol'], config.get('videoAdapter', 'auto')) == (task['baseURL'], task['model'], task['protocol'], job.inputSnapshot.model.videoAdapter)
                if valid and job.inputSnapshot.spec.kind == 'audio' and job.inputSnapshot.spec.parameters.voiceSelection is not None:
                    from opendirector.domain.voices import voice_library_capabilities
                    capabilities = voice_library_capabilities(config)
                    valid = capabilities is not None and capabilities['connectionId'] == job.inputSnapshot.spec.parameters.voiceSelection.connectionId
            except ProjectError:
                valid = False
            if not valid:
                if mode == 'download':
                    # The private locator belongs to the accepted result, not
                    # the current model selection. Never attach another model's
                    # credentials or turn this read into a new submission.
                    config = None
                else:
                    task.update(status='interrupted', recovery='review', resumeAllowed=False)
                    await asyncio.to_thread(self.checkpoint, project_id, task, pinned)
                    return job
        if config is not None:
            config = {**config, 'proxyMode': job.inputSnapshot.model.proxyMode}
        self._launch(task, pinned, config, mode)
        return job

    async def cancel(self, project_id, job_id, session):
        self.cancelled.add(job_id)
        worker = self.jobs.get(job_id)
        if worker and job_id not in self.committing:
            worker.future.cancel()
            await asyncio.gather(worker.future, return_exceptions=True)
        job = self.get_job(project_id, job_id)
        if job and job.externalTaskId and (worker is None or worker.future.cancelled()) and job.status not in {'succeeded', 'cancelled'}:
            task = self.task(job)
            try:
                config = self.configs.resolve(task['modelConfigId'], 'agent' if task['kind'] == 'text' else task['kind'])
                if (config['url'], config['modelId'], config['protocol']) != (task['baseURL'], task['model'], task['protocol']):
                    raise ProjectError('原模型配置已变化，供应商取消未确认。', 409)
                trace_token = MODEL_JOB_CONTEXT.set((str(project_id), str(job_id)))
                try:
                    await self.provider.cancel(config, job.externalTaskId)
                finally:
                    MODEL_JOB_CONTEXT.reset(trace_token)
                task.update(status='cancelled', recovery='remote', resumeAllowed=True, errorDetails=None)
            except (ProjectError, OSError):
                from opendirector.domain.generation import GenerationFailure
                task.update(status='cancelled', recovery='remote', resumeAllowed=True, errorDetails=GenerationFailure(
                    category='temporary', stage='cancel', message='供应商取消未确认。', suggestion='请在服务控制台核对原任务和费用。').model_dump(mode='json'))
            self.checkpoint(project_id, task, str(self.directory(project_id)))
            job = self.get_job(project_id, job_id)
        if job and job.status in {'queued', 'running'} and job_id not in self.committing:
            task = self.task(job)
            task.update(status='cancelled', recovery=self.recovery(task, str(self.directory(project_id))), resumeAllowed=False)
            self.checkpoint(project_id, task, str(self.directory(project_id)))
        self.cancelled.discard(job_id)

    async def start(self):
        for project in self.projects.list_projects()['projects']:
            for job in self.projects.snapshot(project['id']).jobs:
                if job.status in {'queued', 'running', 'interrupted'} or job.status == 'failed' and job.resumeAllowed:
                    if job.cancelRequested:
                        await self.cancel(project['id'], str(job.id), None)
                    else:
                        await self.recover(project['id'], str(job.id))

    async def close(self):
        await asyncio.gather(*list(self.accepting.values()), return_exceptions=True)
        workers = list(self.jobs.values())
        for worker in workers:
            if not any(key in self.committing and value is worker for key, value in self.jobs.items()):
                worker.future.cancel()
        await asyncio.gather(*(w.future for w in workers), return_exceptions=True)
