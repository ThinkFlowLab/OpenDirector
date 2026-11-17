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


def test_directory_qualified_link_focuses_its_directory_and_never_a_basename_duplicate():
    turn, other = uuid4(), uuid4()
    first_asset = asset(uuid4(), 'folder1/notes.md', run=other)
    second_asset = asset(uuid4(), 'folder2/notes.md', run=turn)
    first = node(uuid4(), title='Folder 1 note', asset_id=first_asset.id)
    second = node(uuid4(), title='Folder 2 note', asset_id=second_asset.id)
    project = snapshot(assets=[first_asset, second_asset], nodes=[first, second])

    # The link names its directory, so it resolves folder1's asset even though
    # folder2's same-basename asset belongs to the current turn.
    resolved = resolve_canvas_link('folder1/notes.md', project, turn)
    assert resolved['nodeId'] == str(first.id)

    # A directory with no such asset must not silently fall back to a
    # same-basename file elsewhere.
    assert resolve_canvas_link('folder3/notes.md', project, turn)['status'] == 'missing'


def test_unique_asset_resolves_by_name_regardless_of_turn_provenance():
    turn = uuid4()
    # A user-imported asset has no agentRunId, yet it is the only notes.md.
    imported = asset(uuid4(), 'notes.md')
    imported_item = node(uuid4(), title='Imported note', asset_id=imported.id)
    project = snapshot(assets=[imported], nodes=[imported_item])
    assert resolve_canvas_link('notes.md', project, turn)['nodeId'] == str(imported_item.id)

    # A previous turn's output is equally unique and must not be reported as
    # "not in this project" only because its run id differs.
    earlier = asset(uuid4(), 'notes.md', run=uuid4())
    earlier_item = node(uuid4(), title='Earlier note', asset_id=earlier.id)
    project = snapshot(assets=[earlier], nodes=[earlier_item])
    assert resolve_canvas_link('notes.md', project, turn)['nodeId'] == str(earlier_item.id)


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

    assert resolve_canvas_link('@Scene 1', project)['nodeId'] == str(group.id)
    assert resolve_canvas_link('@Finished note', project)['nodeId'] == str(text.id)
    ambiguous = resolve_canvas_link('@Same title', project)
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
    first = resolve_canvas_link('@Before', original)
    moved = node(item.id, title='After', parent_id=uuid4())
    moved.position = NS(x=1234, y=-500)
    after = snapshot(nodes=[moved])
    second = resolve_canvas_link(f'canvas:{item.id}', after)
    assert first['nodeId'] == second['nodeId'] == str(item.id)
    assert resolve_canvas_link('@Before', after)['status'] == 'missing'
    assert resolve_canvas_link('@After', after)['nodeId'] == str(item.id)


def validated_example():
    from test_creation_contracts import project_example
    return project_example().model_dump(mode='json')


def test_unique_other_turn_filename_resolves_and_explicit_history_identity_works():
    from opendirector.domain.creation import ProjectSnapshot
    data = validated_example()
    data['assets'][0]['name'] = 'notes.md'
    data['assets'][0]['provenance']['agentRunId'] = str(uuid4())
    data['canvasItems'][0]['title'] = 'notes.md'
    project = ProjectSnapshot.model_validate(data)
    # A unique asset keeps resolving by filename even when it belongs to an
    # earlier turn; the turn preference only disambiguates duplicate names.
    assert resolve_canvas_link('notes.md', project, uuid4())['nodeId'] == str(project.canvasItems[0].id)
    assert resolve_canvas_link(f'canvas:{project.canvasItems[0].id}', project, uuid4())['nodeId'] == str(project.canvasItems[0].id)


def test_material_override_links_only_to_the_displayed_asset():
    from opendirector.application.creation_canvas import current_asset
    from opendirector.domain.creation import ProjectSnapshot
    from test_creation_contracts import asset_ref
    data = validated_example()
    data['assets'][-1]['name'] = 'original.png'
    data['assets'][1]['name'] = 'replacement.png'
    data['assets'][1]['provenance'] = dict(source='imported', importedFrom='generated')
    initial = ProjectSnapshot.model_validate(data)
    data['canvasItems'][-3]['binding']['materialOverride'] = asset_ref(initial.assets[1]).model_dump(mode='json')
    # Avoid an unrelated material representation of replacement.png.
    data['canvasItems'][1]['binding'] = dict(role='empty')
    project = ProjectSnapshot.model_validate(data)
    item = project.canvasItems[-3]
    assert current_asset(project, item).name == 'replacement.png'
    assert resolve_canvas_link('original.png', project)['status'] == 'materialize'
    assert resolve_canvas_link('replacement.png', project)['nodeId'] == str(item.id)


