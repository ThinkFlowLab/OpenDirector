"""C02 boundary tests: roles, detached execution, retained editors and shared schemas."""
import json
from pathlib import Path
import subprocess
import sys
from uuid import UUID

from pydantic import ValidationError
import pytest

from opendirector.domain.creation import (
    ContractError, ProjectSnapshot, node_capabilities, parse_command, role_after,
    validate_command, validate_generation,
)
from opendirector.domain.creation.assets import Asset, AssetRef
from opendirector.domain.creation.canvas import CanvasItemBase
from opendirector.domain.creation.commands import CommandReceipt, command_fingerprint
from opendirector.domain.creation.generation import InputSnapshot, Job, ResultVersion
from opendirector.domain.creation.models import ModelConfigPublic, ModelConfigWrite, ModelSnapshot
from opendirector.domain.creation.project import ViewState
from opendirector.domain.input_rules import input_rules

ROOT = Path(__file__).resolve().parents[1]
PROJECT = UUID(int=1)


def uid(number):
    return UUID(int=number)


def entity(number, **fields):
    return dict(id=uid(number), projectId=PROJECT, **fields)


def model(kind='image', **fields):
    config = dict(kind=kind, url='https://models.example/v1', modelId='example',
                  connectionType='api', protocol='vllm_omni' if kind == 'video' else 'openai',
                  authMode='none', videoAdapter='auto')
    config.update(fields)
    return ModelConfigPublic(id=uid(20), inputRules=input_rules(config), **config)


def model_snapshot(config):
    fields = config.model_dump(exclude={'id', 'inputRules', 'authMode', 'videoCapabilities'})
    return ModelSnapshot(modelConfigId=config.id, **fields)


def asset(number, kind):
    return Asset(**entity(number, kind=kind, name=f'{kind} source',
        fingerprint='sha256:' + f'{number:064x}', path=f'assets/{uid(number)}',
        metadata=dict(mimeType={'text': 'text/plain', 'image': 'image/png', 'video': 'video/mp4',
                                'audio': 'audio/wav', 'file': 'application/pdf'}[kind], size=100,
                      **({'durationSeconds': 4} if kind in {'video', 'audio'} else {}),
                      **({'width': 128, 'height': 128} if kind == 'image' else {})),
        provenance=dict(source='upload')))


def asset_ref(value):
    return AssetRef(assetId=value.id, revision=value.revision, fingerprint=value.fingerprint, kind=value.kind)


