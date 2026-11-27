"""Keyframes: pictures pinned at chosen moments of an H3 video, sent as timeline guides."""
import asyncio
import json
from email.parser import BytesParser
from email.policy import default
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest

from opendirector.domain.creation.assets import AssetRef, MediaMetadata
from opendirector.domain.creation.generation import (ResolvedReference, VideoGenerationSpec, VideoParameters,
                                                     validate_generation)
from opendirector.domain.creation.models import ModelConfigPublic
from opendirector.domain.input_rules import input_rules
from opendirector.domain.projects import ProjectError
from opendirector.integrations.fasth3 import video_parameters
from opendirector.integrations.providers import GenerationProviders
from opendirector.integrations.reference_inputs import generation_references
from opendirector.integrations.vllm_omni import VllmOmniGeneration


pytestmark = pytest.mark.cpu

PNG = b'\x89PNG\r\n\x1a\n'
OMNI = {'kind': 'video', 'protocol': 'vllm_omni', 'url': 'http://localhost:18091/v1', 'modelId': 'Pika-H3',
        'videoAdapter': 'fasth3', 'apiKey': '', 'authMode': 'none'}


@pytest.mark.parametrize('adapter, expected', [('fasth3', 8), ('fasth3_dual', 8), ('minimax_h3', 8), ('standard', None)])
def test_every_h3_adapter_declares_keyframes(adapter, expected):
    assert input_rules({**OMNI, 'videoAdapter': adapter}).get('maxKeyframes') == expected


def model(**extra):
    config = {'kind': 'video', 'url': 'http://model.test/v1', 'modelId': 'Pika-H3', 'connectionType': 'self_hosted',
              'protocol': 'vllm_omni', 'authMode': 'none', 'videoAdapter': 'fasth3', **extra}
    return ModelConfigPublic(id=uuid4(), inputRules=input_rules(config), **config)


def picture(role='reference', time=None, kind='image'):
    return ResolvedReference(referenceId=uuid4(), role=role, frameTimeMs=time,
        asset=AssetRef(assetId=uuid4(), revision=1, fingerprint='sha256:' + '0' * 64, kind=kind),
        metadata=MediaMetadata(mimeType='image/png' if kind == 'image' else 'video/mp4', size=10, width=32, height=24,
                               durationSeconds=None if kind == 'image' else 5))


def spec(target, mode='reference', seconds=5):
    return VideoGenerationSpec(id=uuid4(), projectId=uuid4(), kind='video', purpose='generation', modelConfigId=target.id,
        prompt='A dancer', parameters=VideoParameters(videoMode=mode, durationSeconds=seconds))


def test_submission_accepts_keyframes_beside_a_reference():
    omni = model()
    validate_generation(spec(omni), omni, (picture(), picture('keyframe', 1250), picture('keyframe', 4583)), submitting=True)
    # Keyframes are guides: nine reference pictures plus eight keyframes stay within both limits.
    validate_generation(spec(omni), omni, (*[picture() for _ in range(9)], *[picture('keyframe', 100 * n) for n in range(8)]), submitting=True)


@pytest.mark.parametrize('references, message', [
    (lambda: (picture('keyframe', 1000),), '普通参考'),
    (lambda: (picture(), picture('keyframe', None)), '时间点'),
    (lambda: (picture(), picture('keyframe', 5000)), '早于视频结束'),
    (lambda: (picture(), picture('keyframe', 1000), picture('keyframe', 1000)), '同一个时间点'),
    (lambda: (picture(), *[picture('keyframe', 100 * n) for n in range(9)]), '最多指定 8 个'),
])
def test_submission_rejects_invalid_keyframes(references, message):
    omni = model()
    with pytest.raises(ProjectError, match=message):
        validate_generation(spec(omni), omni, references(), submitting=True)


