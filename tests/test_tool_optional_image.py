"""Optional background completion fixes its model choice before segmentation."""
import asyncio
from copy import deepcopy
from uuid import uuid4

import httpx
import pytest

from opendirector.application.creation_tool_assets import CreationToolAssets
from opendirector.application.model_availability import ModelAvailability
from opendirector.application.tool_tasks import ToolTasks
from opendirector.domain.projects import ProjectError
from opendirector.integrations.capability_probe import CapabilityProbe
from test_model_availability import document
from test_tool_tasks import project, configure, upload, png, SAM3, segmentation_server, output_rgba


@pytest.mark.parametrize('state', ['paused', 'unsupported', 'added', 'changed', 'legacy'])
def test_layer_background_completion_never_selects_a_later_model_for_new_work(project, state):
    store, pid, session = project
    configs = configure(store, SAM3)
    model = None
    if state in {'paused', 'unsupported', 'changed'}:
        model = configs.save('image', 'http://image.test/v1', 'image-before', '', connection_type='self_hosted', protocol='openai')
    declaration = document('image_edit', 'image_to_image', '/v1/images/edits', 'image', model='image-before',
                           support='unsupported' if state == 'unsupported' else 'supported')
    if state == 'paused':
        declaration['models'][0]['operations']['image_edit']['execution']['state'] = 'paused'
    probe = CapabilityProbe(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=declaration)))
    source = upload(store, pid, session, 'source.png', png())
    mask = upload(store, pid, session, 'mask.png', png(color='white', mode='L'))
    segments, edits = [], []
    tools = ToolTasks(store.local, configs, CreationToolAssets(store), projects=store, concurrency=1,
        availability=ModelAvailability(configs, probe),
        transport=httpx.MockTransport(segmentation_server(segments, {'person': [(0.9, (10, 8, 30, 32))]}, edits=edits)))
    value = {'id': str(uuid4()), 'tool': 'layer-decompose', 'sourceAssetIds': [source],
             'parameters': {'mode': 'description', 'prompt': 'person'}}
    async def run():
        try:
            if state in {'paused', 'unsupported'}:
                with pytest.raises(ProjectError) as error:
                    await tools.submit(pid, {'id': str(uuid4()), 'tool': 'inpainting-remove',
                        'sourceAssetIds': [source], 'maskAssetId': mask, 'parameters': {}}, session)
                assert error.value.code == ('capability_paused' if state == 'paused' else 'capability_unavailable')
                assert not tools.list(pid) and not segments and not edits
            await tools.limit.acquire()
            accepted = await tools.submit(pid, value, session)
            expected = 'model' if state == 'changed' else 'transparent'
            assert accepted['backgroundCompletion'] == expected
            frozen = deepcopy(accepted['modelSnapshots'])
            if state in {'added', 'legacy'}:
                if state == 'legacy':
                    with tools.store.transaction():
                        old = tools.get(pid, accepted['id'])
                        old.pop('backgroundCompletion')
                        tools._write(tools._directory(pid), old)
                configs.save('image', 'http://later.test/v1', 'image-later', '', connection_type='self_hosted', protocol='openai')
            elif state == 'changed':
                configs.save('image', 'http://later.test/v1', 'image-later', '', model['id'],
                    connection_type='self_hosted', protocol='openai')
            tools.limit.release()
            await asyncio.gather(*tools.jobs.values())
            result = tools.get(pid, accepted['id'])
            assert result['status'] == 'succeeded', result['error']
            assert result['modelSnapshots'] == frozen and len(result['outputs']) == 2
            assert (await tools.submit(pid, value, session))['id'] == accepted['id']
            assert segments == ['person']
            if state == 'legacy':
                assert len(edits) == 1 and 'backgroundCompletion' not in result
                assert output_rgba(store, pid, result).getpixel((20, 20))[3] == 255
            else:
                assert not edits and output_rgba(store, pid, result).getpixel((20, 20))[3] == 0
                assert result['backgroundCompletion'] == expected
        finally:
            await tools.close()
    try:
        asyncio.run(run())
    finally:
        probe.close()
