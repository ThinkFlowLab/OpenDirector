"""Impact reports follow saved business bindings, never display or historical guesses."""
from uuid import UUID

import pytest
from pydantic import TypeAdapter, ValidationError

from opendirector.application.creation_canvas import current_generation_inputs
from opendirector.application.creation_impact import build_generation_dependencies
from opendirector.domain.creation.commands import Query
from opendirector.domain.creation.generation import InputSnapshot, Job, ResultVersion
from opendirector.domain.creation.models import ModelSnapshot
from opendirector.domain.creation.project import ProjectSnapshot
from test_creation_contracts import asset, asset_ref, entity, model, PROJECT, uid

pytestmark = pytest.mark.cpu


def impact_model():
    public = model()
    return ModelSnapshot(modelConfigId=public.id, inputRules=public.inputRules,
        **{key: getattr(public, key) for key in
           ('kind', 'modelId', 'url', 'protocol', 'connectionType', 'proxyMode', 'videoAdapter')})


def graph(count=4, links=((0, 1), (1, 2))):
    """Four adopted image specs: A -> B -> C, with independent D."""
    data = dict(project=dict(id=PROJECT, name='Impact'), generationSpecs=[
        entity(100+i, kind='image', purpose='generation', modelConfigId=uid(20), prompt=f'Shot {i}')
        for i in range(count)], canvasItems=[
        entity(200+i, kind='image', binding=dict(role='generation', objectRef=dict(id=uid(100+i))))
        for i in range(count)], assets=[], jobs=[], results=[], references=[])
    for i in range(count):
        source = next((source for source, target in links if target == i), None)
        if source is not None:
            data['references'].append(entity(600+i, binding='follow_current',
                targetSpecId=uid(100+i), source=dict(id=uid(200+source))))
        state = ProjectSnapshot.model_validate(data)
        spec, refs = current_generation_inputs(state, state.generationSpecs[i], impact_model().inputRules)
        frozen = InputSnapshot(spec=spec, model=impact_model(), references=refs)
        output = asset(300+i, 'image')
        job = Job(**entity(400+i, inputSnapshot=frozen, inputFingerprint=frozen.fingerprint(),
            execution=dict(kind='image', size='2K'), status='succeeded', recovery='done',
            phase='complete', asset=asset_ref(output)))
        result = ResultVersion(**entity(500+i, specId=spec.id, jobId=job.id,
            asset=job.asset, inputFingerprint=job.inputFingerprint))
        data['assets'].append(output)
        data['jobs'].append(job)
        data['results'].append(result)
        data['generationSpecs'][i]['currentResultId'] = result.id
    return ProjectSnapshot.model_validate(data)


def resolved(state):
    return {s.id: current_generation_inputs(state, s, impact_model().inputRules)[1]
            for s in state.generationSpecs}


def replace(state, collection, index, **updates):
    data = state.model_dump()
    data[collection] = list(data[collection])
    data[collection][index].update(updates)
    return ProjectSnapshot.model_validate(data)


def test_dependency_edges_use_active_business_bindings():
    state = graph()
    edges = build_generation_dependencies(state, resolved(state))
    assert [(e.sourceSpecId, e.targetSpecId, e.referenceId, e.inputConfirmed) for e in edges] == [
        (uid(100), uid(101), uid(601), True), (uid(101), uid(102), uid(602), True)]
    moved = replace(state, 'canvasItems', 3, position=dict(x=-999, y=-999))
    assert build_generation_dependencies(moved, resolved(moved)) == edges
    inactive = replace(state, 'references', 1, active=False)
    assert len(build_generation_dependencies(inactive, resolved(inactive))) == 1


