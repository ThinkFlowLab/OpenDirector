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
from opendirector.infrastructure.local_projects import child, read_json, write_json
from opendirector.integrations.http_settings import MODEL_JOB_CONTEXT
from opendirector.integrations.model_adapters import adapter_for, capabilities_of
from opendirector.media import processing as media
from opendirector.media.filenames import with_extension

ACTIVE = {'queued', 'running'}
MAX_SOURCES = 20


def _now():
    return datetime.now(timezone.utc).isoformat()


def _model_label(config):
    return config['modelId'].rsplit('/', 1)[-1] or config['modelId']


def output_item_id(task, index, kind):
    canvas = task.get('canvas') or {}
    if index == 0 and canvas.get('targetNodeId') and canvas.get('targetKind') == kind:
        return canvas['targetNodeId']
    return str(uuid5(UUID(task['id']), f'canvas-output-{index}'))


class ToolTasks:
    def __init__(self, store, configs, assets, *, transport=None, poll_interval=3, concurrency=2, projects=None):
        self.store, self.configs, self.assets = store, configs, assets
        self.transport, self.poll_interval = transport, poll_interval
        self.jobs: dict[tuple[str, str], asyncio.Task] = {}
        self.remote: dict[tuple[str, str], tuple[dict, str]] = {}
        self.limit = asyncio.Semaphore(concurrency)
        self.projects = projects
        self.accepting = set()

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
            if self.projects is not None:
                return media.open_image(self.assets.read_bytes(project_id, source_id))
            return media.open_image(child(child(directory, 'assets'), source_id).read_bytes())

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

    def _folder(self, directory):
        folder = child(directory, 'tool-tasks')
        folder.mkdir(exist_ok=True)
        return folder

    def _directory(self, project_id, session=None):
        with self.store.transaction() as db:
            if self.projects is not None:
                self.projects._recover()
                path, _, _ = self.projects._load(db, project_id)
                if session is not None:
                    self.projects._lease(db, project_id, path, session)
                return path
            return self.store._owner(db, project_id, session)

    def list(self, project_id):
        directory = self._directory(project_id)
        tasks = [self.get(project_id, path.stem) for path in self._folder(directory).glob('*.json')]
        return sorted(tasks, key=lambda task: (task['createdAt'], task['id']), reverse=True)

    def placement(self, project_id, task_id, state, session):
        # Serialize acknowledgement with task writes/project moves. This never
        # adopts a GenerationSpec result or changes a terminal execution state.
        with self.store.transaction():
            directory = self._directory(project_id, session)
            task = self.get(project_id, task_id)
            if task['status'] != 'succeeded':
                raise ProjectError('工具任务尚未完成。', 409)
            if task.get('placement') == 'placed':
                return task
            task['placement'] = state
            self._write(directory, task)
            return task

    def _write(self, directory, task):
        write_json(child(self._folder(directory), task['id'] + '.json'), task)

    def get(self, project_id, task_id, session=None):
        identifier(project_id)
        identifier(task_id)
        path = child(self._folder(self._directory(project_id, session)), task_id + '.json')
        if not path.is_file():
            raise ProjectError('工具任务不存在。', 404)
        task = read_json(path)
        for index, output in enumerate(task.get('outputs', [])):
            # Canvas items and assets occupy different project identities.
            output.setdefault('canvasItemId', output_item_id(task, index, output['kind']))
        if task['status'] in ACTIVE and (project_id, task_id) not in self.jobs and (project_id, task_id) not in self.accepting:
            # The service restarted mid-run; the work cannot resume.
            task.update(status='interrupted', phase=None, error='服务重启，任务已中断，请重新提交。', finishedAt=_now())
            self._write(path.parent.parent, task)
        if 'sourceFingerprint' not in task and task.get('sourceAssetIds'):
            records = self.assets._records(path.parent.parent, project_id)
            source = records.get(task['sourceAssetIds'][0], {})
            task.update(sourceFingerprint=source.get('fingerprint'), sourceKind=source.get('kind'))
        return task

    # Submission ----------------------------------------------------------------

    def _prepare(self, project_id, value, session):
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
        path = child(self._folder(directory), task_id + '.json')
        if path.is_file():
            existing = read_json(path)
            if (existing['tool'] != spec.id or existing['sourceAssetIds'] != source_ids
                    or existing['parameters'] != parameters or existing.get('maskAssetId') != mask_id
                    or existing.get('boxes', []) != (value.get('boxes') or [])
                    or existing.get('canvas') != value.get('canvas')
                    or existing.get('annotationAssetId') != annotation_id
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
        task = {'schemaVersion': 1, 'id': task_id, 'projectId': project_id, 'tool': spec.id, 'status': 'queued', 'phase': '排队中',
                'sourceAssetIds': source_ids, 'maskAssetId': mask_id, 'annotationAssetId': annotation_id,
                'boxes': value.get('boxes') or [], 'parameters': parameters,
                'modelConfigIds': {item: chosen[item] for item in needs if chosen.get(item)}, 'requestedModelConfigIds': chosen, 'requires': list(needs),
                'outputs': [], 'error': None, 'createdAt': _now(), 'finishedAt': None,
                'canvas': canvas, 'sourceFingerprint': records[source_ids[0]]['fingerprint'],
                'sourceKind': records[source_ids[0]]['kind'], 'placement': 'pending'}
        self._write(directory, task)
        return task, directory, records

    async def submit(self, project_id, value, session):
        key = (project_id, identifier(str(value['id'])))
        self.accepting.add(key)
        try:
            task, directory, records = await asyncio.to_thread(self._prepare, project_id, value, session)
            if records is not None and key not in self.jobs:
                job = asyncio.create_task(self._run(task, directory, records))
                self.jobs[key] = job
                job.add_done_callback(lambda done: self.jobs.pop(key, None) if self.jobs.get(key) is done else None)
            return task
        finally:
            self.accepting.discard(key)

    async def _update(self, directory, task, **changes):
        task.update(changes)
        await asyncio.to_thread(self._write, directory, task)

    async def _run(self, task, directory, records):
        key = (task['projectId'], task['id'])
        spec = TOOLS[task['tool']]
        trace_token = MODEL_JOB_CONTEXT.set((str(task['projectId']), str(task['id'])))
        try:
            async with self.limit:
                await self._update(directory, task, status='running', phase='准备素材')

                def read(asset_id):
                    record = records[asset_id]
                    return Source(record['kind'], child(child(directory, 'assets'), asset_id).read_bytes(), record['name'])
                sources = await asyncio.to_thread(lambda: [read(item) for item in task['sourceAssetIds']])
                mask = (await asyncio.to_thread(read, task['maskAssetId'])).data if task['maskAssetId'] else None
                annotation = (await asyncio.to_thread(read, task['annotationAssetId'])).data if task.get('annotationAssetId') else None

                async def progress(message):
                    await self._update(directory, task, phase=message)

                async def image_model(request):
                    config, adapter = self._model('image.edit' if request.image is not None else 'image.generate',
                                                  task['modelConfigIds'].get('image.edit' if request.image is not None else 'image.generate'))
                    return await adapter.image(config, request)

                async def video_model(request, submitted):
                    capability = 'video.first_frame' if request.first_frame is not None else 'video.generate'
                    config, adapter = self._model(capability, task['modelConfigIds'].get(capability))

                    async def remember(external_id):
                        self.remote[key] = (config, external_id)
                        if submitted:
                            await submitted(external_id)
                    return await adapter.video(config, request, submitted=remember)

                async def cutout_model(request):
                    config, adapter = self._model('image.cutout', task['modelConfigIds'].get('image.cutout'))
                    return await adapter.cutout(config, request)

                async def edit_model(request, submitted):
                    config, adapter = self._model('video.edit', task['modelConfigIds'].get('video.edit'))

                    async def remember(external_id):
                        self.remote[key] = (config, external_id)
                    return await adapter.edit_video(config, request, submitted=remember)

                async def segment_model(request):
                    config, adapter = self._model('image.segment', task['modelConfigIds'].get('image.segment'))
                    return await adapter.segment(config, request)

                async def track_model(request):
                    config, adapter = self._model('video.matting', task['modelConfigIds'].get('video.matting'))
                    return await adapter.track(config, request)

                keeps_layout, edit_max_images = True, 1
                if 'image.edit' in task['requires']:
                    _, painter = self._model('image.edit', task['modelConfigIds'].get('image.edit'))
                    keeps_layout = bool(getattr(painter, 'strength', False))
                    edit_max_images = int(getattr(painter, 'max_images', 1))
                limits = (4.0, 15.0)
                if 'video.edit' in task['requires']:
                    _, editor = self._model('video.edit', task['modelConfigIds'].get('video.edit'))
                    limits = (4.0, float(getattr(editor, 'MAX_SECONDS', 15)))
                chat_model = None
                if self.providers().get('text.chat'):
                    async def chat_model(request):
                        config, adapter = self._model('text.chat', task['modelConfigIds'].get('text.chat'))
                        return await adapter.chat(config, request)

                context = ToolContext(sources=sources, mask=mask, boxes=task['boxes'], parameters=task['parameters'],
                                      image_model=image_model, video_model=video_model, progress=progress, cutout_model=cutout_model,
                                      edit_model=edit_model, edit_seconds=limits, chat_model=chat_model,
                                      segment_model=segment_model, track_model=track_model, edit_keeps_layout=keeps_layout,
                                      annotation=annotation, edit_max_images=edit_max_images,
                                      segment_available='image.segment' in task['requires'])
                outputs = await spec.recipe(context)
                await progress('正在保存结果')
                saved = []
                for index, output in enumerate(outputs):
                    asset_id = str(uuid5(UUID(task['id']), f'output-{index}'))
                    if hasattr(self.assets, 'import_output'):
                        asset = await asyncio.to_thread(self.assets.import_output, task, asset_id,
                                                       with_extension(output.title, output.suffix), output.data)
                    else:
                        asset = await asyncio.to_thread(self.assets.import_file, task['projectId'], asset_id,
                                                        with_extension(output.title, output.suffix), output.data, None, source='generated')
                    saved.append({name: asset.get(name) for name in ('id', 'kind', 'name', 'type', 'width', 'height', 'durationMs')}
                                 | {'title': output.title, 'canvasItemId': output_item_id(task, index, output.kind)})
                await self._update(directory, task, status='succeeded', phase=None, outputs=saved, finishedAt=_now())
        except asyncio.CancelledError:
            remote = self.remote.get(key)
            if remote:
                config, external_id = remote
                try:
                    await adapter_for(config, self.transport).cancel_video(config, external_id)
                except (ProjectError, GenerationError):
                    pass
            await self._update(directory, task, status='cancelled', phase=None, error='已取消。', finishedAt=_now())
            raise
        except ProjectError as failure:
            await self._update(directory, task, status='failed', phase=None, error=str(failure), finishedAt=_now())
        except Exception:  # noqa: BLE001 — a recipe bug must still end the task visibly.
            await self._update(directory, task, status='failed', phase=None, error='工具执行出错，请检查素材和参数后重试。', finishedAt=_now())
            raise
        finally:
            MODEL_JOB_CONTEXT.reset(trace_token)
            self.remote.pop(key, None)

    async def cancel(self, project_id, task_id, session):
        task = await asyncio.to_thread(self.get, project_id, task_id, session)
        job = self.jobs.get((project_id, task_id))
        if job and not job.done():
            job.cancel()
            try:
                await job
            except asyncio.CancelledError:
                pass
            except Exception:  # noqa: BLE001 — the failure is already recorded on the task.
                pass
            directory = self._directory(project_id, session)
            saved = read_json(child(self._folder(directory), task_id + '.json'))
            if saved['status'] in ACTIVE:
                saved.update(status='cancelled', phase=None, error='已取消。', finishedAt=_now())
                self._write(directory, saved)
        return await asyncio.to_thread(self.get, project_id, task_id, session)

    async def close(self):
        for job in list(self.jobs.values()):
            job.cancel()
        await asyncio.gather(*self.jobs.values(), return_exceptions=True)
