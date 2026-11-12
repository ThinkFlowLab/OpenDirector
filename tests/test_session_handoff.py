"""Real catalog transactions for reload handoff and delayed lifecycle requests."""
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from opendirector.domain.creation.commands import parse_command
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector_api.main import create_app


@pytest.fixture
def projects(tmp_path):
    store = CreationProjects(LocalProjects(tmp_path))
    ids = [uuid4(), uuid4()]
    for index, project_id in enumerate(ids):
        assert store.execute(parse_command(dict(commandId=uuid4(), projectId=project_id,
            type='project.create', payload=dict(name=f'Project {index}')))).status == 'applied'
    return store, ids, str(uuid4())


def rejects(code, operation):
    with pytest.raises(ProjectError) as error:
        operation()
    assert error.value.code == code


def test_reload_replaces_lingering_lease_and_fences_old_requests(projects):
    store, (project, other), owner = projects
    store.open(project, owner, 1)
    store.open(project, owner, 2)  # No unload release arrived.
    store.local.release(owner, 1)  # Old release arrives after the new open.
    rejects('session_stale', lambda: store.heartbeat(owner, project, 1))
    rejects('session_stale', lambda: store.open(other, owner, 1))
    rejects('session_stale', lambda: store.open(other, owner, 2))
    rejects('storage_busy', lambda: store.open(project, str(uuid4()), 100))
    store.heartbeat(owner, project, 2)
    store.open(project, owner, 2)  # Same acquisition replay is idempotent.


def test_release_fences_pending_acquisition_and_heartbeat(projects):
    store, (project, other), owner = projects
    store.open(project, owner, 1)
    store.local.release(owner, 2)  # Page exits before its second open arrives.
    rejects('session_stale', lambda: store.open(other, owner, 2))
    rejects('session_stale', lambda: store.heartbeat(owner, project, 1))
    store.open(project, owner, 3)
    store.local.release(owner, 2)
    store.heartbeat(owner, project, 3)
    store.local.release(owner, 3)
    store.local.release(owner, 3)
    rejects('session_stale', lambda: store.heartbeat(owner, project, 3))
    store.open(other, owner, 4)  # Explicit navigation remains possible.


def test_expiry_and_restart_preserve_fences_and_other_window_protection(projects):
    store, (project, _), owner = projects
    store.open(project, owner, 1)
    with store.local.transaction() as db:
        db.execute('UPDATE sessions SET expires=0')
    store.heartbeat(owner, project, 1)  # A sleeping page can renew an unclaimed lease.
    with store.local.transaction() as db:
        db.execute('UPDATE sessions SET expires=0')
    restarted = CreationProjects(LocalProjects(store.local.repository))
    rejects('session_not_open', lambda: restarted.heartbeat(owner, project, 1))
    newer_owner = str(uuid4())
    restarted.open(project, newer_owner, 1)
    rejects('storage_busy', lambda: restarted.open(project, owner, 2))
    restarted.local.release(newer_owner, 1)
    restarted.open(project, owner, 2)
    rejects('session_stale', lambda: restarted.open(project, owner, 1))


def test_legacy_callers_must_explicitly_reopen_after_release(projects):
    store, (project, _), owner = projects
    store.open(project, owner)
    store.local.release(owner)
    rejects('session_not_open', lambda: store.heartbeat(owner, project))
    store.open(project, owner)
    store.open(project, owner, 1)
    store.local.release(owner)  # Unversioned cleanup cannot close a fenced owner.
    rejects('session_stale', lambda: store.heartbeat(owner, project))
    store.heartbeat(owner, project, 1)


@pytest.mark.parametrize('generation', [-1, 2 ** 31, True, '1'])
def test_invalid_generation_rejected_before_mutation(projects, generation):
    store, (project, _), owner = projects
    rejects('session_generation_invalid', lambda: store.open(project, owner, generation))
    rejects('session_generation_invalid', lambda: store.local.release(owner, generation))
    store.open(project, str(uuid4()), 1)


@pytest.mark.parametrize('locale, message', [('en-US', 'outdated editing session'), ('zh-CN', '编辑会话已过期')])
def test_http_handoff_and_localized_stale_error(projects, locale, message):
    store, (project, _), owner = projects
    with TestClient(create_app(store.local), headers={
        'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': owner,
        'Accept-Language': locale,
    }) as client:
        def headers(generation):
            return {'X-OpenDirector-Session-Generation': str(generation)}
        path = f'/api/creation/projects/{project}'
        session = f'/api/creation/sessions/{owner}'
        assert client.post(path + '/open', headers=headers(1)).status_code == 200
        assert client.post(path + '/open-canvas', headers=headers(2)).status_code == 200
        assert client.delete(session, headers=headers(1)).status_code == 200
        stale = client.put(session, json={'projectId': str(project)}, headers=headers(1))
        assert stale.status_code == 409 and stale.json()['code'] == 'session_stale'
        assert message in stale.json()['detail']
        assert client.put(session, json={'projectId': str(project)}, headers=headers(2)).status_code == 200
        assert client.post(path + '/open', headers=headers(-1)).status_code == 422
