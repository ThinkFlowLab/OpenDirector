"""Image counts cross real acceptance and serialize through production providers."""
import asyncio
import base64
import json
import time
from uuid import uuid4

from fastapi.testclient import TestClient
import httpx
import pytest

from opendirector.agent.tools import AgentTools
from opendirector.application.creation_generation import CreationGeneration
from opendirector.application.model_availability import ModelAvailability
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.capability_probe import CapabilityProbe
from opendirector.integrations.providers import GenerationProviders
from opendirector.integrations.generation_capability_parameters import generation_capability_parameters
from opendirector_api.main import create_app
from generation_helpers import command as generation_command, settled
from test_creation_canvas_service import project
from test_model_availability import document
from test_tool_native_mask import multipart
from test_tool_tasks import png, upload
from test_voice_library import wav


def image_runtime(project, maximum, model='served-image-alias', *, declared_model=None, editing=True, sampling_maximum=None):
    store, _, _ = project
    configs = ModelConfigs(store.local.repository)
    config = configs.save('image', 'http://images.test/v1', model, '',
        connection_type='self_hosted', protocol='openai', auth_mode='none')
    operation, profile_id, path = (('image_edit', 'image_to_image', '/v1/images/edits') if editing
                                   else ('image_generation', 'text_to_image', '/v1/images/generations'))
    declaration = document(operation, profile_id, path, 'image',
                           model=declared_model or model)
    profile = declaration['models'][0]['operations'][operation]['profiles'][0]
    profile['required_inputs'] = ['text', 'image'] if editing else ['text']
    profile['routes'][0]['request'] = {'inputs': {'image': {
        'support': 'supported', 'min_count': int(editing), 'max_count': maximum}},
        'parameters': {'response_format': {'support': 'supported', 'enum': ['b64_json']}}}
    if sampling_maximum is not None:
        profile['routes'][0]['request']['parameters']['num_inference_steps'] = {
            'support': 'supported', 'type': 'integer', 'maximum': sampling_maximum}
    queries, posts = [], []
    def discover(request):
        queries.append(request)
        assert request.method == 'GET' and request.url.path == '/v1/omni/capabilities'
        return httpx.Response(200, json=declaration)
    def generate(request):
        assert request.method == 'POST' and request.url.path == path
        posts.append(multipart(request) if editing else (json.loads(request.read()), []))
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(png()).decode()}]})
    probe = CapabilityProbe(transport=httpx.MockTransport(discover))
    runner = CreationGeneration(store, configs, availability=ModelAvailability(configs, probe))
    runner.provider = GenerationProviders(runner.store, httpx.MockTransport(generate), poll_interval=0)
    return runner, config, probe, queries, posts


@pytest.mark.parametrize('model', ['served-image-alias', 'Tongyi-MAI/Z-Image-Turbo', 'Qwen/Qwen-Image-2.1'])
@pytest.mark.parametrize('editing', [False, True])
def test_checked_image_parameters_match_serialized_request(project, model, editing):
    store, pid, session = project
    runner, config, probe, _, posts = image_runtime(project, 4, model, editing=editing)
    sources = [upload(store, str(pid), session, 'source.png', png())] if editing else []
    try:
        receipt = submit('service', project, runner, probe, generation_command(project, config, references=sources))
        assert receipt['status'] == 'accepted', receipt
        job = store.snapshot(pid).jobs[0]
        assert job.status == 'succeeded'
        wire, _ = posts[0]
        checked = generation_capability_parameters(config, 'image', job.adapterParameters, has_images=editing)
        assert {key: str(value) for key, value in checked.items() if key not in {'width', 'height'}} == {
            key: str(value) for key, value in wire.items() if key not in {'model', 'prompt'}}
        assert wire['size'] == f"{checked['width']}x{checked['height']}"
    finally:
        probe.close()


@pytest.mark.parametrize('entry', ['service', 'http', 'agent'])
def test_fixed_image_sampling_is_checked_before_acceptance(project, entry):
    store, pid, session = project
    runner, config, probe, queries, posts = image_runtime(
        project, 0, 'Tongyi-MAI/Z-Image-Turbo', editing=False, sampling_maximum=8)
    command = generation_command(project, config)
    before = store.snapshot(pid)
    try:
        receipt = submit(entry, project, runner, probe, command)
        assert receipt['status'] == 'rejected', receipt
        assert len(queries) == 1 and posts == []
        after = store.snapshot(pid)
        assert not after.jobs
        assert after.generationSpecs == before.generationSpecs and after.assets == before.assets
    finally:
        probe.close()


