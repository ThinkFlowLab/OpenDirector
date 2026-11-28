"""Project-scoped assistant persistence and native runtime streaming."""
import asyncio
from contextlib import aclosing, suppress
from dataclasses import dataclass, replace
import json
import logging
from pathlib import Path
import threading
import time
from datetime import datetime, timezone
from typing import Annotated, Literal
from uuid import UUID, uuid4, uuid5

from anyio import CancelScope
from fastapi import APIRouter, Header
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, JsonValue

from opendirector.agent.catalog import model_choices
from opendirector.agent.context import RunContext, RuntimeId
from opendirector.agent.decisions import (
    ASK_SUPPORTED_RUNTIMES,
    DecisionAnswerSubmit,
    DecisionStore,
    InteractionMode,
    PlanAdjustInput,
    PlanConfirmInput,
    build_continuation_prompt_block,
    build_execution_prompt_block,
)
from opendirector.agent.citations import referenced_sources, with_trace_sources
from opendirector.agent.runtime import AgentRuntimes, runtime_available, configured_runtimes, runtime_spec, runtime_catalog, runtime_status
from opendirector.agent.skills import skills
from opendirector.agent import timing as agent_timing
from opendirector.application.model_availability import requests_for
from opendirector.domain.creation.base import agent_command_id
from opendirector.domain.projects import ProjectError
from opendirector.domain.rule_facts import MAX_REFERENCES, PROMPT_MAX_LENGTH
from opendirector.infrastructure.creation_projects import durable_json
from opendirector.infrastructure.local_projects import child, read_json
from opendirector.integrations.chat_completions import CHAT_MAX_TOKENS
from opendirector_api.localization import localized_error_for_language

logger = logging.getLogger(__name__)


Runtime = RuntimeId

def _assistant_request(config):
    """Admission uses the same output ceiling as the configured model gateway."""
    return replace(requests_for(config, inputs={'text'})[0],
                   parameters=(('max_tokens', CHAT_MAX_TOKENS),))


class Draft(BaseModel):
    conversationId: UUID | None = None
    model_config = ConfigDict(extra='forbid')
    draft: str = Field(default='', max_length=PROMPT_MAX_LENGTH)
    draftContent: list[dict[str, JsonValue]] | None = None
    assets: list[dict[str, JsonValue]] = Field(default_factory=list, max_length=MAX_REFERENCES)
    runtime: Runtime = 'default'
    runtimeModel: str | None = Field(default=None, max_length=200)
    harnessModels: dict[Literal["opencode", "codex", "claude", "jiuwenswarm", "deepseek"], Annotated[str, Field(max_length=200)] | None] = Field(default_factory=dict)
    thinking: Literal['auto', 'low', 'medium', 'high'] = 'auto'
    builtinModelThinking: dict[str, Literal['auto', 'low', 'medium', 'high']] = Field(default_factory=dict)
    modelSelections: dict[str, str | None] = Field(default_factory=dict)
    skills: list[str] = Field(default_factory=list, max_length=1)


class Turn(BaseModel):
    conversationId: UUID | None = None
    model_config = ConfigDict(extra='forbid')
    id: UUID
    modelId: UUID | None = None
    text: str = Field(min_length=1, max_length=PROMPT_MAX_LENGTH)
    content: list[dict[str, JsonValue]] | None = None
    assets: list[UUID] = Field(default_factory=list, max_length=MAX_REFERENCES)
    runtime: Runtime = 'default'
    runtimeModel: str | None = Field(default=None, max_length=200)
    thinking: Literal['auto', 'low', 'medium', 'high'] = 'auto'
    modelSelections: dict[str, str | None] = Field(default_factory=dict)
    skills: list[str] = Field(default_factory=list, max_length=1)
    mode: InteractionMode = 'auto'
    planOnly: bool = False


def draft_content_is_empty(content):
    """Blank text-only structured drafts are empty; reference or skill parts are not.

    Non-string text values are treated as present content so New does not raise,
    and an accepted non-text or non-string part is not silently reused away.
    """
    if not content:
        return True
    for part in content:
        if not isinstance(part, dict):
            return False
        kind = part.get('type')
        if kind == 'text':
            text_value = part.get('text')
            if not isinstance(text_value, str):
                return False
            if text_value.strip():
                return False
        else:
            return False
    return True


def conversation_is_empty(value):
    """A session with no messages or unsent content can be reused by New."""
    return (not value.get('messages')
            and not (value.get('draft') or '').strip()
            and not value.get('assets')
            and not value.get('skills')
            and draft_content_is_empty(value.get('draftContent')))


def public_conversation(value):
    # Keys starting with an underscore are bookkeeping the client never sends
    # back; Draft forbids extra members, so they must not reach the payload.
    return {key: item for key, item in value.items()
            if key not in {'archivedConversations', 'reusedCreateIds', 'queueSeq'}
            and not key.startswith('_')}


def reused_ids(value):
    return [str(item) for item in (value.get('reusedCreateIds') or [])]


