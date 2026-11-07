"""Jiuwen Process CLI transport; project operations stay in ToolGateway."""
import asyncio
from contextlib import suppress
import json
import os
from pathlib import Path
from uuid import UUID
import shutil
from tempfile import TemporaryDirectory
from uuid import uuid4

from opendirector.agent.context import RunContext
from opendirector.agent.gateway import ToolGateway
from opendirector.agent.skill_snapshot import prepare_skills
from opendirector.agent.tools import SYSTEM
from opendirector.agent import cli_transport
from opendirector.agent.process import terminate
from opendirector.domain.projects import ProjectError


def executable():
    return shutil.which('jiuwenswarm-process')


async def model_choices(binary=None):
    data = await query('model.list', binary=binary)
    return [dict(id=item['selection_key'], label=item['display_name'], efforts=[],
        isDefault=item['is_default']) for item in data['models']]


async def readiness(binary=None):
    """Probe the CLI. `binary` is the path runtime.installation() resolved."""
    binary = binary or executable()
    if binary is None:
        return 'not_installed'
    try:
        await query('protocol.capabilities', binary=binary)
        return 'ready' if (await query('model.list', binary=binary))['models'] else 'needs_configuration'
    except ProjectError:
        return 'unknown'


async def execute(request, *, cwd, env=None, on_event=None, on_tool_call=None, cancel=None, binary=None):
    binary = binary or executable()
    if binary is None:
        raise ProjectError('jiuwenswarm-process 尚未安装。', 503)
    querying = request['type'] == 'query'
    process = await asyncio.create_subprocess_exec(binary,
        *(['--query-json', '-'] if querying else ['--run-jsonl']), cwd=cwd,
        env={**os.environ, **(env or {})}, stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        start_new_session=True, limit=8 * 1024 * 1024)

    async def write(control):
        process.stdin.write((json.dumps(control, ensure_ascii=False) + '\n').encode())
        await process.stdin.drain()

    async def drain_stderr():
        while await process.stderr.read(8192):
            pass

    async def watch_cancel():
        await cancel.wait()
        with suppress(BrokenPipeError, ConnectionResetError):
            await write({'schema_version': '0.1', 'type': 'cancel', 'request_id': request['request_id']})

    stderr = asyncio.create_task(drain_stderr())
    watcher = asyncio.create_task(watch_cancel()) if cancel is not None else None
    result = None
    sequence = 0
    session = None
    try:
        await write(request)
        if querying:
            process.stdin.close()
        while line := await process.stdout.readline():
            record = json.loads(line)
            if (not isinstance(record, dict) or not line.endswith(b'\n')
                or record.get('schema_version') != '0.1'
                or record.get('request_id') != request['request_id']
                or record.get('sequence') != sequence or result is not None):
                raise ValueError('Invalid Jiuwen CLI record')
            sequence += 1
            if record.get('session_id') is not None:
                if session is not None and session != record['session_id']:
                    raise ValueError('Jiuwen session changed')
                session = record['session_id']
            if record['type'] == ('query_result' if querying else 'result'):
                result = record
            elif record['type'] == 'event' and not querying:
                await on_event(record)
                if cancel is not None and cancel.is_set():
                    continue
                if record['event_type'] == 'host_tool.requested':
                    value = await on_tool_call(record)
                    await write({'schema_version': '0.1', 'type': 'tool_result',
                        'request_id': request['request_id'], 'session_id': session,
                        'call_id': record['payload']['call_id'], 'result': value})
                elif record['event_type'] == 'interaction.requested':
                    raise ProjectError('JiuwenSwarm 需要尚未支持的用户交互，执行已中断。', 502)
            else:
                raise ValueError('Unexpected Jiuwen CLI record')
        code = await process.wait()
        await stderr
        if result is None or result.get('exit_code') != code:
            raise ValueError('Jiuwen CLI missing terminal result or exit code mismatch')
        return result
    finally:
        if watcher is not None:
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)
        process.stdin.close()
        await terminate(process, group=True)
        stderr.cancel()
        await asyncio.gather(stderr, return_exceptions=True)


