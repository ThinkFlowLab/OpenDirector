"""Cutout keeps image-edit admission, its RGBA adapter and accepted-task identity."""
import asyncio
import base64
from io import BytesIO
from uuid import uuid4

import httpx
from PIL import Image
import pytest

from opendirector.application.creation_tool_assets import CreationToolAssets
from opendirector.application.model_availability import ModelAvailability, tool_request
from opendirector.application.tool_tasks import ToolTasks
from opendirector.domain.projects import ProjectError
from opendirector.integrations.capability_probe import CapabilityProbe
from test_model_availability import document
from test_tool_native_mask import multipart
from test_tool_tasks import configure, png, project, upload


pytestmark = pytest.mark.cpu


@pytest.mark.parametrize('mode', ['unsupported', 'closed', 'background_denied', 'allowed'])
def test_cutout_checks_edit_request_and_replays_accepted_output(project, mode):
    store, pid, session = project
    configs = configure(store, ('image', 'http://image.test/v1', 'Qwen/Qwen-Image-2.1'))
    saved = configs.list()[0]
    private = configs.resolve(saved['id'], 'image')
    original = png((64, 48), 'blue')
    source = upload(store, pid, session, 'source.png', original)
    raw = document('image_edit', 'image_to_image', '/v1/images/edits', 'image', model=saved['modelId'])
    operation = raw['models'][0]['operations']['image_edit']
    profile = operation['profiles'][0]
    profile['required_inputs'] = ['text', 'image']
    profile['routes'][0].update(exposure='enabled', request={
        'inputs': {'image': {'support': 'supported', 'min_count': 1, 'max_count': 1}},
        'parameters': {'background': {'support': 'supported', 'enum': [
            'opaque' if mode == 'background_denied' else 'transparent']}}})
    if mode == 'unsupported':
        operation['support'] = profile['support'] = 'unsupported'
    if mode == 'closed':
        raw['routes'][0]['exposure'] = 'disabled'
    posts = []
    queries = []

    def discover(request):
        queries.append(request)
        return httpx.Response(200, json=raw)

    def generate(request):
        assert request.method == 'POST' and request.url.path == '/v1/images/edits'
        fields, files = multipart(request)
        posts.append((fields, files))
        layer = Image.new('RGBA', (64, 48), (0, 0, 0, 0))
        layer.paste((200, 200, 200, 255), (16, 8, 48, 40))
        output = BytesIO()
        layer.save(output, 'PNG')
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(output.getvalue()).decode()}]})

    probe = CapabilityProbe(transport=httpx.MockTransport(discover))
    tools = ToolTasks(store.local, configs, CreationToolAssets(store), projects=store,
        availability=ModelAvailability(configs, probe), transport=httpx.MockTransport(generate))
    value = {'id': str(uuid4()), 'tool': 'cutout', 'sourceAssetIds': [source],
             'parameters': {}, 'modelConfigIds': {'image.cutout': saved['id']}}
    before = store.snapshot(pid)

    async def run():
        try:
            if mode != 'allowed':
                with pytest.raises(ProjectError) as failure:
                    await tools.submit(pid, value, session)
                assert failure.value.code == 'capability_unavailable'
                assert tools.list(pid) == [] and posts == []
                assert store.snapshot(pid).assets == before.assets
                assert store.snapshot(pid).jobs == before.jobs
                return
            task = await tools.submit(pid, value, session)
            await asyncio.gather(*tools.jobs.values())
            task = tools.get(pid, task['id'])
            assert task['status'] == 'succeeded', task['error']
            assert len(posts) == 1
            fields, files = posts[0]
            assert fields['background'] == 'transparent'
            assert [name for name, _ in files] == ['image']
            assert task['modelConfigIds'] == {'image.cutout': saved['id']}
            assert task['modelSnapshots']['image.cutout']['modelId'] == saved['modelId']
            assert task['sourceAssetIds'] == [source]
            assert task['imageExecutionPolicy']['requestConstraints']['parameters']['background']['enum'] == ['transparent']
            assets = CreationToolAssets(store)
            assert assets.read_bytes(pid, source) == original
            with Image.open(BytesIO(assets.read_bytes(pid, task['outputs'][0]['id']))) as output:
                assert output.mode == 'RGBA' and output.size == (64, 48)
                assert output.getpixel((32, 24)) == (0, 0, 255, 255)
                assert output.getpixel((2, 2))[3] == 0
            operation['support'] = profile['support'] = 'unsupported'
            probe.query(private, manual=True)
            assert tools.availability.decision(private, tool_request(private, 'image.cutout'))['status'] == 'unavailable'
            query_count = len(queries)
            repeated = await tools.submit(pid, value, session)
            assert repeated['id'] == task['id'] and repeated['outputs'] == task['outputs']
            assert len(posts) == 1 and len(tools.list(pid)) == 1 and len(queries) == query_count
        finally:
            await tools.close()

    try:
        asyncio.run(run())
    finally:
        probe.close()
