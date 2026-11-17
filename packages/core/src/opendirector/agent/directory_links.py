"""Directory aliases inside private Harness workspaces."""
import os
from pathlib import Path
import stat


def link_directory(path: Path, target: Path) -> None:
    # Targets are prepared private directories. Never replace an existing path.
    if os.name == 'nt':
        import _winapi
        _winapi.CreateJunction(str(target.resolve(strict=True)), str(path))
    else:
        path.symlink_to(target, target_is_directory=True)


def unlink_directory(path: Path) -> None:
    """Remove only the alias, including a dangling Windows junction."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISLNK(info.st_mode):
        path.unlink()
    elif os.name == 'nt' and info.st_reparse_tag == stat.IO_REPARSE_TAG_MOUNT_POINT:
        path.rmdir()
    else:
        raise FileExistsError(f'Refusing to replace a non-link directory: {path}')
