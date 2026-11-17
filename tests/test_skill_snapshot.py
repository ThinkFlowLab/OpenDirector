"""Skill snapshots retain real resources without following external aliases."""
from pathlib import Path
from types import SimpleNamespace

import pytest

from opendirector.agent.skill_snapshot import prepare_skills, copy_skill_tree, _copy_path
from opendirector.domain.projects import ProjectError
from process_helpers import directory_link


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
