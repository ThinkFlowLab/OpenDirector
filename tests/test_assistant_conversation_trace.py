
import pytest
import json
from uuid import UUID, uuid4, uuid5

from test_assistant_conversations import assistant, send  # noqa: F401


pytestmark = pytest.mark.cpu


def conversation_file(tmp_path):
    return next(tmp_path.rglob('agent-runs/conversation.json'))


def test_trace_lists_executed_turns_in_order_with_their_own_runtime(assistant, tmp_path):
    client, path, _ = assistant
    conversation = client.get(path).json()['conversationId']
    for text in ('第一轮', '第二轮', '第三轮'):
        send(client, path, conversation, text)
    file = conversation_file(tmp_path)
    saved = json.loads(file.read_text())
    ids = [message['id'] for message in saved['messages'] if message['role'] == 'user']
    # Turns keep the runtime persisted with them, not one for the whole conversation.
    saved['messages'][3]['runtime'] = 'codex'
    saved['messages'][5]['runtime'] = 'deepseek'
    file.write_text(json.dumps(saved))

    trace_url = f'{path}/conversations/{conversation}/trace'
    result = client.get(trace_url)
    assert result.status_code == 200
    body = result.json()
    assert body['conversationId'] == conversation and body['active'] is True
    assert [(turn['id'], turn['number'], turn['text'], turn['runtime']) for turn in body['turns']] == [
        (ids[0], 1, '第一轮', 'default'), (ids[1], 2, '第二轮', 'codex'), (ids[2], 3, '第三轮', 'deepseek')]
    assert all(turn['status'] == 'complete' for turn in body['turns'])

    continuation, execution, orphan = (str(uuid4()) for _ in range(3))
    for index, turn_id, kind in ((2, continuation, 'continuation'), (5, execution, 'execution'), (6, orphan, 'unknown')):
        saved['messages'].insert(index, {
            'id': str(uuid5(UUID(turn_id), 'assistant')), 'role': 'assistant',
            'turnId': turn_id, 'segmentKind': kind, 'text': kind, 'status': 'complete',
        })
    file.write_text(json.dumps(saved))

    turns = client.get(trace_url).json()['turns']
    assert [(turn['id'], turn['number']) for turn in turns] == [
        (ids[0], 1), (continuation, 2), (ids[1], 3), (execution, 4), (ids[2], 5),
    ]
    for turn_id in (continuation, execution):
        assert client.get(f'{path}/traces/{turn_id}/conversation').json() == {'conversationId': conversation}
    assert client.get(f'{path}/traces/{orphan}/conversation').status_code == 404


def test_trace_ignores_messages_that_never_executed_and_does_not_pair_by_position(assistant, tmp_path):
    client, path, _ = assistant
    conversation = client.get(path).json()['conversationId']
    send(client, path, conversation, '已执行')
    file = conversation_file(tmp_path)
    saved = json.loads(file.read_text())
    executed = saved['messages'][0]['id']
    # A queued or inserted user message sits between executed turns without an assistant record.
    saved['messages'].insert(1, {'id': str(uuid4()), 'role': 'user', 'text': '排队中'})
    saved['messages'].insert(0, {'id': 'not-a-uuid', 'role': 'user', 'text': '坏数据'})
    saved['messages'].append({'id': str(uuid4()), 'role': 'assistant', 'text': '孤立回复', 'status': 'complete'})
    file.write_text(json.dumps(saved))

    turns = client.get(f'{path}/conversations/{conversation}/trace').json()['turns']
    assert [(turn['id'], turn['text']) for turn in turns] == [(executed, '已执行')]


def test_interrupted_streaming_turn_is_not_reported_as_running(assistant, tmp_path):
    client, path, _ = assistant
    conversation = client.get(path).json()['conversationId']
    send(client, path, conversation, '中断')
    file = conversation_file(tmp_path)
    saved = json.loads(file.read_text())
    saved['messages'][1]['status'] = 'streaming'
    file.write_text(json.dumps(saved))
    turns = client.get(f'{path}/conversations/{conversation}/trace').json()['turns']
    assert turns[0]['status'] == 'interrupted'


def test_trace_resolves_archived_and_aliased_conversations_without_activating(assistant, tmp_path):
    client, path, _ = assistant
    first = client.get(path).json()['conversationId']
    send(client, path, first, '旧对话')
    second = str(uuid4())
    assert client.post(path + '/conversations', json={'id': second}).status_code == 200
    send(client, path, second, '新对话')
    before = conversation_file(tmp_path).read_bytes()

    archived = client.get(f'{path}/conversations/{first}/trace').json()
    current = client.get(f'{path}/conversations/{second}/trace').json()
    assert archived['active'] is False and [turn['text'] for turn in archived['turns']] == ['旧对话']
    assert current['active'] is True and [turn['text'] for turn in current['turns']] == ['新对话']
    assert conversation_file(tmp_path).read_bytes() == before
    assert client.get(path + '/conversations').json()['activeId'] == second

    saved = json.loads(before)
    saved['reusedCreateIds'] = [str(uuid4())]
    alias = saved['reusedCreateIds'][0]
    conversation_file(tmp_path).write_text(json.dumps(saved))
    assert client.get(f'{path}/conversations/{alias}/trace').json()['conversationId'] == second


def test_trace_of_unknown_conversation_is_404_and_empty_conversation_has_no_turns(assistant):
    client, path, _ = assistant
    assert client.get(f'{path}/conversations/{uuid4()}/trace').status_code == 404
    conversation = client.get(path).json()['conversationId']
    assert client.get(f'{path}/conversations/{conversation}/trace').json()['turns'] == []


def test_turn_resolves_to_its_own_conversation_including_archived(assistant):
    client, path, _ = assistant
    first = client.get(path).json()['conversationId']
    send(client, path, first, '旧对话')
    old_turn = client.get(f'{path}/conversations/{first}/trace').json()['turns'][0]['id']
    second = str(uuid4())
    client.post(path + '/conversations', json={'id': second})
    send(client, path, second, '新对话')
    new_turn = client.get(f'{path}/conversations/{second}/trace').json()['turns'][0]['id']
    assert client.get(f'{path}/traces/{old_turn}/conversation').json() == {'conversationId': first}
    assert client.get(f'{path}/traces/{new_turn}/conversation').json() == {'conversationId': second}
    assert client.get(f'{path}/traces/{uuid4()}/conversation').status_code == 404
    assert client.get(path + '/conversations').json()['activeId'] == second