def test_structure_control_reference_is_reported_as_an_effective_input():
    from test_fasth3_inputs import control_model
    public = control_model()
    current_model = ModelSnapshot(modelConfigId=public.id, inputRules=public.inputRules,
        **{key: getattr(public, key) for key in
           ('kind', 'modelId', 'url', 'protocol', 'connectionType', 'proxyMode', 'videoAdapter')})
    source = asset(300, 'video')
    state = ProjectSnapshot(project=dict(id=PROJECT, name='Control'), assets=[source],
        generationSpecs=[entity(100, kind='video', purpose='generation', modelConfigId=public.id,
            parameters=dict(videoMode='control'))],
        canvasItems=[entity(200, kind='video', binding=dict(role='material', objectRef=asset_ref(source)))],
        references=[entity(600, binding='follow_current', targetSpecId=uid(100),
            source=dict(id=uid(200)), role='control')])
    value = report(state, roots=(uid(100),), models={public.id: current_model})
    edge, = value.dependencies
    assert (edge.role, edge.sourceItemId, edge.assetId, edge.inputConfirmed) == ('control', uid(200), source.id, True)
    assert edge.sourceSpecId is None
    assert value.items[0].reuseState == 'no_result'


def test_pinned_hidden_override_and_subject_bindings():
    state = graph()
    hidden = replace(state, 'canvasItems', 1, visible=False)
    assert build_generation_dependencies(hidden, resolved(hidden)) == build_generation_dependencies(state, resolved(state))
    pinned = replace(state, 'references', 1, binding='pinned', source=asset_ref(state.assets[1]).model_dump(),
        sourceVersion=dict(objectType='canvas_item', id=uid(201), revision=1))
    assert [e.targetSpecId for e in build_generation_dependencies(pinned, resolved(pinned))] == [uid(101)]
    # An explicit override wins even when it is the same bytes as a generated result.
    data = state.model_dump()
    override = asset(310, 'image').model_copy(update={'provenance': state.assets[0].provenance.model_copy(update={'source': 'imported'})})
    data['assets'] = [*state.assets, override]
    data['canvasItems'][1]['binding']['materialOverride'] = asset_ref(override).model_dump()
    overridden = ProjectSnapshot.model_validate(data)
    edge = build_generation_dependencies(overridden, resolved(overridden))[1]
    assert edge.sourceSpecId is None and edge.assetId == override.id
    data = state.model_dump()
    data['editorDocuments'] = [entity(700, kind='subject', data=dict(main=asset_ref(state.assets[0]),
        auxiliaries=[asset_ref(state.assets[3])]))]
    data['canvasItems'] = [*state.canvasItems, entity(701, kind='subject',
        binding=dict(role='editor', objectRef=dict(id=uid(700), kind='subject')))]
    data['references'][1]['source']['id'] = uid(701)
    subject = ProjectSnapshot.model_validate(data)
    edges = [e for e in build_generation_dependencies(subject, resolved(subject)) if e.targetSpecId == uid(102)]
    assert {(e.assetId, e.sourceItemId, e.sourceSpecId) for e in edges} == {
        (uid(300), uid(701), None), (uid(303), uid(701), None)}


def test_historical_usage_does_not_create_live_dependencies():
    state = replace(graph(), 'references', 1, source=dict(id=uid(203)))
    assert state.jobs[2].inputSnapshot.references[0].sourceVersion.id == uid(201)
    edges = build_generation_dependencies(state, resolved(state))
    assert edges[1].sourceSpecId == uid(103)
    inputs = resolved(state)
    inputs[uid(102)] = None
    uncertain = build_generation_dependencies(state, inputs)[1]
    assert uncertain.sourceSpecId == uid(103) and not uncertain.inputConfirmed
    assert uncertain.assetId is None


def query(**fields):
    return TypeAdapter(Query).validate_python(dict(type='generation.impact', queryId=uid(900),
        projectId=PROJECT, rootSpecIds=[uid(101)], **fields))


def test_impact_query_is_registered_without_changing_ordinary_queries():
    parsed = query()
    assert parsed.rootSpecIds == (uid(101),) and parsed.maxNodes == 2000
    ordinary = TypeAdapter(Query).validate_python(dict(type='project.get', queryId=uid(900), projectId=PROJECT))
    assert ordinary.type == 'project.get'


