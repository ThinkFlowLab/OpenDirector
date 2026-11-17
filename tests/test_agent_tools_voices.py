import asyncio
import os
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest

from opendirector.agent.tools import AgentTools, tools
from opendirector.domain.projects import ProjectError


def test_voice_list_exposes_page_options():
    function = next(tool['function'] for tool in tools() if tool['function']['name'] == 'voice_list')
    parameters = function['parameters']
    assert parameters['required'] == ['modelConfigId']
    properties = parameters['properties']
    assert properties['pageSize']['minimum'] == 1
    assert properties['pageSize']['maximum'] == 150
    assert properties['after']['type'] == 'string'
    assert properties['connectionId']['type'] == 'string'


@pytest.mark.parametrize('options', [
    {},
    {'pageSize': 150},
    {'pageSize': 32, 'after': 'opaque+/=', 'connectionId': 'scope-a'},
])
def test_voice_list_uses_shared_registry_pagination(options):
    registry = Mock()
    registry.list.return_value = {'voices': [], 'connectionId': 'scope-a', 'nextCursor': 'next'}
    business = AgentTools(None, SimpleNamespace(voices=registry), None)
    model = str(uuid4())
    page = asyncio.run(business.execute(uuid4(), uuid4(), 'session', 'call', 'voice_list',
                                        {'modelConfigId': model, **options}, [], None))
    registry.list.assert_called_once_with(model, page_size=options.get('pageSize'),
                                          after=options.get('after'), connection_id=options.get('connectionId'))
    assert page == registry.list.return_value


def create_voice(business, work, path):
    return asyncio.run(business.execute(uuid4(), uuid4(), 'session', 'call', 'voice_create',
        {'modelConfigId': str(uuid4()), 'connectionId': 'scope-a', 'name': 'Voice',
         'path': str(path), 'consent': 'consent-recording-id'}, [], None, execution_directory=work))


def voice_business():
    registry = Mock()
    registry._config.return_value = (None, {'maxBytes': 100})
    registry.create.return_value = {'id': 'created'}
    return AgentTools(None, SimpleNamespace(voices=registry), None), registry


@pytest.mark.parametrize('absolute', [False, True])
def test_voice_create_reads_execution_recording(tmp_path, absolute):
    business, registry = voice_business()
    recording = tmp_path / 'recording.wav'
    recording.write_bytes(b'recording')
    assert create_voice(business, tmp_path, recording if absolute else recording.name) == {'id': 'created'}
    assert registry.create.call_args.args[1] == b'recording'
    assert registry.create.call_args.kwargs['filename'] == 'recording.wav'


@pytest.mark.parametrize('component', ['work', 'turn'])
def test_voice_create_rejects_redirected_execution_root(tmp_path, component):
    from process_helpers import directory_link
    business, registry = voice_business()
    work = tmp_path / 'turn/work'
    work.mkdir(parents=True)
    anchor = work if component == 'work' else work.parent
    outside = tmp_path / 'outside'
    target = outside / work.relative_to(anchor)
    target.mkdir(parents=True)
    (target / 'recording.wav').write_bytes(b'private outside recording')
    anchor.rename(anchor.with_name(anchor.name + '-original'))
    directory_link(anchor, outside)
    try:
        with pytest.raises((OSError, ProjectError)):
            create_voice(business, work, work / 'recording.wav')
        registry.create.assert_not_called()
    finally:
        anchor.rmdir() if os.name == 'nt' else anchor.unlink()


def test_voice_create_rejects_hardlink(tmp_path):
    business, registry = voice_business()
    work = tmp_path / 'work'
    work.mkdir()
    outside = tmp_path / 'private.wav'
    outside.write_bytes(b'private recording')
    os.link(outside, work / 'recording.wav')
    with pytest.raises((OSError, ProjectError)):
        create_voice(business, work, work / 'recording.wav')
    registry.create.assert_not_called()
