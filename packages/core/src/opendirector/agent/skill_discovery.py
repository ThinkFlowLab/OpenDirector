"""Harness-independent skill discovery (RFC #166, implementation slice 2).

Discovers built-in, workspace and project skills without invoking bundled
OpenCode, validates metadata, size and path boundaries explicitly, resolves
duplicate names deterministically and reports rejected skills through stable
diagnostic codes instead of silently dropping them or failing later.

The current loader (``opendirector.agent.skills``) delegates discovery to
``opencode debug skill --pure``. Measured differences that this module
intentionally closes:

- A skill without ``description`` is listed by OpenCode and then crashes the
  catalog endpoint with ``KeyError``; here it is rejected with
  ``missing_description``.
- ``name: a/b`` is listed by OpenCode and later fails during snapshot
  preparation; here it is rejected with ``unsafe_name``.
- Duplicate names resolve to the last root (project < workspace < builtin);
  here the first root wins (project > workspace > builtin).
- Symlinked skill locations disappear without explanation; here they are
  reported as ``symlinked`` diagnostics.
- A catalog larger than 128 KiB truncates OpenCode's piped JSON output on
  macOS; reading files directly has no output-size bound.

Accepted metadata formats stay compatible with OpenCode: uppercase,
underscores, spaces, Unicode and directory names that differ from ``name`` are
all accepted, because rejecting them would drop skills that work today.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from opendirector.agent.skill_snapshot import prepare_skills
from opendirector.installation import builtin_skills

SKILL_FILENAME = 'SKILL.md'
MAX_SKILL_BYTES = 65536

PROJECT = 'project'
WORKSPACE = 'workspace'
BUILTIN = 'builtin'
SOURCE_PRECEDENCE = (PROJECT, WORKSPACE, BUILTIN)

# Stable diagnostic codes for API and Agent surfaces.
SYMLINKED = 'symlinked'
OUTSIDE_ROOT = 'outside_root'
UNREADABLE = 'unreadable'
OVERSIZED = 'oversized'
INVALID_ENCODING = 'invalid_encoding'
MISSING_FRONTMATTER = 'missing_frontmatter'
INVALID_FRONTMATTER = 'invalid_frontmatter'
MISSING_NAME = 'missing_name'
UNSAFE_NAME = 'unsafe_name'
MISSING_DESCRIPTION = 'missing_description'
INVALID_DESCRIPTION = 'invalid_description'
DUPLICATE_SHADOWED = 'duplicate_shadowed'


@dataclass(frozen=True)
class SkillDiagnostic:
    code: str
    path: str
    detail: str = ''


@dataclass(frozen=True)
class Skill:
    name: str
    description: str
    source: str
    file_path: Path
    root: Path

    def catalog_row(self) -> dict[str, str]:
        return {'name': self.name, 'description': self.description,
                'filePath': str(self.file_path), 'source': self.source}


@dataclass
class SkillDiscovery:
    skills: list[Skill] = field(default_factory=list)
    diagnostics: list[SkillDiagnostic] = field(default_factory=list)

    def catalog(self) -> list[dict[str, str]]:
        return [skill.catalog_row() for skill in self.skills]

    def select(self, names: list[str]) -> tuple[list[Skill], list[str]]:
        """Return selected skills and the names that are not available."""
        wanted = list(dict.fromkeys(names))
        available = {skill.name: skill for skill in self.skills}
        return [available[name] for name in wanted if name in available], [
            name for name in wanted if name not in available]


def roots(repository: Path, directory: Path) -> dict[str, Path]:
    """Roots in precedence order: project, workspace, built-in."""
    return {
        PROJECT: directory / '.opendirector/skills',
        WORKSPACE: repository / '.opendirector/skills',
        BUILTIN: builtin_skills(),
    }


def discover(repository: Path, directory: Path) -> SkillDiscovery:
    result = SkillDiscovery()
    locations = roots(repository, directory)
    for source in SOURCE_PRECEDENCE:
        root = locations[source]
        if not root.is_dir():
            continue
        for file_path in _skill_files(root, result.diagnostics):
            skill = _read_skill(file_path, root, source, result.diagnostics)
            if skill is None:
                continue
            previous = next((item for item in result.skills if item.name == skill.name), None)
            if previous is not None:
                result.diagnostics.append(SkillDiagnostic(DUPLICATE_SHADOWED, str(file_path),
                    f'"{skill.name}" from {source} shadowed by {previous.source} at {previous.file_path}'))
                continue
            result.skills.append(skill)
    return result


def _skill_files(root: Path, diagnostics: list[SkillDiagnostic]):
    def onerror(error: OSError) -> None:
        diagnostics.append(SkillDiagnostic(UNREADABLE, str(getattr(error, 'filename', root) or root),
            error.strerror or type(error).__name__))

    for current, directories, files in os.walk(root, followlinks=False, onerror=onerror):
        current_path = Path(current)
        kept = []
        for name in sorted(directories):
            candidate = current_path / name
            if candidate.is_symlink():
                if (candidate / SKILL_FILENAME).is_file():
                    diagnostics.append(SkillDiagnostic(SYMLINKED, str(candidate),
                        'skill directory is a symbolic link'))
                continue
            kept.append(name)
        directories[:] = kept
        if SKILL_FILENAME in files:
            yield current_path / SKILL_FILENAME


def _read_skill(file_path: Path, root: Path, source: str,
                diagnostics: list[SkillDiagnostic]) -> Skill | None:
    if file_path.is_symlink():
        diagnostics.append(SkillDiagnostic(SYMLINKED, str(file_path), 'SKILL.md is a symbolic link'))
        return None
    try:
        if not file_path.resolve().is_relative_to(root.resolve()):
            diagnostics.append(SkillDiagnostic(OUTSIDE_ROOT, str(file_path), 'skill file escapes its root'))
            return None
        size = file_path.stat().st_size
    except OSError as error:
        diagnostics.append(SkillDiagnostic(UNREADABLE, str(file_path), error.strerror or type(error).__name__))
        return None
    if size > MAX_SKILL_BYTES:
        diagnostics.append(SkillDiagnostic(OVERSIZED, str(file_path),
            f'{size} bytes exceeds {MAX_SKILL_BYTES}'))
        return None
    try:
        text = file_path.read_text(encoding='utf-8')
    except UnicodeDecodeError:
        diagnostics.append(SkillDiagnostic(INVALID_ENCODING, str(file_path), 'not valid UTF-8'))
        return None
    except OSError as error:
        diagnostics.append(SkillDiagnostic(UNREADABLE, str(file_path), error.strerror or type(error).__name__))
        return None

    frontmatter = _frontmatter(text)
    if frontmatter is None:
        diagnostics.append(SkillDiagnostic(MISSING_FRONTMATTER, str(file_path),
            'SKILL.md must start with a YAML frontmatter block'))
        return None
    try:
        metadata = yaml.safe_load(frontmatter)
    except yaml.YAMLError as error:
        diagnostics.append(SkillDiagnostic(INVALID_FRONTMATTER, str(file_path), str(error).splitlines()[0]))
        return None
    if not isinstance(metadata, dict):
        diagnostics.append(SkillDiagnostic(INVALID_FRONTMATTER, str(file_path),
            'frontmatter must be a mapping'))
        return None

    name = metadata.get('name')
    if not isinstance(name, str) or not name:
        diagnostics.append(SkillDiagnostic(MISSING_NAME, str(file_path), 'frontmatter needs a name'))
        return None
    if _unsafe_name(name):
        diagnostics.append(SkillDiagnostic(UNSAFE_NAME, str(file_path), f'name {name!r} is not path-safe'))
        return None

    if 'description' not in metadata:
        diagnostics.append(SkillDiagnostic(MISSING_DESCRIPTION, str(file_path),
            'frontmatter needs a description'))
        return None
    description = metadata['description']
    if description is None:
        description = ''
    if not isinstance(description, str):
        diagnostics.append(SkillDiagnostic(INVALID_DESCRIPTION, str(file_path),
            'description must be a string'))
        return None

    return Skill(name=name, description=description, source=source,
                 file_path=file_path, root=root)


def _unsafe_name(name: str) -> bool:
    return (name in {'.', '..'} or '/' in name or '\\' in name
            or '\x00' in name or os.sep in name)


def _frontmatter(text: str) -> str | None:
    if text.startswith('\ufeff'):
        text = text[1:]
    lines = text.splitlines()
    if not lines or lines[0].strip() != '---':
        return None
    for index in range(1, len(lines)):
        if lines[index].strip() in {'---', '...'}:
            return '\n'.join(lines[1:index])
    return None


def snapshot(directory: Path, selected: list[Skill]) -> list[Path]:
    """Copy selected skills and their resources into a per-turn directory."""
    return prepare_skills(directory, [skill.catalog_row() for skill in selected])
