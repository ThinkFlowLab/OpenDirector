"""Tool execution history survives reloads in the unified project."""
import asyncio
from io import BytesIO
from uuid import uuid4

from fastapi.testclient import TestClient
from PIL import Image
import pytest

from opendirector.application.creation_tool_assets import CreationToolAssets
from opendirector.application.tool_tasks import ToolTasks
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector.infrastructure.model_configs import ModelConfigs
from opendirector_api.main import create_app


def png():
    out = BytesIO()
    Image.new('RGB', (64, 48), 'blue').save(out, 'PNG')
    return out.getvalue()


@pytest.fixture
def tool_project(tmp_path):
    store = LocalProjects(tmp_path)
    project_id, session, node_id = str(uuid4()), str(uuid4()), str(uuid4())
    projects = CreationProjects(store)
    projects.execute(parse_command(dict(commandId=uuid4(), projectId=project_id,
        type='project.create', payload=dict(name='Tool history'))))
    projects.open(project_id, session)
    assets = CreationToolAssets(projects)
    source = assets.import_file(project_id, str(uuid4()), 'source.png', png(), session)
    from opendirector.application.creation_canvas import asset_ref
    material = assets.assets.get(project_id, source['id'])
    receipt = projects.execute(parse_command(dict(commandId=uuid4(), projectId=project_id, type='canvas.show',
        payload=dict(item=dict(id=node_id, projectId=project_id, kind='image', binding=dict(role='material', objectRef=asset_ref(material)))))), session=session)
    assert receipt.status == 'applied'
    configs = ModelConfigs(store.repository)
    def service():
        return ToolTasks(store, configs, assets, projects=projects)
    value = dict(id=str(uuid4()), tool='image-hd', sourceAssetIds=[source['id']],
        parameters={'kind': 'normal', 'resolution': '2K'}, boxes=[],
        canvas=dict(nodeId=node_id, sourceNodeIds=[node_id]))
    return store, projects, assets, project_id, session, source, value, service


def test_history_is_service_owned_and_placement_acknowledgement_survives_restart(tool_project):
    store, projects, assets, project_id, session, source, value, factory = tool_project
    async def run():
        service = factory()
        try:
            await service.submit(project_id, value, session)
            await asyncio.gather(*service.jobs.values())
            task, = service.list(project_id)
            assert task['status'] == 'succeeded', task.get('error')
            assert task['canvas'] == value['canvas']
            assert task['sourceFingerprint'] == source['fingerprint']
            assert task['placement'] == 'pending'
            assert len(task['outputs']) == 1
            output = task['outputs'][0]
            assert output['canvasItemId'] != output['id']
            material = assets.assets.get(project_id, output['id'])
            assert material.provenance.sources[0].assetId == uuid_from(source['id'])
            assert not (store.root / 'Tool history' / 'assets.json').exists()
            assert projects.snapshot(project_id).jobs == ()  # not a fabricated GenerationSpec job
            restarted = factory()
            assert restarted.list(project_id)[0]['status'] == 'succeeded'
            with pytest.raises(ProjectError):
                restarted.placement(project_id, value['id'], 'placed', str(uuid4()))
            restarted.placement(project_id, value['id'], 'placed', session)
            assert factory().get(project_id, value['id'])['placement'] == 'placed'
            # Lost acceptance replies never submit or register the result again.
            replay = await restarted.submit(project_id, value, session)
            assert replay['outputs'] == task['outputs']
            assert restarted.jobs == {}
            with pytest.raises(ProjectError, match='标识已使用'):
                await restarted.submit(project_id, {**value, 'parameters': {'scale': 4}}, session)
        finally:
            await service.close()
    asyncio.run(run())


def uuid_from(value):
    from uuid import UUID
    return UUID(value)


def test_queued_cancel_has_a_terminal_cancelled_record(tool_project):
    _, _, _, project_id, session, _, value, factory = tool_project
    async def run():
        service = factory()
        service.limit = asyncio.Semaphore(1)
        await service.limit.acquire()
        try:
            await service.submit(project_id, value, session)
            task = await service.cancel(project_id, value['id'], session)
            assert task['status'] == 'cancelled'
            assert factory().list(project_id)[0]['status'] == 'cancelled'
            with pytest.raises(ProjectError, match='尚未完成'):
                service.placement(project_id, value['id'], 'placed', session)
        finally:
            service.limit.release()
            await service.close()
    asyncio.run(run())


def test_tool_task_routes_use_unified_project_authority(tool_project):
    store, projects, _, project_id, session, _, value, _ = tool_project
    prefix = '/api/creation'
    path = f'{prefix}/projects/{project_id}/tool-tasks'
    headers = {'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': session}
    with TestClient(create_app(store), headers=headers) as client:
        response = client.post(path, json=value)
        assert response.status_code == 202, response.text
        for _ in range(100):
            task = client.get(path + '/' + value['id']).json()
            if task['status'] not in {'queued', 'running'}:
                break
            import time
            time.sleep(.02)
        assert task['status'] == 'succeeded', task.get('error')
        assert client.get(path).json()['tasks'][0]['canvas'] == value['canvas']
        assert client.post(path + '/' + value['id'] + '/placement', json={'state': 'placed'}).status_code == 200
        assert client.get(path).json()['tasks'][0]['placement'] == 'placed'
        malformed = {**value, 'id': str(uuid4()), 'canvas': {'nodeId': str(uuid4()), 'sourceNodeIds': value['canvas']['sourceNodeIds']}}
        assert client.post(path, json=malformed).status_code == 422


