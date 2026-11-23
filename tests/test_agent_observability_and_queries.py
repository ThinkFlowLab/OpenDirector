"""Verify compact/scoped project views and dry-run generation precheck across HTTP, Agent, and CLI."""
import json
import re
from uuid import uuid4

from fastapi.testclient import TestClient
import httpx
import pytest
from typer.testing import CliRunner

from opendirector import cli
from opendirector.agent.context import RunContext
from opendirector.agent.gateway import ToolGateway
from opendirector.agent.tools import AgentTools
from opendirector.domain.creation.commands import parse_command
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector_api.main import create_app

CJK_RE = re.compile(r'[\u4e00-\u9fff]')


@pytest.fixture
def anyio_backend():
    return 'asyncio'


def _seed_multi_shot_project(tmp_path):
    local = LocalProjects(tmp_path)
    projects = CreationProjects(local)
    models = ModelConfigs(tmp_path)
    self_hosted_video = models.save(
        'video', 'http://127.0.0.1:19999/v1', 'MiniMax-H3-Lite', '',
        connection_type='self_hosted', protocol='vllm_omni', auth_mode='none',
    )['id']
    cloud_video = models.save(
        'video', 'https://api.minimaxi.com/v1', 'MiniMax-H3', 'test-key-placeholder',
        connection_type='api', protocol='minimax_video_v2', auth_mode='bearer',
    )['id']

    project_id = uuid4()
    session = str(uuid4())
    projects.execute(parse_command({
        'type': 'project.create',
        'projectId': project_id,
        'commandId': uuid4(),
        'payload': {'name': 'Multi-shot studio'},
    }))
    projects.open(project_id, session)

    from io import BytesIO
    from PIL import Image
    from opendirector.application.creation_assets import CreationAssets

    buf = BytesIO()
    Image.new('RGB', (320, 320), (40, 80, 120)).save(buf, format='PNG')
    handle = uuid4()
    writer = CreationAssets(projects).uploads.begin(
        project_id, handle, session, 'frame.png', expected_kind='image',
    )
    try:
        writer.write(buf.getvalue())
        writer.finish()
    finally:
        writer.abort()
    img_receipt = projects.execute(parse_command({
        'type': 'asset.import',
        'projectId': project_id,
        'commandId': uuid4(),
        'payload': {'uploadHandle': str(handle), 'expectedKind': 'image', 'name': 'frame.png'},
    }), session=session)
    assert img_receipt.status == 'applied'
    snap = projects.snapshot(project_id)
    img_asset = next(a for a in snap.assets if a.kind == 'image')

    ref_item_id = uuid4()
    projects.execute(parse_command({
        'type': 'canvas.show',
        'projectId': project_id,
        'commandId': uuid4(),
        'payload': {
            'item': {
                'id': str(ref_item_id),
                'projectId': str(project_id),
                'kind': 'image',
                'title': 'Key Frame',
                'position': {'x': 0, 'y': 0},
                'binding': {
                    'role': 'material',
                    'objectRef': {
                        'assetId': str(img_asset.id),
                        'revision': img_asset.revision,
                        'fingerprint': img_asset.fingerprint,
                        'kind': 'image',
                    },
                },
            },
        },
    }), session=session)

    ready_spec_id, ready_item_id = uuid4(), uuid4()
    locked_spec_id, locked_item_id = uuid4(), uuid4()
    missing_model_spec_id, missing_model_item_id = uuid4(), uuid4()
    cloud_spec_id, cloud_item_id = uuid4(), uuid4()

    long_prompt = 'Medium close-up Push In with small amplitude at slow speed. ' * 25
    operations = [
        {
            'type': 'generationSpec.create',
            'payload': {
                'spec': {
                    'id': str(ready_spec_id),
                    'projectId': str(project_id),
                    'kind': 'video',
                    'purpose': 'generation',
                    'modelConfigId': self_hosted_video,
                    'prompt': long_prompt,
                    'parameters': {'videoMode': 'first_frame', 'durationSeconds': 6},
                },
            },
        },
        {
            'type': 'canvas.show',
            'payload': {
                'item': {
                    'id': str(ready_item_id),
                    'projectId': str(project_id),
                    'kind': 'video',
                    'title': 'Shot 01',
                    'position': {'x': 420, 'y': 0},
                    'binding': {'role': 'generation', 'objectRef': {'id': str(ready_spec_id)}},
                },
            },
        },
        {
            'type': 'reference.add',
            'payload': {
                'reference': {
                    'id': str(uuid4()),
                    'projectId': str(project_id),
                    'targetSpecId': str(ready_spec_id),
                    'role': 'first_frame',
                    'order': 0,
                    'binding': 'follow_current',
                    'source': {'objectType': 'canvas_item', 'id': str(ref_item_id)},
                },
            },
        },
        {
            'type': 'generationSpec.create',
            'payload': {
                'spec': {
                    'id': str(locked_spec_id),
                    'projectId': str(project_id),
                    'kind': 'video',
                    'purpose': 'generation',
                    'modelConfigId': self_hosted_video,
                    'prompt': long_prompt,
                    'parameters': {'videoMode': 'first_frame', 'durationSeconds': 5},
                },
            },
        },
        {
            'type': 'canvas.show',
            'payload': {
                'item': {
                    'id': str(locked_item_id),
                    'projectId': str(project_id),
                    'kind': 'video',
                    'title': 'Locked Shot',
                    'locked': True,
                    'position': {'x': 420, 'y': 320},
                    'binding': {'role': 'generation', 'objectRef': {'id': str(locked_spec_id)}},
                },
            },
        },
        {
            'type': 'generationSpec.create',
            'payload': {
                'spec': {
                    'id': str(missing_model_spec_id),
                    'projectId': str(project_id),
                    'kind': 'video',
                    'purpose': 'generation',
                    'modelConfigId': None,
                    'prompt': 'Unconfigured draft shot',
                    'parameters': {'videoMode': 'first_frame', 'durationSeconds': 5},
                },
            },
        },
        {
            'type': 'canvas.show',
            'payload': {
                'item': {
                    'id': str(missing_model_item_id),
                    'projectId': str(project_id),
                    'kind': 'video',
                    'title': 'Draft Shot',
                    'position': {'x': 420, 'y': 640},
                    'binding': {'role': 'generation', 'objectRef': {'id': str(missing_model_spec_id)}},
                },
            },
        },
        {
            'type': 'generationSpec.create',
            'payload': {
                'spec': {
                    'id': str(cloud_spec_id),
                    'projectId': str(project_id),
                    'kind': 'video',
                    'purpose': 'generation',
                    'modelConfigId': cloud_video,
                    'prompt': 'Wide establishing shot across mountain ridge',
                    'parameters': {'videoMode': 'first_frame', 'durationSeconds': 10},
                },
            },
        },
        {
            'type': 'canvas.show',
            'payload': {
                'item': {
                    'id': str(cloud_item_id),
                    'projectId': str(project_id),
                    'kind': 'video',
                    'title': 'Cloud Shot',
                    'position': {'x': 840, 'y': 0},
                    'binding': {'role': 'generation', 'objectRef': {'id': str(cloud_spec_id)}},
                },
            },
        },
    ]
    batch = projects.execute(parse_command({
        'type': 'creation.batch',
        'projectId': project_id,
        'commandId': uuid4(),
        'payload': {'operations': operations},
    }), session=session)
    assert batch.status == 'applied', batch
    local.release(session)
    return {
        'local': local,
        'projects': projects,
        'models': models,
        'self_hosted_video': self_hosted_video,
        'project_id': project_id,
        'ref_item_id': ref_item_id,
        'ready_spec_id': ready_spec_id,
        'ready_item_id': ready_item_id,
        'locked_spec_id': locked_spec_id,
        'locked_item_id': locked_item_id,
        'missing_model_spec_id': missing_model_spec_id,
        'cloud_spec_id': cloud_spec_id,
    }


