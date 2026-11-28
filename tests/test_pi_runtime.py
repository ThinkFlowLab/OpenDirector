import asyncio
from contextlib import aclosing
import json
from pathlib import Path
from uuid import uuid4

import pytest
from process_helpers import python_cli

from opendirector.agent import pi
from opendirector.agent.catalog import model_choices
from opendirector.agent.context import RunContext
from opendirector.agent.runtime import AgentRuntimes, runtime_readiness, runtime_spec
from opendirector.domain.projects import ProjectError


TABLE = '''provider       model                context  max-out  thinking  images
acme           think-fast           1M       32K      yes      yes
acme           plain                200K     8K       no       no
other          other-model          1M       32K      yes      no
'''

FAKE = r'''import json, os, sys
from pathlib import Path
mode = os.environ.get('PI_TEST', 'success')
args = sys.argv[1:]
if '--version' in args:
    print('1.6.0')
    raise SystemExit(0 if mode != 'broken' else 1)
if '--list-models' in args:
    if mode == 'no_catalog':
        print('cannot read models')
        raise SystemExit(1)
    if mode == 'bad_catalog':
        print('some other output')
        raise SystemExit(0)
    if mode == 'no_models':
        print('provider       model                context  max-out  thinking  images')
        raise SystemExit(0)
    print(os.environ['PI_TABLE'], end='')
    raise SystemExit(0)
if args[:2] == ['auth', 'check']:
    provider = args[args.index('--provider') + 1]
    raise SystemExit(0 if provider == os.environ.get('PI_READY_PROVIDER', 'acme') else 1)
prompt = sys.stdin.read()
Path(os.environ['PI_RECORD']).write_text(json.dumps(
    {'argv': args, 'prompt': prompt, 'cwd': os.getcwd(), 'session_dir_exists': Path(args[args.index('--session-dir') + 1]).is_dir()}))
def emit(value):
    print(json.dumps(value), flush=True)
def message(role, stop='stop', text='', error=None):
    return {'type': 'message_start', 'message': {'role': role, 'content': []}} if role == 'start' \
        else {'type': 'message_end', 'message': {'role': 'assistant', 'stopReason': stop,
              'errorMessage': error, 'content': [{'type': 'text', 'text': text}]}}
def delta(text):
    return {'type': 'message_update', 'assistantMessageEvent': {'type': 'text_delta', 'delta': text}}
def end(stop='stop', error=None):
    return {'type': 'agent_end', 'messages': [{'role': 'assistant', 'stopReason': stop, 'errorMessage': error}]}
emit({'type': 'session', 'version': 3, 'id': 'pi-session-1', 'cwd': os.getcwd()})
emit({'type': 'agent_start'})
emit(message('start'))
if mode == 'error':
    emit(delta('Partial'))
    emit(message('assistant', 'error', 'Partial', 'HTTP 429: quota exceeded'))
    emit(end('error', 'HTTP 429: quota exceeded'))
    emit({'type': 'agent_settled'})
    raise SystemExit(0)
emit(delta('Hel'))
emit(delta('lo.'))
emit(message('assistant', 'stop', 'Hello.'))
if mode == 'retry':
    emit({'type': 'auto_retry_start', 'attempt': 1, 'maxAttempts': 3, 'delayMs': 10,
        'errorMessage': 'HTTP 429'})
emit(message('start'))
emit(delta(' More'))
emit(message('assistant', 'stop', 'Hello. More'))
emit(message('assistant', 'stop', 'Hello. More'))
emit(end())
emit({'type': 'agent_settled'})
'''


@pytest.fixture
def cli(tmp_path, monkeypatch):
    binary = python_cli(tmp_path / 'pi', FAKE)
    monkeypatch.setattr('opendirector.agent.native.executable', lambda _: str(binary))
    monkeypatch.setattr('opendirector.agent.catalog.executable', lambda _: str(binary))
    record = tmp_path / 'record.json'
    monkeypatch.setenv('PI_RECORD', str(record))
    monkeypatch.setenv('PI_TABLE', TABLE)
    return record


def run(tmp_path, *, messages=None, thinking='auto', selected=(), conversation=None):
    return RunContext(runtime='pi', project_id=uuid4(), turn_id=uuid4(), session='test',
        conversation_id=conversation or uuid4(), directory=tmp_path / 'project', config=None,
        messages=messages or [{'role': 'user', 'content': 'Make a video'}],
        runtime_model='acme/think-fast', thinking=thinking, selected_skills=list(selected),
        skills=[])


def collect(context):
    async def consume():
        events = []
        async with aclosing(AgentRuntimes(None, None, None).stream(context)) as stream:
            async for event in stream:
                events.append(event)
        return events
    return asyncio.run(consume())


def test_parse_models_reads_thinking_and_images():
    rows = pi.parse_models(TABLE)
    assert [row['id'] for row in rows] == ['acme/think-fast', 'acme/plain', 'other/other-model']
    assert rows[0]['efforts'] == list(pi.THINKING)
    assert rows[1]['efforts'] == []
    with pytest.raises(ValueError):
        pi.parse_models('command not found\n')


