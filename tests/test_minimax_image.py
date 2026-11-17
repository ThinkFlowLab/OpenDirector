import asyncio
import base64
import io
import json
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest
from PIL import Image

from opendirector.domain.capabilities import ImageRequest
from opendirector.domain.generation import GenerationError
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.model_adapters import adapter_for
from opendirector.integrations.providers import GenerationProviders
from opendirector.application.creation_generation import CreationGeneration
from opendirector.domain.projects import ProjectError
from opendirector.domain.creation.commands import parse_command
from test_creation_assets import import_asset, ref
from test_creation_canvas_service import project, media, send, ver

URL = 'https://api.minimax.cn/v1'
RESULT = 'https://93.184.215.14/output.png'
MODELS = ('MiniMax-H3-Image', 'MiniMax-H3-Image-Highspeed')
HEIF = Path(__file__).parent / 'fixtures' / 'heif'


def png(color):
    buffer = io.BytesIO()
    Image.new('RGB', (128, 128), color).save(buffer, format='PNG')
    return buffer.getvalue()


@pytest.mark.parametrize('model', MODELS)
def test_image_generation_and_ordered_edits(tmp_path, model):
    configs = ModelConfigs(tmp_path)
    saved = configs.save('image', URL, model, 'test-key', protocol='openai')
    assert saved['inputRules']['maxImages'] == 16
    config = configs.resolve(saved['id'], 'image')
    first, second = png('red'), png('blue')
    calls = []
    checkpoints = []

    def respond(request):
        if request.method == 'GET':
            assert 'authorization' not in request.headers
            return httpx.Response(200, content=first)
        assert request.headers['authorization'] == 'Bearer test-key'
        assert request.extensions['timeout']['read'] == 600
        body = json.loads(request.content)
        assert body['model'] == model and body['output_format'] == 'png'
        calls.append((request.url.path, body))
        return httpx.Response(200, json={'data': [{'url': RESULT}]})

    class Store:
        def asset(self, owner, asset_id):
            data = {'first': first, 'second': second}[asset_id]
            return data, dict(id=asset_id, name=asset_id + '.png', type='image/png',
                              width=128, height=128, fingerprint='test-fingerprint')

    async def ready(suffix, url):
        checkpoints.append((suffix, url))

    async def run():
        transport = httpx.MockTransport(respond)
        provider = GenerationProviders(Store(), transport)
        task = dict(kind='image', projectId='project', prompt='A portrait',
                    referenceIds=['first', 'second'], parameters={'size': '2720x1536'})
        assert await provider.generate(config, task, None, result_ready=ready) == ('png', first)
        assert await provider.resume_result(config, 'png', RESULT) == ('png', first)
        adapter = adapter_for(config, transport)
        assert (await adapter.image(config, ImageRequest('A landscape', 1024, 1024))).data == first
        assert (await adapter.image(config, ImageRequest('Combine', 1024, 1024, first, references=(second,)))).data == first

    asyncio.run(run())
    assert checkpoints == [('png', RESULT)]
    assert [path for path, _ in calls] == ['/v1/images/edits', '/v1/images/generations', '/v1/images/edits']
    assert calls[0][1]['size'] == '2720x1536'
    expected = [{'image_url': 'data:image/png;base64,' + base64.b64encode(data).decode()} for data in (first, second)]
    assert calls[0][1]['images'] == calls[2][1]['images'] == expected


def test_submission_timeout_does_not_retry(tmp_path):
    configs = ModelConfigs(tmp_path)
    saved = configs.save('image', URL, MODELS[0], 'test-key', protocol='openai')
    config = configs.resolve(saved['id'], 'image')
    calls = []

    def timeout(request):
        calls.append(request.method)
        raise httpx.ReadTimeout('timed out')

    adapter = adapter_for(config, httpx.MockTransport(timeout))
    with pytest.raises(GenerationError) as failure:
        asyncio.run(adapter.image(config, ImageRequest('A landscape', 1024, 1024)))
    assert failure.value.details.category == 'submission_unknown'
    assert calls == ['POST']


