"""Image quality uses shared commands, fixed execution inputs and real PNG files."""
import asyncio
import base64
from email.parser import BytesParser
from email.policy import default
from io import BytesIO
import json
from pathlib import Path
from uuid import uuid4

import httpx
from PIL import Image
from pydantic import ValidationError
import pytest

from generation_helpers import command, new_project, prepared, settled
from opendirector.agent.tools import AgentTools
from opendirector.application.creation_generation import CreationGeneration
from opendirector.application.creation_tool_assets import CreationToolAssets
from opendirector.domain.creation.generation import ImageExecution, ImageParameters
from opendirector.domain.creation.project import ProjectSnapshot
from opendirector.domain.input_rules import input_rules
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.providers import GenerationProviders
from opendirector_api.localization import localized_error_for_language
from test_creation_canvas_service import send, ver


def png():
    stream = BytesIO()
    Image.new('RGB', (32, 24), 'green').save(stream, 'PNG')
    return stream.getvalue()


def generated(quality='auto'):
    return httpx.Response(200, json={'quality': quality, 'data': [{'b64_json': base64.b64encode(png()).decode()}]})


def fields(request):
    if request.headers['content-type'].startswith('application/json'):
        return json.loads(request.content), []
    message = BytesParser(policy=default).parsebytes(
        b'Content-Type: ' + request.headers['content-type'].encode() + b'\r\n\r\n' + request.content)
    values, files = {}, []
    for part in message.iter_parts():
        name = part.get_param('name', header='content-disposition')
        if part.get_filename():
            files.append((name, part.get_payload(decode=True)))
        else:
            values[name] = part.get_payload(decode=True).decode()
    return values, files


@pytest.fixture
def context(tmp_path):
    project = new_project(tmp_path, 'Image quality')
    configs = ModelConfigs(tmp_path)
    return project, configs


def model(configs, name='gpt-image-2'):
    return configs.save('image', 'https://images.test/v1', name, 'fixture-image-key', protocol='openai')


@pytest.mark.parametrize('name', ['gpt-image-2', 'chatgpt-image-latest'])
def test_only_gpt_image_profiles_publish_quality_choices(name):
    config = dict(kind='image', protocol='openai', url='https://images.test/v1', modelId=name)
    assert input_rules(config)['imageQualities'] == ['auto', 'low', 'medium', 'high']
    assert 'imageQualities' not in input_rules({**config, 'modelId': 'compatible-image'})
    assert 'imageQualities' not in input_rules({**config, 'protocol': 'volcengine'})


@pytest.mark.parametrize('quality', [None, 'auto', 'low', 'medium', 'high'])
@pytest.mark.parametrize('reference_count', [0, 2])
def test_quality_reaches_json_and_reference_requests_and_persisted_execution(context, quality, reference_count):
    project, configs = context
    store, pid, session = project
    config = model(configs)
    seen = []

    def handle(request):
        seen.append(request)
        return generated(quality or 'auto')

    async def run():
        runner = CreationGeneration(store, configs)
        runner.provider = GenerationProviders(runner.store, httpx.MockTransport(handle), retry_delays=(0, 0))
        try:
            assets = CreationToolAssets(store)
            refs = [assets.import_file(pid, uuid4(), f'reference-{index}.png', png(), session)['id']
                    for index in range(reference_count)]
            parameters = {} if quality is None else {'quality': quality}
            accepted = prepared(runner, project, config, prompt='A green lighthouse', parameters=parameters, references=refs)
            runner._launch(*accepted)
            await settled(runner)
            snapshot = store.snapshot(pid)
            job = snapshot.jobs[-1]
            assert job.status == 'succeeded', job.errorDetails
            assert job.adopted
            assert job.inputSnapshot.spec.parameters.quality == (quality or 'auto')
            assert job.execution.quality == (quality or 'auto')
            assert len(seen) == 1
            payload, images = fields(seen[0])
            assert seen[0].url.path == ('/v1/images/edits' if reference_count else '/v1/images/generations')
            if quality in {None, 'auto'}:
                assert 'quality' not in payload
                assert 'quality' not in job.adapterParameters
                assert 'quality' not in job.inputSnapshot.spec.parameters.model_dump()
                assert 'quality' not in job.execution.model_dump()
            else:
                assert payload['quality'] == job.adapterParameters['quality'] == quality
            assert images == [('image[]', png())] * reference_count
            assert CreationProjects(LocalProjects(store.local.repository)).snapshot(pid) == snapshot
            asset = next(asset for asset in snapshot.assets if asset.id == job.asset.assetId)
            assert (asset.metadata.width, asset.metadata.height) == (32, 24)
        finally:
            await runner.close()

    asyncio.run(run())


