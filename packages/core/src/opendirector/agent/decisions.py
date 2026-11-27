"""Authoritative decision records, versioned plan snapshots and continuation recovery."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import re
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID, uuid5

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from opendirector.application.creation_timeline_packages import CreationTimelinePackages
from opendirector.domain.creation.base import agent_command_id
from opendirector.domain.creation.timeline_packages import TimelinePackageImportFile
from opendirector.domain.projects import ProjectError
from opendirector.domain.rule_facts import PROMPT_MAX_LENGTH
from opendirector.infrastructure.creation_projects import durable_json
from opendirector.infrastructure.local_projects import child, read_json

InteractionMode = Literal['auto', 'ask']
ASK_SUPPORTED_RUNTIMES = frozenset({'default', 'opencode', 'claude', 'codex', 'deepseek'})

TaskStage = Literal[
    'running',
    'planning',
    'waiting_input',
    'answer_saved',
    'resuming',
    'waiting_confirmation',
    'executing',
    'waiting_jobs',
    'execution_failed',
    'completed',
    'interrupted',
    'status_unknown',
]

DecisionStatus = Literal[
    'waiting_input',
    'answer_saved',
    'resuming',
    'completed',
    'invalidated',
    'resume_failed',
    'status_unknown',
]

_RECOMMENDED_SUFFIX = re.compile(
    r'(?:\s*(?:（推荐）|\(推荐\)|\(Recommended\)|\[Recommended\]|【推荐】))+\s*$',
    re.IGNORECASE,
)


def strip_recommended_marker(label: str) -> str:
    cleaned = _RECOMMENDED_SUFFIX.sub('', label.strip()).strip()
    return cleaned or label.strip()


def _require_non_blank(value: str) -> str:
    trimmed = value.strip()
    if not trimmed:
        raise ValueError('Field must not be blank.')
    return trimmed


class QuestionOptionModel(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str = Field(min_length=1, max_length=120, description='Stable option identifier within the question.')
    label: str = Field(min_length=1, max_length=200, description='Short option label without hardcoded recommendation badges.')
    impact: str = Field(min_length=1, max_length=500, description='One-sentence explanation of what changes if this option is chosen.')

    _non_blank = field_validator('id', 'impact')(_require_non_blank)

    @field_validator('label')
    @classmethod
    def _clean_label(cls, value: str) -> str:
        cleaned = strip_recommended_marker(value)
        if not cleaned:
            raise ValueError('Option label must not be blank.')
        return cleaned


class QuestionItemModel(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str = Field(min_length=1, max_length=120, description='Stable question identifier within the request.')
    question: str = Field(min_length=1, max_length=500, description='Question prompt shown to the user.')
    multiSelect: bool = Field(default=False, description='Whether the user may select multiple preset options.')
    required: bool = Field(default=True, description='Whether this question requires an answer before submission.')
    defaultOptionIds: list[str] = Field(default_factory=list, max_length=8, description='Explicit default option IDs for optional questions.')
    defaultText: str | None = Field(default=None, max_length=500, description='Explicit default custom answer for optional questions.')
    options: list[QuestionOptionModel] = Field(min_length=1, max_length=8, description='Options ordered from highest recommendation to lowest.')

    _non_blank = field_validator('id', 'question')(_require_non_blank)

    @model_validator(mode='after')
    def _validate_options(self) -> QuestionItemModel:
        option_ids = [option.id for option in self.options]
        if len(option_ids) != len(set(option_ids)):
            raise ValueError(f'Duplicate option IDs in question {self.id!r}.')
        if self.defaultOptionIds:
            if self.required:
                raise ValueError(f'Required question {self.id!r} cannot declare defaultOptionIds.')
            unknown = set(self.defaultOptionIds) - set(option_ids)
            if unknown:
                raise ValueError(f'Unknown defaultOptionIds in question {self.id!r}: {sorted(unknown)}.')
            if not self.multiSelect and len(self.defaultOptionIds) > 1:
                raise ValueError(f'Single-select question {self.id!r} cannot have multiple defaultOptionIds.')
        if self.defaultText is not None:
            if self.required:
                raise ValueError(f'Required question {self.id!r} cannot declare defaultText.')
            if not self.defaultText.strip():
                raise ValueError(f'defaultText in question {self.id!r} must not be blank.')
        return self


class PlanStepInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    content: str = Field(min_length=1, max_length=1000)
    kind: Literal['write', 'read', 'inspection']


PlanStep = PlanStepInput | Annotated[str, Field(min_length=1, max_length=1000)]


class PlanDraftInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    summary: str = Field(min_length=1, max_length=PROMPT_MAX_LENGTH, description='Versioned plan summary or Markdown content.')
    steps: list[PlanStep] = Field(
        default_factory=list, max_length=50, description='Ordered steps. A string denotes a write step.'
    )


class AskUserInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    questions: list[QuestionItemModel] = Field(min_length=1, max_length=4, description='1 to 4 questions in this decision group.')
    stage: str = Field(default='planning', min_length=1, max_length=80, description='Logical task stage.')
    plan: PlanDraftInput | str | None = Field(default=None, description='Optional current plan summary or structured plan draft.')

    @model_validator(mode='after')
    def _unique_question_ids(self) -> AskUserInput:
        ids = [item.id for item in self.questions]
        if len(ids) != len(set(ids)):
            raise ValueError('Question IDs in ask_user must be unique.')
        return self


class UpdatePlanInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    summary: str = Field(min_length=1, max_length=PROMPT_MAX_LENGTH, description='Complete updated plan summary or Markdown body.')
    steps: list[PlanStep] = Field(
        default_factory=list, max_length=50, description='Ordered steps. A string denotes a write step.'
    )
    planOnly: bool | None = Field(default=None, description='Whether the user requested planning only without execution.')


class CompleteStepInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    stepId: str = Field(min_length=1, max_length=120, description='Plan step ID such as step-1.')
    summary: str = Field(min_length=1, max_length=2000, description='Concise verified outcome of this read or inspection step.')


class AnswerItemInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    questionId: str = Field(min_length=1, max_length=120)
    source: Literal['options', 'custom', 'default']
    selectedOptionIds: list[str] = Field(default_factory=list, max_length=8)
    customText: str | None = Field(default=None, max_length=PROMPT_MAX_LENGTH)


class DecisionAnswerSubmit(BaseModel):
    model_config = ConfigDict(extra='forbid')
    answers: list[AnswerItemInput] = Field(min_length=1, max_length=4)


class PlanConfirmInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    planRevision: int = Field(ge=1)


class PlanAdjustInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    planRevision: int = Field(ge=1)
    prompt: str | None = Field(default=None, max_length=PROMPT_MAX_LENGTH)


def extract_plan_steps(text: str) -> list[str]:
    steps: list[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line == '[opendirector-replies]: #':
            continue
        match = re.match(r'^(?:[-*+]|\d+[.)、])\s+(.+)$', line)
        if match:
            step = match.group(1).strip()
            if step and len(step) <= 500:
                steps.append(step)
        if len(steps) >= 20:
            break
    if not steps and text.strip():
        first_line = text.strip().splitlines()[0].strip()
        if first_line:
            steps.append(first_line[:500])
    return steps


def _build_default_answer(question: dict, options_by_id: dict[str, dict]) -> dict:
    default_ids = question.get('defaultOptionIds') or []
    default_text = question.get('defaultText')
    labels = [options_by_id[opt_id]['label'] for opt_id in default_ids if opt_id in options_by_id]
    return {
        'questionId': question['id'],
        'source': 'default',
        'selectedOptionIds': list(default_ids),
        'selectedLabels': labels,
        'customText': default_text,
        'displayText': default_text if default_text else '、'.join(labels),
    }


def normalize_answers(questions: list[dict], submitted: list[AnswerItemInput]) -> tuple[list[dict], str]:
    by_id = {q['id']: q for q in questions}
    seen: set[str] = set()
    normalized_by_id: dict[str, dict] = {}

    for item in submitted:
        if item.questionId in seen:
            raise ProjectError('同一题目不能重复提交多份答案。', 422, code='decision_answer_invalid')
        seen.add(item.questionId)
        question = by_id.get(item.questionId)
        if question is None:
            raise ProjectError(f'未知题目标识：{item.questionId}。', 422, code='decision_answer_invalid')
        options_by_id = {opt['id']: opt for opt in question['options']}
        if item.source == 'custom':
            custom = (item.customText or '').strip()
            if not custom:
                raise ProjectError('自定义回答不能为空。', 422, code='decision_answer_invalid')
            if item.selectedOptionIds:
                raise ProjectError('输入自定义回答后不能同时提交预设选项。', 422, code='decision_answer_invalid')
            normalized_by_id[item.questionId] = {
                'questionId': item.questionId,
                'source': 'custom',
                'selectedOptionIds': [],
                'selectedLabels': [],
                'customText': custom,
                'displayText': custom,
            }
        elif item.source == 'options':
            if item.customText is not None and item.customText.strip():
                raise ProjectError('选择预设选项时不能同时混入自定义文本。', 422, code='decision_answer_invalid')
            if not item.selectedOptionIds:
                raise ProjectError('请至少选择一个选项，或直接输入自定义内容。', 422, code='decision_answer_invalid')
            if not question.get('multiSelect', False) and len(item.selectedOptionIds) > 1:
                raise ProjectError('单选题只能选择一个预设选项。', 422, code='decision_answer_invalid')
            ordered_ids: list[str] = []
            for opt_id in item.selectedOptionIds:
                if opt_id not in options_by_id:
                    raise ProjectError(f'选项标识无效：{opt_id}。', 422, code='decision_answer_invalid')
                if opt_id not in ordered_ids:
                    ordered_ids.append(opt_id)
            labels = [options_by_id[opt_id]['label'] for opt_id in ordered_ids]
            normalized_by_id[item.questionId] = {
                'questionId': item.questionId,
                'source': 'options',
                'selectedOptionIds': ordered_ids,
                'selectedLabels': labels,
                'customText': None,
                'displayText': '、'.join(labels),
            }
        elif item.source == 'default':
            if question.get('required', True):
                raise ProjectError('必答题不能使用默认值跳过。', 422, code='decision_answer_invalid')
            if not (question.get('defaultOptionIds') or question.get('defaultText')):
                raise ProjectError('该题目没有设置默认值，不能使用默认值跳过。', 422, code='decision_answer_invalid')
            normalized_by_id[item.questionId] = _build_default_answer(question, options_by_id)

    ordered_answers: list[dict] = []
    for q in questions:
        qid = q['id']
        if qid in normalized_by_id:
            ordered_answers.append(normalized_by_id[qid])
        elif not q.get('required', True) and (q.get('defaultOptionIds') or q.get('defaultText')):
            ordered_answers.append(_build_default_answer(q, {opt['id']: opt for opt in q['options']}))
        else:
            raise ProjectError(f'请先回答题目：{q["question"]}', 422, code='decision_answer_invalid')

    canonical = [
        {
            'questionId': ans['questionId'],
            'source': ans['source'],
            'selectedOptionIds': ans['selectedOptionIds'],
            'customText': ans['customText'],
        }
        for ans in ordered_answers
    ]
    encoded = json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return ordered_answers, 'sha256:' + hashlib.sha256(encoded).hexdigest()


def capture_related_versions(snapshot_dict: dict, task: dict) -> list[dict]:
    """Capture explicit plan and referenced-asset versions without binding unrelated canvas moves."""
    versions: list[dict] = [{
        'objectType': 'plan',
        'id': str(task['taskId']),
        'revision': int(task.get('planRevision', 0)),
        'fingerprint': None,
    }]
    assets_by_id = {str(item['id']): item for item in snapshot_dict.get('assets', [])}
    seen_assets: set[str] = set()
    for asset_id in task.get('referencedAssetIds', []):
        aid = str(asset_id)
        asset = assets_by_id.get(aid)
        if asset is not None and aid not in seen_assets:
            seen_assets.add(aid)
            versions.append({
                'objectType': 'asset',
                'id': aid,
                'revision': int(asset['revision']),
                'fingerprint': asset.get('fingerprint'),
            })
    return versions


def related_versions_valid(snapshot_dict: dict, task: dict | None, decision: dict) -> bool:
    """Verify explicit dependency versions. Unrelated canvas dragging never invalidates a question."""
    if task is None:
        return False
    assets_by_id = {
        str(item['id']): item
        for item in snapshot_dict.get('assets', [])
        if not item.get('trashedAt')
    }
    for entry in decision.get('relatedVersions', []):
        kind = entry['objectType']
        expected_rev = entry.get('revision')
        if kind == 'plan':
            if int(task.get('planRevision', 0)) != int(expected_rev or 0):
                return False
        elif kind == 'asset':
            target = assets_by_id.get(str(entry['id']))
            if target is None:
                return False
            if expected_rev is not None and int(target['revision']) != int(expected_rev):
                return False
            if entry.get('fingerprint') and target.get('fingerprint') != entry['fingerprint']:
                return False
    return True


def build_continuation_prompt_block(task: dict, decision: dict) -> str:
    """Build the authoritative latest context block when resuming after user answers ask_user."""
    question_map = {q['id']: q for q in decision.get('questions', [])}
    formatted_answers = []
    for ans in decision.get('answers') or []:
        q = question_map.get(ans['questionId'], {})
        options_map = {opt['id']: opt for opt in q.get('options', [])}
        chosen_impacts = [
            options_map[oid]['impact']
            for oid in ans.get('selectedOptionIds', [])
            if oid in options_map
        ]
        formatted_answers.append({
            'questionId': ans['questionId'],
            'question': q.get('question', ans['questionId']),
            'answerSource': ans['source'],
            'selectedOptionIds': ans.get('selectedOptionIds', []),
            'selectedLabels': ans.get('selectedLabels', []),
            'selectedImpacts': chosen_impacts,
            'customText': ans.get('customText'),
            'effectiveAnswer': ans.get('customText') if ans['source'] == 'custom' else ans.get('displayText'),
        })

    payload = {
        'type': 'ask_user_answer_continuation',
        'taskId': task['taskId'],
        'requestId': decision['requestId'],
        'continuationId': decision['continuationId'],
        'mode': task.get('mode', 'ask'),
        'currentPlanRevision': task.get('planRevision', 0),
        'currentPlan': task.get('plan'),
        'acceptedReceipts': task.get('acceptedReceipts', []),
        'answers': formatted_answers,
    }
    return (
        'OpenDirector user decision response (authoritative checkpoint):\n'
        + json.dumps(payload, ensure_ascii=False, indent=2)
        + '\n\nInstructions for this continuation segment:\n'
        '1. You MUST incorporate every `effectiveAnswer` above into the updated plan. '
        'When `answerSource` is `"custom"`, `customText` is a first-class requirement: adopt its exact values and instructions verbatim '
        '(for example, exact duration such as 12 秒 and shot instructions such as 最后留 3 秒空镜) and NEVER map or round it to a preset option.\n'
        '2. Do NOT repeat any operation with an applied, accepted, or noop receipt.\n'
        '3. This segment is in the planning stage (`waiting_confirmation`). Save the updated plan by running '
        '`opendirector plan save --summary "<updated plan summary reflecting the exact answer>" --step "<step 1>" --step "<step 2>"` '
        'or use `opendirector plan save --file updated_plan.json` for steps with explicit kinds. '
        'In JSON, each step can be {"content": "...", "kind": "write|read|inspection"}. '
        'Use write for project changes or generation, read for OpenDirector queries, and inspection for native file/media checks. '
        'A plain string denotes a write step. Present the complete revised plan clearly in your reply, '
        'and END THIS TURN IMMEDIATELY to wait for the user to confirm execution. '
        'Do NOT execute project mutation commands (`canvas`, `asset`, `video`, `generation`) in this segment.'
    )


def build_execution_prompt_block(task: dict) -> str:
    """Build the authoritative context block when executing a confirmed plan revision."""
    plan = task.get('plan') or {}
    payload = {
        'type': 'plan_execution_confirmation',
        'taskId': task['taskId'],
        'confirmedPlanRevision': task.get('confirmedPlanRevision'),
        'executionContinuationId': task.get('executionContinuationId'),
        'stepOperationIds': {
            step['id']: str(step_operation_id(task, step))
            for step in plan.get('steps', [])
        },
        'plan': plan,
        'acceptedReceipts': task.get('acceptedReceipts', []),
    }
    return (
        'OpenDirector confirmed plan execution (authoritative checkpoint):\n'
        + json.dumps(payload, ensure_ascii=False, indent=2)
        + '\n\nInstructions for this execution segment:\n'
        '1. The user has explicitly confirmed Plan Revision '
        f"{task.get('confirmedPlanRevision')}. Project write operations are now unlocked.\n"
        '2. Inspect `acceptedReceipts` and step status first. Skip completed steps and do not repeat an operation with an applied, accepted, noop, or verified receipt.\n'
        '3. Execute the confirmed plan faithfully, including every custom answer in `plan.summary`. '
        'Use the corresponding `stepOperationIds` value as the global `--operation-id` for each step’s final OpenDirector command '
        '(including read/query commands such as `project show` or `query`). '
        'For an inspection step that uses native file/media tools, record its outcome with '
        '`opendirector --operation-id <stepOperationId> plan complete-step --step <step-id> --summary "<verified outcome>"`. '
        'Every other independent write needs its own operation ID. Reuse an ID only to retry the same write with the same input. '
        'Report any incomplete steps and summarize the actual results.'
    )


def step_operation_id(task: dict, step: dict) -> UUID:
    if step.get('operationId'):
        return UUID(step['operationId'])
    return uuid5(UUID(task['taskId']), f"plan:{task['planRevision']}:{step['id']}")


def write_allowed(task: dict, turn_id: UUID | str) -> bool:
    if task['stage'] == 'running':
        return str(turn_id) == task['taskId']
    return (
        task['stage'] == 'executing'
        and task.get('executionContinuationId') == str(turn_id)
        and task.get('confirmedPlanRevision') == task.get('planRevision')
        and task.get('confirmedPlanRevision') is not None
    )


def receipt_outcome(receipt: dict, jobs: dict) -> str:
    status = receipt.get('status')
    if status in {'applied', 'noop', 'verified'}:
        return 'completed'
    if status == 'rejected':
        return 'failed'
    if status == 'accepted' and receipt.get('jobIds'):
        linked = [jobs.get(str(job_id)) for job_id in receipt['jobIds']]
        if all(linked):
            if all(job.status == 'succeeded' for job in linked):
                return 'completed'
            if any(job.status in {'queued', 'running'} for job in linked):
                return 'in_progress'
            if all(job.status in {'succeeded', 'failed', 'cancelled'} and
                   getattr(job.errorDetails, 'category', None) != 'submission_unknown' for job in linked):
                return 'failed'
    return 'pending'


def execution_outcome(task: dict, jobs: dict) -> str:
    steps = (task.get('plan') or {}).get('steps', [])
    step_calls = {f"cli:{step_operation_id(task, step)}": step for step in steps}
    relevant = {}
    for receipt in task.get('acceptedReceipts', []):
        call_id = receipt['callId']
        step = step_calls.get(call_id)
        if receipt.get('receipt', {}).get('stepId'):
            kind = 'inspection' if receipt['type'] == 'complete_step' else 'read'
            if step is None or step.get('kind', 'write') != kind:
                continue
        elif step is None and receipt.get('turnId') != task.get('executionContinuationId'):
            continue
        relevant[call_id] = receipt_outcome(receipt, jobs)
    for call_id, step in step_calls.items():
        step['status'] = relevant.get(call_id, 'pending')
    if task.get('pendingWrites') or 'pending' in relevant.values():
        return 'status_unknown'
    if 'in_progress' in relevant.values():
        return 'waiting_jobs'
    if 'failed' in relevant.values():
        return 'execution_failed'
    if steps and all(step['status'] == 'completed' for step in steps):
        return 'completed'
    return 'status_unknown'


class DecisionStore:
    """Project-scoped durable persistence for logical tasks, decisions and versioned plans."""

    def __init__(self, projects):
        self.projects = projects

    def _file(self, directory: Path) -> Path:
        return child(child(directory, 'agent-runs'), 'decisions.json')

    def _read_raw(self, directory: Path) -> dict:
        file = self._file(directory)
        if not file.is_file():
            return {'tasks': {}, 'decisions': {}}
        data = read_json(file)
        return {'tasks': dict(data.get('tasks') or {}), 'decisions': dict(data.get('decisions') or {})}

    def _write_raw(self, directory: Path, data: dict) -> None:
        file = self._file(directory)
        file.parent.mkdir(exist_ok=True)
        durable_json(file, data)

    @contextmanager
    def _open_store(self, project_id: UUID, *, session: str | None = None, open_project: bool = False):
        with self.projects.local.transaction() as db:
            self.projects._recover()
            directory, _, records = self.projects._load(db, project_id)
            if session is not None:
                self.projects._lease(db, project_id, directory, session, browser_only=open_project)
                if open_project:
                    self.projects.local.acquire_edit_lease(db, {'id': str(project_id), 'path': str(directory)}, session)
            yield db, directory, records, self._read_raw(directory)

    @contextmanager
    def _open_existing_store(self, project_id: UUID):
        with self.projects.local.transaction() as db:
            directory, _ = self.projects._find(db, project_id)
            if not self._file(directory).is_file():
                yield db, directory, None
                return
            self.projects._recover()
            directory, _, _ = self.projects._load(db, project_id)
            yield db, directory, self._read_raw(directory)

    @staticmethod
    def _lazy_auto_task(directory: Path, data: dict, project_id: UUID, turn_id: UUID) -> dict | None:
        conv_file = child(child(directory, 'agent-runs'), 'conversation.json')
        if not conv_file.is_file():
            return None
        conv = read_json(conv_file)
        tid = str(turn_id)
        user_msg = next((m for m in conv.get('messages', []) if m.get('role') == 'user' and m.get('id') == tid), None)
        if user_msg is None:
            return None
        cid = conv.get('conversationId') or str(uuid5(project_id, 'assistant'))
        task = {
            'taskId': tid,
            'conversationId': cid,
            'mode': user_msg.get('mode') or 'auto',
            'runtime': user_msg.get('runtime') or conv.get('runtime') or 'default',
            'planOnly': bool(user_msg.get('planOnly')),
            'stage': 'running',
            'latestTurnId': tid,
            'referencedAssetIds': [str(item['id']) for item in (user_msg.get('assets') or []) if isinstance(item, dict) and 'id' in item],
            'planRevision': 0,
            'plan': None,
            'confirmedPlanRevision': None,
            'executionContinuationId': None,
            'activeDecisionId': None,
            'pendingContinuationId': None,
            'segmentTurnIds': [tid],
            'acceptedReceipts': [],
            'pendingWrites': [],
            'error': None,
            'errorCode': None,
        }
        data['tasks'][tid] = task
        return task

    @staticmethod
    def _find_task(data: dict, turn_id: UUID | str) -> dict | None:
        tid = str(turn_id)
        return data['tasks'].get(tid) or next(
            (item for item in data['tasks'].values() if tid in item.get('segmentTurnIds', [])),
            None,
        )

    @staticmethod
    def _receipt_entry(
        command_id: str,
        call_id: str,
        turn_id: UUID | str,
        kind: str,
        receipt: dict,
        *,
        input_fingerprint: str | None = None,
        retryable: bool = False,
    ) -> dict:
        entry = {
            'commandId': command_id,
            'callId': call_id,
            'turnId': str(turn_id),
            'type': kind,
            'status': receipt.get('status'),
            'inputFingerprint': input_fingerprint,
            'changed': receipt.get('changed', []),
            'jobIds': receipt.get('jobIds', []),
            'receipt': receipt,
        }
        if retryable:
            entry['retryable'] = True
        return entry

    @staticmethod
    def _store_committed_receipt(task: dict, entry: dict) -> None:
        cid = entry['commandId']
        task['acceptedReceipts'] = [
            r for r in task.get('acceptedReceipts', []) if not (r.get('commandId') == cid and r.get('retryable'))
        ]
        if not any(r.get('commandId') == cid for r in task['acceptedReceipts']):
            task['acceptedReceipts'].append(entry)

    @classmethod
    def _retryable_rejection(
        cls, command_id: str, call_id: str, turn_id: UUID | str, kind: str, message: str,
        *, code: str | None = None, input_fingerprint: str | None = None,
    ) -> dict:
        receipt = {
            'status': 'rejected',
            'retryable': True,
            'issues': [{'code': code or 'operation_rejected', 'message': message}],
        }
        return cls._receipt_entry(
            command_id, call_id, turn_id, kind, receipt, input_fingerprint=input_fingerprint, retryable=True,
        )

    @staticmethod
    def _require_current_conversation(directory: Path, task: dict, project_id: UUID) -> None:
        file = child(child(directory, 'agent-runs'), 'conversation.json')
        current = read_json(file).get('conversationId') if file.is_file() else None
        if task['conversationId'] != (current or str(uuid5(project_id, 'assistant'))):
            raise ProjectError('请切回任务所属对话后再继续。', 409, code='task_conversation_changed')

    def begin_task(
        self,
        project_id: UUID,
        conversation_id: UUID,
        turn_id: UUID,
        *,
        mode: InteractionMode,
        runtime: str,
        referenced_asset_ids: list[str],
        plan_only: bool = False,
        continue_existing: bool = False,
    ) -> dict:
        if mode == 'ask' and runtime not in ASK_SUPPORTED_RUNTIMES:
            raise ProjectError('当前 Agent 运行时暂不支持询问模式。', 409, code='ask_mode_runtime_unsupported')
        initial_stage: TaskStage = 'planning' if (mode == 'ask' or plan_only) else 'running'
        with self._open_store(project_id) as (_, directory, _, data):
            tid, cid = str(turn_id), str(conversation_id)
            if continue_existing and mode == 'ask':
                reusable = None
                for candidate in data['tasks'].values():
                    if candidate.get('conversationId') != cid:
                        continue
                    is_planned_mode = candidate.get('mode') == 'ask' or bool(candidate.get('planOnly'))
                    if candidate.get('pendingWrites'):
                        if is_planned_mode:
                            reusable = None
                        continue
                    stage = candidate.get('stage')
                    if stage == 'waiting_input':
                        active_id = candidate.get('activeDecisionId')
                        if active_id and active_id in data['decisions']:
                            old_dec = data['decisions'][active_id]
                            if old_dec.get('status') == 'waiting_input':
                                old_dec['status'] = 'invalidated'
                        candidate['activeDecisionId'] = None
                        if candidate.get('plan') is not None:
                            reusable = candidate
                        else:
                            candidate['stage'] = 'interrupted'
                            reusable = None
                    elif (
                        candidate.get('plan') is not None
                        and stage in {'planning', 'waiting_confirmation', 'execution_failed', 'interrupted'}
                    ):
                        reusable = candidate
                    elif is_planned_mode:
                        reusable = None
                if reusable is not None:
                    reusable.update(
                        mode=mode,
                        runtime=runtime,
                        planOnly=plan_only,
                        stage='planning',
                        latestTurnId=tid,
                        confirmedPlanRevision=None,
                        error=None,
                        errorCode=None,
                    )
                    existing_refs = list(reusable.get('referencedAssetIds') or [])
                    for aid in referenced_asset_ids:
                        if str(aid) not in existing_refs:
                            existing_refs.append(str(aid))
                    reusable['referencedAssetIds'] = existing_refs
                    if tid not in reusable.setdefault('segmentTurnIds', []):
                        reusable['segmentTurnIds'].append(tid)
                    self._write_raw(directory, data)
                    return reusable
            task = {
                'taskId': tid,
                'conversationId': cid,
                'mode': mode,
                'runtime': runtime,
                'planOnly': plan_only,
                'stage': initial_stage,
                'latestTurnId': tid,
                'referencedAssetIds': [str(aid) for aid in referenced_asset_ids],
                'planRevision': 0,
                'plan': None,
                'confirmedPlanRevision': None,
                'executionContinuationId': None,
                'activeDecisionId': None,
                'pendingContinuationId': None,
                'segmentTurnIds': [tid],
                'acceptedReceipts': [],
                'pendingWrites': [],
                'error': None,
                'errorCode': None,
            }
            data['tasks'][tid] = task
            self._write_raw(directory, data)
            return task

    def get_task(self, project_id: UUID, task_id: UUID | str) -> dict | None:
        with self._open_store(project_id) as (_, _, _, data):
            return data['tasks'].get(str(task_id))

    def task_for_turn(self, project_id: UUID, turn_id: UUID | str) -> dict | None:
        try:
            with self._open_existing_store(project_id) as (_, _, data):
                return self._find_task(data, turn_id) if data is not None else None
        except ProjectError:
            return None

    def record_question(self, project_id: UUID, turn_id: UUID, call_id: str, payload: AskUserInput) -> dict:
        snapshot = self.projects.snapshot(project_id).model_dump(mode='json')
        request_id = str(uuid5(turn_id, f'ask_user:{call_id}'))
        with self._open_store(project_id) as (_, directory, _, data):
            task = self._find_task(data, turn_id) or self._lazy_auto_task(directory, data, project_id, turn_id)
            if task is None:
                raise ProjectError('找不到当前对话任务上下文。', 404, code='missing_object')

            existing = data['decisions'].get(request_id)
            if existing is not None:
                return {'decision': existing, 'task': task}

            if task.get('activeDecisionId'):
                active_dec = data['decisions'].get(task['activeDecisionId'])
                if active_dec and active_dec.get('status') == 'waiting_input':
                    raise ProjectError('当前任务已有待回答的问题，请等待用户回答后再继续。', 409, code='task_waiting_input')

            requires_new_confirmation = write_allowed(task, turn_id) and task['stage'] == 'executing'
            if payload.plan is not None:
                summary = payload.plan if isinstance(payload.plan, str) else payload.plan.summary
                steps = (
                    extract_plan_steps(payload.plan)
                    if isinstance(payload.plan, str)
                    else (payload.plan.steps or extract_plan_steps(payload.plan.summary))
                )
                self._apply_plan_update_locked(task, summary, steps, str(turn_id), force_revision=requires_new_confirmation)
            elif requires_new_confirmation:
                plan = task['plan']
                self._apply_plan_update_locked(
                    task, plan['summary'], self._plan_step_inputs(plan), str(turn_id), force_revision=True,
                )

            assistant_message_id = str(uuid5(turn_id, 'assistant'))
            decision = {
                'requestId': request_id,
                'taskId': task['taskId'],
                'conversationId': task['conversationId'],
                'turnId': str(turn_id),
                'messageId': assistant_message_id,
                'callId': call_id,
                'stage': payload.stage,
                'planRevision': int(task.get('planRevision', 0)),
                'relatedVersions': capture_related_versions(snapshot, task),
                'questions': [q.model_dump(mode='json') for q in payload.questions],
                'status': 'waiting_input',
                'answers': None,
                'answerFingerprint': None,
                'continuationId': None,
                'error': None,
                'errorCode': None,
            }
            data['decisions'][request_id] = decision
            task['stage'] = 'waiting_input'
            task['activeDecisionId'] = request_id
            self._write_raw(directory, data)

            conv_file = child(child(directory, 'agent-runs'), 'conversation.json')
            if conv_file.is_file():
                conv = read_json(conv_file)
                for msg in conv.get('messages', []):
                    if msg.get('id') == assistant_message_id:
                        msg['decisionRequestId'] = request_id
                        msg['taskId'] = task['taskId']
                durable_json(conv_file, conv)

            return {'decision': decision, 'task': task}

    @staticmethod
    def _plan_step_inputs(plan: dict) -> list[PlanStepInput]:
        return [PlanStepInput(content=step['content'], kind=step.get('kind', 'write')) for step in plan['steps']]

    @staticmethod
    def _apply_plan_update_locked(task: dict, summary: str, steps: list[PlanStep], turn_id: str, *, force_revision=False) -> dict:
        cleaned_summary = summary.strip()
        if not cleaned_summary:
            return task.get('plan') or {}
        current_plan = task.get('plan')
        steps = [
            PlanStepInput(content=step, kind='write') if isinstance(step, str) else step
            for step in steps or extract_plan_steps(cleaned_summary)
        ]
        unchanged = bool(
            current_plan
            and current_plan['summary'] == cleaned_summary
            and DecisionStore._plan_step_inputs(current_plan) == steps
        )
        if unchanged and not force_revision:
            return current_plan
        next_revision = int(task.get('planRevision', 0)) + 1
        plan_steps = []
        for index, step in enumerate(steps, start=1):
            step_id = f'step-{index}'
            previous = current_plan['steps'][index - 1] if unchanged else None
            if previous is not None and previous['status'] == 'failed':
                previous = None
            operation_id = (
                step_operation_id(task, previous) if previous is not None
                else uuid5(UUID(task['taskId']), f'plan:{next_revision}:{step_id}')
            )
            plan_steps.append({
                'id': step_id, **step.model_dump(), 'status': previous['status'] if previous else 'pending',
                'operationId': str(operation_id),
            })
        plan_obj = {
            'revision': next_revision,
            'summary': cleaned_summary,
            'steps': plan_steps,
            'updatedAtTurnId': str(turn_id),
        }
        task['planRevision'] = next_revision
        task['plan'] = plan_obj
        if task.get('confirmedPlanRevision') is not None and task['confirmedPlanRevision'] < next_revision:
            task['confirmedPlanRevision'] = None
        return plan_obj

    def save_plan(self, project_id: UUID, turn_id: UUID, payload: UpdatePlanInput) -> dict:
        with self._open_store(project_id) as (_, directory, _, data):
            task = self._find_task(data, turn_id) or self._lazy_auto_task(directory, data, project_id, turn_id)
            if task is None:
                raise ProjectError('找不到当前对话任务上下文。', 404, code='missing_object')
            if payload.planOnly is not None:
                task['planOnly'] = payload.planOnly
            previous_revision = task['planRevision']
            stage = task['stage']
            plan = task.get('plan') or {}
            # Saving an identical draft in a refinement still requires a new confirmation.
            force_revision = stage == 'resuming' or (
                stage == 'planning' and bool(plan) and plan.get('updatedAtTurnId') != str(turn_id)
            )
            steps = payload.steps or extract_plan_steps(payload.summary)
            plan_obj = self._apply_plan_update_locked(
                task, payload.summary, steps, str(turn_id), force_revision=force_revision,
            )
            if stage != 'waiting_input' and plan_obj.get('updatedAtTurnId') == str(turn_id) and (
                stage != 'executing' or task['planRevision'] != previous_revision
            ):
                task['stage'] = 'waiting_confirmation'
            self._write_raw(directory, data)
            return {'plan': plan_obj, 'task': task}

    def finalize_segment(
        self,
        project_id: UUID,
        turn_id: UUID,
        *,
        reply_text: str,
        segment_status: str,
        error: str | None = None,
        before_model: bool = False,
    ) -> dict | None:
        """Update task and decision state when a turn or continuation segment ends."""
        with self._open_store(project_id) as (_, directory, records, data):
            task = self._find_task(data, turn_id)
            if task is None:
                return None
            if task.get('pendingModelTurnId') == str(turn_id):
                before_model = True
                task.pop('pendingModelTurnId')

            decision = next(
                (d for d in data['decisions'].values() if d.get('continuationId') == str(turn_id)),
                None,
            )
            if task['stage'] == 'waiting_input':
                if decision is not None and decision['status'] == 'resuming':
                    decision['status'] = 'completed'
                    task['pendingContinuationId'] = None
                self._write_raw(directory, data)
                return task

            saved_continuation_plan = decision is not None and self._has_continuation_plan(task, decision)
            if segment_status in {'interrupted', 'stopped'} and not saved_continuation_plan:
                if decision is not None and decision['status'] == 'resuming':
                    decision['status'] = 'resume_failed' if before_model else 'status_unknown'
                    decision['error'] = error
                    decision['errorCode'] = 'continuation_resume_failed' if before_model else 'continuation_status_unknown'
                    task['stage'] = 'answer_saved' if before_model else 'status_unknown'
                    task['error'] = decision['error']
                elif task.get('executionContinuationId') == str(turn_id):
                    if write_allowed(task, turn_id) and before_model:
                        task['stage'] = 'waiting_confirmation'
                        task['confirmedPlanRevision'] = None
                    task['error'] = error
                else:
                    task['stage'] = 'interrupted'
                    task['error'] = error
                self._write_raw(directory, data)
                return task

            if decision is not None and not saved_continuation_plan:
                decision['status'] = 'resume_failed'
                decision['errorCode'] = 'continuation_plan_missing'
                task['stage'] = 'answer_saved'
                self._write_raw(directory, data)
                return task

            if decision is not None and decision['status'] in {'resuming', 'status_unknown', 'answer_saved'}:
                self._complete_continuation(task, decision)
                if task['stage'] == 'status_unknown':
                    task['stage'] = 'resuming'

            if task.get('executionContinuationId') == str(turn_id):
                if write_allowed(task, turn_id):
                    jobs = {str(job.id): job for job in records[0].snapshot.jobs}
                    task['stage'] = execution_outcome(task, jobs)
            elif task['stage'] in {'planning', 'resuming', 'waiting_confirmation', 'running'}:
                plan_updated_in_turn = (
                    task['stage'] != 'running'
                    and task.get('plan') is not None
                    and task['plan'].get('updatedAtTurnId') == str(turn_id)
                )
                if plan_updated_in_turn:
                    task['stage'] = 'waiting_confirmation'
                elif task['stage'] != 'running' and task.get('plan') is not None:
                    task['stage'] = 'planning'
                elif task.get('planOnly') and reply_text.strip():
                    self._apply_plan_update_locked(task, reply_text.strip(), extract_plan_steps(reply_text), str(turn_id))
                    task['stage'] = 'waiting_confirmation'
                else:
                    task['stage'] = 'completed'

            self._write_raw(directory, data)
            return task

    def submit_answer(
        self,
        project_id: UUID,
        session: str,
        request_id: UUID | str,
        submission: DecisionAnswerSubmit,
    ) -> dict:
        snapshot = self.projects.snapshot(project_id).model_dump(mode='json')
        req_id = str(request_id)
        with self._open_store(project_id, session=session, open_project=True) as (_, directory, _, data):
            decision = data['decisions'].get(req_id)
            if decision is None:
                raise ProjectError('待回答的问题不存在。', 404, code='missing_object')
            task = data['tasks'].get(decision['taskId'])
            if task is None:
                raise ProjectError('所属对话任务不存在。', 404, code='missing_object')

            self._require_current_conversation(directory, task, project_id)
            normalized, fingerprint = normalize_answers(decision['questions'], submission.answers)

            if decision.get('answers') is not None and decision['status'] != 'invalidated':
                if decision.get('answerFingerprint') == fingerprint:
                    return {
                        'replayed': True,
                        'requestId': req_id,
                        'status': decision['status'],
                        'continuationId': decision['continuationId'],
                        'decision': decision,
                        'task': task,
                    }
                raise ProjectError('该问题已在其他页面提交了不同答案，已展示当前保存的结果。', 409, code='decision_answer_conflict')

            if decision['status'] == 'invalidated' or not related_versions_valid(snapshot, task, decision):
                decision['status'] = 'invalidated'
                if task.get('activeDecisionId') == req_id:
                    task['activeDecisionId'] = None
                self._write_raw(directory, data)
                raise ProjectError('相关素材或计划版本已变更，旧问题已失效，不会覆盖新内容。', 409, code='decision_version_invalidated')

            continuation_id = str(uuid5(UUID(req_id), 'continuation'))
            decision.update(
                answers=normalized,
                answerFingerprint=fingerprint,
                continuationId=continuation_id,
                status='answer_saved',
                error=None,
                errorCode=None,
            )
            task['stage'] = 'answer_saved'
            task['pendingContinuationId'] = continuation_id
            if continuation_id not in task['segmentTurnIds']:
                task['segmentTurnIds'].append(continuation_id)

            self._write_raw(directory, data)
            return {
                'replayed': False,
                'requestId': req_id,
                'status': 'answer_saved',
                'continuationId': continuation_id,
                'decision': decision,
                'task': task,
            }

    def claim_continuation(self, project_id: UUID, session: str, continuation_id: UUID | str) -> dict:
        """Atomically transition a continuation from answer_saved (or resume_failed) to resuming."""
        snapshot = self.projects.snapshot(project_id).model_dump(mode='json')
        cid = str(continuation_id)
        with self._open_store(project_id, session=session, open_project=True) as (_, directory, _, data):
            decision = next((d for d in data['decisions'].values() if d.get('continuationId') == cid), None)
            if decision is None:
                raise ProjectError('接续记录不存在。', 404, code='missing_object')
            task = data['tasks'].get(decision['taskId'])
            if task is None:
                raise ProjectError('所属对话任务不存在。', 404, code='missing_object')

            self._require_current_conversation(directory, task, project_id)
            if decision['status'] == 'completed':
                return {'state': 'already_completed', 'decision': decision, 'task': task}
            if decision['status'] == 'status_unknown':
                raise ProjectError('上一次接续执行状态待核对，为避免重复付费调用，未自动重发。', 409, code='continuation_status_unknown')
            if decision['status'] == 'resuming':
                return {'state': 'already_resuming', 'decision': decision, 'task': task}
            if decision['status'] == 'invalidated' or not related_versions_valid(snapshot, task, decision):
                decision['status'] = 'invalidated'
                self._write_raw(directory, data)
                raise ProjectError('相关素材或计划版本已变更，旧问题已失效，不会覆盖新内容。', 409, code='decision_version_invalidated')
            if decision['status'] not in {'answer_saved', 'resume_failed'}:
                raise ProjectError('当前问题尚未保存答案，无法接续。', 409, code='decision_not_answered')

            decision.update(status='resuming', error=None, errorCode=None)
            task['stage'] = 'resuming'
            task['pendingModelTurnId'] = cid
            if cid not in task['segmentTurnIds']:
                task['segmentTurnIds'].append(cid)
            self._write_raw(directory, data)
            return {'state': 'claimed', 'decision': decision, 'task': task}

    def claim_plan_execution(
        self,
        project_id: UUID,
        session: str,
        task_id: UUID | str,
        payload: PlanConfirmInput,
        *,
        inspect_only: bool = False,
    ) -> dict:
        tid = str(task_id)
        with self._open_store(project_id, session=session, open_project=True) as (_, directory, _, data):
            task = data['tasks'].get(tid)
            if task is None:
                raise ProjectError('对话任务不存在。', 404, code='missing_object')
            self._require_current_conversation(directory, task, project_id)
            if task.get('planOnly'):
                raise ProjectError('此任务只要求规划。', 409, code='plan_confirmation_required')
            if not task.get('plan') or int(task.get('planRevision', 0)) < 1:
                raise ProjectError('当前任务尚无可确认的计划版本。', 409, code='plan_missing')
            if int(payload.planRevision) != int(task['planRevision']):
                raise ProjectError('计划版本已变更，旧确认已失效，请确认最新计划版本。', 409, code='plan_revision_stale')
            if task.get('stage') == 'waiting_input':
                raise ProjectError('请先回答待决问题后再确认执行计划。', 409, code='task_waiting_input')
            if task.get('stage') == 'status_unknown':
                raise ProjectError('当前任务执行状态待核对，请先核对已生成产物或回执。', 409, code='continuation_status_unknown')

            exec_cid = str(uuid5(UUID(tid), f'execute:{payload.planRevision}'))
            if (
                task.get('confirmedPlanRevision') == payload.planRevision
                and task.get('executionContinuationId') == exec_cid
            ):
                if task['stage'] == 'completed':
                    return {'state': 'already_completed', 'continuationId': exec_cid, 'task': task}
                if (
                    task['stage'] in {'executing', 'interrupted'}
                    or any(r.get('turnId') == exec_cid for r in task.get('acceptedReceipts', []))
                    or any(p.get('turnId') == exec_cid for p in task.get('pendingWrites', []))
                ):
                    return {'state': 'already_executing', 'continuationId': exec_cid, 'task': task}

            if task['stage'] != 'waiting_confirmation':
                raise ProjectError('当前计划尚未准备好确认。', 409, code='plan_confirmation_required')
            if task.get('pendingWrites'):
                raise ProjectError('原操作状态待核对，暂不能执行新版计划。', 409, code='continuation_status_unknown')
            if inspect_only:
                return {'state': 'ready', 'continuationId': exec_cid, 'task': task}
            task['confirmedPlanRevision'] = payload.planRevision
            task['executionContinuationId'] = exec_cid
            task['stage'] = 'executing'
            task['pendingModelTurnId'] = exec_cid
            if exec_cid not in task['segmentTurnIds']:
                task['segmentTurnIds'].append(exec_cid)
            self._write_raw(directory, data)
            return {'state': 'claimed', 'continuationId': exec_cid, 'task': task}

    def mark_model_dispatched(self, project_id: UUID, task_id: UUID, turn_id: UUID) -> None:
        with self._open_store(project_id) as (_, directory, _, data):
            task = data['tasks'].get(str(task_id))
            if (
                task is None or task.get('pendingModelTurnId') != str(turn_id)
                or task['stage'] not in {'resuming', 'executing'}
            ):
                raise ProjectError('此执行片段的启动许可已失效。', 409, code='plan_revision_stale')
            task.pop('pendingModelTurnId')
            self._write_raw(directory, data)

    def adjust_plan(self, project_id: UUID, session: str, task_id: UUID | str, payload: PlanAdjustInput) -> dict:
        tid = str(task_id)
        with self._open_store(project_id, session=session, open_project=True) as (_, directory, records, data):
            task = data['tasks'].get(tid)
            if task is None:
                raise ProjectError('对话任务不存在。', 404, code='missing_object')
            self._require_current_conversation(directory, task, project_id)
            if payload.planRevision != task['planRevision']:
                raise ProjectError('计划版本已变更，请按最新版本调整。', 409, code='plan_revision_stale')
            if task['stage'] not in {'executing', 'waiting_confirmation', 'status_unknown', 'execution_failed'} or not task.get('plan'):
                raise ProjectError('当前计划不能调整。', 409, code='plan_confirmation_required')
            plan = task['plan']
            if task.get('executionContinuationId'):
                execution_outcome(task, {str(job.id): job for job in records[0].snapshot.jobs})
            if task['stage'] == 'status_unknown' and (
                task.get('pendingWrites') or not any(step['status'] == 'completed' for step in plan['steps'])
            ):
                raise ProjectError('原操作状态待核对，暂不能执行新版计划。', 409, code='continuation_status_unknown')
            task['confirmedPlanRevision'] = None
            summary = payload.prompt.strip() if payload.prompt else ''
            steps = extract_plan_steps(summary) if summary else self._plan_step_inputs(plan)
            self._apply_plan_update_locked(task, summary or plan['summary'], steps, plan['updatedAtTurnId'], force_revision=True)
            task['stage'] = 'waiting_confirmation'
            task.pop('pendingModelTurnId', None)
            self._write_raw(directory, data)
            return task

    def record_pending_write(
        self,
        project_id: UUID,
        turn_id: UUID,
        call_id: str,
        command_dict: dict,
        input_fingerprint: str,
        *,
        session: str | None = None,
    ) -> dict | None:
        """Fix operation identity before dispatch, or return an already-accepted receipt."""
        command_id = str(command_dict['commandId'])
        try:
            with self._open_existing_store(project_id) as (db, directory, data):
                if data is None:
                    return None
                task = self._find_task(data, turn_id)
                if task is None:
                    return None
                if session is not None:
                    self.projects._lease(db, project_id, directory, session)
                if not write_allowed(task, turn_id):
                    raise ProjectError('当前计划尚未确认，不能派发写入。', 409, code='plan_confirmation_required')
                if task['stage'] == 'running':
                    return None
                for existing in task.get('acceptedReceipts', []):
                    if existing.get('commandId') == command_id and not existing.get('receipt', {}).get('stepId'):
                        if existing.get('inputFingerprint') and existing['inputFingerprint'] != input_fingerprint:
                            raise ProjectError('工具调用标识被用于不同输入。', 409)
                        if not existing.get('retryable') and existing.get('receipt'):
                            return existing['receipt']

                pending = task.setdefault('pendingWrites', [])
                existing = next((item for item in pending if item.get('commandId') == command_id), None)
                if existing is not None:
                    if existing['inputFingerprint'] != input_fingerprint:
                        raise ProjectError('工具调用标识被用于不同输入。', 409)
                    raise ProjectError('原操作状态待核对，未重新派发。', 409, code='continuation_status_unknown')
                pending.append({
                    'commandId': command_id,
                    'callId': call_id,
                    'turnId': str(turn_id),
                    'type': command_dict['type'],
                    'inputFingerprint': input_fingerprint,
                    'command': command_dict,
                    'dispatchState': 'reserved',
                })
                self._write_raw(directory, data)
                return None
        except ProjectError as err:
            if err.status == 404:
                return None
            raise

    def begin_pending_write(self, project_id: UUID, turn_id: UUID, command_id: str, session: str) -> None:
        with self._open_existing_store(project_id) as (db, directory, data):
            if data is None:
                return
            task = self._find_task(data, turn_id)
            if task is None or task['stage'] == 'running':
                return
            pending = next((item for item in task.get('pendingWrites', []) if item['commandId'] == command_id), None)
            if pending is None or pending.get('dispatchState') != 'reserved' or pending['turnId'] != str(turn_id):
                raise ProjectError('该操作的派发状态已变更。', 409, code='continuation_status_unknown')
            try:
                self.projects._lease(db, project_id, directory, session)
                if not write_allowed(task, turn_id):
                    raise ProjectError('当前计划尚未确认，不能派发写入。', 409, code='plan_confirmation_required')
            except ProjectError:
                task['pendingWrites'].remove(pending)
                self._write_raw(directory, data)
                raise
            pending['dispatchState'] = 'dispatched'
            self._write_raw(directory, data)

    def command_id_for_write(self, project_id: UUID, turn_id: UUID, call_id: str) -> UUID:
        if call_id.startswith('cli:'):
            task = self.task_for_turn(project_id, turn_id)
            if task is not None and task['stage'] != 'running':
                for item in (*task.get('acceptedReceipts', []), *task.get('pendingWrites', [])):
                    if item.get('callId') == call_id and not item.get('receipt', {}).get('stepId'):
                        return UUID(item['commandId'])
        return agent_command_id(turn_id, call_id)

    def record_accepted_receipt(
        self,
        project_id: UUID,
        turn_id: UUID,
        call_id: str,
        command_dict: dict,
        input_fingerprint: str,
        receipt: dict,
    ) -> None:
        command_id = str(command_dict['commandId'])
        try:
            with self._open_existing_store(project_id) as (_, directory, data):
                if data is None:
                    return
                task = self._find_task(data, turn_id)
                if task is None or task['stage'] == 'running':
                    return
                task['pendingWrites'] = [p for p in task.get('pendingWrites', []) if p.get('commandId') != command_id]
                self._store_committed_receipt(
                    task,
                    self._receipt_entry(command_id, call_id, turn_id, command_dict['type'], receipt, input_fingerprint=input_fingerprint),
                )
                self._write_raw(directory, data)
        except ProjectError as err:
            if err.status == 404:
                return
            raise

    def record_pre_write_failure(
        self,
        project_id: UUID,
        turn_id: UUID,
        call_id: str,
        command_dict: dict,
        input_fingerprint: str,
        error: str,
        code: str | None = None,
    ) -> bool:
        """Record a failure proven to have occurred before any business write was committed."""
        command_id = str(command_dict['commandId'])
        try:
            with self._open_existing_store(project_id) as (_, directory, data):
                if data is None:
                    return False
                task = self._find_task(data, turn_id)
                if task is None or task['stage'] == 'running':
                    return False
                task['pendingWrites'] = [p for p in task.get('pendingWrites', []) if p.get('commandId') != command_id]
                existing_receipts = task.setdefault('acceptedReceipts', [])
                if any(r.get('commandId') == command_id and not r.get('retryable') for r in existing_receipts):
                    self._write_raw(directory, data)
                    return True
                task['acceptedReceipts'] = [r for r in existing_receipts if r.get('commandId') != command_id]
                task['acceptedReceipts'].append(
                    self._retryable_rejection(
                        command_id, call_id, turn_id, command_dict['type'], error,
                        code=code, input_fingerprint=input_fingerprint,
                    )
                )
                self._write_raw(directory, data)
                return True
        except ProjectError as err:
            if err.status == 404:
                return False
            raise

    def record_step_completion(
        self,
        project_id: UUID,
        turn_id: UUID,
        call_id: str,
        tool_name: str,
        summary: str,
        *,
        step_id: str | None = None,
    ) -> dict | None:
        """Record verifiable completion of a read or inspection step during plan execution."""
        try:
            with self._open_store(project_id) as (_, directory, _, data):
                task = self._find_task(data, turn_id)
                if task is None:
                    if step_id is not None:
                        raise ProjectError('找不到当前对话任务上下文。', 404, code='missing_object')
                    return None
                if not write_allowed(task, turn_id):
                    if step_id is not None:
                        raise ProjectError('当前计划尚未确认，不能标记执行步骤完成。', 409, code='plan_confirmation_required')
                    return None
                steps = (task.get('plan') or {}).get('steps', [])
                by_call = {f"cli:{step_operation_id(task, step)}": step for step in steps}
                by_id = {step['id']: step for step in steps}
                if step_id is not None:
                    target = by_id.get(step_id)
                    if target is None:
                        err = ProjectError(f'未知计划步骤：{step_id}。', 422, code='invalid_input')
                        err._invalid_tool_input = True
                        raise err
                    expected_call = f"cli:{step_operation_id(task, target)}"
                    if call_id != expected_call:
                        raise ProjectError('步骤标识与操作 ID 不一致。', 409)
                    effective_call = expected_call
                else:
                    target = by_call.get(call_id)
                    if target is None:
                        return None
                    effective_call = call_id

                kind = 'inspection' if step_id is not None else 'read'
                if target.get('kind', 'write') != kind:
                    if step_id is not None:
                        raise ProjectError('只有检查步骤可以登记检查结果。', 422, code='plan_step_kind_mismatch')
                    return None

                command_id = str(step_operation_id(task, target))
                receipt = {'status': 'verified', 'stepId': target['id'], 'tool': tool_name, 'summary': summary}
                existing_receipts = task.setdefault('acceptedReceipts', [])
                if not any(r.get('callId') == effective_call and not r.get('retryable') for r in existing_receipts):
                    task['acceptedReceipts'] = [
                        r for r in existing_receipts if not (r.get('callId') == effective_call and r.get('retryable'))
                    ]
                    task['acceptedReceipts'].append(
                        self._receipt_entry(command_id, effective_call, turn_id, tool_name, receipt)
                    )
                target['status'] = 'completed'
                self._write_raw(directory, data)
                return {
                    'status': 'completed',
                    'stepId': target['id'],
                    'taskId': task['taskId'],
                    'planRevision': task['planRevision'],
                    'task': task,
                }
        except ProjectError as err:
            if err.status == 404 and step_id is None:
                return None
            raise

    @staticmethod
    def _has_continuation_plan(task: dict, decision: dict) -> bool:
        plan = task.get('plan')
        return bool(
            plan and plan['updatedAtTurnId'] == decision.get('continuationId')
            and plan['revision'] > decision['planRevision']
        )

    @staticmethod
    def _complete_continuation(task: dict, decision: dict) -> None:
        decision.update(status='completed', error=None, errorCode=None)
        if task.get('activeDecisionId') == decision['requestId']:
            task['activeDecisionId'] = None
        if task.get('pendingContinuationId') == decision['continuationId']:
            task['pendingContinuationId'] = None

    def reconcile_interrupted(self, project_id: UUID, active_turn_id: UUID | None = None) -> dict:
        """Reconcile tasks and decisions after a server restart or crash without duplicate writes."""
        live_id = str(active_turn_id) if active_turn_id is not None else None
        with self.projects.local.transaction() as db:
            self.projects._recover()
            path, _ = self.projects._find(db, project_id)
            if not self._file(path).is_file():
                return {'tasks': {}, 'decisions': {}}
            directory, _, records = self.projects._load(db, project_id)
            data = self._read_raw(directory)
            snapshot = records[0].snapshot
            version_view = snapshot.model_dump(mode='json')
            jobs = {str(job.id): job for job in snapshot.jobs}
            changed = False
            resuming_decisions = {}

            for decision in data['decisions'].values():
                task = data['tasks'].get(decision['taskId'])
                if decision['status'] == 'resuming':
                    resuming_decisions[decision['taskId']] = decision
                elif decision['status'] in {'waiting_input', 'answer_saved', 'resume_failed'}:
                    if not related_versions_valid(version_view, task, decision):
                        decision['status'] = 'invalidated'
                        if task and task.get('activeDecisionId') == decision['requestId']:
                            task['activeDecisionId'] = None
                        changed = True

            for task in data['tasks'].values():
                if live_id is not None and (live_id == task['taskId'] or live_id in task.get('segmentTurnIds', [])):
                    continue

                remaining_pending: list[dict] = []
                for pending in list(task.get('pendingWrites', [])):
                    cmd_uuid = UUID(pending['commandId'])
                    uncertain = False
                    committed = None
                    if pending['type'] == 'timeline_package_import':
                        try:
                            request = TimelinePackageImportFile.model_validate(pending['command']['payload'])
                            result = CreationTimelinePackages(self.projects).reconcile_execution_import(project_id, request)
                        except (ProjectError, ValueError, KeyError, OSError):
                            uncertain = True
                        else:
                            if result is not None:
                                uncertain = result.status == 'registered'
                                if not uncertain:
                                    committed = {'status': result.status, 'result': result.model_dump(mode='json')}
                    else:
                        try:
                            if pending['type'] in {'voice_create', 'voice_delete'}:
                                uncertain = pending.get('dispatchState') != 'reserved'
                            else:
                                committed = self.projects.receipt(project_id, cmd_uuid).model_dump(mode='json')
                        except ProjectError as err:
                            if err.status != 404:
                                raise

                    if committed is not None:
                        self._store_committed_receipt(
                            task,
                            self._receipt_entry(
                                pending['commandId'], pending['callId'], pending['turnId'], pending['type'],
                                committed, input_fingerprint=pending.get('inputFingerprint'),
                            ),
                        )
                        changed = True
                    elif uncertain:
                        remaining_pending.append(pending)
                    elif pending.get('dispatchState') != 'reserved':
                        if not any(r.get('commandId') == pending['commandId'] for r in task.get('acceptedReceipts', [])):
                            task.setdefault('acceptedReceipts', []).append(
                                self._retryable_rejection(
                                    pending['commandId'], pending['callId'], pending['turnId'], pending['type'],
                                    '操作在提交工程写入前中断，可按原输入重试。',
                                    input_fingerprint=pending.get('inputFingerprint'),
                                )
                            )
                        changed = True

                if remaining_pending != task.get('pendingWrites', []):
                    task['pendingWrites'] = remaining_pending
                    changed = True

                pending_model = task.pop('pendingModelTurnId', None)
                if pending_model:
                    changed = True
                decision = resuming_decisions.get(task['taskId'])
                if decision is not None and self._has_continuation_plan(task, decision):
                    self._complete_continuation(task, decision)
                    changed = True
                elif task['stage'] == 'resuming':
                    can_retry = decision is not None and decision.get('continuationId') == pending_model
                    task['stage'] = 'answer_saved' if can_retry else 'status_unknown'
                    if decision is not None:
                        decision['status'] = 'answer_saved' if can_retry else 'status_unknown'
                    changed = True
                if task['stage'] == 'executing' and pending_model == task.get('executionContinuationId') and pending_model:
                    task['stage'] = 'waiting_confirmation'
                    task['confirmedPlanRevision'] = None
                    changed = True
                elif (
                    task['stage'] in {'executing', 'status_unknown', 'waiting_jobs'}
                    and task.get('executionContinuationId')
                    and task.get('confirmedPlanRevision') == task.get('planRevision')
                ):
                    previous_steps = [step['status'] for step in (task.get('plan') or {}).get('steps', [])]
                    next_stage = execution_outcome(task, jobs)
                    changed = changed or task['stage'] != next_stage or previous_steps != [
                        step['status'] for step in (task.get('plan') or {}).get('steps', [])
                    ]
                    task['stage'] = next_stage

            if changed:
                self._write_raw(directory, data)
            return data

    def public_state(self, project_id: UUID, conversation_id: UUID | str, active_turn_id: UUID | None = None) -> dict:
        data = self.reconcile_interrupted(project_id, active_turn_id)
        cid = str(conversation_id)
        return {
            'tasks': [task for task in data['tasks'].values() if task.get('conversationId') == cid],
            'decisions': [dec for dec in data['decisions'].values() if dec.get('conversationId') == cid],
        }
