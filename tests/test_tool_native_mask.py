"""Real tool acceptance, serialized image roles and preserved output pixels."""
import asyncio
import base64
from copy import deepcopy
from email import policy as email_policy
from email.parser import BytesParser
from io import BytesIO
from unittest.mock import Mock
from uuid import uuid4

import httpx
from PIL import Image
import pytest

from opendirector.application.creation_tool_assets import CreationToolAssets
from opendirector.application.model_availability import ModelAvailability
from opendirector.application.tool_tasks import ToolTasks
from opendirector.domain.capabilities import ImageRequest
from opendirector.domain.image_inputs import image_input_policy
from opendirector.domain.projects import ProjectError
from opendirector.integrations.capability_probe import CapabilityProbe
from opendirector.integrations.model_adapters import adapter_for
from opendirector.integrations import model_adapters
from opendirector.media import processing as media
from test_tool_tasks import project, configure, upload, png, output_image
from test_model_availability import document


MODEL = ('image', 'http://image.test/v1', 'test-native-edit')


def native_policy(config):
    return {**image_input_policy(config), 'nativeMask': {
        'field': 'mask_image', 'referenceField': 'reference_image', 'encoding': 'grayscale_white_edit',
        'sameSize': True, 'minImages': 1, 'maxImages': 1, 'maxReferenceImages': 1,
        'widthMultiple': 16, 'heightMultiple': 16, 'minWidth': 32, 'minHeight': 32,
        'maxPixels': 2048 * 2048}}


def multipart(request):
    message = BytesParser(policy=email_policy.default).parsebytes(
        b'Content-Type: ' + request.headers['content-type'].encode() + b'\r\n\r\n' + request.read())
    fields, files = {}, []
    for part in message.iter_parts():
        name = part.get_param('name', header='content-disposition')
        payload = part.get_payload(decode=True)
        if part.get_filename():
            files.append((name, payload))
        else:
            fields[name] = payload.decode()
    return fields, files


def image_server(calls):
    def respond(request):
        assert request.url.path == '/v1/images/edits'
        fields, files = multipart(request)
        calls.append((fields, files))
        size = tuple(map(int, fields['size'].split('x')))
        return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(png(size, 'red')).decode()}]})
    return respond


def runtime(store, config, configs, calls, selected_policy):
    probe = CapabilityProbe(transport=httpx.MockTransport(lambda _: httpx.Response(404)))
    availability = ModelAvailability(configs, probe)
    # Only the remote declaration is doubled; actual policy validation, tools,
    # persistence, provider adapter and result import all run unchanged.
    availability.image_execution_policy = lambda _: deepcopy(selected_policy)
    return ToolTasks(store.local, configs, CreationToolAssets(store), projects=store, concurrency=1,
                     availability=availability, transport=httpx.MockTransport(image_server(calls))), probe