def test_project_rename_waits_for_background_tool_tasks(tool_project):
    store, projects, _, project_id, session, _, value, factory = tool_project
    async def run():
        service = factory()
        await service.limit.acquire()
        try:
            await service.submit(project_id, value, session)
            store.release(session)
            with pytest.raises(ProjectError, match='工具任务'):
                snapshot = projects.snapshot(project_id)
                projects.execute(parse_command(dict(commandId=uuid4(), projectId=project_id, type='project.rename',
                    expectedVersions=[dict(objectType='project', id=project_id, revision=snapshot.project.revision)],
                    payload=dict(name='Renamed'))))
        finally:
            service.limit.release()
            await service.close()
    asyncio.run(run())


def test_pending_result_identity_and_timing_survive_service_restart(tool_project):
    _, projects, _, project_id, session, _, value, factory = tool_project
    target = str(uuid4())
    assert projects.execute(parse_command(dict(commandId=uuid4(), projectId=project_id, type='canvas.show',
        payload=dict(item=dict(id=target, projectId=project_id, kind='image', title='Pending result', binding=dict(role='empty'))))), session=session).status == 'applied'
    value = {**value, 'canvas': {**value['canvas'], 'targetNodeId': target,
                               'targetKind': 'image', 'targetTitle': 'Pending result'}}
    async def run():
        service = factory()
        try:
            await service.submit(project_id, value, session)
            await asyncio.gather(*service.jobs.values())
            task = factory().get(project_id, value['id'])
            assert task['status'] == 'succeeded', task.get('error')
            assert task['canvas'] == value['canvas']
            assert task['outputs'][0]['canvasItemId'] == target
            assert task['outputs'][0]['id'] != target
            assert task['createdAt'] < task['finishedAt']
            replay = await service.submit(project_id, value, session)
            assert replay['outputs'] == task['outputs']
        finally:
            await service.close()
    asyncio.run(run())


def test_pending_target_contract_rejects_partial_or_source_identities(tool_project):
    from opendirector_api.models import ToolTaskCreate
    from pydantic import ValidationError
    _, _, _, _, _, _, value, _ = tool_project
    for extra in ({'targetNodeId': str(uuid4())},
                  {'targetNodeId': value['canvas']['nodeId'], 'targetKind': 'image', 'targetTitle': 'Pending'},
                  {'targetNodeId': str(uuid4()), 'targetKind': 'text', 'targetTitle': 'Pending'}):
        with pytest.raises(ValidationError):
            ToolTaskCreate.model_validate({**value, 'canvas': {**value['canvas'], **extra}})


def test_multi_output_identities_use_the_target_only_for_the_matching_first_kind():
    from opendirector.application.tool_tasks import output_item_id
    task = dict(id=str(uuid4()), canvas=dict(targetNodeId=str(uuid4()), targetKind='video'))
    assert output_item_id(task, 0, 'video') == task['canvas']['targetNodeId']
    assert output_item_id(task, 0, 'image') != task['canvas']['targetNodeId']
    assert output_item_id(task, 1, 'video') != task['canvas']['targetNodeId']
    assert output_item_id(task, 1, 'video') == output_item_id(task, 1, 'video')


@pytest.mark.parametrize('model_kind', ['vision', 'image', 'video'])
def test_selection_route_uses_owned_assets_in_unified_projects(tool_project, monkeypatch, model_kind):
    import base64
    from opendirector.domain.capabilities import Segment
    from opendirector.integrations.model_adapters import VllmOmniSegmentation
    store, projects, assets, project_id, session, source, _, factory = tool_project
    configs = ModelConfigs(store.repository)
    configs.save(model_kind, 'http://fixture.invalid/v1', 'facebook/sam3', '', connection_type='self_hosted',
                 protocol='vllm_omni' if model_kind == 'vision' else 'vllm_omni_segmentation')
    mask = BytesIO()
    matte = Image.new('L', (64, 48), 0)
    matte.paste(255, (10, 8, 30, 32))
    matte.save(mask, 'PNG')
    calls = []
    async def segment(self, config, request):
        calls.append(request)
        return [Segment(mask.getvalue(), (10, 8, 30, 32), .9)]
    monkeypatch.setattr(VllmOmniSegmentation, 'segment', segment)
    prefix = '/api/creation'
    headers = {'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': session}
    before = set(assets._records(None, project_id))
    with TestClient(create_app(store), headers=headers) as client:
        path = f'{prefix}/projects/{project_id}/image-selections'
        value = dict(sourceAssetId=source['id'], boxes=[dict(x=8, y=6, width=26, height=30)])
        response = client.post(path, json=value)
        assert response.status_code == 200, response.text
        result = response.json()
        assert result['sourceAssetId'] == source['id']
        decoded = Image.open(BytesIO(base64.b64decode(result['instances'][0]['maskDataUrl'].split(',')[1])))
        assert decoded.mode == 'RGBA'
        assert decoded.getpixel((0, 0))[3] == 0 and decoded.getpixel((15, 15))[3] == 255
        assert client.post(path, json=value, headers={'X-OpenDirector-Session': str(uuid4())}).status_code == 409
        assert client.post(path, json={**value, 'sourceAssetId': str(uuid4())}).status_code == 409
    assert len(calls) == 1
    assert factory().list(project_id) == []
    assert set(assets._records(None, project_id)) == before
    assert not (store.root / 'Tool history' / 'assets.json').exists()


