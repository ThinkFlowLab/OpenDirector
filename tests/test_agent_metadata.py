"""CI gate for discoverable tool and command descriptions."""
import json
from uuid import uuid4

from pydantic import Field, JsonValue, create_model
import pytest

from opendirector.agent.tools import AgentTools, COMMANDS, tool_schema, tools
from opendirector.domain.creation.base import Contract
from opendirector.domain.creation.commands import COMMAND_MODELS
from opendirector.domain.creation.schema import CreationContracts
from opendirector.infrastructure.model_configs import ModelConfigs


def test_all_registered_commands_have_explicit_metadata():
    for name, model in COMMAND_MODELS.items():
        description = model.__dict__.get('__doc__')
        assert description and description.strip(), name
        assert model.model_json_schema()['description'] == description, name
    assert set(COMMANDS) <= set(COMMAND_MODELS)


def test_compact_discovery_preserves_detailed_write_constraints():
    for model in COMMANDS.values():
        assert len(model.__doc__) <= 120
    references = COMMAND_MODELS['canvas.createGeneration'].model_fields['payload'].annotation.model_fields['references']
    assert 'sourceVersion for pinned' in references.description
    assert 'Never replace a canvas reference with an asset-only binding' in references.description
    spec = COMMAND_MODELS['generationSpec.update'].model_fields['payload'].annotation.model_fields['spec']
    assert 'preserve unedited fields' in spec.description
    assert 'current expected version' in spec.description
    assert 'Accepted job snapshots never change' in spec.description


def test_all_exposed_tools_have_metadata():
    for tool in tools():
        function = tool['function']
        assert function['description'].strip(), function['name']


@pytest.mark.parametrize('description', ['', ' \n\t'])
def test_tool_registration_rejects_empty_metadata(description):
    with pytest.raises(AssertionError, match='Missing tool metadata: example'):
        tool_schema('example', description, {'type': 'object'})


def test_contract_class_rejects_an_undocumented_field():
    with pytest.raises(TypeError, match='Missing field metadata: Undocumented.value'):
        class Undocumented(Contract):
            value: str


@pytest.mark.parametrize('description', [None, '', ' \n\t'])
def test_contract_definition_rejects_missing_field_metadata(description):
    with pytest.raises(TypeError, match='Missing field metadata: Undocumented.value'):
        create_model('Undocumented', __base__=Contract,
            value=(str, Field(description=description)))


def test_contract_metadata_survives_inheritance_and_rejects_undocumented_overrides():
    parent = create_model('Documented', __base__=Contract,
        value=(int, Field(default=1, description='Current value.')))
    child = create_model('Inherited', __base__=parent)
    assert child.model_json_schema()['properties']['value']['description'] == 'Current value.'
    assert child().model_dump() == {'value': 1}
    with pytest.raises(TypeError, match='Missing field metadata: Override.value'):
        create_model('Override', __base__=parent, value=(int, 2))


def test_exported_contract_fields_have_metadata():
    for mode in ('validation', 'serialization'):
        schema = CreationContracts.model_json_schema(mode=mode)
        for name, definition in {'CreationContracts': schema, **schema['$defs']}.items():
            for field, value in definition.get('properties', {}).items():
                assert value.get('description', '').strip(), f'{name}.{field}'


@pytest.mark.anyio
async def test_model_schema_exposes_supported_video_inputs_without_changing_contract(tmp_path):
    configs = ModelConfigs(tmp_path)
    config = configs.save('video', 'http://fixture.invalid/v1', 'FastVideo-FastH3-Omni-8-Step-V1', '',
        connection_type='self_hosted', protocol='vllm_omni', auth_mode='none', video_adapter='fasth3')
    business = AgentTools(None, None, configs)
    async def schema(arguments):
        return await business.execute(uuid4(), uuid4(), '', 'schema', 'command_schema', arguments, [], None)
    async def parameters(**options):
        return await schema({'type': 'canvas.createGeneration', **options})

    example = (await parameters(modelConfigId=config['id']))['example']
    assert example['payload']['spec']['kind'] == 'video'
    assert example['payload']['spec']['parameters']['videoMode'] == 'reference'
    spec = await parameters(path='payload.spec', modelConfigId=config['id'])
    assert 'parameters' in spec['required']
    compact = await parameters(path='payload.spec.parameters', modelConfigId=config['id'])
    assert compact['fields']['videoMode']['enum'] == ['reference']
    assert 'default' not in compact['fields']['videoMode']
    assert 'videoMode' in compact['required']
    assert compact['fields']['generateAudio']['enum'] == [True]
    full = await parameters(path='payload.spec@video.parameters')
    assert full['fields']['videoMode']['default'] == 'first_frame'


@pytest.mark.anyio
async def test_command_help_expands_canvas_fields_on_demand():
    business = AgentTools(None, None, None)

    async def help_at(path=''):
        return await business.execute(uuid4(), uuid4(), '', 'help', 'command_schema',
                                      {'type': 'canvas.show', 'path': path}, [], None)

    root = await help_at()
    assert set(root) == {'command', 'description', 'example', 'fields'}
    assert root['fields']['payload']['path'] == 'payload'
    payload = await help_at('payload')
    assert payload['required'] == ['item']
    image = await help_at(payload['fields']['item']['branches']['image']['path'])
    assert image['fields']['width']['type'] == 'number'
    position = await help_at(image['fields']['position']['path'])
    assert position['fields']['x']['type'] == 'number'
    binding = await help_at('payload.item@image.binding')
    material = binding['branches']['material']
    assert material['description'] == 'Displays a registered project asset through objectRef.'
    assert material['required'] == ['role', 'objectRef']
    asset = await help_at(material['path'] + '.objectRef')
    assert asset['fields']['revision']['type'] == 'integer'
    for result in (root, payload, image, position, asset):
        assert len(json.dumps(result)) < 4096

@pytest.mark.anyio
async def test_command_help_examples_validate_for_all_exposed_commands():
    business = AgentTools(None, None, None)
    project_id = uuid4()
    for name, model in COMMANDS.items():
        help_result = await business.execute(project_id, uuid4(), '', 'help', 'command_schema',
                                             {'type': name}, [], None)
        model.model_validate({**help_result['example'], 'projectId': project_id, 'commandId': uuid4()})