@pytest.mark.parametrize('tool', ['smart-edit', 'combined', 'inpainting-remove', 'outpaint', 'product-replacement', 'multi-size'])
def test_native_selection_serializes_actual_roles_and_preserves_unselected_pixels(project, tool):
    store, pid, session = project
    configs = configure(store, MODEL)
    config = configs.list()[0]
    source = upload(store, pid, session, 'source.png', png((64, 64)))
    mask = Image.new('RGBA', (64, 64), (0, 0, 0, 0))
    mask.paste((255, 255, 255, 255), (16, 16, 48, 48))
    mask_id = upload(store, pid, session, 'selection.png', media.png(mask))
    value = {'id': str(uuid4()), 'tool': 'smart-edit' if tool == 'combined' else tool,
             'sourceAssetIds': [source], 'parameters': {}}
    if tool in {'smart-edit', 'combined', 'inpainting-remove'}:
        value.update(maskAssetId=mask_id, parameters={'editMode': 'combined' if tool == 'combined' else 'selection', 'prompt': 'make it red'})
    if tool == 'combined':
        value['annotationAssetId'] = upload(store, pid, session, 'annotation.png', png((64, 64), 'green'))
    if tool == 'outpaint':
        value['parameters'] = {'right': 1, 'outputWidth': 128, 'outputHeight': 64}
    if tool == 'multi-size':
        value['parameters'] = {'outputWidth': 128, 'outputHeight': 64}
    if tool == 'product-replacement':
        value['sourceAssetIds'].append(upload(store, pid, session, 'product.png', png((32, 32), 'green')))
        value['boxes'] = [{'x': 16, 'y': 16, 'width': 32, 'height': 32}]
    calls = []
    selected_policy = native_policy(config)
    tools, probe = runtime(store, config, configs, calls, selected_policy)
    async def run():
        try:
            await tools.limit.acquire()
            accepted = await tools.submit(pid, value, session)
            assert accepted['imageExecution']['mode'] == 'native_mask'
            frozen = deepcopy(accepted['imageExecutionPolicy'])
            selected_policy['nativeMask'] = None
            tools.availability.image_execution_policy = Mock(side_effect=AssertionError('accepted work queried new policy'))
            tools.limit.release()
            await asyncio.gather(*tools.jobs.values())
            result = tools.get(pid, accepted['id'])
            assert result['status'] == 'succeeded', result['error']
            assert result['imageExecutionPolicy'] == frozen
            replay = await tools.submit(pid, value, session)
            assert replay['id'] == accepted['id'] and len(calls) == 1
            tools.availability.image_execution_policy.assert_not_called()
            return result
        finally:
            await tools.close()
    try:
        task = asyncio.run(run())
    finally:
        probe.close()
    fields, files = calls[0]
    assert [name for name, _ in files] == ['image', 'mask_image'] + (['reference_image'] if tool == 'combined' else [])
    primary, selection = [Image.open(BytesIO(data)) for _, data in files[:2]]
    expected_size = (128, 64) if tool in {'outpaint', 'multi-size'} else (64, 64)
    assert primary.size == selection.size == expected_size
    assert selection.mode == 'L' and fields['size'] == f'{expected_size[0]}x{expected_size[1]}'
    if tool == 'outpaint':
        assert selection.getpixel((32, 32)) == 0 and selection.getpixel((96, 32)) == 255
        assert output_image(store, pid, task).getpixel((32, 32)) == (0, 0, 255)
    elif tool == 'multi-size':
        assert selection.getpixel((64, 32)) == 0 and selection.getpixel((0, 32)) == 255
        assert output_image(store, pid, task).getpixel((64, 32)) == (0, 0, 255)
    else:
        assert selection.getpixel((0, 0)) == 0 and selection.getpixel((32, 32)) == 255
        assert output_image(store, pid, task).getpixel((0, 0)) == (0, 0, 255)
    if tool == 'product-replacement':
        assert primary.getpixel((32, 32)) == (0, 128, 0)  # Two sources composed into one transmitted image.


@pytest.mark.parametrize('reason', ['unknown', 'geometry', 'output_size', 'annotation_only', 'no_reference_role'])
def test_unsuitable_native_selection_chooses_existing_flow_once(project, reason):
    store, pid, session = project
    configs = configure(store, MODEL)
    config = configs.list()[0]
    size = (65, 64) if reason == 'geometry' else (64, 64)
    source = upload(store, pid, session, 'source.png', png(size))
    mask = upload(store, pid, session, 'selection.png', png(size, 'white', 'L'))
    selected_policy = native_policy(config)
    value = {'id': str(uuid4()), 'tool': 'smart-edit', 'sourceAssetIds': [source], 'maskAssetId': mask,
             'parameters': {'editMode': 'selection', 'prompt': 'red'}}
    if reason == 'unknown':
        selected_policy['nativeMask'] = None
    if reason == 'annotation_only':
        value['parameters']['editMode'] = 'annotation'
    if reason == 'output_size':
        value.update(tool='outpaint', parameters={'right': 1, 'outputWidth': 256, 'outputHeight': 128})
    if reason == 'no_reference_role':
        selected_policy['nativeMask']['referenceField'] = None
        value['parameters']['editMode'] = 'combined'
        value['annotationAssetId'] = upload(store, pid, session, 'annotation.png', png(size, 'green'))
    calls = []
    tools, probe = runtime(store, config, configs, calls, selected_policy)
    async def run():
        try:
            task = await tools.submit(pid, value, session)
            assert task['imageExecution']['mode'] == 'legacy'
            await asyncio.gather(*tools.jobs.values())
            assert tools.get(pid, task['id'])['status'] == 'succeeded'
        finally:
            await tools.close()
    try:
        asyncio.run(run())
    finally:
        probe.close()
    assert len(calls) == 1 and all(name == 'image' for name, _ in calls[0][1])


