from legacy_fixtures import legacy_project
from uuid import uuid4
import shutil

from fastapi.testclient import TestClient
import pytest

from opendirector.infrastructure import creation_projects
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector_api.main import create_app


@pytest.fixture
def api(tmp_path):
    local = LocalProjects(tmp_path)
    headers = {'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': str(uuid4())}
    with TestClient(create_app(local), headers=headers) as client:
        yield client, local


def create(client, name='New project'):
    project_id, command_id = str(uuid4()), str(uuid4())
    command = dict(type='project.create', commandId=command_id, projectId=project_id, payload=dict(name=name))
    path = f'/api/creation/projects/{project_id}'
    response = client.post(path + '/commands', json=command)
    assert response.status_code == 200, response.text
    assert response.json()['status'] == 'applied'
    return path, command, response.json()


def rename(command, name='Renamed', revision=1):
    return dict(type='project.rename', commandId=str(uuid4()), projectId=command['projectId'],
                payload=dict(name=name), expectedVersions=[dict(objectType='project', id=command['projectId'], revision=revision)])


def test_create_open_release_rename_and_reopen_via_typed_commands(api):
    client, local = api
    path, command, created = create(client)
    value = client.post(path + '/open').json()
    assert value['format'] == 'opendirector-project' and value['formatVersion'] == 2
    assert value['project']['name'] == 'New project'
    session = client.headers['x-opendirector-session']
    assert client.put('/api/creation/sessions/' + session, json={'projectId': command['projectId']}).status_code == 200
    change = rename(command)
    assert client.post(path + '/commands', json=change).status_code == 409
    assert client.delete('/api/creation/sessions/' + session).status_code == 200
    response = client.post(path + '/commands', json=change)
    assert response.status_code == 200 and response.json()['status'] == 'applied'
    assert client.post(path + '/commands', json=change).json() == response.json()
    assert client.post(path + '/commands', json=command).json() == created
    assert client.get(path + '/receipts/' + command['commandId']).json() == created
    assert client.post(path + '/open').json()['project']['revision'] == 2
    events = client.get(path + '/changes', params={'after': 1}).json()
    assert [event['commandId'] for event in events['events']] == [change['commandId']]
    assert events['nextCursor'] == events['currentCursor'] == 2
    assert client.get('/api/creation/projects').json()['projects'][0]['name'] == 'Renamed'
    assert client.get('/api/projects').status_code == 404


def test_conflicting_command_id_and_stale_version_have_distinct_outcomes(api):
    client, _ = api
    path, command, created = create(client)
    forged = {**command, 'payload': dict(name='Changed input')}
    response = client.post(path + '/commands', json=forged)
    assert response.status_code == 409 and response.json()['code'] == 'command_conflict'
    assert client.post(path + '/commands', json=command).json() == created
    stale = rename(command, revision=9)
    receipt = client.post(path + '/commands', json=stale).json()
    assert receipt['status'] == 'rejected' and receipt['issues'][0]['code'] == 'revision_conflict'
    assert client.get(path + '/receipts/' + stale['commandId']).json() == receipt
    assert len(client.get(path + '/changes').json()['events']) == 1
    assert client.get(path).json()['project']['revision'] == 1


def test_api_exposes_only_implemented_commands_and_never_accepts_snapshot_replacement(api):
    client, _ = api
    path, command, _ = create(client)
    unsupported = dict(type='project.restore', commandId=str(uuid4()), projectId=command['projectId'], payload={},
        expectedVersions=[dict(objectType='project', id=command['projectId'], revision=1)])
    response = client.post(path + '/commands', json=unsupported)
    assert response.status_code == 501 and response.json()['code'] == 'capability_unsupported'
    assert client.get(path + '/receipts/' + unsupported['commandId']).status_code == 404
    forged = {**rename(command), 'apiKey': 'private-test-key'}
    response = client.post(path + '/commands', json=forged)
    assert response.status_code == 422 and 'private-test-key' not in response.text
    assert client.put(path, json=client.get(path).json()).status_code == 405
    wrong_project = f'/api/creation/projects/{uuid4()}/commands'
    assert client.post(wrong_project, json=command).status_code == 400
    assert len(client.get(path + '/changes').json()['events']) == 1


