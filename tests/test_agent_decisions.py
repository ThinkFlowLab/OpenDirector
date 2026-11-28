import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import sys
from uuid import UUID, uuid4, uuid5

from fastapi.testclient import TestClient
import pytest

from opendirector.agent import native
from opendirector.agent.context import RunContext
from opendirector.agent.decisions import (AskUserInput, DecisionAnswerSubmit, DecisionStore, PlanAdjustInput,
                                        PlanConfirmInput, UpdatePlanInput, step_operation_id)
from opendirector.domain.projects import ProjectError
from opendirector.agent.gateway import ToolGateway
from opendirector.agent.tools import AgentTools
from opendirector.domain.creation.commands import parse_command
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector_api import agent
from opendirector_api.main import create_app
from test_assistant_conversations import empty_skills, frames
from test_creation_canvas_service import project, send  # noqa: F401 (project is a fixture)


pytestmark = pytest.mark.cpu


@pytest.fixture
def configured_agent(tmp_path, monkeypatch):
    monkeypatch.setattr(agent, 'runtime_available', lambda _: True)
    monkeypatch.setattr(agent, 'skills', empty_skills)
    config = dict(id=str(uuid4()), modelId='test-model', kind='agent', url='http://models.test/v1',
                  connectionType='api', protocol='openai', authMode='none', apiKey='')
    monkeypatch.setattr(ModelConfigs, 'resolve', lambda *args: dict(config))
    monkeypatch.setattr(ModelConfigs, 'list', lambda self: [dict(config)])
    return LocalProjects(tmp_path)


@pytest.fixture
def fake_default_agent(configured_agent, monkeypatch):
    monkeypatch.setattr(agent.AgentRuntimes, 'stream', ask_stream)
    return configured_agent


async def ask_stream(runtimes, run):
    gateway = ToolGateway(runtimes.business, run)
    try:
        yield await ask_event(gateway, 'cli:ask-1')
        yield {'type': 'delta', 'text': '请先确认成片时长。'}
    finally:
        await gateway.close()


def cli_environment(work, socket, bridge_env):
    root = Path(__file__).resolve().parents[1]
    return {
        **os.environ,
        'PYTHONPATH': os.pathsep.join(str(root / path) for path in ('packages/core/src', 'apps/api/src')),
        'PWD': str(work),
        **(bridge_env or {'OPENDIRECTOR_AGENT_SOCKET': socket}),
    }


def open_project(client, name):
    project_id = str(uuid4())
    root = f'/api/creation/projects/{project_id}'
    assert client.post(root + '/commands', json={
        'type': 'project.create', 'projectId': project_id, 'commandId': str(uuid4()), 'payload': {'name': name},
    }).status_code == 200
    assert client.post(root + '/open').status_code == 200
    return project_id, root


def session_headers():
    return {'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': str(uuid4())}


def read_decision(client, root, request_id):
    return next(d for d in client.get(root + '/assistant').json()['decisions'] if d['requestId'] == request_id)


SAMPLE_QUESTIONS = [{
    'id': 'duration', 'question': '视频成片的目标时长是多少？', 'multiSelect': False, 'required': True,
    'options': [
        {'id': '8s', 'label': '8 秒（推荐）', 'impact': '标准节奏'},
        {'id': '5s', 'label': '5 秒', 'impact': '快节奏'},
        {'id': '15s', 'label': '15 秒', 'impact': '舒缓叙事'},
    ],
}]


async def ask_event(gateway, call_id, questions=SAMPLE_QUESTIONS, **payload):
    outcome = await gateway.call(call_id, 'ask_user', {'questions': questions, **payload})
    assert outcome.error is None, outcome.error
    return {'type': 'decision', 'decision': outcome.value['decision'], 'task': outcome.value['task']}


def ask_turn(client, root, text, *, turn_id=None, runtime='default', **fields):
    response = client.post(root + '/assistant/turns', json={
        'id': str(turn_id or uuid4()), 'runtime': runtime, 'mode': 'ask', 'text': text, **fields,
    })
    assert response.status_code == 200, response.text
    end = frames(response)[-1]
    assert end['error'] is None, end['error']
    return end['conversation']


def submit_answer(client, root, decision, question_id, source, **fields):
    response = client.post(root + f"/assistant/decisions/{decision['requestId']}/answers", json={
        'answers': [{'questionId': question_id, 'source': source, **fields}],
    })
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def anyio_backend():
    return 'asyncio'


def test_option_labels_strip_hardcoded_recommendation_badges():
    parsed = AskUserInput.model_validate({'questions': SAMPLE_QUESTIONS})
    assert parsed.questions[0].options[0].label == '8 秒'
    assert parsed.questions[0].options[1].label == '5 秒'


@pytest.mark.parametrize(('runtime', 'mode', 'plan_only', 'expected_code'), [
    ('default', 'auto', False, None),
    ('claude', 'auto', False, None),
    ('opencode', 'ask', False, 'plan_confirmation_required'),
    ('claude', 'ask', False, 'plan_confirmation_required'),
    ('default', 'auto', True, 'plan_confirmation_required'),
    ('default', 'ask', False, 'plan_confirmation_required'),
])
def test_only_explicit_planning_locks_writes(fake_default_agent, monkeypatch, runtime, mode, plan_only, expected_code):
    async def stream(runtimes, run):
        gateway = ToolGateway(runtimes.business, run)
        try:
            outcome = await gateway.call('write-probe', 'execute_command', {
                'type': 'asset.writeText', 'payload': {'name': 'notes.md', 'text': 'Storyboard notes'},
            })
            yield {**outcome.event('execute_command'), 'id': 'write-probe'}
            yield {'type': 'delta', 'text': '整理分镜笔记。'}
        finally:
            await gateway.close()

    monkeypatch.setattr(agent.AgentRuntimes, 'stream', stream)
    with TestClient(create_app(fake_default_agent), headers=session_headers()) as client:
        _, root = open_project(client, 'Explicit planning')
        response = client.post(root + '/assistant/turns', json={
            'id': str(uuid4()), 'runtime': runtime, 'mode': mode, 'planOnly': plan_only,
            'text': '先把分镜笔记写入工程，但先不要生成视频。',
        })
        assert response.status_code == 200
        operation = next(event for event in frames(response) if event['type'] == 'tool')
        assert operation.get('code') == expected_code
        assets = client.get(root).json()['assets']
        assert [asset['name'] for asset in assets] == ([] if expected_code else ['notes.md'])


@pytest.fixture
def draft_plan(project, agent_plan):
    projects, project_id, session = project
    tools = AgentTools(projects, None, ModelConfigs(projects.local.repository))

    def draft(steps=('Write storyboard',)):
        task = agent_plan(tools.decisions, 'Duration: 8 seconds', steps)
        return projects, tools, project_id, UUID(task['taskId']), session

    return draft


def claim_execution(store, project_id, task_id, session, revision=1, *, dispatch=True):
    claimed = store.claim_plan_execution(project_id, session, task_id, PlanConfirmInput(planRevision=revision))
    assert claimed['state'] == 'claimed'
    turn_id = UUID(claimed['continuationId'])
    if dispatch:
        store.mark_model_dispatched(project_id, task_id, turn_id)
    return turn_id


def save_duration_answer(store, project_id, task_id, session):
    question = store.record_question(project_id, task_id, 'ask-duration', AskUserInput(questions=SAMPLE_QUESTIONS))
    saved = store.submit_answer(project_id, session, question['decision']['requestId'], DecisionAnswerSubmit.model_validate({
        'answers': [{'questionId': 'duration', 'source': 'custom', 'customText': '12 seconds'}],
    }))
    return UUID(saved['continuationId'])


@pytest.mark.anyio
async def test_revision_between_journal_and_dispatch_cancels_old_write(draft_plan, monkeypatch):
    projects, tools, project_id, task_id, session = draft_plan()
    store = tools.decisions
    turn_id = claim_execution(store, project_id, task_id, session)
    recorded = store.record_pending_write

    def adjust_after_reservation(*args, **kwargs):
        result = recorded(*args, **kwargs)
        assert not projects.snapshot(project_id).assets
        revised = store.adjust_plan(project_id, session, task_id, PlanAdjustInput(planRevision=1, prompt='Duration: 12 seconds'))
        assert revised['planRevision'] == 2 and revised['confirmedPlanRevision'] is None
        return result

    monkeypatch.setattr(store, 'record_pending_write', adjust_after_reservation)
    with pytest.raises(ProjectError) as refused:
        await tools.execute(project_id, turn_id, session, 'cli:old-write', 'execute_command', {
            'type': 'asset.writeText', 'payload': {'name': 'old.md', 'text': '8 seconds'},
        }, [], None, 'codex')
    assert refused.value.code == 'plan_confirmation_required'
    assert not projects.snapshot(project_id).assets
    assert store.get_task(project_id, task_id)['pendingWrites'] == []


@pytest.mark.anyio
async def test_changed_requirements_do_not_reuse_same_named_steps(draft_plan):
    projects, tools, project_id, task_id, session = draft_plan()
    store = tools.decisions
    turn_id = claim_execution(store, project_id, task_id, session)
    task = store.get_task(project_id, task_id)
    original_id = step_operation_id(task, task['plan']['steps'][0])
    first = await tools.execute(project_id, turn_id, session, f'cli:{original_id}', 'execute_command', {
        'type': 'asset.writeText', 'payload': {'name': '8-second.md', 'text': '8 seconds'},
    }, [], None, 'codex')
    assert first['status'] == 'applied'
    revised = store.save_plan(project_id, turn_id, UpdatePlanInput(summary='Duration: 12 seconds', steps=['Write storyboard']))['task']
    revised_step = revised['plan']['steps'][0]
    assert revised_step['status'] == 'pending'
    assert step_operation_id(revised, revised_step) != original_id
    revised_turn = claim_execution(store, project_id, task_id, session, 2)
    second = await tools.execute(project_id, revised_turn, session, f'cli:{revised_step["operationId"]}', 'execute_command', {
        'type': 'asset.writeText', 'payload': {'name': '12-second.md', 'text': '12 seconds'},
    }, [], None, 'codex')
    assert second['status'] == 'applied'
    assert sorted(asset.name for asset in projects.snapshot(project_id).assets) == ['12-second.md', '8-second.md']


def test_delayed_adjustment_cannot_revoke_a_newer_confirmation(draft_plan):
    _, tools, project_id, task_id, session = draft_plan()
    store = tools.decisions
    claim_execution(store, project_id, task_id, session)
    delayed = PlanAdjustInput(planRevision=1)
    store.adjust_plan(project_id, session, task_id, delayed)
    revised_turn = claim_execution(store, project_id, task_id, session, 2)
    with pytest.raises(ProjectError) as refused:
        store.adjust_plan(project_id, session, task_id, delayed)
    assert refused.value.code == 'plan_revision_stale'
    current = store.get_task(project_id, task_id)
    assert (current['stage'], current['confirmedPlanRevision'], current['executionContinuationId']) == (
        'executing', 2, str(revised_turn),
    )