@pytest.mark.parametrize('model,count', [('compatible-image', 9), ('Qwen/Qwen-Image-2.1', 5), ('gpt-image-1', 17)])
def test_over_limit_adapter_inputs_are_rejected_without_slicing_or_http(model, count):
    config = {'kind': 'image', 'url': MODEL[1], 'modelId': model, 'protocol': 'openai'}
    calls = []
    adapter = adapter_for(config, httpx.MockTransport(image_server(calls)))
    request = ImageRequest('edit', 64, 64, image=png(), references=(png(),) * (count - 1))
    with pytest.raises(ProjectError) as failure:
        asyncio.run(adapter.image(config, request))
    assert failure.value.code == 'image_input_count'
    assert len(request.references) == count - 1 and calls == []


def test_compatible_adapter_sends_every_image_allowed_by_the_shared_policy():
    config = {'kind': 'image', 'url': MODEL[1], 'modelId': 'compatible-image', 'protocol': 'openai'}
    calls = []
    adapter = adapter_for(config, httpx.MockTransport(image_server(calls)))
    images = [png(color=color) for color in ('blue', 'green', 'red')]
    asyncio.run(adapter.image(config, ImageRequest('edit', 64, 64, image=images[0], references=tuple(images[1:]))))
    assert [data for _, data in calls[0][1]] == images


@pytest.mark.parametrize('model,count,sent', [('compatible-image', 9, 1), ('Qwen/Qwen-Image-2.1', 6, 4), ('gpt-image-1', 18, 16)])
def test_legacy_adapter_reconstructs_the_accepted_request_without_new_limits(model, count, sent):
    config = {'kind': 'image', 'url': MODEL[1], 'modelId': model, 'protocol': 'openai'}
    calls = []
    # New byte limits must not be retroactively applied to accepted old work.
    policy = {**image_input_policy(config), 'imageBytes': 1, 'requestBytes': 1}
    adapter = adapter_for(config, httpx.MockTransport(image_server(calls)), image_policy=policy, legacy_image_policy=True)
    request = ImageRequest('edit', 64, 64, image=png(), references=(png(),) * (count - 1))
    asyncio.run(adapter.image(config, request))
    assert len(calls) == 1 and len(calls[0][1]) == sent
    assert len(request.references) == count - 1


@pytest.mark.parametrize('tool,count', [('outpaint', 2), ('product-replacement', 3)])
def test_extra_recipe_sources_are_rejected_before_acceptance(project, tool, count):
    store, pid, session = project
    configs = configure(store, MODEL)
    config = configs.list()[0]
    sources = [upload(store, pid, session, f'{index}.png', png()) for index in range(count)]
    calls = []
    tools, probe = runtime(store, config, configs, calls, native_policy(config))
    async def run():
        try:
            with pytest.raises(ProjectError) as failure:
                await tools.submit(pid, {'id': str(uuid4()), 'tool': tool, 'sourceAssetIds': sources, 'parameters': {}}, session)
            assert failure.value.code == 'tool_source_count'
            assert tools.list(pid) == [] and calls == []
        finally:
            await tools.close()
    try:
        asyncio.run(run())
    finally:
        probe.close()


