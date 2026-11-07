"""Control and recovery of tool executions, separate from read-only queries."""
import asyncio
from copy import deepcopy
import logging
from uuid import UUID, uuid4, uuid5

from filelock import FileLock, Timeout

from opendirector.domain.generation import GenerationError
from opendirector.domain.projects import ProjectError
from opendirector.ports.gateway import gateway
from opendirector.integrations.model_adapters import adapter_for
from opendirector.media.async_work import blocking

logger = logging.getLogger(__name__)
TERMINAL = {'succeeded', 'failed', 'cancelled', 'interrupted'}


def cancellation_state(task):
    """Remote facts never follow from stopping the local coroutine."""
    calls = task.get('modelCalls', [])
    outstanding = [call for call in calls if call['state'] not in {'succeeded', 'failed', 'cancelled'}]
    states = {call.get('cancellation', 'not_requested') for call in outstanding}
    if states & {'unknown', 'sending'} or any(not call.get('externalTaskId') and call.get('kind') == 'video' for call in outstanding):
        return 'unknown'
    if 'unsupported' in states:
        return 'unsupported'
    if 'requested' in states:
        return 'requested'
    if 'not_requested' in states:
        return 'not_requested'
    if any(call.get('cancellation') == 'confirmed' for call in calls):
        return 'confirmed'
    return 'not_required' if calls else 'not_applicable'


