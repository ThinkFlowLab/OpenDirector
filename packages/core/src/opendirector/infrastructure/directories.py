"""Directory fsync and symlink checks shared by project storage."""
import os
from pathlib import Path

from opendirector.domain.projects import ProjectError


def sync_directory(path: Path):
    # Windows does not expose directory fsync through os.open.
    if os.name == 'nt':
        return
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def directory(path: Path):
    if path.is_symlink() or path.resolve() != path:
        raise ProjectError('工程存储目录不能是符号链接。', 409, code='storage_unavailable')
    if path.exists() and not path.is_dir():
        raise ProjectError('工程存储目录被文件占用。', 409, code='storage_unavailable')
    return path