@pytest.mark.anyio
async def test_project_summary_and_scoped_views_match_across_http_agent_and_cli(tmp_path, monkeypatch):
    ctx = _seed_multi_shot_project(tmp_path)
    project_id = ctx['project_id']
    ready_item = str(ctx['ready_item_id'])

    api = TestClient(create_app(ctx['local']), headers={'X-OpenDirector-Request': '1'})
    original_client = httpx.Client
    monkeypatch.setattr(
        cli.httpx,
        'Client',
        lambda **kwargs: original_client(
            **kwargs,
            transport=httpx.MockTransport(
                lambda req: httpx.Response(
                    *(lambda res: (res.status_code, ))(
                        res := api.request(req.method, req.url.path, headers=dict(req.headers), content=req.read())
                    ),
                    headers=res.headers,
                    content=res.content,
                )
            ),
        ),
    )

    full_http = api.post(f'/api/creation/projects/{project_id}/queries', json={
        'type': 'project.get', 'projectId': str(project_id), 'queryId': str(uuid4()),
    }).json()
    summary_http = api.post(f'/api/creation/projects/{project_id}/queries', json={
        'type': 'project.get', 'projectId': str(project_id), 'queryId': str(uuid4()), 'view': 'summary',
    }).json()
    scoped_http = api.post(f'/api/creation/projects/{project_id}/queries', json={
        'type': 'project.get', 'projectId': str(project_id), 'queryId': str(uuid4()), 'itemIds': [ready_item],
    }).json()

    # Summary payload omits full prompt bodies and nested parameters, cutting context footprint.
    assert summary_http['view'] == 'summary'
    assert summary_http['counts']['canvasItems'] == 5
    assert summary_http['counts']['generationSpecs'] == 4
    assert len(json.dumps(summary_http)) < len(json.dumps(full_http)) * 0.65
    shot_entry = next(item for item in summary_http['canvasItems'] if item['id'] == ready_item)
    assert shot_entry['specId'] == str(ctx['ready_spec_id'])
    assert shot_entry['activeReferenceCount'] == 1
    assert len(shot_entry['promptPreview']) <= 120

    # Scoped full view retains the target item and its referenced spec/assets, excluding unrelated shots.
    assert [item['id'] for item in scoped_http['canvasItems']] == [ready_item]
    assert [spec['id'] for spec in scoped_http['generationSpecs']] == [str(ctx['ready_spec_id'])]
    assert len(scoped_http['references']) == 1
    assert len(scoped_http['assets']) == 1

    # CLI equivalence
    runner = CliRunner()
    cli_summary = runner.invoke(cli.app, ['--project', str(project_id), 'project', 'show', '--view', 'summary'])
    assert cli_summary.exit_code == 0, cli_summary.output
    assert json.loads(cli_summary.output) == summary_http

    cli_scoped = runner.invoke(cli.app, ['--project', str(project_id), 'project', 'show', '--item-id', ready_item])
    assert cli_scoped.exit_code == 0, cli_scoped.output
    assert json.loads(cli_scoped.output) == scoped_http

    # Agent ToolGateway equivalence
    business = AgentTools(ctx['projects'], None, ctx['models'])
    run = RunContext(
        runtime='codex', project_id=project_id, turn_id=uuid4(), session=str(uuid4()),
        directory=tmp_path, config=None, messages=[], selected_skills=[],
    )
    gateway = ToolGateway(business, run)
    try:
        agent_summary = await gateway.call('sum', 'read_project', {'view': 'summary'})
        assert not agent_summary.error
        assert agent_summary.value['project'] == summary_http

        agent_scoped = await gateway.call('scoped', 'read_project', {'view': 'summary', 'itemIds': [ready_item]})
        assert not agent_scoped.error
        assert agent_scoped.value['project']['scopedItemIds'] == [ready_item]
        assert len(agent_scoped.value['project']['canvasItems']) == 1

        missing = await gateway.call('missing', 'read_project', {'itemIds': [str(uuid4())]})
        assert missing.error
    finally:
        await gateway.close()


