"""FastH3 admission must describe its actual uploads and accepted execution."""
import asyncio
import json
from uuid import UUID, uuid4

import httpx
import pytest

from generation_helpers import command, settled
from opendirector.application.creation_canvas import asset_ref
from opendirector.application.creation_generation import CreationGeneration
from opendirector.application.model_availability import ModelAvailability, generation_request
from opendirector.domain.creation.commands import parse_command
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.capability_probe import CapabilityProbe
from opendirector.integrations.providers import GenerationProviders
from test_creation_canvas_service import media, project, send, ver
from test_request_capability_acceptance import submit
from test_tool_tasks import png, upload
from test_video_capability_acceptance import clip, video_service


pytestmark = pytest.mark.cpu


def frame_command(project, config, *, same_asset=False, mode='first_frame'):
    store, pid, session = project
    pictures = [png(color='red'), png(color='red' if same_asset else 'blue')]
    first = upload(store, str(pid), session, 'first.png', pictures[0])
    last = first if same_asset else upload(store, str(pid), session, 'last.png', pictures[1])
    request = command(project, config, parameters={'videoMode': mode, 'durationSeconds': 5})
    for index, (asset_id, role) in enumerate(((first, 'first_frame'), (last, 'last_frame'))):
        source, _ = media(project, 'image', title=role)
        asset = next(a for a in store.snapshot(pid).assets if str(a.id) == str(asset_id))
        assert send(store, pid, 'canvas.materialize', session=session, versions=[ver('canvas_item', source)],
                    itemId=source.id, asset=asset_ref(asset)).status == 'applied'
        snapshot = store.snapshot(pid)
        spec = next(s for s in snapshot.generationSpecs if s.id == request.payload.specId)
        item = next(i for i in snapshot.canvasItems if i.id == request.payload.originItemId)
        receipt = send(store, pid, 'reference.add', session=session,
            versions=[ver('generation_spec', spec), ver('canvas_item', item)],
            reference=dict(id=uuid4(), projectId=pid, targetSpecId=spec.id, order=1 - index,
                role=role if mode == 'first_frame' else 'reference', binding='follow_current', source={'id': source.id}))
        assert receipt.status == 'applied', receipt
    snapshot = store.snapshot(pid)
    spec = next(s for s in snapshot.generationSpecs if s.id == request.payload.specId)
    item = next(i for i in snapshot.canvasItems if i.id == request.payload.originItemId)
    value = request.model_dump(mode='json')
    value.update(expectedVersions=[ver('generation_spec', spec), ver('canvas_item', item)])
    value['payload']['expectedSpecRevision'] = spec.revision
    return parse_command(value), pictures


def contract(case, mode):
    roles = ('first_frame', 'last_frame') if mode == 'first_frame' else ('reference_image',)
    value = {'inputs': {role: {'support': 'supported'} for role in roles}, 'parameters': {}}
    value['inputs']['image'] = {'support': 'supported', 'min_count': 2, 'max_count': 2}
    values = value['parameters']
    if case in {'allowed', 'recover'}:
        values.update(task={'type': 'string', 'enum': ['fl2va' if mode == 'first_frame' else 'ref2va']},
                      num_inference_steps={'type': 'integer', 'minimum': 20 if mode == 'first_frame' else 8,
                                           'maximum': 20 if mode == 'first_frame' else 8})
    elif case == 'steps':
        values['num_inference_steps'] = {'type': 'integer', 'maximum': 10}
    elif case == 'task':
        values['task'] = {'type': 'string', 'enum': ['ref2va']}
    elif case in {'sampler', 'frame_indices'}:
        values[case] = {'support': 'unsupported'}
    elif case == 'image_count':
        value['inputs']['image'].update(min_count=0, max_count=1)
    elif case == 'unknown_role':
        value['inputs'].pop('last_frame')
    return value


