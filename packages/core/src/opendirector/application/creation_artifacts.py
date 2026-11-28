"""Publish execution files through the shared asset staging and commit services."""
import os
from pathlib import Path

from opendirector.domain.creation.project import ProjectSnapshot
from opendirector.domain.creation.validation import ContractError
from opendirector.domain.projects import ProjectError
from opendirector.ports.files import CHUNK_BYTES
from opendirector.ports.gateway import gateway
from .creation_canvas import asset_ref, current_asset


def publish_artifact(assets, command, *, execution_directory: Path, session, provenance, source='agent'):
    """The host supplies the execution directory; command payloads cannot choose it."""
    project_id, request = command.projectId, command.payload
    projects = assets.projects
    replay = projects.replay(command)
    if replay is not None:
        return replay

    def validate_sources(snapshot):
        for reference in request.sources:
            assets._reference(snapshot, reference)
        if request.sourceItemId is None:
            return None
        item = next((item for item in snapshot.canvasItems if item.id == request.sourceItemId), None)
        asset = current_asset(snapshot, item) if item is not None else None
        if asset is None or asset.id != request.sourceAssetId:
            raise ContractError('reference_invalid', '来源节点当前显示的素材与准备派生产物时读取的素材不一致。', request.sourceItemId)
        return asset

    with projects.local.transaction() as db:
        projects._recover()
        directory, _, records = projects._load(db, project_id)
        projects._lease(db, project_id, directory, session)
        canvas_source = validate_sources(records[0].snapshot)
    sources = request.sources
    if canvas_source is not None and all(reference.assetId != canvas_source.id for reference in sources):
        sources = (*sources, asset_ref(canvas_source))
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
            validate_sources(before)
            return ProjectSnapshot.model_validate({**before.model_dump(), 'assets': [*before.assets, asset]})
        return assets.register(command, session=session, source=source, provenance=provenance.model_copy(
            update={'sources': sources, 'sourceItemId': request.sourceItemId}),
            apply=attach, upload_handle=key)