@pytest.mark.parametrize(('target', 'name'), [
    ('report%2520final.md', 'report%20final.md'),
    ('folder%252Freport.md', 'folder%2Freport.md'),
    ('folder%2Freport.md', 'folder/report.md'),
    ('report%23final.md', 'report#final.md'),
    ('report%3Ffinal.md', 'report?final.md'),
    ('100%25.md', '100%.md'),
])
def test_url_path_is_decoded_once_after_structure_parsing(target, name):
    stored = asset(uuid4(), name)
    wrong = asset(uuid4(), 'report final.md')
    item = node(uuid4(), asset_id=stored.id)
    other = node(uuid4(), asset_id=wrong.id)
    links = canvas_links_for_text(f'[file]({target})', snapshot(assets=[stored, wrong], nodes=[item, other]))
    assert links[0]['nodeId'] == str(item.id)


def test_plain_mentions_resolve_unique_missing_and_duplicate_titles():
    from opendirector.domain.creation import ProjectSnapshot
    data = validated_example()
    data['canvasItems'][0]['title'] = 'Finished note'
    data['canvasItems'][1]['title'] = 'Same title'
    data['canvasItems'][2]['title'] = 'Same title'
    project = ProjectSnapshot.model_validate(data)
    links = canvas_links_for_text('@Finished note\n@No such item\n@Same title', project, uuid4())
    assert [link['status'] for link in links] == ['focused', 'missing', 'ambiguous']
    assert links[0]['nodeId'] == str(project.canvasItems[0].id)
    assert len(links[2]['candidates']) == 2


def test_mentions_in_code_images_and_link_labels_are_ignored():
    item = node(uuid4(), title='Finished note')
    text = ('```\n@Finished note\n```\n`@Finished note`\n'
            '![\u0040Finished note](image.png)\n[label @Finished note](https://example.test)')
    assert canvas_links_for_text(text, snapshot(nodes=[item])) == []


@pytest.mark.parametrize('suffix', ['.', ':', '"', "'", '`', '）'])
def test_mention_trailing_punctuation_does_not_swallow_the_title(suffix):
    item = node(uuid4(), title='Finished note')
    links = canvas_links_for_text(f'@Finished note{suffix}', snapshot(nodes=[item]), uuid4())
    assert [link['status'] for link in links] == ['focused']
    assert links[0]['nodeId'] == str(item.id)


@pytest.mark.parametrize('text', [
    '@Finished note. Next step',
    '@Finished note: Next step',
    '@Finished note.',
])
def test_mention_sentence_punctuation_ends_the_mention_before_running_prose(text):
    item = node(uuid4(), title='Finished note')
    links = canvas_links_for_text(text, snapshot(nodes=[item]), uuid4())
    assert [link['status'] for link in links] == ['focused']
    assert links[0]['target'] == '@Finished note'
    assert links[0]['nodeId'] == str(item.id)


def test_empty_link_destinations_are_not_persisted_as_missing_noise():
    item = node(uuid4(), title='Finished note')
    project = snapshot(nodes=[item])
    links = canvas_links_for_text('[x]() [y]( ) [z](notes.md)', project)
    assert [link['target'] for link in links] == ['notes.md']
    assert link_targets('[x]() [y]( )') == []


def test_mentions_keep_internal_punctuation_and_strip_only_trailing():
    chapter = node(uuid4(), title='Chapter 2.1')
    finished = node(uuid4(), title='Finished note')
    project = snapshot(nodes=[chapter, finished])

    links = canvas_links_for_text('See @Chapter 2.1 here', project)
    assert [link['status'] for link in links] == ['focused']
    assert links[0]['nodeId'] == str(chapter.id)
    assert links[0]['target'] == '@Chapter 2.1'

    links = canvas_links_for_text('@Finished note.', project)
    assert links[0]['target'] == '@Finished note'
    assert links[0]['nodeId'] == str(finished.id)


def test_nonexistent_multiword_title_never_falls_back_to_a_shorter_node():
    shorter = node(uuid4(), title='Scene')
    project = snapshot(nodes=[shorter])
    # "99 does not exist" is not running prose that may be stripped off a
    # title; resolving it to the unrelated node "Scene" references the wrong
    # object. Only an ordinary trailing word may be dropped.
    for text in ('@Scene 99', '@Scene 99 does not exist'):
        link, = canvas_links_for_text(text, project, uuid4())
        assert link['status'] == 'missing'
        assert link['target'] == text


@pytest.mark.parametrize(('text', 'expected'), [
    ('看这个@标题', '@标题'),
    ('@标题：请看', '@标题'),
    ('@标题：', '@标题'),
])
def test_cjk_mention_boundaries_and_fullwidth_colon(text, expected):
    item = node(uuid4(), title='标题')
    links = canvas_links_for_text(text, snapshot(nodes=[item]), uuid4())
    assert [link['status'] for link in links] == ['focused']
    assert links[0]['target'] == expected
    assert links[0]['nodeId'] == str(item.id)