def test_selection_cancellation_releases_upstream_and_creates_no_task(tool_project):
    import httpx
    store, projects, assets, project_id, session, source, _, _ = tool_project
    configs = ModelConfigs(store.repository)
    configs.save('vision', 'http://fixture.invalid/v1', 'facebook/sam3', '', connection_type='self_hosted', protocol='vllm_omni')
    async def run():
        entered, cancelled = asyncio.Event(), asyncio.Event()
        async def remote(_):
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                raise
        service = ToolTasks(store, configs, assets, projects=projects, transport=httpx.MockTransport(remote))
        try:
            pending = asyncio.create_task(service.selection_preview(project_id, dict(sourceAssetId=source['id'], boxes=[dict(x=8, y=6, width=26, height=30)]), session))
            await asyncio.wait_for(entered.wait(), 2)
            pending.cancel()
            with pytest.raises(asyncio.CancelledError):
                await pending
            assert cancelled.is_set()
            assert service.list(project_id) == []
        finally:
            await service.close()
    asyncio.run(run())


def test_tool_idempotency_includes_annotation_and_model_inputs(tool_project):
    store, _, assets, project_id, session, _, value, factory = tool_project
    configs = ModelConfigs(store.repository)
    first = configs.save('image', 'http://fixture.invalid/v1', 'Qwen/Qwen-Image-2.1', '', connection_type='self_hosted', protocol='openai')
    second = configs.save('image', 'http://other.invalid/v1', 'Qwen/Qwen-Image-2.1', '', connection_type='self_hosted', protocol='openai')
    annotation = assets.import_file(project_id, str(uuid4()), 'annotation.png', png(), session)
    other = assets.import_file(project_id, str(uuid4()), 'other-annotation.png', png(), session)
    value = {**value, 'tool': 'smart-edit', 'parameters': {'prompt': 'Edit'},
             'annotationAssetId': annotation['id'], 'modelConfigIds': {'image.edit': first['id']}}
    service = factory()
    accepted, _, _ = service._prepare(project_id, value, session)
    assert accepted['annotationAssetId'] == annotation['id']
    for change in ({'annotationAssetId': other['id']}, {'modelConfigIds': {'image.edit': second['id']}}):
        with pytest.raises(ProjectError, match='标识已使用'):
            service._prepare(project_id, {**value, **change}, session)
    configs.delete(first['id'])
    replay, _, records = service._prepare(project_id, value, session)
    assert replay == accepted and records is None  # An accepted request survives configuration changes.


def test_selection_disconnect_cancels_through_request_middleware(tool_project, monkeypatch):
    import json
    from opendirector.integrations.model_adapters import VllmOmniSegmentation
    store, projects, _, project_id, session, source, _, factory = tool_project
    configs = ModelConfigs(store.repository)
    configs.save('vision', 'http://fixture.invalid/v1', 'facebook/sam3', '', connection_type='self_hosted', protocol='vllm_omni')

    async def run():
        entered, cancelled = asyncio.Event(), asyncio.Event()
        async def segment(*_):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        monkeypatch.setattr(VllmOmniSegmentation, 'segment', segment)
        prefix = '/api/creation'
        path = f'{prefix}/projects/{project_id}/image-selections'
        body = json.dumps(dict(sourceAssetId=source['id'], boxes=[dict(x=8, y=6, width=26, height=30)])).encode()
        sent = False
        async def receive():
            nonlocal sent
            if not sent:
                sent = True
                return {'type': 'http.request', 'body': body, 'more_body': False}
            await entered.wait()
            return {'type': 'http.disconnect'}
        async def send(_):
            pass
        scope = dict(type='http', asgi={'version': '3.0'}, http_version='1.1', method='POST',
                     scheme='http', path=path, raw_path=path.encode(), query_string=b'',
                     server=('testserver', 80), client=('127.0.0.1', 12345),
                     headers=[(b'host', b'testserver'), (b'content-type', b'application/json'),
                              (b'x-opendirector-request', b'1'), (b'x-opendirector-session', session.encode())])
        app = create_app(store)
        async with app.router.lifespan_context(app):
            await asyncio.wait_for(app(scope, receive, send), 2)
        assert cancelled.is_set()
        assert factory().list(project_id) == []
    asyncio.run(run())