class ToolTaskLifecycle:
    def _init_lifecycle(self):
        self.worker_id = str(uuid4())
        self.worker_lock = None
        self.maintenance = None
        self.controls = {}
        self.admissions = set()
        self.closing = False

    def _ensure_owner(self):
        if self.worker_lock is None:
            folder = self.store.state_dir / 'tool-workers'
            folder.mkdir(exist_ok=True)
            self.worker_lock = FileLock(folder / (self.worker_id + '.lock'), thread_local=False)
            self.worker_lock.acquire()

    def _owner_alive(self, task):
        owner = task.get('workerId')
        if not owner:
            return False
        if owner == self.worker_id and self.worker_lock is not None:
            key = (task['projectId'], task['id'])
            return key in self.jobs or key in self.accepting
        lock = FileLock(self.store.state_dir / 'tool-workers' / (str(UUID(owner)) + '.lock'))
        try:
            lock.acquire(timeout=0)
        except Timeout:
            return True
        lock.release()
        return False

    def _change(self, project_id, task_id, changes):
        """All writers merge with the durable control intent under one lock."""
        with self.store.transaction():
            directory = self._directory(project_id)
            current = gateway().read_json(gateway().child(self._folder(directory), task_id + '.json'))
            if all(key in current and current[key] == value for key, value in changes.items()):
                return current
            current.update(deepcopy(changes))
            current['revision'] = current.get('revision', 0) + 1
            self._write(directory, current)
            return current

    def _change_call(self, project_id, task_id, call_id, changes):
        with self.store.transaction():
            task = self.get(project_id, task_id)
            calls = task.get('modelCalls', [])
            call = next(value for value in calls if value['id'] == call_id)
            if call['state'] in {'succeeded', 'failed', 'cancelled'}:
                return task
            call.update(changes)
            updates = {'modelCalls': calls}
            if task.get('cancelRequested'):
                updates['remoteCancellation'] = cancellation_state({**task, **updates})
            return self._change(project_id, task_id, updates)

    def _claim_cancel(self, project_id, task_id, call_id):
        with self.store.transaction():
            task = self.get(project_id, task_id)
            call = next(value for value in task['modelCalls'] if value['id'] == call_id)
            claimed = bool(task.get('cancelRequested') and call.get('cancellation') == 'not_requested'
                           and call['state'] not in {'succeeded', 'failed', 'cancelled'})
            if claimed:
                task = self._change_call(project_id, task_id, call_id, {'cancellation': 'sending'})
                call = next(value for value in task['modelCalls'] if value['id'] == call_id)
            return task, call, claimed

    async def _model_call(self, task, capability, invoke):
        project_id, task_id = task['projectId'], task['id']
        def begin():
            with self.store.transaction():
                current = self.get(project_id, task_id)
                if self.closing or current.get('cancelRequested'):
                    return None
                calls = current.get('modelCalls', [])
                call = dict(id=str(uuid5(UUID(task_id), f'model-call-{len(calls)}')), capability=capability,
                            kind='video' if capability in {'video.generate', 'video.first_frame', 'video.edit'} else 'request',
                            state='submitting', externalTaskId=None, cancellation='not_requested')
                self._change(project_id, task_id, {'modelCalls': [*calls, call]})
                return call
        call = await blocking(begin)
        if call is None:
            raise asyncio.CancelledError()

        async def submitted(external_id):
            await blocking(self._change_call, project_id, task_id, call['id'],
                           {'externalTaskId': external_id, 'state': 'running'})
        try:
            result = await invoke(submitted)
        except asyncio.CancelledError:
            current = self.get(project_id, task_id)
            saved = next(value for value in current['modelCalls'] if value['id'] == call['id'])
            await blocking(self._change_call, project_id, task_id, call['id'],
                           {'state': 'running' if saved.get('externalTaskId') else 'unknown'})
            raise
        except Exception as error:
            # A transport/protocol failure does not prove that submission failed.
            unknown = not isinstance(error, GenerationError) or (error.details.category in {'submission_unknown', 'temporary', 'protocol'}
                or error.details.stage in {'poll', 'download'} and error.details.providerStatus is None)
            await blocking(self._change_call, project_id, task_id, call['id'], {'state': 'unknown' if unknown else 'failed'})
            raise
        await blocking(self._change_call, project_id, task_id, call['id'], {'state': 'succeeded'})
        return result

    def _remote_config(self, task, call):
        capability = call['capability']
        frozen = task.get('modelSnapshots', {}).get(capability)
        if frozen is None:
            raise ProjectError('原任务缺少模型执行依据，无法核对远端状态。', 409)
        config = self.configs.resolve(frozen['id'], frozen['kind'])
        if any(config.get(key) != frozen.get(key) for key in ('id', 'url', 'modelId', 'protocol', 'connectionType', 'videoAdapter')):
            raise ProjectError('原任务模型连接已变化，无法核对远端状态。', 409)
        return {**frozen, 'apiKey': config.get('apiKey', '')}

    async def _cancel_remotes(self, task):
        for call in task.get('modelCalls', []):
            if call['state'] in {'succeeded', 'failed', 'cancelled'}:
                continue
            pid, tid, cid = task['projectId'], task['id'], call['id']
            if not call.get('externalTaskId'):
                if task.get('cancelRequested'):
                    await blocking(self._change_call, pid, tid, cid,
                                   {'cancellation': 'unknown' if call['kind'] == 'video' else 'unsupported'})
                continue
            try:
                task, call, claimed = await blocking(self._claim_cancel, pid, tid, cid)
                if call['state'] in {'succeeded', 'failed', 'cancelled'}:
                    continue
                config = self._remote_config(task, call)
                adapter = adapter_for(config, self.transport, self.poll_interval)
                if claimed:
                    # Commit before I/O. After a crash, only query this ID; do
                    # not silently repeat a DELETE whose response was lost.
                    outcome = await adapter.cancel_video(config, call['externalTaskId'])
                    changes = {'cancellation': outcome if outcome in {'confirmed', 'requested', 'unsupported'} else 'unknown'}
                    if outcome == 'confirmed':
                        changes['state'] = 'cancelled'
                    elif outcome in {'completed', 'failed'}:
                        changes.update(state='succeeded' if outcome == 'completed' else 'failed', cancellation='not_required')
                    await blocking(self._change_call, pid, tid, cid, changes)
                else:
                    status = await adapter.video_status(config, call['externalTaskId'])
                    changes = {}
                    if status == 'cancelled':
                        changes.update(state='cancelled', cancellation='confirmed' if task.get('cancelRequested') else 'not_requested')
                    elif status in {'succeeded', 'failed'}:
                        changes.update(state=status, cancellation='not_required' if task.get('cancelRequested') else 'not_requested')
                    elif status == 'running':
                        changes.update(state='running')
                    if changes:
                        await blocking(self._change_call, pid, tid, cid, changes)
            except (ProjectError, GenerationError, OSError):
                if task.get('cancelRequested'):
                    await blocking(self._change_call, pid, tid, cid, {'cancellation': 'unknown'})

    async def _stopped(self, project_id, task_id):
        from .tool_tasks import _now
        task = await blocking(self.get, project_id, task_id)
        if task['status'] == 'succeeded' or task.get('localState') == 'stopped' and task['status'] in TERMINAL:
            return task
        if task.get('cancelRequested'):
            await self._cancel_remotes(task)
        task = await blocking(self.get, project_id, task_id)
        updates = dict(status='cancelled' if task.get('cancelRequested') else 'interrupted',
                       localState='stopped', phase=None, finishedAt=task.get('finishedAt') or _now(),
                       error='已停止本地处理。' if task.get('cancelRequested') else '服务中断，原执行记录已保留；不会自动重新生成。')
        if task.get('cancelRequested'):
            updates['remoteCancellation'] = cancellation_state(task)
        await blocking(self._change, project_id, task_id, updates)
        return await blocking(self._settle_terminal, project_id, task_id)

    def _request_cancel(self, project_id, task_id, session):
        from .tool_tasks import _now
        with self.store.transaction():
            self._directory(project_id, session)
            task = self.get(project_id, task_id)
            outstanding = any(call['state'] not in {'succeeded', 'failed', 'cancelled'} for call in task.get('modelCalls', []))
            if task.get('cancelRequested') or task['status'] in TERMINAL and not outstanding:
                return task
            return self._change(project_id, task_id, dict(cancelRequested=True,
                cancelOperationId=str(uuid5(UUID(task_id), 'cancel')), cancelRequestedAt=_now(),
                localState='stopping', phase='停止处理中'))

    async def cancel(self, project_id, task_id, session, *, wait=True):
        # Accepted intent survives HTTP disconnection; one controller per task.
        request = asyncio.create_task(blocking(self._request_cancel, project_id, task_id, session))
        async def finish():
            task = await request
            if not task.get('cancelRequested') or task.get('localState') == 'stopped':
                return task
            key = (project_id, task_id)
            job = self.jobs.get(key)
            if job is not None and not job.done() and not job.cancelling():
                job.cancel()
            if job is not None:
                await asyncio.gather(job, return_exceptions=True)
            elif self._owner_alive(task):
                # Another live worker observes the persisted request in its
                # maintenance loop. Do not claim that it has already stopped.
                return task
            current = await blocking(self.get, project_id, task_id)
            if current.get('localState') != 'stopped':
                return await self._stopped(project_id, task_id)
            return current
        key = (project_id, task_id)
        # Enqueue admission too: duplicate requests still validate their lease.
        previous = self.controls.get(key)
        async def controlled():
            await request
            if previous is not None:
                await asyncio.shield(previous)
            return await finish()
        control = asyncio.create_task(controlled())
        self.controls[key] = control
        def finished(done):
            if self.controls.get(key) is done:
                self.controls.pop(key, None)
            if not done.cancelled():
                done.exception()
        control.add_done_callback(finished)
        if wait:
            return await asyncio.shield(control)
        return await asyncio.shield(request)

    def _registered_outputs(self, task):
        """Repair a crash after asset commit but before its ledger acknowledgement."""
        from .tool_tasks import output_item_id
        assets = {str(asset.id): asset for asset in self.assets.assets.list(task['projectId'])
                  if str(asset.provenance.toolTaskId) == task['id']}
        outputs = list(task.get('outputs', []))
        known = {output['id'] for output in outputs}
        # Recipe output identity is ordinal and independent of the upload ID.
        for index in range(len(assets) + len(outputs)):
            logical = uuid5(UUID(task['id']), f'output-{index}')
            asset_id = str(gateway().upload_asset_id(UUID(task['projectId']), uuid5(logical, 'tool-output')))
            if asset_id in assets and asset_id not in known:
                asset = assets[asset_id]
                record = self.assets.record(asset)
                outputs.append({key: record.get(key) for key in ('id', 'kind', 'name', 'type', 'width', 'height', 'durationMs')}
                               | {'title': asset.name, 'canvasItemId': output_item_id(task, index, asset.kind)})
        return outputs

    def _recover_local(self):
        """Only the explicit recovery path repairs abandoned execution facts."""
        from .tool_tasks import ACTIVE, _now
        pending = []
        for project in self.projects.list_projects()['projects']:
            pid = str(project['id'])
            try:
                with self.store.transaction():
                    folder = gateway().child(self._directory(pid), 'tool-tasks')
                    if not folder.exists():
                        continue
                    for path in folder.glob('*.json'):
                        task = gateway().read_json(gateway().child(folder, path.name))
                        task['projectId'] = pid
                        key = (pid, task['id'])
                        if task['status'] in ACTIVE:
                            if self._owner_alive(task):
                                job = self.jobs.get(key)
                                if task.get('cancelRequested') and job and not job.done() and not job.cancelling():
                                    # Returned to the event loop for cancellation.
                                    pending.append((pid, task['id'], 'cancel'))
                                continue
                            calls = task.get('modelCalls', [])
                            for call in calls:
                                if call['state'] == 'submitting':
                                    call['state'] = 'unknown'
                                if call.get('cancellation') == 'sending':
                                    call['cancellation'] = 'unknown'
                            task = self._change(pid, task['id'], dict(projectId=pid,
                                status='cancelled' if task.get('cancelRequested') else 'interrupted', localState='stopped',
                                phase=None, modelCalls=calls, finishedAt=task.get('finishedAt') or _now(),
                                error='服务中断，原执行记录已保留；远端状态需核对，不会自动重新生成。'))
                        if task.get('cancelRequested'):
                            state = cancellation_state(task)
                            if task.get('remoteCancellation') != state:
                                task = self._change(pid, task['id'], {'remoteCancellation': state})
                        if task['status'] in TERMINAL - {'succeeded'} and task.get('placement') == 'pending':
                            outputs = self._registered_outputs(task)
                            if outputs != task.get('outputs', []):
                                task = self._change(pid, task['id'], {'outputs': outputs})
                        if task.get('cancelRequested') or any(call['state'] not in {'succeeded', 'failed', 'cancelled'} for call in task.get('modelCalls', [])):
                            pending.append((pid, task['id'], 'remote'))
                        if task['status'] in TERMINAL - {'succeeded'} and task.get('placement') == 'pending':
                            self._settle_terminal(pid, task['id'])
            except (OSError, ProjectError, ValueError, KeyError):
                logger.warning('工具任务恢复未完成，记录已保留：%s', pid, exc_info=True)
        return pending

    async def recover(self):
        pending = await blocking(self._recover_local)
        for pid, tid, action in pending:
            if action == 'cancel':
                job = self.jobs.get((pid, tid))
                if job and not job.done() and not job.cancelling():
                    job.cancel()
            elif (pid, tid) not in self.controls or self.controls[(pid, tid)].done():
                try:
                    await self._cancel_remotes(await blocking(self.get, pid, tid))
                except (OSError, ProjectError):
                    logger.warning('工具远端状态核对未完成：%s', tid, exc_info=True)

    async def start(self):
        await blocking(self._ensure_owner)
        await self.recover()
        async def maintain():
            while True:
                await asyncio.sleep(max(1, self.poll_interval))
                try:
                    await self.recover()
                except (OSError, ProjectError):
                    logger.warning('工具任务后台恢复待重试。', exc_info=True)
        self.maintenance = asyncio.create_task(maintain())

    async def close(self):
        self.closing = True
        if self.maintenance:
            self.maintenance.cancel()
            await asyncio.gather(self.maintenance, return_exceptions=True)
        await asyncio.gather(*self.admissions, return_exceptions=True)
        jobs = list(self.jobs.values())
        for job in jobs:
            if not job.done() and not job.cancelling():
                job.cancel()
        await asyncio.gather(*jobs, *self.controls.values(), return_exceptions=True)
        # Queued coroutines cancelled before their first instruction need an
        # explicit checkpoint too. Recovery never turns shutdown into a user cancel.
        if self.worker_lock:
            self.worker_lock.release()
            self.worker_lock = None
        await self.recover()