def test_dependency_budget_rejects_partial_reports():
    from opendirector.domain.creation.validation import ContractError
    state = graph()
    # Construct a trusted in-memory stress fixture without a huge persisted document.
    state = state.model_copy(update={'references': tuple(
        state.references[0].model_copy(update={'id': uid(10000+i), 'order': i}) for i in range(20001))})
    with pytest.raises(ContractError) as error:
        build_generation_dependencies(state, {uid(101): None})
    assert error.value.issue.code == 'impact_scope_exceeded'


def test_report_rejects_unknown_states_and_reason_codes():
    from opendirector.domain.creation.impact import GenerationImpactItem, ImpactReason
    with pytest.raises(ValidationError):
        GenerationImpactItem(specId=uid(100), specRevision=1, inputState='equal',
            reuseState='auto_retry', relation='root')
    with pytest.raises(ValidationError):
        ImpactReason(code='auto_submit')


@pytest.mark.parametrize('updates', [
    {'rootSpecIds': []}, {'rootSpecIds': [uid(101), uid(101)]}, {'rootSpecIds': ['invalid']},
    {'rootSpecIds': [UUID(int=i+1000) for i in range(101)]},
    {'maxNodes': 0}, {'maxNodes': 10001}, {'maxNodes': True}, {'maxNodes': '5'}, {'unexpected': True},
])
def test_impact_query_rejects_unbounded_or_ambiguous_inputs(updates):
    data = dict(type='generation.impact', queryId=uid(900), projectId=PROJECT, rootSpecIds=[uid(101)])
    with pytest.raises(ValidationError):
        TypeAdapter(Query).validate_python(data | updates)


def report(state=None, *, models=None, missing=(), available=None, roots=(uid(101),), max_nodes=2000):
    from opendirector.application.creation_impact import analyze_generation_impact
    return analyze_generation_impact(state or graph(), root_spec_ids=roots,
        models={uid(20): impact_model()} if models is None else models,
        asset_available=available or (lambda key: key not in missing), max_nodes=max_nodes)


def by_spec(value):
    return {item.specId: item for item in value.items}


def new_result(state, index, *, adopt=True, number=1000):
    """Build an accepted result from real inputs, independently of the analyzer."""
    from opendirector.domain.creation.generation import execution_spec
    spec, refs = current_generation_inputs(state, state.generationSpecs[index], impact_model().inputRules)
    frozen = InputSnapshot(spec=execution_spec(spec, refs, impact_model().inputRules).model_copy(
        update={'currentResultId': None}), model=impact_model(), references=refs)
    output = asset(number, 'image')
    job = Job(**entity(number+1, inputSnapshot=frozen, inputFingerprint=frozen.fingerprint(),
        execution=dict(kind='image', size='2K'), status='succeeded', recovery='done', phase='complete',
        asset=asset_ref(output)))
    result = ResultVersion(**entity(number+2, specId=spec.id, jobId=job.id,
        asset=job.asset, inputFingerprint=job.inputFingerprint))
    data = state.model_dump()
    data.update(assets=[*state.assets, output], jobs=[*state.jobs, job], results=[*state.results, result])
    if adopt:
        data['generationSpecs'][index]['currentResultId'] = result.id
    return ProjectSnapshot.model_validate(data)


def test_unchanged_adopted_results_are_reusable():
    calls = []
    value = report(available=lambda key: calls.append(key) or True)
    assert [item.reuseState for item in value.items] == ['reusable'] * 4
    assert [item.relation for item in value.items] == ['independent', 'root', 'downstream', 'independent']
    assert all(item.inputState == 'equal' and item.baselineInputFingerprint == item.currentInputFingerprint for item in value.items)
    assert [item.baselineJobId for item in value.items] == [uid(400+i) for i in range(4)]
    assert sorted(calls) == [uid(300+i) for i in range(4)]  # shared inputs checked once


def test_pending_upstream_is_not_current_input_mismatch():
    state = replace(graph(), 'generationSpecs', 1, prompt='Changed B', revision=2)
    items = report(state).items
    assert [(i.inputState, i.reuseState) for i in items] == [
        ('equal', 'reusable'), ('changed', 'stale'), ('equal', 'pending_upstream'), ('equal', 'reusable')]
    assert items[1].reasons[0].fieldPaths == ('spec.prompt',)
    assert any(r.code == 'upstream_pending' and r.objectId == uid(101) and r.referenceId == uid(602) for r in items[2].reasons)


