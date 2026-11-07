"""Publish execution files through the shared asset staging and commit services."""
from contextlib import ExitStack, contextmanager
import os
from pathlib import Path
import stat

from opendirector.domain.creation.project import ProjectSnapshot
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.creation_files import CHUNK_BYTES
from opendirector.infrastructure.creation_uploads import asset_name


@contextmanager
def execution_file(execution_directory: Path, path: str, *, create=False):
    """Open one ordinary file under host-owned work, rejecting symlink traversal."""
    if os.open not in os.supports_dir_fd or not hasattr(os, 'O_NOFOLLOW'):
        raise ProjectError('当前平台不支持安全的执行产物文件读取。', 501)
    work = execution_directory.resolve()
    candidate = Path(path)
    candidate = candidate if candidate.is_absolute() else work / candidate
    candidate = Path(os.path.abspath(candidate))
    if not candidate.is_relative_to(work) or candidate == work:
        raise ProjectError('只能发布本轮执行目录中的文件。', 403)
    with ExitStack() as stack:
        descriptor = os.open(work, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        stack.callback(os.close, descriptor)
        parts = candidate.relative_to(work).parts
        for part in parts[:-1]:
            descriptor = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            stack.callback(os.close, descriptor)
        flags = (os.O_WRONLY | os.O_CREAT | os.O_EXCL) if create else (os.O_RDONLY | os.O_NONBLOCK)
        file_descriptor = os.open(parts[-1], flags | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
        stack.callback(os.close, file_descriptor)
        facts = os.fstat(file_descriptor)
        if not stat.S_ISREG(facts.st_mode) or (not create and facts.st_size == 0):
            raise ProjectError('发布产物必须是非空普通文件。')
        stream = stack.enter_context(os.fdopen(os.dup(file_descriptor), 'wb' if create else 'rb'))
        try:
            yield stream
            if create:
                stream.flush()
                os.fsync(stream.fileno())
        except BaseException:
            if create:
                os.unlink(parts[-1], dir_fd=descriptor)
            raise


def publish_artifact(assets, command, *, execution_directory: Path, session, provenance, source='agent'):
    """The host supplies the execution directory; command payloads cannot choose it."""
    project_id, request = command.projectId, command.payload
    projects = assets.projects
    replay = projects.replay(command)
    if replay is not None:
        return replay
    with projects.local.transaction() as db:
        projects._recover()
        directory, _, records = projects._load(db, project_id)
        projects._lease(db, project_id, directory, session)
        snapshot = records[0].snapshot
        for reference in request.sources:
            assets._reference(snapshot, reference)
    name = asset_name(request.name)
    key = command.commandId
    with execution_file(execution_directory, request.path) as stream:
        facts = os.fstat(stream.fileno())
        writer = assets.uploads.begin(project_id, key, session, name, expected_kind=request.expectedKind)
        try:
            while chunk := stream.read(CHUNK_BYTES):
                writer.write(chunk)
            after = os.fstat(stream.fileno())
            if (facts.st_size, facts.st_mtime_ns, facts.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ProjectError('发布期间文件发生变化，请等待文件写入完成后重试。', 409)
            writer.finish()
        finally:
            writer.abort()
        def attach(before, asset):
            for reference in request.sources:
                assets._reference(before, reference)
            return ProjectSnapshot.model_validate({**before.model_dump(), 'assets': [*before.assets, asset]})
        return assets.register(command, session=session, source=source, provenance=provenance.model_copy(update={'sources': request.sources}),
            apply=attach, upload_handle=key)