def test_empty_continuation_cannot_make_old_plan_confirmable(draft_plan):
    _, tools, project_id, task_id, session = draft_plan()
    store = tools.decisions
    continuation = save_duration_answer(store, project_id, task_id, session)
    store.claim_continuation(project_id, session, continuation)
    store.mark_model_dispatched(project_id, task_id, continuation)
    stopped = store.finalize_segment(project_id, continuation, reply_text='', segment_status='complete')
    assert stopped['stage'] == 'answer_saved' and stopped['planRevision'] == 1
    with pytest.raises(ProjectError) as refused:
        store.claim_plan_execution(project_id, session, task_id, PlanConfirmInput(planRevision=1))
    assert refused.value.code == 'plan_confirmation_required'
    retry = store.claim_continuation(project_id, session, continuation)
    assert retry['state'] == 'claimed'
    assert retry['decision']['answers'][0]['customText'] == '12 seconds'
    store.mark_model_dispatched(project_id, task_id, continuation)
    store.save_plan(project_id, continuation, UpdatePlanInput(summary='Duration: 12 seconds'))
    assert store.finalize_segment(project_id, continuation, reply_text='', segment_status='complete')['planRevision'] == 2
    claim_execution(store, project_id, task_id, session, 2)


@pytest.mark.parametrize('segment', ['execution', 'continuation'])
def test_restart_between_claim_and_model_dispatch_is_retryable(tmp_path, draft_plan, segment):
    _, tools, project_id, task_id, session = draft_plan()
    store = tools.decisions
    if segment == 'execution':
        turn_id = claim_execution(store, project_id, task_id, session, dispatch=False)
    else:
        turn_id = save_duration_answer(store, project_id, task_id, session)
        store.claim_continuation(project_id, session, turn_id)

    restarted = DecisionStore(CreationProjects(LocalProjects(tmp_path)))
    state = restarted.public_state(project_id, uuid5(project_id, 'assistant'))['tasks'][0]
    assert state['stage'] == ('waiting_confirmation' if segment == 'execution' else 'answer_saved')
    assert not state['pendingWrites'] and not state['acceptedReceipts']
    if segment == 'execution':
        assert claim_execution(restarted, project_id, task_id, session, dispatch=False) == turn_id
    else:
        assert restarted.claim_continuation(project_id, session, turn_id)['state'] == 'claimed'
    restarted.mark_model_dispatched(project_id, task_id, turn_id)
    after_dispatch = DecisionStore(CreationProjects(LocalProjects(tmp_path))).public_state(project_id, uuid5(project_id, 'assistant'))
    assert after_dispatch['tasks'][0]['stage'] == 'status_unknown'


@pytest.mark.anyio
@pytest.mark.parametrize('finish_segment', [False, True])
async def test_known_revision_rejection_allows_adjustment_and_retry(draft_plan, finish_segment):
    projects, tools, project_id, task_id, session = draft_plan(steps=('Hide canvas item',))
    item_id = uuid4()
    assert send(projects, project_id, 'canvas.show', session=session, item=dict(
        id=item_id, projectId=project_id, kind='text', title='Source',
        position=dict(x=0, y=0), binding=dict(role='empty'),
    )).status == 'applied'
    store = tools.decisions
    turn = claim_execution(store, project_id, task_id, session)
    task = store.get_task(project_id, task_id)
    operation_id = step_operation_id(task, task['plan']['steps'][0])
    arguments = {'type': 'canvas.hide', 'payload': {'itemId': str(item_id)},
                 'expectedVersions': [{'objectType': 'canvas_item', 'id': str(item_id), 'revision': 2}]}
    first = await tools.execute(project_id, turn, session, f'cli:{operation_id}', 'execute_command', arguments, [], None, 'codex')
    assert first['status'] == 'rejected' and first['issues'][0]['code'] == 'revision_conflict'
    if finish_segment:
        failed = store.finalize_segment(project_id, turn, reply_text='Revision conflict', segment_status='complete')
        assert failed['stage'] == 'execution_failed' and failed['plan']['steps'][0]['status'] == 'failed'
    assert not store.get_task(project_id, task_id)['pendingWrites']
    edited = store.adjust_plan(project_id, session, task_id, PlanAdjustInput(planRevision=1))
    revised_step = edited['plan']['steps'][0]
    assert revised_step['status'] == 'pending' and step_operation_id(edited, revised_step) != operation_id
    retry_turn = claim_execution(store, project_id, task_id, session, revision=2)
    arguments['expectedVersions'][0]['revision'] = projects.snapshot(project_id).canvasItems[0].revision
    retry = await tools.execute(project_id, retry_turn, session, f'cli:{revised_step["operationId"]}',
                                'execute_command', arguments, [], None, 'codex')
    assert retry['status'] == 'applied'
    assert not projects.snapshot(project_id).canvasItems[0].visible


@pytest.mark.anyio
async def test_plan_revision_revokes_old_execution_and_preserves_pending_identity(tmp_path, draft_plan):
    projects, business, project_id, task_id, session = draft_plan()
    store = business.decisions
    turn_id = claim_execution(store, project_id, task_id, session)
    command = {'commandId': str(uuid4()), 'type': 'voice_create'}
    store.record_pending_write(project_id, turn_id, 'voice', command, 'original-input')
    with pytest.raises(ProjectError, match='不同输入'):
        store.record_pending_write(project_id, turn_id, 'voice', command, 'different-input')
    assert store.get_task(project_id, task_id)['pendingWrites'][0]['inputFingerprint'] == 'original-input'
    store.record_accepted_receipt(project_id, turn_id, 'voice', command, 'original-input', {'status': 'rejected'})

    gateway = ToolGateway(business, RunContext(
        runtime='default', project_id=project_id, turn_id=turn_id, session=session, directory=tmp_path,
        config=None, messages=[], selected_skills=[], mode='ask', task_id=task_id, task_stage='executing',
    ))
    await gateway.execution_lock.acquire()
    try:
        queued = asyncio.create_task(gateway.call('queued', 'execute_command', {
            'type': 'asset.writeText', 'payload': {'name': 'old.md', 'text': 'old'},
        }))
        await asyncio.sleep(0)
        revised = store.save_plan(project_id, turn_id, UpdatePlanInput(summary='Write B', steps=['Write B']))['task']
        assert revised['planRevision'] == 2 and revised['confirmedPlanRevision'] is None
    finally:
        gateway.execution_lock.release()
    rejected = await queued
    assert rejected.value['code'] == 'plan_confirmation_required'
    with pytest.raises(ProjectError) as stale:
        store.claim_plan_execution(project_id, session, task_id, PlanConfirmInput(planRevision=1))
    assert stale.value.code == 'plan_revision_stale'
    assert store.claim_plan_execution(project_id, session, task_id, PlanConfirmInput(planRevision=2))['state'] == 'claimed'
    assert store.claim_plan_execution(project_id, session, task_id, PlanConfirmInput(planRevision=2))['state'] == 'already_executing'
    assert not projects.snapshot(project_id).assets
    await gateway.close()


def test_disk_recovery_after_one_of_two_writes_commits(tmp_path, draft_plan):
    from opendirector.domain.creation.base import agent_command_id
    from opendirector.domain.creation.commands import command_fingerprint

    projects, tools, project_id, task_id, session = draft_plan(('Write A', 'Write B'))
    store = tools.decisions
    conversation_id = uuid5(project_id, 'assistant')
    turn_id = claim_execution(store, project_id, task_id, session)
    task = store.get_task(project_id, task_id)
    call_id = f"cli:{step_operation_id(task, task['plan']['steps'][0])}"
    command_id = agent_command_id(turn_id, call_id)
    command = parse_command({
        'type': 'asset.writeText', 'projectId': project_id, 'commandId': command_id,
        'payload': {'name': 'a.md', 'text': 'Deliverable A'},
    })
    store.record_pending_write(
        project_id, turn_id, call_id, command.model_dump(mode='json'), command_fingerprint(command), session=session,
    )
    store.begin_pending_write(project_id, turn_id, str(command_id), session)
    receipt = projects.execute(command, session=session, source='agent')
    assert receipt.status == 'applied'

    restarted = CreationProjects(LocalProjects(tmp_path))
    restored = DecisionStore(restarted).public_state(project_id, conversation_id)['tasks'][0]
    assert restored['stage'] == 'status_unknown'
    assert [step['status'] for step in restored['plan']['steps']] == ['completed', 'pending']
    assert restored['pendingWrites'] == []
    assert [record['commandId'] for record in restored['acceptedReceipts']] == [str(command_id)]
    assert restarted.receipt(project_id, command_id) == receipt
    assert [asset.name for asset in restarted.snapshot(project_id).assets] == ['a.md']


@pytest.mark.anyio
async def test_gateway_rechecks_stage_for_queued_writes_and_planning_boundary(tmp_path, project, monkeypatch):
    projects, pid, session = project
    business = AgentTools(projects, None, ModelConfigs(tmp_path))
    tid, cid = uuid4(), uuid4()
    business.decisions.begin_task(
        pid, cid, tid, mode='ask', runtime='default', referenced_asset_ids=[]
    )
    run = RunContext(
        runtime='default',
        project_id=pid,
        turn_id=tid,
        session=session,
        directory=tmp_path,
        config=None,
        messages=[],
        selected_skills=[],
        mode='ask',
        task_id=tid,
        task_stage='planning',
    )
    gateway = ToolGateway(business, run)

    blocked_write = await gateway.call(
        'write-during-plan',
        'execute_command',
        {'type': 'asset.writeText', 'payload': {'name': 'blocked.md', 'text': 'should not write'}},
    )
    assert blocked_write.error is not None
    assert blocked_write.value.get('code') == 'plan_confirmation_required'
    assert len(projects.snapshot(pid).assets) == 0

    entered_ask = asyncio.Event()
    release_ask = asyncio.Event()
    execute = business.execute

    async def hold_question(project_id, turn_id, session_id, call_id, name, arguments, *rest):
        if name == 'ask_user':
            entered_ask.set()
            await release_ask.wait()
        return await execute(project_id, turn_id, session_id, call_id, name, arguments, *rest)

    monkeypatch.setattr(business, 'execute', hold_question)
    ask_task = asyncio.create_task(gateway.call('call-ask', 'ask_user', {'questions': SAMPLE_QUESTIONS}))
    await entered_ask.wait()
    queued_read = asyncio.create_task(gateway.call('call-after-ask', 'read_project', {}))
    queued_write = asyncio.create_task(
        gateway.call(
            'write-after-ask',
            'execute_command',
            {'type': 'asset.writeText', 'payload': {'name': 'late.md', 'text': 'blocked'}},
        )
    )
    await asyncio.sleep(0.01)
    release_ask.set()
    ask_res, read_res, write_res = await asyncio.gather(ask_task, queued_read, queued_write)
    assert ask_res.error is None
    assert ask_res.value['status'] == 'waiting_input'
    assert read_res.error is not None and read_res.value.get('code') == 'task_waiting_input'
    assert write_res.error is not None and write_res.value.get('code') == 'task_waiting_input'
    assert gateway.attempted_after_waiting.is_set()
    assert len(projects.snapshot(pid).assets) == 0
    await gateway.close()