def test_storage_reports_how_a_deleted_project_leaves_the_disk(api):
    client, _ = api
    response = client.get('/api/creation/storage')
    assert response.status_code == 200
    assert set(response.json()) == {'projectDelete'}
    assert response.json()['projectDelete'] in {'recycle_bin', 'permanent'}


def test_lock_timeout_has_a_retryable_code_without_hiding_other_conflicts(api, monkeypatch):
    from filelock import FileLock
    client, local = api
    path = local.state_dir / 'catalog.lock'
    monkeypatch.setattr(local, 'lock', FileLock(path, timeout=.05))
    with FileLock(path):
        response = client.get('/api/creation/projects')
    assert response.status_code == 409
    assert response.json()['code'] == 'storage_busy'
    assert response.headers['retry-after'] == '1'
    assert client.get('/api/creation/projects').status_code == 200


def test_unknown_and_legacy_projects_are_not_reinitialized(api):
    client, local = api
    legacy = legacy_project(local)
    response = client.get('/api/creation/projects/' + legacy['id'])
    assert response.status_code == 409 and response.json()['code'] == 'unsupported_format'
    assert client.get(f'/api/creation/projects/{uuid4()}').status_code == 404
    assert client.get('/api/creation/projects').json()['projects'] == []
    assert client.get('/api/projects').status_code == 404


def test_cleanup_api_removes_unreadable_projects_only(api, monkeypatch):
    client, local = api
    monkeypatch.setattr(creation_projects.recycle, 'remove',
                        lambda path, *, recoverable: shutil.rmtree(path))
    path, _, _ = create(client, 'Readable')
    legacy_project(local)
    listing = client.get('/api/creation/projects').json()
    assert [item['name'] for item in listing['projects']] == ['Readable']
    assert [item['name'] for item in listing['unreadable']] == ['Legacy']

    response = client.post('/api/creation/projects/cleanup')
    assert response.status_code == 200, response.text
    assert response.json() == dict(removed=['Legacy'], failed=[])
    assert client.get(path).json()['project']['name'] == 'Readable'
    assert client.get('/api/creation/projects').json()['unreadable'] == []
    assert client.post('/api/creation/projects/cleanup').json() == dict(removed=[], failed=[])


def test_views_queries_and_revision_scoped_history_do_not_replace_business_state(api):
    client, _ = api
    path, created, _ = create(client)
    assert client.post(path + '/open').status_code == 200
    item_id = str(uuid4())
    add = dict(commandId=str(uuid4()), projectId=created['projectId'], type='canvas.show',
        payload=dict(item=dict(id=item_id, projectId=created['projectId'], kind='text', title='Original', binding=dict(role='empty'))))
    assert client.post(path + '/commands', json=add).json()['status'] == 'applied'
    update = dict(commandId=str(uuid4()), projectId=created['projectId'], type='canvas.update',
        expectedVersions=[dict(objectType='canvas_item', id=item_id, revision=1)], payload=dict(itemId=item_id, title='Changed'))
    assert client.post(path + '/commands', json=update).json()['status'] == 'applied'
    query = dict(queryId=str(uuid4()), projectId=created['projectId'], type='object.get', objectId=item_id, revision=1)
    assert client.post(path + '/queries', json=query).json()['title'] == 'Original'
    assert client.post(path + '/queries', json={**query, 'revision': 2}).json()['title'] == 'Changed'
    projection = client.get(path + '/canvas').json()
    assert projection['visibleItemIds'] == [item_id]
    assert projection['capabilities'][item_id]['canEdit']
    cursor = projection['snapshot']['eventCursor']
    view_id = str(uuid4())
    view = dict(projectId=created['projectId'], clientId=view_id, viewport=dict(x=50, y=75, zoom=1.5), selectedItemIds=[item_id])
    assert client.get(path + '/views/' + view_id).status_code == 204
    assert client.put(path + '/views/' + view_id, json=view).status_code == 200
    assert client.get(path + '/views/' + view_id).json()['viewport'] == view['viewport']
    assert client.get(path).json()['eventCursor'] == cursor
    assert client.get(path + '/subscribe', params={'after': cursor + 100}).status_code == 409
    # Background checkpoint payloads cannot be used as an arbitrary object write.
    from test_creation_contracts import project_example
    forged = dict(commandId=str(uuid4()), projectId=created['projectId'], type='job.checkpoint',
                  payload=dict(job=project_example().jobs[0].model_dump(mode='json')))
    assert client.post(path + '/commands', json=forged).status_code == 403


