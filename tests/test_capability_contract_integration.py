"""Shared names select adapter requests; they never authorize a whole deployment."""
from copy import deepcopy

import pytest

from opendirector.application.model_availability import tool_request
from opendirector.domain import capability_contract as contract
from opendirector.domain.projects import ProjectError
from opendirector.integrations.model_adapters import capabilities_of
from test_model_availability import document, service


pytestmark = pytest.mark.cpu


def config(kind, protocol='openai'):
    return {'kind': kind, 'protocol': protocol, 'url': 'http://models.test/proxy/v1',
            'modelId': 'demo'}


@pytest.mark.parametrize('capability,kind,protocol,operation,profile,path,output', [
    ('text.chat', 'agent', 'openai', 'chat', 'text_response', '/chat/completions', 'text'),
    ('image.generate', 'image', 'openai', 'image_generation', 'text_to_image', '/images/generations', 'image'),
    ('image.edit', 'image', 'openai', 'image_edit', 'image_to_image', '/images/edits', 'image'),
    ('image.cutout', 'image', 'openai', 'image_edit', 'image_to_image', '/images/edits', 'image'),
    ('video.generate', 'video', 'vllm_omni', 'video_generation', 'text_to_video', '/videos', 'video'),
    ('video.first_frame', 'video', 'vllm_omni', 'video_generation', 'image_to_video', '/videos', 'video'),
    ('video.edit', 'video', 'vllm_omni', 'video_generation', 'video_to_video', '/videos', 'video'),
    ('audio.speech', 'audio', 'openai', 'speech', 'text_to_speech', '/audio/speech', 'audio'),
    ('audio.music', 'audio', 'vllm_omni_music', 'speech', 'lyrics_to_music', '/audio/speech', 'audio'),
])
@pytest.mark.parametrize('actual', [False, True])
def test_shared_candidates_keep_the_adapters_request(
        capability, kind, protocol, operation, profile, path, output, actual):
    request = tool_request(config(kind, protocol), capability, actual=actual)
    assert (request.operation, request.profile, request.path, request.output, request.method) == (
        operation, profile, '/proxy/v1' + path, output, 'POST')


def test_an_absent_shared_candidate_is_not_replaced_by_a_local_mapping(monkeypatch):
    monkeypatch.delitem(contract.BY_CAPABILITY, 'video.first_frame')
    assert tool_request(config('video', 'vllm_omni'), 'video.first_frame') is None


def test_a_matching_profile_under_another_operation_is_not_selected(monkeypatch):
    monkeypatch.setitem(contract.BY_CAPABILITY, 'video.first_frame', (('image_edit', 'image_to_video'),))
    assert tool_request(config('video', 'vllm_omni'), 'video.first_frame') is None


@pytest.mark.parametrize('capability', ['video.first_frame', 'video.edit'])
def test_required_roles_are_read_from_the_shared_contract(monkeypatch, capability):
    calls = []
    original = contract.required_roles_for

    def read(value):
        calls.append(value)
        return original(value)

    monkeypatch.setattr(contract, 'required_roles_for', read)
    request = tool_request(config('video', 'vllm_omni'), capability)
    assert calls == [capability]
    assert request.required_roles == frozenset(original(capability))


@pytest.mark.parametrize('kind,protocol,capability', [
    ('video', 'volcengine', 'video.first_frame'),
    ('audio', 'openai', 'audio.music'),
    ('audio', 'vllm_omni_music', 'audio.speech'),
    ('audio', 'openai', 'audio.effect'),
])
def test_a_shared_candidate_cannot_add_an_adapter_request(kind, protocol, capability):
    assert tool_request(config(kind, protocol), capability) is None


def test_editing_support_does_not_grant_a_cutout_adapter():
    ordinary = {**config('image'), 'modelId': 'gpt-image-1'}
    rgba = {**config('image'), 'modelId': 'Qwen/Qwen-Image-2.1', 'connectionType': 'self_hosted'}
    assert contract.candidates_for('image.cutout') == ()
    assert 'image.cutout' not in capabilities_of(ordinary)
    assert 'image.edit' in capabilities_of(ordinary)
    assert 'image.cutout' in capabilities_of(rgba)
    assert tool_request(rgba, 'image.cutout', actual=True).profile == 'image_to_image'


def test_deployment_summary_does_not_grant_a_different_selected_model(service):
    configs, _, state, availability = service
    saved = configs.save('image', 'http://models.test/v1', 'selected', '', connection_type='self_hosted')
    private = configs.resolve(saved['id'], saved['kind'])
    raw = document('image_edit', 'image_to_image', '/v1/images/edits', 'image',
                   model='selected', support='unsupported', now=state['clock'])
    other = deepcopy(raw['models'][0])
    other['id'] = 'other'
    operation = other['operations']['image_edit']
    operation['support'] = operation['profiles'][0]['support'] = 'supported'
    operation['profiles'][0]['routes'][0]['exposure'] = 'enabled'
    raw['models'].append(other)
    state['document'] = raw
    assert contract.resolve(raw)['capabilities']['image.edit'] == 'available'
    availability.prepare(private)
    assert availability.decision(private, tool_request(private, 'image.edit'))['status'] == 'unavailable'


@pytest.mark.parametrize('capability,scenario,status,reason', [
    ('video.first_frame', 'minimum_two', 'unavailable', 'required_inputs_missing'),
    ('video.first_frame', 'maximum_zero', 'unavailable', 'input_count_exceeded'),
    ('video.first_frame', 'complete', 'available', None),
    ('video.edit', 'complete', 'available', None),
    ('video.edit', 'split_routes', 'unknown', 'input_contract_unknown'),
    ('video.first_frame', 'missing_roles', 'unknown', 'input_contract_unknown'),
])
@pytest.mark.parametrize('actual', [False, True])
def test_catalogue_and_submission_check_counts_on_the_actual_route(
        service, capability, scenario, status, reason, actual):
    configs, _, state, availability = service
    saved = configs.save('video', 'http://models.test/proxy/v1', 'MiniMaxAI/MiniMax-H3', '',
                         protocol='vllm_omni', connection_type='self_hosted')
    private = configs.resolve(saved['id'], 'video')
    request = tool_request(private, capability, actual=actual)
    raw = document(request.operation, request.profile, request.path, 'video',
                   model=saved['modelId'], now=state['clock'])
    profile = raw['models'][0]['operations'][request.operation]['profiles'][0]
    roles = {role: {'support': 'supported'} for role in request.required_roles}
    route = profile['routes'][0]
    route.update(exposure='enabled', request={'inputs': roles})
    if scenario == 'minimum_two':
        roles['first_frame']['min_count'] = 2
    elif scenario == 'maximum_zero':
        roles['first_frame']['max_count'] = 0
    elif scenario == 'missing_roles':
        roles.clear()
    elif scenario == 'split_routes':
        second = deepcopy(route)
        second['path'] = '/proxy/v1/videos/sync'
        del second['request']['inputs']['source_video']
        del roles['video_noise_mask'], roles['audio_noise_mask']
        profile['routes'].append(second)
    state['document'] = raw
    availability.prepare(private)
    decision = availability.decision(private, request)
    assert decision['status'] == status
    if status != 'available':
        assert decision['reasonCode'] == reason
    if status == 'unavailable':
        with pytest.raises(ProjectError) as error:
            availability.require(private, request)
        assert error.value.code == 'capability_unavailable'
    else:
        availability.require(private, request)
    # The same negative facts cannot continue rejecting after their expiry.
    state['clock'] += 30
    assert availability.decision(private, request)['status'] == 'unknown'
    availability.require(private, request)