def project_example():
    """One real object graph exercises all retained node/editor kinds, not isolated DTOs."""
    assets = [asset(number, kind) for number, kind in enumerate(('text', 'image', 'video', 'audio', 'file'), 10)]
    text, image, video, audio, file = [asset_ref(value) for value in assets]
    resource = lambda ref: dict(asset=ref, title=ref.kind, durationSeconds=4)
    transform = dict(position=dict(x=0, y=0, z=0), rotation=dict(x=0, y=0, z=0), scale=dict(x=1, y=1, z=1))
    camera = dict(position=dict(x=0, y=1, z=5), target=dict(x=0, y=0, z=0), fov=50)
    documents = [
        entity(30, kind='subject', data=dict(description='actor', main=image, auxiliaries=[], voice=audio)),
        entity(31, kind='timeline', data=dict(fps=30, width=1920, height=1080, importedAssets=[resource(image)], tracks=[
            dict(id='visual', kind='visual', title='Visual', clips=[dict(id='shot', resource=resource(video), inPoint=0, outPoint=2)]),
            # Audio extends past the visual cut; that OpenDirector behavior must survive.
            dict(id='audio', kind='audio', title='Audio', clips=[dict(id='music', resource=resource(audio), start=1, inPoint=0, outPoint=4)]),
        ])),
        entity(32, kind='stack', data=dict(nodeIds=[uid(40)], activeIndex=0)),
        entity(33, kind='tool', data=dict(kind='palette', fields=[dict(name='color', values=['#ffffff'])], palette=dict(sourceImage=image))),
        entity(34, kind='director', data=dict(background='#ffffff', duration=5, activeCameraId='camera',
            cameras=[dict(id='camera', name='Camera', pose=camera, keyframes=[dict(id='key', time=0, value=camera)])],
            cameraSource='storyboard', shots=[dict(id='cut', cameraId='camera', start=0, duration=5)],
            objects=[dict(id='actor', kind='person', name='Actor', color='#ff0000', **transform,
                          motionClips=[dict(id='walk', start=0, duration=4, motion=dict(preset='walk', speed=1, amount=1))])])),
        entity(35, kind='layers', data=dict(width=128, height=128, layers=[dict(id='layer', name='Original', width=128, height=128,
            content=dict(kind='image', asset=image, width=128, height=128), mask=[dict(mode='erase', size=10, points=[dict(x=1, y=2)])])])),
        entity(36, kind='media_edit', data=dict(tool='crop', sources=[image], parameters=dict(ratio='1:1'),
                                              selection=dict(source=image, width=128, height=128))),
    ]
    items = [entity(40 + index, kind=ref.kind, binding=dict(role='material', objectRef=ref),
                    **(dict(editors=[dict(id=uid(35), kind='layers'), dict(id=uid(36), kind='media_edit')]) if ref.kind == 'image' else {}))
             for index, ref in enumerate((text, image, video, audio, file))]
    items += [entity(45 + index, kind=kind, binding=dict(role='editor', objectRef=dict(id=uid(30 + index), kind=doc_kind)))
              for index, (kind, doc_kind) in enumerate([('subject', 'subject'), ('timeline', 'timeline'),
                                                      ('stack', 'stack'), ('tool', 'tool'), ('external', 'director')])]
    items.append(entity(50, kind='group'))
    spec = entity(60, kind='image', purpose='generation', modelConfigId=uid(20), prompt='A mountain')
    draft = entity(61, kind='text', prompt='Configured but still empty')
    items += [entity(51, kind='image', binding=dict(role='generation', objectRef=dict(id=uid(60)))),
              entity(52, kind='text', binding=dict(role='empty', draftSpec=dict(id=uid(61)))),
              entity(53, kind='image', binding=dict(role='empty'))]
    snapshot = InputSnapshot(spec=spec, model=model_snapshot(model()))
    output = asset(15, 'image')
    output = Asset.model_validate({**output.model_dump(), 'provenance': dict(source='generated', jobId=uid(70), inputFingerprint=snapshot.fingerprint())})
    job = Job(**entity(70, inputSnapshot=snapshot, inputFingerprint=snapshot.fingerprint(),
                      execution=dict(kind='image', size='2K'), status='succeeded', phase='complete', recovery='done', asset=asset_ref(output)))
    result = ResultVersion(**entity(71, specId=uid(60), jobId=job.id, asset=asset_ref(output), inputFingerprint=snapshot.fingerprint()))
    # Display selection belongs to the editable spec, never the execution snapshot.
    spec['currentResultId'] = result.id
    return ProjectSnapshot(project=dict(id=PROJECT, name='Contract example'), assets=[*assets, output],
                           generationSpecs=[spec, draft], canvasItems=items, editorDocuments=documents, jobs=[job], results=[result])


def wire():
    return project_example().model_dump(mode='json')


def command(kind, payload, versions=(), **fields):
    return parse_command(dict(commandId=uid(90), projectId=PROJECT, type=kind, payload=payload,
                              expectedVersions=[dict(objectType=kind, id=uid(number), revision=revision)
                                                for kind, number, revision in versions], **fields))


