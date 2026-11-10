"""Admission follows provider comparison rules and actual media transmission."""
from copy import deepcopy
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from opendirector.application.model_availability import generation_request
from opendirector.domain.omni_capabilities import ParameterConstraint, RequestConstraints
from opendirector.domain.request_constraints import constraint_failure, input_details
from test_model_availability import document, private, service


@pytest.mark.parametrize('rule,options,value', [
    ('title', ['English'], 'english'), ('title', ['english'], 'ENGLISH'),
    ('lower', ['af_heart'], 'AF_HEART'), ('lower', ['default'], 'DEFAULT'),
    ('strip_lower', ['default', ''], ' DEFAULT '), ('strip_lower', ['default', ''], '  '),
])
def test_enum_comparison_preserves_the_actual_parameter(rule, options, value):
    contract = RequestConstraints.model_validate({'parameters': {'voice': {
        'type': 'string', 'enum': options, 'enum_normalization': rule}}})
    parameters = {'voice': value}
    assert constraint_failure(contract, None, parameters) is None
    assert parameters == {'voice': value}
    assert contract.parameters['voice'].enum == options
    assert constraint_failure(contract, None, {'voice': 'missing'}) == (
        'parameter_value_unsupported', {'parameter': 'voice'})


@pytest.mark.parametrize('rule,value', [(None, 'AF_HEART'), ('lower', ' af_heart ')])
def test_enum_comparison_does_not_add_undeclared_normalization(rule, value):
    contract = RequestConstraints.model_validate({'parameters': {'voice': {
        'type': 'string', 'enum': ['af_heart'], 'enum_normalization': rule}}})
    assert constraint_failure(contract, None, {'voice': value}) is not None


def test_empty_voice_placeholder_is_accepted_without_becoming_a_displayed_voice():
    contract = RequestConstraints.model_validate({'parameters': {'voice': {
        'type': 'string', 'enum': ['default', ''], 'enum_normalization': 'strip_lower'}}})
    assert constraint_failure(contract, None, {'voice': ' '}) is None
    assert input_details(contract)[0]['values'] == ['default']


@pytest.mark.parametrize('constraint', [
    {'type': 'string', 'enum': ['default'], 'enum_normalization': 'future'},
    {'type': 'string', 'enum_normalization': 'lower'},
    {'type': 'integer', 'enum': [1], 'enum_normalization': 'lower'},
    {'type': 'string', 'enum': ['default', 1], 'enum_normalization': 'lower'},
])
def test_invalid_enum_normalization_is_not_treated_as_exact(constraint):
    with pytest.raises(ValidationError):
        ParameterConstraint.model_validate(constraint)


def test_unknown_normalization_keeps_optional_discovery_unknown(service):
    configs, saved, state, availability = service
    state['document']['models'][0]['operations']['chat']['profiles'][0]['routes'][0]['request'] = {
        'parameters': {'language': {'type': 'string', 'enum': ['English'], 'enum_normalization': 'future'}}}
    config = private(configs, saved)
    availability.prepare(config)
    result = availability.model(config)
    assert result['status'] == 'unknown' and result['reasonCode'] == 'invalid_response'


@pytest.mark.parametrize('voice,rule,options', [
    ('AF_HEART', 'lower', ['af_heart']), (' DEFAULT ', 'strip_lower', ['default', '']),
    ('  ', 'strip_lower', ['default', '']), (None, 'strip_lower', ['default', '']),
])
def test_speech_admission_uses_normalization_without_rewriting_voice(service, voice, rule, options):
    configs, _, state, availability = service
    saved = configs.save('audio', 'http://speech.test/v1', 'demo', '', connection_type='self_hosted')
    config = private(configs, saved)
    state['document'] = document('speech', 'text_to_speech', '/v1/audio/speech', 'audio')
    state['document']['models'][0]['operations']['speech']['profiles'][0]['routes'][0]['request'] = {
        'parameters': {'voice': {'type': 'string', 'enum': options, 'enum_normalization': rule}}}
    availability.prepare(config)
    spec = SimpleNamespace(kind='audio', parameters=SimpleNamespace(voice=voice, creationType='audio'))
    request = generation_request(config, spec, [], parameters={'voice': voice})
    assert availability.decision(config, request)['status'] == 'available'
    assert dict(request.parameters)['voice'] == (voice if voice is not None else 'default')
    assert spec.parameters.voice == voice


def reference(kind, transmission):
    return SimpleNamespace(asset=SimpleNamespace(kind=kind), transmission=transmission)


@pytest.mark.parametrize('kind', ['audio', 'video'])
def test_text_metadata_does_not_satisfy_required_media_input(service, kind):
    configs, saved, state, availability = service
    config = private(configs, saved)
    state['document']['models'][0]['operations']['chat']['profiles'][0]['required_inputs'] = ['text', kind]
    availability.prepare(config)
    request = generation_request(config, SimpleNamespace(kind='text'), [reference(kind, 'metadata')])
    assert dict(request.input_counts) == {'text': 1}
    assert availability.decision(config, request)['reasonCode'] == 'required_inputs_missing'


def test_content_image_counts_survive_metadata_and_context_filtering(service):
    configs, saved, _, _ = service
    request = generation_request(private(configs, saved), SimpleNamespace(kind='text'), [
        reference('image', 'content'), reference('audio', 'metadata'),
        reference('video', 'metadata'), reference('image', 'context_only')])
    assert request.inputs == {'text', 'image'}
    assert dict(request.input_counts) == {'text': 1, 'image': 1}


@pytest.mark.parametrize('paused', [False, True])
def test_continuation_does_not_claim_video_upload_but_honors_route_pause(service, paused):
    configs, saved, state, availability = service
    config = {**private(configs, saved), 'kind': 'video', 'protocol': 'vllm_omni'}
    state['document'] = document('video_generation', 'text_to_video', '/v1/videos', 'video')
    operation = state['document']['models'][0]['operations']['video_generation']
    upload = deepcopy(operation['profiles'][0])
    upload.update(id='video_to_video', support='unsupported')
    operation['profiles'].append(upload)
    operation['execution']['state'] = 'paused' if paused else 'unpaused'
    availability.prepare(config)
    request = generation_request(config, SimpleNamespace(kind='video'), [
        reference('video', 'latent'), reference('image', 'content')])
    assert dict(request.input_counts) == {'text': 1, 'image': 1}
    result = availability.decision(config, request)
    assert result['declaration']['status'] == 'unknown'
    assert result['declaration']['reasonCode'] == 'profile_not_declared'
    assert result['reasonCode'] == ('execution_paused' if paused else 'profile_not_declared')
    assert result['status'] == ('unavailable' if paused else 'unknown')
    state['clock'] += 6
    assert availability.decision(config, request)['status'] == 'unknown'
