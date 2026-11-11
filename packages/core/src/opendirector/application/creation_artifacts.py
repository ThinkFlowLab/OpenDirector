"""Publish execution files through the shared asset staging and commit services."""
import os
from pathlib import Path

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
    name = gateway().asset_name(request.name)
    key = command.commandId
    with gateway().execution_file(execution_directory, request.path) as stream:
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