def test_adoption_changes_direct_consumer_inputs():
    state = graph(5, ((0, 1), (1, 2), (2, 4)))
    state = new_result(replace(state, 'generationSpecs', 1, prompt='B2', revision=2), 1)
    items = report(state).items
    assert [(i.inputState, i.reuseState) for i in items] == [
        ('equal', 'reusable'), ('equal', 'reusable'), ('changed', 'stale'),
        ('equal', 'reusable'), ('equal', 'pending_upstream')]


def test_candidate_and_pinned_reference_do_not_invalidate():
    state = graph()
    candidate = new_result(state, 1, adopt=False)
    assert all(i.reuseState == 'reusable' for i in report(candidate).items)
    pinned = replace(state, 'references', 1, binding='pinned', source=asset_ref(state.assets[1]).model_dump(),
        sourceVersion=dict(objectType='canvas_item', id=uid(201), revision=1))
    pinned = new_result(pinned, 2)  # Adopt C generated from a fixed reference.
    adopted = new_result(pinned, 1, number=1100)
    item = report(adopted).items[2]
    assert (item.inputState, item.reuseState, item.relation) == ('equal', 'reusable', 'independent')


def test_display_changes_do_not_change_effective_inputs():
    state = replace(graph(), 'canvasItems', 1, position=dict(x=99, y=20), visible=False, revision=2)
    state = replace(state, 'assets', 1, name='A renamed file', revision=2)
    assert all(i.inputState == 'equal' and i.reuseState == 'reusable' for i in report(state).items)


@pytest.mark.parametrize('change,path', [
    ('model', 'model'), ('rules', 'model'), ('connection', 'model'), ('parameters', 'spec.parameters'),
    ('identity', 'references'), ('source_identity', 'references'), ('order', 'references'), ('role', 'references'),
])
def test_model_parameters_order_and_identity_changes_are_detected(change, path):
    state = graph()
    models = {uid(20): impact_model()}
    if change == 'model':
        models[uid(20)] = models[uid(20)].model_copy(update={'modelId': 'another-model'})
    elif change == 'rules':
        models[uid(20)] = models[uid(20)].model_copy(update={'inputRules': models[uid(20)].inputRules.model_copy(update={'maxImages': 1})})
    elif change == 'connection':
        models[uid(20)] = models[uid(20)].model_copy(update={'url': 'https://other.example/v1'})
    elif change == 'parameters':
        state = replace(state, 'generationSpecs', 1, parameters=dict(size='1024x1024'))
    elif change == 'identity':
        data = state.model_dump()
        twin = state.assets[0].model_copy(update={'id': uid(999), 'path': f'assets/{uid(999)}'})
        data['assets'] = [*state.assets, twin]
        data['canvasItems'][0]['binding'] = dict(role='material', objectRef=asset_ref(twin))
        state = ProjectSnapshot.model_validate(data)
    elif change == 'source_identity':
        data = state.model_dump()
        data['canvasItems'] = [*state.canvasItems, entity(999, kind='image', binding=dict(role='material', objectRef=asset_ref(state.assets[0])))]
        data['references'][0]['source']['id'] = uid(999)
        state = ProjectSnapshot.model_validate(data)
    elif change == 'role':
        state = replace(state, 'references', 0, role='first_frame')
    else:
        data = state.model_dump()
        data['references'] = [*state.references, entity(699, binding='follow_current', targetSpecId=uid(101), source=dict(id=uid(203)), order=1)]
        state = new_result(ProjectSnapshot.model_validate(data), 1)
        data = state.model_dump()
        data['references'][0]['order'], data['references'][2]['order'] = 1, 0
        state = ProjectSnapshot.model_validate(data)
    item = report(state, models=models).items[1]
    assert item.inputState == 'changed' and item.reuseState == 'stale'
    assert path in next(r.fieldPaths for r in item.reasons if r.code == 'inputs_changed')