def test_all_retained_nodes_and_editors_roundtrip_and_share_base():
    value = project_example()
    assert ProjectSnapshot.model_validate_json(value.model_dump_json()) == value
    assert {node.kind for node in value.canvasItems} == {'text', 'image', 'video', 'audio', 'file', 'group', 'subject', 'timeline', 'stack', 'tool', 'external'}
    assert all(isinstance(node, CanvasItemBase) for node in value.canvasItems)
    timeline = value.editorDocuments[1].data
    assert timeline.tracks[1].clips[0].start + timeline.tracks[1].clips[0].duration() == 5
    assert timeline.tracks[0].clips[0].duration() == 2
    assert value.jobs[0].inputSnapshot.spec.currentResultId is None
    assert value.generationSpecs[0].currentResultId == value.results[0].id


def test_cross_language_fixture_matches_normalized_python_contract():
    assert json.loads((ROOT / 'tests/fixtures/creation-project.json').read_text()) == wire()


@pytest.mark.parametrize(('role', 'action', 'expected'), [
    ('empty', 'configure_generation', 'empty'), ('empty', 'upload_material', 'material'),
    ('empty', 'save_manual_text', 'material'), ('empty', 'add_reference', 'generation'),
    ('empty', 'accept_generation', 'generation'), ('material', 'upload_material', 'material'),
    ('material', 'save_manual_text', 'material'), ('generation', 'accept_generation', 'generation'),
    ('generation', 'add_reference', 'generation'), ('generation', 'select_result', 'generation'),
])
def test_purpose_locks_only_after_accepted_operation(role, action, expected):
    assert role_after(role, action, accepted=False) == role
    assert role_after(role, action) == expected


@pytest.mark.parametrize(('role', 'action'), [
    ('material', 'accept_generation'), ('material', 'add_reference'), ('material', 'configure_generation'),
    ('generation', 'save_manual_text'), ('generation', 'upload_material'), ('empty', 'select_result'),
])
def test_role_restrictions_cannot_be_bypassed_by_shared_media_type(role, action):
    with pytest.raises(ValueError, match='incompatible'):
        role_after(role, action)


@pytest.mark.parametrize('mutate', [
    lambda p: p.update(formatVersion=1),
    lambda p: p.update(nodes=[]),
    lambda p: p['canvasItems'][0].update(kind='image'),
    lambda p: p['canvasItems'][0]['binding'].update(approved=True),
    lambda p: p['canvasItems'][1]['binding']['objectRef'].update(assetId=str(uid(999))),
    lambda p: p['canvasItems'][1]['binding']['objectRef'].update(fingerprint='sha256:' + '0' * 64),
    lambda p: p['canvasItems'][1].update(projectId=str(uid(999))),
    lambda p: p['canvasItems'][0].update(parentId=p['canvasItems'][1]['id']),
    lambda p: p['editorDocuments'][0].update(schemaVersion=2),
    lambda p: p['editorDocuments'][0]['data'].update(voice=p['canvasItems'][1]['binding']['objectRef']),
    lambda p: p['editorDocuments'][1]['data']['tracks'][0]['clips'][0].update(outPoint=10),
    lambda p: p['editorDocuments'][5]['data']['layers'][0]['content'].update(src='blob:temporary'),
    lambda p: p['generationSpecs'][0].update(purpose='draft'),
    lambda p: p['assets'][0].update(path='../credentials'),
    lambda p: p['canvasItems'][0].update(width=float('nan')),
])
def test_inconsistent_new_project_graph_is_rejected(mutate):
    data = wire()
    mutate(data)
    with pytest.raises(ValidationError):
        ProjectSnapshot.model_validate(data)


def test_references_lock_empty_node_and_hidden_sources_still_resolve():
    data = wire()
    data['references'] = [entity(80, targetSpecId=uid(61), binding='follow_current', source=dict(id=uid(40)))]
    with pytest.raises(ValidationError, match='empty node'):
        ProjectSnapshot.model_validate(data)
    data['references'][0]['targetSpecId'] = uid(60)
    data['canvasItems'][0]['visible'] = False
    assert ProjectSnapshot.model_validate(data).references[0].source.id == uid(40)


