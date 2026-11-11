"""Only an owned, existing turn directory may host a resumed native session."""
import json
from uuid import uuid4

import pytest

from opendirector.agent.context import RunContext
from process_helpers import directory_link


@pytest.mark.parametrize('location', ['valid', 'outside', 'invalid_turn', 'missing', 'alias', 'absent'])
def test_native_session_directory_requires_owned_turn_identity(tmp_path, location):
    run = RunContext(runtime='opencode', project_id=uuid4(), turn_id=uuid4(), session=str(uuid4()),
        conversation_id=uuid4(), directory=tmp_path / 'project', config=None,
        messages=[{'role': 'user', 'content': 'first'}], selected_skills=[])
    owned = run.directory / 'agent-runs' / str(uuid4()) / 'work'
    owned.mkdir(parents=True)
    candidate = owned
    if location == 'outside':
        candidate = tmp_path / 'outside' / 'agent-runs' / str(uuid4()) / 'work'
        candidate.mkdir(parents=True)
    elif location == 'invalid_turn':
        candidate = run.directory / 'agent-runs' / 'not-a-turn' / 'work'
        candidate.mkdir(parents=True)
    elif location == 'missing':
        candidate = run.directory / 'agent-runs' / str(uuid4()) / 'work'
    elif location == 'alias':
        candidate = run.directory / 'agent-runs' / str(uuid4()) / 'work'
        candidate.parent.mkdir()
        directory_link(candidate, owned)
    run.save_native_session('owned-session', {}, engine_directory=None if location == 'absent' else candidate)
    record = run.native_session_path() / 'session.json'
    before = record.read_bytes()
    assert run.native_session_directory() == (owned if location == 'valid' else None)
    assert record.read_bytes() == before
    assert json.loads(before)['sessionId'] == 'owned-session'
