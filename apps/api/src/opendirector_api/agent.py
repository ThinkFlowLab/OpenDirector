"""Project-scoped assistant persistence and native runtime streaming."""
import asyncio
from contextlib import aclosing, suppress
from dataclasses import dataclass, replace
import json
import logging
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID, uuid4, uuid5

from anyio import CancelScope
from fastapi import APIRouter, Header
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, JsonValue

from opendirector.agent.catalog import model_choices
from opendirector.agent.context import RunContext, RuntimeId
from opendirector.agent.citations import referenced_sources, with_trace_sources
from opendirector.agent.runtime import AgentRuntimes, runtime_available, configured_runtimes, runtime_spec, runtime_catalog, runtime_status
from opendirector.agent.skills import skills
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


class Conversations:
    def __init__(self, projects):
        self.projects = projects

    def path(self, project_id: UUID, session: str | None = None) -> Path:
        with self.projects.local.transaction() as db:
            self.projects._recover()
            directory, _, _ = self.projects._load(db, project_id)
            if session:
                self.projects._lease(db, project_id, directory, session)
            return directory

    def update(self, project_id: UUID, session: str | None = None, *, draft: Draft | None = None,
               begin: dict | None = None, finish: dict | None = None, conversation_id: UUID | None = None,
               before_begin=None) -> dict:
        with self.projects.local.transaction() as db:
            self.projects._recover()
            directory, _, _ = self.projects._load(db, project_id)
            if session:
                self.projects._lease(db, project_id, directory, session)
            folder = child(directory, 'agent-runs')
            folder.mkdir(exist_ok=True)
            file = child(folder, 'conversation.json')
            value = read_json(file) if file.exists() else {'messages': [], **Draft().model_dump()}
            value['conversationId'] = value.get('conversationId') or str(uuid5(project_id, 'assistant'))
            supplied = draft.conversationId if draft is not None else conversation_id
            if (draft is not None or begin is not None or finish is not None) and str(supplied) != value['conversationId'] and (supplied is not None or value.get('archivedConversations')):
                raise ProjectError('当前对话已切换，请重新加载后重试；原对话未覆盖。', 409)
            changed = False
            if draft is not None:
                value.update(draft.model_dump(mode="json", exclude={"conversationId"}))
                changed = True
            if begin is not None:
                if any(message['id'] == begin['id'] for message in value['messages']):
                    raise ProjectError('这条消息已接受，请读取对话，不要重复发送。', 409)
                if before_begin is not None:
                    before_begin()
                value['messages'].append(begin)
                value['messages'].append({'id': str(uuid5(UUID(begin['id']), 'assistant')),
                    'role': 'assistant', 'text': '', 'status': 'streaming',
                    **{key: begin[key] for key in ('model', 'modelIsCliDefault', 'runtime') if key in begin}})
                value.update(draft='', draftContent=None, assets=[], skills=[])
                changed = True
            if finish is not None:
                value['messages'] = [finish if message['id'] == finish['id'] else message for message in value['messages']]
                changed = True
            if changed:
                durable_json(file, value)
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

    def dispatch(self, project_id: UUID, session: str | None = None) -> dict | None:
        """Start the oldest queued message as this turn's user message.

        Dispatching takes the same lock as starting a run, so the project slot
        never opens between one turn ending and the next beginning; a second run
        cannot slip in ahead of the message that is already waiting.
        """
        with self.projects.local.transaction() as db:
            self.projects._recover()
            directory, _, _ = self.projects._load(db, project_id)
            if session:
                self.projects._lease(db, project_id, directory, session)
            folder = child(directory, 'agent-runs')
            folder.mkdir(exist_ok=True)
            file = child(folder, 'conversation.json')
            value = read_json(file) if file.exists() else {'messages': [], **Draft().model_dump()}
            value['conversationId'] = value.get('conversationId') or str(uuid5(project_id, 'assistant'))
            pending = next((item for item in value['messages'] if item.get('status') == 'queued'), None)
            if pending is None:
                return None
            index = value['messages'].index(pending)
            pending['status'] = 'complete'
            value['messages'].insert(index + 1, {
                'id': str(uuid5(UUID(pending['id']), 'assistant')),
                'role': 'assistant', 'text': '', 'status': 'streaming',
                **{key: pending[key] for key in ('model', 'runtime') if key in pending}})
            value.update(draft='', draftContent=None, assets=[], skills=[])
            durable_json(file, value)
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

        A turn is a user message together with the assistant message whose id is derived from
        it (``uuid5(user id, 'assistant')``), which is how a turn is persisted when it is accepted.
        A user message without that assistant record was never executed and is not a turn.
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
            if message.get('role') != 'user':
                continue
            try:
                reply = replies.get(str(uuid5(UUID(message['id']), 'assistant')))
            except (KeyError, ValueError, TypeError):
                reply = None
            if reply is None:
                continue
            status = reply.get('status') or 'complete'
            if status == 'streaming' and (found is not current or running != UUID(message['id'])):
                status = 'interrupted'
            turns.append({'id': message['id'], 'number': len(turns) + 1,
                          'text': (message.get('text') or '')[:200],
                          'runtime': reply.get('runtime') or message.get('runtime') or 'default',
                          'model': reply.get('model') or message.get('model'),
                          'status': status})
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
        raise ProjectError('该轮用户消息不存在。', 404)

    def activate(self, project_id: UUID, conversation_id: UUID, session: str, *, create=False) -> dict:
        with self.projects.local.transaction() as db:
            self.projects._recover()
            directory, _, _ = self.projects._load(db, project_id)
            self.projects._lease(db, project_id, directory, session)
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


