"""The catalogue and submitted latent continuation share endpoint observations."""
from opendirector.application.model_availability import generation_request
from test_model_availability import document, service
from test_video_request_projection import reference, spec, video_config
import pytest


@pytest.mark.parametrize('state,expected,reason', [
    ('open', 'unknown', 'profile_not_declared'),
    ('closed', 'unavailable', 'route_disabled'),
    ('paused', 'unavailable', 'execution_paused'),
    ('unsupported', 'unavailable', 'operation_unsupported'),
])
def test_continuation_catalogue_matches_actual_request(service, state, expected, reason):
    configs, saved, observed, availability = service
    config = video_config(configs, saved)
    observed['document'] = document('video_generation', 'video_to_video', '/v1/videos', 'video',
                                    model=config['modelId'], now=observed['clock'])
    operation = observed['document']['models'][0]['operations']['video_generation']
    operation['profiles'][0]['support'] = 'unsupported'
    if state == 'closed':
        observed['document']['routes'][0]['exposure'] = 'disabled'
    if state == 'paused':
        operation['execution']['state'] = 'paused'
    if state == 'unsupported':
        operation['support'] = 'unsupported'
    availability.prepare(config)
    actual = generation_request(config, spec('continuation'), [reference('video', 'continuation', 'latent')])
    catalogue = {item['profile']: item for item in availability.model(config)['operations']}
    decision = availability.decision(config, actual)
    assert catalogue['video_continuation'] == decision
    assert (decision['status'], decision['reasonCode']) == (expected, reason)
    assert 'video' not in actual.inputs and 'video' not in dict(actual.input_counts)
    assert catalogue['video_to_video']['status'] == 'unavailable'
    if state == 'paused':
        observed['clock'] += 6
        expired = {item['profile']: item for item in availability.model(config)['operations']}['video_continuation']
        assert expired['status'] == 'unknown' and expired['execution']['state'] == 'unknown'
        assert expired['declaration']['reasonCode'] == 'profile_not_declared'


def test_catalogue_does_not_add_continuation_to_an_adapter_without_it(service):
    configs, saved, _, availability = service
    config = {**video_config(configs, saved), 'modelId': 'Wan-AI/Wan2.2-TI2V-5B'}
    assert 'video_continuation' not in {item['profile'] for item in availability.model(config)['operations']}