async def query(operation: str, *, binary=None) -> dict:
    try:
        with TemporaryDirectory(prefix='od-jiuwen-query-') as temporary:
            async with asyncio.timeout(30):
                result = await execute({'schema_version': '0.1', 'type': 'query',
                    'request_id': str(uuid4()), 'operation': operation, 'params': {}}, cwd=temporary, binary=binary)
    except (ValueError, KeyError, TypeError, TimeoutError, OSError) as error:
        raise ProjectError('JiuwenSwarm 查询失败，请检查 CLI 版本与本机配置。', 503) from error
    if result['status'] != 'completed':
        raise ProjectError('JiuwenSwarm 查询失败，请检查本机配置。', 503)
    if operation == 'protocol.capabilities':
        data = result['data']
        if data['schema_version'] != '0.1' or not all(data['features'].get(name) for name in ('cancel', 'run_skills', 'custom_agent')):
            raise ProjectError('JiuwenSwarm CLI 协议不支持所需能力，请更新 CLI。', 503)
    return result['data']


class JiuwenSwarmRuntime:
    async def stream(self, run: RunContext, gateway: ToolGateway):
        if run.thinking != 'auto':
            raise ProjectError('JiuwenSwarm 的思考级别由本机模型配置管理，请选择自动。')
        await query('protocol.capabilities')
        selection = {'model': run.runtime_model, 'thinking': run.thinking}
        saved = run.native_session(selection)
        runs = run.directory / 'agent-runs'
        work_turn_id = run.turn_id
        session_id = None
        if saved and saved.get('workTurnId'):
            previous_turn_id = UUID(saved['workTurnId'])
            if (runs / str(previous_turn_id) / 'work').is_dir():
                work_turn_id = previous_turn_id
                session_id = saved['sessionId']
        work = (runs / str(work_turn_id) / 'work').resolve()
        work.mkdir(parents=True, exist_ok=session_id is not None)
        gateway.execution_directory = work
        gateway.roots = prepare_skills(work, run.skills)
        queue = asyncio.Queue(maxsize=128)
        cancel = asyncio.Event()
        stopping = False
        emitted_chars = 0
        terminal_written = False
        with TemporaryDirectory(prefix='od-jiuwen-') as temporary:
            async with cli_transport.turn_environment(work, gateway, queue, temporary) as cli_env:
                state = run.native_session_path() or Path(temporary)
                config = Path(temporary) / 'config'
                config.mkdir()
                # Native model execution resolves DATA_DIR/config, unlike the
                # catalog which also honors CONFIG_DIR. Use one temporary root
                # with persistent agent state so both read the same config.
                runtime_root = Path(temporary)
                (state / 'agent').mkdir(parents=True, exist_ok=True)
                if state != runtime_root:
                    (runtime_root / 'agent').symlink_to(state / 'agent', target_is_directory=True)
                # Keep credentials out of published execution files and native traces.
                home = Path(os.environ.get('JIUWENSWARM_HOME', Path.home()))
                source = Path(os.environ.get('JIUWENSWARM_DATA_DIR', home / '.jiuwenswarm')) / 'config'
                for name in ('config.yaml', '.env'):
                    if (source / name).is_file():
                        shutil.copyfile(source / name, config / name)
                        (config / name).chmod(0o600)
                if not (config / 'config.yaml').is_file():
                    raise ProjectError('请先运行 jiuwenswarm-init 并配置模型。', 503)
                skill_root = Path(temporary) / 'skills'
                skill_root.mkdir()
                for root in gateway.roots:
                    shutil.copytree(root, skill_root / root.name)
                skill_link = state / 'agent/workspace/skills'
                skill_link.parent.mkdir(parents=True, exist_ok=True)
                if skill_link.is_symlink():
                    skill_link.unlink()
                skill_link.symlink_to(skill_root, target_is_directory=True)
                gateway.roots += list(skill_root.iterdir())
                request = {'schema_version': '0.1', 'type': 'run', 'request_id': str(run.turn_id),
                    'input': (f'Execution directory: {work}\n'
                        'Use inherited PATH to discover installed programs with command -v. '
                        'Read source assets at their supplied absolute paths; do not move or modify them. '
                        'Write intermediate files and outputs into the execution directory. '
                        'Use opendirector --help to discover project commands and use opendirector for project changes.\n'
                        + json.dumps(run.messages[-1:] if session_id else run.messages, ensure_ascii=False)),
                    'agent': {'name': 'opendirector', 'instructions': SYSTEM,
                        'tools': ['skill_tool', 'list_skill', 'read_file', 'bash']},
                    'skills': run.selected_skills, 'mcp': [], 'host_tools': [],
                    'workspace': {'cwd': str(work), 'project_dir': str(work)}}
                if session_id:
                    request['session_id'] = session_id
                if run.runtime_model:
                    request['model'] = run.runtime_model
                trace_path = runs / f'{run.turn_id}.jiuwenswarm.jsonl'
                with trace_path.open('a', encoding='utf-8') as trace:
                    async def emit(event):
                        if not stopping:
                            await queue.put(event)

                    async def observe(record):
                        nonlocal emitted_chars
                        trace.write(json.dumps({'native': record}, ensure_ascii=False) + '\n')
                        trace.flush()
                        if record['event_type'] == 'chat.delta':
                            text = record['payload']['text']
                            emitted_chars += len(text)
                            if text:
                                await emit({'type': 'delta', 'text': text})
                        elif record['event_type'] in {'chat.tool_call', 'chat.tool_result'}:
                            tool = record['payload']['tool']
                            if tool['name'] not in gateway.names:
                                detail = json.dumps(tool['result'], ensure_ascii=False)
                                await emit({'type': 'tool', 'id': 'native:' + tool['call_id'], 'name': tool['name'],
                                    'status': {'started': 'running', 'completed': 'complete', 'failed': 'failed'}[tool['status']],
                                    'arguments': tool['arguments'], 'result': detail[:65536],
                                    'resultTruncated': len(detail) > 65536})

                    task = asyncio.create_task(execute(request, cwd=str(work), env={**cli_env, 'JIUWENSWARM_DATA_DIR': str(runtime_root),
                        'JIUWENSWARM_CONFIG_DIR': str(config)}, on_event=observe, cancel=cancel))
                    pending = None
                    try:
                        while True:
                            pending = asyncio.create_task(queue.get())
                            done, _ = await asyncio.wait((task, pending), return_when=asyncio.FIRST_COMPLETED)
                            if pending in done:
                                yield pending.result()
                            if task in done:
                                break
                        while not queue.empty():
                            yield queue.get_nowait()
                        result = task.result()
                        trace.write(json.dumps({'native': result}, ensure_ascii=False) + '\n')
                        terminal_written = True
                        if result['status'] != 'completed':
                            reason = (result.get('error') or {}).get('message')
                            if reason:
                                raise ProjectError(f"JiuwenSwarm 执行未完成（{result['status']}）：{reason}", 502)
                            raise ProjectError(f"JiuwenSwarm 执行未完成（{result['status']}），请检查原生轨迹。", 502)
                        if session_id and session_id != result['session_id']:
                            raise ProjectError('JiuwenSwarm 返回了不同的会话 ID。', 502)
                        run.save_native_session(result['session_id'], selection, work_turn_id=work_turn_id)
                        # The terminal output includes the deltas and any unflushed final tail.
                        remaining = (result.get('output') or '')[emitted_chars:]
                        if remaining:
                            yield {'type': 'delta', 'text': remaining}
                    except (ValueError, KeyError, TypeError, TimeoutError, OSError) as error:
                        raise ProjectError('JiuwenSwarm 执行失败或需要尚未支持的用户交互，请检查原生轨迹。', 502) from error
                    finally:
                        stopping = True
                        if pending is not None:
                            pending.cancel()
                            await asyncio.gather(pending, return_exceptions=True)
                        cancel.set()
                        if not task.done():
                            try:
                                await asyncio.wait_for(asyncio.shield(task), 10)
                            except (TimeoutError, ValueError, KeyError, TypeError, OSError):
                                task.cancel()
                        with suppress(asyncio.CancelledError, ValueError, KeyError, TypeError, OSError):
                            result = await task
                            if not terminal_written:
                                trace.write(json.dumps({'native': result}, ensure_ascii=False) + '\n')
