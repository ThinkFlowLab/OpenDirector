"""One-shot prompt completion in a native CLI with project tools disabled."""

import asyncio
from base64 import b64decode
import json
import os
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory

from opendirector.agent import native
from opendirector.agent.process import terminate
from opendirector.domain.projects import ProjectError


async def resolve_model(runtime, model):
    """Resolve the Codex default model without importing the runtime module.

    `agent.runtime` imports `agent.tools`, which reaches this module through the
    prompt optimization service, so a top-level runtime import would cycle.
    """
    if runtime != 'codex' or model:
        return model
    from opendirector.agent.catalog import model_choices
    choices = await model_choices('codex')
    return next((item['id'] for item in choices if item.get('isDefault')), None)


def cli_args(runtime):
    # A request chooses one of these adapters. It never names the executable
    # to look up or any component of its installation path.
    if runtime == 'codex':
        binary = native.executable('codex')
        command = 'codex'
        package_entry = 'node_modules/@openai/codex/bin/codex.js'
    elif runtime == 'claude':
        binary = native.executable('claude')
        command = 'claude'
        package_entry = 'node_modules/@anthropic-ai/claude-code/bin/claude.exe'
    else:
        raise ProjectError('右侧 Agent 的 CLI 暂不支持独立的提示词优化，请在右侧切换 Agent 或模型。',
                           409, code='prompt_optimization_cli_unsupported')
    if not binary:
        raise ProjectError('提示词优化需要已安装并登录右侧 Agent 的 CLI。', 503, code='prompt_optimization_cli')
    # Discovery supplies an installed launcher. Do not resolve a relative
    # executable against the temporary prompt directory.
    path = Path(binary)
    if path.is_absolute() and (os.name != 'nt' or path.suffix.lower() == '.exe') and path.is_file():
        return [binary]
    # Execute only the known npm entry inside the discovered Windows
    # installation. Never relay request arguments through a batch wrapper.
    if (os.name == 'nt' and path.is_absolute() and path.is_file()
            and path.stem.lower() == command and path.suffix.lower() in {'.bat', '.cmd'}):
        root = path.parent.resolve()
        entry = (root / package_entry).resolve()
        if entry.is_relative_to(root) and entry.is_file():
            if command == 'claude':
                return [str(entry)]
            node = shutil.which('node.exe')
            if node and Path(node).is_absolute() and Path(node).is_file():
                return [node, str(entry)]
    raise ProjectError('提示词优化需要可直接运行的 Agent CLI，请检查安装。', 503, code='prompt_optimization_cli')


def codex_input(args, work, parts):
    text = []
    images = 0
    for part in parts:
        if part['type'] == 'text':
            text.append(part['text'])
            continue
        images += 1
        file = work / f'reference-{images}.jpg'
        file.write_bytes(b64decode(part['image_url']['url'].split(',', 1)[1], validate=True))
        args += ['--image', str(file)]
        text.append(f'[Attached image {images}]')
    return '\n\n'.join(text)


async def rewrite(runtime, model, thinking, messages):
    args = cli_args(runtime)
    model = await resolve_model(runtime, model)
    rules, user = (message['content'] for message in messages)
    parts = [{'type': 'text', 'text': user}] if isinstance(user, str) else user
    with TemporaryDirectory(prefix='od-prompt-cli-') as directory:
        work = Path(directory)
        env = native.codex_environment() if runtime == 'codex' else None
        if runtime == 'codex':
            if os.name == 'nt':
                env.pop('CODEX_WINDOWS_REGISTERED_CORE', None)
                env.pop('CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY', None)
            flags = await asyncio.to_thread(native.codex_isolation_flags, tuple(args))
            args += ['exec', '--json', '--ephemeral', '--skip-git-repo-check', *flags, '--sandbox', 'read-only',
                    '-c', 'approval_policy="never"', '-c', 'features.shell_tool=false',
                    '-c', 'features.apply_patch_freeform=false', '-c', 'web_search="disabled"',
                    '-c', 'skills.bundled.enabled=false', '-c', 'mcp_servers={}',
                    '-c', f'developer_instructions={json.dumps(rules, ensure_ascii=False)}']
            if os.name == 'nt':
                args += ['-c', 'windows.sandbox="elevated"']
            if thinking != 'auto':
                args += ['-c', f'model_reasoning_effort={json.dumps(thinking)}']
            if model:
                args += ['--model', model]
            data = codex_input(args, work, parts)
            args += ['--', '-']
        else:
            args += ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json',
                    '--no-session-persistence', '--tools', '', '--strict-mcp-config',
                    '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--system-prompt', rules]
            if thinking != 'auto':
                args += ['--effort', thinking]
            if model:
                args += ['--model', model]
            content = [part if part['type'] == 'text' else {'type': 'image', 'source': {
                'type': 'base64', 'media_type': 'image/jpeg', 'data': part['image_url']['url'].split(',', 1)[1]
            }} for part in parts]
            data = json.dumps({'type': 'user', 'message': {'role': 'user', 'content': content}}, ensure_ascii=False)
        try:
            process = await asyncio.create_subprocess_exec(*args, cwd=work, env=env,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, start_new_session=True)
        except OSError as error:
            raise ProjectError('提示词优化需要可直接运行的 Agent CLI，请检查安装。', 503,
                code='prompt_optimization_cli') from error
        try:
            output, _ = await process.communicate((data + '\n').encode())
            if process.returncode != 0:
                raise ProjectError('右侧 Agent 的 CLI 未完成提示词优化，请检查模型和登录。', 502, code='prompt_optimization_cli')
            records = [json.loads(line) for line in output.splitlines() if line.strip()]
            if runtime == 'codex' and any(row.get('type') == 'turn.completed' for row in records):
                return next((row['item']['text'] for row in reversed(records)
                    if row.get('type') == 'item.completed' and row['item']['type'] == 'agent_message'), '')
            if runtime == 'claude':
                return next((row['result'] for row in reversed(records)
                    if row.get('type') == 'result' and row.get('subtype') == 'success'), '')
            return ''
        finally:
            await terminate(process, group=True)
