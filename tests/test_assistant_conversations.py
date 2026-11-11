import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import threading
from uuid import uuid4

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
    async def stream(self, run):
        contexts.append(run.messages)
        yield {'type': 'delta', 'text': '先检查。'}
        yield {'type': 'tool', 'id': 'a', 'name': 'read_project', 'status': 'running'}
        yield {'type': 'tool', 'id': 'b', 'name': 'read_project', 'status': 'running'}
        yield {'type': 'tool', 'id': 'a', 'name': 'read_project', 'status': 'complete'}
        yield {'type': 'tool', 'id': 'b', 'name': 'read_project', 'status': 'failed', 'error': '读取失败'}
        yield {'type': 'delta', 'text': '\n已检查。'}
    monkeypatch.setattr(agent.AgentRuntimes, 'stream', stream)
    monkeypatch.setattr(agent, 'runtime_available', lambda _: True)
    monkeypatch.setattr(agent, 'skills', empty_skills)
    from opendirector.infrastructure.model_configs import ModelConfigs
    monkeypatch.setattr(ModelConfigs, 'resolve', lambda *args: {'id': str(uuid4()), 'modelId': 'test-model'})
    with TestClient(create_app(LocalProjects(tmp_path)), headers={
        'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': str(uuid4())}) as client:
        pid = str(uuid4())
        root = f'/api/creation/projects/{pid}'
        assert client.post(root + '/commands', json={'type': 'project.create', 'projectId': pid,
            'commandId': str(uuid4()), 'payload': {'name': '多对话'}}).status_code == 200
        assert client.post(root + '/open').status_code == 200
        yield client, root + '/assistant', contexts


def send(client, path, conversation_id, text):
    response = client.post(path + '/turns', json={'id': str(uuid4()), 'runtime': 'default',
        'conversationId': conversation_id, 'text': text})
    assert response.status_code == 200, response.text
    return response


def test_threads_keep_drafts_history_and_independent_context(assistant):
    client, path, contexts = assistant
    first = client.get(path).json()
    assert first['conversationId']
    assert frames(send(client, path, first['conversationId'], '旧故事'))[-1]['error'] is None
    assert client.put(path + '/draft', json={'conversationId': first['conversationId'],
        'draft': '保留草稿', 'runtime': 'default'}).status_code == 200
    new_id = str(uuid4())
    second = client.post(path + '/conversations', json={'id': new_id}).json()
    assert second['messages'] == [] and second['runtime'] == 'default'
    assert frames(send(client, path, new_id, '新故事'))[-1]['error'] is None
    assert '旧故事' not in json.dumps(contexts[-1], ensure_ascii=False)
    listing = client.get(path + '/conversations').json()
    assert {item['title'] for item in listing['items']} == {'旧故事', '新故事'}
    restored = client.post(path + f"/conversations/{first['conversationId']}/activate").json()
    assert restored['draft'] == '保留草稿' and len(restored['messages']) == 2
    assert client.get(path).json() == restored
    tools = restored['messages'][-1]['tools']
    assert [(item['id'], item['status'], item['textOffset']) for item in tools] == [('a', 'complete', 4), ('b', 'failed', 4)]


def test_stale_draft_and_stale_turn_cannot_modify_active_thread(assistant):
    client, path, contexts = assistant
    old_id = client.get(path).json()['conversationId']
    new_id = str(uuid4())
    assert client.post(path + '/conversations', json={'id': new_id}).status_code == 200
    for old in ({'conversationId': old_id}, {}):
        assert client.put(path + '/draft', json={**old, 'draft': '旧草稿'}).status_code == 409
    result = frames(send(client, path, old_id, '迟到的消息'))[-1]
    assert result['error'] and result['conversation'] is None
    assert not contexts
    current = client.get(path).json()
    assert current['conversationId'] == new_id and current['messages'] == []
    assert client.post(path + f'/conversations/{uuid4()}/activate').status_code == 404
    assert client.post(path + '/conversations', json={'id': str(uuid4())},
        headers={'X-OpenDirector-Session': str(uuid4())}).status_code == 409


def test_history_identifies_unsent_drafts_and_replays_creation_without_duplicates(assistant):
    client, path, _ = assistant
    first = client.get(path).json()['conversationId']
    assert client.put(path + '/draft', json={'conversationId': first,
        'draft': '海边短片草稿\n第二行', 'thinking': 'high'}).status_code == 200
    second = str(uuid4())
    created = client.post(path + '/conversations', json={'id': second}).json()
    assert created['draft'] == '' and created['thinking'] == 'high'
    assert client.post(path + '/conversations', json={'id': second}).json() == created
    items = client.get(path + '/conversations').json()['items']
    assert items == [
        {'id': second, 'title': '新会话', 'messageCount': 0, 'hasDraft': False},
        {'id': first, 'title': '海边短片草稿', 'messageCount': 0, 'hasDraft': True},
    ]
    restored = client.post(path + f'/conversations/{first}/activate').json()
    assert restored['draft'] == '海边短片草稿\n第二行'


