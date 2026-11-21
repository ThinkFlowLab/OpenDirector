"""Remote observation age and local cache lifetime are independent limits."""
from dataclasses import replace
from datetime import datetime, timezone

import pytest

from opendirector.application.model_availability import requests_for
from test_model_availability import NOW, private, service


def observed(age):
    return datetime.fromtimestamp(NOW - age, timezone.utc).isoformat()


@pytest.mark.parametrize('age,reason,remaining', [
    (21 * 86400, 'stale_declaration', 0),
    (30, 'stale_declaration', 0),
    (29.5, 'operation_unsupported', .5),
    (28, 'operation_unsupported', 2),
    (0, 'operation_unsupported', 30),
    (-2, 'operation_unsupported', 30),
    (-2.001, 'observation_time_invalid', 0),
])
def test_declaration_age_limits_negative_evidence_and_cache(service, age, reason, remaining):
    configs, saved, state, availability = service
    state['document']['observed_at'] = observed(age)
    operation = state['document']['models'][0]['operations']['chat']
    operation['support'] = operation['profiles'][0]['support'] = 'unsupported'
    availability.refresh()
    config = private(configs, saved)
    value = availability.model(config)
    assert value['reasonCode'] == reason
    assert value['status'] == ('unavailable' if remaining else 'unknown')
    if remaining:
        assert (value['expiresAt'] - value['checkedAt']) / 1000 == remaining
        state['clock'] += remaining
        assert availability.model(config)['status'] == 'unknown'
    assert len(state['calls']) == 1  # Reading expiration never contacts the service.


def test_refresh_cannot_renew_a_document_that_has_expired_at_its_source(service):
    configs, saved, state, availability = service
    state['document']['observed_at'] = observed(28)
    availability.refresh()
    state['clock'] += 2
    availability.prepare(private(configs, saved))
    value = availability.model(private(configs, saved))
    assert value['status'] == 'unknown' and value['reasonCode'] == 'stale_declaration'
    assert len(state['calls']) == 2


@pytest.mark.parametrize('age,remaining', [(21 * 86400, 0), (5, 0), (4.5, .5), (0, 5), (-2, 5), (-2.001, 0)])
@pytest.mark.parametrize('scope', ['deployment', 'worker'])
def test_execution_age_expires_independently_of_a_fresh_declaration(service, age, remaining, scope):
    configs, saved, state, availability = service
    execution = state['document']['models'][0]['operations']['chat']['execution']
    execution.update(state='paused', scope=scope, observed_at=observed(age))
    availability.refresh()
    value = availability.model(private(configs, saved))['operations'][0]
    assert value['declaration']['status'] == 'available'
    assert value['execution']['state'] == ('paused' if remaining else 'unknown')
    assert value['status'] == ('unavailable' if remaining and scope == 'deployment' else 'available')
    if remaining:
        assert (value['execution']['expiresAt'] - value['execution']['checkedAt']) / 1000 == remaining
        state['clock'] += remaining
        assert availability.model(private(configs, saved))['status'] == 'available'
    else:
        # An already rejected pause must not force a network query on each submit.
        availability.prepare(private(configs, saved))
    assert len(state['calls']) == 1


def test_pause_refresh_uses_the_remaining_remote_lifetime(service):
    configs, saved, state, availability = service
    state['document']['models'][0]['operations']['chat']['execution'].update(state='paused', observed_at=observed(4))
    availability.refresh()
    state['clock'] += 1
    availability.prepare(private(configs, saved))
    assert len(state['calls']) == 2
    assert availability.model(private(configs, saved))['status'] == 'available'


def test_execution_never_outlives_its_document(service):
    configs, saved, state, availability = service
    state['document']['observed_at'] = observed(29)
    state['document']['models'][0]['operations']['chat']['execution']['state'] = 'paused'
    availability.refresh()
    value = availability.model(private(configs, saved))['operations'][0]
    assert value['execution']['expiresAt'] == value['declaration']['expiresAt'] == (NOW + 1) * 1000
    state['clock'] += 1
    assert availability.model(private(configs, saved))['status'] == 'unknown'


@pytest.mark.parametrize('invalid', [None, 'not a timestamp', '2026-11-11T12:00:00'])
def test_invalid_optional_execution_timestamp_preserves_declaration(service, invalid):
    configs, saved, state, availability = service
    state['document']['models'][0]['operations']['chat']['execution'].update(state='paused', observed_at=invalid)
    availability.refresh()
    value = availability.model(private(configs, saved))['operations'][0]
    assert value['status'] == 'available' and value['execution']['state'] == 'unknown'


def test_system_clock_change_does_not_renew_remote_pause(service):
    configs, saved, state, availability = service
    state['document']['models'][0]['operations']['chat']['execution'].update(state='paused', observed_at=observed(3))
    availability.refresh()
    availability.probe.wall_clock = lambda: NOW - 86400
    state['clock'] += 1
    assert availability.model(private(configs, saved))['status'] == 'unavailable'
    availability.probe.wall_clock = lambda: NOW + 86400
    state['clock'] += 1
    assert availability.model(private(configs, saved))['status'] == 'available'


@pytest.mark.parametrize('age', [0, 30, 21 * 86400, -2.001])
def test_expired_request_constraints_cannot_reject_actual_inputs(service, age):
    configs, saved, state, availability = service
    state['document']['observed_at'] = observed(age)
    state['document']['models'][0]['operations']['chat']['profiles'][0]['routes'][0]['request'] = {
        'inputs': {'image': {'support': 'supported', 'max_count': 1}},
        'parameters': {'max_tokens': {'support': 'supported', 'type': 'integer', 'maximum': 10}},
    }
    config = private(configs, saved)
    availability.refresh()
    request = replace(requests_for(config)[0], inputs=frozenset({'text', 'image'}),
                      input_counts=(('text', 1), ('image', 2)), parameters=(('max_tokens', 42),))
    value = availability.decision(config, request)
    assert value['status'] == ('unavailable' if age == 0 else 'unknown')
    assert (availability.request_constraints(config, request) is not None) == (age == 0)
