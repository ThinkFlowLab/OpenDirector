"""Read model choices from the installed harness without starting a model turn."""
import asyncio
import json
import os
import re
import secrets
from pathlib import Path

import httpx
from pydantic import BaseModel, Field

from opendirector.agent.native import codex_environment, executable
from opendirector.agent.process import terminate
from opendirector.domain.projects import ProjectError


class ModelChoice(BaseModel):
    id: str
    label: str
    efforts: list[str] = Field(default_factory=list)
    isDefault: bool = Field(default=False, exclude_if=lambda value: not value)


async def opencode_fallback(binary: str, configured_providers: list[str]) -> str | None:
    """Use the native provider order and model ranking, without a model turn."""
    password = secrets.token_urlsafe(24)
    process = await asyncio.create_subprocess_exec(
        binary, 'serve', '--pure', '--hostname', '127.0.0.1', '--port', '0',
        env={**os.environ, 'OPENCODE_SERVER_PASSWORD': password},
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, start_new_session=True)
    try:
        async with asyncio.timeout(15):
            while line := await process.stdout.readline():
                address = re.search(rb'http://127\.0\.0\.1:\d+', line)
                if not address:
                    continue
                async with httpx.AsyncClient(trust_env=False, auth=(
                    os.environ.get('OPENCODE_SERVER_USERNAME', 'opencode'), password)) as client:
                    response = await client.get(address[0].decode() + '/config/providers')
                    response.raise_for_status()
                    data = response.json()
                provider = next((item for item in data['providers']
                    if not configured_providers or item['id'] in configured_providers), None)
                if provider and (model := data['default'].get(provider['id'])):
                    return f"{provider['id']}/{model}"
                return None
        return None
    finally:
        await terminate(process, group=True)


async def model_choices(runtime: str) -> list[dict]:
    if runtime == 'deepseek':
        from opendirector.agent.deepseek import model_choices as deepseek_models
        return await deepseek_models()
    if runtime == 'jiuwenswarm':
        from opendirector.agent.jiuwenswarm import model_choices as swarm_models
        return await swarm_models()
    if runtime == 'pi':
        from opendirector.agent.pi import model_choices as pi_models
        binary = executable('pi')
        if binary is None:
            raise ProjectError('CLI 尚未安装。', 503)
        return await pi_models(binary)
    if runtime not in {'opencode', 'codex', 'claude'}:
        raise ProjectError('此引擎使用模型设置中的模型。')
    binary = executable(runtime)
    if binary is None:
        raise ProjectError('CLI 尚未安装。', 503)
    if runtime == 'opencode':
        process = await asyncio.create_subprocess_exec(binary, 'models', '--pure',
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, start_new_session=True)
        try:
            output, _ = await asyncio.wait_for(process.communicate(), 15)
            if process.returncode != 0:
                raise ProjectError('读取 OpenCode 模型列表失败，请检查本机配置。', 503)
            rows = [ModelChoice(id=line, label=line) for line in output.decode().splitlines() if '/' in line]
            config_process = await asyncio.create_subprocess_exec(binary, 'debug', 'config',
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, start_new_session=True)
            try:
                data, _ = await asyncio.wait_for(config_process.communicate(), 10)
                configuration = json.loads(data) if config_process.returncode == 0 else {}
                configured = configuration.get('model')
            finally:
                await terminate(config_process, group=True)
            if not configured:
                state = Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local/state')) / 'opencode/model.json'
                if state.is_file():
                    recent = json.loads(state.read_text()).get('recent', [])
                    configured = next((f"{item['providerID']}/{item['modelID']}" for item in recent
                                       if any(row.id == f"{item['providerID']}/{item['modelID']}" for row in rows)), None)
            if not configured:
                configured = await opencode_fallback(binary, list(configuration.get('provider', {})))
            for row in rows:
                row.isDefault = row.id == configured
            if configured and not any(row.id == configured for row in rows):
                rows.insert(0, ModelChoice(id=configured, label=configured, isDefault=True))
            return [row.model_dump() for row in rows]
        except (TimeoutError, UnicodeError, OSError, ValueError, httpx.HTTPError) as error:
            raise ProjectError('读取 OpenCode 模型列表失败，请重试。', 503) from error
        finally:
            await terminate(process, group=True)
    args = ['app-server'] if runtime == 'codex' else [
        '-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json']
    try:
        process = await asyncio.create_subprocess_exec(
            binary, *args, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, start_new_session=True, limit=4 * 1024 * 1024,
            env=codex_environment() if runtime == 'codex' else None)
    except OSError as error:
        raise ProjectError('CLI 无法启动，请检查安装。', 503) from error

    async def request(message, request_id):
        process.stdin.write((json.dumps(message) + '\n').encode())
        await process.stdin.drain()
        while line := await process.stdout.readline():
            event = json.loads(line)
            if runtime == 'codex' and event.get('id') == request_id:
                if 'error' in event:
                    raise ProjectError('CLI 无法提供模型列表。', 503)
                return event['result']
            if runtime == 'claude' and event.get('type') == 'control_response':
                response = event['response']
                if response.get('request_id') == request_id:
                    if response['subtype'] != 'success':
                        raise ProjectError('CLI 无法提供模型列表。', 503)
                    return response['response']
        raise ProjectError('CLI 未返回模型列表。', 503)

    try:
        async with asyncio.timeout(15):
            if runtime == 'codex':
                await request({'id': 1, 'method': 'initialize', 'params': {
                    'clientInfo': {'name': 'opendirector', 'version': '0.1'},
                    'capabilities': {'experimentalApi': True}}}, 1)
                process.stdin.write(b'{"method":"initialized"}\n')
                try:
                    configuration = await request({'id': 3, 'method': 'config/read', 'params': {'includeLayers': False}}, 3)
                    configured = configuration.get('config', {}).get('model')
                except ProjectError:
                    configured = None
                rows, cursor = [], None
                while True:
                    result = await request({'id': 2, 'method': 'model/list',
                        'params': {'cursor': cursor, 'limit': 100}}, 2)
                    rows.extend(result['data'])
                    cursor = result.get('nextCursor')
                    if not cursor:
                        break
                choices = [ModelChoice(id=item['model'], label=item['displayName'],
                    efforts=[effort['reasoningEffort'] for effort in item.get('supportedReasoningEfforts', [])],
                    isDefault=item['model'] == configured if configured else item.get('isDefault', False))
                    for item in rows if not item.get('hidden', False)]
                if configured and not any(item.id == configured for item in choices):
                    choices.insert(0, ModelChoice(id=configured, label=configured, isDefault=True))
                return [item.model_dump() for item in choices]
            result = await request({'type': 'control_request', 'request_id': 'model-catalog',
                'request': {'subtype': 'initialize'}}, 'model-catalog')
            return [ModelChoice(id=item['value'], label=(item.get('resolvedModel') if item['value'] == 'default' else None) or item.get('displayName') or item['value'],
                efforts=item.get('supportedEffortLevels', []), isDefault=item['value'] == 'default' or item.get('isDefault', False)).model_dump()
                for item in result['models'] if not item.get('disabled', False)]
    except (TimeoutError, OSError, ValueError, KeyError, TypeError) as error:
        raise ProjectError('读取 CLI 模型列表失败，请重试或检查 CLI 配置。', 503) from error
    finally:
        await terminate(process, group=True)