@pytest.mark.anyio
async def test_generation_precheck_has_zero_side_effects_and_localizes_errors(tmp_path, monkeypatch):
    import shutil
    from opendirector.media import probe as media_probe

    monkeypatch.setattr(
        media_probe.shutil,
        'which',
        lambda name: '/usr/bin/ffprobe' if name == 'ffprobe' else shutil.which(name),
    )
    ctx = _seed_multi_shot_project(tmp_path)
    project_id = ctx['project_id']
    before_history = ctx['projects'].history(project_id)
    before_snapshot = ctx['projects'].snapshot(project_id)

    api = TestClient(create_app(ctx['local']), headers={'X-OpenDirector-Request': '1'})
    original_client = httpx.Client
    monkeypatch.setattr(
        cli.httpx,
        'Client',
        lambda **kwargs: original_client(
            **kwargs,
            transport=httpx.MockTransport(
                lambda req: httpx.Response(
                    *(lambda res: (res.status_code, ))(
                        res := api.request(req.method, req.url.path, headers=dict(req.headers), content=req.read())
                    ),
                    headers=res.headers,
                    content=res.content,
                )
            ),
        ),
    )

    spec_ids = [
        str(ctx['ready_spec_id']),
        str(ctx['locked_spec_id']),
        str(ctx['missing_model_spec_id']),
        str(ctx['cloud_spec_id']),
    ]
    zh_res = api.post(
        f'/api/creation/projects/{project_id}/queries',
        headers={'Accept-Language': 'zh-CN'},
        json={'type': 'generation.precheck', 'projectId': str(project_id), 'queryId': str(uuid4()), 'specIds': spec_ids},
    )
    assert zh_res.status_code == 200
    zh_report = zh_res.json()
    assert zh_report['totalSpecs'] == 4
    assert zh_report['readySpecs'] == 2
    assert zh_report['blockedSpecs'] == 2
    assert zh_report['allReady'] is False
    assert 'requiresConfirmation' not in zh_report
    assert zh_report['byKind'] == {'video': 4}
    assert zh_report['byConnectionType'] == {'self_hosted': 2, 'api': 1}
    assert zh_report['byProtocol'] == {'vllm_omni': 2, 'minimax_video_v2': 1}
    assert zh_report['serviceTypes'] == ['api', 'self_hosted']
    assert zh_report['estimatedVideoSeconds'] == 26.0
    assert zh_report['estimatedAudioSeconds'] == 0.0
    assert zh_report['estimatedTotalDurationSeconds'] == 26.0
    assert zh_report['totalReferenceBytes'] > 0
    assert zh_report['uncheckedRequirementsCount'] >= 1

    by_spec = {entry['specId']: entry for entry in zh_report['items']}
    assert by_spec[str(ctx['ready_spec_id'])]['ready'] is True
    assert by_spec[str(ctx['ready_spec_id'])]['uncheckedRequirements'] == [
        {'check': 'model_availability', 'reasonCode': 'not_checked'},
    ]
    assert by_spec[str(ctx['cloud_spec_id'])]['ready'] is True
    assert by_spec[str(ctx['cloud_spec_id'])]['connectionType'] == 'api'
    assert by_spec[str(ctx['cloud_spec_id'])]['estimatedDurationSeconds'] == 10.0
    assert by_spec[str(ctx['locked_spec_id'])]['ready'] is False
    assert by_spec[str(ctx['locked_spec_id'])]['issues'][0]['code'] == 'role_restricted'
    assert by_spec[str(ctx['missing_model_spec_id'])]['ready'] is False
    assert by_spec[str(ctx['missing_model_spec_id'])]['issues'][0]['code'] == 'invalid_input'

    # Single self-hosted and single API prechecks return factual counts, durations, and service types without confirmation policy.
    single_self = api.post(
        f'/api/creation/projects/{project_id}/queries',
        json={
            'type': 'generation.precheck', 'projectId': str(project_id),
            'queryId': str(uuid4()), 'specIds': [str(ctx['ready_spec_id'])],
        },
    ).json()
    assert single_self['allReady'] is True
    assert 'requiresConfirmation' not in single_self
    assert single_self['serviceTypes'] == ['self_hosted']
    assert single_self['estimatedVideoSeconds'] == 6.0

    single_cloud = api.post(
        f'/api/creation/projects/{project_id}/queries',
        json={
            'type': 'generation.precheck', 'projectId': str(project_id),
            'queryId': str(uuid4()), 'specIds': [str(ctx['cloud_spec_id'])],
        },
    ).json()
    assert single_cloud['allReady'] is True
    assert 'requiresConfirmation' not in single_cloud
    assert single_cloud['serviceTypes'] == ['api']
    assert single_cloud['estimatedVideoSeconds'] == 10.0

    # English Accept-Language localizes every precheck issue without leaking CJK characters.
    en_report = api.post(
        f'/api/creation/projects/{project_id}/queries',
        headers={'Accept-Language': 'en-US'},
        json={'type': 'generation.precheck', 'projectId': str(project_id), 'queryId': str(uuid4()), 'specIds': spec_ids},
    ).json()
    for entry in en_report['items']:
        for issue in entry['issues']:
            assert issue['message']
            assert not CJK_RE.search(issue['message']), issue

    # CLI exit code is 0 when ready and 1 when blocked.
    runner = CliRunner()
    ok_cli = runner.invoke(cli.app, [
        '--project', str(project_id), 'generation', 'precheck', '--spec-id', str(ctx['ready_spec_id']),
    ])
    assert ok_cli.exit_code == 0, ok_cli.output
    assert json.loads(ok_cli.output)['allReady'] is True

    blocked_cli = runner.invoke(cli.app, [
        '--project', str(project_id), 'generation', 'precheck',
        '--spec-id', str(ctx['ready_spec_id']), '--spec-id', str(ctx['locked_spec_id']),
    ])
    assert blocked_cli.exit_code == 1
    assert json.loads(blocked_cli.output)['blockedSpecs'] == 1

    # Agent ToolGateway query equivalence
    business = AgentTools(ctx['projects'], None, ctx['models'])
    run = RunContext(
        runtime='codex', project_id=project_id, turn_id=uuid4(), session=str(uuid4()),
        directory=tmp_path, config=None, messages=[], selected_skills=[],
    )
    gateway = ToolGateway(business, run)
    try:
        agent_precheck = await gateway.call('precheck', 'query', {
            'type': 'generation.precheck', 'specIds': spec_ids,
        })
        assert not agent_precheck.error
        assert agent_precheck.value == zh_report
    finally:
        await gateway.close()

    # Authoritative proof of zero side effects: no jobs or history commits were created.
    after_snapshot = ctx['projects'].snapshot(project_id)
    after_history = ctx['projects'].history(project_id)
    assert after_snapshot == before_snapshot
    assert len(after_history) == len(before_history)
    assert after_snapshot.jobs == ()


