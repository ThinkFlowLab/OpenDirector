import asyncio
import base64
import io
import json

import httpx
import pytest
from PIL import Image

from opendirector.domain.capabilities import ImageRequest
from opendirector.domain.generation import GenerationError
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.generation_capability_parameters import generation_capability_parameters
from opendirector.integrations.model_adapters import adapter_for
from opendirector.integrations.providers import GenerationProviders

URL = 'https://api.minimax.cn/v1'
RESULT = 'https://93.184.215.14/output.png'
MODELS = ('MiniMax-H3-Image', 'MiniMax-H3-Image-Highspeed')


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
    adapter = adapter_for(config)
    projections = [
        generation_capability_parameters(config, 'image', {'size': '2720x1536'}, has_images=True),
        adapter.image_parameters(1024, 1024, has_images=False),
        adapter.image_parameters(1024, 1024, has_images=True),
    ]
    actual = [{key: value for key, value in body.items() if key not in {'model', 'prompt', 'images'}}
              for _, body in calls]
    checked = [{key: value for key, value in item.items() if key not in {'width', 'height'}}
               for item in projections]
    assert checked == actual


@pytest.mark.parametrize('field', ['mask', 'reference'])
def test_unsupported_auxiliary_image_is_not_silently_dropped(tmp_path, field):
    configs = ModelConfigs(tmp_path)
    saved = configs.save('image', URL, MODELS[0], 'test-key', protocol='openai')
    config = configs.resolve(saved['id'], 'image')
    calls = []

    def respond(request):
        calls.append(request.method)
        return (httpx.Response(200, content=png('blue')) if request.method == 'GET'
                else httpx.Response(200, json={'data': [{'url': RESULT}]}))

    adapter = adapter_for(config, httpx.MockTransport(respond))
    with pytest.raises(ProjectError) as failure:
        asyncio.run(adapter.image(config, ImageRequest('Edit', 128, 128, png('red'), **{field: png('blue')})))
    assert failure.value.code == 'image_input_mask'
    assert calls == []


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
