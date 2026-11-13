import asyncio
from io import BytesIO
from pathlib import Path
import subprocess
import sys
from uuid import uuid4

from fastapi.testclient import TestClient
from PIL import Image, ImageCms
import pytest

from opendirector.application.creation_assets import CreationAssets
from opendirector.agent.gateway import ToolGateway
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.media import heif_type
from opendirector.media.processing import open_image
from opendirector.media.thumbnails import preview
from opendirector.domain.projects import ProjectError
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


@pytest.mark.parametrize('profiled', [False, True])
@pytest.mark.parametrize('suffix', ['heic', 'heif'])
@pytest.mark.parametrize('mode', ['RGB', 'L'])
def test_heif_preview_profiles_match_original(storage, tmp_path, profiled, suffix, mode):
    projects, pid, _ = storage
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes() if profiled else None
    output = BytesIO()
    Image.new(mode, (640, 400), 'red').save(output, 'HEIF', icc_profile=profile)
    data = output.getvalue()
    if suffix == 'heif':
        data = data[:8] + b'mif1' + data[12:]
    asset, _, _ = import_asset(storage, f'profile.{suffix}', data)
    service = CreationAssets(projects)
    with Image.open(BytesIO(data)) as original:
        assert original.info.get('icc_profile') == profile
    # Deliberately mismatched RGB metadata on grayscale pixels must not propagate.
    expected_profile = profile if mode == 'RGB' else None
    with TestClient(create_app(projects.local)) as client:
        for route, size in [('browser-image', (640, 400)), ('thumbnail', (480, 300))]:
            response = client.get(f'/api/creation/projects/{pid}/assets/{asset.id}/{route}',
                headers={'X-OpenDirector-Request': '1'})
            assert response.status_code == 200
            with Image.open(BytesIO(response.content)) as image:
                assert image.size == size
                assert image.info.get('icc_profile') == expected_profile, route
    agent_preview = service.preview(pid, asset.id, tmp_path / 'agent-preview')
    for rendered in [Path(agent_preview['preview']['path']).read_bytes(),
                     preview(asset.fingerprint, data, 'image')]:
        with Image.open(BytesIO(rendered)) as image:
            assert image.size == (480, 300)
            assert image.info.get('icc_profile') == expected_profile
    with service.open_media(pid, asset.id)[0] as original:
        assert original.read() == data


@pytest.mark.parametrize('locale', ['zh-CN', 'en-US'])
@pytest.mark.parametrize('invalid', ['corrupt', 'pixels', 'sequence', 'multiple_images'])
def test_invalid_image_upload_is_localized_and_does_not_publish(storage, locale, invalid):
    projects, pid, session = storage
    if invalid == 'corrupt':
        data = (FIXTURES / 'oriented.heic').read_bytes()[:100]
    elif invalid == 'sequence':
        data = (FIXTURES / 'oriented.heic').read_bytes()
        data = data[:8] + b'hevc' + data[12:]
    elif invalid == 'multiple_images':
        output = BytesIO()
        Image.new('RGB', (64, 64), 'red').save(output, 'HEIF', save_all=True,
            append_images=[Image.new('RGB', (64, 64), 'blue')])
        data = output.getvalue()
        assert heif_type(data) == 'image/heic'
        with Image.open(BytesIO(data)) as image:
            assert image.n_frames == 2
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


def test_browser_image_revalidation_skips_decode_but_checks_original(storage, monkeypatch):
    projects, pid, _ = storage
    asset, _, _ = import_asset(storage, 'photo.heic', (FIXTURES / 'oriented.heic').read_bytes())
    with TestClient(create_app(projects.local)) as client:
        path = f'/api/creation/projects/{pid}/assets/{asset.id}/browser-image'
        headers = {'X-OpenDirector-Request': '1'}
        display = client.get(path, headers=headers)
        assert display.status_code == 200
        old_etag = f'"browser-image-{asset.fingerprint}"'
        changed = client.get(path, headers={**headers, 'If-None-Match': old_etag})
        assert changed.status_code == 200 and changed.content == display.content
        assert changed.headers['etag'] != old_etag
        def forbidden_decode(*args):
            raise AssertionError('An unchanged image must not be decoded again')
        monkeypatch.setattr('opendirector.application.creation_assets.open_image', forbidden_decode, raising=False)
        headers['If-None-Match'] = display.headers['etag']
        unchanged = client.get(path, headers=headers)
        assert unchanged.status_code == 304 and unchanged.content == b''
        assert unchanged.headers['etag'] == display.headers['etag']
        assert unchanged.headers['cache-control'] == 'private, no-cache'
        (projects.root / 'Assets' / asset.path).write_bytes(b'tampered')
        assert client.get(path, headers=headers).status_code == 409


