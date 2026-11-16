"""Canvas link resolution and persistence for assistant replies (#333, backend slice)."""
import json
from pathlib import Path
from types import SimpleNamespace as NS
from uuid import UUID, uuid4, uuid5

from fastapi.testclient import TestClient
import pytest

from opendirector.agent.canvas_links import (
    canvas_links_for_text,
    format_canvas_link,
    link_targets,
    resolve_canvas_link,
    with_canvas_links,
)
from opendirector.infrastructure.local_projects import LocalProjects
from opendirector_api.main import create_app
from opendirector_api import agent


def asset(asset_id, name, *, kind='text', run=None):
    return NS(id=asset_id, name=name, kind=kind, path=f'assets/{asset_id}',
              provenance=NS(source='generated', agentRunId=run))


def node(node_id, *, kind='text', title='', visible=True, asset_id=None,
         parent_id=None):
    binding = NS(role='material', objectRef=NS(assetId=asset_id)) if asset_id else NS(role='empty')
    return NS(id=node_id, kind=kind, title=title, visible=visible,
              parentId=parent_id, position=NS(x=0, y=0), binding=binding)


def snapshot(*, project_id=None, assets=(), nodes=()):
    return NS(project=NS(id=project_id or uuid4()), assets=tuple(assets), canvasItems=tuple(nodes))


def test_relative_link_uses_the_turn_provenance_and_never_picks_an_unrelated_duplicate():
    turn, other = uuid4(), uuid4()
    current = asset(uuid4(), 'notes.md', run=turn)
    unrelated = asset(uuid4(), 'notes.md', run=other)
    item = node(uuid4(), title='Finished note', asset_id=current.id)
    project = snapshot(assets=[current, unrelated], nodes=[item])

    resolved = resolve_canvas_link('notes.md', project, turn)
    assert resolved == {'target': 'notes.md', 'status': 'focused',
                        'nodeId': str(item.id), 'kind': 'text'}

    # Without the turn context, the duplicate filename is ambiguous instead of
    # silently selecting one of the two unrelated objects.
    assert resolve_canvas_link('notes.md', project)['status'] == 'ambiguous'


def test_missing_malformed_and_external_targets_are_typed_and_never_raise():
    project = snapshot()
    for target in ('', '   ', 'unknown.mp4', 'javascript:alert(1)',
                   'data:text/plain,hello', 'file:///etc/passwd',
                   '#section', '?query', '../../etc/passwd', 'canvas:not-a-uuid',
                   'project:not-a-uuid/canvas:also-bad', 'project:missing'):
        result = resolve_canvas_link(target, project)
        assert result['status'] in {'missing', 'external'}
        assert set(result) >= {'target', 'status'}
    assert resolve_canvas_link('https://example.test/a', project) == {
        'target': 'https://example.test/a', 'status': 'external'}
    assert link_targets('plain text without links') == []


def test_hidden_materialize_ambiguous_and_explicit_nodes():
    hidden = node(uuid4(), title='Old wording', visible=False)
    unplaced = asset(uuid4(), 'draft.md')
    shared = asset(uuid4(), 'shared.mp4', kind='video')
    first = node(uuid4(), kind='video', title='Take 1', asset_id=shared.id)
    second = node(uuid4(), kind='video', title='Take 2', asset_id=shared.id)
    project = snapshot(assets=[unplaced, shared], nodes=[hidden, first, second])

    revealed = resolve_canvas_link(f'canvas:{hidden.id}', project)
    assert revealed['status'] == 'hidden' and revealed['action'] == 'reveal'

    materialize = resolve_canvas_link('draft.md', project)
    assert materialize['status'] == 'materialize'
    assert materialize['assetId'] == str(unplaced.id)
    assert materialize['action'] == 'materialize'

    ambiguous = resolve_canvas_link('shared.mp4', project)
    assert ambiguous['status'] == 'ambiguous'
    assert {candidate['nodeId'] for candidate in ambiguous['candidates'] if 'nodeId' in candidate} == {
        str(first.id), str(second.id)}

    explicit = resolve_canvas_link(f'node:{first.id}', project)
    assert explicit['status'] == 'focused' and explicit['nodeId'] == str(first.id)
    assert resolve_canvas_link(f'canvas:{uuid4()}', project)['status'] == 'missing'