@pytest.mark.parametrize('quality', [None, 'auto'])
def test_compatible_models_never_send_quality(context, quality):
    project, configs = context
    store, pid, _ = project
    config = model(configs, 'compatible-image')
    seen = []

    def handle(request):
        seen.append(request)
        return generated()

    async def run():
        runner = CreationGeneration(store, configs)
        runner.provider = GenerationProviders(runner.store, httpx.MockTransport(handle))
        try:
            runner._launch(*prepared(runner, project, config, parameters={} if quality is None else {'quality': quality}))
            await settled(runner)
            assert store.snapshot(pid).jobs[-1].status == 'succeeded'
            assert 'quality' not in fields(seen[0])[0]
        finally:
            await runner.close()

    asyncio.run(run())


@pytest.mark.parametrize('quality', ['low', 'medium', 'high'])
def test_unsupported_quality_is_rejected_before_job_creation(context, quality):
    project, configs = context
    store, pid, session = project
    config = model(configs, 'compatible-image')
    runner = CreationGeneration(store, configs)
    request = command(project, config, parameters={'quality': quality})
    before = store.snapshot(pid)
    receipt = runner.prepare(request, session=session)
    assert receipt.status == 'rejected'
    assert receipt.issues[0].code == 'image_quality_unsupported'
    assert store.snapshot(pid) == before
    english = localized_error_for_language('en-US', chinese=receipt.issues[0].message, status=422, code=receipt.issues[0].code)
    assert english == 'This model does not support the selected image quality. Choose Auto or select another model.'


@pytest.mark.parametrize('quality', ['ultra', '', 1, None])
def test_invalid_quality_is_rejected_by_the_parameter_contract(quality):
    with pytest.raises(ValidationError):
        ImageParameters.model_validate({'quality': quality})


def test_auto_keeps_historical_snapshot_fingerprints_and_wire_parameters_unchanged():
    path = Path(__file__).parent / 'fixtures' / 'creation-project.json'
    original = json.loads(path.read_text())
    restored = ProjectSnapshot.model_validate(original)
    assert restored.jobs
    for job in restored.jobs:
        assert job.inputFingerprint == job.inputSnapshot.fingerprint()
        if job.inputSnapshot.spec.kind == 'image':
            assert job.inputSnapshot.spec.parameters.quality == 'auto'
            assert job.execution.quality == 'auto'
            assert 'quality' not in job.model_dump()['inputSnapshot']['spec']['parameters']
            assert 'quality' not in job.model_dump()['execution']
    assert ImageParameters().model_dump() == ImageParameters(quality='auto').model_dump()
    assert ImageExecution(kind='image', size='1024x1024').model_dump() == {
        'kind': 'image', 'size': '1024x1024', 'responseFormat': None, 'outputFormat': 'png', 'watermark': None}


def test_download_recovery_preserves_quality_after_current_settings_change(context):
    project, configs = context
    store, pid, session = project
    config = model(configs)
    healthy, seen = False, []

    def handle(request):
        seen.append(request)
        if request.method == 'POST':
            assert fields(request)[0]['quality'] == 'high'
            return httpx.Response(200, json={'quality': 'high', 'data': [{'url': 'https://images.test/v1/result.png'}]})
        if not healthy:
            raise httpx.ReadTimeout('isolated download failure', request=request)
        return httpx.Response(200, content=png())

    async def run():
        nonlocal healthy
        first = CreationGeneration(store, configs)
        provider = GenerationProviders(first.store, httpx.MockTransport(handle), retry_delays=(0, 0))
        first.provider = provider
        try:
            first._launch(*prepared(first, project, config, parameters={'quality': 'high'}))
            await settled(first)
            snapshot = store.snapshot(pid)
            original = snapshot.jobs[-1]
            assert original.recovery == 'download'
            spec = snapshot.generationSpecs[-1]
            changed = spec.model_copy(update={'parameters': ImageParameters(quality='low')})
            assert send(store, pid, 'generationSpec.update', session=session,
                        versions=[ver('generation_spec', spec)], spec=changed).status == 'applied'
        finally:
            await first.close()
        healthy = True
        restarted = CreationGeneration(store, configs)
        restarted.provider = GenerationProviders(restarted.store, httpx.MockTransport(handle), retry_delays=(0, 0))
        try:
            await restarted.start()
            await settled(restarted)
            snapshot = store.snapshot(pid)
            job = snapshot.jobs[-1]
            assert job.status == 'succeeded'
            assert job.id == original.id
            assert job.inputSnapshot.spec.parameters.quality == job.execution.quality == job.adapterParameters['quality'] == 'high'
            assert snapshot.generationSpecs[-1].parameters.quality == 'low'
            assert job.adopted is False
            assert sum(request.method == 'POST' for request in seen) == 1
            assert len(snapshot.assets) == 1
            assert CreationProjects(LocalProjects(store.local.repository)).snapshot(pid) == snapshot
        finally:
            await restarted.close()

    asyncio.run(run())


