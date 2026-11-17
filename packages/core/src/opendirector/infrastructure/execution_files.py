"""Open ordinary execution files without following untrusted path components."""
from contextlib import ExitStack, contextmanager
import os
from pathlib import Path
import stat

from opendirector.domain.projects import ProjectError


@contextmanager
def _posix_file(work, parts, create):
    if os.open not in os.supports_dir_fd or not hasattr(os, 'O_NOFOLLOW'):
        raise ProjectError('当前平台不支持安全的执行产物文件读取。', 501)
    with ExitStack() as stack:
        # The filesystem root is the anchor. Opening an absolute work path
        # directly would still follow links in its ancestors. Retain every
        # descriptor so replacing a directory cannot retarget later lookups.
        parent = os.open(work.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        stack.callback(os.close, parent)
        for part in (*work.parts[1:], *parts[:-1]):
            parent = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            stack.callback(os.close, parent)
        flags = (os.O_WRONLY | os.O_CREAT | os.O_EXCL) if create else (os.O_RDONLY | os.O_NONBLOCK)
        fd = os.open(parts[-1], flags | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        stack.callback(os.close, fd)
        facts = os.fstat(fd)
        if not stat.S_ISREG(facts.st_mode) or (not create and facts.st_size == 0):
            raise ProjectError('发布产物必须是非空普通文件。')
        duplicate = os.dup(fd)
        try:
            stream = os.fdopen(duplicate, 'wb' if create else 'rb')
        except BaseException:
            # fdopen does not take ownership when construction fails.
            os.close(duplicate)
            raise
        # POSIX permits renaming an open output. Its pathname may now name
        # another writer's file; even stat-then-unlink cannot atomically prove
        # ownership. Preserve possible partial output on failure and never
        # delete by that name. Exclusive creation also protects later retries.
        with stream:
            yield stream


@contextmanager
def execution_file(execution_directory: Path, path: str, *, create=False):
    """The host supplies the root; callers may only open descendants of it.

    Pin the execution root and user directory components for the operation.
    Both implementations open its ancestry without links; after binding the
    root Windows releases lookup-only ancestors to permit project commits.
    Outputs are created exclusively. Failed POSIX writes may leave a partial
    file; inspect it and use a new output name rather than overwriting on retry.
    """
    # Do not resolve the execution root: it is a lexical authorization boundary,
    # not permission to follow a replacement symlink/junction. Both backends
    # open its entire directory chain from the filesystem anchor without links.
    # Host-created project paths are canonical already (LocalProjects); aliases
    # supplied later are rejected instead of silently changing the boundary.
    work = Path(os.path.abspath(execution_directory))
    candidate = Path(path)
    if os.name == 'nt':
        from opendirector.infrastructure.windows_execution_files import validate_path
        validate_path(execution_directory)
        validate_path(work)
        validate_path(candidate)
    candidate = candidate if candidate.is_absolute() else work / candidate
    candidate = Path(os.path.abspath(candidate))
    if not candidate.is_relative_to(work) or candidate == work:
        raise ProjectError('只能发布本轮执行目录中的文件。', 403)
    parts = candidate.relative_to(work).parts
    if os.name == 'nt':
        from opendirector.infrastructure.windows_execution_files import open_file
    else:
        open_file = _posix_file
    with open_file(work, parts, create) as stream:
        facts = os.fstat(stream.fileno())
        if not stat.S_ISREG(facts.st_mode) or (not create and facts.st_size == 0):
            raise ProjectError('发布产物必须是非空普通文件。')
        if facts.st_nlink != 1:
            raise ProjectError('执行文件不能包含硬链接。', 403, code='execution_file_link')
        yield stream
        if create:
            stream.flush()
            os.fsync(stream.fileno())
