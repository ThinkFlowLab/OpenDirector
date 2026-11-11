"""DeepSeek Harness CLI over standard ACP JSON-RPC; no Python SDK required."""
import asyncio
from contextlib import suppress
import json
import os
from pathlib import Path
import shutil
import sys
from tempfile import TemporaryDirectory

import yaml

from opendirector.agent.process import terminate
from opendirector.domain.projects import ProjectError


class Client:
    def __init__(self, process, observe=None):
        self.process = process
        self.observe = observe
        self.sequence = 0
        self.session = None

    async def write(self, record):
        self.process.stdin.write((json.dumps(record, ensure_ascii=False) + '\n').encode())
        await self.process.stdin.drain()

    async def request(self, method, params):
        self.sequence += 1
        identity = self.sequence
        await self.write({'jsonrpc': '2.0', 'id': identity, 'method': method, 'params': params})
        while line := await self.process.stdout.readline():
            record = json.loads(line)
            if not line.endswith(b'\n') or not isinstance(record, dict) or record.get('jsonrpc') != '2.0':
                raise ProjectError('DeepSeek Harness ACP 协议不匹配。', 502)
            if self.observe:
                await self.observe(record)
            if 'method' in record:
                if 'id' not in record:
                    continue
                if record['method'] == 'session/request_permission':
                    # Native policy requests never imply an unattended grant.
                    options = record['params']['options']
                    rejected = next((item for item in options if item['kind'] == 'reject_once'), None)
                    outcome = {'outcome': 'selected', 'optionId': rejected['optionId']} if rejected else {'outcome': 'cancelled'}
                    response = {'jsonrpc': '2.0', 'id': record['id'], 'result': {'outcome': outcome}}
                else:
                    response = {'jsonrpc': '2.0', 'id': record['id'],
                        'error': {'code': -32601, 'message': 'Client method is not supported'}}
                await self.write(response)
                continue
            if record.get('id') != identity:
                raise ProjectError('DeepSeek Harness ACP 回复标识不匹配。', 502)
            if 'error' in record:
                raise ProjectError(f"DeepSeek Harness 请求失败（{method}），请检查 CLI 模型与配置。", 502)
            return record['result']
        raise ProjectError('DeepSeek Harness 在回复完成前退出。', 502)

    async def initialize(self, work, servers, session_id=None):
        result = await self.request('initialize', {'protocolVersion': 1,
            'clientInfo': {'name': 'opendirector', 'version': '0.1.3'}, 'clientCapabilities': {}})
        if result['protocolVersion'] != 1:
            raise ProjectError('DeepSeek Harness 不支持 ACP v1，请更新 CLI。', 503)
        params = {'cwd': str(work), 'mcpServers': servers}
        if session_id:
            result = await self.request('session/resume', {**params, 'sessionId': session_id})
            self.session = session_id
        else:
            result = await self.request('session/new', params)
            self.session = result['sessionId']
        return result.get('configOptions', [])

    async def close(self):
        if self.session:
            await self.request('session/close', {'sessionId': self.session})
        self.process.stdin.close()
        await self.process.wait()


def arguments(private, skill_root=None):
    binary = shutil.which('dsh')
    if binary is None:
        raise ProjectError('DeepSeek Harness 尚未安装，请安装 dsh CLI。', 503)
    home = Path(os.environ.get('DSH_HOME', Path.home() / '.dsh')).expanduser()
    desktop = home / 'profiles/desktop/cordis.patch.yml'
    acp = home / 'profiles/acp/cordis.patch.yml'
    try:
        desktop_rows = (yaml.safe_load(desktop.read_text(encoding='utf-8')) or []) if desktop.is_file() else []
        acp_rows = (yaml.safe_load(acp.read_text(encoding='utf-8')) or []) if acp.is_file() else []
    except yaml.YAMLError as error:
        raise ProjectError('无法读取 DeepSeek Harness 原生模型配置。', 503) from error
    overridden = {row.get('id') for row in acp_rows if 'config' in row}
    rows = [row for row in desktop_rows if row.get('id', '').startswith('llm-')
        and row['id'] not in overridden and 'config' in row]
    default = next((row['config'] for row in desktop_rows if row.get('id') == 'agent-default-model'), None)
    if default and 'acp' not in overridden:
        rows.append({'id': 'acp', 'config': {key: default[key] for key in ('provider', 'model')}})
    rows.append({'id': 'skill-filesystem', 'config': {'includeDefaultRoots': False,
        'customSkillDirs': [str(skill_root)] if skill_root else [], 'watch': False}})
    patch = private / 'deepseek.patch.json'
    patch.write_text(json.dumps(rows, ensure_ascii=False), encoding='utf-8')
    patch.chmod(0o600)
    return [binary, '--profile', 'acp', '--patch', str(patch)]


