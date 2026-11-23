"""Four configured adapters: real payloads, reference identity and recovery."""
import asyncio
import base64
from copy import deepcopy
import io
import json
import shutil
import subprocess
from uuid import uuid4
import wave

from fastapi.testclient import TestClient
import httpx
from PIL import Image
import pytest

from opendirector.application.creation_generation import CreationGeneration
from opendirector.application.creation_tool_assets import CreationToolAssets
from generation_helpers import new_project
from opendirector.domain.input_rules import MAX_REFERENCES, input_rules
from opendirector.domain.projects import ProjectError
from opendirector.domain.references import project_content
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.generation_errors import provider_failure
from opendirector.integrations.reference_inputs import generation_references, reference_content, request_size
from opendirector.integrations.volcengine import VolcengineGeneration
from opendirector_api.main import create_app


pytestmark = pytest.mark.cpu

BASE = 'https://ark.cn-beijing.volces.com/api/plan/v3'


def config(kind='video'):
    return {'kind': kind, 'modelId': {'video': 'doubao-seedance-2.0', 'image': 'doubao-seedream-5.0-pro', 'agent': 'deepseek-flash'}[kind],
            'url': 'https://api.deepseek.com' if kind == 'agent' else BASE, 'apiKey': 'private'}


@pytest.fixture
def media(tmp_path):
    projects, pid, session = new_project(tmp_path, '四类参考')
    store = CreationGeneration(projects, ModelConfigs(tmp_path)).store
    canvas = CreationToolAssets(projects); owner = str(pid)
    def add(name, data):
        return canvas.import_file(owner, str(uuid4()), name, data, session)
    buf = io.BytesIO(); Image.new('RGB', (640, 640), 'teal').save(buf, 'PNG')
    image = add('场景.png', buf.getvalue())
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wav:
        wav.setparams((1, 2, 24000, 0, 'NONE', 'not compressed')); wav.writeframes(b'\0\0' * 72000)
    audio = add('节奏.wav', buf.getvalue())
    text = add('说明.md', '保留几何构图'.encode())
    return store, owner, session, canvas, image, audio, text


def task(owner, refs=(), **changes):
    return {'kind': 'video', 'projectId': owner, 'prompt': '按参考创作', 'referenceIds': [a['id'] for a in refs],
            'videoMode': 'reference', 'parameters': {'duration': 5, 'ratio': '16:9', 'generate_audio': True}, **changes}


def test_profiles_bind_both_endpoint_and_exact_model():
    assert input_rules(config('image'))['maxImages'] == 10
    assert input_rules(config())['maxAudios'] == 3
    assert input_rules({**config(), 'url': 'https://other.test/api/plan/v3'})['videoModes'] == ['first_frame']
    assert input_rules({**config(), 'modelId': 'my-seedance-2.0-lookalike'})['videoModes'] == ['first_frame']


def test_reference_mapping_deduplicates_without_losing_inline_positions(media):
    store, owner, _, _, image, audio, text = media
    content = [{'type': 'text', 'text': '先按'}, {'type': 'reference', 'assetId': audio['id'], 'name': audio['name']},
        {'type': 'text', 'text': '的节奏，再用'}, {'type': 'reference', 'assetId': image['id'], 'name': image['name']},
        {'type': 'text', 'text': '\n以及'}, {'type': 'reference', 'assetId': audio['id'], 'name': audio['name']}]
    prompt, ids = project_content(content)
    prepared = generation_references(store, task(owner, prompt=prompt, promptContent=content, referenceIds=ids), config())
    assert prompt in prepared['prompt'] and prompt.count('参考1') == 2
    assert len(prepared['images']) == len(prepared['audios']) == 1
    assert [(entry['kind'], entry['role'], entry['number']) for entry in prepared['manifest']] == [('audio', 'reference_audio', 1), ('image', 'reference_image', 1)]
    assert base64.b64decode(prepared['audios'][0].split(',')[1]) == store.asset(owner, audio['id'])[0]


def test_chat_audio_and_video_only_send_metadata_and_never_encode_bytes(media, monkeypatch):
    store, owner, _, _, image, audio, text = media
    original = store.asset
    video = {'id': str(uuid4()), 'name': '未知内容.mp4', 'type': 'video/mp4', 'kind': 'video', 'fingerprint': 'fixture', 'durationMs': 5000}
    monkeypatch.setattr(store, 'asset', lambda o, i: (b'private-video-bytes', video) if i == video['id'] else original(o, i))
    manifest = []
    blocks = reference_content(store, owner, {'text': '使用素材制作', 'assets': [audio, video, text, image]}, manifest=manifest)
    serialized = json.dumps(blocks, ensure_ascii=False)
    assert 'private-video-bytes' not in serialized and 'data:audio' not in serialized and 'video_url' not in serialized
    assert '未提供音画内容' in serialized and video['id'] in serialized and '5000' in serialized
    assert [entry['transmission'] for entry in manifest] == ['metadata', 'metadata', 'content', 'content']
    assert sum(block['type'] == 'image_url' for block in blocks) == 1


