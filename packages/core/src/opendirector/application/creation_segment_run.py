"""Persist and execute a published segment run using the existing job services."""

import asyncio
from functools import partial
import logging
from secrets import randbelow
from time import time_ns
from uuid import UUID, uuid5

from filelock import FileLock, Timeout

from opendirector.application.creation_canvas import asset_ref, current_asset
from opendirector.application.creation_segment_run_inputs import selected_segment_asset
from opendirector.application.creation_workflow_assembly import CreationWorkflowAssembly
from opendirector.domain.creation.base import digest
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.creation.validation import ContractError
from opendirector.domain.generation import GenerationFailure, vllm_remote_task_missing
from opendirector.domain.projects import ProjectError
from opendirector.ports.gateway import gateway


logger = logging.getLogger(__name__)
ACTIVE = {'queued', 'running'}
SETTLED = {'paused', 'succeeded', 'failed', 'awaiting_selection'}
UNFINISHED = ACTIVE | {'paused', 'needs_review', 'awaiting_selection'}
REVIEW_REQUIRED = {'submission_unknown', 'segment_run_job_unsettled'}


def _version(kind, obj):
    return {'objectType': kind, 'id': obj.id, 'revision': obj.revision}


def _waiting_step(item_id):
    return {'itemId': str(item_id), 'status': 'waiting', 'command': None, 'jobId': None}


def _next_target(record):
    return next((step['itemId'] for step in record['steps'] if step['status'] != 'succeeded'), 'assemble')


def _definition_id(group):
    return str(group.runDefinitionId) if group.runDefinitionId is not None else None


def _missing_job(job):
    failure = getattr(job, 'errorDetails', None)
    if not isinstance(failure, GenerationFailure):
        return False
    model = job.inputSnapshot.model
    return vllm_remote_task_missing(model.protocol, job.externalTaskId, failure.model_dump())


class PauseBoundary(Exception):
    """The next stage has not been admitted and the Run must pause."""