def test_undo_can_restore_empty_display_without_removing_accepted_history():
    data = wire()
    data['canvasItems'][11]['binding'] = dict(role='empty')
    restored = ProjectSnapshot.model_validate(data)
    assert restored.canvasItems[11].binding.role == 'empty'
    assert restored.jobs[0].status == 'succeeded'
    assert restored.results[0].jobId == restored.jobs[0].id
    # The retained generation spec remains an independent business object.
    assert restored.generationSpecs[0].purpose == 'generation'


@pytest.mark.parametrize('links', [
    [(51, 60)],
    [(51, 62), (54, 60)],
    [(51, 62), (54, 63), (55, 60)],
])
def test_following_self_references_and_cycles_roundtrip_without_changing_jobs(links):
    data = wire()
    frozen_jobs = json.dumps(data['jobs'], sort_keys=True)
    for item_id, spec_id in [(54, 62), (55, 63)]:
        data['generationSpecs'].append(entity(spec_id, kind='image', purpose='generation', prompt='Next image'))
        data['canvasItems'].append(entity(item_id, kind='image', binding=dict(role='generation', objectRef=dict(id=uid(spec_id)))))
    data['references'] = [entity(80 + index, targetSpecId=uid(target), binding='follow_current', source=dict(id=uid(source)))
                          for index, (source, target) in enumerate(links)]
    restored = ProjectSnapshot.model_validate(data)
    assert ProjectSnapshot.model_validate_json(restored.model_dump_json()) == restored
    assert len(restored.references) == len(links)
    assert json.dumps(restored.model_dump(mode='json')['jobs'], sort_keys=True) == frozen_jobs


@pytest.mark.parametrize('relationship', ['group', 'job_attempt'])
def test_non_reference_cycles_remain_rejected(relationship):
    data = wire()
    if relationship == 'group':
        data['canvasItems'][10]['parentId'] = str(uid(54))
        data['canvasItems'].append(entity(54, kind='group', parentId=uid(50)))
    else:
        data['jobs'][0]['previousJobId'] = str(uid(72))
        data['jobs'].append({**data['jobs'][0], 'id': str(uid(72)), 'previousJobId': str(uid(70))})
    with pytest.raises(ValidationError, match='Cyclic canvas group hierarchy' if relationship == 'group' else 'Cyclic job attempts'):
        ProjectSnapshot.model_validate(data)


def test_audio_track_overlap_rejected_without_truncating_long_audio():
    data = wire()
    clips = data['editorDocuments'][1]['data']['tracks'][1]['clips']
    clips.append({**clips[0], 'id': 'overlap', 'start': 2})
    with pytest.raises(ValidationError, match='overlap'):
        ProjectSnapshot.model_validate(data)


def test_frozen_execution_identity_excludes_presentation_and_ui_state():
    before = project_example()
    data = wire()
    data['canvasItems'][11].update(title='Renamed', position=dict(x=500, y=-40), visible=False)
    data['canvasItems'][11]['revision'] += 1
    after = ProjectSnapshot.model_validate(data)
    assert before.jobs[0].inputFingerprint == after.jobs[0].inputFingerprint
    snapshot = before.jobs[0].inputSnapshot.model_dump()
    snapshot['spec']['revision'] += 1
    assert InputSnapshot.model_validate(snapshot).fingerprint() == before.jobs[0].inputFingerprint
    ViewState(projectId=PROJECT, clientId=uid(99), viewport=dict(x=200, y=100, zoom=2))
    with pytest.raises(ValidationError, match='frozen'):
        before.jobs[0].inputSnapshot.spec.prompt = 'changed'
    data['jobs'][0]['inputSnapshot']['spec']['prompt'] = 'changed'
    with pytest.raises(ValidationError, match='fingerprint'):
        ProjectSnapshot.model_validate(data)


