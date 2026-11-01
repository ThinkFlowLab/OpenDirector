"""Shared manual/Agent generation operations with durable task receipts."""

import asyncio
from contextlib import nullcontext
import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
import re
from uuid import UUID, uuid5

import anyio
from pydantic import ValidationError

from opendirector.domain.references import replace_inputs
from opendirector.infrastructure.canvas_references import resolve_inputs

from opendirector.domain.projects import ProjectError, identifier
from opendirector.domain.canvas import CanvasNode, CanvasState, lock_role
from opendirector.domain.generation import GenerationError, GenerationFailure
from opendirector.domain.input_rules import input_rules
from opendirector.domain.video_output import apply_video_resolution
from opendirector.infrastructure.canvas import CanvasProjects
from opendirector.infrastructure.app_settings import AppSettings
from opendirector.infrastructure.canvas_assets import require_node_references
from opendirector.infrastructure.local_projects import child
from opendirector.infrastructure.execution import read_generation_task
from opendirector.infrastructure.generation_results import GenerationResults
from opendirector.infrastructure.adoption import decision, fingerprints, node_basis, reason
from opendirector.integrations.http_settings import MODEL_JOB_CONTEXT
from opendirector.integrations.providers import GenerationProviders
from opendirector.integrations.fasth3 import video_parameters, finalize_video_edit
from opendirector.integrations.generation_errors import transport_failure
from opendirector.media.filenames import with_extension


ACTIVE = {"queued", "running"}


def _self_hosted_video(task):
    profile = (task.get('referenceInputs') or {}).get('profile', '')
    return task['kind'] == 'video' and (task.get('protocol') == 'vllm_omni' or profile.startswith('vllm-omni-h3'))


def _execution_timeout(task):
    return 4 * 3600 if _self_hosted_video(task) else 1800


@dataclass
class GenerationJob:
    future: asyncio.Task
    project_id: str
    directory: str


