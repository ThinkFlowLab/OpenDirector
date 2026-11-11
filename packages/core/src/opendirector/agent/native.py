"""CLI runtimes use native skills and a turn-scoped business CLI."""
import asyncio
from contextlib import AsyncExitStack
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from urllib.request import getproxies
from uuid import UUID

from opendirector.agent.model_gateway import ModelGateway
from opendirector.agent import cli_transport, deepseek
from opendirector.agent.context import RunContext
from opendirector.agent.gateway import ToolGateway
from opendirector.agent.process import terminate
from opendirector.agent.tools import ROOT, SYSTEM
from opendirector.installation import BUNDLED
from opendirector.agent.skill_snapshot import prepare_skills
from opendirector.agent.directory_links import link_directory, unlink_directory
from opendirector.agent.owner_rights import native_owner_access
from opendirector.domain.projects import ProjectError
from opendirector.integrations.chat_completions import ChatCompletions


BUNDLED_INSTALL_ERROR = ('内置 Agent 依赖安装不完整或无法运行，请重新执行 pip install --force-reinstall opendirector；源码安装使用 pip install -e .。')


def executable(runtime: str) -> str | None:
    if runtime == 'default':
        for name in ('opencode.exe', 'opencode'):
            path = ROOT / 'node_modules/opencode-ai/bin' / name
            if path.is_file():
                return str(path)
        path = BUNDLED / 'bin' / ('opencode.exe' if os.name == 'nt' else 'opencode')
        return str(path) if path.is_file() else None
    return shutil.which('dsh' if runtime == 'deepseek' else runtime)


_CODEX_ISOLATION: dict[str, tuple[str, ...]] = {}


def codex_environment() -> dict[str, str]:
    env = dict(os.environ)
    if sys.platform == 'win32' and not (env.get('HTTPS_PROXY') or env.get('ALL_PROXY')):
        # A Windows system proxy need not be exported to the CLI process.
        if proxy := getproxies().get('https'):
            env['HTTPS_PROXY'] = proxy
    return env


def codex_isolation_flags(binary: str) -> tuple[str, ...]:
    """Optional codex flags this CLI accepts.

    Isolation flags vary across releases, and an unsupported flag prevents the
    CLI from starting. Keep rollouts on disk so later turns can resume them.
    """
    cached = _CODEX_ISOLATION.get(binary)
    if cached is not None:
        return cached
    wanted = ('--ignore-user-config', '--ignore-rules')
    try:
        probe = subprocess.run([binary, 'exec', '--help'], capture_output=True,
                               timeout=20, stdin=subprocess.DEVNULL)
        # Help text can contain bytes outside the console code page.
        help_text = (probe.stdout + probe.stderr).decode('utf-8', 'replace')
    except (OSError, subprocess.SubprocessError):
        help_text = ''
    flags = tuple(flag for flag in wanted if flag in help_text)
    _CODEX_ISOLATION[binary] = flags
    return flags


def codex_session_available(session_id: str) -> bool:
    home = Path(os.environ.get('CODEX_HOME', Path.home() / '.codex'))
    return any(path.is_file() for folder in ('sessions', 'archived_sessions')
               for path in (home / folder).glob(f'**/*{session_id}*.jsonl'))