def test_decisions_replay_conflict_version_invalidation_and_draft_isolation(fake_default_agent):
    with TestClient(create_app(fake_default_agent), headers=session_headers()) as client:
        pid, root = open_project(client, 'Decision Flow')

        # Unsupported runtime for ask mode is rejected explicitly without silent fallback.
        bad_mode = client.post(root + '/assistant/turns', json={
            'id': str(uuid4()),
            'runtime': 'jiuwenswarm',
            'mode': 'ask',
            'text': '帮我做个视频计划',
        })
        assert bad_mode.status_code == 409 and bad_mode.json()['code'] == 'ask_mode_runtime_unsupported'

        # Create a referenced text asset and an unrelated canvas node.
        asset_res = client.post(root + '/commands', json={
            'type': 'asset.writeText',
            'projectId': pid,
            'commandId': str(uuid4()),
            'payload': {'name': 'brief.md', 'text': 'Initial brief'},
        }).json()
        ref_asset_id = asset_res['changed'][0]['id']
        unrelated_item_id = str(uuid4())
        assert client.post(root + '/commands', json={
            'type': 'canvas.show',
            'projectId': pid,
            'commandId': str(uuid4()),
            'payload': {
                'item': {
                    'id': unrelated_item_id,
                    'projectId': pid,
                    'kind': 'text',
                    'title': 'Unrelated note',
                    'position': {'x': 10, 'y': 20},
                    'binding': {'role': 'empty'},
                }
            },
        }).status_code == 200

        conv = ask_turn(client, root, '根据参考定制宣传片方案', assets=[ref_asset_id])
        assert conv['messages'][-1]['status'] == 'complete'
        assert len(conv['decisions']) == 1
        decision = conv['decisions'][0]
        request_id = decision['requestId']
        assert decision['status'] == 'waiting_input'
        assert decision['questions'][0]['options'][0]['label'] == '8 秒'

        # Save a regular chat draft while the question is waiting_input; answering must NOT overwrite it.
        assert client.put(root + '/assistant/draft', json={
            'conversationId': conv['conversationId'],
            'draft': '用户未发送的普通聊天草稿',
            'skills': ['character-replacement'],
            'runtime': 'default',
        }).status_code == 200

        # Dragging an unrelated canvas node does NOT invalidate the question.
        assert client.post(root + '/commands', json={
            'type': 'canvas.move',
            'projectId': pid,
            'commandId': str(uuid4()),
            'payload': {'items': [{'itemId': unrelated_item_id, 'position': {'x': 300, 'y': 400}}]},
            'expectedVersions': [{'objectType': 'canvas_item', 'id': unrelated_item_id, 'revision': 1}],
        }).status_code == 200
        assert read_decision(client, root, request_id)['status'] == 'waiting_input'

        # Validation rejects mixing custom text with selectedOptionIds.
        mixed = client.post(root + f'/assistant/decisions/{request_id}/answers', json={
            'answers': [{'questionId': 'duration', 'source': 'custom', 'selectedOptionIds': ['8s'], 'customText': '12 秒，最后留 3 秒空镜'}]
        })
        assert mixed.status_code == 422

        # Submit custom answer (without selecting any option).
        custom_payload = {
            'answers': [{'questionId': 'duration', 'source': 'custom', 'selectedOptionIds': [], 'customText': '12 秒，最后留 3 秒空镜'}]
        }
        ans1 = client.post(root + f'/assistant/decisions/{request_id}/answers', json=custom_payload)
        assert ans1.status_code == 200, ans1.text
        body1 = ans1.json()
        assert (body1['replayed'], body1['status']) == (False, 'answer_saved')
        assert body1['task']['conversationId'] == body1['decision']['conversationId']
        assert 'conversation' not in body1
        continuation_id = body1['continuationId']

        # Replaying the exact same answer returns the original receipt idempotently.
        ans_replay = client.post(root + f'/assistant/decisions/{request_id}/answers', json=custom_payload)
        assert ans_replay.status_code == 200
        assert (ans_replay.json()['replayed'], ans_replay.json()['continuationId']) == (True, continuation_id)

        # A second tab submitting a different answer gets a 409 conflict and original answer is preserved.
        conflict = client.post(root + f'/assistant/decisions/{request_id}/answers', json={
            'answers': [{'questionId': 'duration', 'source': 'options', 'selectedOptionIds': ['15s']}]
        })
        assert conflict.status_code == 409
        assert read_decision(client, root, request_id)['answers'][0]['customText'] == '12 秒，最后留 3 秒空镜'

        # Ordinary chat draft and skills are still untouched!
        current_conv = client.get(root + '/assistant').json()
        assert current_conv['draft'] == '用户未发送的普通聊天草稿'
        assert current_conv['skills'] == ['character-replacement']


def test_version_invalidation_when_referenced_asset_changes(fake_default_agent):
    with TestClient(create_app(fake_default_agent), headers=session_headers()) as client:
        pid, root = open_project(client, 'Invalidation')
        written = client.post(root + '/commands', json={
            'type': 'asset.writeText',
            'projectId': pid,
            'commandId': str(uuid4()),
            'payload': {'name': 'script.md', 'text': 'v1'},
        }).json()
        asset_id = written['changed'][0]['id']

        conv = ask_turn(client, root, '规划时长', assets=[asset_id])
        request_id = conv['decisions'][0]['requestId']

        # Delete the referenced asset so its version is no longer valid in the project snapshot.
        snapshot = client.get(root).json()
        asset_obj = next(a for a in snapshot['assets'] if a['id'] == asset_id)
        preview = client.post(root + '/asset-delete-preview', json={'assetIds': [asset_id], 'clearHistory': False}).json()
        assert client.post(root + '/commands', json={
            'type': 'asset.delete',
            'projectId': pid,
            'commandId': str(uuid4()),
            'payload': {'assetIds': [asset_id], 'clearHistory': False},
            'expectedVersions': [{'objectType': 'asset', 'id': asset_id, 'revision': asset_obj['revision']}],
            'expectedPreview': preview['fingerprint'],
        }).status_code == 200

        # Submitting an answer now must reject with 409 decision_version_invalidated.
        stale = client.post(root + f'/assistant/decisions/{request_id}/answers', json={
            'answers': [{'questionId': 'duration', 'source': 'options', 'selectedOptionIds': ['8s']}]
        })
        assert stale.status_code == 409
        assert read_decision(client, root, request_id)['status'] == 'invalidated'