@pytest.mark.parametrize('entry', ['service', 'http', 'agent'])
@pytest.mark.parametrize('editing', [False, True])
def test_minimax_fixed_response_format_is_checked_before_acceptance(project, entry, editing):
    store, pid, session = project
    configs = ModelConfigs(store.local.repository)
    config = configs.save('image', 'https://api.minimax.cn/v1', 'MiniMax-H3-Image', 'test-key',
                          protocol='openai', capability_auto_check=True)
    operation, profile, path = (('image_edit', 'image_to_image', '/v1/images/edits') if editing
                                else ('image_generation', 'text_to_image', '/v1/images/generations'))
    declaration = document(operation, profile, path, 'image', model=config['modelId'])
    declaration['models'][0]['operations'][operation]['profiles'][0]['routes'][0]['request'] = {
        'parameters': {'response_format': {'support': 'supported', 'enum': ['b64_json']}}}
    probe = CapabilityProbe(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=declaration)))
    posts = []
    def generate(request):
        posts.append(request)
        return httpx.Response(500)
    runner = CreationGeneration(store, configs, availability=ModelAvailability(configs, probe))
    runner.provider = GenerationProviders(runner.store, httpx.MockTransport(generate))
    sources = [upload(store, str(pid), session, 'source.png', png((128, 128)))] if editing else []
    command = generation_command(project, config, references=sources)
    before = store.snapshot(pid)
    try:
        receipt = submit(entry, project, runner, probe, command)
        assert receipt['status'] == 'rejected', receipt
        assert receipt['issues'][0]['code'] == 'capability_unavailable'
        after = store.snapshot(pid)
        assert not after.jobs and posts == []
        assert after.generationSpecs == before.generationSpecs and after.assets == before.assets
    finally:
        probe.close()


def submit(entry, project, runner, probe, command):
    store, pid, session = project
    async def asynchronous():
        try:
            if entry == 'agent':
                arguments = command.model_dump(mode='json', exclude={'commandId', 'projectId'})
                receipt = await AgentTools(store, runner, runner.configs).execute(
                    pid, uuid4(), session, 'submit', 'execute_command', arguments, [], None)
            else:
                receipt = (await runner.execute(command, session=session)).model_dump(mode='json')
            await settled(runner)
            return receipt
        finally:
            await runner.close()
    if entry != 'http':
        return asyncio.run(asynchronous())
    app = create_app(store.local, generation_provider=runner.provider, capability_probe=probe)
    with TestClient(app, headers={'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': session}) as client:
        response = client.post(f'/api/creation/projects/{pid}/commands', json=command.model_dump(mode='json'))
        assert response.status_code == 200, response.text
        receipt = response.json()
        if receipt['status'] == 'accepted':
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                jobs = store.snapshot(pid).jobs
                if jobs and all(job.status in {'succeeded', 'failed'} for job in jobs):
                    break
                time.sleep(.01)
            assert jobs and all(job.status in {'succeeded', 'failed'} for job in jobs), 'Generation did not finish'
        return receipt


@pytest.mark.parametrize('voice,normalization,expected', [
    ('AF_HEART', 'lower', 'accepted'), ('DEFAULT', 'strip_lower', 'accepted'),
    (None, 'strip_lower', 'accepted'),
    ('not-a-speaker', 'lower', 'rejected'),
])
def test_speech_enum_admission_preserves_the_serialized_voice(project, voice, normalization, expected):
    store, pid, session = project
    configs = ModelConfigs(store.local.repository)
    config = configs.save('audio', 'http://speech.test/v1', 'test-speech', '',
        connection_type='self_hosted', protocol='openai', auth_mode='none')
    declaration = document('speech', 'text_to_speech', '/v1/audio/speech', 'audio', model=config['modelId'])
    declaration['models'][0]['operations']['speech']['profiles'][0]['routes'][0]['request'] = {
        'parameters': {'voice': {'type': 'string', 'enum': ['default', 'af_heart', ''],
                                 'enum_normalization': normalization}}}
    probe = CapabilityProbe(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=declaration)))
    posts = []
    def generate(request):
        assert request.method == 'POST' and request.url.path == '/v1/audio/speech'
        posts.append(json.loads(request.read()))
        return httpx.Response(200, content=wav())
    runner = CreationGeneration(store, configs, availability=ModelAvailability(configs, probe))
    runner.provider = GenerationProviders(runner.store, httpx.MockTransport(generate))
    try:
        command = generation_command(project, config, parameters={'voice': voice})
        receipt = submit('service', project, runner, probe, command)
        assert receipt['status'] == expected, receipt
        if expected == 'accepted':
            job = store.snapshot(pid).jobs[0]
            assert job.status == 'succeeded', job
            assert job.inputSnapshot.spec.parameters.voice == voice
            assert posts[0]['voice'] == (voice if voice is not None else 'default')
        else:
            assert not store.snapshot(pid).jobs and not posts
            assert receipt['issues'][0]['code'] == 'capability_unavailable'
    finally:
        probe.close()


