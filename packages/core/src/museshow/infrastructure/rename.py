"""Rename a file or directory without replacing an existing destination."""

import ctypes
import errno
import os
from pathlib import Path
import platform

from museshow.domain.projects import ProjectError


def rename_path(source: Path, target: Path) -> None:
    system = platform.system()
    if system == "Windows":
        try:
            os.rename(source, target)  # Windows rejects an existing destination.
        except FileExistsError:
            raise ProjectError("目标目录已存在，未覆盖任何文件。", 409) from None
        return
    library = ctypes.CDLL(None, use_errno=True)
    try:
        if system == "Darwin":
            call = library.renamex_np
            call.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
            arguments = (os.fsencode(source), os.fsencode(target), 4)  # RENAME_EXCL
        else:
            call = library.renameat2
            call.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
            arguments = (-100, os.fsencode(source), -100, os.fsencode(target), 1)  # AT_FDCWD, RENAME_NOREPLACE
    except AttributeError:
        raise ProjectError("该系统缺少安全重命名接口，项目目录未修改。", 503) from None
    call.restype = ctypes.c_int
    if call(*arguments) != 0:
        error = ctypes.get_errno()
        if error == errno.EEXIST:
            raise ProjectError("目标目录已存在，未覆盖任何文件。", 409)
        if error in {errno.ENOSYS, errno.EINVAL, errno.ENOTSUP}:
            _rename_without_flags(source, target)
            return
        raise OSError(error, os.strerror(error), str(target))


def _rename_without_flags(source: Path, target: Path) -> None:
    """Fallback for filesystems without RENAME_NOREPLACE, such as NFS.

    A file is hard-linked to the target, which fails on an existing name, and
    then unlinked. A directory cannot be linked; its target is checked first,
    so callers keep holding the project lock that serializes these renames.
    """
    if not source.is_dir() or source.is_symlink():
        try:
            os.link(source, target)
        except FileExistsError:
            raise ProjectError("目标目录已存在，未覆盖任何文件。", 409) from None
        except OSError as error:
            if error.errno in {errno.EPERM, errno.ENOTSUP, errno.EXDEV}:
                raise ProjectError("该文件系统不支持安全重命名，项目文件已保留。", 503) from None
            raise
        os.unlink(source)
        return
    if os.path.lexists(target):
        raise ProjectError("目标目录已存在，未覆盖任何文件。", 409)
    os.rename(source, target)