def test_fault_injections_restart_after_answer_and_restart_after_business_write(fake_default_agent, monkeypatch):
    """Covers both required fault injections:
    1. Restart after answer saved, before continuation starts -> resumes once, no auto-run on GET.
    2. Restart after business write succeeds, before segment finishes -> recovers from receipt without duplicate write.
    """
    local = fake_default_agent

    continuation_runs = []
    execution_runs = []
    crash_after_write = {'enabled': True}
    record_receipt = DecisionStore.record_accepted_receipt

    def record_or_crash(self, project_id, turn_id, call_id, command, fingerprint, receipt):
        if crash_after_write['enabled'] and command.get('payload', {}).get('name') == 'final-plan.md':
            raise RuntimeError('Simulated interruption after the business commit and before the task receipt')
        return record_receipt(self, project_id, turn_id, call_id, command, fingerprint, receipt)

    monkeypatch.setattr(DecisionStore, 'record_accepted_receipt', record_or_crash)

    async def stream(self, run: RunContext):
        gateway = ToolGateway(self.business, run)
        try:
            if run.task_stage == 'planning':
                yield await ask_event(gateway, 'cli:ask-1', plan='Initial plan before the duration is confirmed.')
                yield {'type': 'delta', 'text': '请选择时长。'}
            elif run.task_stage == 'resuming':
                continuation_runs.append(str(run.turn_id))
                assert '12 秒，最后留 3 秒空镜' in run.messages[-1]['content']
                assert run.messages[-1]['role'] == 'user'
                assert sum('12 秒，最后留 3 秒空镜' in row['content'] for row in run.messages) == 1
                assert any(row['content'] == 'Unrelated answer' for row in run.messages[:-1])
                await gateway.call('plan', 'update_plan', {
                    'summary': '新版计划：总长 12 秒，最后留 3 秒空镜。',
                    'steps': ['制作分镜', '制作旁白'],
                })
                yield {'type': 'delta', 'text': '新版计划：总长 12 秒，最后留 3 秒空镜。'}
            elif run.task_stage == 'executing':
                execution_runs.append(str(run.turn_id))
                task = self.business.decisions.task_for_turn(run.project_id, run.turn_id)
                for step, name in zip(task['plan']['steps'], ['final-plan.md', 'narration.md']):
                    if step['status'] == 'completed':
                        continue
                    outcome = await gateway.call(
                        f'cli:{step_operation_id(task, step)}', 'execute_command',
                        {'type': 'asset.writeText', 'payload': {'name': name, 'text': '12 秒成片，结尾 3 秒空镜'}},
                    )
                    assert outcome.error is None
                yield {'type': 'delta', 'text': '执行完成。'}
            else:
                yield {'type': 'delta', 'text': 'Unrelated answer'}
        finally:
            await gateway.close()

    monkeypatch.setattr(agent.AgentRuntimes, 'stream', stream)
    headers = session_headers()
    turn_id = str(uuid4())

    # Instance 1: ask question and save answer, then shut down before starting continuation.
    with TestClient(create_app(local), headers=headers) as client1:
        _, root = open_project(client1, 'Fault Recovery')
        first = ask_turn(client1, root, '制定宣传片计划', turn_id=turn_id)
        original_conversation = first['conversationId']
        interleaved = frames(client1.post(root + '/assistant/turns', json={
            'id': str(uuid4()), 'conversationId': original_conversation, 'text': 'Unrelated task',
        }))
        assert interleaved[-1]['error'] is None
        ans = submit_answer(client1, root, first['decisions'][0], 'duration', 'custom',
                            selectedOptionIds=[], customText='12 秒，最后留 3 秒空镜')
        continuation_id = ans['continuationId']
        assert ans['status'] == 'answer_saved'
        assert continuation_runs == []
        assert client1.post(root + f'/assistant/tasks/{turn_id}/confirm-plan', json={'planRevision': 1}).status_code == 409
        other = str(uuid4())
        assert client1.post(root + '/assistant/conversations', json={'id': other}).status_code == 200
        stale = client1.post(root + f'/assistant/continuations/{continuation_id}')
        assert stale.status_code == 409 and stale.json()['code'] == 'task_conversation_changed'
        current = client1.get(root + '/assistant').json()
        assert current['conversationId'] == other and current['messages'] == []
        assert client1.post(root + f'/assistant/conversations/{original_conversation}/activate').status_code == 200

    # Fault 1: Server restarted after answer was saved, before continuation started.
    with TestClient(create_app(local), headers=headers) as client2:
        # Read-only GET must NOT trigger a model run; status stays answer_saved ("已回答，待继续").
        loaded = client2.get(root + '/assistant').json()
        assert continuation_runs == []
        assert loaded['decisions'][0]['status'] == 'answer_saved'
        assert loaded['tasks'][0]['stage'] == 'answer_saved'
        # No user chat message was fabricated.
        assert [m['role'] for m in loaded['messages']] == ['user', 'assistant', 'user', 'assistant']

        assert client2.post(root + '/open').status_code == 200
        continuation_url = root + f'/assistant/continuations/{continuation_id}'
        with monkeypatch.context() as unavailable:
            unavailable.setattr(agent, 'runtime_available', lambda _: False)
            rejected = client2.post(continuation_url, headers={'Accept-Language': 'en-US'})
            assert rejected.status_code == 503
        failed = client2.get(root + '/assistant').json()['decisions'][0]
        assert (failed['status'], failed['errorCode']) == ('resume_failed', 'continuation_resume_failed')
        assert continuation_runs == []
        cont_resp = client2.post(continuation_url)
        assert cont_resp.status_code == 200
        cont_events = frames(cont_resp)
        assert cont_events[-1]['error'] is None
        assert len(continuation_runs) == 1

        # Re-calling the same continuation after completion does NOT run the model a second time.
        cont_again = frames(client2.post(root + f'/assistant/continuations/{continuation_id}'))
        assert cont_again[-1]['error'] is None
        assert len(continuation_runs) == 1

        conv_after_plan = cont_again[-1]['conversation']
        task_state = conv_after_plan['tasks'][0]
        assert task_state['stage'] == 'waiting_confirmation'
        assert task_state['planRevision'] == 2
        assert '12 秒' in task_state['plan']['summary'] and '3 秒空镜' in task_state['plan']['summary']
        # Still zero business assets created before confirmation!
        assert len(client2.get(root).json()['assets']) == 0
        # Still no fabricated user message!
        assert [m['role'] for m in conv_after_plan['messages']] == ['user', 'assistant', 'user', 'assistant', 'assistant']

        # Stale plan revision confirmation is rejected.
        stale_confirm = client2.post(root + f'/assistant/tasks/{turn_id}/confirm-plan', json={'planRevision': 99})
        assert stale_confirm.status_code == 409
        with monkeypatch.context() as unavailable:
            unavailable.setattr(agent, 'runtime_available', lambda _: False)
            unavailable_confirm = client2.post(root + f'/assistant/tasks/{turn_id}/confirm-plan', json={'planRevision': 2})
            assert unavailable_confirm.status_code == 503
        still_ready = client2.get(root + '/assistant').json()['tasks'][0]
        assert still_ready['stage'] == 'waiting_confirmation' and still_ready['confirmedPlanRevision'] is None

        # Fault 2: The first write commits before the task records its receipt.
        exec_resp = client2.post(root + f'/assistant/tasks/{turn_id}/confirm-plan', json={'planRevision': 2})
        assert exec_resp.status_code == 200
        assert len(execution_runs) == 1
        assert len(client2.get(root).json()['assets']) == 1

    # Simulate server restart after the crash and recover/retry confirm-plan.
    crash_after_write['enabled'] = False
    with TestClient(create_app(local), headers=headers) as client3:
        assert client3.post(root + '/open').status_code == 200
        recovered = client3.get(root + '/assistant').json()['tasks'][0]
        assert recovered['stage'] == 'status_unknown'
        assert [step['status'] for step in recovered['plan']['steps']] == ['completed', 'pending']
        assert client3.post(root + f'/assistant/tasks/{turn_id}/confirm-plan', json={'planRevision': 2}).status_code == 409
        assert len(execution_runs) == 1
        assets = client3.get(root).json()['assets']
        assert len(assets) == 1
        assert assets[0]['name'] == 'final-plan.md'
        adjustment = client3.post(root + f'/assistant/tasks/{turn_id}/adjust-plan', json={'planRevision': 2}).json()
        assert set(adjustment) == {'task'}
        adjusted = adjustment['task']
        assert adjusted['planRevision'] == 3
        finished = frames(client3.post(root + f'/assistant/tasks/{turn_id}/confirm-plan', json={'planRevision': 3}))
        assert finished[-1]['conversation']['tasks'][0]['stage'] == 'completed'
        delivered = client3.get(root).json()['assets']
        assert sorted(asset['name'] for asset in delivered) == ['final-plan.md', 'narration.md']
        assert next(asset for asset in delivered if asset['name'] == 'final-plan.md') == assets[0]


def test_session_id_without_completion_event_is_not_reused_and_codex_fallback_preserves_answer(tmp_path, monkeypatch):
    local = LocalProjects(tmp_path)
    monkeypatch.setattr(agent, 'runtime_available', lambda _: True)
    monkeypatch.setattr(agent, 'skills', empty_skills)
    monkeypatch.setattr(native, 'executable', lambda _: sys.executable)

    # 1. Verify that emitting only thread.started (session ID captured) without a completion event
    # does NOT save a reusable native session.
    incomplete_script = tmp_path / 'incomplete_codex.py'
    incomplete_script.write_text(
        'import json, sys\n'
        'sys.stdin.read()\n'
        'print(json.dumps({"type": "thread.started", "thread_id": "incomplete-thread"}), flush=True)\n'
    )
    project_dir = tmp_path / 'session-check'
    project_dir.mkdir()
    run1 = RunContext(
        runtime='codex',
        project_id=uuid4(),
        turn_id=uuid4(),
        session=str(uuid4()),
        conversation_id=uuid4(),
        directory=project_dir,
        config=None,
        messages=[{'role': 'user', 'content': 'hello'}],
        selected_skills=[],
    )
    monkeypatch.setattr(
        native,
        'command',
        lambda kind, work, socket, token, model, model_url, catalog, **kw: (
            [sys.executable, str(incomplete_script)],
            {'PWD': str(work), **(kw.get('bridge_env') or {'OPENDIRECTOR_AGENT_SOCKET': socket})},
        ),
    )
    projects = CreationProjects(local)
    business = AgentTools(projects, None, ModelConfigs(tmp_path))

    async def run_incomplete():
        gw = ToolGateway(business, run1)
        _ = [ev async for ev in native.NativeRuntime().stream(run1, gw)]
        await gw.close()

    asyncio.run(run_incomplete())
    assert run1.native_session_id({'model': None, 'thinking': 'auto'}) is None

    # 2. Full CLI + Codex continuation when native session cannot be reused (codex_session_available = False).
    codex_script = tmp_path / 'fake_codex_ask.py'
    codex_script.write_text(
        'import json, os, subprocess, sys\n'
        'from pathlib import Path\n'
        'prompt = sys.stdin.read()\n'
        'cli = [sys.executable, "-m", "opendirector.cli"]\n'
        'work = Path(prompt.split("Execution directory: ", 1)[1].split(chr(10), 1)[0])\n'
        'if "plan_execution_confirmation" in prompt:\n'
        '    assert "12 秒，最后留 3 秒空镜" in prompt\n'
        '    op = "00000000-0000-0000-0000-000000000099"\n'
        '    res = json.loads(subprocess.check_output([*cli, "--operation-id", op, "asset", "write-text", "--name", "codex-plan.md", "--text", "12 秒成片，最后留 3 秒空镜"], text=True))\n'
        '    assert res["status"] == "applied"\n'
        '    print(json.dumps({"type": "thread.started", "thread_id": "codex-thread-3"}), flush=True)\n'
        '    print(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "已按确认计划生成文本产物。"}}), flush=True)\n'
        'elif "ask_user_answer_continuation" in prompt:\n'
        '    assert "resume" not in sys.argv, "Should use checkpoint fallback when codex session is unavailable"\n'
        '    assert "12 秒，最后留 3 秒空镜" in prompt\n'
        '    plan_file = work / "updated_plan.json"\n'
        '    plan_file.write_bytes("\\ufeff".encode("utf-8") + json.dumps({"summary": "Codex 12 秒方案，结尾保留 3 秒空镜", "steps": ["前 9 秒主镜头", "最后 3 秒空镜"]}, ensure_ascii=False).encode("utf-8"))\n'
        '    saved = json.loads(subprocess.check_output([*cli, "plan", "save", "--file", str(plan_file)], text=True))\n'
        '    assert saved["status"] == "waiting_confirmation"\n'
        '    print(json.dumps({"type": "thread.started", "thread_id": "codex-thread-2"}), flush=True)\n'
        '    print(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "已按 12 秒及最后 3 秒空镜更新计划。"}}), flush=True)\n'
        'else:\n'
        '    q_file = work / "questions.json"\n'
        '    q_file.write_bytes("\\ufeff".encode("utf-8") + json.dumps({"questions": [{"id": "duration", "question": "请选择成片时长", "options": [{"id": "8s", "label": "8 秒", "impact": "标准节奏"}, {"id": "5s", "label": "5 秒", "impact": "快节奏"}, {"id": "15s", "label": "15 秒", "impact": "舒缓叙事"}]}]}, ensure_ascii=False).encode("utf-8"))\n'
        '    asked = json.loads(subprocess.check_output([*cli, "ask-user", "--file", str(q_file)], text=True))\n'
        '    assert asked["status"] == "waiting_input"\n'
        '    print(json.dumps({"type": "thread.started", "thread_id": "codex-thread-1"}), flush=True)\n'
        '    print(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "请确认视频成片时长。"}}), flush=True)\n'
    )

    monkeypatch.setattr(native, 'codex_session_available', lambda _: False)
    monkeypatch.setattr(
        native,
        'command',
        lambda kind, work, socket, token, model, model_url, catalog, **kw: (
            [sys.executable, str(codex_script), *(['resume', 'test-session', '-'] if kw.get('session_id') else [])],
            cli_environment(work, socket, kw.get('bridge_env')),
        ),
    )

    with TestClient(create_app(local), headers=session_headers()) as client:
        _, root = open_project(client, 'Codex Fallback')

        tid = str(uuid4())
        conv = ask_turn(client, root, '规划宣传片', turn_id=tid, runtime='codex', runtimeModel='gpt-5-codex')
        dec = conv['decisions'][0]
        assert dec['status'] == 'waiting_input'

        ans = submit_answer(client, root, dec, 'duration', 'custom', selectedOptionIds=[], customText='12 秒，最后留 3 秒空镜')
        cid = ans['continuationId']

        ev2 = frames(client.post(root + f'/assistant/continuations/{cid}'))
        assert ev2[-1]['error'] is None
        task = ev2[-1]['conversation']['tasks'][0]
        assert task['stage'] == 'waiting_confirmation'
        assert '12 秒' in task['plan']['summary'] and '3 秒空镜' in task['plan']['summary']
        assert len(client.get(root).json()['assets']) == 0

        ev3 = frames(client.post(root + f'/assistant/tasks/{tid}/confirm-plan', json={'planRevision': task['planRevision']}))
        assert ev3[-1]['error'] is None
        assets = client.get(root).json()['assets']
        assert len(assets) == 1
        assert assets[0]['name'] == 'codex-plan.md'