def test_snapshot_excludes_selection_credentials_and_wrong_model():
    snapshot = project_example().jobs[0].inputSnapshot.model_dump(mode='json')
    snapshot['model']['apiKey'] = 'private-key'
    with pytest.raises(ValidationError):
        InputSnapshot.model_validate(snapshot)
    snapshot['model'].pop('apiKey')
    snapshot['spec']['currentResultId'] = str(uid(71))
    with pytest.raises(ValidationError, match='display selection'):
        InputSnapshot.model_validate(snapshot)


@pytest.mark.parametrize('kind', ['agent', 'image', 'video', 'audio'])
def test_model_public_contract_accepts_existing_configuration_outputs(tmp_path, kind):
    from opendirector.infrastructure.local_projects import LocalProjects
    from opendirector.infrastructure.model_configs import ModelConfigs
    configs = ModelConfigs(LocalProjects(tmp_path).repository)
    value = configs.save(kind, 'https://models.example/v1', 'demo', 'private-key')
    parsed = ModelConfigPublic.model_validate(value)
    assert parsed.model_dump(mode='json', exclude_unset=True) == value
    assert ModelConfigPublic.model_validate(parsed.model_dump()) == parsed
    assert 'private-key' not in parsed.model_dump_json()


@pytest.mark.parametrize('kind', ['image', 'video'])
def test_shared_generation_contract_rejects_segmentation_models(kind):
    from opendirector.domain.creation.generation import ImageGenerationSpec, VideoGenerationSpec
    sam = model(kind, protocol='vllm_omni_segmentation')
    spec_type = ImageGenerationSpec if kind == 'image' else VideoGenerationSpec
    spec = spec_type(**entity(21, kind=kind, modelConfigId=sam.id, prompt='generate'))
    with pytest.raises(ValueError, match='视觉分割模型'):
        validate_generation(spec, sam)


def test_credential_write_is_separate_and_protocols_are_restricted():
    value = model().model_dump(exclude={'id', 'inputRules'})
    write = ModelConfigWrite(**value, apiKey='private-key')
    assert write.apiKey.get_secret_value() == 'private-key'
    assert 'private-key' not in write.model_dump_json()
    with pytest.raises(ValidationError):
        ModelConfigWrite(**{**value, 'protocol': 'vllm_omni'})
    with pytest.raises(ValidationError):
        ModelConfigWrite(**{**value, 'url': 'https://user:private-key@models.example/v1'})


def video_spec(**parameters):
    from opendirector.domain.creation.generation import VideoGenerationSpec
    return VideoGenerationSpec(**entity(65, kind='video', purpose='generation', modelConfigId=uid(20), prompt='A walk', parameters=parameters))


def resolved(kind='image', role='reference', **metadata):
    value = asset(18, kind)
    return dict(referenceId=uid(80), role=role, asset=asset_ref(value), metadata={**value.metadata.model_dump(), **metadata})


def test_video_capabilities_and_reference_rules_reuse_existing_profiles():
    from opendirector.domain.creation.generation import ResolvedReference
    config = model('video', videoAdapter='minimax_h3')
    assert config.inputRules.profile == 'vllm-omni-h3'
    validate_generation(video_spec(durationSeconds=5, resolution='480P'), config)
    with pytest.raises(ValueError, match='duration'):
        validate_generation(video_spec(durationSeconds=3, resolution='480P'), config)
    with pytest.raises(ValueError, match='Continuation'):
        validate_generation(video_spec(videoMode='continuation'), config)
    prior = ResolvedReference(**resolved('video', 'continuation'))
    validate_generation(video_spec(videoMode='continuation'), config, (prior,))
    image = ResolvedReference(**resolved(size=config.inputRules.imageBytes + 1))
    with pytest.raises(ValueError, match='byte limit'):
        validate_generation(video_spec(), config, (image,))