def test_missing_output_and_unrecorded_inputs_are_not_reusable():
    state = graph()
    missing = report(state, missing=(uid(303),)).items[3]
    assert missing.reuseState == 'unavailable' and missing.reasons[0].code == 'output_unavailable'
    unresolved = report(state, models={}).items[1]
    assert (unresolved.inputState, unresolved.reuseState) == ('unresolved', 'unknown')
    assert unresolved.reasons[0].code == 'model_unresolved'
    incomplete = replace(state, 'jobs', 1, adapterParameters={'guide_frames': [0, 8], 'adapter': 'external'})
    assert report(incomplete).items[1].reuseState == 'unknown'
    assert 'execution_basis_incomplete' in [r.code for r in report(incomplete).items[1].reasons]
    # Defensive analyzer checks also reject inconsistent in-memory adopted links.
    broken = state.model_copy(update={'results': tuple(r for r in state.results if r.id != uid(501))})
    assert report(broken).items[1].reuseState == 'unknown'
    missing_input = report(state, missing=(uid(300),)).items[1]
    assert missing_input.reuseState == 'unknown' and missing_input.inputState == 'unresolved'
    assert 'input_unresolved' in [r.code for r in missing_input.reasons]
    empty = replace(state, 'generationSpecs', 1, currentResultId=None)
    assert report(empty).items[1].reuseState == 'no_result'


def test_active_and_unknown_jobs_do_not_create_retry_actions():
    state = graph()
    active = state.jobs[1].model_copy(update={'id': uid(901), 'status': 'running', 'phase': 'poll',
        'recovery': 'remote', 'externalTaskId': 'original-task', 'asset': None, 'resumeAllowed': True})
    unknown = active.model_copy(update={'id': uid(902), 'status': 'interrupted', 'recovery': 'review',
        'resumeAllowed': False, 'externalTaskId': None})
    state = state.model_copy(update={'jobs': (*state.jobs, active, unknown)})
    before = state.model_dump_json()
    item = report(state).items[1]
    assert item.reuseState == 'reusable' and item.activeJobIds == (uid(901), uid(902))
    assert state.model_dump_json() == before
    assert not {'action', 'submit', 'resume', 'retry'} & set(item.model_dump())


@pytest.mark.parametrize('source_role', ['generation', 'material'])
def test_timeline_consumers_are_reported_without_mutation(source_role):
    state = graph()
    resources = [dict(asset=asset_ref(state.assets[i]), title=f'Clip {i}') for i in (1, 2, 3)]
    data = state.model_dump()
    source_id = uid(201)
    if source_role == 'material':
        source_id = uid(810)
        data['canvasItems'] = [*state.canvasItems, entity(810, kind='image',
            binding=dict(role='material', objectRef=asset_ref(state.assets[1])))]
    data['editorDocuments'] = [entity(800, kind='timeline', revision=3,
        inputConnections=[dict(id=uid(801), sourceId=source_id, slotId='b', asset=asset_ref(state.assets[1]))],
        data=dict(fps=24, width=128, height=128, tracks=[dict(id='v', kind='visual', title='Shots', clips=[
            dict(id=key, resource=res, inPoint=0, outPoint=1) for key, res in zip(('b', 'c', 'd'), resources)])]))]
    state = new_result(ProjectSnapshot.model_validate(data), 1)  # timeline retains B1
    before = state.model_dump_json()
    value = report(state)
    association = 'asset_and_source' if source_role == 'generation' else 'asset'
    assert [(c.clipId, c.association, c.assetId, c.specIds, c.revision, c.sourceItemId)
            for c in value.timelineConsumers] == [
        ('b', association, uid(301), (uid(101),), 3, source_id),
        ('c', 'asset', uid(302), (uid(102),), 3, None)]
    # Retained material provenance does not introduce another generation edge.
    assert [(e.sourceSpecId, e.targetSpecId) for e in value.dependencies] == [
        (uid(100), uid(101)), (uid(101), uid(102))]
    assert state.model_dump_json() == before


