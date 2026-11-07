"""Durable canvas AI tool tasks: catalog, submission, progress, cancellation.

Tasks resolve each capability a recipe needs to a configured model through the
adapter registry; recipes and this service never branch on model or protocol.
Results are stored as project assets; the canvas places them as linked nodes.
"""

import asyncio
import base64
from datetime import datetime, timezone
from uuid import UUID, uuid5

from PIL import Image

from opendirector.application.tool_operations import TOOLS, Source, ToolContext, select_image_objects
from opendirector.domain.capabilities import LABELS
from opendirector.domain.generation import GenerationError
from opendirector.domain.projects import ProjectError, identifier
from opendirector.ports.gateway import gateway
from opendirector.integrations.http_settings import MODEL_JOB_CONTEXT
from opendirector.integrations.model_adapters import adapter_for, capabilities_of
from opendirector.media import processing as media
from opendirector.media.filenames import with_extension
from opendirector.media.async_work import blocking
from .tool_task_lifecycle import ToolTaskLifecycle

ACTIVE = {'queued', 'running'}
MAX_SOURCES = 20


def _now():
    return datetime.now(timezone.utc).isoformat()


def _model_label(config):
    return config['modelId'].rsplit('/', 1)[-1] or config['modelId']


def output_item_id(task, index, kind):
    outputs = task.get('outputs', [])
    if index < len(outputs) and outputs[index].get('canvasItemId'):
        return outputs[index]['canvasItemId']
    canvas = task.get('canvas') or {}
    if index == 0 and canvas.get('targetNodeId') and canvas.get('targetKind') == kind:
        return canvas['targetNodeId']
    return str(uuid5(UUID(task['id']), f'canvas-output-{index}'))


