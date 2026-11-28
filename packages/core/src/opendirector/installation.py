"""Installation resources are read-only; workspace data is stored separately."""
import os
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent
BUNDLED = PACKAGE / '_bundled'
SOURCE = PACKAGE.parents[3]
SOURCE_ROOT = SOURCE if (SOURCE / 'package.json').is_file() else None


def data_root() -> Path:
    explicit = os.environ.get('OPENDIRECTOR_ROOT')
    return Path(explicit).expanduser().resolve() if explicit else SOURCE_ROOT or Path.home() / '.opendirector'


def web_root() -> Path:
    return SOURCE_ROOT / 'dist' if SOURCE_ROOT else BUNDLED / 'web'


def builtin_skills() -> Path:
    return SOURCE_ROOT / 'packages/agent/skills' if SOURCE_ROOT else BUNDLED / 'skills'


def builtin_skill_roots() -> tuple[Path, ...]:
    roots = (builtin_skills(),)
    if SOURCE_ROOT is not None:
        h3_skill = SOURCE_ROOT / '.agents/upstream/minimax-h3/skills/h3-prompt-writing'
        if (h3_skill / 'SKILL.md').is_file():
            return (*roots, h3_skill)
    return roots


def default_timeline_font() -> Path:
    return (SOURCE_ROOT / 'public/fonts' if SOURCE_ROOT else web_root() / 'fonts') / 'NotoSansCJKsc-Regular.otf'