def test_running_turn_blocks_switch_and_new_thread(assistant, monkeypatch):
    client, path, _ = assistant
    started, release = threading.Event(), threading.Event()
    async def stream(self, run):
        started.set()
        await asyncio.to_thread(release.wait, 10)
        yield {'type': 'delta', 'text': '完成'}
    monkeypatch.setattr(agent.AgentRuntimes, 'stream', stream)
    old_id = client.get(path).json()['conversationId']
    with ThreadPoolExecutor() as pool:
        pending = pool.submit(send, client, path, old_id, '等待')
        try:
            assert started.wait(5)
            assert client.post(path + '/conversations', json={'id': str(uuid4())}).status_code == 409
            assert client.post(path + f'/conversations/{old_id}/activate').status_code == 409
        finally:
            release.set()
        assert frames(pending.result())[-1]['error'] is None


def test_inline_skill_position_survives_conversation_switch(assistant):
    client, path, _ = assistant
    original = client.get(path).json()
    content = [{'type': 'text', 'text': '先保留这段 '}, {'type': 'skill', 'name': 'character-replacement'}, {'type': 'text', 'text': ' 再补充说明'}]
    response = client.put(path + '/draft', json={'conversationId': original['conversationId'],
        'draft': '先保留这段 /character-replacement 再补充说明', 'draftContent': content,
        'skills': ['character-replacement']})
    assert response.status_code == 200
    assert client.post(path + '/conversations', json={'id': str(uuid4())}).status_code == 200
    restored = client.post(path + f"/conversations/{original['conversationId']}/activate").json()
    assert restored['draftContent'] == content
    assert restored['skills'] == ['character-replacement']


def test_image_reference_reaches_runtime_with_media_metadata(assistant):
    from io import BytesIO
    from PIL import Image

    client, path, contexts = assistant
    base = path.removesuffix('/assistant')
    handle = str(uuid4())
    image = BytesIO()
    Image.new('RGB', (13, 7), 'purple').save(image, format='PNG')
    uploaded = client.put(base + '/uploads/' + handle, content=image.getvalue(),
        headers={'X-Asset-Name': 'portrait.png'})
    assert uploaded.status_code == 200, uploaded.text
    imported = client.post(base + '/commands', json={'type': 'asset.import',
        'commandId': str(uuid4()), 'projectId': base.rsplit('/', 1)[-1],
        'payload': {'uploadHandle': handle, 'name': 'portrait.png', 'expectedKind': 'image'}})
    assert imported.status_code == 200, imported.text
    asset_id = imported.json()['changed'][0]['id']
    response = client.post(path + '/turns', json={'id': str(uuid4()), 'runtime': 'default',
        'text': '使用这张人物参考', 'assets': [asset_id]})
    assert response.status_code == 200, response.text
    assert frames(response)[-1]['error'] is None
    message = client.get(path).json()['messages'][0]
    assert message['assets'][0]['type'] == 'image/png'
    prompt = contexts[-1][-1]['content']
    assert asset_id in prompt and 'portrait.png' in prompt
    assert '"width": 13' in prompt and '"height": 7' in prompt
    assert 'not visual observations' in prompt
    references = json.loads(prompt.split('Referenced project assets: ', 1)[1].split('\n', 1)[0])
    from pathlib import Path
    assert Path(references[0]['path']).is_absolute()
    assert Path(references[0]['path']).read_bytes() == image.getvalue()
    conversation_id = client.get(path).json()['conversationId']
    assert frames(send(client, path, conversation_id, '继续使用刚才的参考'))[-1]['error'] is None
    assert contexts[-1][0]['content'].split('\nReferenced project assets: ', 1)[1].split('\n', 1)[0] == json.dumps(references, ensure_ascii=False)


def test_stop_releases_project_after_saving_partial_reply(assistant, monkeypatch):
    client, path, _ = assistant
    started = threading.Event()
    async def stream(self, run):
        yield {'type': 'delta', 'text': '保留部分回复'}
        started.set()
        await asyncio.Event().wait()
    monkeypatch.setattr(agent.AgentRuntimes, 'stream', stream)
    turn_id = str(uuid4())
    with ThreadPoolExecutor() as pool:
        pending = pool.submit(client.post, path + '/turns', json={
            'id': turn_id, 'runtime': 'default', 'text': '等待'})
        assert started.wait(5)
        assert client.post(path + f'/turns/{turn_id}/stop').status_code == 200
        assert pending.result(timeout=5).status_code == 200
    saved = client.get(path).json()['messages'][-1]
    assert saved['status'] == 'stopped'
    assert saved['text'] == '保留部分回复'
    assert client.post(path + '/conversations', json={'id': str(uuid4())}).status_code == 200
    async def finished(self, run):
        yield {'type': 'delta', 'text': '新回复'}
    monkeypatch.setattr(agent.AgentRuntimes, 'stream', finished)
    reply = send(client, path, client.get(path).json()['conversationId'], '继续')
    assert frames(reply)[-1]['conversation']['messages'][-1]['text'] == '新回复'


