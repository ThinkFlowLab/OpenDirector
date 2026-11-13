import asyncio
from pathlib import Path

import pytest

from opendirector.agent import native
from opendirector.agent.skill_discovery import (
    DUPLICATE_SHADOWED, INVALID_DESCRIPTION, INVALID_FRONTMATTER, MISSING_DESCRIPTION,
    MISSING_FRONTMATTER, MISSING_NAME, OVERSIZED, SYMLINKED, UNSAFE_NAME,
    discover, snapshot,
)
from opendirector.agent.skills import skills


def layout(tmp_path: Path) -> tuple[Path, Path]:
    repository = tmp_path / 'repository'
    project = tmp_path / 'project'
    (repository / '.opendirector/skills').mkdir(parents=True)
    (project / '.opendirector/skills').mkdir(parents=True)
    return repository, project


def write_skill(root: Path, directory: str, *, name: str | None = None,
                description: str | None = 'Description', body: str = 'Body',
                frontmatter: bool = True) -> Path:
    path = root / directory
    path.mkdir(parents=True)
    lines = ['---']
    if name is not None:
        lines.append(f'name: {name}')
    if description is not None:
        lines.append(f'description: {description}')
    lines.append('---')
    if not frontmatter:
        lines = []
    (path / 'SKILL.md').write_text('\n'.join([*lines, body, '']))
    return path


def diagnostics(discovery) -> set[str]:
    return {item.code for item in discovery.diagnostics}


def test_discovers_project_workspace_and_builtin(tmp_path):
    repository, project = layout(tmp_path)
    write_skill(project / '.opendirector/skills', 'alpha-demo', name='alpha-demo', description='from project')
    write_skill(repository / '.opendirector/skills', 'beta-demo', name='beta-demo', description='from workspace')

    discovery = discover(repository, project)
    by_name = {skill.name: skill for skill in discovery.skills}

    assert by_name['alpha-demo'].source == 'project'
    assert by_name['beta-demo'].source == 'workspace'
    assert by_name['character-replacement'].source == 'builtin'
    assert discovery.diagnostics == []
    row = by_name['alpha-demo'].catalog_row()
    assert row == {'name': 'alpha-demo', 'description': 'from project',
                   'filePath': str(project / '.opendirector/skills/alpha-demo/SKILL.md'),
                   'source': 'project'}


def test_duplicate_names_prefer_project_over_workspace_and_builtin(tmp_path):
    repository, project = layout(tmp_path)
    write_skill(project / '.opendirector/skills', 'character-replacement',
                name='character-replacement', description='project copy')
    write_skill(repository / '.opendirector/skills', 'character-replacement',
                name='character-replacement', description='workspace copy')

    discovery = discover(repository, project)
    winner = next(skill for skill in discovery.skills if skill.name == 'character-replacement')

    assert winner.source == 'project'
    assert winner.description == 'project copy'
    shadowed = [item for item in discovery.diagnostics if item.code == DUPLICATE_SHADOWED]
    assert len(shadowed) == 2
    assert all('shadowed by project' in item.detail for item in shadowed)


def test_invalid_skills_report_explicit_diagnostics(tmp_path):
    repository, project = layout(tmp_path)
    root = project / '.opendirector/skills'
    write_skill(root, 'valid-demo', name='valid-demo')
    write_skill(root, 'no-frontmatter', frontmatter=False)
    write_skill(root, 'no-name', name=None)
    write_skill(root, 'no-description', name='no-description', description=None)
    write_skill(root, 'bad-yaml', name='bad-yaml')
    (root / 'bad-yaml/SKILL.md').write_text('---\nname: [unclosed\ndescription: x\n---\nBody\n')
    write_skill(root, 'bad-description', name='bad-description')
    (root / 'bad-description/SKILL.md').write_text('---\nname: bad-description\ndescription: [a]\n---\n')
    write_skill(root, 'unsafe-name', name='a/b')
    huge = write_skill(root, 'oversized', name='oversized')
    (huge / 'SKILL.md').write_text('---\nname: oversized\ndescription: d\n---\n' + 'x' * 70000)
    outside = write_skill(tmp_path / 'outside', 'external', name='external')
    (root / 'linked-file').mkdir()
    (root / 'linked-file/SKILL.md').symlink_to(outside / 'SKILL.md')
    (root / 'linked-directory').symlink_to(outside)

    discovery = discover(repository, project)

    assert {skill.name for skill in discovery.skills} >= {'valid-demo'}
    assert 'no-frontmatter' not in {skill.name for skill in discovery.skills}
    assert diagnostics(discovery) >= {
        MISSING_FRONTMATTER, MISSING_NAME, MISSING_DESCRIPTION, INVALID_FRONTMATTER,
        INVALID_DESCRIPTION, UNSAFE_NAME, OVERSIZED, SYMLINKED,
    }


