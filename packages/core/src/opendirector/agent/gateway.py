"""One turn's tool admission, replay and receipts, independent of transport."""
import asyncio
from copy import deepcopy
from dataclasses import dataclass
import json
from pathlib import Path

from pydantic import JsonValue, TypeAdapter, ValidationError

from opendirector.agent.context import AgentEvent, RunContext
from opendirector.agent.tools import AgentTools, tools
from opendirector.domain.projects import ProjectError
from opendirector.domain.creation.commands import COMMAND_MODELS


@dataclass(frozen=True, kw_only=True)
class ToolResult:
    value: JsonValue
    error: str | None = None

    def event(self, name: str) -> AgentEvent:
        return {'type': 'tool', 'name': name,
                'status': 'failed' if self.error else 'complete',
                **({'error': self.error} if self.error else {})}


class ToolGateway:
    def __init__(self, business: AgentTools, run: RunContext):
        self.business = business
        self.run = run
        self.model_selections = dict(run.model_selections)
        self.execution_directory: Path | None = None
        self.roots: list[Path] = []
        self.closed = False
        self.calls: dict[str, tuple[str, asyncio.Task[ToolResult]]] = {}
        self.lock = asyncio.Lock()
        self.execution_lock = asyncio.Lock()
        self.names = {item['function']['name'] for item in tools()}

    async def call(self, call_id: str, name: str, arguments: dict[str, JsonValue]) -> ToolResult:
        identity = json.dumps([name, arguments], ensure_ascii=False, sort_keys=True)
        async with self.lock:
            if self.closed:
                return ToolResult(value={'error': '本轮工具入口已关闭。'}, error='本轮工具入口已关闭。')
            previous = self.calls.get(call_id)
            if previous is not None:
                if previous[0] != identity:
                    return ToolResult(value={'error': '工具调用标识被用于不同输入。'}, error='工具调用标识被用于不同输入。')
                task = previous[1]
            else:
                task = asyncio.create_task(self.execute(call_id, name, deepcopy(arguments)))
                self.calls[call_id] = (identity, task)
        # Transport cancellation must not discard an accepted write or its receipt.
        return await asyncio.shield(task)

    async def execute(self, call_id: str, name: str, arguments: dict[str, JsonValue]) -> ToolResult:
        async with self.execution_lock:
            try:
                if self.closed:
                    raise ProjectError('本轮工具入口已关闭。', 409)
                if not call_id or len(call_id) > 512 or name not in self.names:
                    raise ProjectError('工具调用标识或名称无效。')
                arguments = TypeAdapter(dict[str, JsonValue]).validate_python(arguments, strict=True)
                schema = next(item['function']['parameters'] for item in tools() if item['function']['name'] == name)
                if 'properties' in schema and (set(arguments) - set(schema['properties']) or set(schema.get('required', [])) - set(arguments)):
                    raise ProjectError('工具参数缺失或包含未定义字段。')
                value = await self.business.execute(self.run.project_id, self.run.turn_id, self.run.session,
                    call_id, name, arguments, self.roots, self.run.config,
                    self.run.runtime if self.run.config is None else None,
                    self.execution_directory)
                if name == 'read_project':
                    value['modelSelections'] = dict(self.model_selections)
                error = None
                if isinstance(value, dict):
                    if value.get('status') == 'rejected':
                        error = '; '.join(issue['message'] for issue in value.get('issues', (value.get('receipt') or {}).get('issues', []))) or 'Timeline package import was rejected.'
                    elif value.get('error'):
                        error = str(value['error'])
                return ToolResult(value={**value, 'error': error} if error else value, error=error)
            except ValidationError as failure:
                messages = []
                for issue in failure.errors(include_input=False, include_url=False):
                    location = issue['loc']
                    if location and location[0] in COMMAND_MODELS:
                        location = location[1:]
                    path = '.'.join(str(part) for part in location)
                    messages.append(f"{path or 'command'}: {issue['msg']}")
                error = '; '.join(messages)
                return ToolResult(value={'error': error}, error=error)
            except (ProjectError, ValueError, KeyError, OSError, UnicodeError) as failure:
                value = {'error': str(failure)}
                if isinstance(failure, ProjectError):
                    value['code'] = failure.code
                return ToolResult(value=value, error=str(failure))

    async def close(self) -> None:
        self.closed = True
        for identity, task in self.calls.values():
            name, arguments = json.loads(identity)
            if name == 'query' and arguments.get('type') == 'canvas.status':
                task.cancel()
        await asyncio.gather(*(task for _, task in self.calls.values()), return_exceptions=True)