def test_keyframes_need_reference_mode_and_a_supporting_model():
    omni = model()
    control = picture('control', kind='video')
    with pytest.raises(ProjectError, match='素材参考模式'):
        validate_generation(spec(omni, 'control'), omni, (control, picture(), picture('keyframe', 1000)), submitting=True)
    plain = model(videoAdapter='standard')
    with pytest.raises(ProjectError, match='不支持指定帧'):
        validate_generation(spec(plain, 'first_frame'), plain, (picture('keyframe', 1000),), submitting=True)


def fixture(times=(1250, 4583)):
    costume = {'id': str(uuid4()), 'name': 'costume.png', 'kind': 'image', 'type': 'image/png', 'fingerprint': 'fixture'}
    poses = [{'id': str(uuid4()), 'name': f'pose-{index}.png', 'kind': 'image', 'type': 'image/png', 'fingerprint': 'fixture'}
             for index in range(len(times))]
    assets = {costume['id']: (PNG + b'costume', costume), **{pose['id']: (PNG + pose['name'].encode(), pose) for pose in poses}}
    store = SimpleNamespace(asset=lambda owner, key: assets[key])
    task = {'kind': 'video', 'projectId': 'owner', 'prompt': '飞天起舞', 'referenceIds': list(assets), 'videoMode': 'reference',
            'referenceRoles': [{'assetId': costume['id'], 'role': 'reference'},
                               *[{'assetId': pose['id'], 'role': 'keyframe', 'frameTimeMs': time} for pose, time in zip(poses, times)]]}
    task['parameters'] = video_parameters(task, {key: pair[1] for key, pair in assets.items()}, duration_seconds=5)
    return store, task, costume, poses


def test_a_keyframe_is_a_guide_and_not_a_reference_picture():
    store, task, costume, poses = fixture()
    prepared = generation_references(store, task, OMNI)
    assert len(prepared['images']) == 1
    assert [(guide['name'], guide['frame']) for guide in prepared['guides']] == [('pose-0.png', 30), ('pose-1.png', 110)]
    # Only the reference picture is labelled; guides never shift <Picture N>.
    assert prepared['prompt'].count('<Picture') == 1 and 'pose-' not in prepared['prompt']
    roles = [(entry['role'], entry.get('frameTimeMs')) for entry in prepared['manifest']]
    assert ('keyframe', 1250) in roles and ('keyframe', 4583) in roles


def test_one_asset_can_be_both_reference_and_keyframe():
    store, task, costume, _ = fixture(times=())
    task['referenceRoles'].append({'assetId': costume['id'], 'role': 'keyframe', 'frameTimeMs': 0})
    prepared = generation_references(store, task, OMNI)
    assert len(prepared['images']) == 1 and [guide['frame'] for guide in prepared['guides']] == [0]


def test_keyframes_are_refused_outside_reference_mode():
    store, task, _, _ = fixture()
    with pytest.raises(ProjectError, match='不支持指定帧'):
        generation_references(store, {**task, 'videoMode': 'control'}, OMNI)


def parts(request):
    prefix = 'Content-Type: ' + request.headers['content-type'] + '\r\n\r\n'
    message = BytesParser(policy=default).parsebytes(prefix.encode() + request.content)
    seen = {}
    for part in message.iter_parts():
        seen.setdefault(part.get_param('name', header='content-disposition'), []).append((part.get_filename(), part.get_payload(decode=True)))
    return seen