def test_cross_project_targets_report_the_destination_project():
    foreign_project = uuid4()
    item = node(uuid4())
    project = snapshot(nodes=[item])
    target = format_canvas_link(str(item.id), str(foreign_project))
    resolved = resolve_canvas_link(target, project)
    assert resolved['status'] == 'cross-project'
    assert resolved['projectId'] == str(foreign_project)
    assert resolved['nodeId'] == str(item.id)
    # A fully qualified link to this project resolves normally after reload.
    own = format_canvas_link(str(item.id), str(project.project.id))
    assert resolve_canvas_link(own, project)['status'] == 'focused'


@pytest.mark.parametrize('kind', ['text', 'image', 'video', 'audio', 'subject',
                                  'timeline', 'group', 'stack', 'tool', 'external'])
def test_explicit_identity_resolves_every_canvas_kind(kind):
    item = node(uuid4(), kind=kind, title='Item')
    project = snapshot(nodes=[item])
    resolved = resolve_canvas_link(f'canvas:{item.id}', project)
    assert resolved == {'target': f'canvas:{item.id}', 'status': 'focused',
                        'nodeId': str(item.id), 'kind': kind}


def test_title_matching_covers_non_media_nodes_and_keeps_duplicates_ambiguous():
    group = node(uuid4(), kind='group', title='Scene 1')
    text = node(uuid4(), kind='text', title='Finished note')
    duplicate_a = node(uuid4(), kind='text', title='Same title')
    duplicate_b = node(uuid4(), kind='text', title='Same title')
    project = snapshot(nodes=[group, text, duplicate_a, duplicate_b])

    assert resolve_canvas_link('Scene 1', project)['nodeId'] == str(group.id)
    assert resolve_canvas_link('Finished note', project)['nodeId'] == str(text.id)
    ambiguous = resolve_canvas_link('Same title', project)
    assert ambiguous['status'] == 'ambiguous'
    assert len(ambiguous['candidates']) == 2


def test_code_examples_are_not_navigable_links():
    fence = '```markdown\n[Example](fenced.md)\n```'
    inline = 'Use `[Example](inline.md)` literally.'
    text = f'{fence}\n{inline}\nReal [Finished note](notes.md)'
    stored = asset(uuid4(), 'notes.md')
    item = node(uuid4(), title='Finished note', asset_id=stored.id)
    project = snapshot(assets=[stored], nodes=[item])
    assert link_targets(text) == ['notes.md']
    links = canvas_links_for_text(text, project)
    assert [link['target'] for link in links] == ['notes.md']
    assert links[0]['nodeId'] == str(item.id)


def test_markdown_parser_ignores_nested_image_labels_and_malformed_destinations():
    text = ('````markdown\n```\n[example](notes.md)\n````\n'
            '![alt [nested](notes.md)](image.png)\n'
            '[bad](notes.md unquoted junk) [open](<notes.md>')
    assert link_targets(text) == []


def test_markdown_escaped_filename_resolves_to_real_asset():
    stored = asset(uuid4(), 'notes.md')
    item = node(uuid4(), title='Finished note', asset_id=stored.id)
    resolved, = canvas_links_for_text(r'[note](notes\.md)', snapshot(assets=[stored], nodes=[item]))
    assert resolved['status'] == 'focused'
    assert resolved['nodeId'] == str(item.id)


def test_child_under_hidden_group_is_hidden():
    group = node(uuid4(), kind='group', visible=False)
    child = node(uuid4(), title='Child', parent_id=group.id)
    resolved = resolve_canvas_link(f'canvas:{child.id}', snapshot(nodes=[group, child]))
    assert resolved['status'] == 'hidden'
    assert resolved['action'] == 'reveal'