def test_native_provider_failure_does_not_retry_with_another_edit_mode(project):
    store, pid, session = project
    configs = configure(store, MODEL)
    config = configs.list()[0]
    source = upload(store, pid, session, 'source.png', png((64, 64)))
    mask = upload(store, pid, session, 'selection.png', png((64, 64), 'white', 'L'))
    calls = []
    tools, probe = runtime(store, config, configs, calls, native_policy(config))
    def reject(request):
        calls.append(multipart(request))
        return httpx.Response(400, json={'error': {'message': 'Rejected selection'}})
    tools.transport = httpx.MockTransport(reject)
    async def run():
        try:
            task = await tools.submit(pid, {'id': str(uuid4()), 'tool': 'smart-edit', 'sourceAssetIds': [source],
                'maskAssetId': mask, 'parameters': {'editMode': 'selection', 'prompt': 'red'}}, session)
            await asyncio.gather(*tools.jobs.values())
            result = tools.get(pid, task['id'])
            assert result['status'] == 'failed' and result['imageExecution']['mode'] == 'native_mask'
            assert len(result['modelCalls']) == len(calls) == 1
            assert [name for name, _ in calls[0][1]] == ['image', 'mask_image']
        finally:
            await tools.close()
    try:
        asyncio.run(run())
    finally:
        probe.close()


def test_empty_selection_rejects_before_creating_a_task(project):
    store, pid, session = project
    configs = configure(store, MODEL)
    config = configs.list()[0]
    source = upload(store, pid, session, 'source.png', png((64, 64)))
    mask = upload(store, pid, session, 'selection.png', png((64, 64), 'black', 'L'))
    calls = []
    tools, probe = runtime(store, config, configs, calls, native_policy(config))
    async def run():
        try:
            with pytest.raises(ProjectError):
                await tools.submit(pid, {'id': str(uuid4()), 'tool': 'inpainting-remove',
                    'sourceAssetIds': [source], 'maskAssetId': mask, 'parameters': {}}, session)
            assert tools.list(pid) == [] and calls == []
        finally:
            await tools.close()
    try:
        asyncio.run(run())
    finally:
        probe.close()


@pytest.mark.parametrize('maximum', [0, 1])
def test_tool_admission_uses_declared_roles_and_limits_from_the_actual_route(project, maximum):
    store, pid, session = project
    configs = configure(store, MODEL)
    source = upload(store, pid, session, 'source.png', png((64, 64)))
    mask = upload(store, pid, session, 'selection.png', png((64, 64), 'white', 'L'))
    annotation = upload(store, pid, session, 'annotation.png', png((64, 64), 'green'))
    declaration = document('image_edit', 'image_to_image', '/v1/images/edits', 'image', model=MODEL[2])
    profile = declaration['models'][0]['operations']['image_edit']['profiles'][0]
    profile['required_inputs'] = ['text', 'image']
    profile['routes'][0]['request'] = {
        'inputs': {'image': {'support': 'supported', 'max_count': maximum},
                   'mask_image': {'support': 'supported', 'max_count': 1},
                   'reference_image': {'support': 'supported', 'max_count': 1}},
        'mask': {'support': 'supported', 'source_role': 'image', 'max_source_count': 1,
                 'white': 'edit', 'black': 'preserve', 'binarize_threshold': 0.5,
                 'requires_same_size': True, 'geometry': {'state': 'known', 'multiple_of': 16},
                 'source_resize': {'max_pixels': 2048 * 2048, 'policy': 'downscale_preserve_aspect_ratio'}}}
    probe = CapabilityProbe(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=declaration)))
    calls = []
    tools = ToolTasks(store.local, configs, CreationToolAssets(store), projects=store,
        availability=ModelAvailability(configs, probe), transport=httpx.MockTransport(image_server(calls)))
    value = {'id': str(uuid4()), 'tool': 'smart-edit', 'sourceAssetIds': [source],
             'maskAssetId': mask, 'annotationAssetId': annotation,
             'parameters': {'editMode': 'combined', 'prompt': 'red'}}
    async def run():
        try:
            if not maximum:
                with pytest.raises(ProjectError) as error:
                    await tools.submit(pid, value, session)
                assert error.value.code == 'image_input_count'
                assert tools.list(pid) == [] and calls == []
                return
            task = await tools.submit(pid, value, session)
            await asyncio.gather(*tools.jobs.values())
            result = tools.get(pid, task['id'])
            assert result['status'] == 'succeeded', result['error']
            assert result['imageExecution']['roles'] == ['image', 'mask', 'reference']
            assert result['imageExecutionPolicy']['maxImages'] == 1
            assert [name for name, _ in calls[0][1]] == ['image', 'mask_image', 'reference_image']
        finally:
            await tools.close()
    try:
        asyncio.run(run())
    finally:
        probe.close()