@pytest.mark.parametrize('model', MODELS)
@pytest.mark.parametrize('source', ['ui', 'agent'])
def test_mixed_heif_edits_share_original_assets_and_frozen_order(project, model, source):
    projects, pid, session = project
    configs = ModelConfigs(projects.local.repository)
    saved = configs.save('image', URL, model, 'fixture-key', protocol='openai')
    inputs = [('oriented.heif', (HEIF / 'oriented.heif').read_bytes()), ('red.png', png('red')),
              ('oriented.heic', (HEIF / 'oriented.heic').read_bytes())]
    for fmt in ('JPEG', 'WEBP'):
        output = io.BytesIO()
        Image.new('RGB', (128, 128), 'green').save(output, fmt)
        inputs.append((f'green.{fmt.lower()}', output.getvalue()))
    assets = [import_asset(project, name, data)[0] for name, data in inputs]
    target, spec = media(project, kind='image')
    spec = spec.model_copy(update={'prompt': 'Combine in reference order', 'modelConfigId': UUID(saved['id'])})
    assert send(projects, pid, 'generationSpec.update', session=session,
        versions=[ver('generation_spec', spec)], spec=spec).status == 'applied'
    for index, asset in enumerate(assets):
        spec = projects.snapshot(pid).generationSpecs[-1]
        target = projects.snapshot(pid).canvasItems[-1]
        receipt = send(projects, pid, 'reference.add', session=session,
            versions=[ver('generation_spec', spec), ver('canvas_item', target)], reference=dict(id=uuid4(), projectId=pid,
                targetSpecId=spec.id, binding='pinned', source=ref(asset), order=index))
        assert receipt.status == 'applied', receipt
    calls = []
    result = png('purple')

    def respond(request):
        if request.method == 'GET':
            return httpx.Response(200, content=result)
        assert request.url.path == '/v1/images/edits'
        calls.append(json.loads(request.content))
        return httpx.Response(200, json={'data': [{'url': RESULT}]})

    async def run():
        transport = httpx.MockTransport(respond)
        runner = CreationGeneration(projects, configs)
        runner.provider = GenerationProviders(runner.store, transport)
        try:
            snapshot = projects.snapshot(pid)
            spec, target = snapshot.generationSpecs[-1], snapshot.canvasItems[-1]
            command = parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit',
                expectedVersions=[ver('generation_spec', spec), ver('canvas_item', target)],
                payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=target.id)))
            receipt = await runner.execute(command, session=session, source=source)
            assert receipt.status == 'accepted', receipt
            await asyncio.gather(*(job.future for job in list(runner.jobs.values())))
            snapshot = projects.snapshot(pid)
            job = snapshot.jobs[0]
            assert job.status == 'succeeded' and job.adopted, job
            assert [r.asset for r in job.inputSnapshot.references] == [ref(asset) for asset in assets]
            assert len(snapshot.results) == 1
            assert (await runner.execute(command, session=session, source=source)) == receipt
            with runner.assets.open_media(pid, snapshot.results[0].asset.assetId)[0] as stream:
                assert stream.read() == result
            config = configs.resolve(saved['id'], 'image')
            adapter = adapter_for(config, transport)
            assert (await adapter.image(config, ImageRequest('Combine', 1024, 1024,
                inputs[0][1], references=tuple(data for _, data in inputs[1:])))).data == result
        finally:
            await runner.close()

    asyncio.run(run())
    expected = [{'image_url': f'data:{asset.metadata.mimeType};base64,' + base64.b64encode(data).decode()}
                for asset, (_, data) in zip(assets, inputs)]
    assert len(calls) == 2
    assert calls[0]['images'] == calls[1]['images'] == expected


@pytest.mark.parametrize('invalid', ['corrupt', 'small', 'edge', 'ratio', 'count', 'bytes'])
def test_heif_reference_limits_reject_before_provider_request(tmp_path, invalid):
    configs = ModelConfigs(tmp_path)
    saved = configs.save('image', URL, MODELS[0], 'fixture-key', protocol='openai')
    config = configs.resolve(saved['id'], 'image')
    data = (HEIF / 'oriented.heic').read_bytes()
    references = ()
    if invalid == 'corrupt':
        data = data[:100]
    elif invalid in {'small', 'edge', 'ratio'}:
        output = io.BytesIO()
        Image.new('RGB', {'small': (127, 128), 'edge': (8193, 2048), 'ratio': (128, 513)}[invalid]).save(output, 'HEIF')
        data = output.getvalue()
    elif invalid == 'count':
        references = (data,) * 16
    elif invalid == 'bytes':
        # Each valid file fits, but their Base64 JSON exceeds the request budget.
        data += b'\0' * (25 * 1024 * 1024)
        references = (data,)

    def unexpected(request):
        pytest.fail('Invalid input reached the provider')

    with pytest.raises(ProjectError) as failure:
        asyncio.run(adapter_for(config, httpx.MockTransport(unexpected)).image(config,
            ImageRequest('Combine', 1024, 1024, data, references=references)))
    assert failure.value.status == (413 if invalid == 'bytes' else 422)
