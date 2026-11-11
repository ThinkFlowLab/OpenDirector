import asyncio
from io import BytesIO
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from opendirector.application.creation_assets import CreationAssets
from opendirector.agent.gateway import ToolGateway
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.media import heif_type
from opendirector.media.thumbnails import preview
from opendirector_api.main import create_app
from test_creation_assets import storage, import_asset
from test_agent_artifacts import publication

FIXTURES = Path(__file__).parent / 'fixtures' / 'heif'


def assert_portrait(data):
    with Image.open(BytesIO(data)) as image:
        assert image.size == (192, 320)
        assert image.getpixel((96, 40))[0] > 200
        assert image.getpixel((96, 280))[2] > 200


@pytest.mark.parametrize('suffix', ['heic', 'heif'])
@pytest.mark.parametrize('name', ['photo', 'misnamed.bin'])
def test_heif_original_preview_orientation_and_reopen(storage, suffix, name):
    projects, pid, session = storage
    data = (FIXTURES / f'oriented.{suffix}').read_bytes()
    asset, _, _ = import_asset(storage, f'{name}.{suffix}' if name == 'photo' else name, data)
    assert asset.kind == 'image' and asset.metadata.mimeType == f'image/{suffix}'
    assert (asset.metadata.width, asset.metadata.height) == (192, 320)
    service = CreationAssets(projects)
    assert_portrait(service.thumbnail(pid, asset.id)[0])
    assert_portrait(service.browser_image(pid, asset.id)[0])
    assert_portrait(preview(asset.fingerprint, data, 'image'))
    before = projects.snapshot(pid)
    projects.local.release(session)
    reopened = CreationProjects(LocalProjects(projects.local.repository))
    service = CreationAssets(reopened)
    with service.open_media(pid, asset.id)[0] as original:
        assert original.read() == data
    assert_portrait(service.browser_image(pid, asset.id)[0])
    assert reopened.snapshot(pid) == before
    with TestClient(create_app(projects.local)) as client:
        path = f'/api/creation/projects/{pid}/assets/{asset.id}'
        headers = {'X-OpenDirector-Request': '1'}
        original = client.get(path + '/content', headers=headers)
        assert original.content == data and original.headers['content-type'] == f'image/{suffix}'
        display = client.get(path + '/browser-image', headers=headers)
        assert display.status_code == 200 and display.headers['content-type'] == 'image/png'
        assert_portrait(display.content)


@pytest.mark.parametrize('locale', ['zh-CN', 'en-US'])
@pytest.mark.parametrize('invalid', ['corrupt', 'pixels', 'sequence'])
def test_invalid_image_upload_is_localized_and_does_not_publish(storage, locale, invalid):
    projects, pid, session = storage
    if invalid == 'corrupt':
        data = (FIXTURES / 'oriented.heic').read_bytes()[:100]
    elif invalid == 'sequence':
        data = (FIXTURES / 'oriented.heic').read_bytes()
        data = data[:8] + b'hevc' + data[12:]
    else:
        output = BytesIO()
        Image.new('RGB', (5001, 5000)).save(output, 'PNG')
        data = output.getvalue()
    with TestClient(create_app(projects.local)) as client:
        response = client.put(f'/api/creation/projects/{pid}/uploads/{uuid4()}', content=data,
            headers={'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': session,
                     'X-Asset-Name': 'photo.heic', 'X-Asset-Kind': 'image', 'Accept-Language': locale})
    assert response.status_code == (413 if invalid == 'pixels' else 400)
    message = response.json()['detail']
    expected = ('25 million' if invalid == 'pixels' else 'decoded') if locale == 'en-US' else (
        '2500 万' if invalid == 'pixels' else '无法读取图片')
    assert expected in message
    assert projects.snapshot(pid).assets == ()


def test_heif_detection_does_not_admit_avif_video_or_sequences():
    for data in (b'', b'not an image', b'\x00\x00\x00\x18ftypavif\x00\x00\x00\x00',
                 b'\x00\x00\x00\x18ftyphevc\x00\x00\x00\x00',
                 b'\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00'):
        assert heif_type(data) is None


@pytest.mark.parametrize('suffix', ['heic', 'heif'])
def test_agent_import_and_preview_use_the_same_validated_original(publication, suffix):
    business, run, work = publication
    data = (FIXTURES / f'oriented.{suffix}').read_bytes()
    name = f'photo.{suffix}'
    (work / name).write_bytes(data)
    (work / f'corrupt.{suffix}').write_bytes(data[:100])

    async def execute():
        gateway = ToolGateway(business, run)
        try:
            result = await gateway.call('import', 'execute_command', {'type': 'artifact.publish',
                'payload': {'path': name, 'name': name, 'expectedKind': 'image'}})
            assert result.error is None, result
            asset = business.assets.get(run.project_id, result.value['changed'][0]['id'])
            assert asset.metadata.mimeType == f'image/{suffix}'
            with business.assets.open_media(run.project_id, asset.id)[0] as original:
                assert original.read() == data
            preview = await gateway.call('preview', 'query', {'type': 'asset.preview', 'objectId': str(asset.id)})
            assert preview.error is None, preview
            assert_portrait(Path(preview.value['preview']['path']).read_bytes())
            corrupt = await gateway.call('corrupt', 'execute_command', {'type': 'artifact.publish',
                'payload': {'path': f'corrupt.{suffix}', 'name': f'corrupt.{suffix}', 'expectedKind': 'image'}})
            assert corrupt.error is not None
            assert len(business.projects.snapshot(run.project_id).assets) == 1
        finally:
            await gateway.close()

    asyncio.run(execute())
