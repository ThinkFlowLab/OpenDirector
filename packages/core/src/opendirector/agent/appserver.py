"""Codex app-server: one turn over the JSON-RPC stdio protocol.

`codex exec` reads one prompt from stdin and exits, so once a turn is running
nothing can reach the model. The app server is the same engine behind a
long-lived channel: a turn can be steered while it runs, and the conversation
keeps a thread id that a later turn can resume.
"""
import asyncio
import json
from collections.abc import Awaitable, Callable
from pathlib import Path

from opendirector.domain.projects import ProjectError

Emit = Callable[[dict], Awaitable[None]]

CLIENT = {'name': 'OpenDirector', 'version': '1.0'}


class Session:
    """A JSON-RPC channel over the app server's stdin and stdout."""

    def __init__(self, process):
        self.process = process
        self.notes: asyncio.Queue[dict] = asyncio.Queue()
        self.pending: dict[int, asyncio.Future] = {}
        self.next_id = 0
        self.reader = asyncio.create_task(self._read())

    async def _read(self):
        try:
            while line := await self.process.stdout.readline():
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if 'id' in data:
                    future = self.pending.pop(data['id'], None)
                    if future is not None and not future.done():
                        future.set_result(data)
                elif 'method' in data:
                    self.notes.put_nowait(data)
        except (asyncio.CancelledError, ValueError):
            return

    async def write(self, payload: dict):
        self.process.stdin.write(json.dumps(payload).encode() + b'\n')
        await self.process.stdin.drain()

    async def notify(self, method: str, params: dict | None = None):
        await self.write({'jsonrpc': '2.0', 'method': method, 'params': params or {}})

    async def call(self, method: str, params: dict, timeout: float = 60) -> dict:
        self.next_id += 1
        identifier = self.next_id
        future = asyncio.get_running_loop().create_future()
        self.pending[identifier] = future
        await self.write({'jsonrpc': '2.0', 'id': identifier, 'method': method, 'params': params})
        try:
            data = await asyncio.wait_for(future, timeout)
        except TimeoutError:
            raise ProjectError('codex app-server 没有响应，请检查登录和网络。', 502) from None
        finally:
            self.pending.pop(identifier, None)
        if 'error' in data:
            detail = (data['error'] or {}).get('message') or '未知原因'
            raise ProjectError(f'codex app-server 拒绝了 {method}：{detail}', 502)
        return data.get('result') or {}

    async def close(self):
        self.reader.cancel()
        await asyncio.gather(self.reader, return_exceptions=True)


async def run(process, *, work: Path, model: str | None, resume: str | None,
              prompt: str, fallback: str | None, steer: asyncio.Queue[str] | None,
              emit: Emit) -> str:
    """Run one turn and return the thread id that can be resumed later.

    `prompt` assumes the native thread is resumed and carries only the newest
    message; `fallback` is the same request with the whole history, used when a
    saved thread cannot be opened.
    """
    session = Session(process)
    try:
        await session.call('initialize', {'clientInfo': CLIENT})
        await session.notify('initialized')
        thread, resumed = await _thread(session, work, model, resume)
        # The trace keeps the native thread id the way the exec protocol kept
        # `thread.started`, so a run stays traceable to its engine session.
        await emit({'native': {'type': 'thread.started', 'thread_id': thread}})
        started = await session.call('turn/start', {
            'threadId': thread, 'input': [{'type': 'text', 'text': prompt if resumed or fallback is None else fallback}],
            **({'model': model} if model else {})})
        turn = (started.get('turn') or {}).get('id')
        if not turn:
            raise ProjectError('codex 没有开始这一轮回复。', 502)
        await _drive(session, thread, turn, steer, emit)
        return thread
    finally:
        await session.close()


async def _thread(session: Session, work: Path, model: str | None,
                  resume: str | None) -> tuple[str, bool]:
    settings = {'cwd': str(work), 'approvalPolicy': 'never', 'sandbox': 'workspace-write',
                **({'model': model} if model else {})}
    if resume:
        try:
            result = await session.call('thread/resume', {'threadId': resume, **settings})
            thread = (result.get('thread') or {}).get('id')
            if thread:
                return thread, True
        except ProjectError:
            # A stale thread id is not fatal: the turn starts over with the full
            # authoritative history instead of quietly losing the conversation.
            pass
    result = await session.call('thread/start', settings)
    thread = (result.get('thread') or {}).get('id')
    if not thread:
        raise ProjectError('codex 没有建立会话。', 502)
    return thread, False


async def _drive(session: Session, thread: str, turn: str,
                 steer: asyncio.Queue[str] | None, emit: Emit):
    note = asyncio.create_task(session.notes.get())
    wanted = asyncio.create_task(steer.get()) if steer is not None else None
    streamed: set[str] = set()
    try:
        while True:
            waiting = {task for task in (note, wanted) if task is not None}
            done, _ = await asyncio.wait(waiting, return_when=asyncio.FIRST_COMPLETED)
            if wanted is not None and wanted in done:
                text = wanted.result()
                await session.call('turn/steer', {
                    'threadId': thread, 'expectedTurnId': turn,
                    'input': [{'type': 'text', 'text': text}]})
                wanted = asyncio.create_task(steer.get())
            if note in done:
                message = note.result()
                note = asyncio.create_task(session.notes.get())
                method = message.get('method')
                params = message.get('params') or {}
                if method == 'item/agentMessage/delta':
                    if params.get('itemId'):
                        streamed.add(params['itemId'])
                    await emit({'type': 'delta', 'text': params.get('delta', '')})
                elif method == 'item/completed':
                    item = params.get('item') or {}
                    if item.get('type') == 'agentMessage' and item.get('id') not in streamed:
                        await emit({'type': 'delta', 'text': item.get('text', '')})
                elif method == 'turn/completed':
                    finished = params.get('turn') or {}
                    status = finished.get('status')
                    if status == 'failed':
                        detail = (finished.get('error') or {}).get('message') or '未知原因'
                        raise ProjectError(f'codex 运行失败：{detail}', 502)
                    return
    finally:
        for task in (note, wanted):
            if task is not None:
                task.cancel()
        await asyncio.gather(*[task for task in (note, wanted) if task is not None], return_exceptions=True)
