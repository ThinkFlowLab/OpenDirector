"""Missing tool models retain actionable reasons at the real HTTP boundary."""
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from opendirector.integrations.model_adapters import OpenAIImages, VllmOmniSegmentation
from opendirector_api.main import create_app
from test_tool_tasks import project, png, upload


@pytest.mark.parametrize('language', ['zh-CN', 'en-US'])
@pytest.mark.parametrize('operation,capability,chinese,english', [
    ('resize', 'image.edit', '图生图/图片编辑', 'image editing'),
    ('selection', 'image.segment', '图像分割', 'image segmentation'),
])
def test_missing_tool_model_http_names_required_capability_without_creating_work(
    project, monkeypatch, language, operation, capability, chinese, english,
):
    store, project_id, session = project
    source = upload(store, project_id, session, 'source.png', png((64, 48)))
    before = store.snapshot(project_id)
    calls = []

    async def unexpected_provider(*args, **kwargs):
        calls.append(True)
        raise AssertionError('A missing model must not submit a provider request')

    monkeypatch.setattr(OpenAIImages, 'image', unexpected_provider)
    monkeypatch.setattr(VllmOmniSegmentation, 'segment', unexpected_provider)
    with TestClient(create_app(store.local), headers={
        'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': session,
        'Accept-Language': language,
    }) as client:
        path = f'/api/creation/projects/{project_id}'
        if operation == 'resize':
            response = client.post(path + '/tool-tasks', json={
                'id': str(uuid4()), 'tool': 'multi-size', 'sourceAssetIds': [source],
                'parameters': {'aspectRatio': 'custom', 'outputWidth': 128, 'outputHeight': 128},
            })
        else:
            response = client.post(path + '/image-selections', json={
                'sourceAssetId': source, 'boxes': [{'x': 10, 'y': 8, 'width': 22, 'height': 24}],
            })
        assert response.status_code == 409, response.text
        expected = (f'没有可用的「{chinese}」模型，请在“模型接入”中添加。' if language == 'zh-CN'
                    else f'No {english} model is available. Add one in Model connections.')
        assert response.json()['detail'] == expected
        assert response.json()['code'] == 'tool_model_missing'
        assert response.json()['requiredCapability'] == capability
        assert client.get(path + '/tool-tasks').json()['tasks'] == []
        assert store.snapshot(project_id) == before
    assert calls == []
