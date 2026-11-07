"""Shared C04 asset registration for uploads, text and trusted media outputs."""
from collections import OrderedDict
from io import BytesIO
import os
import subprocess
import shutil
from tempfile import TemporaryDirectory
from pathlib import Path
from threading import Lock
from uuid import UUID, uuid5

from opendirector.domain.creation.assets import Asset, AssetProvenance
from opendirector.domain.creation.project import ProjectSnapshot
from opendirector.domain.creation.validation import ContractError
from opendirector.domain.projects import ProjectError
from opendirector.ports.files import (
    AssetFileWrite, CHUNK_BYTES, MAX_CREATION_TEXT_BYTES, stream_identity,
)
from opendirector.ports.gateway import gateway


class CreationAssets:
    def __init__(self, projects):
        self.projects = projects
        self.uploads = gateway().uploads(projects)
        self._verified = OrderedDict()
        self._verification_lock = Lock()
        self._thumbnails = OrderedDict()

    def stage_copy(self, project_id, handle, session, source_project_id, source_asset_id, fingerprint=None):
        """Stage another project's verified asset as an upload; its bytes never leave the server.

        Registration still goes through asset.import, so the copy is an ordinary
        upload in the target project and keeps none of the source's provenance.
        A caller that already holds the bytes passes their fingerprint, so a
        changed source is refused instead of copied.
        """
        stream, asset = self.open_media(source_project_id, source_asset_id)
        with stream:
            if fingerprint is not None and fingerprint != asset.fingerprint:
                raise ProjectError('来源素材已变化。', 409)
            writer = self.uploads.begin(project_id, handle, session, asset.name, expected_kind=asset.kind)
            try:
                while chunk := stream.read(1024 * 1024):
                    writer.write(chunk)
                return writer.finish()
            finally:
                writer.abort()

    def reference_available(self, project_id, asset_id, *, snapshot=None):
        stream, asset = self.open_media(project_id, asset_id, snapshot=snapshot)
        with stream:
            if asset.kind == 'text' and not stream.read().decode('utf-8-sig').strip():
                raise ContractError('reference_invalid', '空白文本不能作为参考。', asset.id)
        return asset

    def execute(self, command, *, session=None, source='ui', provenance=None, imported_from=None):
        replay = self.projects.replay(command)
        if replay is not None:
            return replay
        if command.type == 'asset.import':
            if provenance is None and imported_from is not None:
                # A canvas archive carried this media in with its own recorded
                # source. Mark it as imported rather than fabricating a job.
                provenance = AssetProvenance(source='imported', importedFrom=imported_from)
            return self.register(command, session=session, source=source, provenance=provenance)
        if imported_from is not None:
            raise ProjectError('只有素材导入可以声明归档来源。', 400, code='invalid_input')
        if command.type == 'asset.writeText':
            return self.write_text(command, session=session, source=source, provenance=provenance)
        if command.type == 'asset.updateMetadata':
            def update(before):
                asset = self._asset(before, command.payload.assetId)
                name = gateway().asset_name(command.payload.name)
                if name == asset.name:
                    return before
                data = before.model_dump()
                data['assets'] = [({**item.model_dump(), 'name': name, 'revision': item.revision + 1})
                                  if item.id == asset.id else item for item in before.assets]
                return ProjectSnapshot.model_validate(data)
            return self.projects.commit(command, update, session=session, source=source)
        raise ProjectError('该素材命令尚未实现。', 501, code='capability_unsupported')

    @staticmethod
    def _asset(snapshot, asset_id):
        asset = next((asset for asset in snapshot.assets if asset.id == UUID(str(asset_id))), None)
        if asset is None:
            raise ContractError('missing_object', 'Asset does not exist in this project', UUID(str(asset_id)))
        return asset

    @classmethod
    def _reference(cls, snapshot, reference):
        asset = cls._asset(snapshot, reference.assetId)
        if (asset.kind != reference.kind or asset.fingerprint != reference.fingerprint
                or asset.revision < reference.revision):
            raise ContractError('reference_invalid', 'Asset reference differs from its content', asset.id)
        return asset

    def register(self, command, *, session=None, source='ui', provenance=None, apply=None, upload_handle=None):
        """Trusted services may supply provenance and atomically update jobs/editors.

        HTTP never accepts these extra arguments. Generated/edited outputs
        must have real job/document evidence validated by ProjectSnapshot.
        """
        replay = self.projects.replay(command)
        if replay is not None:
            return replay
        payload = command.payload
        if command.type != 'asset.import' and not (command.type == 'artifact.publish' and upload_handle is not None):
            raise ProjectError('文件登记需要素材导入命令。')
        handle = payload.uploadHandle if command.type == 'asset.import' else upload_handle
        with self.uploads.lock(command.projectId, handle):
            _, owner, record = self.uploads.ready(command.projectId, handle, session)
            asset = Asset(id=gateway().upload_asset_id(command.projectId, handle), projectId=command.projectId,
                kind=record.kind, name=gateway().asset_name(payload.name), fingerprint=record.fingerprint,
                path=f'assets/{gateway().upload_asset_id(command.projectId, handle)}', metadata=record.metadata,
                provenance=provenance or AssetProvenance(source='upload'))
            def register(before):
                if payload.expectedKind is not None and payload.expectedKind != record.kind:
                    raise ContractError('invalid_input', 'Uploaded media kind differs from the command')
                existing = next((item for item in before.assets if item.id == asset.id), None)
                if existing:
                    if (existing.fingerprint, existing.kind, existing.provenance) != (asset.fingerprint, asset.kind, asset.provenance):
                        raise ContractError('invalid_input', 'Upload identity is already used by another asset', asset.id)
                    return before
                data = before.model_dump()
                data['assets'] = [*before.assets, asset]
                after = ProjectSnapshot.model_validate(data) if apply is None else apply(before, asset)
                if not any(item == asset for item in after.assets):
                    raise ContractError('invalid_input', 'Output registration must include its inspected asset', asset.id)
                return after
            write = AssetFileWrite(assetId=asset.id, uploadHandle=handle, fingerprint=asset.fingerprint, size=asset.metadata.size)
            return self.projects.commit(command, register, session=session, source=source, files=(write,))

    def write_text(self, command, *, session=None, source='ui', provenance=None):
        replay = self.projects.replay(command)
        if replay is not None:
            return replay
        payload = command.payload
        name = gateway().asset_name(payload.name)
        if Path(name).suffix.lower() not in {'.txt', '.md'}:
            raise ProjectError('文本素材名称需以 .txt 或 .md 结尾。')
        content = payload.text.encode('utf-8')
        if len(content) > MAX_CREATION_TEXT_BYTES:
            raise ProjectError('文本素材应不超过 1 MiB（按 UTF-8 字节计算）。', 413)
        handle = uuid5(command.commandId, 'text-upload')
        writer = self.uploads.begin(command.projectId, handle, session, name, expected_kind='text',
                                    trusted=source in {'background', 'external'})
        try:
            writer.write(content)
            writer.finish()
        finally:
            writer.abort()
        # Text and imported bytes share the same stable file registration path.
        with self.uploads.lock(command.projectId, handle):
            _, _, record = self.uploads.ready(command.projectId, handle, session)
            previous = payload.previousAsset
            actual_provenance = provenance or AssetProvenance(source='manual', sources=(previous,) if previous else ())
            if previous and previous not in actual_provenance.sources:
                actual_provenance = AssetProvenance.model_validate({**actual_provenance.model_dump(),
                    'sources': (*actual_provenance.sources, previous)})
            asset_id = gateway().upload_asset_id(command.projectId, handle)
            asset = Asset(id=asset_id, projectId=command.projectId, name=name, kind='text', metadata=record.metadata,
                          fingerprint=record.fingerprint, path=f'assets/{asset_id}', provenance=actual_provenance)
            def save(before):
                if previous and self._reference(before, previous).kind != 'text':
                    raise ContractError('invalid_input', 'Only text assets can be revised as text', previous.assetId)
                return ProjectSnapshot.model_validate({**before.model_dump(), 'assets': [*before.assets, asset]})
            write = AssetFileWrite(assetId=asset.id, uploadHandle=handle, fingerprint=asset.fingerprint, size=asset.metadata.size)
            receipt = self.projects.commit(command, save, session=session, source=source, files=(write,))
        if receipt.status == 'rejected':
            try:
                self.uploads.cancel(command.projectId, handle, session)
            except (OSError, ProjectError):
                pass
        return receipt

    def stage_output(self, project_id, handle, name, source_path, *, expected_kind):
        """Local path is supplied by trusted Python code, never an HTTP payload."""
        path = Path(source_path)
        if path.is_symlink() or not path.is_file():
            raise ProjectError('输出文件必须是实际本地文件。', 409)
        writer = self.uploads.begin(project_id, handle, None, name, expected_kind=expected_kind, trusted=True)
        try:
            with path.open('rb') as stream:
                while chunk := stream.read(CHUNK_BYTES):
                    writer.write(chunk)
            return writer.finish()
        finally:
            writer.abort()

    def list(self, project_id):
        return self.projects.snapshot(project_id).assets

    def get(self, project_id, asset_id):
        try:
            return self._asset(self.projects.snapshot(project_id), asset_id)
        except ContractError:
            raise ProjectError('素材不在当前工程中。', 404) from None

    def open_media(self, project_id, asset_id, *, snapshot=None):
        """Pin the descriptor under the catalog lock, then verify outside it.

        Trusted queries may reuse a snapshot verified earlier in the same read.
        Resolve the current path under the lock even then: a project rename must
        never retarget media. No HTTP parameter can supply this read basis.
        """
        with self.projects.local.transaction() as db:
            self.projects._recover()
            if snapshot is None:
                path, _, records = self.projects._load(db, project_id)
                snapshot = records[0].snapshot
            else:
                if snapshot.project.id != UUID(str(project_id)):
                    raise ProjectError('素材读取快照不属于当前工程。', 409)
                path, _ = self.projects._find(db, project_id)
            try:
                asset = self._asset(snapshot, asset_id)
            except ContractError:
                raise ProjectError('素材不在当前工程中。', 404) from None
            file = gateway().child(gateway().directory(gateway().child(path, 'assets')), str(asset.id))
            try:
                stream = os.fdopen(os.open(file, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)), 'rb')
            except FileNotFoundError:
                raise ProjectError('素材文件缺失，元信息与历史已保留，请恢复文件。', 409, code='storage_unavailable') from None
        try:
            def signature():
                stat = os.fstat(stream.fileno())
                return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns
            before = signature()
            key = (asset.projectId, asset.id, asset.fingerprint, before)
            with self._verification_lock:
                verified = key in self._verified
            if not verified and (stream_identity(stream) != (asset.fingerprint, asset.metadata.size) or signature() != before):
                raise ProjectError('素材文件内容已变化，已阻止返回错误媒体。', 409, code='storage_unavailable')
            with self._verification_lock:
                self._verified[key] = True
                self._verified.move_to_end(key)
                while len(self._verified) > 128:
                    self._verified.popitem(last=False)
            stream.seek(0)
            return stream, asset
        except BaseException:
            stream.close()
            raise

    def preview(self, project_id: UUID, asset_id: UUID, target: Path) -> dict:
        stream, asset = self.open_media(project_id, asset_id)
        with stream:
            target = gateway().directory(target)
            target.mkdir(parents=True, exist_ok=True)
            stem = f'{asset.id}-{asset.fingerprint.removeprefix("sha256:")}'
            if asset.kind == 'image':
                content, _ = self.thumbnail(project_id, asset_id)
                output, mime = gateway().child(target, stem + '.webp'), 'image/webp'
                output.write_bytes(content)
            elif asset.kind in {'video', 'audio'}:
                output = gateway().child(target, stem + ('.jpg' if asset.kind == 'video' else '.wav'))
                command = ['ffmpeg', '-nostdin', '-v', 'error', '-y']
                if asset.kind == 'video':
                    command += ['-vf', "scale='min(960,iw)':-2", '-frames:v', '1', '-q:v', '3']
                    mime = 'image/jpeg'
                else:
                    command += ['-t', '30', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le']
                    mime = 'audio/wav'
                try:
                    with TemporaryDirectory(prefix='source-', dir=target) as temporary:
                        source = Path(temporary) / 'media'
                        with source.open('wb') as destination:
                            shutil.copyfileobj(stream, destination, length=1024 * 1024)
                        subprocess.run([*command[:5], '-i', str(source), *command[5:], str(output)],
                            capture_output=True, check=True, timeout=30)
                except (OSError, subprocess.SubprocessError) as error:
                    raise ProjectError('无法生成素材预览。', 422) from error
            elif asset.kind == 'text':
                return {'assetId': str(asset.id), 'kind': asset.kind,
                    'text': stream.read(65536).decode('utf-8', errors='replace'), 'truncated': asset.metadata.size > 65536}
            else:
                raise ProjectError('该素材类型不支持预览。', 422)
        return {'assetId': str(asset.id), 'kind': asset.kind, 'metadata': asset.metadata.model_dump(mode='json'),
            'preview': {'path': str(output.resolve()), 'mimeType': mime,
                'scope': 'first_frame' if asset.kind == 'video' else 'first_30_seconds' if asset.kind == 'audio' else 'thumbnail'}}

    def thumbnail(self, project_id, asset_id):
        """A bounded, disposable image preview; always verify its source first."""
        from PIL import Image, ImageOps
        stream, asset = self.open_media(project_id, asset_id)
        with stream:
            if asset.kind != 'image':
                raise ProjectError('只有图片素材支持缩略图。', 400)
            key = asset.fingerprint
            with self._verification_lock:
                cached = self._thumbnails.get(key)
                if cached is not None:
                    self._thumbnails.move_to_end(key)
                    return cached, asset
            with Image.open(stream) as source:
                source.thumbnail((480, 480))
                image = ImageOps.exif_transpose(source).convert('RGBA')
                output = BytesIO()
                image.save(output, format='WEBP', quality=80)
                value = output.getvalue()
            with self._verification_lock:
                self._thumbnails[key] = value
                while len(self._thumbnails) > 64:
                    self._thumbnails.popitem(last=False)
            return value, asset