@pytest.mark.parametrize(('mode', 'expected'), [
    ('success', ['acme/think-fast', 'acme/plain', 'other/other-model']),
    ('no_models', []),
])
def test_catalog_lists_models(cli, monkeypatch, mode, expected):
    monkeypatch.setenv('PI_TEST', mode)
    assert [row['id'] for row in asyncio.run(model_choices('pi'))] == expected


@pytest.mark.parametrize('mode', ['no_catalog', 'bad_catalog'])
def test_catalog_failure_is_reported(cli, monkeypatch, mode):
    monkeypatch.setenv('PI_TEST', mode)
    with pytest.raises(ProjectError) as error:
        asyncio.run(model_choices('pi'))
    assert error.value.status == 503


@pytest.mark.parametrize(('mode', 'ready_provider', 'expected'), [
    ('success', 'acme', 'ready'),
    ('success', 'other', 'ready'),
    ('logged_out', '', 'needs_login'),
    ('no_models', '', 'needs_configuration'),
    ('bad_catalog', '', 'unknown'),
    ('no_catalog', '', 'unknown'),
    ('broken', '', 'unknown'),
])
def test_readiness_probes_version_catalog_and_login(cli, monkeypatch, mode, ready_provider, expected):
    monkeypatch.setenv('PI_TEST', mode)
    monkeypatch.setenv('PI_READY_PROVIDER', ready_provider)
    assert asyncio.run(runtime_readiness('pi')) == expected


def test_missing_install(monkeypatch):
    monkeypatch.setattr('opendirector.agent.native.executable', lambda _: None)
    assert asyncio.run(runtime_readiness('pi')) == 'not_installed'


def test_runtime_spec_is_a_native_skill_harness():
    spec = runtime_spec('pi')
    assert (spec.label, spec.group, spec.modelSource, spec.modelOverride) == ('Pi', 'harness', 'cli', True)
    assert spec.supportsSkills


def test_turn_streams_argv_and_finalizes_text_once(cli, tmp_path):
    events = collect(run(tmp_path))
    text = ''.join(event['text'] for event in events if event['type'] == 'delta')
    assert text == 'Hello. More'
    record = json.loads(cli.read_text())
    argv = record['argv']
    assert argv[:2] == ['--mode', 'json']
    assert '--print' in argv and '--approve' in argv
    assert argv[argv.index('--tools') + 1] == 'read,bash,write,edit'
    assert argv[argv.index('--model') + 1] == 'acme/think-fast'
    assert '--thinking' not in argv
    system = argv[argv.index('--append-system-prompt') + 1]
    assert 'opendirector' in system and 'text and images only' in system
    assert record['session_dir_exists']
    assert Path(argv[argv.index('--session-dir') + 1]).name == 'native'
    assert 'Make a video' in record['prompt']


def test_thinking_and_skill_reach_the_cli(cli, tmp_path):
    collect(run(tmp_path, thinking='high', selected=['example']))
    argv = json.loads(cli.read_text())['argv']
    assert argv[argv.index('--thinking') + 1] == 'high'
    prompt = json.loads(cli.read_text())['prompt']
    assert '.agents/skills/example/SKILL.md' in prompt


def test_resume_keeps_the_workspace_and_skips_history(cli, tmp_path):
    conversation = uuid4()
    collect(run(tmp_path, conversation=conversation))
    work = json.loads(cli.read_text())['cwd']
    later = run(tmp_path, conversation=conversation, messages=[{'role': 'user', 'content': 'Make a video'},
        {'role': 'assistant', 'content': 'Hello. More'}, {'role': 'user', 'content': 'And a title'}])
    collect(later)
    record = json.loads(cli.read_text())
    assert record['argv'][record['argv'].index('--session-id') + 1] == 'pi-session-1'
    assert record['cwd'] == work
    assert 'Make a video' not in record['prompt'] and 'And a title' in record['prompt']


@pytest.mark.parametrize(('mode', 'text', 'error'), [
    ('error', 'Partial', '429'),
    ('retry', 'Hello. More', None),
])
def test_only_a_settled_error_fails_the_turn(cli, tmp_path, monkeypatch, mode, text, error):
    monkeypatch.setenv('PI_TEST', mode)
    if error:
        with pytest.raises(ProjectError, match=error):
            collect(run(tmp_path))
    else:
        events = collect(run(tmp_path))
        body = ''.join(event['text'] for event in events if event['type'] == 'delta')
        assert body == text and body.count('Hello. More') == 1
    trace = next(tmp_path.rglob('*.pi.jsonl')).read_text()
    assert 'auto_retry_start' in trace if mode == 'retry' else 'quota exceeded' in trace


def test_runtime_ids_and_api_models_admit_every_runtime():
    """A new runtime must reach the request models, not only the local registry.

    `RuntimeId` moved out of `agent/context.py` into `domain/agent_runtime.py`, so
    adding a harness name in the old place compiles and passes every local test
    while the API rejects the turn.
    """
    from typing import get_args

    from opendirector.agent.context import RuntimeId
    from opendirector.agent.runtime import RUNTIMES
    from opendirector_api.agent import Draft, Turn

    declared = set(get_args(RuntimeId))
    assert set(RUNTIMES) <= declared, set(RUNTIMES) - declared
    for name in RUNTIMES:
        assert Turn(id=uuid4(), text='hi', runtime=name).runtime == name
        assert Draft(runtime=name).runtime == name
