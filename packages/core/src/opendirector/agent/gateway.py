"""One turn's tool admission, replay and receipts, independent of transport."""
import asyncio
from contextlib import nullcontext
from copy import deepcopy
from dataclasses import dataclass
import json
from pathlib import Path
from typing import Annotated
from uuid import UUID

from pydantic import Field, JsonValue, TypeAdapter, ValidationError

from opendirector.agent.context import AgentEvent, RunContext
from opendirector.agent.tools import AgentTools, tools
from opendirector.domain.projects import ProjectError
from opendirector.domain.creation.commands import COMMAND_MODELS
from opendirector.domain.rule_facts import MAX_REFERENCES

REFERENCE_IDS = TypeAdapter(Annotated[list[UUID], Field(min_length=1, max_length=MAX_REFERENCES)])


@dataclass(frozen=True, kw_only=True)
class ToolResult:
    value: JsonValue
    error: str | None = None

    def event(self, name: str) -> AgentEvent:
        code = self.value.get('code') if isinstance(self.value, dict) else None
        if code is None and isinstance(self.value, dict):
            issues = self.value.get('issues')
            if issues is None and isinstance(self.value.get('receipt'), dict):
                issues = self.value['receipt'].get('issues')
            if isinstance(issues, list) and len(issues) == 1 and isinstance(issues[0], dict):
                code = issues[0].get('code')
        return {'type': 'tool', 'name': name,
                'status': 'failed' if self.error else 'complete',
                **({'error': self.error} if self.error else {}),
                **({'code': code} if self.error and isinstance(code, str) else {})}


# Reads are answered from immutable snapshots, so a wait cannot block unrelated
# work; writes still hold the turn's single execution slot.
READ_ONLY_QUERIES = frozenset({'job.status', 'job.get', 'object.get', 'canvas.status'})
# Queries that wait for a business state. Closing a turn cancels them; a read
# that has not been answered is worth nothing once the turn is over.
WAITING_QUERIES = frozenset({'job.status', 'canvas.status', 'run.execution.get'})


def _read_only(name, arguments) -> bool:
    """Whether this call may skip the execution lock.

    Arguments are validated inside the call itself, so an argument shape that
    is not a mapping or whose type is not a string is simply not read-only.
    Raising here would leave the tool result contract.
    """
    if name != 'query' or not isinstance(arguments, dict):
        return False
    kind = arguments.get('type')
    return isinstance(kind, str) and kind in READ_ONLY_QUERIES


class ToolGateway:
    def __init__(self, business: AgentTools, run: RunContext):
        self.business = business
        self.run = run
        self.model_selections = dict(run.model_selections)
        self.review_executions: set[str] = set()
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
        async with (nullcontext() if _read_only(name, arguments) else self.execution_lock):
            try:
                if self.closed:
                    raise ProjectError('本轮工具入口已关闭。', 409)
                if not call_id or len(call_id) > 512 or name not in self.names:
                    raise ProjectError('工具调用标识或名称无效。')
                arguments = TypeAdapter(dict[str, JsonValue]).validate_python(arguments, strict=True)
                schema = next(item['function']['parameters'] for item in tools() if item['function']['name'] == name)
                if 'properties' in schema and (set(arguments) - set(schema['properties']) or set(schema.get('required', [])) - set(arguments)):
                    raise ProjectError('工具参数缺失或包含未定义字段。')
                kind = arguments.get('type')
                if self.review_executions and name in {'execute_command', 'timeline_package_export', 'timeline_package_import'}:
                    executor = self.business.generation.segment_runs
                    for execution_id in sorted(self.review_executions):
                        review = await executor.status(self.run.project_id, execution_id)
                        if review['status'] != 'awaiting_selection':
                            continue
                        payload = arguments.get('payload')
                        if (kind == 'group.adoptRunCandidate' and isinstance(payload, dict)
                                and payload.get('executionId') == execution_id
                                and payload.get('groupId') == review['groupId']):
                            continue
                        raise ProjectError(
                            f"分组 {review['groupId']} 的片段 {review['reviewItemId']} 等待采用候选。"
                            "请检查候选。候选不合格时，报告问题并结束本轮。", 409,
                            code='agent_run_candidate_review_required')
                value = await self.business.execute(self.run.project_id, self.run.turn_id, self.run.session,
                    call_id, name, arguments, self.roots, self.run.config,
                    self.run.runtime if self.run.config is None else None,
                    self.execution_directory, **({'runtime_model': self.run.runtime_model, 'thinking': self.run.thinking}
                        if name == 'prompt_optimize' else {}))
                if isinstance(value, dict):
                    if kind == 'group.regenerateRunStep' and value.get('runExecutionId'):
                        self.review_executions.add(value['runExecutionId'])
                    if name == 'query' and value.get('status') == 'awaiting_selection' and value.get('executionId'):
                        self.review_executions.add(value['executionId'])
                if name == 'read_project':
                    value['modelSelections'] = dict(self.model_selections)
                    references = self.run.turn_references
                    if 'referenceIds' in arguments:
                        ids = REFERENCE_IDS.validate_python(arguments['referenceIds'])
                        known = {ref.id: ref for ref in (*self.run.earlier_references, *references)}
                        unknown = next((identity for identity in ids if identity not in known), None)
                        if unknown is not None:
                            raise ProjectError(f'聊天引用 {unknown} 不属于当前对话。', 409, code='reference_invalid')
                        references = tuple(known[identity] for identity in dict.fromkeys(ids))
                    if references:
                        value['turnReferences'] = [ref.observation() for ref in references]
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
                details = {'error': str(failure)}
                if isinstance(failure, ProjectError):
                    details['code'] = failure.code
                return ToolResult(value=details, error=str(failure))

    async def close(self) -> None:
        self.closed = True
        for identity, task in self.calls.values():
            name, arguments = json.loads(identity)
            if name == 'query' and isinstance(arguments, dict) and arguments.get('type') in WAITING_QUERIES:
                task.cancel()
        await asyncio.gather(*(task for _, task in self.calls.values()), return_exceptions=True)