def test_disk_failure_has_no_premature_event_and_retry_recovers_same_receipt(api, monkeypatch):
    client, _ = api
    path, command, _ = create(client)
    change = rename(command)
    def checkpoint(self, stage):
        if stage == 'bundle_written':
            raise OSError('injected disk failure')
    monkeypatch.setattr(CreationProjects, '_checkpoint', checkpoint)
    assert client.post(path + '/commands', json=change).status_code == 503
    # Queries cannot fall back to the old snapshot while recovery fails.
    assert client.get(path).status_code == 409
    assert client.get(path + '/changes').status_code == 409
    monkeypatch.setattr(CreationProjects, '_checkpoint', lambda self, stage: None)
    receipt = client.post(path + '/commands', json=change).json()
    assert receipt['status'] == 'applied' and receipt['eventCursor'] == 2
    assert client.get(path + '/receipts/' + change['commandId']).json() == receipt
    events = client.get(path + '/changes').json()['events']
    assert [event['cursor'] for event in events] == [1, 2]


def test_new_routes_keep_existing_local_request_protection(api):
    client, _ = api
    assert client.get('/api/creation/projects', headers={'Origin': 'https://untrusted.example'}).status_code == 403
    assert client.get('/api/creation/projects', headers={'X-OpenDirector-Request': ''}).status_code == 403


def test_app_assembly_recovers_a_previously_interrupted_commit(tmp_path):
    from opendirector.domain.creation.commands import parse_command
    local = LocalProjects(tmp_path)
    storage = CreationProjects(local)
    project_id = str(uuid4())
    command = parse_command(dict(type='project.create', projectId=project_id, commandId=str(uuid4()), payload=dict(name='Recovered')))
    def crash(stage):
        if stage == 'directory_ready':
            raise OSError('simulated shutdown')
    storage._checkpoint = crash
    with pytest.raises(OSError):
        storage.execute(command)
    app = create_app(LocalProjects(tmp_path))
    assert (tmp_path / 'projects/Recovered/project.json').is_file()
    with TestClient(app, headers={'X-OpenDirector-Request': '1'}) as client:
        path = '/api/creation/projects/' + project_id
        assert client.get(path).json()['project']['name'] == 'Recovered'
        assert client.get(path + '/receipts/' + str(command.commandId)).json()['status'] == 'applied'


def test_asset_list_accepts_visibility_filter_and_rejects_usage_values_in_its_place(api):
    client, _ = api
    path, command, _ = create(client)
    assert client.post(path + '/open').status_code == 200
    write = dict(type='asset.writeText', commandId=str(uuid4()), projectId=command['projectId'],
                 payload=dict(name='Unplaced.md', text='Unplaced'))
    assert client.post(path + '/commands', json=write).json()['status'] == 'applied'
    assert client.get(path + '/asset-list', params={'visibility': 'all'}).json()['total'] == 1
    assert client.get(path + '/asset-list', params={'visibility': 'hidden'}).json()['total'] == 1
    assert client.get(path + '/asset-list', params={'visibility': 'visible'}).json()['total'] == 0
    assert client.get(path + '/asset-list', params={'visibility': 'used'}).status_code == 422
    assert client.get(path + '/asset-list', params={'category': 'text'}).json()['counts']['text'] == 1
    assert client.get(path + '/asset-list', params={'category': 'image'}).json()['total'] == 0
    assert client.get(path + '/asset-list', params={'category': 'other'}).status_code == 422