def test_queued_job_restarts_with_its_original_quality_after_settings_change(context):
    project, configs = context
    store, pid, session = project
    config = model(configs)
    seen = []

    def handle(request):
        seen.append(fields(request)[0])
        return generated('high')

    async def run():
        first = CreationGeneration(store, configs)
        try:
            prepared(first, project, config, parameters={'quality': 'high'})
            spec = store.snapshot(pid).generationSpecs[-1]
            changed = spec.model_copy(update={'parameters': ImageParameters(quality='low')})
            assert send(store, pid, 'generationSpec.update', session=session,
                        versions=[ver('generation_spec', spec)], spec=changed).status == 'applied'
        finally:
            await first.close()
        restarted = CreationGeneration(store, configs)
        restarted.provider = GenerationProviders(restarted.store, httpx.MockTransport(handle))
        try:
            await restarted.start()
            await settled(restarted)
            snapshot = store.snapshot(pid)
            assert snapshot.jobs[-1].status == 'succeeded'
            assert snapshot.jobs[-1].adopted is False
            assert snapshot.jobs[-1].execution.quality == 'high'
            assert snapshot.generationSpecs[-1].parameters.quality == 'low'
            assert len(seen) == 1 and seen[0]['quality'] == 'high'
        finally:
            await restarted.close()

    asyncio.run(run())


@pytest.mark.parametrize('name,choices', [('gpt-image-2', ['auto', 'low', 'medium', 'high']), ('compatible-image', ['auto'])])
def test_agent_schema_uses_the_selected_models_quality_choices(context, name, choices):
    project, configs = context
    config = model(configs, name)
    business = AgentTools(project[0], None, configs)

    async def run():
        result = await business.execute(project[1], uuid4(), project[2], 'quality-schema', 'command_schema',
            {'type': 'generationSpec.update', 'modelConfigId': config['id'], 'path': 'payload.spec.parameters.quality'}, [], None)
        assert result['enum'] == choices

    asyncio.run(run())


def test_agent_submit_uses_the_same_quality_parameter_and_execution_snapshot(context):
    project, configs = context
    store, pid, session = project
    config = model(configs)
    seen = []

    def handle(request):
        seen.append(fields(request)[0])
        return generated('high')

    async def run():
        runner = CreationGeneration(store, configs)
        runner.provider = GenerationProviders(runner.store, httpx.MockTransport(handle))
        business = AgentTools(store, runner, configs)
        try:
            request = command(project, config, parameters={'quality': 'high'})
            arguments = request.model_dump(mode='json', exclude={'commandId', 'projectId'})
            receipt = await business.execute(pid, uuid4(), session, 'quality-submit', 'execute_command', arguments, [], None)
            assert receipt['status'] == 'accepted'
            await settled(runner)
            snapshot = store.snapshot(pid)
            assert seen[0]['quality'] == 'high'
            assert snapshot.jobs[-1].execution.quality == 'high'
            assert snapshot.jobs[-1].inputSnapshot.spec.parameters.quality == 'high'
            original = snapshot.jobs[-1]
            spec = snapshot.generationSpecs[-1]
            changed = spec.model_copy(update={'parameters': ImageParameters(quality='low')})
            assert send(store, pid, 'generationSpec.update', session=session,
                        versions=[ver('generation_spec', spec)], spec=changed).status == 'applied'
            current = store.snapshot(pid).generationSpecs[-1]
            assert current.parameters.quality == 'low'
            restored = send(store, pid, 'generationSpec.restore', session=session,
                            versions=[ver('generation_spec', current)], specId=spec.id,
                            commandId=receipt['commandId'], referencePolicy='pinned')
            assert restored.status == 'applied', restored
            snapshot = store.snapshot(pid)
            assert snapshot.generationSpecs[-1].parameters.quality == 'high'
            assert snapshot.jobs[-1] == original
            assert CreationProjects(LocalProjects(store.local.repository)).snapshot(pid) == snapshot
        finally:
            await runner.close()

    asyncio.run(run())