def test_local_upscale_preserves_multiple_recipe_sources(project):
    store, pid, session = project
    configs = configure(store, MODEL)
    sources = [upload(store, pid, session, f'{color}.png', png((64, 64), color)) for color in ('blue', 'green')]
    calls = []
    tools, probe = runtime(store, configs.list()[0], configs, calls, native_policy(configs.list()[0]))
    async def run():
        try:
            task = await tools.submit(pid, {'id': str(uuid4()), 'tool': 'image-hd', 'sourceAssetIds': sources,
                'parameters': {'kind': 'normal', 'resolution': '2K'}}, session)
            await asyncio.gather(*tools.jobs.values())
            result = tools.get(pid, task['id'])
            assert result['status'] == 'succeeded' and len(result['outputs']) == 2
            assert result['sourceAssetIds'] == sources and calls == []
            assert [output_image(store, pid, result, index).getpixel((10, 10)) for index in range(2)] == [(0, 0, 255), (0, 128, 0)]
        finally:
            await tools.close()
    try:
        asyncio.run(run())
    finally:
        probe.close()


@pytest.mark.parametrize('state,reason,message', [
    ('paused', 'execution_paused', '服务已暂停，请恢复后重试。'),
    ('unsupported', 'operation_unsupported', '该模型不支持图片编辑。'),
    ('disabled', 'route_disabled', '服务未开放图片编辑。'),
])
def test_tool_catalog_keeps_the_specific_cached_unavailability_reason(project, state, reason, message):
    store, _, _ = project
    configs = configure(store, MODEL)
    config = configs.list()[0]
    declaration = document('image_edit', 'image_to_image', '/v1/images/edits', 'image', model=MODEL[2],
                           support='unsupported' if state == 'unsupported' else 'supported')
    operation = declaration['models'][0]['operations']['image_edit']
    if state == 'paused':
        operation['execution']['state'] = 'paused'
    elif state == 'disabled':
        operation['profiles'][0]['routes'][0]['exposure'] = 'disabled'
    calls = []
    probe = CapabilityProbe(transport=httpx.MockTransport(lambda request: calls.append(request) or httpx.Response(200, json=declaration)))
    availability = ModelAvailability(configs, probe)
    tools = ToolTasks(store.local, configs, CreationToolAssets(store), projects=store, availability=availability)
    try:
        availability.refresh([config['id']])
        tools.availability.prepare = Mock(side_effect=AssertionError('catalog queried the service'))
        entry = next(item for item in tools.catalog()['tools'] if item['id'] == 'outpaint')
        assert not entry['available'] and entry['reasonCode'] == reason and entry['reason'] == message
        assert len(calls) == 1
    finally:
        probe.close()


