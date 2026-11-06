"""Per-turn skill copies shared by native runtime adapters."""
from pathlib import Path
import shutil

from opendirector.domain.projects import ProjectError


def prepare_skills(directory: Path, catalog: list[dict]) -> list[Path]:
    root = directory / '.agents/skills'
    if root.parent.is_symlink() or root.is_symlink():
        raise ProjectError('技能快照目录不能是符号链接。')
    if root.is_dir():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    for item in catalog:
        source = Path(item['filePath']).parent
        if Path(item['filePath']).is_symlink():
            raise ProjectError('技能入口不能是符号链接。')
        name = item['name']
        if name in {'.', '..'} or Path(name).name != name or '\\' in name:
            raise ProjectError('技能名称不能包含路径。')
        destination = root / name
        shutil.copytree(source, destination,
            ignore=lambda parent, names: [name for name in names if Path(parent, name).is_symlink()])
    return [path for path in root.iterdir() if path.is_dir()]
