"""Optional discovery uses real request contracts and never changes saved intent."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from types import SimpleNamespace
import asyncio
import json
import threading
import time

import httpx
import pytest

from opendirector.application.model_availability import ModelAvailability, generation_request, requests_for, tool_request
from opendirector.application.model_catalog import ModelCatalog
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector.integrations.capability_probe import CapabilityProbe


NOW = 1794225600.0


def document(operation='chat', profile='text_response', path='/v1/chat/completions', output='text', *, model='demo', support='supported'):
    return {'object': 'omni.capabilities', 'schema_version': 1,
            'observed_at': datetime.fromtimestamp(NOW, timezone.utc).isoformat(),
            'models': [{'id': model, 'stage_ids': ['0'], 'operations': {operation: {
                'support': support, 'exposure': 'enabled', 'reason_code': 'model_declared',
                'profiles': [{'id': profile, 'support': support, 'outputs': [output],
                              'required_inputs': ['text'], 'routes': [{'method': 'POST', 'path': path}]}],
                'execution': {'state': 'unpaused', 'scope': 'deployment',
                              'observed_at': datetime.fromtimestamp(NOW, timezone.utc).isoformat()}}}}],
            'routes': [{'transport': 'http', 'method': 'POST', 'path': path, 'exposure': 'enabled'}]}


@pytest.fixture
def service(tmp_path):
    configs = ModelConfigs(tmp_path)
    saved = configs.save('agent', 'http://models.test/v1', 'demo', '', connection_type='self_hosted', auth_mode='none')
    state = {'document': document(), 'status': 200, 'calls': [], 'clock': NOW}

    def respond(request):
        state['calls'].append(request)
        return httpx.Response(state['status'], json=state['document'])

    probe = CapabilityProbe(transport=httpx.MockTransport(respond), clock=lambda: state['clock'], wall_clock=lambda: state['clock'])
    availability = ModelAvailability(configs, probe)
    yield configs, saved, state, availability
    probe.close()


def private(configs, saved):
    return configs.resolve(saved['id'], saved['kind'])


def test_catalog_is_network_free_and_manual_refresh_runs_no_inference(service):
    configs, saved, state, availability = service
    catalog = ModelCatalog(configs, availability=availability)
    before = configs.path.read_bytes()
    assert catalog.list()[0]['availability']['status'] == 'unknown'
    assert state['calls'] == []
    observed = availability.refresh()['models'][0]
    assert observed['status'] == 'available'
    assert [(r.method, str(r.url)) for r in state['calls']] == [('GET', 'http://models.test/v1/omni/capabilities')]
    assert catalog.list()[0]['availability']['identity'] == observed['identity']
    assert configs.path.read_bytes() == before


@pytest.mark.parametrize('status,body', [(404, {}), (401, {}), (500, {}), (200, {'object': 'list'}),
    (200, {**document(), 'schema_version': 2}), (200, {**document(), 'models': document()['models'] * 2})])
def test_legacy_or_invalid_service_stays_unknown_and_preserves_manual_config(service, status, body):
    configs, saved, state, availability = service
    state.update(status=status, document=body)
    before = configs.path.read_bytes()
    availability.refresh()
    config = private(configs, saved)
    availability.require(config, requests_for(config)[0])
    assert availability.model(config)['status'] == 'unknown'
    assert configs.path.read_bytes() == before


@pytest.mark.parametrize('status,body,reason', [(401, {}, 'authentication_failed'), (403, {}, 'authentication_failed'),
    (404, {}, 'protocol_unavailable'), (200, {**document(), 'schema_version': 2}, 'unsupported_version'),
    (200, {**document(), 'models': 'invalid'}, 'invalid_response')])
def test_query_failures_keep_actionable_sanitized_reasons(service, status, body, reason):
    configs, saved, state, availability = service
    state.update(status=status, document=body)
    availability.refresh()
    value = availability.model(private(configs, saved))
    assert value['status'] == 'unknown' and value['reasonCode'] == reason


def test_connection_failure_is_distinct_from_invalid_document(service):
    configs, saved, _, availability = service
    def respond(request):
        raise httpx.ConnectError('secret response must not escape', request=request)
    availability.probe.transport = httpx.MockTransport(respond)
    availability.refresh()
    value = availability.model(private(configs, saved))
    assert value['reasonCode'] == 'connection_failed'
    assert 'secret response' not in str(value)


@pytest.mark.parametrize('mutation,reason', [
    (lambda op, doc: (op.update(support='unsupported'), op['profiles'][0].update(support='unsupported')), 'operation_unsupported'),
    (lambda op, doc: op.update(exposure='disabled'), 'operation_disabled'),
    (lambda op, doc: op['profiles'][0].update(support='unsupported'), 'profile_unsupported'),
    (lambda op, doc: op['profiles'][0].update(outputs=['image']), 'output_unsupported'),
    (lambda op, doc: doc['routes'][0].update(exposure='disabled'), 'route_disabled'),
])
def test_explicit_negative_evidence_rejects_exact_request(service, mutation, reason):
    configs, saved, state, availability = service
    mutation(state['document']['models'][0]['operations']['chat'], state['document'])
    availability.refresh()
    config = private(configs, saved)
    assert availability.model(config)['operations'][0]['reasonCode'] == reason
    with pytest.raises(ProjectError) as error:
        availability.require(config, requests_for(config)[0])
    assert error.value.code == 'capability_unavailable'


@pytest.mark.parametrize('mutation', [
    lambda doc: doc['models'][0].update(id='different-alias'),
    lambda doc: doc['models'][0]['operations']['chat']['profiles'][0].update(id='image_response'),
    lambda doc: doc['models'][0]['operations']['chat']['profiles'][0]['routes'][0].update(path='/v1/other'),
    lambda doc: doc['models'][0]['operations']['chat']['profiles'][0]['routes'][0].update(method='GET'),
])
def test_no_inference_from_a_different_model_profile_or_route(service, mutation):
    configs, saved, state, availability = service
    mutation(state['document'])
    availability.refresh()
    assert availability.model(private(configs, saved))['status'] == 'unknown'


def test_independent_pause_and_declaration_expiry_changes_projection_without_network(service):
    configs, saved, state, availability = service
    execution = state['document']['models'][0]['operations']['chat']['execution']
    execution['state'] = 'paused'
    availability.refresh()
    initial = availability.list()
    assert initial['models'][0]['reasonCode'] == 'execution_paused'
    state['clock'] += 5.01
    expired_pause = availability.list()
    assert expired_pause['models'][0]['status'] == 'available'
    assert expired_pause['revision'] != initial['revision']
    state['clock'] = NOW + 30.01
    assert availability.list()['models'][0]['status'] == 'unknown'
    assert len(state['calls']) == 1


@pytest.mark.parametrize('scope,observed', [('worker', NOW), ('deployment', NOW - 10), ('deployment', NOW + 100)])
def test_pause_scope_and_local_expiry_do_not_depend_on_remote_clock(service, scope, observed):
    configs, saved, state, availability = service
    state['document']['models'][0]['operations']['chat']['execution'].update(state='paused', scope=scope,
        observed_at=datetime.fromtimestamp(observed, timezone.utc).isoformat())
    availability.refresh()
    assert availability.list()['models'][0]['status'] == ('available' if scope == 'worker' else 'unavailable')
    state['clock'] += 5.01
    assert availability.list()['models'][0]['status'] == 'available'


@pytest.mark.parametrize('contradiction', ['operation_profile', 'duplicate_route', 'duplicate_profile_route'])
def test_contradictory_document_is_unknown(service, contradiction):
    configs, saved, state, availability = service
    doc = state['document']
    if contradiction == 'operation_profile':
        doc['models'][0]['operations']['chat']['support'] = 'unsupported'
    elif contradiction == 'duplicate_route':
        doc['routes'].append({**doc['routes'][0], 'exposure': 'disabled'})
    else:
        routes = doc['models'][0]['operations']['chat']['profiles'][0]['routes']
        routes.append({**routes[0], 'exposure': 'disabled'})
    availability.refresh()
    assert availability.model(private(configs, saved))['reasonCode'] == 'invalid_response'


def test_unknown_profile_outputs_do_not_create_negative_evidence(service):
    configs, saved, state, availability = service
    state['document']['models'][0]['operations']['chat']['profiles'][0].update(support='unknown', outputs=['image'])
    availability.refresh()
    assert availability.model(private(configs, saved))['status'] == 'unknown'


def test_wall_clock_change_does_not_extend_or_shorten_ttl(service):
    configs, saved, state, availability = service
    wall = [NOW]
    availability.probe.wall_clock = lambda: wall[0]
    availability.refresh()
    wall[0] += 10000
    assert availability.model(private(configs, saved))['status'] == 'available'
    wall[0] -= 20000
    state['clock'] += 31
    assert availability.model(private(configs, saved))['status'] == 'unknown'


def test_opt_out_is_persisted_and_manual_check_is_explicit(service):
    configs, saved, state, availability = service
    configs.save('agent', saved['url'], 'demo', '', saved['id'], connection_type='self_hosted', capability_auto_check=False)
    availability.refresh()
    assert state['calls'] == []
    with pytest.raises(ProjectError):
        availability.refresh(manual=True)
    availability.refresh([saved['id']], manual=True)
    assert availability.list()['models'][0]['status'] == 'available'
    assert len(state['calls']) == 1


def test_shared_service_preference_preserves_omitted_and_explicit_false(tmp_path):
    configs = ModelConfigs(tmp_path)
    models = configs.save_many('agent', 'http://models.test/v1', ['a', 'b'], '', connection_type='self_hosted')
    assert all('capabilityAutoCheck' not in item for item in models)
    configs.save('agent', models[0]['url'], 'a', '', models[0]['id'], connection_type='self_hosted', capability_auto_check=False)
    assert all(item['capabilityAutoCheck'] is False for item in ModelConfigs(tmp_path).list())
    configs.save_many('agent', models[0]['url'], ['a', 'b'], '', models[0]['id'], connection_type='self_hosted')
    assert all(item['capabilityAutoCheck'] is False for item in configs.list())
    stored = json.loads(configs.path.read_text())
    assert all('capabilityAutoCheck' not in item for item in stored['models'])
    assert next(iter(stored['services'].values()))['capabilityAutoCheck'] is False


def test_disabled_independent_connection_does_not_suppress_enabled_peer(service):
    configs, saved, state, availability = service
    configs.save('agent', saved['url'], 'demo', '', saved['id'], connection_type='self_hosted', capability_auto_check=False)
    configs.save('agent', saved['url'], 'demo', '', connection_type='self_hosted', capability_auto_check=True)
    availability.refresh()
    assert len(state['calls']) == 1


def test_independent_service_owners_do_not_share_cache_at_the_same_url(service):
    configs, saved, state, availability = service
    availability.refresh()
    other = configs.save('agent', saved['url'], 'demo', '', connection_type='self_hosted')
    assert availability.model(private(configs, other))['status'] == 'unknown'
    availability.refresh()
    assert len(state['calls']) == 2


def test_one_provider_with_multiple_models_shares_one_declaration_query(service):
    configs, saved, state, availability = service
    configs.delete(saved['id'])
    models = configs.save_many('agent', saved['url'], ['demo', 'other'], '', connection_type='self_hosted')
    assert models[0]['providerId'] == models[1]['providerId']
    availability.refresh()
    assert len(state['calls']) == 1
    assert availability.list()['models'][0]['status'] == 'available'


def test_distinct_providers_at_identical_urls_remain_isolated(service):
    configs, saved, state, availability = service
    configs.delete(saved['id'])
    first = configs.save_many('agent', saved['url'], ['demo'], '', connection_type='self_hosted')[0]
    second = configs.save_many('agent', saved['url'], ['demo'], '', connection_type='self_hosted')[0]
    assert first['providerId'] != second['providerId']
    availability.refresh([first['id']])
    assert availability.model(private(configs, second))['status'] == 'unknown'
    availability.refresh([second['id']])
    assert len(state['calls']) == 2


def test_draft_does_not_publish_saved_observation_or_credentials(service):
    configs, saved, state, availability = service
    catalog = ModelCatalog(configs, availability=availability)
    result = asyncio.run(catalog.check_availability('agent', saved['url'], 'demo', '', connection_type='self_hosted'))
    assert result['status'] == 'available' and result['configId'] is None
    assert availability.list()['models'][0]['status'] == 'unknown'
    assert 'apiKey' not in str(result)


def test_connection_changes_invalidate_identity_and_late_response(service):
    configs, saved, state, availability = service
    original = private(configs, saved)
    prepared = availability.prepare(original)
    changed = configs.save('agent', 'http://other.test/v1', 'demo', '', saved['id'], connection_type='self_hosted')
    with pytest.raises(ProjectError) as error:
        availability.require(private(configs, changed), requests_for(original)[0], prepared)
    assert error.value.code == 'capability_connection_changed'
    assert availability.list()['models'][0]['status'] == 'unknown'


def test_music_uses_lyrics_profile_on_speech_and_not_generic_audio_generation(service):
    configs, _, state, availability = service
    saved = configs.save('audio', 'http://music.test/v1', 'demo', '', connection_type='self_hosted', protocol='vllm_omni_music')
    state['document'] = document('speech', 'lyrics_to_music', '/v1/audio/speech', 'audio')
    state['document']['models'][0]['operations']['speech']['profiles'].append({'id': 'text_to_speech', 'support': 'unsupported'})
    state['document']['models'][0]['operations']['audio_generation'] = {'support': 'unsupported'}
    config = private(configs, saved)
    availability.prepare(config)
    assert availability.model(config)['status'] == 'available'
    request = requests_for(config)[0]
    assert (request.operation, request.profile, request.path) == ('speech', 'lyrics_to_music', '/v1/audio/speech')
    ordinary = {**config, 'protocol': 'openai'}
    with pytest.raises(ProjectError):
        availability.require(ordinary, requests_for(ordinary)[0])


def test_new_remote_profiles_are_accepted_without_creating_consumers(service):
    configs, saved, state, availability = service
    state['document']['models'][0]['operations']['speech'] = {
        'support': 'supported', 'profiles': [{'id': 'caption_to_audio', 'support': 'supported',
            'outputs': ['audio'], 'required_inputs': ['caption'], 'routes': [{'method': 'POST', 'path': '/v1/audio/speech'}]}]}
    availability.refresh()
    value = availability.model(private(configs, saved))
    assert value['status'] == 'available'
    assert [item['profile'] for item in value['operations']] == ['text_response']


def test_agent_connection_test_rejects_known_non_text_model_without_inference(service):
    from test_model_catalog import Scripted
    configs, saved, state, availability = service
    state['document']['models'][0]['operations']['chat']['profiles'][0]['support'] = 'unsupported'
    tester = Scripted([{'type': 'delta', 'text': 'should not run'}])
    catalog = ModelCatalog(configs, tester, availability)
    with pytest.raises(ProjectError) as error:
        asyncio.run(catalog.test_agent(saved['url'], 'demo', '', connection_type='self_hosted'))
    assert error.value.code == 'capability_unavailable' and tester.calls == []


def test_parallel_callers_share_one_query_and_deadline(tmp_path):
    started, finish = threading.Event(), threading.Event()
    calls = []
    def respond(request):
        calls.append(request)
        started.set()
        finish.wait(2)
        return httpx.Response(200, json=document())
    probe = CapabilityProbe(transport=httpx.MockTransport(respond), timeout=.15)
    config = {'url': 'http://models.test/v1', 'connectionType': 'self_hosted'}
    try:
        with ThreadPoolExecutor(max_workers=6) as pool:
            started_at = time.monotonic()
            futures = [pool.submit(probe.query, config) for _ in range(6)]
            assert started.wait(1)
            results = [future.result(timeout=1) for future in futures]
            assert time.monotonic() - started_at < 1
            assert all(value.reason == 'query_timeout' for value in results)
            assert len(calls) == 1
    finally:
        finish.set()
        probe.close()


def test_cache_is_bounded_and_does_not_persist(tmp_path):
    probe = CapabilityProbe(transport=httpx.MockTransport(lambda _: httpx.Response(404)), capacity=3)
    try:
        for index in range(7):
            probe.query({'url': f'http://service-{index}.test/v1', 'connectionType': 'self_hosted'})
        assert len(probe._cache) == 3
        assert list(tmp_path.iterdir()) == []
    finally:
        probe.close()


@pytest.mark.parametrize('references,expected', [
    ([('image', 'attachment')], 'unavailable'),
    ([('image', 'attachment'), ('audio', 'attachment')], 'available'),
    ([('image', 'attachment'), ('audio', 'context_only')], 'unavailable'),
])
def test_video_required_audio_is_checked_on_actual_request_not_catalog(service, references, expected):
    configs, _, state, availability = service
    config = {**configs.resolve(configs.list()[0]['id'], 'agent'), 'kind': 'video', 'protocol': 'vllm_omni'}
    state['document'] = document('video_generation', 'image_to_video', '/v1/videos', 'video')
    profile = state['document']['models'][0]['operations']['video_generation']['profiles'][0]
    profile.update(required_inputs=['text', 'image', 'audio'], outputs=['video', 'audio'])
    availability.prepare(config)
    catalog_request = next(item for item in requests_for(config) if item.profile == 'image_to_video')
    assert availability.decision(config, catalog_request)['status'] == 'available'
    refs = [SimpleNamespace(asset=SimpleNamespace(kind=kind), transmission=transmission) for kind, transmission in references]
    actual = generation_request(config, SimpleNamespace(kind='video'), refs)
    assert actual.profile == 'image_to_video'
    value = availability.decision(config, actual)
    assert value['status'] == expected
    if expected == 'unavailable':
        assert value['reasonCode'] == 'required_inputs_missing'
        with pytest.raises(ProjectError):
            availability.require(config, actual)
    else:
        availability.require(config, actual)


def test_unrecognized_required_input_stays_unknown(service):
    configs, saved, state, availability = service
    state['document']['models'][0]['operations']['chat']['profiles'][0]['required_inputs'] = ['text', 'future_input']
    config = private(configs, saved)
    availability.prepare(config)
    request = requests_for(config, inputs={'text'})[0]
    value = availability.decision(config, request)
    assert value['status'] == 'unknown' and value['reasonCode'] == 'input_contract_unknown'
    availability.require(config, request)


def test_generation_profiles_and_tool_inputs_follow_the_actual_adapter(service):
    configs, saved, _, _ = service
    base = private(configs, saved)
    def ref(kind):
        return SimpleNamespace(asset=SimpleNamespace(kind=kind), transmission='attachment')
    for kind, protocol, refs, profile, inputs in [
        ('image', 'openai', [], 'text_to_image', {'text'}),
        ('image', 'openai', [ref('image')], 'image_to_image', {'text', 'image'}),
        ('video', 'vllm_omni', [ref('video')], 'video_to_video', {'text', 'video'}),
        ('audio', 'vllm_omni_music', [], 'lyrics_to_music', {'text', 'instructions'}),
        ('audio', 'vllm_omni_music', [ref('audio')], 'lyrics_to_music', {'text', 'instructions'}),
    ]:
        spec = SimpleNamespace(kind=kind, parameters=SimpleNamespace(creationType='music'))
        request = generation_request({**base, 'kind': kind, 'protocol': protocol}, spec, refs)
        assert request.profile == profile and request.inputs == inputs
    video = {**base, 'kind': 'video', 'protocol': 'vllm_omni'}
    assert tool_request(video, 'video.first_frame').inputs is None
    assert tool_request(video, 'video.first_frame', actual=True).inputs == {'text', 'image'}


def test_refresh_two_slow_services_uses_one_total_wait_budget(tmp_path):
    configs = ModelConfigs(tmp_path)
    for name in ['one', 'two']:
        configs.save('agent', f'http://{name}.test/v1', 'demo', '', connection_type='self_hosted')
    finish, both_started = threading.Event(), threading.Event()
    calls, lock = [], threading.Lock()
    def respond(request):
        with lock:
            calls.append(request)
            if len(calls) == 2:
                both_started.set()
        finish.wait(2)
        return httpx.Response(200, json=document())
    probe = CapabilityProbe(transport=httpx.MockTransport(respond), timeout=.4)
    try:
        started = time.monotonic()
        result = ModelAvailability(configs, probe).refresh()
        assert time.monotonic() - started < .65
        assert both_started.is_set() and len(calls) == 2
        assert all(value['reasonCode'] == 'query_timeout' for value in result['models'])
    finally:
        finish.set()
        probe.close()


def test_batch_refresh_keeps_worker_and_queue_limits(tmp_path):
    finish = threading.Event()
    calls, lock = [], threading.Lock()
    def respond(request):
        with lock:
            calls.append(request)
        finish.wait(2)
        return httpx.Response(404)
    probe = CapabilityProbe(transport=httpx.MockTransport(respond), timeout=.2, capacity=5)
    configs = [{'id': str(i), 'url': f'http://service-{i}.test/v1', 'connectionType': 'self_hosted'} for i in range(9)]
    try:
        result = probe.query_many(configs)
        assert len(calls) == 4 and len(probe._pending) == 5
        assert [value.reason for value in result] == ['query_timeout'] * 5 + ['query_busy'] * 4
        assert len(probe._cache) <= 5
    finally:
        finish.set()
        probe.close()
