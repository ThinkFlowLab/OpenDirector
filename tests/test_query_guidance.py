"""Issue #132: a rejected query must name the types and fields it actually accepts."""
from uuid import uuid4

import pytest
from pydantic import TypeAdapter, ValidationError

from opendirector.agent.tools import QUERY_TYPES, query_guidance, tools
from opendirector.domain.creation.commands import Query


def guidance(arguments):
    try:
        TypeAdapter(Query).validate_python({'projectId': uuid4(), 'queryId': uuid4(), **arguments})
    except ValidationError as failure:
        return query_guidance(failure)
    raise AssertionError('expected the query to be rejected')


def test_the_tool_description_lists_every_legal_type():
    tool = next(item['function'] for item in tools() if item['function']['name'] == 'query')
    for name in QUERY_TYPES:
        assert name in tool['description'], name
    # The type the assistant guessed in #132 is not one of them.
    assert 'canvas_items' not in QUERY_TYPES


def test_an_unknown_type_is_answered_with_the_closest_legal_one():
    message = guidance({'type': 'canvas_items'})
    assert 'canvas_items' in message
    assert 'canvas.status' in message  # the suggestion
    assert all(name in message for name in QUERY_TYPES)


def test_a_missing_field_is_named():
    message = guidance({'type': 'canvas.status'})
    assert 'objectId' in message

def test_an_unexpected_field_keeps_its_name():
    """Field-level detail must survive: test_agent_artifacts relies on it."""
    message = guidance({'type': 'object.get', 'objectId': str(uuid4()), 'waitSeconds': 1})
    assert 'waitSeconds' in message