@pytest.mark.parametrize('runtime', ['opencode', 'claude'])
def test_opencode_and_claude_ask_cli_pause_resume_and_execute_after_confirmation(configured_agent, tmp_path, monkeypatch, runtime):
    monkeypatch.setattr(native, 'executable', lambda _: sys.executable)
    script = tmp_path / 'fake_native_harness_ask.py'
    script.write_text(
        'import json, subprocess, sys\n'
        'from pathlib import Path\n'
        'prompt = sys.stdin.read()\n'
        'runtime = sys.argv[1]\n'
        'resume_flag = "--session" if runtime == "opencode" else "--resume"\n'
        'cli = [sys.executable, "-m", "opendirector.cli"]\n'
        'work = Path(prompt.split("Execution directory: ", 1)[1].split(chr(10), 1)[0])\n'
        'def emit(text):\n'
        '    if runtime == "opencode":\n'
        '        events = [{"type": "text", "sessionID": "native-ask", "part": {"text": text}},\n'
        '                  {"type": "step_finish", "sessionID": "native-ask", "part": {"reason": "stop"}}]\n'
        '    else:\n'
        '        events = [{"type": "assistant", "session_id": "native-ask", "message": {"content": [{"type": "text", "text": text}]}},\n'
        '                  {"type": "result", "session_id": "native-ask", "is_error": False}]\n'
        '    for event in events: print(json.dumps(event), flush=True)\n'
        'if "plan_execution_confirmation" in prompt:\n'
        '    assert sys.argv[2:4] == [resume_flag, "native-ask"]\n'
        '    context = json.loads(prompt.strip().splitlines()[-1])\n'
        '    checkpoint, _ = json.JSONDecoder().raw_decode(context[-1]["content"].split("\\n", 1)[1])\n'
        '    op = next(iter(checkpoint["stepOperationIds"].values()))\n'
        '    res = json.loads(subprocess.check_output([*cli, "--operation-id", op, "asset", "write-text", "--name", f"{runtime}-plan.md", "--text", "12 秒成片，最后留 3 秒空镜"], text=True))\n'
        '    assert res["status"] == "applied"\n'
        '    emit("已按确认计划生成文本产物。")\n'
        'elif "ask_user_answer_continuation" in prompt:\n'
        '    assert sys.argv[2:4] == [resume_flag, "native-ask"]\n'
        '    assert "12 秒，最后留 3 秒空镜" in prompt\n'
        '    plan_file = work / "updated_plan.json"\n'
        '    plan_file.write_text(json.dumps({"summary": "12 秒，最后留 3 秒空镜", "steps": ["写入方案"]}, ensure_ascii=False), encoding="utf-8-sig")\n'
        '    saved = json.loads(subprocess.check_output([*cli, "plan", "save", "--file", str(plan_file)], text=True))\n'
        '    assert saved["status"] == "waiting_confirmation"\n'
        '    emit("已按 12 秒及最后 3 秒空镜更新计划。")\n'
        'else:\n'
        '    assert resume_flag not in sys.argv\n'
        '    assert "Mandatory Interactive Clarification Stage" in prompt\n'
        '    q_file = work / "questions.json"\n'
        '    q_file.write_text(json.dumps({"questions": [{"id": "duration", "question": "请选择成片时长", "options": [{"id": "8s", "label": "8 秒", "impact": "标准节奏"}, {"id": "5s", "label": "5 秒", "impact": "快节奏"}]}]}, ensure_ascii=False), encoding="utf-8")\n'
        '    asked = json.loads(subprocess.check_output([*cli, "ask-user", "--file", str(q_file)], text=True))\n'
        '    assert asked["status"] == "waiting_input"\n'
        '    emit("请确认视频成片时长。")\n',
        encoding='utf-8',
    )
    monkeypatch.setattr(
        native,
        'command',
        lambda kind, work, socket, token, model, model_url, catalog, **kw: (
            [sys.executable, '-X', 'utf8', str(script), kind],
            cli_environment(work, socket, kw.get('bridge_env')),
        ),
    )

    with TestClient(create_app(configured_agent), headers=session_headers()) as client:
        _, root = open_project(client, f'{runtime} Ask')
        tid = str(uuid4())
        conv = ask_turn(client, root, '规划宣传片', turn_id=tid, runtime=runtime, runtimeModel='test-model')
        dec = conv['decisions'][0]
        assert dec['status'] == 'waiting_input'
        assert not client.get(root).json()['assets']

        ans = submit_answer(client, root, dec, 'duration', 'custom', selectedOptionIds=[], customText='12 秒，最后留 3 秒空镜')
        ev2 = frames(client.post(root + f'/assistant/continuations/{ans["continuationId"]}'))
        assert ev2[-1]['error'] is None
        task = ev2[-1]['conversation']['tasks'][0]
        assert task['stage'] == 'waiting_confirmation'
        assert not client.get(root).json()['assets']

        ev3 = frames(client.post(root + f'/assistant/tasks/{tid}/confirm-plan', json={'planRevision': task['planRevision']}))
        assert ev3[-1]['error'] is None
        assert ev3[-1]['conversation']['tasks'][0]['stage'] == 'completed'
        assets = client.get(root).json()['assets']
        assert [a['name'] for a in assets] == [f'{runtime}-plan.md']


def test_followup_ask_turn_continues_existing_plan_into_revision_v2(fake_default_agent, monkeypatch):
    from opendirector.agent.tools import build_ask_mode_guidance

    observed_plans = []
    continuation_messages = []

    async def followup_stream(self, run: RunContext):
        gateway = ToolGateway(self.business, run)
        try:
            if run.task_stage == 'planning':
                observed_plans.append((str(run.task_id), run.current_plan))
                if run.current_plan is None:
                    yield await ask_event(gateway, 'cli:ask-world')
                    yield {'type': 'delta', 'text': '请先选择核心方向。'}
                elif '改为三位主角' in run.messages[-1]['content']:
                    yield {'type': 'delta', 'text': '明白，我会修改人物安排。'}
                elif '沿用原版方案' in run.messages[-1]['content']:
                    await gateway.call('save-existing-plan', 'update_plan', {
                        'summary': run.current_plan['summary'],
                        'steps': [step['content'] for step in run.current_plan['steps']],
                    })
                    yield {'type': 'delta', 'text': '已保存方案，可重新确认。'}
                else:
                    guidance = build_ask_mode_guidance(run.current_plan)
                    assert 'Active unconfirmed plan in this conversation' in guidance
                    assert '遗潮纪 v1' in guidance
                    yield await ask_event(gateway, 'cli:ask-cast', [{
                        'id': 'cast_arc',
                        'question': '男女主角的关系张力采用哪种方向？',
                        'options': [
                            {'id': 'rivals', 'label': '各怀秘密的搭档', 'impact': '领潮人与公会抄录员围绕同一本名册试探与合作。'},
                            {'id': 'mentor', 'label': '师徒传承', 'impact': '围绕航道歌失传展开。'},
                        ],
                    }])
                    yield {'type': 'delta', 'text': '请选择男女主角的关系张力方向。'}
            elif run.task_stage == 'resuming':
                continuation_messages.append(run.messages[-1]['content'])
                rev = (run.current_plan or {}).get('revision') or 0
                summary = '遗潮纪 v1：潮水归还失城' if rev == 0 else '遗潮纪 v2：潮水归还失城 + 各怀秘密的双主角'
                await gateway.call(f'plan-{rev + 1}', 'update_plan', {
                    'summary': summary,
                    'steps': ['确立规则', '双主角冲突'] if rev >= 1 else ['确立规则'],
                })
                yield {'type': 'delta', 'text': summary}
        finally:
            await gateway.close()

    monkeypatch.setattr(agent.AgentRuntimes, 'stream', followup_stream)
    with TestClient(create_app(fake_default_agent), headers=session_headers()) as client:
        _, root = open_project(client, 'Follow-up Ask')
        t1 = str(uuid4())
        conv = ask_turn(client, root, '给出一个异世界世界观', turn_id=t1)
        ans1 = submit_answer(client, root, conv['decisions'][0], 'duration', 'options', selectedOptionIds=['8s'])
        frames(client.post(root + f"/assistant/continuations/{ans1['continuationId']}"))
        conv1 = client.get(root + '/assistant').json()
        assert len(conv1['tasks']) == 1
        assert conv1['tasks'][0]['taskId'] == t1
        assert conv1['tasks'][0]['planRevision'] == 1
        assert conv1['tasks'][0]['stage'] == 'waiting_confirmation'

        # Follow-up Ask turn on top of Plan v1 must continue the same task, receive Plan v1, and ask a new question.
        t2 = str(uuid4())
        conv2 = ask_turn(client, root, '丰富一下男女主角人设', turn_id=t2)
        assert observed_plans[-1][0] == t1
        assert observed_plans[-1][1]['revision'] == 1
        assert len(conv2['tasks']) == 1
        assert conv2['tasks'][0]['stage'] == 'waiting_input'
        dec2 = next(d for d in conv2['decisions'] if d['turnId'] == t2)
        assert dec2['taskId'] == t1
        assert dec2['status'] == 'waiting_input'

        ans2 = submit_answer(client, root, dec2, 'cast_arc', 'options', selectedOptionIds=['rivals'])
        frames(client.post(root + f"/assistant/continuations/{ans2['continuationId']}"))
        assert 'Latest user refinement request for this decision:\n丰富一下男女主角人设' in continuation_messages[-1]
        conv3 = client.get(root + '/assistant').json()
        assert len(conv3['tasks']) == 1
        assert conv3['tasks'][0]['planRevision'] == 2
        assert '双主角' in conv3['tasks'][0]['plan']['summary']

        ask_turn(client, root, '把新版计划改为三位主角')
        conv4 = client.get(root + '/assistant').json()
        assert conv4['tasks'][0]['plan'] == conv3['tasks'][0]['plan']
        assert conv4['tasks'][0]['stage'] == 'planning'
        confirm_url = root + f'/assistant/tasks/{t1}/confirm-plan'
        blocked = client.post(confirm_url, json={'planRevision': 2})
        assert blocked.status_code == 409 and blocked.json()['code'] == 'plan_confirmation_required'

        t4 = str(uuid4())
        tasks = ask_turn(client, root, '沿用原版方案，请重新保存', turn_id=t4)['tasks']
        assert len(tasks) == 1 and tasks[0]['taskId'] == t1
        assert tasks[0]['stage'] == 'waiting_confirmation'
        assert tasks[0]['planRevision'] == 3
        assert tasks[0]['plan']['updatedAtTurnId'] == t4
        assert tasks[0]['plan']['steps'] == conv3['tasks'][0]['plan']['steps']
        stale = client.post(confirm_url, json={'planRevision': 2})
        assert stale.status_code == 409 and stale.json()['code'] == 'plan_revision_stale'


