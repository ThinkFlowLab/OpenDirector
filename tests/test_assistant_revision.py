"""Tests for editing and resending a stopped user turn (#375).

Covered behaviours follow the agreed design:

* ``revisionOf`` links a new turn back to the turn it replaces; the active path
  is derived by following that chain, not by slicing ``messages`` positionally.
* ``expectedRevision`` guards concurrent writes inside the same transaction.
* A revision carries a snapshot of the original turn's accepted jobs.
"""
import json
import threading
import time
from io import BytesIO
from uuid import uuid4

from PIL import Image

from fastapi.testclient import TestClient
import pytest

from opendirector.infrastructure.local_projects import LocalProjects
from opendirector_api.main import create_app
from opendirector_api import agent


def frames(response):
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]


async def empty_skills(*args):
    return []


@pytest.fixture
def assistant(tmp_path, monkeypatch):
    contexts = []
    # Replies stay streaming until released, so a stop request is what ends a
    # turn and the server records ``stopped`` instead of ``complete``.
    release = threading.Event()

    async def stream(self, run):
        contexts.append(run.messages)
        # Emit the tool record before waiting, so a stopped turn still owns the
        # accepted job a revision has to inherit.
        yield {'type': 'tool', 'id': 'call-known', 'name': 'run_command', 'status': 'complete'}
        while not release.is_set():
            import asyncio
            await asyncio.sleep(0.01)
        yield {'type': 'delta', 'text': 'REVISED-ATTEMPT' if len(contexts) > 1 else 'FIRST-ATTEMPT'}

    monkeypatch.setattr(agent.AgentRuntimes, 'stream', stream)
    monkeypatch.setattr(agent, 'runtime_available', lambda _: True)
    monkeypatch.setattr(agent, 'skills', empty_skills)
    from opendirector.infrastructure.model_configs import ModelConfigs
    config = {'id': str(uuid4()), 'modelId': 'test-model', 'kind': 'agent', 'url': 'http://models.test/v1',
              'connectionType': 'api', 'protocol': 'openai', 'authMode': 'none', 'apiKey': ''}
    monkeypatch.setattr(ModelConfigs, 'resolve', lambda *args: dict(config))
    with TestClient(create_app(LocalProjects(tmp_path)), headers={
        'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': str(uuid4())}) as client:
        pid = str(uuid4())
        root = f'/api/creation/projects/{pid}'
        assert client.post(root + '/commands', json={'type': 'project.create', 'projectId': pid,
            'commandId': str(uuid4()), 'payload': {'name': '修订'}}).status_code == 200
        assert client.post(root + '/open').status_code == 200
        yield client, root + '/assistant', contexts, release


def open_turn(client, path, conversation_id, text, *, revision_of=None, assets=()):
    """Send a turn without waiting for its reply, and return (thread, turn id)."""
    body = {'id': str(uuid4()), 'runtime': 'default', 'conversationId': conversation_id, 'text': text}
    if revision_of is not None:
        body['revisionOf'] = revision_of
    if assets:
        body['assets'] = list(assets)
    captured = {}

    def run():
        captured['response'] = client.post(path + '/turns', json=body)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    deadline = time.time() + 10
    while time.time() < deadline:
        state = client.get(path).json()
        streaming = [message for message in state['messages'] if message.get('status') == 'streaming']
        if streaming:
            break
        time.sleep(0.02)
    turn = body['id']
    return thread, turn, captured


def finish(client, path, thread, turn, captured):
    assert client.post(f'{path}/turns/{turn}/stop').status_code == 200
    thread.join(timeout=10)
    assert not thread.is_alive(), 'the stopped turn did not end'
    return captured['response']


def error_of(response):
    ends = [frame for frame in frames(response) if frame['type'] == 'end']
    assert ends, response.text
    return ends[-1]['error']


def conversation(client, path):
    response = client.get(path)
    assert response.status_code == 200, response.text
    return response.json()


def test_revised_attempt_replaces_the_stopped_turn_on_the_active_path(assistant):
    client, path, contexts, release = assistant
    active = conversation(client, path)['conversationId']
    thread, original, captured = open_turn(client, path, active, 'OLD-标记')
    finish(client, path, thread, original, captured)
    assert conversation(client, path)['messages'][-1]['status'] == 'stopped'

    release.set()
    revised = client.post(path + '/turns', json={'id': str(uuid4()), 'runtime': 'default',
        'conversationId': active, 'text': 'NEW-标记', 'revisionOf': original})
    assert revised.status_code == 200, revised.text
    assert error_of(revised) is None, error_of(revised)

    seen = json.dumps(contexts[-1], ensure_ascii=False)
    assert 'NEW-标记' in seen
    assert 'OLD-标记' not in seen, 'the replaced request must leave the active path'

    saved = conversation(client, path)
    assert [message['id'] for message in saved['messages']].count(original) == 1, \
        'the stopped turn is kept for history, not rewritten'
    assert saved['messages'][-2].get('revisionOf') == original
    # Later turns continue from the revised attempt, not from the replaced one.
    again = client.post(path + '/turns', json={'id': str(uuid4()), 'runtime': 'default',
        'conversationId': active, 'text': 'third'})
    assert error_of(again) is None, error_of(again)
    later = json.dumps(contexts[-1], ensure_ascii=False)
    assert 'third' in later
    assert 'OLD-标记' not in later