def test_accepted_legacy_tool_keeps_single_annotation_input_without_native_mask(project):
    store, pid, session = project
    configs = configure(store, MODEL)
    config = configs.list()[0]
    source = upload(store, pid, session, 'source.png', png((64, 64)))
    annotation = upload(store, pid, session, 'annotation.png', png((64, 64), 'green'))
    mask = upload(store, pid, session, 'selection.png', png((64, 64), 'white', 'L'))
    value = {'id': str(uuid4()), 'tool': 'smart-edit', 'sourceAssetIds': [source],
             'maskAssetId': mask, 'annotationAssetId': annotation,
             'parameters': {'editMode': 'combined', 'prompt': 'red'}}
    calls = []
    tools, probe = runtime(store, config, configs, calls, native_policy(config))
    async def run():
        try:
            await tools.limit.acquire()
            accepted = await tools.submit(pid, value, session)
            # This is the persisted shape written by the previous version.
            with tools.store.transaction():
                legacy = tools.get(pid, accepted['id'])
                legacy.pop('imageExecutionPolicy')
                legacy.pop('imageExecution')
                tools._write(tools._directory(pid), legacy)
            tools.availability.image_execution_policy = Mock(side_effect=AssertionError('legacy task checked new policy'))
            tools.limit.release()
            await asyncio.gather(*tools.jobs.values())
            result = tools.get(pid, accepted['id'])
            assert result['status'] == 'succeeded', result['error']
            replay = await tools.submit(pid, value, session)
            assert replay['id'] == result['id'] and len(calls) == 1
            assert 'imageExecutionPolicy' not in result
            tools.availability.image_execution_policy.assert_not_called()
        finally:
            await tools.close()
    try:
        asyncio.run(run())
    finally:
        probe.close()
    assert [name for name, _ in calls[0][1]] == ['image']
    assert Image.open(BytesIO(calls[0][1][0][1])).getpixel((32, 32)) == (0, 128, 0)


@pytest.mark.parametrize('legacy', [False, True])
def test_cutout_freezes_its_image_policy_and_preserves_accepted_legacy_validation(project, monkeypatch, legacy):
    store, pid, session = project
    configs = configure(store, ('image', MODEL[1], 'Qwen/Qwen-Image-2.1'))
    config = configs.list()[0]
    source = upload(store, pid, session, 'source.png', png((64, 64)))
    calls = []
    selected_policy = native_policy(config)
    tools, probe = runtime(store, config, configs, calls, selected_policy)
    value = {'id': str(uuid4()), 'tool': 'cutout', 'sourceAssetIds': [source], 'parameters': {}}
    async def run():
        try:
            await tools.limit.acquire()
            accepted = await tools.submit(pid, value, session)
            assert accepted['requires'] == ['image.cutout']
            assert accepted['imageExecutionPolicy']['nativeMask'] is None
            if legacy:
                with tools.store.transaction():
                    saved = tools.get(pid, accepted['id'])
                    saved.pop('imageExecutionPolicy')
                    saved.pop('imageExecution')
                    tools._write(tools._directory(pid), saved)
                validate = Mock(side_effect=AssertionError('old cutout acquired new validation rules'))
                monkeypatch.setattr(model_adapters, 'validate_image_request', validate)
            selected_policy['imageBytes'] = 1
            tools.availability.image_execution_policy = Mock(side_effect=AssertionError('accepted cutout checked current policy'))
            tools.limit.release()
            await asyncio.gather(*tools.jobs.values())
            result = tools.get(pid, accepted['id'])
            assert result['status'] == 'succeeded', result['error']
            assert (await tools.submit(pid, value, session))['id'] == accepted['id']
            assert len(calls) == 1 and [name for name, _ in calls[0][1]] == ['image']
            assert ('imageExecutionPolicy' not in result) if legacy else result['imageExecutionPolicy']['imageBytes'] > 1
            if legacy:
                validate.assert_not_called()
            tools.availability.image_execution_policy.assert_not_called()
        finally:
            await tools.close()
    try:
        asyncio.run(run())
    finally:
        probe.close()