def test_frame_mode_counts_retained_image_relations_before_transmission_filtering():
    from opendirector.domain.creation.generation import ResolvedReference
    references = tuple(ResolvedReference(referenceId=uid(80 + index), role='reference',
        asset=asset_ref(asset(18 + index, 'image')), metadata=asset(18 + index, 'image').metadata,
        transmission='context_only') for index in range(3))
    config = model('video', videoAdapter='minimax_h3')
    validate_generation(video_spec(), config, references[:2])
    with pytest.raises(ValueError, match='最多连接 2'):
        validate_generation(video_spec(), config, references)


def test_seedance_image_reference_resolution_and_audio_duration_constraints():
    from opendirector.domain.creation.generation import ResolvedReference
    config = model('video', url='https://ark.cn-beijing.volces.com/api/plan/v3', protocol='volcengine', modelId='doubao-seedance-2.0')
    image = ResolvedReference(**resolved())
    audio = ResolvedReference(**{**resolved('audio', durationSeconds=16), 'referenceId': uid(81)})
    with pytest.raises(ValueError, match='resolution'):
        validate_generation(video_spec(videoMode='reference', resolution='1080P'), config, (image,))
    with pytest.raises(ValueError, match='15 seconds'):
        validate_generation(video_spec(videoMode='reference'), config, (image, audio))


def test_unknown_submission_requires_review_and_cancel_does_not_change_role():
    data = project_example().jobs[0].model_dump(mode='json')
    data.update(status='failed', recovery='review', asset=None, resumeAllowed=False,
                errorDetails=dict(category='submission_unknown', stage='submit', suggestion='Review before retrying', message='Submission status is unknown'))
    assert Job.model_validate(data).recovery == 'review'
    data['resumeAllowed'] = True
    with pytest.raises(ValidationError, match='Unknown submissions'):
        Job.model_validate(data)
    data.update(errorDetails=None, status='cancelled', resumeAllowed=False, cancelRequested=True, remoteCancellation='unknown')
    assert Job.model_validate(data).status == 'cancelled'
    project = wire()
    project['jobs'] = [data]
    project['assets'] = [asset for asset in project['assets'] if asset['provenance']['source'] != 'generated']
    project['results'] = []
    project['generationSpecs'][0]['currentResultId'] = None
    assert ProjectSnapshot.model_validate(project).canvasItems[11].binding.role == 'generation'


def test_ui_capabilities_use_role_and_model_constraints():
    p = project_example()
    assert not node_capabilities(p.canvasItems[1], assetAvailable=True).canGenerate
    assert node_capabilities(p.canvasItems[1], assetAvailable=True).canReplaceMaterial
    assert node_capabilities(p.canvasItems[11], spec=p.generationSpecs[0], model=model()).canGenerate
    assert not node_capabilities(p.canvasItems[11], spec=p.generationSpecs[0], model=model('audio')).canAcceptReferences
    assert not node_capabilities(p.canvasItems[5]).canConfigureGeneration
    assert node_capabilities(p.canvasItems[6]).canPlay


def test_same_command_parser_rejects_forged_flags_and_missing_versions():
    payload = dict(itemId=uid(40), position=dict(x=10, y=20))
    move = command('canvas.move', dict(items=[payload]), [('canvas_item', 40, 1)])
    validate_command(move, project_example())
    assert command_fingerprint(move) == command_fingerprint(parse_command(move.model_dump(mode='json')))
    with pytest.raises(ValidationError, match='current versions'):
        command('canvas.move', dict(items=[payload]))
    with pytest.raises(ValidationError):
        command('canvas.update', dict(itemId=uid(40), role='generation', approved=True), [('canvas_item', 40, 1)])
    stale = command('canvas.hide', dict(itemId=uid(40)), [('canvas_item', 40, 2)])
    with pytest.raises(ContractError) as error:
        validate_command(stale, project_example())
    assert error.value.issue.code == 'revision_conflict'