def test_sse_disconnect_keeps_the_run_and_a_new_stream_resumes_it(assistant, monkeypatch):
    """#81: leaving the project closes the stream but must not stop the Agent."""
    client, path, _ = assistant
    release, attached = threading.Event(), threading.Event()
    async def stream(self, run):
        yield {'type': 'delta', 'text': '断线前的回复'}
        await asyncio.to_thread(release.wait, 10)
        yield {'type': 'delta', 'text': '，返回后完成'}
    monkeypatch.setattr(agent.AgentRuntimes, 'stream', stream)
    follow, calls = agent.RunEvents.follow, []
    async def counted(self):
        calls.append(self)
        if len(calls) > 1:
            attached.set()
        async for item in follow(self):
            yield item
    monkeypatch.setattr(agent.RunEvents, 'follow', counted)
    turn_id = str(uuid4())
    disconnect_turn(client, path, turn_id)

    current = client.get(path).json()
    assert current['activeTurnId'] == turn_id
    assert current['messages'][-1]['status'] == 'streaming'
    assert client.post(path + '/conversations', json={'id': str(uuid4())}).status_code == 409
    with ThreadPoolExecutor() as pool:
        pending = pool.submit(client.get, path + f'/turns/{turn_id}/events')
        try:
            assert attached.wait(5)
        finally:
            release.set()
        events = frames(pending.result(timeout=10))
    assert events[0]['type'] == 'start'
    assert [item['text'] for item in events if item['type'] == 'delta'] == ['断线前的回复', '，返回后完成']
    saved = events[-1]['conversation']['messages'][-1]
    assert events[-1]['type'] == 'end' and events[-1]['error'] is None
    assert saved['status'] == 'complete' and saved['text'] == '断线前的回复，返回后完成'
    assert 'activeTurnId' not in client.get(path).json()
    assert client.get(path + f'/turns/{turn_id}/events').status_code == 404
    assert client.post(path + '/conversations', json={'id': str(uuid4())}).status_code == 200


def test_explicit_stop_after_disconnect_still_stops_the_run(assistant, monkeypatch):
    client, path, _ = assistant
    async def stream(self, run):
        yield {'type': 'delta', 'text': '断线前的回复'}
        await asyncio.Event().wait()
    monkeypatch.setattr(agent.AgentRuntimes, 'stream', stream)
    turn_id = str(uuid4())
    disconnect_turn(client, path, turn_id)
    assert client.get(path).json()['activeTurnId'] == turn_id
    assert client.post(path + f'/turns/{turn_id}/stop').status_code == 200
    current = client.get(path).json()
    assert 'activeTurnId' not in current
    assert current['messages'][-1]['status'] == 'stopped'
    assert current['messages'][-1]['text'] == '断线前的回复'
    assert client.post(path + '/conversations', json={'id': str(uuid4())}).status_code == 200


def disconnect_turn(client, path, turn_id):
    """Start a turn over raw ASGI and close the stream after its first delta."""
    async def disconnect():
        disconnected = asyncio.Event()
        body = json.dumps({'id': turn_id, 'runtime': 'default', 'text': '断线测试'}).encode()
        requested = False
        async def receive():
            nonlocal requested
            if not requested:
                requested = True
                return {'type': 'http.request', 'body': body, 'more_body': False}
            await disconnected.wait()
            return {'type': 'http.disconnect'}
        async def send_event(message):
            if message['type'] == 'http.response.body' and b'"type": "delta"' in message.get('body', b''):
                disconnected.set()
        url = path + '/turns'
        scope = {'type': 'http', 'asgi': {'version': '3.0', 'spec_version': '2.3'},
            'http_version': '1.1', 'scheme': 'http', 'method': 'POST', 'root_path': '',
            'path': url, 'raw_path': url.encode(), 'query_string': b'',
            'headers': [(key.lower().encode(), value.encode()) for key, value in client.headers.items()]
                + [(b'content-type', b'application/json'), (b'content-length', str(len(body)).encode())],
            'server': ('testserver', 80), 'client': ('testclient', 50000)}
        await asyncio.wait_for(client.app(scope, receive, send_event), 5)
        assert disconnected.is_set()
    client.portal.call(disconnect)


@pytest.mark.parametrize('runtime', ['default', 'opencode', 'codex', 'claude', 'jiuwenswarm', 'deepseek'])
@pytest.mark.parametrize('language, text', [('zh-CN', '你好'), ('en-US', 'hello')])
def test_plain_request_reaches_each_runtime_without_delivery_instructions(assistant, runtime, language, text):
    client, path, contexts = assistant
    conversation_id = client.get(path).json()['conversationId']
    response = client.post(path + '/turns', headers={'Accept-Language': language}, json={
        'id': str(uuid4()), 'runtime': runtime, 'conversationId': conversation_id, 'text': text,
    })
    assert frames(response)[-1]['error'] is None
    # Shared behavioral guidance belongs in the system instructions, not in the
    # user's request. A greeting must not acquire an invented delivery task.
    assert contexts[-1] == [{'role': 'user', 'content': text}]
    saved = client.get(path).json()['messages']
    assert saved[0]['text'] == text
    assert saved[-1]['status'] == 'complete'
