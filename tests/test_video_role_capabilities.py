"""Selected video routes must prove the purpose of each transmitted input."""
import pytest

from opendirector.application.model_availability import generation_request, tool_request
from test_model_availability import document, service
from test_video_request_projection import reference, spec, video_config


def configure_declaration(service, profile='video_to_video', *, inputs=None, support='supported'):
    configs, saved, state, availability = service
    config = video_config(configs, saved)
    state['document'] = document('video_generation', profile, '/v1/videos', 'video',
                                 now=state['clock'], model=config['modelId'], support=support)
    entry = state['document']['models'][0]['operations']['video_generation']['profiles'][0]
    entry['required_inputs'] = ['video'] if profile == 'video_to_video' else ['text', 'image']
    entry['routes'][0]['request'] = {'inputs': inputs or {}}
    entry['routes'][0]['exposure'] = 'enabled'
    return config, entry, availability


@pytest.mark.parametrize('actual', [False, True])
@pytest.mark.parametrize('roles,expected', [
    ({}, 'unknown'),
    ({'source_video': {'support': 'supported'}}, 'unknown'),
    ({key: {'support': 'supported'} for key in ('source_video', 'video_noise_mask', 'audio_noise_mask')}, 'available'),
    ({'audio_noise_mask': {'support': 'unsupported'}}, 'unavailable'),
])
def test_catalogue_and_submission_require_the_same_editing_evidence(service, actual, roles, expected):
    config, _, availability = configure_declaration(service, inputs=roles)
    availability.prepare(config)
    result = availability.decision(config, tool_request(config, 'video.edit', actual=actual))
    assert result['status'] == expected


def test_roles_on_another_route_do_not_complete_the_selected_request(service):
    config, entry, availability = configure_declaration(service, inputs={'source_video': {'support': 'supported'}})
    entry['routes'].append({**entry['routes'][0], 'path': '/v1/videos/sync', 'request': {'inputs': {
        'video_noise_mask': {'support': 'supported'}, 'audio_noise_mask': {'support': 'supported'}}}})
    availability.prepare(config)
    assert availability.decision(config, tool_request(config, 'video.edit'))['status'] == 'unknown'


def test_reference_image_support_does_not_grant_first_frame(service):
    config, _, availability = configure_declaration(service, 'image_to_video',
        inputs={'reference_image': {'support': 'supported'}, 'first_frame': {'support': 'unsupported'}})
    availability.prepare(config)
    assert availability.decision(config, tool_request(config, 'video.first_frame'))['status'] == 'unavailable'
    request = generation_request(config, spec('reference'), [reference('image')])
    assert availability.decision(config, request)['status'] == 'available'


def test_explicit_h3_profile_refusal_keeps_its_existing_meaning(service):
    config, entry, availability = configure_declaration(service)
    entry['support'] = 'unsupported'
    availability.prepare(config)
    result = availability.decision(config, tool_request(config, 'video.edit', actual=True))
    assert result['status'] == 'unavailable' and result['reasonCode'] == 'profile_unsupported'


@pytest.mark.parametrize('missing', ['source_video', 'video_noise_mask', 'audio_noise_mask'])
def test_reference_video_cannot_supply_editing_roles(service, missing):
    roles = {key: {'support': 'supported'} for key in
             ('reference_video', 'source_video', 'video_noise_mask', 'audio_noise_mask') if key != missing}
    config, _, availability = configure_declaration(service, inputs=roles)
    availability.prepare(config)
    assert availability.decision(config, tool_request(config, 'video.edit'))['status'] == 'unknown'


@pytest.mark.parametrize('extra', [
    {'source_video': {'support': 'supported', 'min_count': 2}},
    {'audio_noise_mask': {'support': 'supported', 'max_count': 0}},
    {'reference_audio': {'support': 'supported', 'min_count': 1}},
])
def test_catalogue_checks_the_known_tool_input_counts(service, extra):
    roles = {key: {'support': 'supported'} for key in ('source_video', 'video_noise_mask', 'audio_noise_mask')}
    config, _, availability = configure_declaration(service, inputs={**roles, **extra})
    availability.prepare(config)
    assert availability.decision(config, tool_request(config, 'video.edit'))['status'] == 'unavailable'


def test_unknown_profile_still_enforces_known_input_limits(service):
    config, entry, availability = configure_declaration(service,
        inputs={'audio_noise_mask': {'support': 'unsupported'}})
    entry['support'] = 'unknown'
    availability.prepare(config)
    assert availability.decision(config, tool_request(config, 'video.edit', actual=True))['status'] == 'unavailable'