class Generation:
    def __init__(self, store, configs, provider=None):
        self.store, self.configs = store, configs
        self.settings = AppSettings(store.repository)
        self.canvas = CanvasProjects(store)
        self.provider = provider or GenerationProviders(store)
        self.jobs: dict[str, GenerationJob] = {}
        self.accepting: dict[tuple[str, str], asyncio.Task] = {}
        self.cancelled = set()
        self.committing = set()
        self.limit = asyncio.Semaphore(2)
        self.remote_limits: dict[str, asyncio.Lock] = {}

    def _prepare(self, project_id, node_id, value, session, *, create=None, adoption_policy='if_current'):
        identifier(project_id)
        identifier(node_id)
        task_id = identifier(str(value["id"]))
        with self.store.transaction() as db:
            directory = self.store._owner(db, project_id, session)
            folder = child(directory, "tasks")
            path = child(folder, task_id + ".json")
            if path.exists():
                old = read_generation_task(path)
                if old["nodeId"] != node_id or old["modelConfigId"] != str(value["modelConfigId"]):
                    raise ProjectError("生成任务标识已使用。", 409)
                return old, str(directory), None
            state, records = self.canvas._sync(directory, project_id)
            if create:
                if any(item["id"] == node_id for item in state["nodes"]):
                    raise ProjectError("节点标识已使用。", 409)
                node = CanvasNode(id=node_id, kind=create["kind"], **self.canvas.next_position(state, create['kind'], records)).model_dump(mode="json")
                state["nodes"].append(node)
            else:
                node = self.canvas._node(state, node_id)
            lock_role(node, 'generation')
            if node["revision"] != value["expectedRevision"]:
                raise ProjectError("节点内容已变化，请重新加载后生成。", 409)
            if any(task["nodeId"] == node_id and task["status"] in ACTIVE for task in self.canvas._tasks(directory)):
                raise ProjectError("该节点正在生成，请等待或取消当前任务。", 409)
            updates = dict(value.get("inputs") or {})
            # Output length and canvas belong to the task, not to the node inputs.
            output = {key: updates.pop(key) for key in ('durationSeconds', 'aspectRatio', 'resolution', 'voice', 'thinking', 'maxTokens') if key in updates}
            output = {key: value for key, value in output.items() if value is not None}
            try:
                candidate = CanvasNode.model_validate(replace_inputs(node, {**updates, **({"modelConfigId": str(value["modelConfigId"])} if value.get("inputs") is not None else {})}, records)).model_dump(mode="json")
            except ValidationError:
                raise ProjectError("生成输入无效，请检查正文、名称和参考资产。") from None
            if candidate != node:
                candidate["revision"] += 1
            if set(candidate['referenceIds']) - records.keys():
                raise ProjectError('节点引用的资产不存在。', 409)
            bound = {part['assetId'] for part in candidate.get('promptContent') or [] if part.get('nodeId')}
            require_node_references(directory, {**candidate, 'referenceIds': [key for key in candidate['referenceIds'] if key not in bound]}, retained=node['referenceIds'])
            node.update(candidate)
            node.update(resolve_inputs(node, state, records, strict=True))
            config = self.configs.resolve(str(value["modelConfigId"]), "agent" if node["kind"] == "text" else node["kind"])
            if input_rules(config)['profile'] == 'vllm-omni-segmentation':
                raise ProjectError('视觉分割模型仅用于选区、分割和抠像，请选择生成模型。', 409)
            self.provider.validate(node["kind"], config)
            if not node["prompt"].strip():
                raise ProjectError("请输入生成要求；音频节点中请输入要合成的文字。")
            self.canvas._check_assets(node, records)
            require_node_references(directory, node)
            reference_inputs = None
            if hasattr(self.provider, 'prepare_inputs'):
                reference_inputs = self.provider.prepare_inputs(project_id, node, config)
            elif hasattr(self.provider, "validate_inputs"):
                self.provider.validate_inputs(project_id, node)
            try:
                CanvasState.model_validate(state)
            except ValidationError:
                raise ProjectError("画布节点数量已达上限或输入无效。", 409) from None
            task = {"schemaVersion": 1, "id": task_id, "projectId": project_id, "nodeId": node_id, "kind": node["kind"], "status": "queued",
                    "modelConfigId": config["id"], "model": config["modelId"], "baseURL": config["url"], "prompt": node["prompt"], "promptContent": node.get("promptContent"),
                    "title": node["title"].strip() or node["prompt"].strip().splitlines()[0][:24] + "｜" + {"text": "文本", "image": "图片", "video": "视频", "audio": "旁白"}[node["kind"]], "referenceIds": node["referenceIds"], "inputRevision": node["revision"], "externalTaskId": None,
                    "assetId": None, "adopted": False, "error": None, "errorDetails": None,
                    "createdAt": datetime.now(timezone.utc).isoformat(), "resumeAllowed": False,
                    "phase": "queued", "recovery": "submit"}
            if value.get('logicalNodeId'):
                task['logicalNodeId'] = value['logicalNodeId']
            task['adoptionPolicy'] = adoption_policy
            task['videoMode'] = node['videoMode']
            task['referenceInputs'] = reference_inputs
            task['inputSnapshot'] = {'node': node_basis(node), 'references': fingerprints(records, node['referenceIds'])}
            task["parameters"] = {"image": {"size": "2K", "response_format": "url", "output_format": "png"},
                "video": {"duration": 5, "ratio": "adaptive", "generate_audio": True},
                "audio": {"speaker": "zh_female_vv_uranus_bigtts", "audio_params": {"format": "mp3", "sample_rate": 24000}},
                "text": {"thinking": "auto", "max_tokens": 8192}}[node["kind"]]
            if node['kind'] == 'text':
                thinking, tokens = output.get('thinking', 'auto'), output.get('maxTokens', 8192)
                if thinking not in {'auto', 'low', 'medium', 'high'} or isinstance(tokens, bool) or not isinstance(tokens, int) or not 1 <= tokens <= 32768:
                    raise ProjectError('Agent 思考程度或最大输出长度无效。')
                task['parameters'].update(thinking=thinking, max_tokens=tokens)
            rules = input_rules(config)
            capabilities = rules.get('videoCapabilities')
            explicit_duration = output.get('durationSeconds')
            selected_duration = explicit_duration
            if selected_duration is None and config.get('videoCapabilities'):
                selected_duration = capabilities['defaultDuration']
            if node['kind'] == 'video' and rules['profile'] == 'fasth3-omni':
                # Only an explicit selection may override the prompt and the source
                # clip length; a declared default must not truncate an edit.
                task['parameters'] = video_parameters(node, records, duration_seconds=explicit_duration)
            elif node['kind'] == 'video' and rules['profile'] == 'standard-video':
                task['parameters'] = {}
            if node['kind'] == 'video' and selected_duration is not None:
                task['parameters']['duration'] = selected_duration
            task['protocol'] = config.get('protocol')
            if node['kind'] == 'video' and output and rules['profile'] != 'fasth3-omni':
                if 'durationSeconds' in output:
                    task['parameters']['duration'] = output['durationSeconds']
                if 'aspectRatio' in output:
                    task['parameters']['ratio'] = output['aspectRatio']
            if node['kind'] == 'video':
                apply_video_resolution(task['parameters'], node, records, config, output)
            if node['kind'] == 'audio' and 'voice' in output and config.get('protocol') == 'openai':
                task['parameters']['voice'] = output['voice']
            if node['kind'] in {'image', 'video'} and config.get('protocol') != 'vllm_omni':
                # Snapshot once, before the durable task is accepted. Recovery
                # and idempotent submissions keep the original parameters.
                task['parameters']['watermark'] = not self.settings.get()['removeWatermark']
            node["taskId"] = task_id
            # All rejection checks precede any input or task write. Atomic JSON
            # replacement preserves the old canvas if its write fails.
            self.canvas.task_write(project_id, task, str(directory))
            try:
                self.canvas._write(directory, state)
            except BaseException:
                path.unlink(missing_ok=True)
                raise
            return task, str(directory), config

    async def submit(self, project_id, node_id, value, session, *, create=None, adoption_policy='if_current'):
        key = (project_id, str(value["id"]))
        pending = self.accepting.get(key)
        if pending is None:
            async def accept():
                task, pinned, config = await asyncio.to_thread(self._prepare, project_id, node_id, value, session, create=create, adoption_policy=adoption_policy)
                if config is not None:
                    self._launch(task, pinned, config)
                return task
            pending = asyncio.create_task(accept())
            self.accepting[key] = pending
            def done(future):
                if self.accepting.get(key) is future:
                    self.accepting.pop(key, None)
                if not future.cancelled():
                    future.exception()  # Retrieve failures even if the caller disconnected.
            pending.add_done_callback(done)
        # A disconnect/stop must not orphan a task accepted by the worker thread.
        return await asyncio.shield(pending)

    def _launch(self, task, pinned, config, mode='submit'):
        old = self.jobs.get(task['id'])
        if old and not old.future.done():
            return
        future = asyncio.create_task(self._run(dict(task), pinned, config, mode))
        self.jobs[task["id"]] = GenerationJob(future, task["projectId"], pinned)
        def done(completed):
            if self.jobs.get(task['id']) and self.jobs[task['id']].future is completed:
                self.jobs.pop(task['id'], None)
            if not completed.cancelled():
                completed.exception()
        future.add_done_callback(done)

    def _result_asset(self, task, directory):
        asset_id = str(uuid5(UUID(task['id']), 'output'))
        with self.store.transaction():
            asset = self.canvas.assets._records(Path(directory), task['projectId']).get(asset_id)
            if asset is None:
                return None
            if asset.get('generationTaskId') != task['id']:
                raise ProjectError('已有结果与生成任务不一致，请保留素材并核对。', 409)
            path = child(child(Path(directory), 'assets'), asset_id)
            if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != asset['fingerprint'].removeprefix('sha256:'):
                raise ProjectError('已保存的结果文件缺失或变化，不会重新生成。', 409)
            return asset

    @staticmethod
    def _technical_check(asset):
        keys = ('kind', 'type', 'size', 'fingerprint', 'width', 'height', 'durationMs', 'frameRate', 'hasAudio', 'sampleRate', 'channels')
        return {'status': 'passed', 'facts': {key: asset[key] for key in keys if asset.get(key) is not None},
                'message': '文件已通过格式和可读取性检查；创意效果、人物一致性及内容质量仍需人工确认。', 'humanReviewRequired': True}

    def _place_result(self, task, directory, asset):
        """The same guards apply during completion, local recovery and continue."""
        state = self.canvas._read(directory)
        node = next((item for item in state['nodes'] if item['id'] == task['nodeId']), None)
        records = self.canvas.assets._records(directory, task['projectId'])
        held = reason(task, directory, node, records, self.configs)
        adopted = self.canvas.attach(task['projectId'], task['nodeId'], asset['id'], adopt=held is None)
        task['adopted'] = adopted
        task['canvasAdoption'] = decision(held or (None if adopted else 'canvas_held'))

    def adopt_result(self, project_id, task_id):
        with self.store.transaction() as db:
            directory = self.store._owner(db, project_id)
            task = read_generation_task(child(child(directory, 'tasks'), task_id + '.json'))
            asset = self._result_asset(task, directory)
            if task['status'] != 'succeeded' or asset is None:
                raise ProjectError('候选结果尚未保存完成，请先核对原任务。', 409)
            task['technicalCheck'] = task.get('technicalCheck') or self._technical_check(asset)
            self._place_result(task, directory, asset)
            self.canvas.task_write(project_id, task, str(directory))
            return task

    def recovery(self, task, directory):
        """One decision table for startup and same-task canvas recovery."""
        if task['status'] == 'succeeded':
            return 'done'
        if self._result_asset(task, directory):
            return 'local'
        cache = GenerationResults(directory, task['id'])
        metadata = cache.metadata()
        if metadata and child(cache.directory, 'output').is_file():
            return 'local'
        details = task.get('errorDetails') or {}
        if details.get('providerStatus') in {'failed', 'cancelled', 'expired'}:
            return 'retry'  # The original remote task is confirmed terminal.
        # Requery video tasks to refresh possibly expired result locators.
        if task['kind'] == 'video' and task.get('externalTaskId'):
            return 'remote'
        if metadata and metadata.get('url'):
            return 'download'
        if task.get('phase') == 'queued':
            return 'submit'  # Proven durable checkpoint before any provider call.
        if (details.get('stage') == 'submit' and details.get('httpStatus') in {400, 401, 402, 403, 404, 413, 422, 429}
                and details.get('category') not in {'submission_unknown', 'local', 'protocol'}):
            return 'retry'  # An explicit continuation may create a new attempt.
        return 'review'


    async def recover(self, project_id, task_id, session=None):
        accepting = self.accepting.get((project_id, task_id))
        if accepting:
            await asyncio.shield(accepting)
        with self.store.transaction() as db:
            directory = self.store._owner(db, project_id, session)
            path = child(child(directory, 'tasks'), identifier(task_id) + '.json')
            if not path.is_file():
                raise ProjectError('生成任务不存在。', 404)
            task = read_generation_task(path)
            job = self.jobs.get(task_id)
            if job and not job.future.done():
                return {**task, 'status': 'running'} if task['status'] not in ACTIVE else task
            try:
                mode = self.recovery(task, directory)
                config = None
                if mode in {'submit', 'remote'}:
                    config = self.configs.resolve(task['modelConfigId'], 'agent' if task['kind'] == 'text' else task['kind'])
                    if config['url'] != task['baseURL'] or config['modelId'] != task['model'] or task.get('protocol') and config.get('protocol') != task['protocol']:
                        raise ProjectError('原模型配置已变化，请恢复原配置后再核对任务。', 409)
            except (ProjectError, OSError) as failure:
                task.update(status='interrupted', resumeAllowed=False, recovery='review',
                            error=str(failure) if isinstance(failure, ProjectError) else '读取本地结果失败，请检查项目和磁盘。')
                self.canvas.task_write(project_id, task, str(directory))
                return task
            if mode in {'retry', 'done'}:
                return task
            if mode == 'review':
                task.update(status='interrupted', resumeAllowed=False, recovery='review',
                    error='原请求是否已被接收或完成尚无法确认。请核对供应商任务；不会自动重新生成。')
                self.canvas.task_write(project_id, task, str(directory))
                return task
            task.update(resumeAllowed=True, recovery=mode)
            self.canvas.task_write(project_id, task, str(directory))
            # Queries may observe this receipt before the worker gets CPU time.
            # Persist queued after explicitly permitting this same-task recovery.
            task['status'] = 'queued'
            self.canvas.task_write(project_id, task, str(directory))
            self._launch(task, str(directory), config, mode)
            return task

    async def _run(self, task, pinned, config, mode='submit'):
        stage = 'save'
        cache = GenerationResults(pinned, task['id'])
        trace_token = MODEL_JOB_CONTEXT.set((str(task['projectId']), str(task['id'])))
        async def save():
            # Cancelling to_thread does not stop the underlying write. Drain it
            # before saving the terminal state so an old running receipt cannot
            # overwrite a later cancellation.
            pending = asyncio.create_task(asyncio.to_thread(self.canvas.task_write, task["projectId"], dict(task), pinned))
            try:
                await asyncio.shield(pending)
            except asyncio.CancelledError:
                await pending
                raise

        async def submitted(external_id):
            nonlocal stage
            task["externalTaskId"] = external_id
            task['phase'] = 'poll'
            stage = 'save'
            await save()
            stage = 'submit'

        async def result_ready(suffix, url):
            nonlocal stage
            stage = 'save'
            task['phase'] = 'download'
            await asyncio.to_thread(cache.locator, suffix, url)
            await save()
            stage = 'download'

        try:
            remote_limit = (self.remote_limits.setdefault(task['baseURL'].rstrip('/'), asyncio.Lock())
                            if _self_hosted_video(task) else nullcontext())
            # Wait outside the global worker limit and execution timeout. A
            # queued task remains a proven checkpoint before remote submission.
            async with remote_limit, self.limit, asyncio.timeout(_execution_timeout(task)):
                task.update(status="running", resumeAllowed=False, error=None, errorDetails=None)
                await save()
                asset = await asyncio.to_thread(self._result_asset, task, pinned)
                cached = await asyncio.to_thread(cache.data) if asset is None else None
                if asset is None and cached is None:
                    if mode == 'local':
                        raise ProjectError('本地结果缺失，请保留任务并核对；不会重新生成。', 409)
                    if mode == 'download':
                        stage = 'download'
                        metadata = cache.metadata()
                        suffix, data = await self.provider.resume_result(config, metadata['suffix'], metadata['url'])
                    else:
                        stage = 'poll' if task.get('externalTaskId') else 'submit'
                        task['phase'] = stage
                        await save()  # Mark submission before entering any provider call.
                        if hasattr(self.provider, 'resume_result'):
                            suffix, data = await self.provider.generate(config, task, submitted, result_ready=result_ready)
                        else:
                            suffix, data = await self.provider.generate(config, task, submitted)
                    suffix, data = await asyncio.to_thread(finalize_video_edit, self.store, task, suffix, data)
                elif cached:
                    suffix, data = cached
                # Preserve complete bytes before catalog/link writes. Cancellation
                # waits for local commit; recovery reconciles partial commits.
                with anyio.CancelScope(shield=True):
                    if task["id"] in self.cancelled:
                        raise asyncio.CancelledError()
                    self.committing.add(task["id"])
                    stage = 'save'
                    if asset is None and cached is None:
                        task['phase'] = 'save'
                        await asyncio.to_thread(cache.save, suffix, data)
                        await save()
                    try:
                        asset = await asyncio.to_thread(self._commit_output, task, pinned, suffix if asset is None else None, data if asset is None else None)
                    except BaseException:
                        if task.get('phase') == 'adopt':
                            stage = 'adopt'
                        raise
                    task.update(status="succeeded", assetId=asset["id"], phase='complete', recovery='done')
        except asyncio.CancelledError:
            task["status"] = "cancelled" if task["id"] in self.cancelled else "interrupted"
            task['resumeAllowed'] = False
            task["error"] = "已停止本地生成；已提交任务和费用需在服务控制台核对。" if task["status"] == "cancelled" else "服务中断；有供应商任务 ID 的视频将在重启后查询，其他任务不会自动重复提交。"
            if task["status"] == "cancelled" and task["externalTaskId"]:
                try:
                    cancel_config = config or self.configs.resolve(task['modelConfigId'], task['kind'])
                    if cancel_config['url'] != task['baseURL'] or cancel_config['modelId'] != task['model'] or task.get('protocol') and cancel_config.get('protocol') != task['protocol']:
                        raise ProjectError('原模型配置已变化，供应商取消未确认。', 409)
                    await self.provider.cancel(cancel_config, task["externalTaskId"])
                    task["error"] = "已请求取消供应商任务，实际取消与费用以服务控制台为准。"
                except (ProjectError, OSError) as failure:
                    task["error"] = "本地已停止，供应商取消未确认，请在控制台核对任务。"
                    # Cancellation confirmation is distinct from local stop.
                    # Never infer a refund or a successful remote cancellation.
                    task['errorDetails'] = (failure.details if isinstance(failure, GenerationError) else GenerationFailure(
                        category='temporary', stage='cancel', message='供应商取消未确认。',
                        suggestion='请在控制台核对原任务、取消状态及费用。')).model_dump(mode='json')
        except (ProjectError, OSError, TimeoutError) as failure:
            task["status"] = "interrupted" if isinstance(failure, TimeoutError) or getattr(failure, "status", None) in {503, 504} else "failed"
            task["error"] = (str(failure) if isinstance(failure, ProjectError) else
                "等待超过允许时长，本地已停止查询；已提交的云端任务未自动取消，请恢复原任务继续查询，或取消云端任务。"
                if isinstance(failure, TimeoutError) and task.get('externalTaskId') and stage not in {'save', 'adopt'} else
                "生成或本地保存失败，请检查服务和磁盘；不会自动重新提交。")
            if isinstance(failure, GenerationError):
                details = failure.details
                if details.stage == 'check':
                    task['technicalCheck'] = {'status': 'failed', 'facts': {}, 'message': details.message, 'humanReviewRequired': True}
            elif isinstance(failure, TimeoutError) and stage not in {'save', 'adopt'}:
                details = transport_failure('poll' if task.get('externalTaskId') else stage, timeout=True).details
            else:
                details = GenerationFailure(category='local' if stage in {'save', 'adopt'} else 'provider', stage=stage,
                    message=task['error'], suggestion='请检查本地项目、磁盘和采用状态，保留已有结果。' if stage in {'save', 'adopt'} else '请核对原任务和模型服务后再处理。')
            task['errorDetails'] = details.model_dump(mode='json')
        except Exception:
            # Do not leak provider responses, signed download URLs or credentials.
            task.update(status="failed", error="生成结果处理失败，请检查服务协议；不会自动重新提交。")
            task['errorDetails'] = GenerationFailure(category='local' if stage in {'save', 'adopt'} else 'protocol', stage=stage,
                message=task['error'], suggestion='请检查本地项目和保存结果。' if stage in {'save', 'adopt'} else '请核对原任务和接口协议。').model_dump(mode='json')
        finally:
            with anyio.CancelScope(shield=True):
                try:
                    if task['status'] != 'succeeded':
                        try:
                            task['recovery'] = self.recovery(task, pinned)
                        except (ProjectError, OSError):
                            task['recovery'] = 'review'
                        task['resumeAllowed'] = task['recovery'] in {'submit', 'remote', 'download', 'local'}
                    await save()
                    if task['status'] == 'succeeded':
                        await asyncio.to_thread(cache.clear)
                except (OSError, ProjectError):
                    pass  # Original task receipt remains available for startup reconciliation.
            MODEL_JOB_CONTEXT.reset(trace_token)
            self.cancelled.discard(task["id"])
            self.committing.discard(task["id"])

    def _commit_output(self, task, pinned, suffix, data):
        """Storage hook shared by the legacy and unified execution runtimes."""
        asset_id = str(uuid5(UUID(task['id']), 'output'))
        with self.store.transaction() as db:
            directory = self.store._owner(db, task['projectId'])
            if str(directory) != pinned:
                raise ProjectError('项目目录发生变化，结果未写入其他位置。', 409)
            name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', task.get('title', '')).strip(' .')[:200] or f"{task['kind']}-{task['id'][:8]}"
            existing = self._result_asset(task, directory)
            result = existing or self.canvas.assets.import_file(task['projectId'], asset_id, with_extension(name, suffix), data, None,
                source='generated', generation=task, expected_kind=task['kind'])
            task['assetId'] = result['id']
            task['technicalCheck'] = self._technical_check(result)
            task['phase'] = 'adopt'
            self._place_result(task, directory, result)
            return result

    async def cancel(self, project_id, task_id, session):
        accepting = self.accepting.get((project_id, task_id))
        if accepting:
            await asyncio.shield(accepting)
        with self.store.transaction() as db:
            directory = self.store._owner(db, project_id, session)
            path = child(child(directory, "tasks"), identifier(task_id) + ".json")
            if not path.is_file():
                raise ProjectError("生成任务不存在。", 404)
            task = read_generation_task(path)
        if (task['status'] in {'interrupted', 'failed'} and task.get('externalTaskId')
                and _self_hosted_video(task) and self.recovery(task, directory) == 'remote'):
            config = self.configs.resolve(task['modelConfigId'], task['kind'])
            if config['url'] != task['baseURL'] or config['modelId'] != task['model'] or config.get('protocol') != task.get('protocol'):
                raise ProjectError('原模型配置已变化，云端取消未确认。', 409)
            trace_token = MODEL_JOB_CONTEXT.set((str(project_id), str(task_id)))
            try:
                await self.provider.cancel(config, task['externalTaskId'])
            finally:
                MODEL_JOB_CONTEXT.reset(trace_token)
            with self.store.transaction():
                current = read_generation_task(path)
                if current['status'] in {'interrupted', 'failed'} and current.get('externalTaskId') == task['externalTaskId']:
                    current.update(status='cancelled', recovery='retry', resumeAllowed=False,
                        error='已请求取消云端任务；执行中的计算会在安全边界停止。',
                        errorDetails=GenerationFailure(category='provider', stage='cancel', providerStatus='cancelled',
                            message='已请求取消云端视频任务。', suggestion='需要再次生成时，请提交新的任务。').model_dump(mode='json'))
                    self.canvas.task_write(project_id, current, str(directory))
        elif task["status"] in ACTIVE:
            self.cancelled.add(task_id)
            job = self.jobs.get(task_id)
            if job:
                if task_id not in self.committing:
                    job.future.cancel()
                await asyncio.gather(job.future, return_exceptions=True)
            current = read_generation_task(path)
            if current["status"] in ACTIVE:
                try:
                    recovery = self.recovery(current, directory)
                except (ProjectError, OSError):
                    recovery = 'review'
                current.update(status='cancelled', recovery=recovery,
                    resumeAllowed=recovery in {'submit', 'remote', 'download', 'local'},
                    error='生成已停止；如已提交，请在服务控制台核对。')
                self.canvas.task_write(project_id, current, str(directory))
            self.cancelled.discard(task_id)
        return {"ok": True}

    async def start(self):
        projects = (await asyncio.to_thread(self.store.list_projects))["projects"]
        for project in projects:
            directory = Path(project["path"])
            for task in self.canvas._tasks(directory):
                if task['status'] not in ACTIVE | {'interrupted', 'failed'}:
                    continue
                await self.recover(project['id'], task['id'])

    async def close(self):
        await asyncio.gather(*list(self.accepting.values()), return_exceptions=True)
        jobs = list(self.jobs.items())
        for task_id, job in jobs:
            if task_id not in self.committing:
                job.future.cancel()
        await asyncio.gather(*(job.future for _, job in jobs), return_exceptions=True)
        # A task cancelled before its coroutine started has no finally block.
        for task_id, job in jobs:
            if job.future.cancelled():
                task = read_generation_task(child(child(Path(job.directory), "tasks"), task_id + ".json"))
                if task["status"] in ACTIVE:
                    try:
                        recovery = self.recovery(task, job.directory)
                    except (ProjectError, OSError):
                        recovery = 'review'
                    task.update(status='interrupted', recovery=recovery,
                                resumeAllowed=recovery in {'submit', 'remote', 'download', 'local'},
                                error='服务已停止，未自动重复提交。')
                    await asyncio.to_thread(self.canvas.task_write, job.project_id, task, job.directory)