def test_summary_includes_models_and_precheck_matches_submission_output_rules(tmp_path, monkeypatch):
    import shutil
    from opendirector.application.creation_generation import CreationGeneration
    from opendirector.domain.creation.validation import ContractError
    from opendirector.domain.projects import ProjectError
    from opendirector.media import probe as media_probe

    monkeypatch.setattr(
        media_probe.shutil,
        'which',
        lambda name: '/usr/bin/ffprobe' if name == 'ffprobe' else shutil.which(name),
    )

    ctx = _seed_multi_shot_project(tmp_path)
    projects = ctx['projects']
    models = ctx['models']
    project_id = ctx['project_id']
    api = TestClient(create_app(ctx['local']), headers={'X-OpenDirector-Request': '1'})

    summary = api.post(
        f'/api/creation/projects/{project_id}/queries',
        json={'type': 'project.get', 'projectId': str(project_id), 'queryId': str(uuid4()), 'view': 'summary'},
    ).json()
    assert isinstance(summary.get('models'), list) and len(summary['models']) >= 2
    assert all('apiKey' not in model for model in summary['models'])

    # Configure a tool-only segmentation model for precheck vs submit parity.
    seg_model = models.save(
        'image', 'http://127.0.0.1:19999/v1', 'SAM2-Segmentation', '',
        connection_type='self_hosted', protocol='vllm_omni_segmentation', auth_mode='none',
    )['id']

    session = str(uuid4())
    projects.open(project_id, session)

    # 1. Tool-only segmentation model bound to an image generation spec
    seg_spec_id, seg_item_id = uuid4(), uuid4()
    projects.execute(parse_command({
        'type': 'canvas.createGeneration',
        'projectId': project_id,
        'commandId': uuid4(),
        'payload': {
            'spec': {
                'id': str(seg_spec_id), 'projectId': str(project_id), 'kind': 'image',
                'purpose': 'generation', 'modelConfigId': seg_model, 'prompt': 'Segment subject', 'parameters': {},
            },
            'item': {
                'id': str(seg_item_id), 'projectId': str(project_id), 'kind': 'image',
                'position': {'x': 900, 'y': 0},
                'binding': {'role': 'generation', 'objectRef': {'id': str(seg_spec_id)}},
            },
            'references': [],
        },
    }), session=session)

    # 2. Video spec requesting unsupported explicit output resolution on vLLM-Omni H3
    bad_res_spec_id, bad_res_item_id = uuid4(), uuid4()
    projects.execute(parse_command({
        'type': 'canvas.createGeneration',
        'projectId': project_id,
        'commandId': uuid4(),
        'payload': {
            'spec': {
                'id': str(bad_res_spec_id), 'projectId': str(project_id), 'kind': 'video',
                'purpose': 'generation', 'modelConfigId': ctx['self_hosted_video'],
                'prompt': 'Wide shot alley',
                'parameters': {'videoMode': 'first_frame', 'durationSeconds': 5, 'resolution': '4K'},
            },
            'item': {
                'id': str(bad_res_item_id), 'projectId': str(project_id), 'kind': 'video',
                'position': {'x': 900, 'y': 260},
                'binding': {'role': 'generation', 'objectRef': {'id': str(bad_res_spec_id)}},
            },
            'references': [],
        },
    }), session=session)

    # Precheck must reject both specs for the exact same reason formal submission rejects them.
    report = api.post(
        f'/api/creation/projects/{project_id}/queries',
        json={
            'type': 'generation.precheck', 'projectId': str(project_id),
            'queryId': str(uuid4()), 'specIds': [str(seg_spec_id), str(bad_res_spec_id)],
        },
    ).json()
    assert report['readySpecs'] == 0
    assert report['blockedSpecs'] == 2
    by_spec = {entry['specId']: entry for entry in report['items']}
    assert '分割' in by_spec[str(seg_spec_id)]['issues'][0]['message']
    assert '分辨率' in by_spec[str(bad_res_spec_id)]['issues'][0]['message']

    gen_service = CreationGeneration(projects, models)
    for blocked_spec, origin_item in ((seg_spec_id, seg_item_id), (bad_res_spec_id, bad_res_item_id)):
        expected_msg = by_spec[str(blocked_spec)]['issues'][0]['message']
        try:
            submit_receipt = gen_service.prepare(parse_command({
                'type': 'generation.submit',
                'projectId': project_id,
                'commandId': uuid4(),
                'expectedVersions': [
                    {'objectType': 'generation_spec', 'id': str(blocked_spec), 'revision': 1},
                    {'objectType': 'canvas_item', 'id': str(origin_item), 'revision': 1},
                ],
                'payload': {
                    'specId': str(blocked_spec),
                    'originItemId': str(origin_item),
                    'expectedSpecRevision': 1,
                },
            }), session=session)
            assert submit_receipt.status == 'rejected'
            assert submit_receipt.issues[0].message == expected_msg
        except ContractError as err:
            assert err.issue.message == expected_msg
        except ProjectError as err:
            assert str(err) == expected_msg

    projects.local.release(session)


