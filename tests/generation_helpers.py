"""Fixtures submit real unified commands and expose the fixed adapter snapshot."""
import asyncio
from uuid import UUID, uuid4

from opendirector.application.creation_canvas import asset_ref
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from test_creation_canvas_service import media, send, ver


def new_project(path, name='Generation test'):
    projects = CreationProjects(LocalProjects(path))
    pid, session = uuid4(), str(uuid4())
    assert send(projects, pid, 'project.create', name=name).status == 'applied'
    projects.open(pid, session)
    return projects, pid, session


def command(project, config, *, kind=None, parameters=None, prompt='生成测试', references=()):
    projects, pid, session = project
    kind = kind or ('text' if config['kind'] == 'agent' else config['kind'])
    item, spec = media(project, kind)
    updated = spec.model_copy(update={'modelConfigId': UUID(config['id']), 'prompt': prompt,
        'parameters': type(spec.parameters).model_validate(parameters or {})})
    receipt = send(projects, pid, 'generationSpec.update', session=session,
                   versions=[ver('generation_spec', spec)], spec=updated)
    assert receipt.status == 'applied', receipt
    for index, reference in enumerate(references):
        snapshot = projects.snapshot(pid)
        spec = next(s for s in snapshot.generationSpecs if s.id == spec.id)
        item = next(i for i in snapshot.canvasItems if i.id == item.id)
        asset = next(a for a in snapshot.assets if str(a.id) == str(reference))
        receipt = send(projects, pid, 'reference.add', session=session,
            versions=[ver('generation_spec', spec), ver('canvas_item', item)],
            reference=dict(id=uuid4(), projectId=pid, targetSpecId=spec.id, order=index,
                role='continuation' if (parameters or {}).get('videoMode') == 'continuation' and asset.kind == 'video' else 'reference',
                binding='pinned', source=asset_ref(asset)))
        assert receipt.status == 'applied', receipt
    snapshot = projects.snapshot(pid)
    spec = next(s for s in snapshot.generationSpecs if s.id == spec.id)
    item = next(i for i in snapshot.canvasItems if i.id == item.id)
    return parse_command(dict(commandId=uuid4(), projectId=pid, type='generation.submit',
        expectedVersions=[ver('generation_spec', spec), ver('canvas_item', item)],
        payload=dict(specId=spec.id, expectedSpecRevision=spec.revision, originItemId=item.id)))


def prepared(runner, project, config, **kwargs):
    request = command(project, config, **kwargs)
    receipt = runner.prepare(request, session=project[2])
    if receipt.status == 'rejected':
        raise ProjectError(receipt.issues[0].message, 422)
    assert receipt.status == 'accepted', receipt
    task = runner.task(runner.get_job(project[1], receipt.jobIds[0]))
    private = runner.configs.resolve(config['id'], config['kind'])
    return task, runner.directory(project[1]), private


def tasks(runner, pid):
    return [runner.task(job) for job in runner.projects.snapshot(pid).jobs]


async def settled(runner):
    await asyncio.gather(*(job.future for job in list(runner.jobs.values())))


async def cancel(runner, pid, job_id, session):
    job = runner.get_job(pid, job_id)
    request = parse_command(dict(commandId=uuid4(), projectId=pid, type='job.cancel',
        expectedVersions=[ver('job', job)], payload=dict(jobId=job.id)))
    receipt = await runner.execute(request, session=session)
    assert receipt.status == 'applied', receipt