class ToolTasks(ToolTaskLifecycle):
    def __init__(self, store, configs, assets, *, transport=None, poll_interval=3, concurrency=2, projects):
        self.store, self.configs, self.assets = store, configs, assets
        self.transport, self.poll_interval = transport, poll_interval
        self.jobs: dict[tuple[str, str], asyncio.Task] = {}
        self.limit = asyncio.Semaphore(concurrency)
        self.projects = projects
        self.accepting = set()
        self._init_lifecycle()

    # Capabilities -------------------------------------------------------------

    def providers(self) -> dict[str, list[dict]]:
        """Configured models per capability, in settings order."""
        served: dict[str, list[dict]] = {}
        for config in self.configs.list():
            for capability in sorted(capabilities_of(config)):
                served.setdefault(capability, []).append(config)
        return served

    def catalog(self):
        served = self.providers()
        tools = []
        for spec in TOOLS.values():
            needs = spec.requires({})
            missing = [item for item in needs if item not in served]
            entry = {'id': spec.id, 'requires': [{'capability': item, 'label': LABELS[item]} for item in needs],
                     'available': spec.recipe is not None and not missing, 'parametersConfirmed': spec.recipe is not None,
                     'fields': list(spec.fields), 'note': spec.note,
                     'models': {item: [{'id': config['id'], 'label': _model_label(config)} for config in served.get(item, [])] for item in needs}}
            if spec.recipe is None or missing:
                entry['reason'] = f"需要接入具备「{'、'.join(LABELS[item] for item in missing or needs)}」能力的模型。"
            tools.append(entry)
        selection = {'available': 'image.segment' in served}
        if not selection['available']:
            selection['reason'] = '接入图像分割模型后可自动识别选区；仍可手动画选区。'
        return {'capabilities': {item: [{'id': config['id'], 'label': _model_label(config)} for config in configs]
                                 for item, configs in served.items()}, 'tools': tools, 'selectionPreview': selection}

    def _model(self, capability, chosen):
        candidates = self.providers().get(capability, [])
        public = next((item for item in candidates if item['id'] == chosen), None) if chosen else (candidates[0] if candidates else None)
        if public is None:
            raise ProjectError(f'没有可用的「{LABELS[capability]}」模型，请在“模型接入”中添加。', 409)
        config = self.configs.resolve(public['id'], public['kind'])
        return config, adapter_for(config, self.transport, self.poll_interval)

    async def selection_preview(self, project_id, value, session):
        """Transient masks for one owned source asset; never creates tasks or output assets."""
        source_id = identifier(str(value['sourceAssetId']))

        def read():
            directory = self._directory(project_id, session)
            records = self.assets._records(directory, project_id)
            if source_id not in records or records[source_id]['kind'] != 'image':
                raise ProjectError('来源图片不存在，请重新上传。', 409)
            return media.open_image(self.assets.read_bytes(project_id, source_id))

        image = await asyncio.to_thread(read)
        config, adapter = self._model('image.segment', value.get('modelConfigId'))

        async def segment(request):
            return await adapter.segment(config, request)

        async def progress(_):
            pass

        chat = None
        if self.providers().get('text.chat'):
            async def chat(request):
                chat_config, chat_adapter = self._model('text.chat', None)
                return await chat_adapter.chat(chat_config, request)

        context = ToolContext(sources=[], mask=None, boxes=[], parameters={}, image_model=None, video_model=None,
                              progress=progress, segment_model=segment, chat_model=chat)
        async with self.limit:
            instances = await select_image_objects(context, image, value.get('prompt', ''), value.get('boxes') or [])

        def encode():
            result = []
            for index, (mask, score, label, box) in enumerate(instances):
                # White paint on transparency matches editor masks; grayscale PNGs
                # would otherwise cover the whole image when drawn into an RGBA canvas.
                rgba = Image.new('RGBA', image.size, (255, 255, 255, 0))
                rgba.putalpha(mask)
                result.append({'id': str(index), 'label': label, 'score': score,
                               'box': {'x': box[0], 'y': box[1], 'width': box[2] - box[0], 'height': box[3] - box[1]},
                               'maskDataUrl': 'data:image/png;base64,' + base64.b64encode(media.png(rgba)).decode()})
            return {'sourceAssetId': source_id, 'width': image.width, 'height': image.height, 'instances': result}
        return await asyncio.to_thread(encode)

    # Storage -------------------------------------------------------------------

    def _folder(self, directory, *, create=True):
        folder = gateway().child(directory, 'tool-tasks')
        if create:
            folder.mkdir(exist_ok=True)
        return folder

    def _directory(self, project_id, session=None):
        with self.store.transaction() as db:
            self.projects._recover()
            path, manifest = self.projects._find(db, project_id)
            self.projects._current(db, project_id, path, manifest)
            if session is not None:
                self.projects._lease(db, project_id, path, session)
            return path

    def list(self, project_id):
        folder = self._folder(self._directory(project_id), create=False)
        tasks = [self._read_task(project_id, gateway().child(folder, path.name)) for path in folder.glob('*.json')]
        return sorted(tasks, key=lambda task: (task['createdAt'], task['id']), reverse=True)

    def placement(self, project_id, task_id, state, session, *, policy="if_current"):
        # Serialize acknowledgement with task writes/project moves. This never
        # adopts a GenerationSpec result or changes a terminal execution state.
        with self.store.transaction():
            self._directory(project_id, session)
            task = self.get(project_id, task_id)
            if task['status'] in {'failed', 'cancelled', 'interrupted'} and state == 'unplaced':
                return self._settle_terminal(project_id, task_id, session)
            explicit_retained = (state == 'placed' and policy == 'explicit' and task.get('outputs')
                                 and task['status'] in {'failed', 'cancelled', 'interrupted'} and task.get('localState') == 'stopped')
            if task['status'] != 'succeeded' and not explicit_retained:
                raise ProjectError('工具任务尚未完成。', 409)
            if task.get('placement') == 'placed' and policy != 'explicit':
                return task
            if state == 'placed':
                from .creation_tool_drafts import publish_outputs
                state = publish_outputs(self, task, session, policy)
            return self._change(project_id, task_id, {'placement': state, 'outputs': task['outputs']})

    def _settle_terminal(self, project_id, task_id, session=None):
        # An accepted tool's canvas target remains visible as the place where
        # the attempt failed. Only settle result placement in the ledger.
        with self.store.transaction():
            directory = self._directory(project_id, session)
            task = gateway().read_json(gateway().child(self._folder(directory), task_id + '.json'))
            if task['status'] in {'failed', 'cancelled', 'interrupted'} and task.get('placement') == 'pending':
                task = self._change(project_id, task_id, {'placement': 'unplaced'})
            return task

    def _write(self, directory, task):
        gateway().write_json(gateway().child(self._folder(directory), task['id'] + '.json'), task)

    def get(self, project_id, task_id, session=None):
        identifier(project_id)
        identifier(task_id)
        path = gateway().child(self._folder(self._directory(project_id, session), create=False), task_id + '.json')
        return self._read_task(project_id, path, session)

    def _read_task(self, project_id, path, session=None):
        identifier(path.stem)
        if not path.is_file():
            raise ProjectError('工具任务不存在。', 404)
        task = gateway().read_json(path)
        for index, output in enumerate(task.get('outputs', [])):
            # Canvas items and assets occupy different project identities.
            output.setdefault('canvasItemId', output_item_id(task, index, output['kind']))
        if 'sourceFingerprint' not in task and task.get('sourceAssetIds'):
            records = self.assets._records(path.parent.parent, project_id)
            source = records.get(task['sourceAssetIds'][0], {})
            task.update(sourceFingerprint=source.get('fingerprint'), sourceKind=source.get('kind'))
        return task

    # Submission ----------------------------------------------------------------

    def _prepare(self, project_id, value, session):
        # Snapshot validation and accepted ledger publication share the project
        # lock. A source cannot be replaced between checking and acceptance.
        with self.store.transaction():
            return self._prepare_locked(project_id, value, session)

    def _prepare_locked(self, project_id, value, session):
        if self.closing:
            raise ProjectError('工具服务正在关闭，请稍后查询原任务。', 503)
        self._ensure_owner()
        identifier(project_id)
        task_id = identifier(str(value['id']))
        spec = TOOLS.get(value.get('tool'))
        if spec is None:
            raise ProjectError('未知工具。', 422)
        if spec.recipe is None:
            raise ProjectError(f"该工具需要接入具备「{'、'.join(LABELS[item] for item in spec.requires({}))}」能力的模型。", 409)
        parameters = value.get('parameters') or {}
        mask_id = identifier(str(value['maskAssetId'])) if value.get('maskAssetId') else None
        annotation_id = identifier(str(value['annotationAssetId'])) if value.get('annotationAssetId') else None
        needs = spec.requires(parameters)
        if spec.id == 'cutout' and not mask_id:
            needs = ('image.segment',) if 'image.segment' in self.providers() else ('image.cutout',)
        chosen = value.get('modelConfigIds') or {}
        source_ids = [identifier(str(item)) for item in value.get('sourceAssetIds') or []]
        if not source_ids or len(source_ids) > MAX_SOURCES or len(set(source_ids)) != len(source_ids):
            raise ProjectError('请提供 1–20 个不重复的来源素材。', 422)
        directory = self._directory(project_id, session)
        path = gateway().child(self._folder(directory), task_id + '.json')
        if path.is_file():
            existing = gateway().read_json(path)
            if (existing['tool'] != spec.id or existing['sourceAssetIds'] != source_ids
                    or existing['parameters'] != parameters or existing.get('maskAssetId') != mask_id
                    or existing.get('boxes', []) != (value.get('boxes') or [])
                    or existing.get('canvas') != value.get('canvas')
                    or existing.get('annotationAssetId') != annotation_id
                    or existing.get('draftBinding') != value.get('draft')
                    or existing.get('requestedModelConfigIds', existing.get('modelConfigIds', {})) != chosen):
                raise ProjectError('工具任务标识已使用。', 409)
            return existing, directory, None
        for capability in needs:
            self._model(capability, chosen.get(capability))
        records = self.assets._records(directory, project_id)
        for asset_id in [*source_ids, *([mask_id] if mask_id else []), *([annotation_id] if annotation_id else [])]:
            if asset_id not in records:
                raise ProjectError('来源素材不存在，请重新上传后提交。', 409)
        if records[source_ids[0]]['kind'] not in spec.sources:
            raise ProjectError('来源素材类型与工具不匹配。', 422)
        if mask_id and records[mask_id]['kind'] != 'image':
            raise ProjectError('选区必须是图片。', 422)
        if annotation_id and records[annotation_id]['kind'] != 'image':
            raise ProjectError('标注必须是图片。', 422)
        canvas = value.get('canvas')
        if canvas and (len(canvas['sourceNodeIds']) != len(source_ids) or canvas['sourceNodeIds'][0] != canvas['nodeId']):
            raise ProjectError('工具任务的画布来源不匹配。', 422)
        from .creation_tool_drafts import freeze_inputs
        frozen = freeze_inputs(self, project_id, value)
        models = {capability: self._model(capability, chosen.get(capability))[0] for capability in needs}
        if self.providers().get('text.chat'):
            models['text.chat'] = self._model('text.chat', chosen.get('text.chat'))[0]
        task = {'schemaVersion': 1, 'id': task_id, 'projectId': project_id, 'tool': spec.id, 'status': 'queued', 'phase': '排队中',
                'sourceAssetIds': source_ids, 'maskAssetId': mask_id, 'annotationAssetId': annotation_id,
                'boxes': value.get('boxes') or [], 'parameters': parameters,
                'modelConfigIds': {item: config['id'] for item, config in models.items()},
                'modelSnapshots': {item: {key: val for key, val in config.items() if key != 'apiKey'} for item, config in models.items()}, 'requestedModelConfigIds': chosen, 'requires': list(needs),
                'outputs': [], 'error': None, 'createdAt': _now(), 'finishedAt': None,
                'revision': 1, 'workerId': self.worker_id, 'localState': 'active',
                'cancelRequested': False, 'modelCalls': [],
                'canvas': canvas, 'sourceFingerprint': records[source_ids[0]]['fingerprint'],
                'sourceKind': records[source_ids[0]]['kind'], 'placement': 'pending'}
        task.update(frozen)
        self._write(directory, task)
        return task, directory, records

    async def submit(self, project_id, value, session):
        key = (project_id, identifier(str(value['id'])))
        self.accepting.add(key)
        async def accept():
            try:
                task, directory, records = await blocking(self._prepare, project_id, value, session)
                if records is not None and key not in self.jobs:
                    job = asyncio.create_task(self._run(task, directory, records))
                    self.jobs[key] = job
                    job.add_done_callback(lambda done: self.jobs.pop(key, None) if self.jobs.get(key) is done else None)
                return task
            finally:
                self.accepting.discard(key)
        pending = asyncio.create_task(accept())
        self.admissions.add(pending)
        def accepted(done):
            self.admissions.discard(done)
            if not done.cancelled():
                done.exception()
        pending.add_done_callback(accepted)
        return await asyncio.shield(pending)

    async def _update(self, directory, task, **changes):
        def save():
            with self.store.transaction():
                current = self.get(task['projectId'], task['id'])
                if current['status'] in {'succeeded', 'failed', 'cancelled', 'interrupted'} and changes.get('status') in ACTIVE:
                    return current
                if changes.get('status') == 'succeeded' and current.get('cancelRequested'):
                    return current
                return self._change(task['projectId'], task['id'], changes)
        current = await blocking(save)
        task.clear()
        task.update(current)
        if task['status'] in {'failed', 'cancelled', 'interrupted'}:
            task.update(await blocking(self._settle_terminal, task['projectId'], task['id']))

    async def _run(self, task, directory, records):
        spec = TOOLS[task['tool']]
        trace_token = MODEL_JOB_CONTEXT.set((str(task['projectId']), str(task['id'])))
        try:
            async with self.limit:
                current = self.get(task['projectId'], task['id'])
                if self.closing or current.get('cancelRequested') or current['status'] not in ACTIVE:
                    raise asyncio.CancelledError()
                await self._update(directory, task, status='running', phase='准备素材')

                def read(asset_id):
                    record = records[asset_id]
                    return Source(record['kind'], self.assets.read_bytes(task['projectId'], asset_id), record['name'])
                sources = await blocking(lambda: [read(item) for item in task['sourceAssetIds']])
                mask = (await blocking(read, task['maskAssetId'])).data if task['maskAssetId'] else None
                annotation = (await blocking(read, task['annotationAssetId'])).data if task.get('annotationAssetId') else None

                async def progress(message):
                    await self._update(directory, task, phase=message)

                def frozen_model(capability):
                    config, adapter = self._model(capability, task['modelConfigIds'].get(capability))
                    frozen = task.get('modelSnapshots', {}).get(capability)
                    if frozen and any(config.get(key) != frozen.get(key) for key in ('id', 'modelId', 'url', 'protocol', 'connectionType', 'videoAdapter')):
                        raise ProjectError('已接受工具任务的模型配置已变化，请新建尝试。', 409)
                    # Runtime credentials remain separate; execution options
                    # come from acceptance, not later configuration edits.
                    return ({**frozen, 'apiKey': config.get('apiKey', '')} if frozen else config), adapter

                async def image_model(request):
                    config, adapter = frozen_model('image.edit' if request.image is not None else 'image.generate')
                    return await self._model_call(task, 'image.edit' if request.image is not None else 'image.generate',
                        lambda _: adapter.image(config, request))

                async def video_model(request, submitted):
                    capability = 'video.first_frame' if request.first_frame is not None else 'video.generate'
                    config, adapter = frozen_model(capability)

                    async def invoke(remember):
                        async def accepted(external_id):
                            await remember(external_id)
                            if submitted:
                                await submitted(external_id)
                        return await adapter.video(config, request, submitted=accepted)
                    return await self._model_call(task, capability, invoke)

                async def cutout_model(request):
                    config, adapter = frozen_model('image.cutout')
                    return await self._model_call(task, 'image.cutout', lambda _: adapter.cutout(config, request))

                async def edit_model(request, submitted):
                    config, adapter = frozen_model('video.edit')

                    return await self._model_call(task, 'video.edit',
                        lambda remember: adapter.edit_video(config, request, submitted=remember))

                async def segment_model(request):
                    config, adapter = frozen_model('image.segment')
                    return await self._model_call(task, 'image.segment', lambda _: adapter.segment(config, request))

                async def track_model(request):
                    config, adapter = frozen_model('video.matting')
                    return await self._model_call(task, 'video.matting', lambda _: adapter.track(config, request))

                async def depth_model(request):
                    config, adapter = frozen_model('video.motion_capture')
                    return await self._model_call(task, 'video.motion_capture', lambda _: adapter.depth(config, request))

                keeps_layout, edit_max_images = True, 1
                if 'image.edit' in task['requires']:
                    _, painter = frozen_model('image.edit')
                    keeps_layout = bool(getattr(painter, 'strength', False))
                    edit_max_images = int(getattr(painter, 'max_images', 1))
                limits = (4.0, 15.0)
                if 'video.edit' in task['requires']:
                    _, editor = frozen_model('video.edit')
                    limits = (4.0, float(getattr(editor, 'MAX_SECONDS', 15)))
                chat_model = None
                if 'text.chat' in task['modelConfigIds']:
                    async def chat_model(request):
                        config, adapter = frozen_model('text.chat')
                        return await self._model_call(task, 'text.chat', lambda _: adapter.chat(config, request))

                context = ToolContext(sources=sources, mask=mask, boxes=task['boxes'], parameters=task['parameters'],
                                      image_model=image_model, video_model=video_model, progress=progress, cutout_model=cutout_model,
                                      edit_model=edit_model, edit_seconds=limits, chat_model=chat_model,
                                      segment_model=segment_model, track_model=track_model, edit_keeps_layout=keeps_layout,
                                      annotation=annotation, edit_max_images=edit_max_images,
                                      segment_available='image.segment' in task['requires'], depth_model=depth_model)
                outputs = await spec.recipe(context)
                # Preserve already-produced bytes even if cancellation arrives
                # during registration. Each asset is checkpointed independently.
                async def preserve():
                    await self._update(directory, task, phase='正在保存结果')
                    saved = list(self.get(task['projectId'], task['id'])['outputs'])
                    for index, output in enumerate(outputs):
                        asset_id = str(uuid5(UUID(task['id']), f'output-{index}'))
                        asset = await blocking(self.assets.import_output, task, asset_id,
                                               with_extension(output.title, output.suffix), output.data)
                        saved.append({name: asset.get(name) for name in ('id', 'kind', 'name', 'type', 'width', 'height', 'durationMs')}
                                     | {'title': output.title, 'canvasItemId': output_item_id(task, index, output.kind)})
                        await self._update(directory, task, outputs=list(saved))
                saving = asyncio.create_task(preserve())
                try:
                    await asyncio.shield(saving)
                except asyncio.CancelledError:
                    await saving
                    raise
                await self._update(directory, task, status='succeeded', localState='stopped', phase=None, finishedAt=_now())
                if task.get('cancelRequested'):
                    await self._stopped(task['projectId'], task['id'])
        except asyncio.CancelledError:
            await self._stopped(task['projectId'], task['id'])
            raise
        except ProjectError as failure:
            current = self.get(task['projectId'], task['id'])
            if current.get('cancelRequested'):
                await self._stopped(task['projectId'], task['id'])
            else:
                await self._update(directory, task, status='failed', localState='stopped', phase=None, error=str(failure), finishedAt=_now())
        except Exception:  # noqa: BLE001 — a recipe bug must still end the task visibly.
            current = self.get(task['projectId'], task['id'])
            if current.get('cancelRequested') or self.closing:
                await self._stopped(task['projectId'], task['id'])
            else:
                await self._update(directory, task, status='failed', localState='stopped', phase=None, error='工具执行出错，请检查素材和参数后重试。', finishedAt=_now())
            raise
        finally:
            MODEL_JOB_CONTEXT.reset(trace_token)
