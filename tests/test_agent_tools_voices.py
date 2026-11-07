import asyncio
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest

from opendirector.agent.tools import AgentTools, tools


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