def test_revision_of_an_unrelated_turn_is_rejected(assistant):
    client, path, contexts, release = assistant
    release.set()
    active = conversation(client, path)['conversationId']
    assert error_of(client.post(path + '/turns', json={'id': str(uuid4()), 'runtime': 'default',
        'conversationId': active, 'text': 'seed'})) is None
    response = client.post(path + '/turns', json={'id': str(uuid4()), 'runtime': 'default',
        'conversationId': active, 'text': 'x', 'revisionOf': str(uuid4())})
    assert response.status_code == 200, response.text
    assert error_of(response), 'an unknown turn cannot be revised'


def test_a_turn_that_is_not_the_newest_cannot_be_revised(assistant):
    client, path, contexts, release = assistant
    release.set()
    active = conversation(client, path)['conversationId']
    for text in ('first', 'second'):
        assert error_of(client.post(path + '/turns', json={'id': str(uuid4()), 'runtime': 'default',
            'conversationId': active, 'text': text})) is None
    first = [message for message in conversation(client, path)['messages'] if message['role'] == 'user'][0]['id']
    response = client.post(path + '/turns', json={'id': str(uuid4()), 'runtime': 'default',
        'conversationId': active, 'text': 'too late', 'revisionOf': first})
    assert response.status_code == 200, response.text
    assert error_of(response), 'only the newest turn can be revised'


def test_a_turn_cannot_be_revised_twice(assistant):
    client, path, contexts, release = assistant
    active = conversation(client, path)['conversationId']
    thread, original, captured = open_turn(client, path, active, 'OLD-标记')
    finish(client, path, thread, original, captured)

    release.set()
    first = client.post(path + '/turns', json={'id': str(uuid4()), 'runtime': 'default',
        'conversationId': active, 'text': 'NEW-标记', 'revisionOf': original})
    assert error_of(first) is None, error_of(first)
    again = client.post(path + '/turns', json={'id': str(uuid4()), 'runtime': 'default',
        'conversationId': active, 'text': 'NEW-again', 'revisionOf': original})
    assert again.status_code == 200, again.text
    assert error_of(again), 'a turn can only be revised once'


def test_expected_revision_blocks_a_concurrent_write(assistant):
    client, path, contexts, release = assistant
    release.set()
    active = conversation(client, path)['conversationId']
    assert error_of(client.post(path + '/turns', json={'id': str(uuid4()), 'runtime': 'default',
        'conversationId': active, 'text': 'seed'})) is None
    revision = conversation(client, path)['revision']

    fresh = client.post(path + '/turns', json={'id': str(uuid4()), 'runtime': 'default',
        'conversationId': active, 'text': 'second', 'expectedRevision': revision})
    assert error_of(fresh) is None, error_of(fresh)
    stale = client.post(path + '/turns', json={'id': str(uuid4()), 'runtime': 'default',
        'conversationId': active, 'text': 'third', 'expectedRevision': revision})
    assert stale.status_code == 200, stale.text
    assert error_of(stale), 'a stale expectedRevision must not overwrite'


def test_revision_snapshots_the_stopped_turns_tool_records(assistant):
    client, path, contexts, release = assistant
    active = conversation(client, path)['conversationId']
    thread, original, captured = open_turn(client, path, active, 'OLD-标记')
    finish(client, path, thread, original, captured)
    assert conversation(client, path)['messages'][-1]['status'] == 'stopped'

    release.set()
    revised = client.post(path + '/turns', json={'id': str(uuid4()), 'runtime': 'default',
        'conversationId': active, 'text': 'NEW-标记', 'revisionOf': original})
    assert error_of(revised) is None, error_of(revised)
    new_turn = frames(revised)[0]['conversation']['messages'][-2]
    assert new_turn.get('inheritedJobs'), 'the snapshot is written together with the new turn'
    assert [job['callId'] for job in new_turn['inheritedJobs']] == ['call-known']
    from uuid import UUID
    expected = str(agent.agent_command_id(UUID(original), 'call-known'))
    assert [job['commandId'] for job in new_turn['inheritedJobs']] == [expected]