@pytest.mark.parametrize('locale', ['zh-CN', 'en-US'])
def test_non_heif_browser_image_is_rejected_even_with_matching_validator(storage, locale):
    projects, pid, _ = storage
    asset, _, _ = import_asset(storage)
    with TestClient(create_app(projects.local)) as client:
        response = client.get(f'/api/creation/projects/{pid}/assets/{asset.id}/browser-image', headers={
            'X-OpenDirector-Request': '1', 'Accept-Language': locale,
            'If-None-Match': f'"browser-image-v2-{asset.fingerprint}"'})
    assert response.status_code == 422
    assert ('does not support' if locale == 'en-US' else '不支持预览') in response.json()['detail']


def test_decode_failure_has_localizable_code():
    with pytest.raises(ProjectError) as error:
        open_image(b'broken image')
    assert error.value.status == 422 and error.value.code == 'image_decode'


def test_standalone_asset_thumbnail_registers_heif_decoder():
    subprocess.run([sys.executable, '-c', '''
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from opendirector.application.creation_assets import CreationAssets
from opendirector.ports.gateway import register_gateway
from PIL import Image
register_gateway(SimpleNamespace(uploads=lambda projects: None))
service = CreationAssets(None)
asset = SimpleNamespace(kind='image', fingerprint='standalone')
data = Path('tests/fixtures/heif/oriented.heic').read_bytes()
service.open_media = lambda *args: (BytesIO(data), asset)
with Image.open(BytesIO(service.thumbnail(None, None)[0])) as image:
    assert image.size == (192, 320)
'''], check=True)


def test_heif_library_thumbnail_composites_transparency():
    output = BytesIO()
    Image.new('RGBA', (64, 64), (255, 0, 0, 0)).save(output, 'HEIF')
    data = output.getvalue()
    with Image.open(BytesIO(data)) as source:
        assert source.convert('RGBA').getpixel((32, 32))[3] == 0
    with Image.open(BytesIO(preview('transparent-heif', data, 'image'))) as image:
        assert min(image.getpixel((32, 32))) > 245


@pytest.mark.parametrize('locale', ['zh-CN', 'en-US'])
@pytest.mark.parametrize('route', ['browser-image', 'thumbnail'])
def test_preview_decode_failure_is_localized(storage, monkeypatch, locale, route):
    projects, pid, _ = storage
    asset, _, _ = import_asset(storage, 'photo.heic', (FIXTURES / 'oriented.heic').read_bytes())
    def failed_decoder(*args, **kwargs):
        raise OSError('decoder failure')
    monkeypatch.setattr(Image, 'open', failed_decoder)
    with TestClient(create_app(projects.local)) as client:
        response = client.get(f'/api/creation/projects/{pid}/assets/{asset.id}/{route}', headers={
            'X-OpenDirector-Request': '1', 'Accept-Language': locale})
    assert response.status_code == 422
    assert ('decoded' if locale == 'en-US' else '无法读取图片') in response.json()['detail']


def test_heif_at_pixel_limit_has_full_resolution_browser_display(storage):
    projects, pid, _ = storage
    output = BytesIO()
    Image.new('RGB', (5000, 5000), 'red').save(output, 'HEIF', quality=10, enc_params={'preset': 'ultrafast'})
    asset, _, _ = import_asset(storage, 'large.heic', output.getvalue())
    assert (asset.metadata.width, asset.metadata.height) == (5000, 5000)
    display, _ = CreationAssets(projects).browser_image(pid, asset.id)
    with Image.open(BytesIO(display)) as image:
        assert image.size == (5000, 5000)
        assert image.getpixel((4999, 4999))[0] > 200


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