def command(work, socket, token, bridge_env=None):
    args = arguments(Path(socket).parent, work / '.agents/skills')
    return args, dict(os.environ), None


async def model_choices(selected=None):
    with TemporaryDirectory(prefix='od-deepseek-query-') as temporary:
        process = await asyncio.create_subprocess_exec(*arguments(Path(temporary)), cwd=temporary,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, start_new_session=True, limit=8 * 1024 * 1024)
        client = Client(process)
        try:
            async with asyncio.timeout(30):
                options = await client.initialize(Path(temporary), [])
                default_value = next(item for item in options if item['id'] == 'model')['currentValue']
                if selected:
                    result = await client.request('session/set_config_option', {'sessionId': client.session, 'configId': 'model', 'value': selected})
                    options = result['configOptions']
                model = next(item for item in options if item['id'] == 'model')
                reasoning = next((item for item in options if item['id'] == 'reasoning_effort'), {})
                efforts = [item['value'] for item in reasoning.get('options', []) if item['value'] in {'low', 'medium', 'high'}]
                rows = []
                for group in model['options']:
                    for item in group.get('options', [group]):
                        rows.append({'id': item['value'], 'label': item['name'],
                            'efforts': efforts if item['value'] == model['currentValue'] else [],
                            'isDefault': item['value'] == default_value})
                await client.close()
                return rows
        except (TimeoutError, OSError, ValueError, KeyError, StopIteration) as error:
            raise ProjectError('DeepSeek Harness 模型查询失败，请检查 CLI 配置。', 503) from error
        finally:
            await terminate(process, group=True)


async def run(process, work, blocks, model, thinking, server, observe, session_id=None):
    client = Client(process, observe)
    try:
        async with asyncio.timeout(30):
            await client.initialize(work, [], session_id)
            if model:
                await client.request('session/set_config_option', {'sessionId': client.session, 'configId': 'model', 'value': model})
            if thinking != 'auto':
                await client.request('session/set_config_option', {'sessionId': client.session, 'configId': 'reasoning_effort', 'value': thinking})
        result = await client.request('session/prompt', {'sessionId': client.session,
            'prompt': [{'type': 'text', 'text': block} for block in blocks]})
        if result['stopReason'] != 'end_turn':
            raise ProjectError(f"DeepSeek Harness 执行未完成（{result['stopReason']}）。", 502)
        return client.session
    finally:
        async def cleanup():
            if client.session:
                await client.write({'jsonrpc': '2.0', 'method': 'session/cancel', 'params': {'sessionId': client.session}})
            await client.close()
        with suppress(TimeoutError, OSError, ProjectError, ValueError):
            await asyncio.wait_for(cleanup(), 5)
        await terminate(process, group=True)


def events(record, calls):
    if record.get('method') != 'session/update':
        return []
    update = record['params']['update']
    kind = update['sessionUpdate']
    if kind == 'agent_thought_chunk':
        return [{'type': 'thinking'}]
    if kind == 'plan':
        return [{'type': 'plan', 'entries': [
            {'content': entry['content'], 'status': entry['status']} for entry in update['entries']]}]
    if kind == 'agent_message_chunk' and update['content']['type'] == 'text':
        return [{'type': 'delta', 'text': update['content']['text']}]
    if kind not in {'tool_call', 'tool_call_update'}:
        return []
    identity = update['toolCallId']
    previous = calls.get(identity, {})
    name = update.get('title', previous.get('name', 'tool'))
    arguments = update.get('rawInput', previous.get('arguments', {}))
    detail = json.dumps(update.get('content', []), ensure_ascii=False)
    event = {'type': 'tool', 'id': 'deepseek:' + identity, 'name': name,
        'arguments': arguments, 'status': {'pending': 'running', 'in_progress': 'running',
            'completed': 'complete', 'failed': 'failed'}[update.get('status', 'in_progress')],
        'result': detail[:65536], 'resultTruncated': len(detail) > 65536}
    calls[identity] = event
    return [event]