def test_commands_prevent_role_bypass_and_require_explicit_draft_discard():
    p = project_example()
    overwrite = command('canvas.materialize', dict(itemId=uid(51), asset=asset_ref(p.assets[1])), [('canvas_item', 51, 1)])
    with pytest.raises(ContractError) as error:
        validate_command(overwrite, p)
    assert error.value.issue.code == 'role_restricted'
    payload = dict(itemId=uid(52), asset=asset_ref(p.assets[0]))
    with pytest.raises(ContractError, match='discard'):
        validate_command(command('canvas.materialize', payload, [('canvas_item', 52, 1)]), p)
    validate_command(command('canvas.materialize', {**payload, 'discardGenerationDraft': True},
                             [('canvas_item', 52, 1), ('generation_spec', 61, 1)]), p)
    flipped = {**p.generationSpecs[1].model_dump(), 'purpose': 'generation'}
    with pytest.raises(ContractError, match='purpose'):
        validate_command(command('generationSpec.update', dict(spec=flipped), [('generation_spec', 61, 1)]), p)


def test_delete_requires_impact_preview_and_rejected_receipt_cannot_claim_changes():
    with pytest.raises(ValidationError, match='preview'):
        command('asset.delete', dict(assetIds=[uid(10)]), [('asset', 10, 1)])
    with pytest.raises(ValidationError, match='Rejected'):
        CommandReceipt(commandId=uid(90), projectId=PROJECT, inputFingerprint='0' * 64,
                       status='rejected', jobIds=[uid(70)], issues=[dict(code='invalid_input', message='Invalid')])


def test_generated_schemas_are_current_and_distinguish_defaults():
    subprocess.run([sys.executable, str(ROOT / 'scripts/generate_contracts.py'), '--check'], check=True, cwd=ROOT)
    catalog = json.loads((ROOT / 'src/contracts/creation.schema.json').read_text())
    assert 'width' not in catalog['input']['$defs']['ImageCanvasItem']['required']
    assert 'width' in catalog['output']['$defs']['ImageCanvasItem']['required']
    assert catalog['input']['$defs']['CanvasShow']['properties']['item']['discriminator']['propertyName'] == 'kind'


@pytest.mark.parametrize('kind,transmission,expected', [
    ('text', 'content', 'first_frame'),
    ('image', 'context_only', 'first_frame'),
    ('image', 'content', 'reference'),
    ('video', 'content', 'reference'),
    ('audio', 'content', 'reference'),
])
def test_effective_video_mode_uses_transmitted_media_and_keeps_editable_intent(kind, transmission, expected):
    from opendirector.domain.creation.generation import ResolvedReference, execution_spec
    spec = video_spec(videoMode='reference')
    ref = ResolvedReference(**{**resolved(kind), 'transmission': transmission})
    rules = model('video').inputRules
    effective = execution_spec(spec, (ref,), rules)
    assert effective.parameters.videoMode == expected
    assert spec.parameters.videoMode == 'reference'
    # The same resolution is used for the frozen request and adoption comparison.
    assert execution_spec(effective, (ref,), rules) == effective
    continuation = video_spec(videoMode='continuation')
    assert execution_spec(continuation, (), rules) is continuation


def test_music_fields_leave_speech_fingerprints_unchanged():
    # Jobs recorded before music support fingerprint these exact dumps; extra
    # default keys would make every saved speech job fail validation on load.
    from opendirector.domain.creation.generation import AudioExecution, AudioParameters
    assert AudioParameters().model_dump(mode='json') == {'creationType': 'audio', 'mode': 'tts', 'voice': None}
    assert AudioExecution(kind='audio', format='mp3').model_dump(mode='json') == {
        'kind': 'audio', 'voice': None, 'speaker': None, 'format': 'mp3', 'sampleRate': None}
    music = AudioParameters(creationType='music', lyrics='[verse]\n雨', durationSeconds=45)
    assert music.model_dump(mode='json')['lyrics'] == '[verse]\n雨' and music.model_dump()['durationSeconds'] == 45