def _monotonic() -> float:
    # Own indirection so turn timing never shares a patch point with other users of `time` in this module.
    return time.monotonic()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _duration_ms(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _timestamp(value):
    return value if isinstance(value, str) and value else None


TIMED_STATUSES = {'complete', 'stopped', 'interrupted'}


class Conversations:
    def __init__(self, projects):
        self.projects = projects
        # Turn timing is recorded here, not in produce(). The window starts right after the begin write
        # succeeded, inside the begin transaction (the begin write is excluded, so persistence latency
        # never counts; `startedAt` is stamped earlier, when the placeholder is built) and ends at entry of the finish
        # update (the finish write is excluded). Job completion never extends it and browser time is
        # never used. The monotonic start lives in this process only: after a restart the duration is
        # unknown and stays absent rather than invented.
        self._started: dict[str, float] = {}
        self._started_lock = threading.Lock()

    def path(self, project_id: UUID, session: str | None = None) -> Path:
        with self.projects.local.transaction() as db:
            self.projects._recover()
            directory, _ = self.projects._find(db, project_id)
            if session:
                self.projects._lease(db, project_id, directory, session, browser_only=True)
            return directory

    def update(self, project_id: UUID, session: str | None = None, *, draft: Draft | None = None,
               begin: dict | None = None, begin_segment: dict | None = None,
               finish: dict | None = None, conversation_id: UUID | None = None,
               before_begin=None, agent_session: str | None = None) -> dict:
        finish_mono, finish_at = (_monotonic(), _utc_now()) if finish is not None else (None, None)
        with self.projects.local.transaction() as db:
            self.projects._recover()
            directory, _ = self.projects._find(db, project_id)
            if session:
                self.projects._lease(db, project_id, directory, session, browser_only=True)
            folder = child(directory, 'agent-runs')
            folder.mkdir(exist_ok=True)
            file = child(folder, 'conversation.json')
            value = read_json(file) if file.exists() else {'messages': [], **Draft().model_dump()}
            value['conversationId'] = value.get('conversationId') or str(uuid5(project_id, 'assistant'))
            supplied = draft.conversationId if draft is not None else conversation_id
            if (draft is not None or begin is not None or begin_segment is not None or finish is not None) and str(supplied) != value['conversationId'] and (supplied is not None or value.get('archivedConversations')):
                raise ProjectError('当前对话已切换，请重新加载后重试；原对话未覆盖。', 409)
            changed = False
            started = None
            started_reply_id = None
            if draft is not None:
                value.update(draft.model_dump(mode="json", exclude={"conversationId"}))
                changed = True
            if begin is not None:
                if any(message['id'] == begin['id'] for message in value['messages']):
                    raise ProjectError('这条消息已接受，请读取对话，不要重复发送。', 409)
                if before_begin is not None:
                    before_begin()
                if agent_session is not None:
                    self.projects.local.start_agent_session(db, project_id, directory, agent_session)
                value['messages'].append(begin)
                started_reply_id = str(uuid5(UUID(begin['id']), 'assistant'))
                value['messages'].append({'id': started_reply_id,
                    'role': 'assistant', 'text': '', 'status': 'streaming', 'turnId': begin['id'],
                    'startedAt': _utc_now(),
                    **{key: begin[key] for key in ('model', 'modelIsCliDefault', 'runtime') if key in begin}})
                value.update(draft='', draftContent=None, assets=[], skills=[])
                changed = True
            if begin_segment is not None:
                if before_begin is not None:
                    before_begin()
                if agent_session is not None:
                    self.projects.local.start_agent_session(db, project_id, directory, agent_session)
                started_reply_id = str(uuid5(UUID(begin_segment['turnId']), 'assistant'))
                segment_msg = {
                    'id': started_reply_id,
                    'role': 'assistant',
                    'text': '',
                    'status': 'streaming',
                    'startedAt': _utc_now(),
                    'turnId': begin_segment['turnId'],
                    'taskId': begin_segment['taskId'],
                    'segmentKind': begin_segment['segmentKind'],
                    **({'parentRequestId': begin_segment['parentRequestId']} if begin_segment.get('parentRequestId') else {}),
                    **{key: begin_segment[key] for key in ('model', 'modelIsCliDefault', 'runtime') if key in begin_segment},
                }
                if any(message['id'] == started_reply_id for message in value['messages']):
                    value['messages'] = [segment_msg if message['id'] == started_reply_id else message for message in value['messages']]
                else:
                    value['messages'].append(segment_msg)
                changed = True
            if finish is not None:
                with self._started_lock:
                    started = self._started.pop(finish['id'], None)
                def stamped(message):
                    result = {**message, **finish}
                    if message.get('startedAt'):
                        result['startedAt'] = message['startedAt']
                    if finish.get('status') in TIMED_STATUSES and started is not None:
                        result.setdefault('finishedAt', finish_at)
                        result.setdefault('durationMs', max(0, round((finish_mono - started) * 1000)))
                    return result
                value['messages'] = [stamped(message) if message['id'] == finish['id'] else message
                                     for message in value['messages']]
                changed = True
            if changed:
                try:
                    durable_json(file, value)
                except BaseException:
                    if started is not None:
                        # The finish write failed: the message is still streaming on disk, so keep its start.
                        with self._started_lock:
                            self._started.setdefault(finish['id'], started)
                    raise
                if started_reply_id is not None:
                    # The turn counts as accepted only now. The clock starts after the begin write succeeded,
                    # still inside the transaction, so no finish for this reply can run before it is set.
                    with self._started_lock:
                        self._started[started_reply_id] = _monotonic()
            result = public_conversation(value)
        return with_trace_sources(result, directory)

    def queue(self, project_id: UUID, session: str, message: dict, conversation_id: UUID | None = None) -> dict:
        """Store a supplementary message that runs after the active turn.

        The record keeps the shape of an accepted turn, so the run that picks it
        up later needs nothing but what the user sent and the settings frozen
        with it.
        """
        with self.projects.local.transaction() as db:
            self.projects._recover()
            directory, _, _ = self.projects._load(db, project_id)
            self.projects._lease(db, project_id, directory, session)
            folder = child(directory, 'agent-runs')
            folder.mkdir(exist_ok=True)
            file = child(folder, 'conversation.json')
            value = read_json(file) if file.exists() else {'messages': [], **Draft().model_dump()}
            value['conversationId'] = value.get('conversationId') or str(uuid5(project_id, 'assistant'))
            if conversation_id is not None and str(conversation_id) != value['conversationId']:
                raise ProjectError('当前对话已切换，请重新加载后重试；原对话未覆盖。', 409)
            if any(item['id'] == message['id'] for item in value['messages']):
                raise ProjectError('这条消息已接受，请读取对话，不要重复发送。', 409)
            if 'queueSeq' in value:
                value['_queueSeq'] = value.pop('queueSeq')
            value['_queueSeq'] = value.get('_queueSeq', 0) + 1
            queued = {**message, 'status': 'queued', 'queueSeq': value['_queueSeq']}
            value['messages'].append(queued)
            durable_json(file, value)
        return queued

    def dispatch(self, project_id: UUID, session: str | None = None,
                 agent_session: str | None = None) -> dict | None:
        """Start the oldest queued message as this turn's user message.

        Dispatching takes the same lock as starting a run, so the project slot
        never opens between one turn ending and the next beginning; a second run
        cannot slip in ahead of the message that is already waiting.
        """
        with self.projects.local.transaction() as db:
            self.projects._recover()
            directory, _, _ = self.projects._load(db, project_id)
            folder = child(directory, 'agent-runs')
            file = child(folder, 'conversation.json')
            if not file.exists():
                return None
            value = read_json(file)
            value['conversationId'] = value.get('conversationId') or str(uuid5(project_id, 'assistant'))
            pending = next((item for item in value['messages'] if item.get('status') == 'queued'), None)
            if pending is None:
                return None
            if session:
                self.projects._lease(db, project_id, directory, session)
            if agent_session is not None:
                self.projects.local.start_agent_session(db, project_id, directory, agent_session)
            index = value['messages'].index(pending)
            pending['status'] = 'complete'
            reply_id = str(uuid5(UUID(pending['id']), 'assistant'))
            value['messages'].insert(index + 1, {
                'id': reply_id,
                'role': 'assistant', 'text': '', 'status': 'streaming', 'turnId': pending['id'],
                'startedAt': _utc_now(),
                **{key: pending[key] for key in ('model', 'modelIsCliDefault', 'runtime') if key in pending}})
            value.update(draft='', draftContent=None, assets=[], skills=[])
            durable_json(file, value)
            # Same boundary as update(begin): the clock starts once the write succeeded, inside the transaction.
            with self._started_lock:
                self._started[reply_id] = _monotonic()
            result = public_conversation(value)
        return {'message': pending, 'conversation': with_trace_sources(result, directory)}

    def cancel_queued(self, project_id: UUID, session: str | None = None) -> list[dict]:
        """Mark messages that will not run as cancelled, keeping them readable."""
        with self.projects.local.transaction() as db:
            self.projects._recover()
            directory, _, _ = self.projects._load(db, project_id)
            if session:
                self.projects._lease(db, project_id, directory, session)
            file = child(child(directory, 'agent-runs'), 'conversation.json')
            if not file.exists():
                return []
            value = read_json(file)
            cancelled = [item for item in value['messages'] if item.get('status') == 'queued']
            if not cancelled:
                return []
            for item in cancelled:
                item['status'] = 'cancelled'
            durable_json(file, value)
        return cancelled

    def list(self, project_id: UUID) -> dict:
        directory = self.path(project_id)
        file = child(child(directory, 'agent-runs'), 'conversation.json')
        with self.projects.local.transaction():
            current = read_json(file) if file.exists() else {'messages': [], **Draft().model_dump()}
            current['conversationId'] = current.get('conversationId') or str(uuid5(project_id, 'assistant'))
            return {'activeId': current['conversationId'], 'items': [
                {'id': item['conversationId'],
                 'title': next((message['text'].strip().split('\n')[0][:48] or None
                                for message in item['messages'] if message['role'] == 'user'),
                               (item.get('draft') or '').strip().split('\n')[0][:48] or None),
                 'messageCount': len(item['messages']),
                 'hasDraft': bool((item.get('draft') or '').strip() or item.get('assets') or item.get('skills'))}
                for item in [current, *current.get('archivedConversations', [])]]}

    def trace(self, project_id: UUID, conversation_id: UUID, running: UUID | None = None) -> dict:
        """Executed turns of one conversation, read-only: no lease, no activation, no log bodies.

        A user turn requires the assistant record identified by ``uuid5(user id, 'assistant')``.
        Continuations and confirmed executions have their own assistant record and turn ID.
        """
        directory = self.path(project_id)
        file = child(child(directory, 'agent-runs'), 'conversation.json')
        with self.projects.local.transaction():
            current = read_json(file) if file.is_file() else {'messages': []}
        current['conversationId'] = current.get('conversationId') or str(uuid5(project_id, 'assistant'))
        requested = str(conversation_id)
        found = next((item for item in [current, *current.get('archivedConversations', [])]
                      if item.get('conversationId') == requested or requested in reused_ids(item)), None)
        if found is None:
            raise ProjectError('对话不存在。', 404)
        replies = {message.get('id'): message for message in found.get('messages', [])
                   if message.get('role') == 'assistant'}
        turns = []
        for message in found.get('messages', []):
            if message.get('role') == 'user':
                try:
                    reply = replies.get(str(uuid5(UUID(message['id']), 'assistant')))
                except (KeyError, ValueError, TypeError):
                    reply = None
                if reply is None:
                    continue
                turn_id_str = message['id']
                summary_text = (message.get('text') or '')[:200]
            elif (
                message.get('role') == 'assistant'
                and message.get('segmentKind') in ('continuation', 'execution')
                and message.get('turnId')
            ):
                reply = message
                turn_id_str = str(message['turnId'])
                summary_text = (message.get('text') or message.get('segmentKind') or '')[:200]
            else:
                continue
            status = reply.get('status') or 'complete'
            if status == 'streaming' and (found is not current or running != UUID(turn_id_str)):
                status = 'interrupted'
            turns.append({'id': turn_id_str, 'number': len(turns) + 1,
                          'text': summary_text,
                          'runtime': reply.get('runtime') or message.get('runtime') or 'default',
                          'model': reply.get('model') or message.get('model'),
                          'status': status,
                          'startedAt': _timestamp(reply.get('startedAt')),
                          'finishedAt': _timestamp(reply.get('finishedAt')),
                          'durationMs': _duration_ms(reply.get('durationMs'))})
        return {'conversationId': found['conversationId'], 'active': found is current, 'turns': turns}

    def conversation_of(self, project_id: UUID, turn_id: UUID) -> str:
        """Id of the conversation that persisted this executed turn, current or archived."""
        directory = self.path(project_id)
        file = child(child(directory, 'agent-runs'), 'conversation.json')
        with self.projects.local.transaction():
            current = read_json(file) if file.is_file() else {}
        current['conversationId'] = current.get('conversationId') or str(uuid5(project_id, 'assistant'))
        reply = str(uuid5(turn_id, 'assistant'))
        for item in [current, *current.get('archivedConversations', [])]:
            messages = item.get('messages', [])
            if (any(m.get('role') == 'user' and m.get('id') == str(turn_id) for m in messages)
                    and any(m.get('role') == 'assistant' and m.get('id') == reply for m in messages)):
                return item['conversationId']
            if any(m.get('role') == 'assistant' and m.get('segmentKind') in ('continuation', 'execution')
                   and m.get('turnId') == str(turn_id) for m in messages):
                return item['conversationId']
        raise ProjectError('该轮用户消息不存在。', 404)

    def activate(self, project_id: UUID, conversation_id: UUID, session: str, *, create=False) -> dict:
        with self.projects.local.transaction() as db:
            self.projects._recover()
            directory, _ = self.projects._find(db, project_id)
            self.projects._lease(db, project_id, directory, session, browser_only=True)
            folder = child(directory, 'agent-runs')
            folder.mkdir(exist_ok=True)
            file = child(folder, 'conversation.json')
            current = read_json(file) if file.exists() else {'messages': [], **Draft().model_dump(mode='json')}
            current['conversationId'] = current.get('conversationId') or str(uuid5(project_id, 'assistant'))
            archives = current.pop('archivedConversations', [])
            requested = str(conversation_id)
            if current['conversationId'] == requested or requested in reused_ids(current):
                return with_trace_sources(public_conversation(current), directory)
            target = next((item for item in archives
                           if item['conversationId'] == requested or requested in reused_ids(item)), None)
            if target is None:
                if not create:
                    raise ProjectError('对话不存在。', 404)
                if conversation_is_empty(current):
                    aliases = reused_ids(current)
                    if requested not in aliases:
                        aliases.append(requested)
                    current['reusedCreateIds'] = aliases
                    durable_json(file, {**current, 'archivedConversations': archives})
                    return with_trace_sources(public_conversation(current), directory)
                if len(archives) >= 99:
                    raise ProjectError('项目对话已达 100 个，暂不能继续新建。', 409)
                target = {'messages': [], **Draft().model_dump(mode='json'),
                          **{key: current[key] for key in ('runtime', 'runtimeModel', 'harnessModels', 'thinking', 'builtinModelThinking', 'modelSelections') if key in current},
                          'conversationId': requested}
            archives = [item for item in archives if item['conversationId'] != target['conversationId']]
            durable_json(file, {**target, 'archivedConversations': [current, *archives]})
        return with_trace_sources(public_conversation(target), directory)


class ConversationCreate(BaseModel):
    id: UUID


class RunEvents:
    """Events of one conversation chain, replayable from any cursor.

    The run belongs to the project, not to the HTTP request that started it:
    leaving the project closes the stream, and returning attaches a new one that
    replays from the beginning, or from the last frame a viewer already has. A
    chain keeps its events across turns, so one stream can carry the turn that is
    running and the supplementary messages queued behind it.
    """

    def __init__(self):
        self.items: list[dict] = []
        self.changed = asyncio.Event()
        self.closed = False

    def put(self, event: dict) -> None:
        self.items.append({**event, 'seq': len(self.items)})
        if event['type'] == 'end' and not event.get('nextTurnId'):
            self.closed = True
        self.changed.set()
        self.changed = asyncio.Event()

    async def follow(self, after: int = 0):
        index = max(0, after)
        while True:
            while index < len(self.items):
                event = self.items[index]
                index += 1
                yield 'data: ' + json.dumps(event, ensure_ascii=False) + '\n\n'
                if event['type'] == 'end' and not event.get('nextTurnId'):
                    return
            if self.closed:
                # The chain finished while this viewer was still catching up: its
                # cursor is past the last frame, so serve what is left and stop
                # rather than waiting for events that will never come.
                return
            await self.changed.wait()


@dataclass
class Chain:
    """One running turn and the messages queued behind it.

    The chain owns the project slot rather than the turn: the moment between one
    turn ending and the next starting must stay closed, otherwise a second run
    could be admitted alongside the follow-up that is about to start. A chain
    lives until its queue is empty, so a supplementary message never races the
    turn it was sent during.
    """

    id: UUID
    project_id: UUID
    events: RunEvents
    session: str
    turn: UUID
    conversation_id: UUID | None = None
    task: asyncio.Task | None = None
    stopped: bool = False
    last: dict | None = None


def _build_context_messages(
    directory: Path,
    messages: list[dict],
    assets: dict,
    preferences: dict,
    decisions_by_id: dict[str, dict],
    tasks_by_id: dict[str, dict],
    *,
    current_segment: dict | None = None,
) -> list[dict]:
    """Reconstruct alternating user/assistant context for initial, continuation and execution segments."""
    context: list[dict] = []
    current_request_id = (
        current_segment['decision']['requestId']
        if current_segment is not None and current_segment['kind'] == 'continuation' else None
    )
    decision_turn_id = (
        current_segment['decision'].get('turnId')
        if current_segment is not None and current_segment['kind'] == 'continuation' else None
    )
    original_request = None
    refinement_request = None
    for message in messages:
        if message['role'] == 'user':
            content = message['text'] or '(empty reply)'
            references = []
            for attachment in message.get('assets', []):
                asset = assets.get(attachment['id'])
                if asset is not None:
                    references.append({
                        'id': str(asset.id),
                        'name': attachment['name'],
                        'kind': asset.kind,
                        'path': str((directory / asset.path).resolve()),
                        'metadata': asset.metadata.model_dump(mode='json', exclude_none=True),
                    })
            if references:
                content += '\nReferenced project assets: ' + json.dumps(references, ensure_ascii=False)
                content += '\nThese are asset references, not visual observations. Inspect media with available tools before describing its contents.'
            context.append({'role': 'user', 'content': content})
            if current_segment is not None and message['id'] == current_segment['task']['taskId']:
                original_request = content
            if (
                current_segment is not None
                and decision_turn_id
                and decision_turn_id != current_segment['task']['taskId']
                and message['id'] == decision_turn_id
            ):
                refinement_request = content
        elif message['role'] == 'assistant':
            content = message.get('text') or '(empty reply)'
            req_id = message.get('decisionRequestId')
            decision = decisions_by_id.get(req_id) if req_id else None
            if decision is not None:
                content += '\nAsked user decision (' + decision['requestId'] + '): ' + json.dumps(
                    decision.get('questions', []), ensure_ascii=False
                )
            context.append({'role': 'assistant', 'content': content})
            if decision is not None and decision.get('answers') is not None and req_id != current_request_id:
                task = tasks_by_id.get(decision['taskId'], {'taskId': decision['taskId']})
                context.append({'role': 'user', 'content': build_continuation_prompt_block(task, decision)})

    if current_segment is not None:
        task = current_segment['task']
        block = (
            build_continuation_prompt_block(task, current_segment['decision'])
            if current_segment['kind'] == 'continuation' else build_execution_prompt_block(task)
        )
        if original_request:
            block += '\n\nOriginal request for this task:\n' + original_request
        if refinement_request:
            block += '\n\nLatest user refinement request for this decision:\n' + refinement_request
        context.append({'role': 'user', 'content': block})

    if preferences and context and context[-1]['role'] == 'user':
        context[-1]['content'] += '\nUser model preferences for this turn: ' + json.dumps(preferences, ensure_ascii=False)
        context[-1]['content'] += (
            '\nUse these models for new generation unless the user explicitly requests another. '
            'If unavailable or unsuitable, explain and ask before substituting. '
            'Keep existing nodes on their configured models unless the user requests a change.'
        )
    return context


def _enrich_conversation(
    project_id: UUID,
    value: dict,
    decisions: DecisionStore,
    active_turn_id: UUID | None = None,
    *,
    state: dict | None = None,
) -> dict:
    cid = value.get('conversationId')
    if not cid:
        return value
    if state is None:
        state = decisions.public_state(project_id, cid, active_turn_id)
    live_reply = str(uuid5(active_turn_id, 'assistant')) if active_turn_id is not None else None
    value = {
        **value,
        'messages': [
            {**message, 'status': 'interrupted'}
            if message.get('status') == 'streaming' and message.get('id') != live_reply else message
            for message in value['messages']
        ],
    }
    interactive_tasks = [
        task for task in state['tasks']
        if task.get('mode') == 'ask'
        or task.get('planOnly')
        or int(task.get('planRevision', 0)) > 0
        or task.get('activeDecisionId')
        or len(task.get('segmentTurnIds', [])) > 1
        or task.get('stage') not in {'running', 'completed'}
    ]
    if not state['decisions'] and not interactive_tasks:
        return value
    return {
        **value,
        'decisions': state['decisions'],
        'tasks': interactive_tasks,
    }


def agent_routes(projects, generation, configs, provider=None, *, active=None) -> APIRouter:
    router = APIRouter(prefix='/api/creation/projects/{project_id}/assistant')
    conversations = Conversations(projects)
    runtimes = AgentRuntimes(projects, generation, configs, provider)
    decisions = runtimes.business.decisions

    @router.get('/conversations/{conversation_id}/trace')
    def conversation_trace(project_id: UUID, conversation_id: UUID):
        running = active.get(project_id)
        live = running.turn if running is not None and running.task is not None and not running.task.done() else None
        return conversations.trace(project_id, conversation_id, live)

    @router.get('/traces/{turn_id}/conversation')
    def trace_conversation(project_id: UUID, turn_id: UUID):
        return {'conversationId': conversations.conversation_of(project_id, turn_id)}

    @router.get('/traces/{turn_id}/input')
    def trace_input(project_id: UUID, turn_id: UUID):
        file = child(child(conversations.path(project_id), 'agent-runs'), 'conversation.json')
        with projects.local.transaction():
            conversation = read_json(file) if file.is_file() else {}
        for item in [conversation, *conversation.get('archivedConversations', [])]:
            for message in item.get('messages', []):
                if message['role'] == 'user' and message['id'] == str(turn_id):
                    return {'text': message['text']}
                if message['role'] == 'assistant' and message.get('turnId') == str(turn_id):
                    return {'text': message.get('text') or message.get('segmentKind') or ''}
        raise ProjectError('该轮用户消息不存在。', 404)

    @router.get('/traces/{turn_id}/{source}')
    def trace(project_id: UUID, turn_id: UUID,
              source: Literal['opencode', 'codex', 'claude', 'jiuwenswarm', 'deepseek', 'model']):
        folder = child(conversations.path(project_id), 'agent-runs')
        file = child(folder, f'{turn_id}.{source}.jsonl')
        if not file.is_file():
            raise ProjectError('轨迹文件不存在。', 404)
        return FileResponse(file, media_type='text/plain', headers={'Cache-Control': 'no-store'})

    @router.get('/turns/{turn_id}/jobs')
    def turn_jobs(project_id: UUID, turn_id: UUID):
        # Read-only like the trace routes: no session lease, and the Agent trace is not consulted.
        # It reads the committed snapshot and never starts, resumes or replays a command.
        jobs = sorted((job for job in projects.snapshot(project_id).jobs if job.agentRunId == turn_id),
                      key=lambda job: (job.createdAt, str(job.id)))
        return [dict(jobId=job.id, callId=job.agentCallId, commandId=agent_command_id(turn_id, job.agentCallId),
                     status=job.status, phase=job.phase, recovery=job.recovery, resumeAllowed=job.resumeAllowed,
                     cancelRequested=job.cancelRequested, remoteCancellation=job.remoteCancellation,
                     errorDetails=job.errorDetails, asset=job.asset, adopted=job.adopted)
                for job in jobs]

    if active is None:
        active = {}
    launching: dict[UUID, UUID] = {}
    admission: dict[UUID, asyncio.Lock] = {}

    def _live_turn_id(project_id: UUID) -> UUID | None:
        running = active.get(project_id)
        if running is not None and running.task is not None and not running.task.done():
            return running.turn
        return launching.get(project_id)

    async def _read_enriched_conversation(project_id: UUID, *, include_launching=True) -> dict:
        value = await asyncio.to_thread(conversations.update, project_id)
        live = _live_turn_id(project_id) if include_launching else None
        value = await asyncio.to_thread(_enrich_conversation, project_id, value, decisions, live)
        # A streaming message without a chain was interrupted (for example by a
        # restart); with one, the client can attach to the turn it is running.
        if live is not None:
            value = {**value, 'activeTurnId': str(live)}
        return value

    @router.get('')
    async def conversation(project_id: UUID):
        async with admission.setdefault(project_id, asyncio.Lock()):
            return await _read_enriched_conversation(project_id)

    @router.get('/conversations')
    async def list_conversations(project_id: UUID):
        return await asyncio.to_thread(conversations.list, project_id)

    async def change_conversation(project_id: UUID, conversation_id: UUID, session: UUID, *, create=False):
        async with admission.setdefault(project_id, asyncio.Lock()):
            if project_id in active:
                raise ProjectError('请先停止或等待当前回复结束，再切换对话。', 409)
            result = await asyncio.to_thread(conversations.activate, project_id, conversation_id, str(session), create=create)
            return await asyncio.to_thread(_enrich_conversation, project_id, result, decisions, None)

    @router.post('/conversations')
    async def new_conversation(project_id: UUID, value: ConversationCreate, x_opendirector_session: UUID = Header()):
        return await change_conversation(project_id, value.id, x_opendirector_session, create=True)

    @router.post('/conversations/{conversation_id}/activate')
    async def activate_conversation(project_id: UUID, conversation_id: UUID, x_opendirector_session: UUID = Header()):
        return await change_conversation(project_id, conversation_id, x_opendirector_session)

    @router.put('/draft')
    async def draft(project_id: UUID, value: Draft, x_opendirector_session: UUID = Header()):
        result = await asyncio.to_thread(conversations.update, project_id, str(x_opendirector_session), draft=value)
        return await asyncio.to_thread(_enrich_conversation, project_id, result, decisions, _live_turn_id(project_id))

    @router.post('/decisions/{request_id}/answers')
    async def submit_decision_answer(
        project_id: UUID,
        request_id: UUID,
        value: DecisionAnswerSubmit,
        x_opendirector_session: UUID = Header(),
    ):
        session = str(x_opendirector_session)
        result = await asyncio.to_thread(decisions.submit_answer, project_id, session, request_id, value)
        return {**result, 'busy': _live_turn_id(project_id) is not None}

    @router.post('/tasks/{task_id}/adjust-plan')
    async def adjust_task_plan(
        project_id: UUID,
        task_id: UUID,
        value: PlanAdjustInput,
        x_opendirector_session: UUID = Header(),
    ):
        session = str(x_opendirector_session)
        async with runtimes.business.write_lock(project_id):
            task = await asyncio.to_thread(decisions.adjust_plan, project_id, session, task_id, value)
        return {'task': task}

    @router.get('/runtimes')
    async def available_runtimes(project_id: UUID, probe: bool = True):
        await asyncio.to_thread(conversations.path, project_id)
        if probe:
            return await configured_runtimes()
        return [{**item, 'status': await runtime_status(item['id'], probe=False)}
                for item in runtime_catalog()]

    @router.get('/runtimes/{runtime}/status')
    async def runtime_detail(project_id: UUID, runtime: Runtime):
        await asyncio.to_thread(conversations.path, project_id)
        item = next(item for item in runtime_catalog() if item['id'] == runtime)
        return {**item, 'status': await runtime_status(runtime)}

    @router.get('/runtimes/{runtime}/models')
    async def runtime_models(project_id: UUID, runtime: Literal['opencode', 'codex', 'claude', 'jiuwenswarm', 'deepseek'], selected: str | None = None):
        await asyncio.to_thread(conversations.path, project_id)
        if runtime == 'deepseek':
            from opendirector.agent.deepseek import model_choices as deepseek_models
            return await deepseek_models(selected)
        return await model_choices(runtime)

    @router.get('/skills')
    async def catalog(project_id: UUID):
        directory = await asyncio.to_thread(conversations.path, project_id)
        found = await skills(projects.local.repository, directory)
        return [{key: item[key] for key in ('name', 'description', 'source')} for item in found]

    def preferences_for(model_selections: dict) -> dict:
        names = {row['id']: row['modelId'] for row in configs.list()}
        return {kind: {'modelConfigId': model_id, 'modelName': names.get(model_id)}
                for kind, model_id in model_selections.items() if model_id}

    def revalidate(plan: dict):
        """Re-read the model config just before the message joins the conversation.

        prepare() validates while the user is still typing; the settings can move
        before the message is accepted, so the same gate runs again inside the
        conversation transaction.
        """
        config, prepared = plan.get('config'), plan.get('prepared')
        if config is None or prepared is None:
            return None
        def check() -> None:
            current = configs.resolve(str(plan.get('config_id')), 'agent')
            generation.availability.require(current, _assistant_request(current), prepared)
        return check

    async def _prepare_runtime_and_assets(
        project_id: UUID,
        session: str,
        accept_language: str | None,
        *,
        runtime_name: Runtime,
        runtime_model: str | None,
        model_id: UUID | str | None,
        thinking: Literal['auto', 'low', 'medium', 'high'],
        model_selections: dict[str, str | None],
        selected_skills: list[str],
        mode: InteractionMode,
        referenced_asset_ids: list[str],
    ) -> dict:
        directory = await asyncio.to_thread(conversations.path, project_id, session)
        if mode == 'ask' and runtime_name not in ASK_SUPPORTED_RUNTIMES:
            raise ProjectError('当前 Agent 运行时暂不支持询问模式。', 409, code='ask_mode_runtime_unsupported')
        if not runtime_available(runtime_name):
            raise ProjectError(f'{runtime_name} 未安装，请安装 CLI 并登录。', 503)
        spec = runtime_spec(runtime_name)
        if not spec.supportsSkills and selected_skills:
            raise ProjectError(f'{spec.label} 不支持技能，请移除技能后发送。', 409)
        if runtime_name == 'jiuwenswarm' and thinking != 'auto':
            raise ProjectError('JiuwenSwarm 当前使用原生默认推理强度。', 409)
        resolved_model_id = str(model_id) if model_id is not None else model_selections.get('agent')
        config = await asyncio.to_thread(configs.resolve, str(resolved_model_id), 'agent') if spec.modelSource == 'settings' else None
        prepared = None
        if config is not None:
            prepared = await asyncio.to_thread(generation.availability.prepare, config)
            current = await asyncio.to_thread(configs.resolve, str(resolved_model_id), 'agent')
            generation.availability.require(current, _assistant_request(current), prepared)
            config = current
        available = await skills(projects.local.repository, directory) if spec.supportsSkills else []
        if set(selected_skills) - {item['name'] for item in available}:
            raise ProjectError('技能已失效，请重新选择。', 409)
        snapshot = await asyncio.to_thread(projects.snapshot, project_id)
        assets = {str(asset.id): asset for asset in snapshot.assets}
        for asset_id in referenced_asset_ids:
            if str(asset_id) not in assets:
                raise ProjectError('引用素材不属于当前工程。', 409)
        model = config['modelId'] if config else runtime_model
        model_is_cli_default = spec.modelSource == 'cli' and not model
        return {
            'session': session,
            'directory': directory,
            'config': config,
            'prepared': prepared,
            'config_id': str(resolved_model_id) if resolved_model_id is not None else None,
            'available': available,
            'model': model,
            'model_is_cli_default': model_is_cli_default,
            'model_selections': dict(model_selections),
            'preferences': preferences_for(model_selections),
            'thinking': thinking,
            'accept_language': accept_language,
            'assets': assets,
        }

    async def prepare(project_id: UUID, value: Turn, session: str, accept_language: str | None) -> dict:
        """Validate a submitted turn and resolve everything it needs to run.

        Validation happens while the user is still at the keyboard: a message
        that could never run must fail now, not after the active turn, when the
        user has already moved on.
        """
        base = await _prepare_runtime_and_assets(
            project_id,
            session,
            accept_language,
            runtime_name=value.runtime,
            runtime_model=value.runtimeModel,
            model_id=value.modelId,
            thinking=value.thinking,
            model_selections=dict(value.modelSelections),
            selected_skills=value.skills,
            mode=value.mode,
            referenced_asset_ids=[str(key) for key in value.assets],
        )
        assets = base.pop('assets')
        config = base['config']
        model_cfg_id = str(config['id']) if config is not None else (str(value.modelId) if value.modelId else None)
        return {
            **base,
            'message': {
                'id': str(value.id),
                'role': 'user',
                'text': value.text,
                'content': value.content,
                'assets': [
                    {
                        'id': str(asset.id),
                        'name': asset.name,
                        'type': asset.metadata.mimeType,
                        'size': asset.metadata.size,
                        'fingerprint': asset.fingerprint,
                    }
                    for asset in (assets[str(key)] for key in value.assets)
                ],
                'skills': value.skills,
                'runtime': value.runtime,
                'runtimeModel': value.runtimeModel,
                'modelSelections': dict(value.modelSelections),
                'model': base['model'],
                'modelId': str(config['id']) if config is not None else None,
                'modelIsCliDefault': base['model_is_cli_default'],
                'thinking': value.thinking,
                'status': 'complete',
                **({'mode': value.mode} if value.mode != 'auto' else {}),
                **({'planOnly': True} if value.planOnly else {}),
                **({'modelConfigId': model_cfg_id} if model_cfg_id else {}),
            },
        }

    async def plan_for(project_id: UUID, message: dict, session: str, accept_language: str | None) -> dict:
        """Settings for a message that was accepted earlier and is due now.

        The message was validated when the user sent it, so this rebuilds the
        run settings without rejecting input that is already typed: a model that
        has disappeared in the meantime falls back to the runtime default.
        """
        directory = await asyncio.to_thread(conversations.path, project_id, session)
        spec = runtime_spec(message['runtime'])
        config = None
        config_id = message.get('modelConfigId') or message.get('modelId')
        if spec.modelSource == 'settings' and config_id:
            try:
                config = await asyncio.to_thread(configs.resolve, config_id, 'agent')
            except Exception:
                logger.warning('agent.queue.model_missing project_id=%s message_id=%s',
                               project_id, message.get('id'))
        available = await skills(projects.local.repository, directory) if spec.supportsSkills else []
        model_selections = dict(message.get('modelSelections') or {})
        return {'session': session, 'directory': directory, 'config': config, 'available': available,
                'model': message.get('model') or 'CLI 默认模型',
                'model_is_cli_default': bool(message.get('modelIsCliDefault')),
                'model_selections': model_selections,
                'preferences': preferences_for(model_selections), 'accept_language': accept_language,
                'thinking': message.get('thinking') or 'auto', 'message': message}

    async def produce_one(chain: Chain, plan: dict) -> tuple[dict | None, str | None, str]:
        """Run one turn or task segment and persist its reply; the caller decides what runs next."""
        project_id = chain.project_id
        message = plan['message']
        turn_id = UUID(message['id'])
        segment_meta = plan.get('segment_meta')
        segment_claimed = segment_meta is not None
        effective_task_id = plan.get('task_id') or turn_id
        current_plan = (segment_meta or {}).get('task', {}).get('plan')
        text, status, error = '', 'complete', None
        activities: list[dict] = []
        sources: dict = {}
        previous_sources: dict = {}
        steps = None
        run_session = plan.get('run_session') or chain.session
        timing: dict = {}
        turn_started = time.monotonic()
        renewal: asyncio.Task | None = None

        async def renew_session() -> None:
            """Keep the project writable while a turn outlives the lease it started under."""
            try:
                if not await asyncio.to_thread(projects.local.renew_agent_session, run_session):
                    return
            except Exception:
                logger.exception(f'agent.session.renew.failed project_id={project_id}')
            while True:
                await asyncio.sleep(projects.local.LEASE_SECONDS / 3)
                try:
                    if not await asyncio.to_thread(projects.local.renew_agent_session, run_session):
                        return
                except Exception:
                    logger.exception(f'agent.session.renew.failed project_id={project_id}')

        try:
            saved = plan['start']
            chain.conversation_id = UUID(saved['conversationId'])
            renewal = asyncio.create_task(renew_session())
            if segment_meta is None:
                mode: InteractionMode = message.get('mode') or 'auto'
                plan_only = bool(message.get('planOnly'))
                if mode == 'ask' or plan_only:
                    task_record = await asyncio.to_thread(
                        decisions.begin_task,
                        project_id,
                        chain.conversation_id,
                        turn_id,
                        mode=mode,
                        runtime=message['runtime'],
                        referenced_asset_ids=[item['id'] for item in (message.get('assets') or [])],
                        plan_only=plan_only,
                        continue_existing=mode == 'ask',
                    )
                    segment_claimed = True
                    effective_task_id = UUID(task_record['taskId'])
                    current_plan = task_record.get('plan')
                    effective_stage = task_record['stage']
                else:
                    effective_stage = 'running'
            else:
                mode = plan['mode']
                effective_stage = plan['task_stage']

            raw_state = await asyncio.to_thread(
                decisions.public_state, project_id, saved['conversationId'], turn_id
            )
            enriched_start = _enrich_conversation(project_id, saved, decisions, turn_id, state=raw_state)
            chain.events.put({'type': 'start', 'turnId': str(turn_id), 'conversation': enriched_start})
            reply_id = str(uuid5(turn_id, 'assistant'))
            non_queued = [
                item for item in saved['messages']
                if item.get('status') not in {'queued', 'cancelled'}
            ]
            if segment_meta is None:
                reply_index = next(
                    (idx for idx, item in enumerate(non_queued) if item['id'] == reply_id),
                    len(non_queued),
                )
                history = non_queued[:reply_index]
            else:
                # A retry reuses its earlier reply slot, even after newer turns have completed.
                history = [item for item in non_queued if item['id'] != reply_id]
            previous_sources = {
                source['id']: source
                for item in history
                for source in item.get('sources', [])
            }
            snapshot = await asyncio.to_thread(projects.snapshot, project_id)
            assets = {str(asset.id): asset for asset in snapshot.assets}
            decisions_by_id = {d['requestId']: d for d in raw_state['decisions']}
            tasks_by_id = {t['taskId']: t for t in raw_state['tasks']}
            context = _build_context_messages(
                plan['directory'],
                history,
                assets,
                plan['preferences'],
                decisions_by_id,
                tasks_by_id,
                current_segment=segment_meta,
            )
            dispatched_marked = False

            async def mark_dispatched() -> None:
                nonlocal dispatched_marked
                if dispatched_marked or segment_meta is None:
                    return
                await asyncio.to_thread(decisions.mark_model_dispatched, project_id, effective_task_id, turn_id)
                dispatched_marked = True

            run = RunContext(
                runtime=message['runtime'],
                project_id=project_id,
                turn_id=turn_id,
                session=run_session,
                directory=plan['directory'],
                config=plan['config'],
                messages=context,
                selected_skills=message.get('skills') or [],
                thinking=plan['thinking'],
                model_selections=plan['model_selections'],
                runtime_model=message.get('runtimeModel'),
                skills=plan['available'],
                conversation_id=chain.conversation_id,
                mode=mode,
                task_id=effective_task_id,
                task_stage=effective_stage,
                current_plan=current_plan,
                rebuild_native_context=bool(non_queued and non_queued[-1]['id'] != reply_id),
                on_dispatched=mark_dispatched if segment_meta is not None else None,
            )
            async with aclosing(runtimes.stream(run)) as stream:
                async for event in stream:
                    if message['runtime'] != 'deepseek':
                        await mark_dispatched()
                    if event['type'] == 'delta':
                        text += event['text']
                        inherited = ([source for source in referenced_sources(text, previous_sources)
                                      if source['id'] not in sources]
                                     if previous_sources and '\ue201' in event['text'] else [])
                        if inherited:
                            sources.update({source['id']: source for source in inherited})
                            chain.events.put({'type': 'sources', 'sources': inherited})
                    if event['type'] == 'sources':
                        for source in event['sources']:
                            sources.setdefault(source['id'], source)
                    if event['type'] == 'plan':
                        steps = event['entries']
                    if event['type'] == 'tool':
                        # Measurement is a side ledger: the per-call numbers must
                        # not become part of the tool call the turn persists.
                        agent_timing.note(timing, event)
                        previous = next((item for item in activities if item['id'] == event['id']), None)
                        activity = {**{key: item for key, item in event.items()
                                       if key not in {'type', 'timing'}},
                                    'textOffset': previous['textOffset'] if previous else len(text)}
                        if previous is None:
                            activities.append(activity)
                        else:
                            activities[activities.index(previous)] = activity
                        event = {'type': 'tool', **activity}
                    chain.events.put(event)
        except asyncio.CancelledError:
            status = 'stopped'
            raise
        except Exception as failure:
            # Persist partial output even when an integration fails unexpectedly.
            status = 'interrupted'
            if isinstance(failure, ProjectError):
                error = localized_error_for_language(
                    plan.get('accept_language'), chinese=str(failure),
                    status=failure.status, code=failure.code)
            else:
                error = localized_error_for_language(
                    plan.get('accept_language'),
                    chinese='Agent 执行失败，请检查后端日志。',
                    status=500, code='operation_rejected')
            logger.exception(f'agent.turn.failed project_id={project_id} turn_id={turn_id}')
        finally:
            for activity in activities:
                if activity['status'] == 'running':
                    activity['status'] = 'interrupted'
            try:
                if segment_claimed or (plan['directory'] / 'agent-runs' / 'decisions.json').is_file():
                    await asyncio.to_thread(
                        decisions.finalize_segment,
                        project_id,
                        turn_id,
                        reply_text=text,
                        segment_status=status,
                        error=error,
                    )
                saved = await asyncio.to_thread(conversations.update, project_id, finish={
                    'id': str(uuid5(turn_id, 'assistant')),
                    'role': 'assistant',
                    'turnId': str(turn_id),
                    'taskId': str(effective_task_id),
                    'text': text,
                    'status': status,
                    'model': plan['model'],
                    'modelIsCliDefault': plan.get('model_is_cli_default', False),
                    'runtime': message['runtime'],
                    'thinking': plan['thinking'],
                    'tools': activities,
                    'sources': list(sources.values()),
                    **({'plan': steps} if steps is not None else {})}, conversation_id=chain.conversation_id)
                saved = await asyncio.to_thread(_enrich_conversation, project_id, saved, decisions, None)
            except Exception:
                logger.exception(f'agent.turn.unfinished project_id={project_id} turn_id={turn_id}')
                saved = None
            finally:
                if renewal is not None:
                    renewal.cancel()
                    with suppress(asyncio.CancelledError):
                        await renewal
                try:
                    # Measurement and the lease are both best effort: losing
                    # either may cost a file or a lock, never the turn's reply.
                    await asyncio.to_thread(agent_timing.write, plan['directory'], turn_id, timing,
                                            round(time.monotonic() - turn_started, 3))
                    if plan.get('run_session'):
                        await asyncio.to_thread(projects.local.release_agent_session, plan['run_session'])
                except Exception:
                    logger.exception(f'agent.turn.timing.failed project_id={project_id} turn_id={turn_id}')
            chain.last = saved
        return saved, error, status

    async def run_chain(chain: Chain, plan: dict) -> None:
        """Run a turn, then take the next queued message until the queue is empty.

        Dispatching the next message and releasing the project slot happen under
        the admission lock, so a message can never be appended after the queue
        was found empty but before the slot is released: it either runs in this
        chain or it starts a new one.
        """
        project_id = chain.project_id
        turn_id, saved, error, status = chain.turn, None, None, 'complete'
        try:
            while True:
                saved, error, status = await produce_one(chain, plan)
                turn_id = UUID(plan['message']['id'])
                if status != 'complete' or chain.stopped:
                    break
                run_session = str(uuid4())
                async with admission.setdefault(project_id, asyncio.Lock()):
                    dispatched = None if chain.stopped else await asyncio.to_thread(
                        conversations.dispatch, project_id, chain.session, run_session)
                if dispatched is None:
                    break
                chain.turn = UUID(dispatched['message']['id'])
                enriched_dispatched = await asyncio.to_thread(
                    _enrich_conversation, project_id, dispatched['conversation'], decisions, chain.turn
                )
                chain.events.put({'type': 'end', 'turnId': str(turn_id), 'nextTurnId': str(chain.turn),
                                  'conversation': enriched_dispatched, 'error': None})
                plan = await plan_for(project_id, dispatched['message'], chain.session, None)
                plan['start'] = dispatched['conversation']
                plan['run_session'] = run_session
                saved = None
        except asyncio.CancelledError:
            status, error = 'stopped', None
            raise
        finally:
            chain.events.put({'type': 'end', 'turnId': str(turn_id), 'nextTurnId': None,
                              'conversation': saved if saved is not None else chain.last, 'error': error})
            if active.get(project_id) is chain:
                active.pop(project_id, None)

    def launch(project_id: UUID, plan: dict, conversation_id: UUID | None) -> StreamingResponse:
        chain = Chain(id=uuid4(), project_id=project_id, events=RunEvents(), session=plan['session'],
                      turn=UUID(plan['message']['id']), conversation_id=conversation_id)
        active[project_id] = chain
        chain.task = asyncio.create_task(run_chain(chain, plan))
        def release(completed: asyncio.Task) -> None:
            # The chain normally releases the slot itself; this covers a task
            # cancelled before it ever started.
            if active.get(project_id) is chain and completed is chain.task:
                active.pop(project_id, None)
        chain.task.add_done_callback(release)
        # Closing this stream (switching projects, reloading) only detaches the
        # viewer; the run continues and can be attached again.
        return StreamingResponse(chain.events.follow(), media_type='text/event-stream')

    def rejected(turn_id: UUID, failure: ProjectError, accept_language: str | None) -> StreamingResponse:
        """Report a message that cannot be opened as one already closed stream.

        A rejected message never entered the conversation, so the viewer has
        nothing to catch up on: the stream carries the end frame a client
        already knows how to show.
        """
        events = RunEvents()
        events.put({'type': 'end', 'turnId': str(turn_id), 'nextTurnId': None, 'conversation': None,
            'error': localized_error_for_language(accept_language, chinese=str(failure),
                status=failure.status, code=failure.code)})
        return StreamingResponse(events.follow(), media_type='text/event-stream')

    @router.post('/turns/{turn_id}/stop')
    async def stop(project_id: UUID, turn_id: UUID, x_opendirector_session: UUID = Header()):
        session = str(x_opendirector_session)
        await asyncio.to_thread(conversations.path, project_id, session)
        chain = active.get(project_id)
        if chain is not None and turn_id in (chain.turn, chain.id, chain.conversation_id):
            chain.stopped = True
            with CancelScope(shield=True):
                if chain.task is not None and not chain.task.cancelling():
                    chain.task.cancel()
                if chain.task is not None:
                    with suppress(asyncio.CancelledError):
                        await chain.task
            async with admission.setdefault(project_id, asyncio.Lock()):
                await asyncio.to_thread(conversations.cancel_queued, project_id, session)
        return {'ok': True}

    @router.get('/turns/{turn_id}/events')
    async def turn_events(project_id: UUID, turn_id: UUID, after: int = 0):
        await asyncio.to_thread(conversations.path, project_id)
        chain = active.get(project_id)
        if chain is not None and turn_id not in (chain.turn, chain.id):
            # A viewer that lost the stream between two turns remembers the turn
            # it saw last, which is already over while its chain keeps running.
            try:
                settled = await asyncio.to_thread(conversations.conversation_of, project_id, turn_id)
            except ProjectError:
                settled = None
            if settled is None or settled != str(chain.conversation_id):
                chain = None
        if chain is None:
            raise ProjectError('这轮回复已结束，请重新读取对话。', 404)
        return StreamingResponse(chain.events.follow(after), media_type='text/event-stream')

    def _resolve_task_turn_parameters(current_conv: dict, task: dict) -> dict:
        preferred_id = task.get('latestTurnId') or task['taskId']
        initial_user = next(
            (m for m in current_conv.get('messages', []) if m.get('role') == 'user' and m.get('id') == preferred_id),
            None,
        ) or next(
            (m for m in current_conv.get('messages', []) if m.get('role') == 'user' and m.get('id') == task['taskId']),
            None,
        )
        if initial_user is None:
            raise ProjectError('找不到原任务的消息和模型配置。', 409, code='task_model_unavailable')
        runtime_name = initial_user.get('runtime') or task.get('runtime') or current_conv.get('runtime') or 'default'
        runtime_model = initial_user.get('runtimeModel')
        if runtime_model is None:
            if current_conv.get('runtime') == runtime_name:
                runtime_model = current_conv.get('runtimeModel')
            if runtime_model is None:
                runtime_model = (current_conv.get('harnessModels') or {}).get(runtime_name)
        model_selections = {
            **dict(initial_user.get('modelSelections') or {}),
            **dict(current_conv.get('modelSelections') or {}),
        }
        thinking = (
            initial_user.get('thinking')
            or (current_conv.get('thinking') if current_conv.get('runtime') == runtime_name else None)
            or 'auto'
        )
        selected_skills = list(initial_user.get('skills') or [])
        draft_agent_id = (current_conv.get('modelSelections') or {}).get('agent')
        initial_agent_id = (
            initial_user.get('modelId')
            or initial_user.get('modelConfigId')
            or (initial_user.get('modelSelections') or {}).get('agent')
        )
        model_id = initial_agent_id or draft_agent_id
        if runtime_spec(runtime_name).modelSource == 'settings':
            resolved_id = None
            candidates = [draft_agent_id, initial_agent_id] if draft_agent_id else [initial_agent_id]
            for candidate_id in candidates:
                if not candidate_id:
                    continue
                try:
                    resolved = configs.resolve(str(candidate_id), 'agent')
                    resolved_id = str(resolved['id'])
                    break
                except ProjectError:
                    continue
            if resolved_id is not None:
                model_id = resolved_id
            else:
                agent_configs = [row for row in configs.list() if row.get('kind') == 'agent' and row['modelId'] == initial_user.get('model')]
                if len(agent_configs) == 1:
                    model_id = str(agent_configs[0]['id'])
                else:
                    raise ProjectError('无法确认原任务的 Agent 模型配置。', 409, code='task_model_unavailable')
        return {
            'runtime': runtime_name,
            'runtimeModel': runtime_model,
            'modelSelections': model_selections,
            'thinking': thinking,
            'skills': selected_skills,
            'modelId': model_id,
        }

    def _completed_sse(turn_id: UUID, saved_conv: dict) -> StreamingResponse:
        events = RunEvents()
        events.put({'type': 'end', 'turnId': str(turn_id), 'nextTurnId': None, 'conversation': saved_conv, 'error': None})
        return StreamingResponse(events.follow(), media_type='text/event-stream')

    async def _launch_task_segment(
        project_id: UUID,
        session: str,
        accept_language: str | None,
        *,
        segment_turn_id: UUID,
        task: dict,
        task_stage: str,
        segment_begin: dict,
        current_segment_meta: dict,
        claim_execution=None,
    ) -> StreamingResponse:
        if project_id in active:
            raise ProjectError('当前工程已有回复正在执行。', 409, code='project_assistant_busy')
        current_conv = await asyncio.to_thread(conversations.update, project_id, session)
        params = _resolve_task_turn_parameters(current_conv, task)
        mode: InteractionMode = task.get('mode', 'ask')
        plan = await _prepare_runtime_and_assets(
            project_id,
            session,
            accept_language,
            runtime_name=params['runtime'],
            runtime_model=params['runtimeModel'],
            model_id=params['modelId'],
            thinking=params['thinking'],
            model_selections=params['modelSelections'],
            selected_skills=params['skills'],
            mode=mode,
            referenced_asset_ids=[],
        )
        plan.pop('assets', None)
        check = revalidate(plan)
        if claim_execution is not None:
            if check is not None:
                await asyncio.to_thread(check)
            claimed = await asyncio.to_thread(claim_execution)
            if claimed['state'] != 'claimed':
                raise ProjectError('计划执行已受理，请查询原执行片段。', 409, code='project_assistant_busy')
            current_segment_meta = {**current_segment_meta, 'task': claimed['task']}
        run_session = str(uuid4())
        seg = {
            **segment_begin,
            'model': plan['model'],
            'modelIsCliDefault': plan['model_is_cli_default'],
            'runtime': params['runtime'],
        }
        plan['start'] = await asyncio.to_thread(
            conversations.update,
            project_id,
            session,
            begin_segment=seg,
            conversation_id=UUID(task['conversationId']),
            before_begin=check,
            agent_session=run_session,
        )
        plan['run_session'] = run_session
        plan['task_id'] = UUID(task['taskId'])
        plan['task_stage'] = task_stage
        plan['mode'] = mode
        plan['segment_meta'] = current_segment_meta
        plan['message'] = {
            'id': str(segment_turn_id),
            'runtime': params['runtime'],
            'runtimeModel': params['runtimeModel'],
            'skills': params['skills'],
            'mode': mode,
            'planOnly': False,
            'assets': [],
        }
        return launch(project_id, plan, UUID(plan['start']['conversationId']))

    @router.post('/continuations/{continuation_id}')
    async def continue_decision(
        project_id: UUID,
        continuation_id: UUID,
        x_opendirector_session: UUID = Header(),
        accept_language: str | None = Header(default=None, alias='Accept-Language'),
    ):
        session = str(x_opendirector_session)
        async with admission.setdefault(project_id, asyncio.Lock()):
            running = active.get(project_id)
            if running is not None and running.task is not None and not running.task.done():
                if running.turn == continuation_id:
                    return StreamingResponse(running.events.follow(), media_type='text/event-stream')
                raise ProjectError('当前工程已有回复正在执行。', 409, code='project_assistant_busy')

            await asyncio.to_thread(decisions.reconcile_interrupted, project_id)
            launching[project_id] = continuation_id
            try:
                claimed = await asyncio.to_thread(decisions.claim_continuation, project_id, session, continuation_id)
                if claimed['state'] == 'already_completed':
                    return _completed_sse(continuation_id, await _read_enriched_conversation(project_id, include_launching=False))
                if claimed['state'] == 'already_resuming':
                    await asyncio.to_thread(decisions.reconcile_interrupted, project_id, None)
                    current = await _read_enriched_conversation(project_id, include_launching=False)
                    dec = next((d for d in current.get('decisions', []) if d.get('continuationId') == str(continuation_id)), None)
                    if dec and dec.get('status') == 'completed':
                        return _completed_sse(continuation_id, current)
                    raise ProjectError(
                        '上一次接续执行状态待核对，为避免重复付费调用，未自动重发。',
                        409,
                        code='continuation_status_unknown',
                    )

                task, decision = claimed['task'], claimed['decision']
                try:
                    return await _launch_task_segment(
                        project_id,
                        session,
                        accept_language,
                        segment_turn_id=continuation_id,
                        task=task,
                        task_stage='resuming',
                        segment_begin={
                            'turnId': str(continuation_id),
                            'taskId': task['taskId'],
                            'segmentKind': 'continuation',
                            'parentRequestId': decision['requestId'],
                        },
                        current_segment_meta={'kind': 'continuation', 'task': task, 'decision': decision},
                    )
                except Exception as failure:
                    await asyncio.to_thread(
                        decisions.finalize_segment,
                        project_id,
                        continuation_id,
                        reply_text='',
                        segment_status='interrupted',
                        error=str(failure),
                        before_model=True,
                    )
                    raise
            finally:
                launching.pop(project_id, None)

    @router.post('/tasks/{task_id}/confirm-plan')
    async def confirm_task_plan(
        project_id: UUID,
        task_id: UUID,
        value: PlanConfirmInput,
        x_opendirector_session: UUID = Header(),
        accept_language: str | None = Header(default=None, alias='Accept-Language'),
    ):
        session = str(x_opendirector_session)
        async with admission.setdefault(project_id, asyncio.Lock()):
            tentative_exec_cid = uuid5(task_id, f'execute:{value.planRevision}')
            launching[project_id] = tentative_exec_cid
            try:
                running = active.get(project_id)
                is_live = running is not None and running.task is not None and not running.task.done()
                if is_live and running.turn != tentative_exec_cid:
                    raise ProjectError('当前工程已有回复正在执行。', 409, code='project_assistant_busy')
                if not is_live:
                    await asyncio.to_thread(decisions.reconcile_interrupted, project_id)
                claimed = await asyncio.to_thread(
                    decisions.claim_plan_execution, project_id, session, task_id, value, inspect_only=True
                )
                exec_cid = UUID(claimed['continuationId'])
                launching[project_id] = exec_cid
                running = active.get(project_id)
                is_live = running is not None and running.task is not None and not running.task.done()
                if claimed['state'] == 'already_completed':
                    return _completed_sse(exec_cid, await _read_enriched_conversation(project_id, include_launching=False))
                if claimed['state'] == 'already_executing':
                    if is_live and running.turn == exec_cid:
                        return StreamingResponse(running.events.follow(), media_type='text/event-stream')
                    await asyncio.to_thread(decisions.reconcile_interrupted, project_id, None)
                    reconciled_task = await asyncio.to_thread(decisions.get_task, project_id, task_id)
                    if reconciled_task and reconciled_task.get('stage') in {'completed', 'waiting_jobs', 'execution_failed'}:
                        return _completed_sse(exec_cid, await _read_enriched_conversation(project_id, include_launching=False))
                    raise ProjectError(
                        '当前任务执行状态待核对，请先核对已生成产物或回执。',
                        409,
                        code='continuation_status_unknown',
                    )
                if is_live:
                    raise ProjectError('当前工程已有回复正在执行。', 409, code='project_assistant_busy')

                execution_claimed = False

                def _claim_execution():
                    nonlocal execution_claimed
                    result = decisions.claim_plan_execution(project_id, session, task_id, value)
                    execution_claimed = result.get('state') == 'claimed'
                    return result

                try:
                    return await _launch_task_segment(
                        project_id,
                        session,
                        accept_language,
                        segment_turn_id=exec_cid,
                        task=claimed['task'],
                        task_stage='executing',
                        segment_begin={'turnId': str(exec_cid), 'taskId': str(task_id), 'segmentKind': 'execution'},
                        current_segment_meta={'kind': 'execution', 'task': claimed['task']},
                        claim_execution=_claim_execution,
                    )
                except Exception as failure:
                    if execution_claimed:
                        await asyncio.to_thread(
                            decisions.finalize_segment,
                            project_id,
                            exec_cid,
                            reply_text='',
                            segment_status='interrupted',
                            error=str(failure),
                            before_model=True,
                        )
                    raise
            finally:
                launching.pop(project_id, None)

    @router.post('/turns')
    async def turn(project_id: UUID, value: Turn, x_opendirector_session: UUID = Header(),
                   accept_language: str | None = Header(default=None, alias='Accept-Language')):
        session = str(x_opendirector_session)
        async with admission.setdefault(project_id, asyncio.Lock()):
            if project_id in active:
                raise ProjectError('当前工程已有回复正在执行。', 409)
            launching[project_id] = value.id
            try:
                plan = await prepare(project_id, value, session, accept_language)
                run_session = str(uuid4())
                try:
                    plan['start'] = await asyncio.to_thread(conversations.update, project_id, session,
                        begin=plan['message'], conversation_id=value.conversationId,
                        before_begin=revalidate(plan), agent_session=run_session)
                except ProjectError as failure:
                    # The message points at a thread that is no longer the active one.
                    # Clients of this endpoint read that from the stream, so report it
                    # where they already look instead of as a bare status code.
                    return rejected(UUID(plan['message']['id']), failure, accept_language)
                plan['run_session'] = run_session
                return launch(project_id, plan, UUID(plan['start']['conversationId']))
            finally:
                launching.pop(project_id, None)

    @router.post('/messages')
    async def message(project_id: UUID, value: Turn, x_opendirector_session: UUID = Header(),
                      accept_language: str | None = Header(default=None, alias='Accept-Language')):
        """Accept a message while a turn runs and run it when that turn is done.

        A message that arrives while the project is idle starts a turn right
        away, so a client can use one endpoint for both cases and never has to
        guess whether the active turn has finished.
        """
        session = str(x_opendirector_session)
        async with admission.setdefault(project_id, asyncio.Lock()):
            plan = await prepare(project_id, value, session, accept_language)
            chain = active.get(project_id)
            if chain is not None:
                if value.conversationId is not None and chain.conversation_id is not None \
                        and str(value.conversationId) != str(chain.conversation_id):
                    raise ProjectError('当前对话已切换，请重新加载后重试；原对话未覆盖。', 409)
                queued = await asyncio.to_thread(conversations.queue, project_id, session,
                                                 plan['message'], value.conversationId)
                chain.events.put({'type': 'queued', 'message': queued})
                return JSONResponse({'queued': queued, 'chainId': str(chain.id),
                                     'turnId': str(chain.turn)}, status_code=202)
            launching[project_id] = value.id
            try:
                check = revalidate(plan)
                if check is not None:
                    await asyncio.to_thread(check)
                await asyncio.to_thread(conversations.queue, project_id, session, plan['message'], value.conversationId)
                start_session = str(uuid4())
                dispatched = await asyncio.to_thread(conversations.dispatch, project_id, session, start_session)
                if dispatched is None:
                    raise ProjectError('这条消息未能开始执行，请重新发送。', 409)
                started = await plan_for(project_id, dispatched['message'], session, accept_language)
                started['start'] = dispatched['conversation']
                started['run_session'] = start_session
                return launch(project_id, started, UUID(dispatched['conversation']['conversationId']))
            finally:
                launching.pop(project_id, None)

    return router