def test_adopted_generation_asset_resolves_through_current_result():
    asset_id, spec_id, result_id, item_id = (uuid4() for _ in range(4))
    stored = asset(asset_id, 'adopted.png', kind='image')
    item = node(item_id, kind='image', parent_id=None)
    item.binding = NS(role='generation', objectRef=NS(id=spec_id))
    result = NS(id=result_id, asset=NS(assetId=asset_id))
    spec = NS(id=spec_id, currentResultId=result_id)
    project = snapshot(assets=[stored], nodes=[item])
    project.results = (result,)
    project.generationSpecs = (spec,)
    resolved = resolve_canvas_link('adopted.png', project)
    assert resolved['status'] == 'focused'
    assert resolved['nodeId'] == str(item_id)


def test_stable_identity_does_not_depend_on_position_or_title():
    item = node(uuid4(), title='Before')
    original = snapshot(nodes=[item])
    first = resolve_canvas_link('Before', original)
    moved = node(item.id, title='After', parent_id=uuid4())
    moved.position = NS(x=1234, y=-500)
    after = snapshot(nodes=[moved])
    second = resolve_canvas_link(f'canvas:{item.id}', after)
    assert first['nodeId'] == second['nodeId'] == str(item.id)
    assert resolve_canvas_link('Before', after)['status'] == 'missing'
    assert resolve_canvas_link('After', after)['nodeId'] == str(item.id)


def test_message_enrichment_only_attaches_project_references():
    item = node(uuid4(), title='Finished note')
    project = snapshot(nodes=[item])
    message = {'id': 'm', 'role': 'assistant',
               'text': '[local](notes.md) [site](https://example.test) [known](<Finished note>)'}
    enriched = with_canvas_links(message, project)
    assert [link['status'] for link in enriched['canvasLinks']] == ['missing', 'focused']
    assert 'canvasLinks' not in message
    user = with_canvas_links({'id': 'u', 'role': 'user', 'text': '[x](notes.md)'}, project)
    assert 'canvasLinks' not in user


def frames(response):
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]


async def empty_skills(*args):
    return []