def test_metadata_audio_cannot_satisfy_a_required_chat_audio_input(project):
    store, pid, session = project
    configs = ModelConfigs(store.local.repository)
    config = configs.save('agent', 'http://chat.test/v1', 'test-chat', '',
        connection_type='self_hosted', protocol='openai', auth_mode='none')
    declaration = document(model=config['modelId'])
    declaration['models'][0]['operations']['chat']['profiles'][0]['required_inputs'] = ['text', 'audio']
    probe = CapabilityProbe(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=declaration)))
    posts = []
    def generate(request):
        posts.append(request)
        return httpx.Response(200, json={'choices': [{'message': {'content': 'Should not run'}}]})
    runner = CreationGeneration(store, configs, availability=ModelAvailability(configs, probe))
    runner.provider = GenerationProviders(runner.store, httpx.MockTransport(generate))
    source = upload(store, str(pid), session, 'reference.wav', wav())
    try:
        receipt = submit('service', project, runner, probe, generation_command(project, config, references=[source]))
        assert receipt['status'] == 'rejected', receipt
        assert receipt['issues'][0]['code'] == 'capability_unavailable'
        assert not store.snapshot(pid).jobs and not posts
    finally:
        probe.close()


@pytest.mark.parametrize('entry', ['service', 'http', 'agent'])
@pytest.mark.parametrize('maximum', [1, 4])
@pytest.mark.parametrize('over_limit', [False, True])
def test_declared_image_counts_apply_to_every_generation_entry(project, entry, maximum, over_limit):
    store, pid, session = project
    runner, config, probe, queries, posts = image_runtime(project, maximum)
    count = maximum + int(over_limit)
    images = [png(color=(index * 30, 0, 255)) for index in range(count)]
    sources = [upload(store, str(pid), session, f'{index}.png', data) for index, data in enumerate(images)]
    command = generation_command(project, config, references=sources)
    before = store.snapshot(pid)
    try:
        receipt = submit(entry, project, runner, probe, command)
        after = store.snapshot(pid)
        assert len(queries) == 1
        assert after.references == before.references
        if over_limit:
            assert receipt['status'] == 'rejected', receipt
            assert not after.jobs and posts == []
            assert after.generationSpecs == before.generationSpecs
            assert after.canvasItems == before.canvasItems and after.assets == before.assets
            assert after.results == before.results
        else:
            assert receipt['status'] == 'accepted', receipt
            assert len(after.jobs) == len(posts) == 1
            assert after.jobs[0].status == 'succeeded', after.jobs[0]
            assert after.jobs[0].inputSnapshot.spec.prompt == before.generationSpecs[0].prompt
            assert after.jobs[0].inputSnapshot.model.inputRules.maxImages == maximum
            assert [str(item.asset.assetId) for item in after.jobs[0].inputSnapshot.references] == sources
            fields, files = posts[0]
            assert fields['model'] == config['modelId']
            assert [data for _, data in files] == images
            declared = generation_capability_parameters(config, 'image', after.jobs[0].adapterParameters, has_images=True)
            assert {key: str(value) for key, value in declared.items() if key not in {'width', 'height'}} == {
                key: value for key, value in fields.items() if key not in {'model', 'prompt'}}
            assert len(after.results) == 1
    finally:
        probe.close()


def test_unmatched_alias_does_not_apply_another_models_image_limit(project):
    store, pid, session = project
    runner, config, probe, _, posts = image_runtime(project, 1, model='served-image-alias-v2', declared_model='served-image-alias')
    sources = [upload(store, str(pid), session, f'{index}.png', png(color=color))
               for index, color in enumerate(('blue', 'green'))]
    try:
        receipt = submit('service', project, runner, probe, generation_command(project, config, references=sources))
        assert receipt['status'] == 'accepted', receipt
        assert store.snapshot(pid).jobs[0].status == 'succeeded'
        assert posts[0][0]['model'] == 'served-image-alias-v2' and len(posts[0][1]) == 2
    finally:
        probe.close()


def test_zimage_single_image_reaches_the_image_edit_adapter(project):
    store, pid, session = project
    runner, config, probe, _, posts = image_runtime(project, 1, model='Tongyi-MAI/Z-Image-Turbo')
    data = png()
    source = upload(store, str(pid), session, 'source.png', data)
    try:
        receipt = submit('service', project, runner, probe, generation_command(project, config, references=[source]))
        assert receipt['status'] == 'accepted', receipt
        assert store.snapshot(pid).jobs[0].status == 'succeeded', store.snapshot(pid).jobs[0]
        assert len(posts) == 1 and posts[0][0]['model'] == config['modelId']
        assert posts[0][0]['response_format'] == 'b64_json'
        assert [data for _, data in posts[0][1]] == [data]
    finally:
        probe.close()