def test_ascii_word_glued_to_a_cjk_mention_stays_prose():
    item = node(uuid4(), title='标题')
    assert canvas_links_for_text('abc@标题', snapshot(nodes=[item]), uuid4()) == []


def test_exact_title_wins_before_sentence_punctuation_is_trimmed():
    # "@Dr. Smith" must resolve the full title even when the shorter "Dr"
    # exists; trimming first would persist the wrong node id.
    short = node(uuid4(), title='Dr')
    full = node(uuid4(), title='Dr. Smith')
    note = node(uuid4(), title='Note')
    intro = node(uuid4(), title='Note: Intro')
    project = snapshot(nodes=[short, full, note, intro])
    for text, expected in (('@Dr. Smith', full), ('@Note: Intro', intro)):
        link, = canvas_links_for_text(text, project, uuid4())
        assert link['status'] == 'focused'
        assert link['target'] == text
        assert link['nodeId'] == str(expected.id)


@pytest.mark.parametrize(('text', 'title', 'expected_target'), [
    ('参见@标题、然后继续', '标题', '@标题'),
    ('“@标题”效果不错', '标题', '@标题'),
    ('（@标题）请继续', '标题', '@标题'),
    ('@标题…继续', '标题', '@标题'),
    ('@标题—继续', '标题', '@标题'),
    ('@标题」继续', '标题', '@标题'),
    ('@标题】继续', '标题', '@标题'),
    ('@Finished note）后续', 'Finished note', '@Finished note'),
])
def test_fullwidth_punctuation_ends_a_mention_mid_sentence(text, title, expected_target):
    item = node(uuid4(), title=title)
    link, = canvas_links_for_text(text, snapshot(nodes=[item]), uuid4())
    assert link['status'] == 'focused'
    assert link['target'] == expected_target
    assert link['nodeId'] == str(item.id)


@pytest.mark.parametrize('text', ['用@标题生成视频', '把@标题改一下'])
def test_cjk_prose_after_a_mention_resolves_a_known_title_prefix(text):
    # Chinese prose has no word separator, so the mention swallows the rest
    # of the phrase; the longest known title prefix still resolves it.
    item = node(uuid4(), title='标题')
    link, = canvas_links_for_text(text, snapshot(nodes=[item]), uuid4())
    assert link['status'] == 'focused'
    assert link['target'] == '@标题'
    assert link['nodeId'] == str(item.id)


def test_cjk_prefix_fallback_uses_the_longest_known_title():
    short = node(uuid4(), title='标题')
    longer = node(uuid4(), title='标题生成')
    link, = canvas_links_for_text('用@标题生成视频', snapshot(nodes=[short, longer]), uuid4())
    assert link['target'] == '@标题生成'
    assert link['nodeId'] == str(longer.id)


def test_ascii_continuation_does_not_use_the_cjk_prefix_fallback():
    # "Scene" is a prefix of "Scene2", but the continuation is not CJK prose;
    # silently referencing "Scene" would be the wrong object.
    item = node(uuid4(), title='Scene')
    link, = canvas_links_for_text('@Scene2', snapshot(nodes=[item]), uuid4())
    assert link['status'] == 'missing'
    assert 'nodeId' not in link


def test_bare_title_name_is_missing_and_only_mentions_resolve_titles():
    item = node(uuid4(), kind='group', title='Scene 1')
    project = snapshot(nodes=[item])
    # A bare filename-like destination matches assets, never item titles; the
    # production path (agent.py) always supplies a turn id, so this fallback
    # used to be dead code.
    assert resolve_canvas_link('Scene 1', project, uuid4())['status'] == 'missing'
    assert resolve_canvas_link('@Scene 1', project, uuid4())['nodeId'] == str(item.id)


def test_reference_style_markdown_links_are_supported():
    item = node(uuid4(), title='Finished note')
    links = canvas_links_for_text(f'[Finished note][ref]\n\n[ref]: canvas:{item.id}', snapshot(nodes=[item]))
    assert links[0]['nodeId'] == str(item.id)


def test_message_enrichment_only_attaches_project_references():
    item = node(uuid4(), title='Finished note')
    project = snapshot(nodes=[item])
    message = {'id': 'm', 'role': 'assistant',
               'text': '[local](notes.md) [site](https://example.test) @Finished note'}
    enriched = with_canvas_links(message, project)
    assert [link['status'] for link in enriched['canvasLinks']] == ['missing', 'focused']
    assert 'canvasLinks' not in message
    user = with_canvas_links({'id': 'u', 'role': 'user', 'text': '[x](notes.md)'}, project)
    assert 'canvasLinks' not in user