def test_inherited_jobs_resolves_the_job_receipt_by_call_id():
    """The snapshot carries the idempotency key and, when one exists, the job."""
    from types import SimpleNamespace
    from uuid import UUID

    turn = str(uuid4())
    reply_id = str(agent.uuid5(UUID(turn), 'assistant'))
    messages = [
        {'id': turn, 'role': 'user', 'text': 'OLD'},
        {'id': reply_id, 'role': 'assistant', 'status': 'stopped',
         'tools': [{'id': 'call-done', 'name': 'generate', 'status': 'running'},
                   {'id': 'call-lost', 'name': 'generate', 'status': 'failed'}]},
    ]
    job = SimpleNamespace(id=uuid4(), agentRunId=turn, agentCallId='call-done', status='succeeded',
                          asset=None, errorDetails=None)
    snapshot = agent.inherited_jobs(messages, turn, [job])

    done = next(item for item in snapshot if item['callId'] == 'call-done')
    lost = next(item for item in snapshot if item['callId'] == 'call-lost')
    # The accepted job is resolved to its id.
    assert done['jobId'] == str(job.id)
    assert done['commandId'] == str(agent.agent_command_id(UUID(turn), 'call-done'))
    # A call that never produced a job keeps its command id and reports no job.
    assert lost['jobId'] is None
    assert lost['commandId'] == str(agent.agent_command_id(UUID(turn), 'call-lost'))
    # Only identity is persisted: a status or asset copied here would go stale as
    # the job progresses, and the expanded view would report a state that is no
    # longer true. The job id is the handle a live lookup needs.
    for item in snapshot:
        assert set(item) == {'commandId', 'callId', 'name', 'jobId'}, item


def test_a_running_turn_rejects_a_concurrent_submission(assistant):
    """A second submit while a turn is running is refused before it streams."""
    client, path, contexts, release = assistant
    active = conversation(client, path)['conversationId']
    thread, original, captured = open_turn(client, path, active, 'OLD-标记')
    try:
        blocked = client.post(path + '/turns', json={'id': str(uuid4()), 'runtime': 'default',
            'conversationId': active, 'text': 'concurrent', 'revisionOf': original})
        assert blocked.status_code == 409, blocked.text
    finally:
        finish(client, path, thread, original, captured)
    # The refused submission left no trace.
    texts = [message.get('text') for message in conversation(client, path)['messages']]
    assert 'concurrent' not in texts


def test_the_revision_survives_reloading_the_conversation(assistant):
    """Both attempts stay inspectable; the active path still excludes the old one."""
    client, path, contexts, release = assistant
    active = conversation(client, path)['conversationId']
    thread, original, captured = open_turn(client, path, active, 'OLD-标记')
    finish(client, path, thread, original, captured)
    release.set()
    revised_id = str(uuid4())
    revised = client.post(path + '/turns', json={'id': revised_id, 'runtime': 'default',
        'conversationId': active, 'text': 'NEW-标记', 'revisionOf': original})
    assert error_of(revised) is None, error_of(revised)

    reloaded = conversation(client, path)
    users = [message for message in reloaded['messages'] if message['role'] == 'user']
    # The replaced request is kept for inspection, not rewritten.
    assert [message['text'] for message in users] == ['OLD-标记', 'NEW-标记']
    assert next(message for message in users if message['id'] == revised_id)['revisionOf'] == original
    assert reloaded['revision'] == conversation(client, path)['revision']


def test_the_revised_attempt_keeps_attachments_of_the_edited_message(assistant):
    client, path, contexts, release = assistant
    active = conversation(client, path)['conversationId']
    base = path.removesuffix('/assistant')
    image = BytesIO()
    Image.new('RGB', (5, 4), 'purple').save(image, format='PNG')
    handle = str(uuid4())
    assert client.put(base + '/uploads/' + handle, content=image.getvalue(),
        headers={'X-Asset-Name': 'keep.png'}).status_code == 200
    imported = client.post(base + '/commands', json={'type': 'asset.import',
        'commandId': str(uuid4()), 'projectId': base.rsplit('/', 1)[-1],
        'payload': {'uploadHandle': handle, 'name': 'keep.png', 'expectedKind': 'image'}})
    assert imported.status_code == 200, imported.text
    asset = imported.json()['changed'][0]['id']

    thread, original, captured = open_turn(client, path, active, 'OLD-标记', assets=[asset])
    finish(client, path, thread, original, captured)
    assert conversation(client, path)['messages'][-1]['status'] == 'stopped'
    assert conversation(client, path)['messages'][-2]['assets'][0]['id'] == asset

    release.set()
    revised = client.post(path + '/turns', json={'id': str(uuid4()), 'runtime': 'default',
        'conversationId': active, 'text': 'NEW-标记', 'revisionOf': original,
        'assets': [asset]})
    assert error_of(revised) is None, error_of(revised)
    new_turn = frames(revised)[0]['conversation']['messages'][-2]
    assert [item['id'] for item in new_turn.get('assets') or []] == [asset]
    # The reference still reaches the runtime context of the revised attempt.
    assert asset in json.dumps(contexts[-1], ensure_ascii=False)
