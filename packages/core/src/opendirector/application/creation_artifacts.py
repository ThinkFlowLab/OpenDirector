"""Publish execution files through the shared asset staging and commit services."""
from contextlib import ExitStack
import os
from pathlib import Path
import stat

from opendirector.domain.creation.project import ProjectSnapshot
from opendirector.domain.projects import ProjectError
from opendirector.ports.files import CHUNK_BYTES
from opendirector.ports.gateway import gateway


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
    if os.open not in os.supports_dir_fd or not hasattr(os, 'O_NOFOLLOW'):
        raise ProjectError('当前平台不支持安全的执行产物文件读取。', 501)
    work = execution_directory.resolve()
    candidate = Path(request.path)
    candidate = candidate if candidate.is_absolute() else work / candidate
    # Normalize dot segments without following symlinks; the descriptor walk rejects links.
    candidate = Path(os.path.abspath(candidate))
    if not candidate.is_relative_to(work) or candidate == work:
        raise ProjectError('只能发布本轮执行目录中的文件。', 403)
    name = gateway().asset_name(request.name)
    key = command.commandId
    with ExitStack() as stack:
        descriptor = os.open(work, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        stack.callback(os.close, descriptor)
        parts = candidate.relative_to(work).parts
        for part in parts[:-1]:
            descriptor = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            stack.callback(os.close, descriptor)
        file_descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
        stack.callback(os.close, file_descriptor)
        facts = os.fstat(file_descriptor)
        if not stat.S_ISREG(facts.st_mode) or facts.st_size == 0:
            raise ProjectError('发布产物必须是非空普通文件。')
        stream = stack.enter_context(os.fdopen(os.dup(file_descriptor), 'rb'))
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