def test_the_wire_carries_timeline_guides_on_the_fasth3_path():
    store, task, _, _ = fixture()
    seen = {}

    def handle(request):
        if request.method == 'POST':
            seen.update(parts(request))
            return httpx.Response(200, json={'id': 'guided'})
        if request.url.path.endswith('/content'):
            return httpx.Response(200, content=b'generated')
        return httpx.Response(200, json={'status': 'completed'})

    async def submitted(value):
        assert value == 'guided'

    provider = GenerationProviders(store, httpx.MockTransport(handle), poll_interval=0)
    assert asyncio.run(provider.generate(OMNI, task, submitted)) == ('mp4', b'generated')
    assert json.loads(seen['timeline_guides'][0][1]) == [{'frame_index': 30, 'image': {'upload_index': 0}},
                                                          {'frame_index': 110, 'image': {'upload_index': 1}}]
    assert [name for name, _ in seen['guide_files']] == ['pose-0.png', 'pose-1.png']
    assert seen['quality'][0][1] == b'lossless'
    # The costume is the only reference picture; the poses are not uploaded twice.
    assert [name for name, _ in seen['input_references']] == ['costume.png']
    assert seen['prompt'][0][1].decode().count('<Picture') == 1


def test_native_h3_requests_carry_the_same_guides():
    store, task, _, _ = fixture()
    config = {**OMNI, 'videoAdapter': 'minimax_h3'}
    prepared = generation_references(store, task, config)
    fields, files = VllmOmniGeneration(store).form(config, {**task, 'parameters': {'duration': 5}}, prepared)
    assert json.loads(fields['timeline_guides'])[1] == {'frame_index': 110, 'image': {'upload_index': 1}}
    assert fields['quality'] == 'lossless'
    assert [name for name, part in files if name == 'guide_files'] == ['guide_files', 'guide_files']
    assert json.loads(fields['extra_params'])['task'] == 'ref2va'


# --- Stored references --------------------------------------------------------------------------------------

from test_creation_canvas_service import media, project, send, ver  # noqa: E402,F401  (project is a fixture)


def pinned_reference(project, **fields):
    from io import BytesIO
    from PIL import Image
    from opendirector.application.creation_assets import CreationAssets
    from opendirector.application.creation_canvas import asset_ref
    store, pid, session = project
    image, handle, picture = BytesIO(), uuid4(), uuid4()
    Image.new('RGB', (8, 8), (40, 50, 80)).save(image, 'PNG')
    writer = CreationAssets(store).uploads.begin(pid, handle, session, 'pose.png', expected_kind='image')
    writer.write(image.getvalue()); writer.finish()
    assert send(store, pid, 'asset.import', session=session, uploadHandle=handle, name='pose.png', expectedKind='image').status == 'applied'
    assert send(store, pid, 'canvas.show', session=session, item=dict(id=picture, projectId=pid, kind='image',
        binding=dict(role='material', objectRef=asset_ref(store.snapshot(pid).assets[-1])))).status == 'applied'
    target, spec = media(project, 'video', title='dance')
    reference = dict(id=uuid4(), projectId=pid, targetSpecId=spec.id, binding='follow_current', source=dict(id=picture), **fields)
    receipt = send(store, pid, 'reference.add', session=session, versions=[ver('canvas_item', target), ver('generation_spec', spec)], reference=reference)
    return receipt, store, pid, session


def test_a_keyframe_reference_stores_its_time_and_unpinning_clears_it(project):
    receipt, store, pid, session = pinned_reference(project, role='keyframe', frameTimeMs=1250)
    assert receipt.status == 'applied', receipt
    stored = store.snapshot(pid).references[-1]
    assert (stored.role, stored.frameTimeMs) == ('keyframe', 1250)
    plain = {key: value for key, value in stored.model_dump(mode='json').items() if key != 'frameTimeMs'} | {'role': 'reference'}
    receipt = send(store, pid, 'reference.update', session=session, versions=[ver('reference', stored)], reference=plain)
    assert receipt.status == 'applied', receipt
    stored = store.snapshot(pid).references[-1]
    # The update replaces the pin: no stale time is left behind on an ordinary reference.
    assert (stored.role, stored.frameTimeMs) == ('reference', None)


@pytest.mark.parametrize('fields', [dict(role='keyframe'), dict(role='reference', frameTimeMs=1000)])
def test_time_and_keyframe_role_go_together(project, fields):
    receipt, *_ = pinned_reference(project, **fields)
    assert receipt.status == 'rejected'