def test_timeline_candidate_usage_preserves_the_adopted_reuse_baseline():
    state = new_result(graph(), 1, adopt=False)
    data = state.model_dump()
    data['editorDocuments'] = [entity(800, kind='timeline', data=dict(
        fps=24, width=128, height=128, tracks=[dict(id='v', kind='visual', title='Shots', clips=[dict(
            id='candidate', resource=dict(asset=asset_ref(state.assets[-1]), title='Candidate'),
            inPoint=0, outPoint=1)])]))]
    state = ProjectSnapshot.model_validate(data)
    before = state.model_dump_json()
    value = report(state)
    consumer, = value.timelineConsumers
    assert (consumer.assetId, consumer.specIds, consumer.association) == (uid(1000), (uid(101),), 'asset')
    assert (value.items[1].currentResultId, value.items[1].baselineJobId) == (uid(501), uid(401))
    assert all(item.reuseState == 'reusable' for item in value.items)
    assert state.model_dump_json() == before


def test_snapshot_normalization_matches_generation_acceptance(tmp_path):
    from generation_helpers import new_project, command
    from test_creation_generation_service import Provider
    from opendirector.application.creation_generation import CreationGeneration
    from opendirector.domain.creation.generation import freeze_input_snapshot
    from opendirector.infrastructure.model_configs import ModelConfigs
    project = new_project(tmp_path)
    configs = ModelConfigs(tmp_path)
    config = configs.save('video', 'http://127.0.0.1:12345/v1', 'standard-video-fixture', '',
        connection_type='self_hosted', protocol='vllm_omni', auth_mode='none', video_adapter='standard',
        video_capabilities={'outputs': [{'resolution': '480P', 'width': 832, 'height': 480, 'durations': [5]}],
            'defaultResolution': '480P', 'defaultDuration': 5, 'dimensionStep': 2})
    runner = CreationGeneration(project[0], configs, Provider())
    request = command(project, config, parameters={'videoMode': 'reference', 'resolution': '480P'})
    receipt = runner.prepare(request, session=project[2])
    assert receipt.status == 'accepted'
    state = project[0].snapshot(project[1])
    spec, job = state.generationSpecs[-1], state.jobs[-1]
    current, refs = current_generation_inputs(state, spec, job.inputSnapshot.model.inputRules)
    frozen = freeze_input_snapshot(current, job.inputSnapshot.model, refs)
    assert frozen == job.inputSnapshot and frozen.fingerprint() == job.inputFingerprint
    assert spec.parameters.videoMode == 'reference' and frozen.spec.parameters.videoMode == 'first_frame'


def test_inputs_over_acceptance_limit_are_unresolved_before_fingerprinting():
    state = graph()
    data = state.model_dump()
    data['references'] = [entity(10000+i, binding='follow_current', targetSpecId=uid(101),
        source=dict(id=uid(200)), order=i) for i in range(65)]
    item = report(ProjectSnapshot.model_validate(data)).items[1]
    assert (item.inputState, item.reuseState) == ('unresolved', 'unknown')


@pytest.mark.parametrize('parameters', [
    {'seconds': '5', 'duration': 5, 'num_frames': 124, 'fps': 24, 'seed': 123},
    {'duration': 5, 'generate_audio': True, 'audio': 'native', 'operation': 'text', 'route': '/text2video/fixture'},
])
def test_ordinary_adapter_settings_do_not_invent_missing_guide_requirements(parameters):
    from opendirector.domain.creation.generation import VideoGenerationSpec
    public = model('video')
    frozen_model = ModelSnapshot(modelConfigId=public.id, inputRules=public.inputRules,
        **{key: getattr(public, key) for key in ('kind', 'modelId', 'url', 'protocol', 'connectionType', 'videoAdapter')})
    frozen = InputSnapshot(spec=VideoGenerationSpec(**entity(100, kind='video', purpose='generation', modelConfigId=public.id)), model=frozen_model)
    output = asset(300, 'video')
    job = Job(**entity(400, inputSnapshot=frozen, inputFingerprint=frozen.fingerprint(),
        execution=dict(kind='video'), asset=asset_ref(output), status='succeeded', recovery='done',
        adapterParameters=parameters))
    result = ResultVersion(**entity(500, specId=uid(100), jobId=job.id, asset=job.asset, inputFingerprint=job.inputFingerprint))
    state = ProjectSnapshot(project=dict(id=PROJECT, name='Video'), assets=[output], jobs=[job], results=[result],
        generationSpecs=[frozen.spec.model_copy(update={'currentResultId': result.id})])
    assert report(state, models={public.id: frozen_model}, roots=(uid(100),)).items[0].reuseState == 'reusable'