def test_generation_limits_modes_and_audio_combinations_preserve_inputs(media):
    store, owner, _, _, image, audio, text = media
    nine = [image] * 9
    # Different asset IDs are counted; repeated mentions are not.
    assert len(generation_references(store, task(owner, nine), config())['images']) == 1
    with pytest.raises(ProjectError, match='搭配'):
        generation_references(store, task(owner, [audio]), config())
    with pytest.raises(ProjectError, match='暂不支持'):
        generation_references(store, task(owner, [image, audio], videoMode='first_frame'), config())
    with pytest.raises(ProjectError, match='暂不支持'):
        generation_references(store, task(owner, [audio], kind='image'), config('image'))
    original = task(owner, [image, audio])
    saved = deepcopy(original)
    with pytest.raises(ProjectError, match='尚未接通素材参考模式'):
        generation_references(store, original, {**config(), 'url': 'https://other.test'})
    assert original == saved


def test_real_adapter_encodes_reference_roles_and_resume_never_reads_sources(media, monkeypatch):
    store, owner, _, _, image, audio, _ = media
    calls = []
    def handler(request):
        if request.method == 'POST':
            calls.append(json.loads(request.content)); return httpx.Response(200, json={'id': 'remote-existing'})
        if request.url.host == 'download.test':
            assert 'authorization' not in request.headers; return httpx.Response(200, content=b'output')
        return httpx.Response(200, json={'status': 'succeeded', 'content': {'video_url': 'https://download.test/result'}})
    provider = VolcengineGeneration(store, httpx.MockTransport(handler), poll_interval=0)
    value = task(owner, [image, audio]); ids = []
    async def submitted(external): ids.append(external)
    assert asyncio.run(provider.generate(config(), value, submitted)) == ('mp4', b'output')
    assert ids == ['remote-existing']
    assert [(block['type'], block.get('role')) for block in calls[0]['content']] == [('text', None), ('image_url', 'reference_image'), ('audio_url', 'reference_audio')]
    assert 'video_url' not in json.dumps(calls[0])
    monkeypatch.setattr(store, 'asset', lambda *_: pytest.fail('Remote recovery must not reread references'))
    assert asyncio.run(provider.generate(config(), {**value, 'externalTaskId': ids[0]}, submitted)) == ('mp4', b'output')
    assert len(calls) == 1


def test_reference_error_classification_is_specific_and_redacted():
    error = provider_failure({'error': {'code': 'InvalidParameter', 'message': 'reference_audio cannot be the only reference input https://private.test/?token=secret'}}, stage='submit', http_status=400, secrets=('secret',))
    assert error.details.category == 'reference' and '图片' in error.details.message
    assert 'private.test' not in str(error) and 'secret' not in str(error)
    ordinary = provider_failure({'error': {'code': 'InvalidParameter', 'message': 'invalid duration'}}, stage='submit', http_status=400)
    assert ordinary.details.category == 'input'
    with pytest.raises(ProjectError, match='请求过大'):
        request_size({'image': 'x' * 50}, 10)


@pytest.fixture(scope='module')
def small_video(tmp_path_factory):
    if not shutil.which('ffmpeg'):
        pytest.skip('FFmpeg is required for media history')
    path = tmp_path_factory.mktemp('reference-output') / 'output.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x24:d=0.2', '-pix_fmt', 'yuv420p', str(path)], check=True)
    return path.read_bytes()


@pytest.mark.parametrize(('count', 'seconds'), [(4, 3), (2, 8)])
def test_audio_count_and_total_duration_are_checked_together(media, count, seconds):
    store, owner, session, canvas, image, _, _ = media
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as wav:
        wav.setparams((1, 2, 24000, 0, 'NONE', 'not compressed')); wav.writeframes(b'\0\0' * 24000 * seconds)
    audios = [canvas.import_file(owner, str(uuid4()), f'音频{i}.wav', buf.getvalue(), session) for i in range(count)]
    with pytest.raises(ProjectError, match='最多 3 段，总时长不超过 15 秒'):
        generation_references(store, task(owner, [image, *audios]), config())
