"""Skill snapshots retain real resources without following external aliases."""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from opendirector import installation
from opendirector.agent import skills as skill_catalog
from opendirector.agent.skill_snapshot import prepare_skills, copy_skill_tree, selected_skill_catalog, _copy_path
from opendirector.domain.projects import ProjectError
from process_helpers import directory_link


pytestmark = pytest.mark.cpu


@pytest.mark.parametrize('component', ['.agents', '.agents/skills'])
def test_reused_snapshot_rejects_reparse_directories_before_removal(tmp_path, monkeypatch, component):
    work = tmp_path / 'work'
    root = work / '.agents/skills'
    root.mkdir(parents=True)
    retained = root / 'retained.txt'
    retained.write_text('retained')
    original = Path.lstat
    def reparse_info(path, *args, **kwargs):
        info = original(path, *args, **kwargs)
        if path == work / component:
            return SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400)
        return info
    monkeypatch.setattr(Path, 'lstat', reparse_info)
    with pytest.raises(ProjectError, match='技能快照目录'):
        prepare_skills(work, [])
    assert retained.read_text() == 'retained'


def test_long_skill_resources_are_copied_but_external_directory_aliases_are_not(tmp_path):
    source = tmp_path / 'source'
    source.mkdir()
    entry = source / 'SKILL.md'
    entry.write_text('---\nname: example\ndescription: Fixture\n---\nRead the resource')
    (source / 'assets').mkdir()
    resource = 'r' * 100 + '.txt'
    (source / 'assets' / resource).write_bytes(b'actual resource')
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'private.txt').write_text('private')
    directory_link(source / 'escape', outside)
    work = tmp_path / ('w' * max(1, 195 - len(str(tmp_path))))
    roots = prepare_skills(work, [{'name': 'example', 'filePath': str(entry)}])
    copied = roots[0] / 'assets' / resource
    assert len(str(copied)) > 260
    assert Path(_copy_path(copied)).read_bytes() == b'actual resource'
    assert not (roots[0] / 'escape').exists()
    assert (outside / 'private.txt').read_text() == 'private'


def test_secondary_native_skill_copy_keeps_long_resources_and_rejects_aliases(tmp_path):
    source = tmp_path / ('s' * max(1, 190 - len(str(tmp_path))))
    source.mkdir()
    resource = source / ('r' * 100 + '.json')
    Path(_copy_path(resource)).write_bytes(b'{"resource":"actual bytes"}')
    outside = tmp_path / 'outside'; outside.mkdir()
    (outside / 'private.txt').write_bytes(b'private')
    directory_link(source / 'escape', outside)
    private = tmp_path / ('d' * max(1, 190 - len(str(tmp_path))))
    copy_skill_tree(source, private)
    assert len(str(resource)) > 260 and len(str(private / resource.name)) > 260
    assert Path(_copy_path(private / resource.name)).read_bytes() == Path(_copy_path(resource)).read_bytes()
    assert not (private / 'escape').exists()
    assert (outside / 'private.txt').read_bytes() == b'private'


@pytest.mark.parametrize('kind', ['source', 'uninitialized', 'installed'])
def test_official_h3_skill_is_discovered_and_snapshotted(tmp_path, monkeypatch, kind):
    repository = tmp_path / 'repo'
    monkeypatch.setattr(installation, 'SOURCE_ROOT', None if kind == 'installed' else repository)
    monkeypatch.setattr(installation, 'BUNDLED', tmp_path / 'bundled')
    replacement = installation.builtin_skills() / 'character-replacement'
    replacement.mkdir(parents=True)
    (replacement / 'SKILL.md').write_bytes(b'character replacement')

    upstream_skills = repository / '.agents/upstream/minimax-h3/skills'
    official = upstream_skills / 'h3-prompt-writing'
    if kind != 'uninitialized':
        (official / 'references').mkdir(parents=True)
        (official / 'SKILL.md').write_bytes(b'upstream H3 skill')
        (official / 'references/ref-en.txt').write_bytes(b'upstream Ref2VA rules')
        unrelated = upstream_skills / 'unrelated'
        unrelated.mkdir()
        (unrelated / 'SKILL.md').write_bytes(b'unrelated upstream skill')

    async def run_loader(*args, env, **kwargs):
        paths = json.loads(env['OPENCODE_CONFIG_CONTENT'])['skills']['paths']
        expected = [str(installation.builtin_skills().resolve())]
        if kind == 'source':
            expected.append(str(official.resolve()))
        assert paths == expected

        async def communicate():
            entries = [dict(name=entry.parent.name, description='Fixture', location=str(entry))
                       for path in paths for entry in Path(path).rglob('SKILL.md')]
            return json.dumps(entries).encode(), b''

        return SimpleNamespace(communicate=communicate, returncode=0)

    async def terminate(_):
        pass

    monkeypatch.setattr(skill_catalog, 'executable', lambda _: 'opencode')
    monkeypatch.setattr(skill_catalog.asyncio, 'create_subprocess_exec', run_loader)
    monkeypatch.setattr(skill_catalog, 'terminate', terminate)
    catalog = asyncio.run(skill_catalog.skills(repository, tmp_path / 'project'))
    expected = {'character-replacement': 'builtin'}
    if kind == 'source':
        expected['h3-prompt-writing'] = 'builtin'
    assert {entry['name']: entry['source'] for entry in catalog} == expected

    roots = {path.name: path for path in prepare_skills(tmp_path / 'work', catalog)}
    assert roots['character-replacement'].joinpath('SKILL.md').read_bytes() == b'character replacement'
    if kind == 'source':
        reference = roots['h3-prompt-writing']
        assert (reference / 'SKILL.md').read_bytes() == b'upstream H3 skill'
        assert (reference / 'references/ref-en.txt').read_bytes() == b'upstream Ref2VA rules'
    assert roots.keys() == expected.keys()


def test_turn_snapshots_only_selected_skills_and_declared_dependencies(tmp_path):
    catalog = []
    for name in ('selected', 'dependency', 'unrelated'):
        entry = tmp_path / 'catalog' / name / 'SKILL.md'
        entry.parent.mkdir(parents=True)
        metadata = '\nmetadata:\n  opendirector-dependencies: dependency' if name == 'selected' else ''
        entry.write_text(f'---\nname: {name}{metadata}\n---\n', encoding='utf-8')
        catalog.append({'name': name, 'filePath': str(entry)})
    work = tmp_path / 'work'
    assert {path.name for path in prepare_skills(work, selected_skill_catalog(catalog, ['selected']))} == {
        'selected', 'dependency',
    }
    assert {path.name for path in prepare_skills(work, selected_skill_catalog(catalog, ['unrelated']))} == {
        'unrelated',
    }
    assert prepare_skills(work, selected_skill_catalog(catalog, [])) == []
    with pytest.raises(ProjectError, match='dependency'):
        selected_skill_catalog([catalog[0]], ['selected'])
