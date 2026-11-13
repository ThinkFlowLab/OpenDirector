"""Retained editing sessions obey project scope, expiry and cancellation."""
import asyncio
import threading
from uuid import uuid4

import pytest

from opendirector.domain.creation.commands import parse_command
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector_api.agent import agent_session


@pytest.fixture
def anyio_backend():
    return 'asyncio'


@pytest.fixture
def project(tmp_path):
    projects = CreationProjects(LocalProjects(tmp_path))
    pid, owner = uuid4(), str(uuid4())
    projects.execute(parse_command({'type': 'project.create', 'projectId': pid,
        'commandId': uuid4(), 'payload': {'name': 'Retained session'}}))
    projects.open(pid, owner)
    return projects, pid, owner


def test_retaining_requires_a_current_authorized_ui_session(project):
    projects, pid, owner = project
    with projects.local.transaction() as db:
        db.execute('UPDATE sessions SET expires=0 WHERE id=?', (owner,))
    with pytest.raises(ProjectError, match='会话已过期'):
        projects.retain_agent_session(pid, owner, str(uuid4()))
    with projects.local.transaction() as db:
        assert db.execute('SELECT id FROM agent_sessions').fetchall() == []


def test_renewal_cannot_change_project_or_reacquire_an_expired_lease(project):
    projects, pid, owner = project
    session = str(uuid4())
    projects.retain_agent_session(pid, owner, session)
    other = uuid4()
    projects.execute(parse_command({'type': 'project.create', 'projectId': other,
        'commandId': uuid4(), 'payload': {'name': 'Other project'}}))
    with pytest.raises(ProjectError, match='会话已过期'):
        projects.renew_agent_session(other, session)
    with projects.local.transaction() as db:
        db.execute('UPDATE sessions SET expires=0 WHERE id=?', (session,))
    projects.local.release(owner)
    replacement = str(uuid4())
    projects.open(pid, replacement)
    with pytest.raises(ProjectError, match='会话已过期'):
        projects.renew_agent_session(pid, session)
    # Expired run records are recoverable coordination state, not project data.
    restarted = CreationProjects(LocalProjects(projects.local.repository))
    with restarted.local.transaction() as db:
        assert db.execute('SELECT id FROM agent_sessions').fetchall() == []
        assert [row['id'] for row in db.execute('SELECT id FROM sessions')] == [replacement]


@pytest.mark.anyio
async def test_cancellation_during_acquisition_waits_for_the_worker_then_releases(project, monkeypatch):
    projects, pid, owner = project
    entered, release = threading.Event(), threading.Event()
    retain = projects.retain_agent_session
    def delayed(*args):
        entered.set()
        assert release.wait(5)
        retain(*args)
    monkeypatch.setattr(projects, 'retain_agent_session', delayed)
    async def run():
        async with agent_session(projects, pid, owner):
            pytest.fail('Cancelled acquisition must not start a runtime')
    pending = asyncio.create_task(run())
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        pending.cancel()
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(pending, 5)
    with projects.local.transaction() as db:
        assert db.execute('SELECT id FROM agent_sessions').fetchall() == []
        assert [row['id'] for row in db.execute('SELECT id FROM sessions')] == [owner]