class SegmentRunExecutor:
    def __init__(self, projects, generation):
        self.projects = projects
        self.generation = generation
        self.assembly = CreationWorkflowAssembly(projects)
        self.directory = gateway().directory(gateway().child(projects.state_dir, 'segment-run-executions'))
        self.directory.mkdir(exist_ok=True)
        gateway().sync_directory(self.directory.parent)
        self.accepting = set()
        self.workers = {}
        self.closed = False

    def _path(self, project_id, execution_id, extension='json'):
        return gateway().child(self.directory, f'{project_id}-{execution_id}.{extension}')

    def _write(self, record):
        path = self._path(record['projectId'], record['executionId'])
        gateway().write_json(path, record)
        gateway().sync_directory(self.directory)

    def _state_lock(self, record):
        return FileLock(self._path(record['projectId'], record['executionId'], 'state.lock'), timeout=5)

    def _save(self, record, *, boundary=False):
        path = self._path(record['projectId'], record['executionId'])
        with self._state_lock(record):
            if path.exists():
                current = self._read(path)
                for key in ('pauseRequested', 'controlOperations'):
                    if key in current:
                        record[key] = current[key]
            if boundary and record.get('pauseRequested'):
                raise PauseBoundary
            self._write(record)

    async def _persist(self, record, *, boundary=False):
        pending = asyncio.create_task(asyncio.to_thread(self._save, record, boundary=boundary))
        try:
            await asyncio.shield(pending)
        except asyncio.CancelledError:
            # Keep the execution lock until the last journal write completes.
            await asyncio.gather(pending, return_exceptions=True)
            raise

    def _read(self, path):
        return gateway().read_json(gateway().child(self.directory, path.name))

    def _public(self, record, *, superseded=False):
        steps = [{key: step[key] for key in ('itemId', 'status', 'jobId')} for step in record['steps']]
        for view, step in zip(steps, record['steps']):
            for key in ('assetId', 'reusedFromExecutionId'):
                if key in step:
                    view[key] = step[key]
        status = 'pausing' if record['status'] in ACTIVE and record.get('pauseRequested') else record['status']
        target = record.get('reviewItemId') or _next_target(record)
        return {key: record[key] for key in ('executionId', 'projectId', 'groupId', 'issue', 'outputAssetId')} | {
            'status': 'superseded' if superseded else status, 'steps': steps,
            'runDefinitionId': record.get('runDefinitionId'),
            'baseExecutionId': record.get('baseExecutionId'),
            'reviewItemId': record.get('reviewItemId'),
            'candidates': record.get('candidates', []) if record.get('reviewItemId') else [],
            'nextStep': ({'kind': 'assembly'} if target == 'assemble' else {'kind': 'generation', 'itemId': target})
                if not superseded and status in {'paused', 'queued', 'running', 'pausing'} else None,
        }

    def _executions(self, project_id):
        records = [(self._read(path), path.stat().st_mtime_ns) for path in self.directory.glob(f'{project_id}-*.json')]
        return [record for record, _ in sorted(records, key=lambda pair: pair[0].get('createdAt', pair[1]), reverse=True)]

    @staticmethod
    def _superseded(executions):
        return {record['supersedesExecutionId'] for record in executions if record.get('supersedesExecutionId')}

    def _latest(self, executions, group_id, definition_id):
        superseded = self._superseded(executions)
        return next((record for record in executions if record['groupId'] == str(group_id)
                     and record.get('runDefinitionId') == definition_id
                     and record['executionId'] not in superseded), None)

    def _project_lock(self, project_id):
        return FileLock(gateway().child(self.directory, f'{project_id}.start.lock'), timeout=5)

    def _check_lease(self, project_id, session):
        with self.projects.local.transaction() as db:
            path, _ = self.projects._find(db, project_id)
            self.projects._lease(db, project_id, path, str(session) if session is not None else None)

    def _group(self, snapshot, group_id):
        group = self._canvas_group(snapshot, group_id)
        if group is None or group.runPlan is None or group.assembly is None:
            raise ProjectError('找不到已发布的分段 Run。', 404)
        return group

    @staticmethod
    def _canvas_group(snapshot, group_id):
        return next((item for item in snapshot.canvasItems if str(item.id) == str(group_id) and item.kind == 'group'), None)

    def _accept(self, project_id, group_id, operation_id, session, input_fingerprint):
        execution_id = operation_id
        self._check_lease(project_id, session)
        try:
            with self._project_lock(project_id):
                path = self._path(project_id, execution_id)
                if path.exists():
                    record = self._read(path)
                    if record['groupId'] != str(group_id) or record.get('inputFingerprint') != input_fingerprint:
                        raise ProjectError('此操作 ID 已用于不同的 Run 请求。', 409, code='command_conflict')
                    return record
                executions = self._executions(project_id)
                for record in executions:
                    if str(operation_id) in record.get('controlOperations', {}):
                        raise ProjectError('此操作 ID 已用于不同的 Run 请求。', 409, code='command_conflict')
                snapshot = self.projects.snapshot(project_id)
                group = self._group(snapshot, group_id)
                latest = self._latest(executions, group_id, _definition_id(group))
                if latest is not None and latest['status'] in UNFINISHED:
                    raise ProjectError('此 Run 有未完成的执行，请查询已有执行。', 409, code='segment_run_busy')
                record = self._new_execution(project_id, group, execution_id, input_fingerprint)
                self._save(record)
                return record
        except Timeout as error:
            raise ProjectError('此 Run 正在启动，请查询已有执行。', 409, code='segment_run_busy') from error

    def _new_execution(self, project_id, group, execution_id, input_fingerprint):
        return {
            'projectId': str(project_id), 'groupId': str(group.id), 'executionId': str(execution_id),
            'runDefinitionId': _definition_id(group),
            'createdAt': time_ns(), 'status': 'queued', 'steps': [_waiting_step(i) for i in group.runPlan.execution_order()],
            'assembly': None, 'issue': None, 'outputAssetId': None, 'inputFingerprint': input_fingerprint,
            'planFingerprint': digest(group.runPlan), 'assemblyFingerprint': digest(group.assembly),
        }

    async def _accept_and_launch(self, accept, *args):
        if self.closed:
            raise ProjectError('Run 执行服务正在关闭。', 503)

        async def accept_and_launch():
            record = await asyncio.to_thread(accept, *args)
            self._launch(record)
            return self._public(record)

        def finished(task):
            self.accepting.discard(task)
            if not task.cancelled():
                task.exception()

        continuation = asyncio.create_task(accept_and_launch())
        self.accepting.add(continuation)
        continuation.add_done_callback(finished)
        return await asyncio.shield(continuation)

    async def submit(self, project_id, group_id, operation_id, session, *, input_fingerprint=None):
        return await self._accept_and_launch(self._accept, UUID(str(project_id)), UUID(str(group_id)),
                                             UUID(str(operation_id)), session, input_fingerprint)

    def _change_control(self, project_id, group_id, session, operation_id, input_fingerprint, *, pause):
        self._check_lease(project_id, session)
        operation_id = str(operation_id)
        operation = {'pause': pause, 'inputFingerprint': input_fingerprint}
        try:
            with self._project_lock(project_id):
                executions = self._executions(project_id)
                for record in executions:
                    previous = record.get('controlOperations', {}).get(operation_id)
                    if previous is not None:
                        if previous == operation and record['groupId'] == str(group_id):
                            return record
                        raise ProjectError('此操作 ID 已用于不同的 Run 请求。', 409, code='command_conflict')
                    if record['executionId'] == operation_id:
                        raise ProjectError('此操作 ID 已用于不同的 Run 请求。', 409, code='command_conflict')
                group = self._group(self.projects.snapshot(project_id), group_id)
                record = self._latest(executions, group_id, _definition_id(group))
                if record is None:
                    raise ProjectError('此 Run 没有可暂停或继续的执行。', 409, code='segment_run_no_execution')
                if pause:
                    return self._write_control(record, operation_id, operation)
                if record['status'] != 'paused':
                    raise ProjectError('此 Run 尚未暂停。', 409, code='segment_run_not_paused')
                # The pausing worker owns this lock until its final journal write completes.
                with FileLock(self._path(project_id, record['executionId'], 'lock'), timeout=5):
                    return self._write_control(record, operation_id, operation)
        except Timeout as error:
            raise ProjectError('此 Run 正在处理，请稍后重试。', 409, code='segment_run_busy') from error

    def _write_control(self, record, operation_id, operation):
        with self._state_lock(record):
            record = self._read(self._path(record['projectId'], record['executionId']))
            if operation['pause']:
                if record['status'] not in ACTIVE | {'paused'}:
                    raise ProjectError('此 Run 没有可暂停或继续的执行。', 409, code='segment_run_no_execution')
                record['pauseRequested'] = True
            else:
                record.update(status='queued', pauseRequested=False, stepTarget=None)
            record.setdefault('controlOperations', {})[operation_id] = operation
            self._write(record)
            return record

    async def pause(self, project_id, group_id, session, *, operation_id, input_fingerprint):
        return await self._accept_and_launch(partial(self._change_control, pause=True), UUID(str(project_id)),
                                             UUID(str(group_id)), session, operation_id, input_fingerprint)

    async def resume(self, project_id, group_id, session, *, operation_id, input_fingerprint):
        return await self._accept_and_launch(partial(self._change_control, pause=False), UUID(str(project_id)),
                                             UUID(str(group_id)), session, operation_id, input_fingerprint)

    async def reconcile(self, project_id, payload, session, *, operation_id, input_fingerprint):
        return await self._accept_and_launch(self._reconcile, UUID(str(project_id)), payload.groupId,
            str(payload.executionId), session, str(operation_id), input_fingerprint)

    def _reconcile(self, project_id, group_id, execution_id, session, operation_id, fingerprint):
        self._check_lease(project_id, session)
        operation = {'action': 'reconcile', 'inputFingerprint': fingerprint}
        try:
            with self._project_lock(project_id):
                executions = self._executions(project_id)
                for record in executions:
                    previous = record.get('controlOperations', {}).get(operation_id)
                    if previous == operation and record['groupId'] == str(group_id):
                        return record
                    if previous is not None or record['executionId'] == operation_id:
                        raise ProjectError('此操作 ID 已用于不同的 Run 请求。', 409, code='command_conflict')
                group = self._group(self.projects.snapshot(project_id), group_id)
                current = self._latest(executions, group_id, _definition_id(group))
                if current is None or current['executionId'] != execution_id:
                    raise ProjectError('当前 Run 已切换到另一轮执行，请刷新后再操作。', 409, code='segment_run_stale_execution')
                if current['status'] != 'needs_review':
                    raise ProjectError('此 Run 当前没有待核对的任务。', 409, code='segment_run_invalid_state')
                return self._resolve_review(current, operation_id=operation_id, operation=operation)
        except Timeout as error:
            raise ProjectError('此 Run 正在处理，请稍后重试。', 409, code='segment_run_busy') from error

    def _resolve_review(self, record, *, operation_id=None, operation=None):
        project_id, execution_id = record['projectId'], record['executionId']
        path = self._path(project_id, execution_id)
        with FileLock(self._path(project_id, execution_id, 'lock'), timeout=5), self._state_lock(record):
            current = self._read(path)
            if current['status'] != 'needs_review':
                return current
            issue = current.get('issue') or {}
            step = next((step for step in current['steps'] if step['itemId'] == issue.get('itemId')), None)
            job_id = step['jobId'] if step else None
            if step and not job_id and step['command']:
                receipt = self.projects.replay(parse_command(step['command']))
                if receipt is not None and len(receipt.jobIds) == 1:
                    job_id = str(receipt.jobIds[0])
            job = self.generation.get_job(project_id, job_id) if job_id else None
            if (job is None or str(job.batchId) != execution_id or str(job.originItemId) != step['itemId']):
                raise ProjectError('原任务尚无可确认的回执。请先核对供应商受理记录。', 409, code='segment_run_reconciliation_pending')
            missing = _missing_job(job)
            remote_status = getattr(job.errorDetails, 'providerStatus', None)
            terminal = (job.status in {'failed', 'cancelled', 'interrupted'} and not job.resumeAllowed
                        and (missing or remote_status in {'failed', 'cancelled', 'expired'}
                             or getattr(job, 'remoteCancellation', None) == 'confirmed'))
            if job.status == 'succeeded':
                step.update(jobId=job_id, status='running')
                current.update(status='paused', pauseRequested=False, issue=None)
            elif terminal:
                step['jobId'] = job_id
                current.update(status='failed', issue={
                    'code': 'segment_run_remote_missing' if missing else 'provider',
                    'message': ('供应商已确认原任务不存在。可以从这段重新生成。' if missing else
                                '供应商任务已结束。可以从这段重新生成。'),
                    'itemId': step['itemId'],
                })
            else:
                raise ProjectError('原任务尚无可确认的回执。请先核对供应商受理记录。', 409, code='segment_run_reconciliation_pending')
            if operation_id is not None:
                current.setdefault('controlOperations', {})[operation_id] = operation
            self._write(current)
            return current

    async def restart(self, project_id, payload, session, *, operation_id, input_fingerprint):
        return await self._run_action('restart', project_id, payload, session, operation_id, input_fingerprint)

    async def step(self, project_id, payload, session, *, operation_id, input_fingerprint):
        return await self._run_action('step', project_id, payload, session, operation_id, input_fingerprint)

    async def regenerate(self, project_id, payload, session, *, operation_id, input_fingerprint):
        return await self._run_action('regenerate', project_id, payload, session, operation_id, input_fingerprint)

    async def adopt(self, project_id, payload, session, *, operation_id, input_fingerprint):
        return await self._run_action('adopt', project_id, payload, session, operation_id, input_fingerprint)

    async def _run_action(self, action, project_id, payload, session, operation_id, fingerprint):
        return await self._accept_and_launch(self._change_action, action, UUID(str(project_id)), payload,
                                             session, operation_id, fingerprint)

    def _change_action(self, action, project_id, payload, session, operation_id, fingerprint):
        self._check_lease(project_id, session)
        operation_id = str(operation_id)
        operation = {'action': action, 'inputFingerprint': fingerprint}
        group_id = str(payload.groupId)
        requested = str(payload.executionId) if payload.executionId is not None else None
        try:
            with self._project_lock(project_id):
                executions = self._executions(project_id)
                for record in executions:
                    previous = record.get('controlOperations', {}).get(operation_id)
                    if record['executionId'] == operation_id:
                        previous = record.get('startOperation')
                        if previous is None:
                            raise ProjectError('此操作 ID 已用于不同的 Run 请求。', 409, code='command_conflict')
                    if previous is not None:
                        if previous == operation and record['groupId'] == group_id:
                            return record
                        raise ProjectError('此操作 ID 已用于不同的 Run 请求。', 409, code='command_conflict')

                snapshot = self.projects.snapshot(project_id)
                group = self._group(snapshot, payload.groupId)
                latest = self._latest(executions, group_id, _definition_id(group))
                current_id = latest['executionId'] if latest else None
                expected = getattr(payload, 'expectedExecutionId', None)
                if str(expected or requested) != str(current_id):
                    raise ProjectError('当前 Run 已切换到另一轮执行，请刷新后再操作。', 409, code='segment_run_stale_execution')
                if action in {'restart', 'regenerate'} and (latest is None or latest['status'] not in SETTLED):
                    raise ProjectError('请在当前执行停止且任务状态已明确后操作。', 409, code='segment_run_invalid_state')
                if action == 'step' and latest is not None and latest['status'] not in {'paused', 'needs_review'}:
                    raise ProjectError('请先暂停当前执行，再运行下一步。', 409, code='segment_run_invalid_state')

                if action == 'regenerate':
                    base = next((record for record in executions if record['executionId'] == requested
                                 and record['groupId'] == group_id), None)
                    if base is None or base['status'] not in SETTLED:
                        raise ProjectError('这轮执行的结果尚不可复用。', 409, code='segment_run_incompatible_result')
                    self._check_plan(snapshot, base)
                    if base is latest and latest['status'] in {'awaiting_selection', 'failed'} and latest.get('reviewItemId') == str(payload.itemId):
                        return self._continue_action(latest, operation_id, operation, snapshot, group, payload)
                    record = self._new_execution(project_id, group, operation_id, fingerprint)
                    self._prepare_regeneration(record, base, snapshot, group, payload.itemId)
                elif action == 'step' and latest is not None and latest['status'] == 'needs_review':
                    self._check_plan(snapshot, latest)
                    record = self._new_execution(project_id, group, operation_id, fingerprint)
                    target = _next_target(latest)
                    self._prepare_regeneration(
                        record, latest, snapshot, group, None if target == 'assemble' else UUID(target), sample=False,
                    )
                    record['stepTarget'] = _next_target(record)
                elif action == 'adopt' or action == 'step' and latest is not None:
                    return self._continue_action(latest, operation_id, operation, snapshot, group, payload)
                else:
                    record = self._new_execution(project_id, group, operation_id, fingerprint)
                    if action == 'step':
                        record['stepTarget'] = _next_target(record)
                record['startOperation'] = operation
                if latest is not None:
                    record['supersedesExecutionId'] = current_id
                self._save(record)
                return record
        except Timeout as error:
            raise ProjectError('此 Run 正在处理，请稍后重试。', 409, code='segment_run_busy') from error

    def _continue_action(self, record, operation_id, operation, snapshot, group, payload):
        project_id, execution_id = record['projectId'], record['executionId']
        with FileLock(self._path(project_id, execution_id, 'lock'), timeout=5), self._state_lock(record):
            record = self._read(self._path(project_id, execution_id))
            self._check_plan(snapshot, record)
            action = operation['action']
            if action == 'step':
                record['stepTarget'] = _next_target(record)
            else:
                review = record.get('reviewItemId')
                if record['status'] not in {'awaiting_selection', 'failed'} or not review:
                    raise ProjectError('此 Run 当前没有可采用的片段版本。', 409, code='segment_run_candidate_missing')
                target = next(step for step in record['steps'] if step['itemId'] == review)
                if action == 'regenerate':
                    self._set_sample(record, snapshot, UUID(review))
                else:
                    choice = next((item for item in record['candidates'] if item['jobId'] == str(payload.jobId)), None)
                    if choice is None:
                        raise ProjectError('找不到这次执行的片段版本。', 409, code='segment_run_candidate_missing')
                    item = next(item for item in snapshot.canvasItems if str(item.id) == review)
                    job = next((job for job in snapshot.jobs if job.id == payload.jobId), None)
                    asset = self._check_selected_job(snapshot, group, item, job, execution_id)
                    if str(asset.id) != choice['assetId']:
                        raise ProjectError('片段版本的素材已变化。', 409, code='segment_run_incompatible_result')
                    target.update(status='succeeded', jobId=choice['jobId'], assetId=choice['assetId'])
                    record['reviewItemId'] = None
            record.update(status='queued', pauseRequested=False, issue=None)
            record.setdefault('controlOperations', {})[operation_id] = operation
            self._write(record)
            return record

    def _prepare_regeneration(self, record, base, snapshot, group, target_id, *, sample=True):
        plan = group.runPlan.by_item()
        if target_id is not None and target_id not in plan:
            raise ProjectError('请选择此 Run 中的生成片段。', 409, code='segment_run_invalid_state')
        items = {item.id: item for item in snapshot.canvasItems}
        jobs = {str(job.id): job for job in snapshot.jobs}
        base_steps = {step['itemId']: step for step in base['steps'] if step['status'] == 'succeeded'}
        accepted = {}
        affected = {target_id} if target_id is not None else set()
        for step in record['steps']:
            item_id = UUID(step['itemId'])
            dependency = plan[item_id].step
            donor_id = dependency.upstreamItemId if dependency.kind == 'continuation' else None
            if item_id in affected or donor_id in affected:
                affected.add(item_id)
                continue
            original = base_steps.get(step['itemId'])
            job = jobs.get(original['jobId']) if original else None
            if job is None or (donor_id is not None and donor_id not in accepted):
                continue
            origin = original.get('reusedFromExecutionId', base['executionId'])
            try:
                asset = self._check_selected_job(snapshot, group, items[item_id], job, origin)
                self._check_guide(dependency, job, accepted, require_source_node=True)
            except ProjectError:
                continue
            accepted[item_id] = job
            step.update(status='succeeded', jobId=str(job.id), assetId=str(asset.id), reusedFromExecutionId=origin)
        required = plan[target_id].step if target_id is not None else None
        if required is not None and required.kind == 'continuation' and required.upstreamItemId not in accepted:
            raise ProjectError('没有可复用的上游导帧结果，请从上游片段开始。', 409, code='segment_run_incompatible_result')
        record['baseExecutionId'] = base['executionId']
        if not sample:
            return
        record.update(reviewItemId=str(target_id), candidates=[])
        if old_step := base_steps.get(str(target_id)):
            if old_job := jobs.get(old_step['jobId']):
                record['sampleSeeds'] = [old_job.inputSnapshot.spec.parameters.seed]
        self._set_sample(record, snapshot, target_id)

    @staticmethod
    def _set_sample(record, snapshot, item_id):
        item = next(item for item in snapshot.canvasItems if item.id == item_id)
        spec = next(spec for spec in snapshot.generationSpecs if spec.id == item.binding.objectRef.id)
        used = set(record.get('sampleSeeds', ())) | {spec.parameters.seed}
        seed = randbelow(2**31)
        while seed in used:
            seed = randbelow(2**31)
        record.setdefault('sampleSeeds', []).append(seed)
        record['sampleAttempt'] = record.get('sampleAttempt', 0) + 1
        index = next(index for index, step in enumerate(record['steps']) if step['itemId'] == str(item_id))
        record['steps'][index] = _waiting_step(item_id) | {'seed': seed, 'attempt': record['sampleAttempt']}

    async def latest(self, project_id, group_id):
        def read():
            group = self._canvas_group(self.projects.snapshot(project_id), group_id)
            if group is None or group.runPlan is None:
                return None
            record = self._latest(self._executions(project_id), group_id, _definition_id(group))
            return self._public(record) if record is not None else None

        return await asyncio.to_thread(read)

    async def history(self, project_id, group_id):
        def read():
            group = self._canvas_group(self.projects.snapshot(project_id), group_id)
            records = self._executions(project_id)
            superseded = self._superseded(records)
            return [self._public(record, superseded=(record['executionId'] in superseded or group is None
                     or group.runPlan is None or record.get('runDefinitionId') != _definition_id(group)))
                    for record in records if record['groupId'] == str(group_id)]

        return await asyncio.to_thread(read)

    async def status(self, project_id, execution_id):
        project_id, execution_id = UUID(str(project_id)), UUID(str(execution_id))
        path = self._path(project_id, execution_id)
        if not path.is_file():
            raise ProjectError('找不到此 Run 执行。', 404)
        record = await asyncio.to_thread(self._read, path)
        if record['projectId'] != str(project_id) or record['executionId'] != str(execution_id):
            raise ProjectError('找不到此 Run 执行。', 404)
        executions = await asyncio.to_thread(self._executions, project_id)
        return self._public(record, superseded=str(execution_id) in self._superseded(executions))

    async def wait(self, project_id, execution_id, wait_seconds=0):
        loop = asyncio.get_running_loop()
        deadline = loop.time() + wait_seconds
        while True:
            execution = await self.status(project_id, execution_id)
            remaining = deadline - loop.time()
            if execution['status'] not in ACTIVE or remaining <= 0:
                return execution
            await asyncio.sleep(min(0.5, remaining))

    def _launch(self, record):
        key = (record['projectId'], record['executionId'])
        running = self.workers.get(key)
        if (running is None or running.done()) and record['status'] in ACTIVE:
            worker = self.workers[key] = asyncio.create_task(self._run(record))
            worker.add_done_callback(lambda future: self._finished(key, future))

    def _finished(self, key, future):
        if self.workers.get(key) is future:
            self.workers.pop(key, None)
        if not future.cancelled() and (error := future.exception()) is not None:
            logger.error('Segment run %s in project %s failed to persist its execution state', key[1], key[0], exc_info=error)

    async def start(self):
        self.closed = False
        for path in self.directory.glob('*.json'):
            try:
                record = await asyncio.to_thread(self._read, path)
                if path != self._path(UUID(record['projectId']), UUID(record['executionId'])):
                    raise ValueError('Mismatched execution path')
                if record['status'] == 'needs_review':
                    await asyncio.to_thread(self._reconcile_on_start, record)
                else:
                    self._launch(record)
            except (OSError, ValueError, KeyError, ProjectError, Timeout):
                logger.warning('Could not read segment run execution %s', path.name)

    def _reconcile_on_start(self, record):
        project_id = UUID(record['projectId'])
        with self._project_lock(project_id):
            group = self._canvas_group(self.projects.snapshot(project_id), record['groupId'])
            if group is None or group.runPlan is None:
                return
            latest = self._latest(self._executions(project_id), group.id, _definition_id(group))
            if latest is None or latest['executionId'] != record['executionId'] or latest['status'] != 'needs_review':
                return
            try:
                self._resolve_review(latest)
            except ProjectError as error:
                if error.code != 'segment_run_reconciliation_pending':
                    raise

    async def close(self):
        self.closed = True
        await asyncio.gather(*tuple(self.accepting), return_exceptions=True)
        workers = tuple(self.workers.values())
        for worker in workers:
            worker.cancel()
        await asyncio.gather(*workers, return_exceptions=True)

    def _check_plan(self, snapshot, record):
        group = self._group(snapshot, UUID(record['groupId']))
        if (record.get('runDefinitionId') != _definition_id(group) or digest(group.runPlan) != record['planFingerprint']
                or digest(group.assembly) != record['assemblyFingerprint']):
            raise ProjectError('已发布的 Run 计划已变化。', 409, code='revision_conflict')
        return group

    def _check_job(self, snapshot, job, item, execution_id):
        asset = current_asset(snapshot, item)
        if (job is None or job.originItemId != item.id or job.batchId != execution_id
                or job.status != 'succeeded' or not job.adopted or not asset or asset_ref(asset) != job.asset):
            raise ProjectError('片段没有本次执行已采用的结果。', 409, code='segment_run_result_mismatch')

    @staticmethod
    def _check_selected_job(snapshot, group, item, job, source_execution):
        if job is None or str(job.batchId) != str(source_execution):
            raise ProjectError('片段任务与已选执行版本不符。', 409, code='segment_run_incompatible_result')
        try:
            return selected_segment_asset(snapshot, group, item, job)
        except ContractError as error:
            raise ProjectError(str(error), 409, code='segment_run_incompatible_result') from error

    @staticmethod
    def _check_guide(dependency, job, results, *, require_source_node=False):
        if dependency.kind != 'continuation':
            return
        donor = results.get(dependency.upstreamItemId)
        try:
            guide = job.inputSnapshot.timeline_guide(required=True)
        except ValueError:
            guide = None
        if (donor is None or guide is None or guide.asset != donor.asset
                or require_source_node and (guide.sourceVersion is None or guide.sourceVersion.id != dependency.upstreamItemId)
                or job.inputSnapshot.spec.parameters.h3Segment.sourceFrames != dependency.sourceFrames):
            raise ProjectError('片段使用的导帧与本次执行的上游结果不符。', 409, code='segment_run_guide_mismatch')

    async def _wait_job(self, project_id, job_id):
        job = await asyncio.to_thread(self.generation.get_job, project_id, job_id)
        if job and (job.status in ACTIVE or job.status in {'interrupted', 'failed'} and job.resumeAllowed):
            await self.generation.recover(str(project_id), str(job_id))
        while True:
            job = await asyncio.to_thread(self.generation.get_job, project_id, job_id)
            if job is None:
                raise ProjectError('找不到原片段任务。', 409, code='segment_run_job_missing')
            worker = self.generation.jobs.get(str(job_id))
            if job.status == 'succeeded':
                return job
            if worker is None or worker.future.done():
                # A worker can commit its final state while the read above is
                # in progress. Resolve the persisted outcome once more.
                latest = await asyncio.to_thread(self.generation.get_job, project_id, job_id)
                if latest is not None:
                    if latest.status == 'succeeded':
                        return latest
                    if latest.resumeAllowed:
                        raise ProjectError('原片段任务仍可恢复，请先核对该任务。', 409, code='segment_run_job_unsettled')
                    if _missing_job(latest):
                        raise ProjectError('供应商已确认原任务不存在。可以从这段重新生成。', 409, code='segment_run_remote_missing')
                    if latest.errorDetails is not None:
                        raise ProjectError(latest.errorDetails.message, 409, code=latest.errorDetails.category)
                raise ProjectError('片段任务已停止，请核对原任务回执。', 409, code='submission_unknown')
            await asyncio.sleep(.25)

    @staticmethod
    def _require_receipt(receipt):
        if receipt.status == 'rejected':
            issue = receipt.issues[0]
            raise ProjectError(issue.message, 409, code=issue.code)

    def _replay_while_pausing(self, record, command):
        # A recovered durable command may have reached admission before the worker
        # stopped. While paused, read its receipt without starting an unaccepted one.
        current = self._read(self._path(record['projectId'], record['executionId']))
        if not current.get('pauseRequested'):
            return None
        replay = self.projects.replay(command)
        if replay is None:
            raise PauseBoundary
        return replay

    async def _step(self, record, step, project_id, execution_id, results):
        snapshot = await asyncio.to_thread(self.projects.snapshot, project_id)
        group = self._check_plan(snapshot, record)
        item_id = UUID(step['itemId'])
        items = {item.id: item for item in snapshot.canvasItems}
        item = items[item_id]
        dependency = group.runPlan.by_item()[item_id].step
        specs = {spec.id: spec for spec in snapshot.generationSpecs}
        spec = specs[item.binding.objectRef.id]
        selected = record.get('baseExecutionId') is not None
        new_command = step['command'] is None
        donor_id = dependency.upstreamItemId if dependency.kind == 'continuation' else None
        if step['jobId'] is None:
            if new_command:
                if donor_id is not None and not selected:
                    self._check_job(snapshot, results[donor_id], items[donor_id], execution_id)
                options = {'adoptionPolicy': 'candidate_only'} if selected else {}
                step_command = f"{item_id}:sample:{step['attempt']}" if 'attempt' in step else str(item_id)
                command = parse_command(dict(
                    type='generation.submit', projectId=project_id, commandId=uuid5(execution_id, step_command),
                    expectedVersions=[_version('generation_spec', spec), _version('canvas_item', item)],
                    payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=item.id,
                                 batchId=execution_id, **options),
                ))
                step.update(command=command.model_dump(mode='json'), status='submitting')
                await self._persist(record, boundary=True)
            command = parse_command(step['command'])
            receipt = None if new_command else await asyncio.to_thread(self._replay_while_pausing, record, command)
            if receipt is None:
                inputs = ({'run_guide_job_id': results[donor_id].id if donor_id is not None else None, 'run_seed': step.get('seed')}
                          if selected else {})
                receipt = await self.generation.execute(command, source='background', run_execution_id=execution_id, **inputs)
            self._require_receipt(receipt)
            if len(receipt.jobIds) != 1:
                raise ProjectError('生成回执缺少唯一片段任务。', 409, code='segment_run_job_missing')
            step.update(jobId=str(receipt.jobIds[0]), status='running')
            await self._persist(record)
        job = await self._wait_job(project_id, step['jobId'])
        latest = await asyncio.to_thread(self.projects.snapshot, project_id)
        latest_item = next(item for item in latest.canvasItems if item.id == item_id)
        if selected:
            self._check_selected_job(latest, group, latest_item, job, step.get('reusedFromExecutionId', execution_id))
        else:
            self._check_job(latest, job, latest_item, execution_id)
        self._check_guide(dependency, job, results, require_source_node=selected)
        if step['status'] != 'succeeded':
            step.update(status='succeeded', assetId=str(job.asset.assetId))
            await self._persist(record)
        return job

    async def _assemble(self, record, project_id, execution_id, results):
        snapshot = await asyncio.to_thread(self.projects.snapshot, project_id)
        group = self._check_plan(snapshot, record)
        items = {item.id: item for item in snapshot.canvasItems}
        timeline = items[group.assembly.timelineItemId]
        documents = {document.id: document for document in snapshot.editorDocuments}
        document = documents[timeline.binding.objectRef.id]
        new_command = record['assembly'] is None
        selected = record.get('baseExecutionId') is not None
        if new_command:
            if not selected:
                for item_id, job in results.items():
                    self._check_job(snapshot, job, items[item_id], execution_id)
            versions = [_version('canvas_item', group), _version('canvas_item', timeline),
                        _version('editor_document', document)]
            if output := items.get(group.assembly.outputItemId):
                versions.append(_version('canvas_item', output))
            command = parse_command(dict(type='group.assemble', projectId=project_id,
                commandId=uuid5(execution_id, 'assemble'), expectedVersions=versions,
                payload=dict(groupId=group.id, jobIds=[results[item_id].id for item_id in group.runPlan.by_item()])))
            record['assembly'] = command.model_dump(mode='json')
            await self._persist(record, boundary=True)
        command = parse_command(record['assembly'])
        receipt = None if new_command else await asyncio.to_thread(self._replay_while_pausing, record, command)
        if receipt is None:
            # The foreground coroutine can stop, but the admitted render still owns
            # its files and execution lock until its atomic commit returns.
            selection = {'run_result_jobs': {item_id: job.id for item_id, job in results.items()}} if selected else {}
            render = asyncio.create_task(asyncio.to_thread(self.assembly.execute, command,
                                         source='background', run_execution_id=execution_id, **selection))
            try:
                receipt = await asyncio.shield(render)
            except asyncio.CancelledError:
                await asyncio.gather(render, return_exceptions=True)
                raise
        self._require_receipt(receipt)
        latest = await asyncio.to_thread(self.projects.snapshot, project_id)
        output = next((item for item in latest.canvasItems if item.id == group.assembly.outputItemId), None)
        asset = current_asset(latest, output) if output else None
        if asset is None or asset.id not in {change.id for change in receipt.changed if change.objectType == 'asset'}:
            raise ProjectError('组装回执与本次运行的成片不符。', 409, code='segment_run_result_mismatch')
        record.update(status='succeeded', outputAssetId=str(asset.id))
        await self._persist(record)

    async def _run(self, record):
        project_id, execution_id = UUID(record['projectId']), UUID(record['executionId'])
        lock = FileLock(self._path(project_id, execution_id, 'lock'), timeout=0)
        try:
            lock.acquire()
        except Timeout:
            return
        step = None
        try:
            record = await asyncio.to_thread(self._read, self._path(project_id, execution_id))
            if record['status'] not in ACTIVE:
                return
            record['status'] = 'running'
            await self._persist(record)
            results = {}
            review = record.get('reviewItemId')
            for step in record['steps']:
                identifier = step['itemId']
                if review and identifier != review and step['status'] != 'succeeded':
                    continue
                job = await self._step(record, step, project_id, execution_id, results)
                if identifier == review:
                    record['candidates'].append({'jobId': str(job.id), 'assetId': str(job.asset.assetId), 'seed': step['seed']})
                    record['steps'][record['steps'].index(step)] = _waiting_step(identifier)
                    record['status'] = 'awaiting_selection'
                    await self._persist(record)
                    return
                results[UUID(identifier)] = job
                if identifier == record.get('stepTarget'):
                    record.update(status='paused', stepTarget=None)
                    await self._persist(record)
                    return
            step = None
            await self._assemble(record, project_id, execution_id, results)
        except PauseBoundary:
            # The next command was rejected before its intent was saved.
            record = await asyncio.to_thread(self._read, self._path(project_id, execution_id))
            record['status'] = 'paused'
            await self._persist(record)
        except ProjectError as error:
            if step is not None:
                step['status'] = 'failed'
            status = 'needs_review' if error.code in REVIEW_REQUIRED else 'failed'
            if status == 'failed' and record.get('reviewItemId') and record.get('candidates'):
                status = 'awaiting_selection'
            record.update(status=status,
                          issue={'code': error.code, 'message': str(error), 'itemId': step['itemId'] if step else None})
            await self._persist(record)
        except (OSError, ValueError, KeyError):
            # Acceptance may have reached durable storage before a local error.
            # Preserve the original command and stop instead of issuing another.
            logger.exception('Segment run %s interrupted during execution', execution_id)
            record.update(status='needs_review',
                          issue={'code': 'submission_unknown', 'message': '执行结果需核对原任务回执。',
                                 'itemId': step['itemId'] if step else None})
            await self._persist(record)
        finally:
            lock.release()