def test_open_canvas_returns_one_snapshot_with_authoritative_reference_edges(api, monkeypatch):
    client, _ = api
    path, created, _ = create(client)
    project_id = created['projectId']
    assert client.post(path + '/open').status_code == 200
    source_spec, source_item = str(uuid4()), str(uuid4())
    target_spec, target_item = str(uuid4()), str(uuid4())
    write = dict(commandId=str(uuid4()), projectId=project_id, type='asset.writeText',
                 payload=dict(name='Source.md', text='v1'))
    assert client.post(path + '/commands', json=write).json()['status'] == 'applied'
    batch = dict(commandId=str(uuid4()), projectId=project_id, type='creation.batch', payload=dict(operations=[
        dict(type='generationSpec.create', payload=dict(
            spec=dict(id=source_spec, projectId=project_id, kind='text', purpose='draft'))),
        dict(type='canvas.show', payload=dict(item=dict(
            id=source_item, projectId=project_id, kind='text', title='Source',
            binding=dict(role='empty', draftSpec=dict(id=source_spec))))),
        dict(type='generationSpec.create', payload=dict(
            spec=dict(id=target_spec, projectId=project_id, kind='text', purpose='draft'))),
        dict(type='canvas.show', payload=dict(item=dict(
            id=target_item, projectId=project_id, kind='text', title='Target',
            binding=dict(role='empty', draftSpec=dict(id=target_spec))))),
    ]))
    response = client.post(path + '/commands', json=batch)
    assert response.status_code == 200 and response.json()['status'] == 'applied', response.text
    asset = client.get(path).json()['assets'][0]
    materialize = dict(commandId=str(uuid4()), projectId=project_id, type='canvas.materialize',
                       payload=dict(itemId=source_item, asset=dict(
                           assetId=asset['id'], revision=asset['revision'],
                           fingerprint=asset['fingerprint'], kind=asset['kind'])),
                       expectedVersions=[dict(objectType='canvas_item', id=source_item, revision=1)])
    assert client.post(path + '/commands', json=materialize).json()['status'] == 'applied'
    reference = dict(id=str(uuid4()), projectId=project_id, targetSpecId=target_spec,
                     binding='follow_current', source=dict(id=source_item))
    add = dict(commandId=str(uuid4()), projectId=project_id, type='reference.add',
               payload=dict(reference=reference),
               expectedVersions=[dict(objectType='generation_spec', id=target_spec, revision=1),
                                 dict(objectType='canvas_item', id=target_item, revision=1)])
    assert client.post(path + '/commands', json=add).json()['status'] == 'applied'

    # The route must read the project exactly once: one projects.open() snapshot
    # serves the canvas and its edges, with no extra snapshot() call.
    opens, snapshots = [], []
    original_open, original_snapshot = CreationProjects.open, CreationProjects.snapshot
    def counting_open(self, project_id_value, session):
        opens.append(str(project_id_value))
        return original_open(self, project_id_value, session)
    def counting_snapshot(self, project_id_value):
        snapshots.append(str(project_id_value))
        return original_snapshot(self, project_id_value)
    monkeypatch.setattr(CreationProjects, 'open', counting_open)
    monkeypatch.setattr(CreationProjects, 'snapshot', counting_snapshot)
    opened = client.post(path + '/open-canvas')
    assert opened.status_code == 200, opened.text
    assert opens == [project_id] and snapshots == []
    body = opened.json()
    assert body['snapshot']['format'] == 'opendirector-project'
    # The one snapshot drives both the canvas and its edges; GET /canvas is the
    # authority the previous client round trip used to fetch separately.
    projection = client.get(path + '/canvas').json()
    assert body['snapshot'] == projection['snapshot']
    assert body['edges'] == projection['edges']
    assert body['edges'] == [dict(referenceId=reference['id'], sourceItemId=source_item,
                                  targetSpecId=target_spec, state='pending')]
    # The no-flag open keeps its established bare snapshot response.
    plain = client.post(path + '/open').json()
    assert plain == body['snapshot']
    assert 'edges' not in plain
    assert client.post(path + '/open-canvas',
                       headers={'x-opendirector-session': ''}).status_code == 422