def test_context_only_is_not_a_propagation_edge_but_retains_shared_fingerprint_semantics():
    from opendirector.domain.creation.generation import VideoGenerationSpec
    state = graph()
    public = model('video')
    video_model = ModelSnapshot(modelConfigId=uid(21), inputRules=public.inputRules,
        **{key: getattr(public, key) for key in ('kind', 'modelId', 'url', 'protocol', 'connectionType', 'videoAdapter')})
    data = state.model_dump()
    data['generationSpecs'] = list(data['generationSpecs'])
    data['generationSpecs'][2] = VideoGenerationSpec(**entity(102, kind='video', purpose='generation', modelConfigId=uid(21)))
    data['canvasItems'][2]['kind'] = 'video'
    data['jobs'] = [j for j in state.jobs if j.id != uid(402)]
    data['results'] = [r for r in state.results if r.id != uid(502)]
    state = ProjectSnapshot.model_validate(data)
    spec, refs = current_generation_inputs(state, state.generationSpecs[2], video_model.inputRules)
    assert refs[0].transmission == 'context_only'
    frozen = InputSnapshot(spec=spec, model=video_model, references=refs)
    output = asset(350, 'video')
    job = Job(**entity(450, inputSnapshot=frozen, inputFingerprint=frozen.fingerprint(), execution=dict(kind='video'),
        status='succeeded', recovery='done', asset=asset_ref(output)))
    result = ResultVersion(**entity(550, specId=spec.id, jobId=job.id, asset=job.asset, inputFingerprint=job.inputFingerprint))
    data = state.model_dump()
    data.update(assets=[*state.assets, output], jobs=[*state.jobs, job], results=[*state.results, result])
    data['generationSpecs'][2]['currentResultId'] = result.id
    state = ProjectSnapshot.model_validate(data)
    models = {uid(20): impact_model(), uid(21): video_model}
    changed = replace(state, 'generationSpecs', 1, prompt='B changed')
    value = report(changed, models=models)
    assert value.items[2].reuseState == 'reusable'
    assert not any(e.targetSpecId == uid(102) for e in value.dependencies)
    adopted = new_result(changed, 1)
    item = report(adopted, models=models).items[2]
    assert (item.inputState, item.reuseState) == ('changed', 'stale')
    assert item.reasons[0].fieldPaths == ('references',)


@pytest.mark.parametrize('reverse', [False, True])
def test_unknown_upstream_overrides_pending_independently_of_reference_order(reverse):
    state = graph()
    data = state.model_dump()
    data['references'] = [*state.references, entity(650, binding='follow_current',
        targetSpecId=uid(102), source=dict(id=uid(203)), order=1)]
    state = new_result(ProjectSnapshot.model_validate(data), 2)
    state = replace(state, 'generationSpecs', 1, prompt='B changed')
    # D's adopted inputs still match, but its execution evidence is incomplete.
    state = replace(state, 'jobs', 3, adapterParameters={'guide': 'unregistered'})
    if reverse:
        state = state.model_copy(update={'references': tuple(reversed(state.references))})
    item = report(state).items[2]
    assert item.inputState == 'equal'
    assert item.reuseState == 'unknown'
    assert any(reason.code == 'dependency_unresolved' and reason.objectId == uid(103) for reason in item.reasons)