def test_symlinked_entry_reporting_covers_file_and_directory(tmp_path):
    repository, project = layout(tmp_path)
    root = project / '.opendirector/skills'
    outside = write_skill(tmp_path / 'outside', 'external', name='external')
    (root / 'linked-file').mkdir()
    (root / 'linked-file/SKILL.md').symlink_to(outside / 'SKILL.md')
    (root / 'linked-directory').symlink_to(outside)
    discovery = discover(repository, project)
    symlinked = [item for item in discovery.diagnostics if item.code == SYMLINKED]
    assert {Path(item.path).relative_to(root).as_posix() for item in symlinked} == {
        'linked-file/SKILL.md', 'linked-directory'}


def test_keeps_formats_the_current_loader_accepts(tmp_path):
    repository, project = layout(tmp_path)
    root = project / '.opendirector/skills'
    write_skill(root, 'Upper-Case', name='Upper-Case')
    write_skill(root, 'under_score', name='under_score')
    write_skill(root, 'space name', name='space name')
    write_skill(root, 'unicode', name='技能')
    write_skill(root, 'different-dir', name='dir-mismatch')

    names = {skill.name for skill in discover(repository, project).skills}
    assert {'Upper-Case', 'under_score', 'space name', '技能', 'dir-mismatch'} <= names


def test_nested_skills_and_resources_snapshot(tmp_path):
    repository, project = layout(tmp_path)
    root = project / '.opendirector/skills'
    nested = write_skill(root / 'group', 'nested-skill', name='nested-skill')
    (nested / 'assets').mkdir()
    (nested / 'assets/reference.txt').write_text('resource')
    (nested / 'guide.md').write_text('guide')

    discovery = discover(repository, project)
    selected, missing = discovery.select(['nested-skill', 'missing-skill'])

    assert [skill.name for skill in selected] == ['nested-skill']
    assert missing == ['missing-skill']
    work = tmp_path / 'turn'
    copied = snapshot(work, selected)
    assert [path.name for path in copied] == ['nested-skill']
    skill_root = work / '.agents/skills/nested-skill'
    assert (skill_root / 'SKILL.md').is_file()
    assert (skill_root / 'guide.md').read_text() == 'guide'
    assert (skill_root / 'assets/reference.txt').read_text() == 'resource'


def test_discovery_ignores_root_escape_attempts(tmp_path):
    repository, project = layout(tmp_path)
    root = project / '.opendirector/skills'
    outside = tmp_path / 'outside-skill'
    outside.mkdir()
    (outside / 'SKILL.md').write_text('---\nname: escaped\ndescription: d\n---\n')
    (root / 'escaped').symlink_to(outside, target_is_directory=True)

    discovery = discover(repository, project)
    assert 'escaped' not in {skill.name for skill in discovery.skills}
    assert SYMLINKED in diagnostics(discovery)


def test_parity_with_bundled_opencode_loader_on_representative_skills(tmp_path):
    if native.executable('default') is None:
        pytest.skip('Bundled OpenCode is not installed')
    repository, project = layout(tmp_path)
    write_skill(project / '.opendirector/skills', 'alpha-demo', name='alpha-demo', description='from project')
    write_skill(repository / '.opendirector/skills', 'beta-demo', name='beta-demo', description='from workspace')
    write_skill(repository / '.opendirector/skills/group', 'gamma-demo', name='gamma-demo', description='nested')

    current = asyncio.run(skills(repository, project))
    current_rows = {(item['name'], item['description'], item['source']) for item in current}
    discovery = discover(repository, project)
    rows = {(skill.name, skill.description, skill.source) for skill in discovery.skills}

    assert rows == current_rows
