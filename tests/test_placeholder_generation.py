"""Built-in placeholder generator: the zero-key first attempt stays a real job."""
import asyncio

import pytest

from opendirector.domain.creation.models import BUILTIN_PLACEHOLDER_URL
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import (BUILTIN_PLACEHOLDER_IMAGE_ID, ModelConfigs,
                                                       connection_fields)
from opendirector.integrations.placeholder import PlaceholderGeneration

from generation_helpers import command as build_submit, new_project, settled


def test_builtin_seed_is_idempotent_and_coexists_with_real_models(tmp_path):
    configs = ModelConfigs(tmp_path)
    first = configs.ensure_builtin()
    assert first['id'] == BUILTIN_PLACEHOLDER_IMAGE_ID
    assert first['connectionType'] == 'builtin' and first['protocol'] == 'placeholder'
    assert first['url'] == BUILTIN_PLACEHOLDER_URL and first['authMode'] == 'none'
    assert first['inputRules']['profile'] == 'compatible'
    assert configs.ensure_builtin() == first
    assert len(configs.list()) == 1
    resolved = configs.resolve(first['id'], 'image')
    assert resolved['apiKey'] == '' and resolved['proxyMode'] == 'direct'
    configs.save('image', 'https://models.example/v1', 'real-model', 'secret')
    assert configs.ensure_builtin()['id'] == first['id']
    assert len(configs.list()) == 2


def test_builtin_connection_fields_force_placeholder_protocol():
    assert connection_fields('image', 'builtin') == {
        'connectionType': 'builtin', 'protocol': 'placeholder', 'authMode': 'none', 'proxyMode': 'direct'}
    with pytest.raises(ProjectError):
        connection_fields('agent', 'builtin')


def test_placeholder_provider_generates_deterministic_png():
    provider = PlaceholderGeneration()
    config = {'kind': 'image', 'protocol': 'placeholder', 'modelId': 'placeholder', 'apiKey': ''}
    task = {'id': 'task', 'kind': 'image', 'prompt': '一个有电影感的月光房间', 'parameters': {'size': 'auto'}}
    suffix, data = asyncio.run(provider.generate(config, task, None))
    assert suffix == 'png' and data[:8] == b'\x89PNG\r\n\x1a\n'
    assert asyncio.run(provider.generate(config, dict(task), None))[1] == data
    other = asyncio.run(provider.generate(config, {**task, 'prompt': '另一句提示词'}, None))
    assert other[1] != data


def test_placeholder_provider_rejects_unsupported_kinds():
    provider = PlaceholderGeneration()
    config = {'kind': 'image', 'protocol': 'placeholder', 'modelId': 'placeholder'}
    with pytest.raises(ProjectError, match='仅支持图片'):
        provider.validate('video', config)
    task = {'id': 'task', 'kind': 'video', 'prompt': 'x', 'parameters': {}}
    with pytest.raises(ProjectError, match='仅支持图片'):
        asyncio.run(provider.generate(config, task, None))


async def _zero_key_first_win(tmp_path):
    from opendirector.application.creation_generation import CreationGeneration
    project = new_project(tmp_path, name='Zero-key first win')
    configs = ModelConfigs(tmp_path)
    builtin = configs.ensure_builtin()
    generation = CreationGeneration(project[0], configs)
    submit = build_submit(project, builtin, kind='image',
        prompt='一个有电影感的月光房间', parameters={'size': 'auto'})
    receipt = await generation.execute(submit, session=project[2])
    assert receipt.status == 'accepted', receipt
    await settled(generation)
    return generation, project, str(receipt.jobIds[0])


def test_zero_key_submit_registers_placeholder_candidate(tmp_path):
    from opendirector.application.creation_generation import media_record

    generation, project, job_id = asyncio.run(_zero_key_first_win(tmp_path))
    projects, pid, _session = project
    snapshot = projects.snapshot(pid)
    job = next(j for j in snapshot.jobs if str(j.id) == job_id)
    assert job.status == 'succeeded'
    assert job.inputSnapshot.model.protocol == 'placeholder'
    asset = next(a for a in snapshot.assets if a.provenance.jobId == job.id)
    assert asset.metadata.mimeType == 'image/png'
    record = media_record(asset)
    assert record['placeholder'] is True
    _stream, reopened = generation.assets.open_media(pid, asset.id)
    assert reopened.id == asset.id
    spec = next(s for s in snapshot.generationSpecs if s.id == job.inputSnapshot.spec.id)
    # Default submit policy adopts the result as current; the DSH entry passes
    # candidate_only explicitly and adopts through result.select instead.
    result = next(r for r in snapshot.results if r.jobId == job.id)
    assert spec.currentResultId == result.id


def test_zero_key_submit_survives_provider_absence_in_private_config(tmp_path):
    """The placeholder never reads credentials: the private snapshot stays empty."""
    configs = ModelConfigs(tmp_path)
    builtin = configs.ensure_builtin()
    assert 'apiKey' not in builtin
    resolved = configs.resolve(builtin['id'], 'image')
    assert resolved['apiKey'] == '' and resolved['url'] == BUILTIN_PLACEHOLDER_URL