def agent_routes(projects, generation, configs, provider=None, *, active=None) -> APIRouter:
    router = APIRouter(prefix='/api/creation/projects/{project_id}/assistant')
    conversations = Conversations(projects)
    runtimes = AgentRuntimes(projects, generation, configs, provider)

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
    admission: dict[UUID, asyncio.Lock] = {}

    @router.get('')
    async def conversation(project_id: UUID):
        value = await asyncio.to_thread(conversations.update, project_id)
        running = active.get(project_id)
        # A streaming message without a chain was interrupted (for example by a
        # restart); with one, the client can attach to the turn it is running.
        if running is not None:
            value = {**value, 'activeTurnId': str(running.turn)}
        return value

    @router.get('/conversations')
    async def list_conversations(project_id: UUID):
        return await asyncio.to_thread(conversations.list, project_id)

    async def change_conversation(project_id: UUID, conversation_id: UUID, session: UUID, *, create=False):
        async with admission.setdefault(project_id, asyncio.Lock()):
            if project_id in active:
                raise ProjectError('请先停止或等待当前回复结束，再切换对话。', 409)
            return await asyncio.to_thread(conversations.activate, project_id, conversation_id, str(session), create=create)

    @router.post('/conversations')
    async def new_conversation(project_id: UUID, value: ConversationCreate, x_opendirector_session: UUID = Header()):
        return await change_conversation(project_id, value.id, x_opendirector_session, create=True)

    @router.post('/conversations/{conversation_id}/activate')
    async def activate_conversation(project_id: UUID, conversation_id: UUID, x_opendirector_session: UUID = Header()):
        return await change_conversation(project_id, conversation_id, x_opendirector_session)

    @router.put('/draft')
    async def draft(project_id: UUID, value: Draft, x_opendirector_session: UUID = Header()):
        return await asyncio.to_thread(conversations.update, project_id, str(x_opendirector_session), draft=value)

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

    async def prepare(project_id: UUID, value: Turn, session: str, accept_language: str | None) -> dict:
        """Validate a submitted turn and resolve everything it needs to run.

        Validation happens while the user is still at the keyboard: a message
        that could never run must fail now, not after the active turn, when the
        user has already moved on.
        """
        directory = await asyncio.to_thread(conversations.path, project_id, session)
        if not runtime_available(value.runtime):
            raise ProjectError(f'{value.runtime} 未安装，请安装 CLI 并登录。', 503)
        spec = runtime_spec(value.runtime)
        if not spec.supportsSkills and value.skills:
            raise ProjectError(f'{spec.label} 不支持技能，请移除技能后发送。', 409)
        if value.runtime == 'jiuwenswarm' and value.thinking != 'auto':
            raise ProjectError('JiuwenSwarm 当前使用原生默认推理强度。', 409)
        config = await asyncio.to_thread(configs.resolve, str(value.modelId), 'agent') if spec.modelSource == 'settings' else None
        prepared = None
        if config is not None:
            prepared = await asyncio.to_thread(generation.availability.prepare, config)
            current = await asyncio.to_thread(configs.resolve, str(value.modelId), 'agent')
            generation.availability.require(current, _assistant_request(current), prepared)
            config = current
        available = await skills(projects.local.repository, directory) if spec.supportsSkills else []
        if set(value.skills) - {item['name'] for item in available}:
            raise ProjectError('技能已失效，请重新选择。', 409)
        snapshot = await asyncio.to_thread(projects.snapshot, project_id)
        assets = {str(asset.id): asset for asset in snapshot.assets}
        for asset_id in value.assets:
            if str(asset_id) not in assets:
                raise ProjectError('引用素材不属于当前工程。', 409)
        model = config['modelId'] if config else value.runtimeModel
        model_is_cli_default = spec.modelSource == 'cli' and not model
        model_selections = dict(value.modelSelections)
        return {'session': session, 'directory': directory, 'config': config, 'prepared': prepared,
                'config_id': str(value.modelId) if value.modelId else None,
                'available': available,
                'model': model, 'model_is_cli_default': model_is_cli_default,
                'model_selections': model_selections,
                'preferences': preferences_for(model_selections), 'thinking': value.thinking,
                'accept_language': accept_language,
                'message': {'id': str(value.id), 'role': 'user', 'text': value.text, 'content': value.content,
                    'assets': [{'id': str(asset.id), 'name': asset.name, 'type': asset.metadata.mimeType,
                        'size': asset.metadata.size, 'fingerprint': asset.fingerprint}
                        for asset in (assets[str(key)] for key in value.assets)],
                    'skills': value.skills, 'runtime': value.runtime, 'runtimeModel': value.runtimeModel,
                    'modelSelections': dict(value.modelSelections), 'model': model,
                    'modelIsCliDefault': model_is_cli_default,
                    'thinking': value.thinking, 'status': 'complete',
                    **({'modelConfigId': str(value.modelId)} if value.modelId else {})}}

    async def plan_for(project_id: UUID, message: dict, session: str, accept_language: str | None) -> dict:
        """Settings for a message that was accepted earlier and is due now.

        The message was validated when the user sent it, so this rebuilds the
        run settings without rejecting input that is already typed: a model that
        has disappeared in the meantime falls back to the runtime default.
        """
        directory = await asyncio.to_thread(conversations.path, project_id, session)
        spec = runtime_spec(message['runtime'])
        config = None
        if spec.modelSource == 'settings' and message.get('modelConfigId'):
            try:
                config = await asyncio.to_thread(configs.resolve, message['modelConfigId'], 'agent')
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
        """Run one turn and persist its reply; the caller decides what runs next."""
        project_id = chain.project_id
        message = plan['message']
        turn_id = UUID(message['id'])
        text, status, error = '', 'complete', None
        activities: list[dict] = []
        sources: dict = {}
        previous_sources: dict = {}
        steps = None
        try:
            saved = plan['start']
            chain.conversation_id = UUID(saved['conversationId'])
            chain.events.put({'type': 'start', 'conversation': saved})
            previous_sources = {source['id']: source for reply in saved['messages'][:-2]
                                for source in reply.get('sources', [])}
            snapshot = await asyncio.to_thread(projects.snapshot, project_id)
            assets = {str(asset.id): asset for asset in snapshot.assets}
            context = []
            for reply in saved['messages'][:-1]:
                content = reply['text'] or '(empty reply)'
                references = []
                for attachment in reply.get('assets', []):
                    asset = assets.get(attachment['id'])
                    if asset is not None:
                        references.append({'id': str(asset.id), 'name': attachment['name'],
                            'kind': asset.kind, 'path': str((plan['directory'] / asset.path).resolve()),
                            'metadata': asset.metadata.model_dump(mode='json', exclude_none=True)})
                if references:
                    content += '\nReferenced project assets: ' + json.dumps(references, ensure_ascii=False)
                    content += '\nThese are asset references, not visual observations. Inspect media with available tools before describing its contents.'
                context.append({'role': reply['role'], 'content': content})
            if plan['preferences']:
                context[-1]['content'] += '\nUser model preferences for this turn: ' + json.dumps(plan['preferences'], ensure_ascii=False)
                context[-1]['content'] += '\nUse these models for new generation unless the user explicitly requests another. If unavailable or unsuitable, explain and ask before substituting. Keep existing nodes on their configured models unless the user requests a change.'
            run = RunContext(runtime=message['runtime'], project_id=project_id, turn_id=turn_id,
                session=chain.session, directory=plan['directory'], config=plan['config'], messages=context,
                selected_skills=message.get('skills') or [], thinking=plan['thinking'],
                model_selections=plan['model_selections'], runtime_model=message.get('runtimeModel'),
                skills=plan['available'], conversation_id=chain.conversation_id)
            async with aclosing(runtimes.stream(run)) as stream:
                async for event in stream:
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
                        previous = next((item for item in activities if item['id'] == event['id']), None)
                        activity = {**{key: item for key, item in event.items() if key != 'type'},
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
                saved = await asyncio.to_thread(conversations.update, project_id, finish={
                    'id': str(uuid5(turn_id, 'assistant')), 'role': 'assistant', 'text': text, 'status': status,
                    'model': plan['model'], 'modelIsCliDefault': plan.get('model_is_cli_default', False),
                    'runtime': message['runtime'], 'thinking': plan['thinking'], 'tools': activities,
                    'sources': list(sources.values()),
                    **({'plan': steps} if steps is not None else {})}, conversation_id=chain.conversation_id)
            except Exception:
                logger.exception(f'agent.turn.unfinished project_id={project_id} turn_id={turn_id}')
                saved = None
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
                async with admission.setdefault(project_id, asyncio.Lock()):
                    dispatched = None if chain.stopped else await asyncio.to_thread(
                        conversations.dispatch, project_id, chain.session)
                if dispatched is None:
                    break
                chain.turn = UUID(dispatched['message']['id'])
                chain.events.put({'type': 'end', 'turnId': str(turn_id), 'nextTurnId': str(chain.turn),
                                  'conversation': dispatched['conversation'], 'error': None})
                plan = await plan_for(project_id, dispatched['message'], chain.session, None)
                plan['start'] = dispatched['conversation']
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

    @router.post('/turns')
    async def turn(project_id: UUID, value: Turn, x_opendirector_session: UUID = Header(),
                   accept_language: str | None = Header(default=None, alias='Accept-Language')):
        session = str(x_opendirector_session)
        async with admission.setdefault(project_id, asyncio.Lock()):
            if project_id in active:
                raise ProjectError('当前工程已有回复正在执行。', 409)
            plan = await prepare(project_id, value, session, accept_language)
            try:
                plan['start'] = await asyncio.to_thread(conversations.update, project_id, session,
                    begin=plan['message'], conversation_id=value.conversationId,
                    before_begin=revalidate(plan))
            except ProjectError as failure:
                # The message points at a thread that is no longer the active one.
                # Clients of this endpoint read that from the stream, so report it
                # where they already look instead of as a bare status code.
                return rejected(UUID(plan['message']['id']), failure, accept_language)
            return launch(project_id, plan, UUID(plan['start']['conversationId']))

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
            check = revalidate(plan)
            if check is not None:
                await asyncio.to_thread(check)
            await asyncio.to_thread(conversations.queue, project_id, session, plan['message'], value.conversationId)
            dispatched = await asyncio.to_thread(conversations.dispatch, project_id, session)
            if dispatched is None:
                raise ProjectError('这条消息未能开始执行，请重新发送。', 409)
            started = await plan_for(project_id, dispatched['message'], session, accept_language)
            started['start'] = dispatched['conversation']
            return launch(project_id, started, UUID(dispatched['conversation']['conversationId']))

    return router
