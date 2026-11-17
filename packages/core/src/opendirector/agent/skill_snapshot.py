"""Per-turn skill copies shared by native runtime adapters."""
from pathlib import Path
import os
import shutil
import stat

from opendirector.domain.projects import ProjectError


def _copy_path(path: Path) -> str:
    # Python's copy functions still hit MAX_PATH on machines where long-path
    # awareness is disabled. Keep public paths ordinary; use extended paths
    # only for the private snapshot's filesystem operations.
    value = str(path.absolute())
    if os.name != 'nt' or value.startswith('\\\\?\\'):
        return value
    return '\\\\?\\UNC\\' + value[2:] if value.startswith('\\\\') else '\\\\?\\' + value


def _is_link(path: Path) -> bool:
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & 0x400)


def copy_skill_tree(source: Path, destination: Path) -> None:
    """Copy a selected skill's resources without following filesystem aliases."""
    if _is_link(source):
        raise ProjectError('技能入口不能是符号链接。')
    shutil.copytree(_copy_path(source), _copy_path(destination),
        ignore=lambda parent, names: [name for name in names if _is_link(Path(parent, name))])


def prepare_skills(directory: Path, catalog: list[dict]) -> list[Path]:
    root = directory / '.agents/skills'
    if any((path.exists() or path.is_symlink()) and _is_link(path) for path in (root.parent, root)):
        raise ProjectError('技能快照目录不能是符号链接。')
    if root.is_dir():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    for item in catalog:
        source = Path(item['filePath']).parent
        if _is_link(Path(item['filePath'])):
            raise ProjectError('技能入口不能是符号链接。')
        name = item['name']
        if name in {'.', '..'} or Path(name).name != name or '\\' in name:
            raise ProjectError('技能名称不能包含路径。')
        destination = root / name
        copy_skill_tree(source, destination)
    return [path for path in root.iterdir() if path.is_dir()]