def test_agent_generation_submit_stamps_provenance_and_relative_link_hits_it(tmp_path):
    import asyncio
    from opendirector.application.creation_generation import CreationGeneration
    from opendirector.domain.creation.commands import parse_command
    from opendirector.infrastructure.creation_projects import CreationProjects
    from opendirector.infrastructure.model_configs import ModelConfigs
    from opendirector.agent.tools import AgentTools

    store = CreationProjects(LocalProjects(tmp_path))
    pid, session = uuid4(), str(uuid4())

    def send(kind, *, versions=(), **payload):
        return store.execute(parse_command({
            'type': kind, 'projectId': pid, 'commandId': uuid4(),
            'expectedVersions': list(versions), 'payload': payload}), session=session)

    def version(kind, obj):
        return {'objectType': kind, 'id': str(obj.id), 'revision': obj.revision}

    assert send('project.create', name='Links').status == 'applied'
    store.open(pid, session)

    spec_id, item_id = uuid4(), uuid4()
    assert send('creation.batch', operations=[
        {'type': 'generationSpec.create', 'payload': {'spec': {
            'id': str(spec_id), 'projectId': str(pid), 'kind': 'text', 'purpose': 'generation'}}},
        {'type': 'canvas.show', 'payload': {'item': {
            'id': str(item_id), 'projectId': str(pid), 'kind': 'text', 'title': 'Result',
            'binding': {'role': 'generation', 'objectRef': {'id': str(spec_id)}}}}}]).status == 'applied'

    configs = ModelConfigs(store.local.repository)
    config = configs.save('agent', 'http://127.0.0.1:12345/v1', 'test-agent', '',
        connection_type='self_hosted', protocol='openai', auth_mode='none')
    spec = next(s for s in store.snapshot(pid).generationSpecs if s.id == spec_id)
    assert send('generationSpec.update', versions=[version('generation_spec', spec)],
        spec=spec.model_copy(update={'prompt': 'result.md',
            'modelConfigId': UUID(config['id'])}).model_dump(mode='json')).status == 'applied'
    spec = store.snapshot(pid).generationSpecs[-1]
    target = next(item for item in store.snapshot(pid).canvasItems if item.id == item_id)

    # A same-named user import: only the stamped generation output carries the turn.
    assert send('asset.writeText', name='result.md', text='v1').status == 'applied'

    class Provider:
        def __init__(self):
            self.finish = asyncio.Event()

        def validate(self, kind, config):
            pass

        async def generate(self, config, task, submitted):
            await self.finish.wait()
            return 'md', b'Actual generated text'

    provider = Provider()
    generation = CreationGeneration(store, configs, provider)
    business = AgentTools(store, generation, configs)
    turn_id = uuid4()
    provider.finish.set()

    async def submit_and_wait():
        receipt = await business.execute(pid, turn_id, session, 'submit-call', 'execute_command', {
            'type': 'generation.submit',
            'expectedVersions': [version('canvas_item', target), version('generation_spec', spec)],
            'payload': {'specId': str(spec.id), 'expectedSpecRevision': spec.revision,
                        'originItemId': str(target.id)}}, [], None)
        assert receipt['status'] == 'accepted', receipt
        await asyncio.gather(*(job.future for job in list(generation.jobs.values())))

    try:
        asyncio.run(submit_and_wait())
    finally:
        asyncio.run(generation.close())

    snapshot = store.snapshot(pid)
    generated = next(asset for asset in snapshot.assets if asset.provenance.source == 'generated')
    assert str(generated.provenance.agentRunId) == str(turn_id)
    resolved = resolve_canvas_link('result.md', snapshot, turn_id)
    assert resolved['status'] == 'focused'
    assert resolved['nodeId'] == str(target.id)


def frames(response):
    return [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]


async def empty_skills(*args):
    return []


def test_finished_turn_persists_canvas_links_across_move_rename_and_reopen(tmp_path, monkeypatch):
    async def stream(self, run):
        yield {'type': 'delta', 'text': f'Done [Finished note](canvas:{item_id})'}

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
        schema = json.loads((Path(__file__).resolve().parents[1] / 'src/contracts/creation.schema.json').read_text())
        assert set(saved['canvasLinks'][0]) >= set(schema['output']['$defs']['ChatCanvasLink']['required'])
        from opendirector.domain.creation.chat import ChatCanvasLink
        assert saved['canvasLinks'] == [ChatCanvasLink(target=f'canvas:{item_id}', status='focused',
                                                     nodeId=item_id, kind='text').model_dump(mode='json')]

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

    # A fresh application instance reads the same persisted identity.
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