def test_finished_turn_persists_canvas_links_across_move_rename_and_reopen(tmp_path, monkeypatch):
    async def stream(self, run):
        yield {'type': 'delta', 'text': 'Done [Finished note](notes.md)'}

    monkeypatch.setattr(agent.AgentRuntimes, 'stream', stream)
    monkeypatch.setattr(agent, 'runtime_available', lambda _: True)
    monkeypatch.setattr(agent, 'skills', empty_skills)
    from opendirector.infrastructure.model_configs import ModelConfigs
    monkeypatch.setattr(ModelConfigs, 'resolve', lambda *args: {'id': str(uuid4()), 'modelId': 'test-model'})

    project_id = str(uuid4())
    assistant_path = f'/api/creation/projects/{project_id}/assistant'
    root = f'/api/creation/projects/{project_id}'
    headers = {'X-OpenDirector-Request': '1', 'X-OpenDirector-Session': str(uuid4())}

    with TestClient(create_app(LocalProjects(tmp_path)), headers=headers) as client:
        created = client.post(root + '/commands', json={
            'type': 'project.create', 'projectId': project_id,
            'commandId': str(uuid4()), 'payload': {'name': 'Links'}})
        assert created.status_code == 200, created.text
        assert client.post(root + '/open').status_code == 200

        item_id, spec_id = str(uuid4()), str(uuid4())
        batch = client.post(root + '/commands', json={
            'type': 'creation.batch', 'commandId': str(uuid4()), 'projectId': project_id,
            'payload': {'operations': [
                {'type': 'generationSpec.create', 'payload': {'spec': {
                    'id': spec_id, 'projectId': project_id, 'kind': 'text', 'purpose': 'draft'}}},
                {'type': 'canvas.show', 'payload': {'item': {
                    'id': item_id, 'projectId': project_id, 'kind': 'text',
                    'title': 'Finished note',
                    'binding': {'role': 'empty', 'draftSpec': {'id': spec_id}}}}},
            ]}})
        assert batch.status_code == 200 and batch.json()['status'] == 'applied', batch.text
        written = client.post(root + '/commands', json={
            'type': 'asset.writeText', 'commandId': str(uuid4()), 'projectId': project_id,
            'payload': {'name': 'notes.md', 'text': 'v1'}})
        assert written.status_code == 200 and written.json()['status'] == 'applied', written.text
        saved_asset = client.get(root).json()['assets'][0]
        materialized = client.post(root + '/commands', json={
            'type': 'canvas.materialize', 'commandId': str(uuid4()), 'projectId': project_id,
            'payload': {'itemId': item_id, 'asset': {
                'assetId': saved_asset['id'], 'revision': saved_asset['revision'],
                'fingerprint': saved_asset['fingerprint'], 'kind': saved_asset['kind']}},
            'expectedVersions': [{'objectType': 'canvas_item', 'id': item_id, 'revision': 1}]})
        assert materialized.status_code == 200, materialized.text
        assert materialized.json()['status'] == 'applied', materialized.text

        turn_id = uuid4()
        response = client.post(assistant_path + '/turns', json={
            'id': str(turn_id), 'runtime': 'default', 'text': 'Create the note'})
        assert response.status_code == 200, response.text
        events = frames(response)
        assert events[-1]['type'] == 'end' and events[-1]['error'] is None
        saved = events[-1]['conversation']['messages'][-1]
        assert saved['id'] == str(uuid5(turn_id, 'assistant'))
        assert saved['canvasLinks'] == [{'target': 'notes.md', 'status': 'focused',
                                         'nodeId': item_id, 'kind': 'text'}]

        disk = next(tmp_path.glob('**/agent-runs/conversation.json'))
        persisted = json.loads(disk.read_text(encoding='utf-8'))['messages'][-1]
        assert persisted['canvasLinks'] == saved['canvasLinks']

        moved = client.post(root + '/commands', json={
            'type': 'canvas.move', 'commandId': str(uuid4()), 'projectId': project_id,
            'payload': {'items': [{'itemId': item_id, 'position': {'x': 640, 'y': 480}}]},
            'expectedVersions': [{'objectType': 'canvas_item', 'id': item_id, 'revision': 2}]})
        assert moved.json()['status'] == 'applied', moved.text
        renamed = client.post(root + '/commands', json={
            'type': 'canvas.update', 'commandId': str(uuid4()), 'projectId': project_id,
            'payload': {'itemId': item_id, 'title': 'Renamed note'},
            'expectedVersions': [{'objectType': 'canvas_item', 'id': item_id, 'revision': 3}]})
        assert renamed.json()['status'] == 'applied', renamed.text
        group_id = str(uuid4())
        grouped = client.post(root + '/commands', json={
            'type': 'creation.batch', 'commandId': str(uuid4()), 'projectId': project_id,
            'expectedVersions': [{'objectType': 'canvas_item', 'id': item_id, 'revision': 4}],
            'payload': {'operations': [
                {'type': 'canvas.show', 'payload': {'item': {
                    'id': group_id, 'projectId': project_id, 'kind': 'group'}}},
                {'type': 'canvas.update', 'payload': {'itemId': item_id, 'parentId': group_id}},
            ]}})
        assert grouped.status_code == 200 and grouped.json()['status'] == 'applied', grouped.text
        reread = client.get(assistant_path).json()
        assert reread['messages'][-1]['canvasLinks'] == saved['canvasLinks']

    # A fresh process reads the same persisted identity after reopening.
    with TestClient(create_app(LocalProjects(tmp_path)), headers=headers) as reopened:
        restored = reopened.get(assistant_path).json()
        assert restored['messages'][-1]['canvasLinks'] == saved['canvasLinks']
        opened = reopened.post(root + '/open-canvas')
        assert opened.status_code == 200, opened.text
        restored_item = next(item for item in opened.json()['snapshot']['canvasItems']
                             if item['id'] == item_id)
        assert restored_item['title'] == 'Renamed note'
        assert restored_item['position'] == {'x': 640, 'y': 480}
        assert restored_item['parentId'] == group_id
