"""Render a planned source range and commit it through shared media publication."""
from shutil import copyfileobj
from uuid import uuid4, uuid5

from filelock import FileLock, Timeout

from opendirector.domain.creation.assets import Asset, AssetProvenance
from opendirector.domain.creation.canvas import VideoCanvasItem
from opendirector.domain.creation.commands import CanvasPublishMedia, MediaPublicationOutput
from opendirector.domain.creation.editors import MediaEditData, MediaEditDocument
from opendirector.domain.creation.project import ProjectSnapshot
from opendirector.domain.creation.validation import ContractError, validate_command
from opendirector.domain.projects import ProjectError
from opendirector.media.processing import Workspace, trim
from opendirector.ports.files import AssetFileWrite
from opendirector.ports.gateway import gateway
from .creation_canvas import CreationCanvas, asset_ref
from .creation_media_publication import media_edit_source, publish_media


class CreationVideoTrim:
    def __init__(self, projects):
        self.projects = projects
        self.canvas = CreationCanvas(projects)
        self.assets = self.canvas.assets

    def execute(self, command, *, session=None, source='ui'):
        lock = gateway().child(self.projects.state_dir, f'video-trim-{command.projectId}-{command.commandId}.lock')
        try:
            with FileLock(lock, timeout=0):
                replay = self.projects.replay(command)
                if replay is not None:
                    return replay
                return self._execute(command, session, source)
        except Timeout as error:
            raise ProjectError('此视频裁切正在进行，请等待结果。', 409) from error

    def _execute(self, command, session, source):
        project_id, request = command.projectId, command.payload
        if source in {'ui', 'agent'}:
            with self.projects.local.transaction() as db:
                path, _ = self.projects._find(db, project_id)
                self.projects._lease(db, project_id, path, session)
        snapshot = self.projects.snapshot(project_id)
        try:
            validate_command(command, snapshot)
            self.canvas._editable(snapshot.model_dump(mode='json'), request.sourceItemId)
            item = next(item for item in snapshot.canvasItems if item.id == request.sourceItemId)
            if not isinstance(item, VideoCanvasItem):
                raise ContractError('invalid_input', '视频裁切需要视频来源节点。', item.id)
            actual = media_edit_source(snapshot, item, request.source)
            if actual.metadata.durationSeconds is None or request.endSeconds > actual.metadata.durationSeconds:
                raise ContractError('invalid_input', '裁切结束时间超出来源视频时长。', item.id)
        except ContractError as error:
            def reject(_):
                raise error
            return self.projects.commit(command, reject, session=session, source=source)

        name = gateway().asset_name(request.name)
        handle = uuid4()
        with Workspace() as workspace:
            raw, output = workspace.path / 'source', workspace.path / 'trim.mp4'
            stream, _ = self.assets.open_media(project_id, actual.id, snapshot=snapshot)
            with stream, raw.open('wb') as target:
                copyfileobj(stream, target)
            trim(raw, request.endSeconds - request.startSeconds, output, start=request.startSeconds)
            upload = self.assets.stage_output(project_id, handle, name, output, expected_kind='video')

        asset_id = gateway().upload_asset_id(project_id, handle)
        staged = Asset(id=asset_id, projectId=project_id, kind='video', name=name, path=f'assets/{asset_id}',
            metadata=upload.metadata, fingerprint=upload.fingerprint, provenance=AssetProvenance(source='upload'))
        write = AssetFileWrite(assetId=asset_id, uploadHandle=handle, fingerprint=staged.fingerprint, size=staged.metadata.size)
        document = MediaEditDocument(id=uuid5(command.commandId, 'editor'), projectId=project_id, kind='media_edit',
            data=MediaEditData(tool='video-trim', sourceItems=(request.sourceItemId,), sources=(request.source,),
                parameters={'startSeconds': request.startSeconds, 'endSeconds': request.endSeconds}))

        def publish(before):
            data = before.model_dump(mode='json')
            self.canvas._get(data, 'canvas_item', request.sourceItemId)
            owner = next(item for item in before.canvasItems if item.id == request.sourceItemId)
            data['assets'].append(staged.model_dump(mode='json'))
            publication = CanvasPublishMedia(itemId=owner.id, source=request.source, document=document, outputs=(
                MediaPublicationOutput(itemId=uuid5(command.commandId, 'output'), asset=asset_ref(staged), title=name,
                    position={'x': owner.position.x + owner.width + 48, 'y': owner.position.y}),))
            publish_media(self.canvas, data, publication, staged={asset_id})
            return ProjectSnapshot.model_validate(data)

        receipt = self.projects.commit(command, publish, session=session, source=source, files=(write,))
        # An unknown commit can own the file. Only discard after a definite rejection.
        if receipt.status in {'rejected', 'noop'}:
            self.projects.discard_uncommitted_files(project_id, (write,))
        return receipt