def test_duplicate_turn_request_does_not_interrupt_confirmable_plan(fake_default_agent, monkeypatch):
    async def stream(runtimes, run):
        gateway = ToolGateway(runtimes.business, run)
        try:
            if run.task_stage == 'planning':
                yield await ask_event(gateway, 'cli:ask-1')
            elif run.task_stage == 'resuming':
                saved = await gateway.call('cli:plan-1', 'update_plan', {
                    'summary': '8 秒紧凑方案', 'steps': ['写出分镜稿'],
                })
                assert saved.error is None
                yield {'type': 'task', 'task': saved.value['task']}
                yield {'type': 'delta', 'text': '已保存计划 v1。'}
            elif run.task_stage == 'executing':
                step_op = step_operation_id(
                    {'taskId': str(run.task_id), 'planRevision': 1},
                    run.current_plan['steps'][0],
                )
                wrote = await gateway.call(f'cli:{step_op}', 'execute_command', {
                    'type': 'asset.writeText', 'payload': {'name': 'shot.md', 'text': '8 秒分镜'},
                })
                assert wrote.error is None
                yield {'type': 'delta', 'text': '执行完毕。'}
        finally:
            await gateway.close()

    monkeypatch.setattr(agent.AgentRuntimes, 'stream', stream)
    with TestClient(create_app(fake_default_agent), headers=session_headers()) as client:
        _, root = open_project(client, 'Duplicate Turn Guard')
        tid = str(uuid4())
        conv = ask_turn(client, root, '规划一段短片', turn_id=tid)
        ans = submit_answer(client, root, conv['decisions'][0], 'duration', 'options', selectedOptionIds=['8s'])
        frames(client.post(root + f"/assistant/continuations/{ans['continuationId']}"))
        before = client.get(root + '/assistant').json()['tasks'][0]
        assert before['stage'] == 'waiting_confirmation' and before['planRevision'] == 1

        # Replaying the original /turns request with the same ID must reject without interrupting Plan v1.
        dup_events = frames(client.post(root + '/assistant/turns', json={
            'id': tid, 'runtime': 'default', 'mode': 'ask', 'text': '规划一段短片',
        }))
        assert dup_events[-1]['error'] is not None
        after_dup = client.get(root + '/assistant').json()['tasks'][0]
        assert after_dup['stage'] == 'waiting_confirmation' and after_dup['planRevision'] == 1

        exec_events = frames(client.post(root + f'/assistant/tasks/{tid}/confirm-plan', json={'planRevision': 1}))
        assert exec_events[-1]['error'] is None
        assert exec_events[-1]['conversation']['tasks'][0]['stage'] == 'completed'


def test_default_runtime_can_retry_prose_only_continuation_and_pre_spawn_failure(configured_agent, tmp_path, monkeypatch):
    monkeypatch.setattr(native, 'executable', lambda _: sys.executable)

    attempt = {'continuation': 0}
    seen_work_dirs: list[str] = []
    opencode_script = tmp_path / 'fake_default_opencode.py'
    opencode_script.write_text(
        'import json, os, subprocess, sys\n'
        'from pathlib import Path\n'
        'prompt = sys.stdin.read()\n'
        'cli = [sys.executable, "-m", "opendirector.cli"]\n'
        'work = Path(prompt.split("Execution directory: ", 1)[1].split(chr(10), 1)[0])\n'
        'if os.environ["FAKE_RUNTIME"] == "codex":\n'
        '    assert "Interleaved ordinary question" in prompt\n'
        '    print(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "Interleaved ordinary reply"}}), flush=True)\n'
        '    print(json.dumps({"type": "turn.completed"}), flush=True)\n'
        'elif "ask_user_answer_continuation" in prompt:\n'
        '    mode = os.environ.get("FAKE_CONT_MODE", "prose")\n'
        '    if mode == "save_plan":\n'
        '        assert "Interleaved ordinary reply" in prompt and "(empty reply)" not in prompt\n'
        '        saved = json.loads(subprocess.check_output([*cli, "plan", "save", "--summary", "重试后保存的 8 秒方案", "--step", "整理镜头"], text=True))\n'
        '        assert saved["status"] == "waiting_confirmation"\n'
        '    print(json.dumps({"type": "text", "sessionID": "oc-sess-1", "part": {"text": "口头说明方案。"}}), flush=True)\n'
        '    print(json.dumps({"type": "step_finish", "sessionID": "oc-sess-1", "part": {"reason": "stop"}}), flush=True)\n'
        'else:\n'
        '    q_file = work / "q.json"\n'
        '    q_file.write_text(json.dumps({"questions": [{"id": "duration", "question": "选择时长", "options": [{"id": "8s", "label": "8 秒", "impact": "紧凑"}]}]}, ensure_ascii=False), encoding="utf-8")\n'
        '    subprocess.check_output([*cli, "ask-user", "--file", str(q_file)], text=True)\n'
        '    print(json.dumps({"type": "text", "sessionID": "oc-sess-1", "part": {"text": "请确认时长。"}}), flush=True)\n'
        '    print(json.dumps({"type": "step_finish", "sessionID": "oc-sess-1", "part": {"reason": "stop"}}), flush=True)\n',
        encoding='utf-8',
    )

    def fake_command(kind, work, socket, token, model, model_url, catalog, **kw):
        cont_mode = 'prose'
        if kind == 'default':
            seen_work_dirs.append(str(work))
        if kind == 'default' and len(seen_work_dirs) >= 2:
            attempt['continuation'] += 1
            if attempt['continuation'] == 2:
                raise OSError('Simulated runtime launch failure before model dispatch')
            if attempt['continuation'] >= 3:
                cont_mode = 'save_plan'
        return (
            [sys.executable, str(opencode_script)],
            {
                **cli_environment(work, socket, kw.get('bridge_env')),
                'FAKE_RUNTIME': kind,
                'FAKE_CONT_MODE': cont_mode,
            },
        )

    monkeypatch.setattr(native, 'command', fake_command)
    with TestClient(create_app(configured_agent), headers=session_headers()) as client:
        _, root = open_project(client, 'Default Continuation Retry')
        conv = ask_turn(client, root, '规划短片')
        ans = submit_answer(client, root, conv['decisions'][0], 'duration', 'options', selectedOptionIds=['8s'])
        cid = ans['continuationId']

        # Attempt 1: prose-only reply without saving plan -> resume_failed.
        ev_prose = frames(client.post(root + f'/assistant/continuations/{cid}'))
        dec_after_prose = ev_prose[-1]['conversation']['decisions'][0]
        assert dec_after_prose['status'] == 'resume_failed'
        assert dec_after_prose['errorCode'] == 'continuation_plan_missing'

        ordinary = frames(client.post(root + '/assistant/turns', json={
            'id': str(uuid4()), 'runtime': 'codex', 'runtimeModel': 'fixture',
            'text': 'Interleaved ordinary question',
        }))
        assert ordinary[-1]['conversation']['messages'][-1]['text'] == 'Interleaved ordinary reply'

        # Attempt 2: fails before process spawn -> must stay retryable (resume_failed / answer_saved), not status_unknown.
        ev_fail = frames(client.post(root + f'/assistant/continuations/{cid}'))
        assert ev_fail[-1]['error'] is not None
        conv_after_fail = client.get(root + '/assistant').json()
        assert conv_after_fail['decisions'][0]['status'] == 'resume_failed'
        assert conv_after_fail['tasks'][0]['stage'] == 'answer_saved'

        # Attempt 3: allocates a fresh workspace directory without FileExistsError and saves Plan v1.
        ev_ok = frames(client.post(root + f'/assistant/continuations/{cid}'))
        assert ev_ok[-1]['error'] is None
        task_ok = ev_ok[-1]['conversation']['tasks'][0]
        assert task_ok['stage'] == 'waiting_confirmation' and task_ok['planRevision'] == 1
        assert len(set(seen_work_dirs[1:])) == len(seen_work_dirs[1:])


@pytest.mark.anyio
async def test_missing_artifact_file_is_retryable_with_same_operation_id_and_allows_adjustment(tmp_path, draft_plan):
    projects, business, project_id, task_id, session = draft_plan(steps=('Publish rendered artifact',))
    store = business.decisions
    turn_id = claim_execution(store, project_id, task_id, session)
    work = tmp_path / 'exec-work'
    work.mkdir()

    @asynccontextmanager
    async def publish_gateway(turn):
        task = store.get_task(project_id, task_id)
        gateway = ToolGateway(business, RunContext(
            runtime='codex', project_id=project_id, turn_id=turn, session=session, directory=tmp_path,
            config=None, messages=[], selected_skills=[], mode='ask', task_id=task_id, task_stage='executing',
        ))
        gateway.execution_directory = work
        try:
            yield gateway, f"cli:{step_operation_id(task, task['plan']['steps'][0])}"
        finally:
            await gateway.close()

    publish_args = {
        'type': 'artifact.publish',
        'payload': {'name': 'deliverable.txt', 'path': 'deliverable.txt', 'expectedKind': 'text', 'sources': []},
    }
    async with publish_gateway(turn_id) as (gateway, call_id):
        # Missing input fails before dispatch; the operation remains retryable.
        missing = await gateway.call(call_id, 'execute_command', publish_args)
        assert missing.error is not None and missing.retryable is True
        after_missing = store.get_task(project_id, task_id)
        assert after_missing['pendingWrites'] == []

        # Conflicting input with the same call_id is still rejected.
        conflict = await gateway.call(call_id, 'execute_command', {
            'type': 'artifact.publish',
            'payload': {'name': 'other.txt', 'path': 'other.txt', 'expectedKind': 'text', 'sources': []},
        })
        assert '不同输入' in (conflict.error or '')

        # Reconciling after a simulated restart does not block adjust_plan.
        restarted_store = DecisionStore(CreationProjects(LocalProjects(tmp_path)))
        reconciled = restarted_store.public_state(project_id, uuid5(project_id, 'assistant'))['tasks'][0]
        assert reconciled['stage'] == 'execution_failed' and reconciled['pendingWrites'] == []
        assert not projects.snapshot(project_id).assets

    # Retry the adjusted step within one turn, using the same operation ID.
    adjusted = store.adjust_plan(project_id, session, task_id, PlanAdjustInput(planRevision=1))
    assert adjusted['planRevision'] == 2 and adjusted['stage'] == 'waiting_confirmation'
    turn_v2 = claim_execution(store, project_id, task_id, session, revision=2)
    async with publish_gateway(turn_v2) as (gateway, call_id):
        fail_first = await gateway.call(call_id, 'execute_command', publish_args)
        assert fail_first.error is not None and fail_first.retryable is True
        (work / 'deliverable.txt').write_text('Final script content', encoding='utf-8')
        retried = await gateway.call(call_id, 'execute_command', publish_args)
        assert retried.error is None and retried.value['status'] == 'applied'
        done = store.finalize_segment(project_id, turn_v2, reply_text='Published.', segment_status='complete')
        assert done['stage'] == 'completed'
        assert [a.name for a in projects.snapshot(project_id).assets] == ['deliverable.txt']