def command(runtime: str, work: Path, socket: str, token: str, model: str | None,
            model_url: str, catalog: list[dict], *, input_modalities: list[str] | None = None,
            bridge_env: dict[str, str] | None = None,
            native_directory: Path | None = None) -> tuple[list[str], dict[str, str]]:
    binary = executable(runtime)
    if binary is None:
        raise ProjectError(BUNDLED_INSTALL_ERROR if runtime == 'default' else f'{runtime} CLI 未安装，请先安装。', 503)
    bundled = runtime == 'default'
    if bundled:
        runtime = 'opencode'
    env = cli_transport.environment(work, socket, bridge_env)
    if runtime == 'codex' and (proxy := codex_environment().get('HTTPS_PROXY')):
        env['HTTPS_PROXY'] = proxy
    if runtime == 'opencode':
        config = {'autoupdate': False, 'default_agent': 'opendirector',
            'agent': {'opendirector': {'mode': 'primary', 'prompt': SYSTEM}},
            'skills': {'paths': [str(work / '.agents/skills')]},
            'permission': {'*': 'deny', 'bash': 'allow', 'read': 'allow',
                'external_directory': 'allow',
                'skill': {'*': 'deny', **{item['name']: 'allow' for item in catalog}}},
            'mcp': {}}
        if bundled:
            # OpenDirector owns conversation titles. The native title is unused
            # and would submit a second paid model request on a fresh greeting.
            config['agent']['title'] = {'disable': True}
            config['provider'] = {'opendirector': {'npm': '@ai-sdk/openai-compatible', 'name': 'OpenDirector',
                'options': {'baseURL': model_url, 'apiKey': '{env:OPENDIRECTOR_MODEL_KEY}'},
                'models': {model: {'name': model, 'modalities': {'input': input_modalities or ['text'], 'output': ['text']}}}}}
            env.update(XDG_CONFIG_HOME=str(work), OPENDIRECTOR_MODEL_KEY=token)
        env.update(OPENCODE_DISABLE_EXTERNAL_SKILLS='1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS='1', OPENCODE_CONFIG_CONTENT=json.dumps(config))
        # OpenCode uses inherited PWD when resolving its local directory.
        env['PWD'] = str(native_directory or work)
        args = [binary, 'run', '--dir', str(native_directory or work), '--pure', '--format', 'json', '--agent', 'opendirector']
        if model:
            args += ['--model', f'opendirector/{model}' if bundled else model]
        return args, env
    if runtime == 'codex':
        settings = ['features.shell_tool=true', 'features.apply_patch_freeform=false', 'web_search="disabled"',
            'sandbox_workspace_write.network_access=true',
            'skills.bundled.enabled=false', f'developer_instructions={json.dumps(SYSTEM)}']
        args = [binary, 'exec', '--json', '--skip-git-repo-check', *codex_isolation_flags(binary), '--sandbox', 'workspace-write']
        for setting in settings:
            args += ['-c', setting]
    else:
        plugin = work / 'plugin'
        (plugin / '.claude-plugin').mkdir(parents=True, exist_ok=True)
        (plugin / '.claude-plugin/plugin.json').write_text(json.dumps({'name': 'opendirector', 'version': '0.1.2'}))
        skill_root = work / '.agents/skills'
        skill_root.mkdir(parents=True, exist_ok=True)
        unlink_directory(plugin / 'skills')
        link_directory(plugin / 'skills', skill_root)
        args = [binary, '-p', '--verbose', '--system-prompt', SYSTEM,
            '--output-format', 'stream-json', '--plugin-dir', str(plugin), '--tools', 'Skill,Bash,Read',
            '--strict-mcp-config', '--mcp-config', json.dumps({'mcpServers': {}}),
            '--allowedTools', 'Skill(opendirector:*)', 'Bash', 'Read',
            '--permission-mode', 'dontAsk', '--setting-sources', '']
    if model:
        args += ['--model', model]
    return args, env


def text_events(runtime: str, raw: dict) -> list[dict]:
    if runtime == 'claude' and raw.get('error') == 'authentication_failed':
        raise ProjectError('Claude Code 登录已过期，请在终端执行 claude auth login 后重试。', 401)
    if runtime == 'codex' and raw['type'] == 'error':
        # Codex also emits this event while reconnecting. Wait for turn.failed or process exit.
        return []
    if raw['type'] in {'error', 'turn.failed'} or raw['type'] == 'result' and raw.get('is_error'):
        raise ProjectError(f'{runtime} 运行失败，请检查登录、模型或原生轨迹。', 502)
    if runtime == 'opencode' and raw['type'] == 'text':
        return [{'type': 'delta', 'text': raw['part']['text']}]
    if runtime == 'codex' and raw['type'] == 'item.completed' and raw['item']['type'] == 'agent_message':
        return [{'type': 'delta', 'text': raw['item']['text']}]
    if runtime == 'claude' and raw['type'] == 'assistant':
        return [{'type': 'delta', 'text': part['text']} for part in raw['message']['content'] if part['type'] == 'text']
    return []


class NativeRuntime:
    def __init__(self, provider=None):
        self.transport = provider.transport if isinstance(provider, ChatCompletions) else None

    async def stream(self, run: RunContext, gateway: ToolGateway):
        project_id, turn_id = run.project_id, run.turn_id
        directory, config, context = run.directory, run.config, run.messages
        selected, thinking = run.selected_skills, run.thinking
        runtime, runtime_model, catalog = ('opencode' if run.runtime == 'default' else run.runtime), run.runtime_model, run.skills
        selection = {'model': runtime_model, 'thinking': thinking}
        if config:
            selection.update(config=config.get('id'), modelId=config['modelId'])
        session_id = run.native_session_id(selection)
        session_directory = run.native_session_directory() if session_id else None
        if session_id and session_directory is None:
            # Unverifiable session directories cannot be resumed. Preserve the
            # old session and start with authoritative conversation context.
            session_id = None
        if session_id and runtime == 'codex' and not codex_session_available(session_id):
            # Retain the validated workspace while rebuilding a missing native
            # conversation from the full authoritative history.
            session_id = None
        queue = asyncio.Queue(maxsize=128)
        pending = set()
        token = secrets.token_urlsafe(32)
        process = pump = stderr_task = None
        with TemporaryDirectory(prefix='od-agent-', dir=None if os.name == 'nt' else '/tmp') as temporary:
            reuse_workspace = session_directory is not None and runtime in {'codex', 'claude', 'deepseek'}
            work = session_directory if reuse_workspace else (directory / 'agent-runs' / str(turn_id) / 'work').resolve()
            work.mkdir(parents=True, exist_ok=reuse_workspace)
            gateway.execution_directory = work
            # OpenCode emits session events in the session's original instance
            # directory. Keep that engine directory stable, while the gateway,
            # CLI, skills and all published outputs remain scoped to this turn.
            native_work = session_directory or work
            server = model_server = model = None
            permissions = AsyncExitStack()
            try:
                if runtime == 'deepseek':
                    # A fresh tree is initialized before copying files. A saved
                    # session already has its standing projection; only lease
                    # its ancestors and validate the populated tree on resume.
                    await permissions.enter_async_context(native_owner_access(work,
                        **({'initialized': True} if reuse_workspace else {})))
                if runtime == 'opencode':
                    git = await asyncio.create_subprocess_exec(
                        'git', 'init', '--quiet', '--template=', cwd=work,
                        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
                    )
                    _, error = await git.communicate()
                    if git.returncode:
                        raise ProjectError(f'无法初始化画布执行目录：{error.decode(errors="replace").strip()}', 503)
                roots = prepare_skills(work, catalog)
                roots += [Path(item['filePath']).resolve().parent for item in catalog]
                gateway.roots = roots
                endpoint = str(Path(temporary) / 'cli.sock')
                server, bridge_env = await cli_transport.start_server(gateway, queue, endpoint, pending)
                if run.runtime == 'default':
                    model = ModelGateway(
                        config, thinking, token, str(project_id), str(turn_id), self.transport,
                        trace_path=work.parent.with_suffix('.model.jsonl'),
                    )
                model_server = await asyncio.start_server(model.connect, '127.0.0.1', 0) if model else None
                model_url = f'http://127.0.0.1:{model_server.sockets[0].getsockname()[1]}' if model_server else ''
                deepseek_server = None
                if runtime == 'deepseek':
                    env = cli_transport.environment(work, endpoint, bridge_env)
                    args, _, deepseek_server = deepseek.command(work, endpoint, token, bridge_env)
                else:
                    args, env = command(run.runtime, work, endpoint, token,
                        config['modelId'] if config else runtime_model, model_url, catalog, bridge_env=bridge_env,
                        **({'native_directory': native_work} if runtime == 'opencode' else {}),
                        **({'input_modalities': config.get('inputModalities', ['text'])} if run.runtime == 'default' else {}))
                if thinking != 'auto' and runtime == 'codex':
                    args += ['-c', f'model_reasoning_effort={json.dumps(thinking)}']
                elif thinking != 'auto' and runtime == 'claude':
                    args += ['--effort', thinking]
                if session_id and runtime != 'deepseek':
                    if runtime == 'codex':
                        args += ['resume', session_id, '-']
                    else:
                        args += ['--session' if runtime == 'opencode' else '--resume', session_id]
                execution_context = (f'Execution directory: {work}\nNative session directory: {native_work}\n'
                    'Set the native shell workdir to this execution directory for file and media operations. '
                    'Use inherited PATH to discover installed programs with command -v. '
                    'Read source assets at their supplied absolute paths; do not move or modify them. '
                    'Write all intermediate files and outputs into the execution directory. '
                    'Use opendirector --help to discover OpenDirector commands and opendirector <group> <command> --help for usage. Use opendirector for project changes.')
                prompt = execution_context + '\n' + json.dumps(context[-1:] if session_id else context, ensure_ascii=False)
                skill_instruction = ''
                if selected:
                    name = selected[0]
                    if runtime == 'codex':
                        prompt = f'${name}\n' + prompt
                    elif runtime == 'claude':
                        prompt = f'/opendirector:{name}\n' + prompt
                    elif runtime == 'deepseek':
                        skill_instruction = f'Use the native skill tool to load {name} from {work / ".agents/skills"} before proceeding.'
                    else:
                        prompt = f'Use the native skill tool to load {name} before proceeding.\n' + prompt
                env['OPENDIRECTOR_PROJECT_ID'] = str(run.project_id)
                try:
                    process = await asyncio.create_subprocess_exec(*args, cwd=native_work, env=env,
                        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE, start_new_session=True, limit=64 * 1024 * 1024)
                except OSError as error:
                    if run.runtime == 'default':
                        raise ProjectError(BUNDLED_INSTALL_ERROR, 503, code='agent_dependency_unavailable') from error
                    raise
                stderr_tail = bytearray()
                async def drain_stderr():
                    while chunk := await process.stderr.read(4096):
                        stderr_tail.extend(chunk)
                        del stderr_tail[:-8192]
                stderr_task = asyncio.create_task(drain_stderr())
                if runtime != 'deepseek':
                    process.stdin.write(prompt.encode() + b'\n')
                    await process.stdin.drain()
                    process.stdin.close()
                async def record_exit():
                    await stderr_task
                    diagnostic = stderr_tail.decode('utf-8', errors='replace').replace(token, '[redacted]')
                    if config and config.get('apiKey'):
                        diagnostic = diagnostic.replace(config['apiKey'], '[redacted]')
                    await queue.put({'native': {'type': 'diagnostic', 'stderr': diagnostic,
                                                'exitCode': process.returncode}})
                async def output():
                    try:
                        reported_session = None
                        if runtime == 'deepseek':
                            async def observe(raw):
                                await queue.put({'native': raw})
                            blocks = [execution_context] if session_id else [SYSTEM, execution_context]
                            if skill_instruction:
                                blocks.append(skill_instruction)
                            if not session_id and context[:-1]:
                                blocks.append('Conversation history\n' + json.dumps(context[:-1], ensure_ascii=False))
                            if context:
                                blocks.append('Current user request\n' + context[-1]['content'])
                            reported_session = await deepseek.run(process, work, blocks, runtime_model, thinking,
                                                            deepseek_server, observe, session_id)
                        else:
                            while line := await process.stdout.readline():
                                raw = json.loads(line)
                                previous_session = reported_session
                                if runtime == 'codex' and raw['type'] == 'thread.started':
                                    reported_session = raw.get('thread_id')
                                elif runtime == 'opencode':
                                    reported_session = raw.get('sessionID') or reported_session
                                elif runtime == 'claude':
                                    reported_session = raw.get('session_id') or reported_session
                                if (previous_session and reported_session != previous_session
                                        or session_id and reported_session and reported_session != session_id):
                                    raise ProjectError('Harness 返回了不同的会话 ID。', 502)
                                await queue.put({'native': raw})
                        if await process.wait():
                            await record_exit()
                            raise ProjectError(f'{runtime} 进程退出（{process.returncode}），请检查 CLI 登录和配置。', 502)
                        if reported_session:
                            run.save_native_session(reported_session, selection,
                                engine_directory=native_work,
                                work_turn_id=run.turn_id if native_work == work and not reuse_workspace else UUID(native_work.parent.name))
                    except ProjectError:
                        if runtime == 'deepseek' and process.returncode:
                            await record_exit()
                        raise
                    finally:
                        await queue.put(None)
                pump = asyncio.create_task(output())
                run_dir = directory / 'agent-runs'
                run_dir.mkdir(exist_ok=True)
                native_calls = {}
                with (run_dir / f'{turn_id}.{runtime}.jsonl').open('a', encoding='utf-8') as trace:
                    while (event := await queue.get()) is not None:
                        trace.write(json.dumps(event, ensure_ascii=False) + '\n')
                        trace.flush()
                        if 'native' in event:
                            for item in (deepseek.events(event['native'], native_calls) if runtime == 'deepseek' else text_events(runtime, event['native'])):
                                yield item
                        else:
                            yield event
                    await pump
            finally:
                try:
                    await gateway.close()
                    if server:
                        server.close()
                        await server.wait_closed()
                    if model_server:
                        model.closed = True
                        model_server.close()
                        await model_server.wait_closed()
                        for task in model.active:
                            task.cancel()
                        await asyncio.gather(*model.active, return_exceptions=True)
                    if runtime == 'deepseek' and pump and not pump.done():
                        while not queue.empty():
                            queue.get_nowait()
                        pump.cancel()
                        await asyncio.gather(pump, return_exceptions=True)
                    if process is not None:
                        await terminate(process, group=True)
                    while not queue.empty():
                        queue.get_nowait()
                    if pump:
                        pump.cancel()
                        await asyncio.gather(pump, return_exceptions=True)
                    while not queue.empty():
                        queue.get_nowait()
                    if stderr_task:
                        stderr_task.cancel()
                        await asyncio.gather(stderr_task, return_exceptions=True)
                    if pending:
                        await asyncio.gather(*pending, return_exceptions=True)
                finally:
                    try:
                        if process is not None and process.returncode is None:
                            await terminate(process, group=True)
                    finally:
                        await permissions.__aexit__(*sys.exc_info())