def test_precheck_shares_voice_selection_and_cached_capability_checks(tmp_path, monkeypatch):
    import shutil
    from opendirector.application.creation_generation import CreationGeneration
    from opendirector.application.model_availability import ModelAvailability
    from opendirector.application.voice_library import VoiceLibrary
    from opendirector.domain.creation.validation import ContractError
    from opendirector.domain.input_rules import input_rules
    from opendirector.domain.projects import ProjectError
    from opendirector.integrations.capability_probe import CapabilityProbe
    from opendirector.media import probe as media_probe

    monkeypatch.setattr(
        media_probe.shutil,
        'which',
        lambda name: '/usr/bin/ffprobe' if name == 'ffprobe' else shutil.which(name),
    )
    ctx = _seed_multi_shot_project(tmp_path)
    projects = ctx['projects']
    models = ctx['models']
    project_id = ctx['project_id']

    tts_cfg = models.save(
        'audio', 'http://127.0.0.1:19999/v1', 'MOSS-TTS-Drama3', '',
        connection_type='self_hosted', protocol='openai', auth_mode='none',
    )
    tts_id = tts_cfg['id']
    scope = input_rules(tts_cfg)['voiceLibrary']['connectionId']

    available_voices = {
        'voices': ['alice'],
        'uploaded_voices': [{'id': 'alice', 'name': 'Alice', 'embedding_source': 'audio', 'ref_text': 'Hello world.'}],
    }
    voice_transport = httpx.MockTransport(lambda req: httpx.Response(200, json=available_voices))

    session = str(uuid4())
    projects.open(project_id, session)
    tts_spec_id, tts_item_id = uuid4(), uuid4()
    projects.execute(parse_command({
        'type': 'canvas.createGeneration',
        'projectId': project_id,
        'commandId': uuid4(),
        'payload': {
            'spec': {
                'id': str(tts_spec_id),
                'projectId': str(project_id),
                'kind': 'audio',
                'purpose': 'generation',
                'modelConfigId': tts_id,
                'prompt': 'Welcome to the studio.',
                'parameters': {
                    'creationType': 'audio',
                    'mode': 'tts',
                    'voice': 'alice',
                    'voiceSelection': {
                        'connectionId': scope,
                        'voiceId': 'alice',
                        'name': 'Alice',
                        'source': 'uploaded',
                        'hasReferenceAudio': True,
                        'refText': 'Hello world.',
                    },
                },
            },
            'item': {
                'id': str(tts_item_id),
                'projectId': str(project_id),
                'kind': 'audio',
                'position': {'x': 1200, 'y': 0},
                'binding': {'role': 'generation', 'objectRef': {'id': str(tts_spec_id)}},
            },
            'references': [],
        },
    }), session=session)

    # 1. Existing voice passes precheck; unprobed model capability is reported in uncheckedRequirements.
    cap_transport = httpx.MockTransport(lambda req: httpx.Response(404))
    availability = ModelAvailability(models, CapabilityProbe(transport=cap_transport))
    gen_service = CreationGeneration(projects, models, availability=availability)
    gen_service.voices = VoiceLibrary(models, transport=voice_transport)

    ok_report = gen_service.precheck(projects.snapshot(project_id), (tts_spec_id,))
    assert ok_report['allReady'] is True, ok_report
    assert ok_report['uncheckedRequirementsCount'] == 1
    assert ok_report['items'][0]['uncheckedRequirements'] == [
        {'check': 'model_availability', 'reasonCode': 'not_checked'},
    ]

    # 2. Deleting the remote voice makes precheck reject with voice_not_found, matching prepare().
    available_voices['voices'] = []
    available_voices['uploaded_voices'] = []
    deleted_report = gen_service.precheck(projects.snapshot(project_id), (tts_spec_id,))
    assert deleted_report['allReady'] is False
    assert deleted_report['blockedSpecs'] == 1
    precheck_issue = deleted_report['items'][0]['issues'][0]
    assert precheck_issue['code'] == 'voice_not_found'

    try:
        submit_receipt = gen_service.prepare(parse_command({
            'type': 'generation.submit',
            'projectId': project_id,
            'commandId': uuid4(),
            'expectedVersions': [
                {'objectType': 'generation_spec', 'id': str(tts_spec_id), 'revision': 1},
                {'objectType': 'canvas_item', 'id': str(tts_item_id), 'revision': 1},
            ],
            'payload': {
                'specId': str(tts_spec_id),
                'originItemId': str(tts_item_id),
                'expectedSpecRevision': 1,
            },
        }), session=session)
        assert submit_receipt.status == 'rejected'
        assert submit_receipt.issues[0].code == precheck_issue['code']
        assert submit_receipt.issues[0].message == precheck_issue['message']
    except (ContractError, ProjectError) as err:
        assert getattr(err, 'code', getattr(getattr(err, 'issue', None), 'code', None)) == 'voice_not_found'

    # 3. Cached unavailable capability observation blocks precheck without network refresh.
    from test_model_availability import document as capability_document
    available_voices['voices'] = ['alice']
    available_voices['uploaded_voices'] = [{'id': 'alice', 'name': 'Alice', 'embedding_source': 'audio', 'ref_text': 'Hello world.'}]
    paused_doc = capability_document(
        operation='speech',
        profile='text_to_speech',
        path='/v1/audio/speech',
        output='audio',
        model='MOSS-TTS-Drama3',
        support='unsupported',
    )
    paused_probe = CapabilityProbe(transport=httpx.MockTransport(lambda req: httpx.Response(200, json=paused_doc)))
    paused_availability = ModelAvailability(models, paused_probe)
    paused_availability.refresh([tts_id], manual=True)
    paused_gen = CreationGeneration(projects, models, availability=paused_availability)
    paused_gen.voices = VoiceLibrary(models, transport=voice_transport)

    blocked_cap = paused_gen.precheck(projects.snapshot(project_id), (tts_spec_id,))
    assert blocked_cap['allReady'] is False
    assert blocked_cap['items'][0]['issues'][0]['code'] == 'capability_unavailable'
    assert blocked_cap['items'][0]['uncheckedRequirements'] == []

    projects.local.release(session)