def test_plan_with_read_and_inspection_steps_reaches_completed_and_voice_step_replays(tmp_path, draft_plan, monkeypatch):
    from typer.testing import CliRunner
    from opendirector import cli
    from opendirector.application.voice_library import VoiceLibrary

    projects, business, project_id, task_id, session = draft_plan(
        steps=(
            {'content': 'Read current project state', 'kind': 'read'},
            {'content': 'Inspect local storyboard notes', 'kind': 'inspection'},
            'Upload custom voice',
        ),
    )
    voice_model = ModelConfigs(tmp_path).save(
        'audio', 'http://voice.test/v1', 'Drama3', '',
        connection_type='self_hosted', protocol='openai', auth_mode='none',
    )['id']
    voice_calls = []

    def fake_voice_create(self, model_id, data, **kwargs):
        kwargs['before_submit']()
        voice_calls.append((model_id, data, kwargs['name']))
        return {'voiceId': 'voice-step-3', 'connectionId': kwargs['connection_id']}

    monkeypatch.setattr(VoiceLibrary, 'create', fake_voice_create)
    monkeypatch.setattr(VoiceLibrary, '_config', lambda self, mid: ({'id': mid}, {'maxBytes': 1024 * 1024}))

    store = business.decisions
    turn_id = claim_execution(store, project_id, task_id, session)
    task = store.get_task(project_id, task_id)
    read_op, inspect_op, voice_op = (str(step_operation_id(task, step)) for step in task['plan']['steps'])

    work = tmp_path / 'voice-work'
    work.mkdir(parents=True)
    sample = work / 'sample.wav'
    sample.write_bytes(b'RIFFfakewav')

    monkeypatch.setenv('OPENDIRECTOR_AGENT_SOCKET', 'in-process-bridge')

    def bridge_call(self, name, arguments, *, identity=None):
        call_key = f'cli:{identity or uuid4()}'
        return asyncio.run(business.execute(
            project_id, turn_id, session, call_key, name, arguments,
            roots=[], config=None, native_runtime='codex', execution_directory=work,
        ))

    def run_cli(*args):
        runner = CliRunner()
        res = runner.invoke(cli.app, ['--project', str(project_id), *args])
        assert res.exit_code == 0, (res.output, res.exception)
        return json.loads(res.output)

    monkeypatch.setattr(cli.Client, 'call', bridge_call)
    run_cli('--operation-id', read_op, 'project', 'show')
    run_cli('--operation-id', inspect_op, 'plan', 'complete-step', '--step', 'step-2', '--summary', 'Verified notes.')
    voice_args = ('--operation-id', voice_op, 'voice', 'create', str(sample),
                  '--model', voice_model, '--connection', 'conn-1', '--name', 'Narrator')
    created_voice = run_cli(*voice_args)
    assert run_cli(*voice_args) == created_voice == {'voiceId': 'voice-step-3', 'connectionId': 'conn-1'}
    assert len(voice_calls) == 1

    final = store.finalize_segment(project_id, turn_id, reply_text='All steps done.', segment_status='complete')
    assert final['stage'] == 'completed'
    assert [s['status'] for s in final['plan']['steps']] == ['completed', 'completed', 'completed']


@pytest.mark.anyio
async def test_only_business_receipt_can_complete_write_step(draft_plan):
    projects, business, project_id, task_id, session = draft_plan()
    turn = claim_execution(business.decisions, project_id, task_id, session)
    task = business.decisions.get_task(project_id, task_id)
    call = f"cli:{task['plan']['steps'][0]['operationId']}"
    args = (project_id, turn, session, call)
    with pytest.raises(ProjectError, match='只有检查步骤'):
        await business.execute(*args, 'complete_step', {'stepId': 'step-1', 'summary': 'Done'}, [], None)
    await business.execute(*args, 'read_project', {}, [], None)
    task = business.decisions.finalize_segment(project_id, turn, reply_text='Done', segment_status='complete')
    assert task['stage'] == 'status_unknown' and task['plan']['steps'][0]['status'] == 'pending'
    assert not task['acceptedReceipts'] and not projects.snapshot(project_id).assets


@pytest.mark.anyio
@pytest.mark.parametrize('tool_name', ['voice_create', 'voice_delete'])
async def test_voice_dispatch_starts_after_preflight(draft_plan, tmp_path, tool_name):
    import httpx
    from test_voice_library import config, library, wav

    _, business, project_id, task_id, session = draft_plan(('Update provider voices',))
    voice_config = {**config('Drama3'), 'id': str(uuid4())}
    calls = []

    def provider(request):
        calls.append(request.method)
        if request.method == 'GET':
            return httpx.Response(200, json={
                'voices': ['alice'], 'uploaded_voices': [{'id': 'alice', 'embedding_source': 'audio'}],
            })
        raise httpx.ReadTimeout('Provider result did not arrive', request=request)

    business.voices = library(voice_config, provider)
    _, caps = business.voices._config(voice_config['id'])
    work = tmp_path / 'run'
    work.mkdir()
    recording = work / 'sample.wav'
    recording.write_bytes(wav())
    store = business.decisions
    turn = claim_execution(store, project_id, task_id, session)

    async def send_voice(turn, step, connection):
        arguments = {'modelConfigId': voice_config['id'], 'connectionId': connection}
        if tool_name == 'voice_create':
            arguments.update(name='Narrator', path=str(recording), consent='fixture', refText='Hello')
        else:
            arguments['voiceId'] = 'alice'
        return await business.execute(
            project_id, turn, session, f"cli:{step['operationId']}", tool_name, arguments, [],
            None, execution_directory=work,
        )

    first = store.get_task(project_id, task_id)['plan']['steps'][0]
    with pytest.raises(ProjectError) as error:
        await send_voice(turn, first, 'stale')
    assert error.value.code == 'voice_connection_changed' and not calls
    failed = store.finalize_segment(project_id, turn, reply_text='', segment_status='complete')
    assert failed['stage'] == 'execution_failed' and not failed['pendingWrites']
    adjusted = store.adjust_plan(project_id, session, task_id, PlanAdjustInput(planRevision=1))
    turn = claim_execution(store, project_id, task_id, session, revision=2)
    step = adjusted['plan']['steps'][0]
    with pytest.raises(ProjectError) as error:
        await send_voice(turn, step, caps['connectionId'])
    assert error.value.code == 'voice_provider_timeout'
    writes = [method for method in calls if method != 'GET']
    assert writes == ['POST' if tool_name == 'voice_create' else 'DELETE']
    restored = store.public_state(project_id, adjusted['conversationId'])['tasks'][0]
    assert restored['stage'] == 'status_unknown' and restored['pendingWrites'][0]['dispatchState'] == 'dispatched'


def test_restart_after_saving_continuation_plan_returns_original_result(fake_default_agent, monkeypatch):
    headers = session_headers()
    with TestClient(create_app(fake_default_agent), headers=headers) as client:
        pid, root = open_project(client, 'Saved before restart')
        task_id = uuid4()
        asked = ask_turn(client, root, 'Plan', turn_id=task_id)
        saved = submit_answer(client, root, asked['decisions'][0], 'duration', 'custom', customText='12 seconds')
    project_id = UUID(pid)
    cid = UUID(saved['continuationId'])
    projects = CreationProjects(fake_default_agent)
    store = DecisionStore(projects)
    store.claim_continuation(project_id, headers['X-OpenDirector-Session'], cid)
    store.mark_model_dispatched(project_id, task_id, cid)
    agent.Conversations(projects).update(
        project_id, headers['X-OpenDirector-Session'], conversation_id=UUID(asked['conversationId']),
        begin_segment={'turnId': str(cid), 'taskId': str(task_id), 'segmentKind': 'continuation'},
    )
    store.save_plan(project_id, cid, UpdatePlanInput(summary='12 seconds'))
    assert store.public_state(project_id, asked['conversationId'], cid)['decisions'][0]['status'] == 'resuming'

    async def unexpected_stream(*args):
        pytest.fail('The persisted plan must replay without starting the model')
        yield

    monkeypatch.setattr(agent.AgentRuntimes, 'stream', unexpected_stream)
    with TestClient(create_app(LocalProjects(fake_default_agent.repository)), headers=headers) as client:
        current = client.get(root + '/assistant').json()
        assert current['decisions'][0]['status'] == 'completed'
        assert current['tasks'][0]['stage'] == 'waiting_confirmation'
        assert current['messages'][-1]['status'] == 'interrupted'
        replay = frames(client.post(root + f'/assistant/continuations/{cid}'))
        assert replay == [{
            'type': 'end',
            'seq': 0,
            'turnId': str(cid),
            'nextTurnId': None,
            'conversation': current,
            'error': None,
        }]