@pytest.mark.parametrize('entry,case,same_asset,mode', [
    ('http', 'steps', False, 'first_frame'), ('agent', 'steps', True, 'first_frame'),
    ('http', 'task', False, 'first_frame'), ('http', 'sampler', False, 'first_frame'),
    ('http', 'frame_indices', False, 'first_frame'), ('http', 'image_count', True, 'first_frame'),
    ('http', 'allowed', False, 'first_frame'), ('agent', 'allowed', True, 'first_frame'),
    ('http', 'unknown_role', True, 'first_frame'), ('http', 'allowed', False, 'reference'),
    ('http', 'recover', True, 'first_frame'),
])
def test_fast_h3_contract_matches_http_uploads_saved_results_and_recovery(project, clip, entry, case, same_asset, mode):
    store, pid, session = project
    declared = contract(case, mode)
    with video_service(clip, 'generation', model='FastH3-Omni-INT8', generation_contract=declared) as (url, state):
        configs = ModelConfigs(store.local.repository)
        config = configs.save('video', url, 'FastH3-Omni-INT8', '', connection_type='self_hosted',
                              protocol='vllm_omni', auth_mode='none', video_adapter='fasth3_dual')
        probe = CapabilityProbe(transport=httpx.HTTPTransport())
        runner = CreationGeneration(store, configs, availability=ModelAvailability(configs, probe))
        runner.provider = GenerationProviders(runner.store, poll_interval=0)
        request, pictures = frame_command(project, config, same_asset=same_asset, mode=mode)
        before = store.snapshot(pid)
        accepted = case in {'allowed', 'unknown_role', 'recover'}
        if case == 'recover':
            state['fail_downloads'] = 1
        try:
            receipt = submit(entry, project, runner, probe, request)
            after = store.snapshot(pid)
            assert receipt['status'] == ('accepted' if accepted else 'rejected'), receipt
            if not accepted:
                assert receipt['issues'][0]['code'] in (
                    {'capability_unavailable', 'invalid_input'} if case == 'image_count' else {'capability_unavailable'})
                assert not after.jobs and not state['posts'] and after.assets == before.assets
                assert after.generationSpecs == before.generationSpecs and after.references == before.references
                return
            job = after.jobs[0]
            assert len(state['posts']) == 1
            fields, uploads = state['posts'][0]
            checked_request = generation_request(config, job.inputSnapshot.spec, job.inputSnapshot.references,
                                                 parameters=job.adapterParameters)
            checked = dict(checked_request.parameters)
            sent = {**fields, **json.loads(fields['extra_params'])}
            expected_steps = 20 if mode == 'first_frame' else 8
            assert checked['num_inference_steps'] == job.adapterParameters['num_inference_steps'] == expected_steps
            assert fields['num_inference_steps'] == str(expected_steps)
            assert checked['task'] == sent['task'] == ('fl2va' if mode == 'first_frame' else 'ref2va')
            assert {key: json.dumps(value) if isinstance(value, tuple) else str(value)
                    for key, value in checked.items() if key not in {'width', 'height'}} == {
                key: json.dumps(value) if isinstance(value, list) else str(value)
                for key, value in sent.items() if key not in {'model', 'prompt', 'extra_params'}}
            assert dict(checked_request.input_counts)['image'] == len(uploads) == 2
            assert [name for name, _ in uploads] == ['input_references', 'input_references']
            assert [data for _, data in uploads] == (pictures if mode == 'first_frame' else pictures[::-1])
            if mode == 'first_frame':
                assert sent['frame_indices'] == [0, -1] and checked['frame_indices'] == (0, -1)
                assert sent['sampler'] == checked['sampler'] == 'res_multistep'
                assert dict(checked_request.input_counts)['first_frame'] == dict(checked_request.input_counts)['last_frame'] == 1
            else:
                assert 'frame_indices' not in sent and 'sampler' not in sent
            assert fields['num_frames'] == str(job.execution.numFrames) == str(job.adapterParameters['num_frames']) == '120'
            frozen, parameters = job.inputSnapshot, job.adapterParameters
            declared['parameters']['task'] = {'support': 'unsupported'}
            # Each HTTP application owns and closes its discovery worker pool.
            probe.close()
            probe = CapabilityProbe(transport=httpx.HTTPTransport())
            probe.query(config, manual=True)
            if case == 'recover':
                assert job.status == 'failed' and job.resumeAllowed
                # Restart the manager, change current declarations and recover the paid job.
                replacement = CreationGeneration(store, configs, availability=ModelAvailability(configs, probe))
                replacement.provider = GenerationProviders(replacement.store, poll_interval=0)
                async def recover():
                    try:
                        await replacement.recover(pid, job.id, session)
                        await settled(replacement)
                    finally:
                        await replacement.close()
                asyncio.run(recover())
                job = store.snapshot(pid).jobs[0]
                assert state['downloads'] == 2
            assert job.status == 'succeeded' and job.externalTaskId == 'remote-video'
            assert job.inputSnapshot == frozen and job.adapterParameters == parameters
            assert runner.store.asset(str(pid), str(job.asset.assetId))[0] == clip
            replay = request.model_copy(update={'commandId': UUID(receipt['commandId'])})
            again = submit('http', project, runner, probe, replay)
            assert again['jobIds'] == receipt['jobIds'] and len(state['posts']) == 1
            assert store.snapshot(pid).jobs[0] == job
        finally:
            probe.close()
