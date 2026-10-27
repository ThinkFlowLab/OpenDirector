import json
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
import httpx
import pytest

from museshow.infrastructure.local_projects import LocalProjects, read_json
from museshow.infrastructure.model_configs import ModelConfigs
from museshow.integrations.chat_completions import ChatCompletions
from museshow_api.main import create_app


def sse(delta=None, finish=None):
    return 'data: ' + json.dumps({'choices': [{'delta': delta or {}, 'finish_reason': finish}]}) + '\n\n'


def test_agent_tool_roundtrip_persists_asset_and_private_reasoning(tmp_path):
    store = LocalProjects(tmp_path)
    session = str(uuid4())
    project = store.create('Agent项目', str(uuid4()), session)
    config = ModelConfigs(tmp_path).save('agent', 'https://api.deepseek.com', 'deepseek-flash', 'private-key')
    calls = []
    def handler(request):
        payload = json.loads(request.content)
        calls.append(payload)
        assert payload['tools'] and payload['thinking']['type'] == 'enabled'
        if len(calls) == 1:
            args = json.dumps({'name': '剧本.md', 'text': '# 城市之夜'})
            return httpx.Response(200, text=sse({'reasoning_content': 'private-thought'}) +
                sse({'tool_calls': [{'index': 0, 'id': 'write-one', 'function': {'name': 'save_text_asset', 'arguments': args[:12]}}]}) +
                sse({'tool_calls': [{'index': 0, 'function': {'arguments': args[12:]}}]}) + sse(finish='tool_calls') + 'data: [DONE]\n\n')
        assistant = [m for m in payload['messages'] if m['role'] == 'assistant']
        assert assistant[0]['reasoning_content'] == 'private-thought'
        assert any(m['role'] == 'tool' and 'succeeded' in m['content'] for m in payload['messages'])
        return httpx.Response(200, text=sse({'reasoning_content': 'private-followup'}) + sse({'content': '已将剧本保存到画布。'}) + sse(finish='stop') + 'data: [DONE]\n\n')
    headers = {'X-MuseShow-Request': '1', 'X-MuseShow-Session': session}
    with TestClient(create_app(store, ChatCompletions(httpx.MockTransport(handler))), headers=headers) as client:
        reply_id = str(uuid4())
        request = {'id': reply_id, 'modelId': config['id'], 'text': '写一份剧本并保存到画布'}
        response = client.post(f'/api/data/{project["id"]}/chat', json=request)
        assert response.status_code == 200 and '"error": null' in response.text
        assert 'private-thought' not in response.text and 'private-key' not in response.text
        assert 'save_text_asset' in response.text
        snapshot = client.get(f'/api/projects/{project["id"]}/canvas').json()
        assert len(snapshot['canvas']['nodes']) == len(snapshot['assets']) == 1
        asset = snapshot['assets'][0]
        assert asset['agentRunId'] == reply_id and asset['source'] == 'generated'
        assert snapshot['canvas']['nodes'][0]['assetId'] == asset['id']
        assert store.asset(project['id'], asset['id'])[0] == '# 城市之夜'.encode()
        node = snapshot['canvas']['nodes'][0]
        versions = client.get(f'/api/projects/{project["id"]}/canvas/nodes/{node["id"]}/versions').json()['versions']
        assert versions[0]['prompt'] == request['text'] and versions[0]['modelName'] == 'deepseek-flash'
        assert versions[0]['recorded'] and versions[0]['modelConfigId'] == config['id']
        assert 'private-key' not in json.dumps(versions)
        record = read_json(Path(project['path']) / 'agent-runs' / (reply_id + '.json'))
        assert record['status'] == 'complete' and record['protocol'][0]['reasoning_content'] == 'private-thought'
        # A following turn echoes the complete thinking/tool protocol without
        # re-executing the already completed write.
        response = client.post(f'/api/data/{project["id"]}/chat', json={**request, 'id': str(uuid4()), 'text': '刚才保存了什么？'})
        assert '"error": null' in response.text
        assert len(client.get(f'/api/projects/{project["id"]}/canvas').json()['assets']) == 1
        assert len(calls) == 3
        assert client.post(f'/api/data/{project["id"]}/chat', json=request).status_code == 409


def test_missing_media_model_returns_tool_error_without_empty_node(tmp_path):
    store = LocalProjects(tmp_path)
    session = str(uuid4())
    project = store.create('缺少模型', str(uuid4()), session)
    config = ModelConfigs(tmp_path).save('agent', 'https://example.test', 'chat', 'private')
    calls = []
    def handler(request):
        payload = json.loads(request.content)
        calls.append(payload)
        if len(calls) == 1:
            tool = {'index': 0, 'id': 'image-one', 'function': {'name': 'generate_asset', 'arguments': json.dumps({'kind': 'image', 'prompt': '猫', 'referenceIds': []})}}
            return httpx.Response(200, text=sse({'tool_calls': [tool]}) + sse(finish='tool_calls'))
        result = json.loads(payload['messages'][-1]['content'])
        assert '尚未选择' in result['error']
        return httpx.Response(200, text=sse({'content': '请先配置图片模型。'}) + sse(finish='stop'))
    with TestClient(create_app(store, ChatCompletions(httpx.MockTransport(handler))), headers={'X-MuseShow-Request': '1', 'X-MuseShow-Session': session}) as client:
        response = client.post(f'/api/data/{project["id"]}/chat', json={'id': str(uuid4()), 'modelId': config['id'], 'text': '生成图片', 'modelSelections': {'image': None}})
        assert '请先配置图片模型。' in response.text
        state = client.get(f'/api/projects/{project["id"]}/canvas').json()
        assert state['canvas']['nodes'] == [] and state['tasks'] == []


def test_agent_cannot_overwrite_a_node_using_a_stale_read(tmp_path):
    import asyncio
    from types import SimpleNamespace
    import pytest
    from museshow.agent.loop import AgentLoop
    from museshow.application.generation import Generation
    from museshow.domain.projects import ProjectError
    store = LocalProjects(tmp_path)
    session = str(uuid4())
    project = store.create('保护编辑', str(uuid4()), session)
    generation = Generation(store, ModelConfigs(tmp_path))
    item = generation.canvas.create(project['id'], {'id': str(uuid4()), 'kind': 'text'}, session)
    generation.canvas.patch(project['id'], item['id'], {'prompt': '用户的新修改', 'expectedRevision': 1}, session)
    before = generation.canvas.snapshot(project['id'])
    turn = SimpleNamespace(owner=project['id'], session=session)
    loop = AgentLoop(store, generation.configs, generation, None)
    with pytest.raises(ProjectError, match='expectedRevision'):
        asyncio.run(loop.execute(turn, 'save_text_asset', {'name': '旧内容.md', 'text': '不能覆盖', 'nodeId': item['id'], 'expectedRevision': 1}, str(uuid4())))
    assert generation.canvas.snapshot(project['id']) == before


def test_rejected_tool_arguments_name_the_fields_without_their_values():
    from pydantic import ValidationError
    from museshow.agent.loop import SCHEMAS, argument_error
    with pytest.raises(ValidationError) as failure:
        SCHEMAS['generate_asset'][0].model_validate_json('{"kind": "image", "prompt": "雨夜", "modelConfigId": "secret-value"}')
    message = argument_error(failure.value)
    assert 'modelConfigId' in message and 'secret-value' not in message
    assert argument_error(ValueError('x')) == '工具参数或文本格式无效，未执行。'