def test_finished_turn_releases_agent_session_and_queued_handoff_preserves_decisions(fake_default_agent, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    import threading

    gate = {'started': threading.Event(), 'release': threading.Event()}

    async def gated_ask_stream(runtimes, run):
        gateway = ToolGateway(runtimes.business, run)
        try:
            if run.messages[-1]['content'].startswith('先问'):
                yield await ask_event(gateway, 'cli:ask-1')
                gate['started'].set()
                await asyncio.to_thread(gate['release'].wait, 10)
                yield {'type': 'delta', 'text': '请先选择时长。'}
            else:
                yield {'type': 'delta', 'text': '已按新要求调整。'}
        finally:
            await gateway.close()

    monkeypatch.setattr(agent.AgentRuntimes, 'stream', gated_ask_stream)
    headers = session_headers()
    session_id = headers['X-OpenDirector-Session']
    with TestClient(create_app(fake_default_agent), headers=headers) as client:
        pid, root = open_project(client, 'Queue and lease')
        cid = client.get(root + '/assistant').json()['conversationId']
        first, second = str(uuid4()), str(uuid4())
        with ThreadPoolExecutor() as pool:
            running = pool.submit(client.post, root + '/assistant/turns', json={
                'id': first, 'runtime': 'default', 'mode': 'ask', 'conversationId': cid, 'text': '先问时长',
            })
            assert gate['started'].wait(5)
            queued = client.post(root + '/assistant/messages', json={
                'id': second, 'runtime': 'default', 'mode': 'auto', 'conversationId': cid, 'text': '直接开始',
            })
            assert queued.status_code == 202
            gate['release'].set()
            events = frames(running.result(timeout=10))

        ends = [event for event in events if event['type'] == 'end']
        assert len(ends) == 2 and ends[0]['nextTurnId'] == second
        assert 'decisions' in ends[0]['conversation'] and ends[0]['conversation']['decisions']

        # Releasing the browser session after the chain finishes must leave no leaked agent:<id> lease.
        assert client.delete(f'/api/creation/sessions/{session_id}').status_code == 200
        renamed = client.post(root + '/commands', json={
            'type': 'project.rename', 'projectId': pid, 'commandId': str(uuid4()),
            'expectedVersions': [{'objectType': 'project', 'id': pid, 'revision': 1}],
            'payload': {'name': 'Queue and lease renamed'},
        })
        assert renamed.status_code == 200 and renamed.json()['status'] == 'applied'


def test_confirm_plan_rolls_back_claim_if_conversation_switched_before_launch(configured_agent, monkeypatch):
    async def plan_stream(runtimes, run):
        saved = runtimes.business.decisions.save_plan(
            run.project_id, run.turn_id, UpdatePlanInput(summary='8 seconds', steps=['Write notes']),
        )
        yield {'type': 'task', 'task': saved['task']}

    monkeypatch.setattr(agent.AgentRuntimes, 'stream', plan_stream)
    with TestClient(create_app(configured_agent), headers=session_headers()) as client:
        pid, root = open_project(client, 'Rollback confirm')
        task_id = uuid4()
        task, = ask_turn(client, root, '规划一段短片', turn_id=task_id)['tasks']
        assert task['stage'] == 'waiting_confirmation'
        other_conversation = uuid4()
        original_claim = DecisionStore.claim_plan_execution

        def switch_after_real_claim(self, project_id, session, tid, payload, *, inspect_only=False):
            result = original_claim(self, project_id, session, tid, payload, inspect_only=inspect_only)
            if not inspect_only:
                assert result['state'] == 'claimed'
                agent.Conversations(self.projects).activate(project_id, other_conversation, session, create=True)
            return result

        monkeypatch.setattr(DecisionStore, 'claim_plan_execution', switch_after_real_claim)
        failed = client.post(root + f'/assistant/tasks/{task_id}/confirm-plan', json={'planRevision': task['planRevision']})
        assert failed.status_code == 409
        assert client.get(root + '/assistant/conversations').json()['activeId'] == str(other_conversation)
        reverted = DecisionStore(CreationProjects(configured_agent)).get_task(UUID(pid), task_id)
        assert reverted['stage'] == 'waiting_confirmation'
        assert reverted['confirmedPlanRevision'] is None


def test_begin_task_does_not_resurrect_older_plan_after_newer_ask_task_finished_or_abandoned(project):
    projects, pid, _ = project
    store = DecisionStore(projects)
    cid = uuid5(pid, 'assistant')

    # Case 1: Earlier Ask task interrupted with a saved plan, followed by a completed Ask task.
    t1 = uuid4()
    store.begin_task(pid, cid, t1, mode='ask', runtime='default', referenced_asset_ids=[], continue_existing=True)
    store.save_plan(pid, t1, UpdatePlanInput(summary='Old plan v1', steps=['Old step']))
    store.finalize_segment(pid, t1, reply_text='Stopped', segment_status='stopped')
    assert store.get_task(pid, t1)['stage'] == 'interrupted'

    t2 = uuid4()
    store.begin_task(pid, cid, t2, mode='ask', runtime='default', referenced_asset_ids=[], continue_existing=False)
    store.save_plan(pid, t2, UpdatePlanInput(
        summary='Completed plan', steps=[{'content': 'Check step', 'kind': 'inspection'}],
    ))
    with store._open_store(pid) as (_, directory, _, data):
        data['tasks'][str(t2)]['stage'] = 'completed'
        store._write_raw(directory, data)

    t3 = uuid4()
    fresh = store.begin_task(pid, cid, t3, mode='ask', runtime='default', referenced_asset_ids=[], continue_existing=True)
    assert fresh['taskId'] == str(t3)
    assert fresh['plan'] is None

    # Case 2: Earlier Ask task interrupted with a plan, followed by a newer Ask task waiting_input with no plan.
    store.save_plan(pid, t3, UpdatePlanInput(summary='Middle plan', steps=['Middle step']))
    store.finalize_segment(pid, t3, reply_text='Interrupted', segment_status='stopped')

    t4 = uuid4()
    store.begin_task(pid, cid, t4, mode='ask', runtime='default', referenced_asset_ids=[], continue_existing=False)
    store.record_question(pid, t4, 'cli:q', AskUserInput(questions=SAMPLE_QUESTIONS))
    assert store.get_task(pid, t4)['plan'] is None

    t5 = uuid4()
    after_abandoned_question = store.begin_task(
        pid, cid, t5, mode='ask', runtime='default', referenced_asset_ids=[], continue_existing=True,
    )
    assert after_abandoned_question['taskId'] == str(t5)
    assert after_abandoned_question['plan'] is None
    assert store.get_task(pid, t4)['stage'] == 'interrupted'


def test_confirm_plan_merges_updated_draft_models_and_falls_back_when_original_agent_removed(tmp_path, monkeypatch):
    local = LocalProjects(tmp_path)
    old_agent = dict(id=str(uuid4()), modelId='gpt-old', kind='agent', url='http://models.test/v1',
                     connectionType='api', protocol='openai', authMode='none', apiKey='')
    new_agent = dict(id=str(uuid4()), modelId='gpt-new', kind='agent', url='http://models.test/v1',
                     connectionType='api', protocol='openai', authMode='none', apiKey='')
    video_cfg = dict(id=str(uuid4()), modelId='seedance-test', kind='video', url='http://models.test/v1',
                     connectionType='api', protocol='volcengine', authMode='none', apiKey='')
    registry = {row['id']: row for row in (old_agent, new_agent, video_cfg)}

    def resolve_cfg(self, model_id, kind=None):
        row = registry.get(str(model_id))
        if row is None or (kind and row['kind'] != kind):
            raise ProjectError('未找到所选模型配置。', 404)
        return dict(row)

    monkeypatch.setattr(ModelConfigs, 'resolve', resolve_cfg)
    monkeypatch.setattr(ModelConfigs, 'list', lambda self: [dict(row) for row in registry.values()])
    monkeypatch.setattr(agent, 'runtime_available', lambda _: True)
    monkeypatch.setattr(agent, 'skills', empty_skills)

    seen_runs = []

    async def capture_stream(runtimes, run):
        seen_runs.append((run.config['id'] if run.config else None, dict(run.model_selections)))
        if run.task_stage == 'planning':
            saved = runtimes.business.decisions.save_plan(
                run.project_id, run.turn_id,
                UpdatePlanInput(summary='Inspect only', steps=['Verify setup']),
            )
            yield {'type': 'task', 'task': saved['task']}
        else:
            gateway = ToolGateway(runtimes.business, run)
            try:
                step_id = run.current_plan['steps'][0]['id']
                op = run.current_plan['steps'][0]['operationId']
                await gateway.call(f'cli:{op}', 'complete_step', {'stepId': step_id, 'summary': 'Checked'})
                yield {'type': 'delta', 'text': 'Done.'}
            finally:
                await gateway.close()

    monkeypatch.setattr(agent.AgentRuntimes, 'stream', capture_stream)
    with TestClient(create_app(local), headers=session_headers()) as client:
        _, root = open_project(client, 'Draft Model Merge')
        tid = str(uuid4())
        conv = frames(client.post(root + '/assistant/turns', json={
            'id': tid, 'runtime': 'default', 'mode': 'ask', 'text': '规划视频',
            'modelId': old_agent['id'], 'modelSelections': {'agent': old_agent['id']},
        }))[-1]['conversation']
        task = conv['tasks'][0]

        # Delete the old agent config and select new_agent + video_cfg in conversation draft.
        registry.pop(old_agent['id'])
        assert client.put(root + '/assistant/draft', json={
            'conversationId': conv['conversationId'],
            'draft': '',
            'runtime': 'default',
            'modelSelections': {'agent': new_agent['id'], 'video': video_cfg['id']},
        }).status_code == 200

        done = frames(client.post(root + f'/assistant/tasks/{tid}/confirm-plan', json={'planRevision': task['planRevision']}))
        assert done[-1]['error'] is None
        assert seen_runs[-1] == (new_agent['id'], {'agent': new_agent['id'], 'video': video_cfg['id']})


@pytest.mark.anyio
async def test_plan_step_operation_id_recovers_after_schema_validation_error_in_same_turn(draft_plan):
    projects, business, project_id, task_id, session = draft_plan(steps=('Create cover generation node',))
    store = business.decisions
    turn_id = claim_execution(store, project_id, task_id, session)
    task = store.get_task(project_id, task_id)
    call_id = f"cli:{step_operation_id(task, task['plan']['steps'][0])}"
    gateway = ToolGateway(business, RunContext(
        runtime='default', project_id=project_id, turn_id=turn_id, session=session,
        directory=projects.local.root, config=None, messages=[], selected_skills=[],
        mode='ask', task_id=task_id, task_stage='executing',
    ))
    try:
        # First attempt omits payload fields -> schema validation error before record_pending_write.
        bad = await gateway.call(call_id, 'execute_command', {'type': 'canvas.createGeneration', 'payload': {}})
        assert bad.error is not None and bad.release_id is True

        # Second attempt with corrected payload and the same mandatory stepOperationId completes the step.
        spec_id, item_id = str(uuid4()), str(uuid4())
        good = await gateway.call(call_id, 'execute_command', {
            'type': 'canvas.createGeneration',
            'payload': {
                'spec': {'id': spec_id, 'projectId': str(project_id), 'kind': 'image', 'purpose': 'generation'},
                'item': {
                    'id': item_id, 'projectId': str(project_id), 'kind': 'image',
                    'position': {'x': 200, 'y': 200},
                    'binding': {'role': 'generation', 'objectRef': {'id': spec_id}},
                },
            },
        })
        assert good.error is None and good.value['status'] == 'applied'
        final = store.finalize_segment(project_id, turn_id, reply_text='Cover node created.', segment_status='complete')
        assert final['stage'] == 'completed'
        assert [s['status'] for s in final['plan']['steps']] == ['completed']
    finally:
        await gateway.close()