def test_timeline_text_overlay_retains_generated_source_without_replacing_text():
    from opendirector.domain.creation.generation import TextGenerationSpec, freeze_input_snapshot
    from test_creation_timeline_text import data as timeline_data
    public = model('agent')
    text_model = ModelSnapshot(modelConfigId=public.id, inputRules=public.inputRules,
        **{key: getattr(public, key) for key in ('kind', 'modelId', 'url', 'protocol', 'connectionType', 'videoAdapter')})
    spec = TextGenerationSpec(**entity(100, kind='text', purpose='generation', modelConfigId=public.id))
    frozen = freeze_input_snapshot(spec, text_model, ())
    output, font = asset(350, 'text'), asset(351, 'file')
    job = Job(**entity(450, inputSnapshot=frozen, inputFingerprint=frozen.fingerprint(), execution=dict(kind='text'),
        status='succeeded', recovery='done', asset=asset_ref(output)))
    result = ResultVersion(**entity(550, specId=spec.id, jobId=job.id, asset=job.asset, inputFingerprint=job.inputFingerprint))
    timeline = timeline_data()
    timeline['fonts'][0]['asset'] = asset_ref(font)
    timeline['overlays'][0].update(sourceAsset=asset_ref(output), text='Edited retained title')
    state = ProjectSnapshot(project=dict(id=PROJECT, name='Text impact'), assets=[output, font], jobs=[job], results=[result],
        generationSpecs=[spec.model_copy(update={'currentResultId': result.id})],
        editorDocuments=[entity(800, kind='timeline', revision=3, data=timeline)])
    before = state.model_dump_json()
    consumers = report(state, roots=(spec.id,), models={public.id: text_model}).timelineConsumers
    assert len(consumers) == 1
    consumer = consumers[0]
    assert (consumer.kind, consumer.overlayId, consumer.assetId, consumer.specIds, consumer.association) == (
        'text_overlay', 'a', output.id, (spec.id,), 'asset')
    assert consumer.editorDocumentId == uid(800) and consumer.revision == 3
    assert state.model_dump_json() == before


@pytest.mark.parametrize('status,recovery,cancellation', [
    ('failed', 'download', 'not_requested'), ('failed', 'local', 'not_requested'),
    ('cancelled', 'remote', 'unknown'), ('cancelled', 'remote', 'requested'),
])
def test_recoverable_jobs_keep_their_original_identity(status, recovery, cancellation):
    state = graph()
    original = state.jobs[1].model_copy(update=dict(id=uid(901), status=status, recovery=recovery,
        asset=None, resumeAllowed=True, cancelRequested=cancellation != 'not_requested',
        remoteCancellation=cancellation, externalTaskId='accepted-original-job'))
    terminal = original.model_copy(update=dict(id=uid(902), recovery='retry', resumeAllowed=False,
        remoteCancellation='confirmed' if cancellation != 'not_requested' else cancellation))
    state = state.model_copy(update={'jobs': (*state.jobs, original, terminal)})
    item = report(state).items[1]
    assert item.activeJobIds == (original.id,)
    assert item.reuseState == 'reusable'


@pytest.mark.parametrize('evidence', ['timeline', 'jobs', 'combined'])
def test_report_evidence_overflow_is_explicit_including_pending_job_ids(evidence):
    from opendirector.domain.creation.validation import ContractError
    state = graph(count=1, links=())
    data = state.model_dump()
    if evidence in {'jobs', 'combined'}:
        count = 10001 if evidence == 'combined' else 20001
        original = state.jobs[0]
        data['jobs'] = [original, *(original.model_copy(update=dict(id=UUID(int=10000+i), status='running',
            recovery='remote', externalTaskId=f'accepted-{i}', asset=None)) for i in range(count))]
    if evidence in {'timeline', 'combined'}:
        count = 10000 if evidence == 'combined' else 20001
        resource = dict(asset=asset_ref(state.assets[0]), title='Retained output')
        data['editorDocuments'] = [entity(800, kind='timeline', data=dict(fps=24, width=16, height=16,
            tracks=[dict(id='v', kind='visual', title='Shots', clips=[dict(id=str(i), resource=resource,
                inPoint=0, outPoint=1) for i in range(count)])]))]
    state = ProjectSnapshot.model_validate(data)
    with pytest.raises(ContractError) as error:
        report(state, roots=(uid(100),), max_nodes=1)
    assert error.value.issue.code == 'impact_scope_exceeded'
