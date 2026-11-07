"""Project/session-scoped streaming staging; no project facts before commit."""
import hashlib
import os
from pathlib import Path
import tempfile
from uuid import UUID, uuid5

from filelock import FileLock
from PIL import Image, UnidentifiedImageError

from pydantic import Field

from opendirector.domain.creation.assets import MediaMetadata, UploadInfo
from opendirector.domain.creation.base import Contract, Fingerprint, MediaKind
from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.creation_files import file_identity, upload_directory
from opendirector.ports.files import MAX_CREATION_ASSET_BYTES, MAX_CREATION_TEXT_BYTES
from opendirector.infrastructure.creation_projects import directory, durable_json, sync_directory
from opendirector.infrastructure.local_projects import child, read_json
from opendirector.infrastructure.rename import rename_path
from opendirector.media.probe import probe_file


def asset_name(value):
    value = value.strip()
    if not value or len(value) > 255 or any(ord(char) < 32 or char in '/\\' for char in value):
        raise ProjectError('素材名称不能为空，最长 255 字符，且不能包含路径或控制字符。')
    return value


def upload_asset_id(project_id, handle):
    return uuid5(UUID(str(project_id)), 'upload:' + str(handle))


class UploadOwner(Contract):
    projectId: UUID = Field(description='Owning project ID.')
    id: UUID = Field(description='Stable object ID.')
    sessionId: UUID | None = Field(description='Owning editing session ID.')
    name: str = Field(description='User-visible name.')
    expectedKind: MediaKind | None = Field(default=None, description='Required media kind, when specified.')
    cancelled: bool = Field(default=False, description='Whether the staged upload was cancelled.')


class UploadRecord(Contract):
    kind: MediaKind = Field(description='Business object or media type.')
    fingerprint: Fingerprint = Field(description='Immutable content fingerprint.')
    metadata: MediaMetadata = Field(description='Verified media properties.')


def inspect_file(path: Path, name: str, *, expected_kind=None):
    """Reuse OpenDirector media limits and ffprobe, while keeping large files on disk."""
    suffix = Path(name).suffix.lower()
    size = path.stat().st_size
    if suffix in {'.txt', '.md'} or expected_kind == 'text':
        if size > MAX_CREATION_TEXT_BYTES:
            raise ProjectError('文本素材应不超过 1 MiB。', 413)
        try:
            text = path.read_text(encoding='utf-8-sig')
        except UnicodeDecodeError:
            raise ProjectError('文本素材需使用 UTF-8 编码。') from None
        if any(ord(char) < 32 and char not in '\t\r\n' for char in text):
            raise ProjectError('文件包含非文本内容，请导入 UTF-8 文本。')
        return 'text', MediaMetadata(size=size, mimeType='text/markdown' if suffix == '.md' else 'text/plain')
    with path.open('rb') as stream:
        prefix = stream.read(16)
    image_bytes = (prefix.startswith((b'\x89PNG\r\n\x1a\n', b'\xff\xd8\xff', b'GIF87a', b'GIF89a'))
                   or prefix.startswith(b'RIFF') and prefix[8:12] == b'WEBP')
    if suffix in {'.png', '.jpg', '.jpeg', '.gif', '.webp'} or image_bytes or expected_kind == 'image':
        try:
            with Image.open(path, formats=['PNG', 'JPEG', 'GIF', 'WEBP']) as image:
                if image.width * image.height > 25_000_000:
                    raise ProjectError('图片像素总数应不超过 2500 万。', 413)
                metadata = MediaMetadata(size=size, mimeType=Image.MIME[image.format], width=image.width, height=image.height)
                image.load()
            return 'image', metadata
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
            raise ProjectError('无法读取图片，请检查实际格式及完整性。') from None
    kind = ('video' if suffix in {'.mp4', '.mov', '.webm'} else
            'audio' if suffix in {'.mp3', '.wav', '.m4a', '.ogg', '.flac'} else
            expected_kind if expected_kind in {'video', 'audio'} else None)
    if kind:
        value = probe_file(path, kind, include_container=True)
        container = value.pop('container')
        brand = value.pop('majorBrand')
        mime = ('audio/wav' if container == 'wav' else 'audio/mpeg' if container == 'mp3' else
                'audio/flac' if container == 'flac' else f'{kind}/ogg' if container == 'ogg' else
                f'{kind}/webm' if container == 'matroska,webm' else
                'video/quicktime' if brand == 'qt' else f'{kind}/mp4' if 'mp4' in container else None)
        if mime is None:
            raise ProjectError('媒体容器格式不受支持。')
        value.pop('kind')
        value.pop('durationMs')
        try:
            return kind, MediaMetadata(size=size, mimeType=mime, **value)
        except ValueError:
            raise ProjectError('媒体尺寸、时长或音频信息无效，请检查文件。') from None
    with path.open('rb') as stream:
        mime = 'application/pdf' if stream.read(5) == b'%PDF-' else 'application/octet-stream'
    return 'file', MediaMetadata(size=size, mimeType=mime)


class CreationUploads:
    def __init__(self, projects):
        self.projects = projects

    def lock(self, project_id, handle):
        project_id, handle = UUID(str(project_id)), UUID(str(handle))
        path = child(directory(self.projects.state_dir), f'creation-upload-{project_id}-{handle}.lock')
        return FileLock(path, timeout=0, thread_local=False)

    def _scope(self, db, project_id, session, trusted=False):
        self.projects._recover()
        path, _, records = self.projects._load(db, project_id)
        if not trusted:
            self.projects._lease(db, project_id, path, session)
        return records[0].snapshot

    def _owner(self, folder, project_id, handle, session):
        try:
            owner = UploadOwner.model_validate(read_json(child(folder, 'owner.json')))
        except (FileNotFoundError, ValueError, TypeError):
            raise ProjectError('上传句柄不存在或无法读取。', 404) from None
        if owner.projectId != UUID(str(project_id)) or owner.id != UUID(str(handle)) or str(owner.sessionId) != str(session):
            raise ProjectError('上传句柄不属于当前工程或会话。', 409)
        return owner

    def begin(self, project_id, handle, session, name, *, expected_kind=None, trusted=False):
        project_id, handle = UUID(str(project_id)), UUID(str(handle))
        owner = UploadOwner(projectId=project_id, id=handle, sessionId=session, name=asset_name(name), expectedKind=expected_kind)
        lock = self.lock(project_id, handle)
        lock.acquire()
        try:
            with self.projects.local.transaction() as db:
                self._scope(db, project_id, session, trusted)
                folder = upload_directory(self.projects.state_dir, project_id, handle)
                for parent in [folder.parent.parent, folder.parent, folder]:
                    directory(parent).mkdir(mode=0o700, exist_ok=True)
                    sync_directory(parent.parent)
                owner_path = child(folder, 'owner.json')
                if owner_path.exists():
                    current = self._owner(folder, project_id, handle, session)
                    if current.cancelled or current != owner:
                        raise ProjectError('上传句柄已取消或已用于不同输入，请使用新的句柄。', 409)
                else:
                    durable_json(owner_path, owner.model_dump(mode='json'))
                # Only this locked handle's interrupted request files are ours.
                for abandoned in folder.glob('.partial-*'):
                    child(folder, abandoned.name).unlink()
            return UploadWriter(self, folder, owner, lock, trusted)
        except BaseException:
            lock.release()
            raise

    def _info(self, owner, snapshot, record=None):
        asset_id = upload_asset_id(owner.projectId, owner.id)
        registered = next((asset for asset in snapshot.assets if asset.id == asset_id), None)
        return UploadInfo(id=owner.id, projectId=owner.projectId, name=owner.name,
            status='cancelled' if owner.cancelled else 'registered' if registered else 'ready' if record else 'uploading',
            kind=record.kind if record else None, fingerprint=record.fingerprint if record else None,
            metadata=record.metadata if record else None, assetId=asset_id if registered and not owner.cancelled else None)

    def info(self, project_id, handle, session):
        with self.lock(project_id, handle), self.projects.local.transaction() as db:
            snapshot = self._scope(db, project_id, session)
            folder = upload_directory(self.projects.state_dir, UUID(str(project_id)), UUID(str(handle)))
            owner = self._owner(folder, project_id, handle, session)
            file = child(folder, 'ready.json')
            try:
                record = UploadRecord.model_validate(read_json(file)) if file.exists() else None
                return self._info(owner, snapshot, record)
            except (ValueError, TypeError):
                raise ProjectError('上传记录无效，原文件已保留。', 409, code='storage_unavailable') from None

    def ready(self, project_id, handle, session):
        folder = upload_directory(self.projects.state_dir, UUID(str(project_id)), UUID(str(handle)))
        owner = self._owner(folder, project_id, handle, session)
        if owner.cancelled:
            raise ProjectError('上传句柄已取消。', 409)
        try:
            record = UploadRecord.model_validate(read_json(child(folder, 'ready.json')))
        except (FileNotFoundError, ValueError, TypeError):
            raise ProjectError('上传尚未完成或已损坏。', 409) from None
        return folder, owner, record

    def cancel(self, project_id, handle, session):
        with self.lock(project_id, handle), self.projects.local.transaction() as db:
            snapshot = self._scope(db, project_id, session)
            folder = upload_directory(self.projects.state_dir, UUID(str(project_id)), UUID(str(handle)))
            owner = self._owner(folder, project_id, handle, session)
            owner = owner.model_copy(update={'cancelled': True})
            durable_json(child(folder, 'owner.json'), owner.model_dump(mode='json'))
            for file in [child(folder, 'content'), *folder.glob('.partial-*')]:
                child(folder, file.name).unlink(missing_ok=True)
            sync_directory(folder)
            return self._info(owner, snapshot)


class UploadWriter:
    def __init__(self, uploads, folder, owner, lock, trusted):
        self.uploads, self.folder, self.owner, self.lock, self.trusted = uploads, folder, owner, lock, trusted
        fd, path = tempfile.mkstemp(prefix='.partial-', dir=folder)
        self.path, self.stream = Path(path), os.fdopen(fd, 'wb')
        self.digest, self.size, self.closed = hashlib.sha256(), 0, False

    def write(self, chunk):
        self.size += len(chunk)
        if self.size > MAX_CREATION_ASSET_BYTES:
            raise ProjectError('工程素材应不超过 512 MiB。', 413)
        self.digest.update(chunk)
        self.stream.write(chunk)

    def finish(self):
        try:
            self.stream.flush()
            os.fsync(self.stream.fileno())
            self.stream.close()
            kind, metadata = inspect_file(self.path, self.owner.name, expected_kind=self.owner.expectedKind)
            if self.owner.expectedKind is not None and kind != self.owner.expectedKind:
                raise ProjectError('文件实际类型与声明类型不一致。')
            record = UploadRecord(kind=kind, metadata=metadata, fingerprint='sha256:' + self.digest.hexdigest())
            with self.uploads.projects.local.transaction() as db:
                snapshot = self.uploads._scope(db, self.owner.projectId, str(self.owner.sessionId) if self.owner.sessionId else None, self.trusted)
                ready = child(self.folder, 'ready.json')
                if ready.exists():
                    if UploadRecord.model_validate(read_json(ready)) != record:
                        raise ProjectError('上传句柄已用于不同文件内容。', 409)
                    return self.uploads._info(self.owner, snapshot, record)
                content = child(self.folder, 'content')
                if content.exists():
                    if file_identity(content) != (record.fingerprint, record.metadata.size):
                        raise ProjectError('上传文件内容冲突，原文件已保留。', 409)
                else:
                    rename_path(self.path, content)
                    sync_directory(self.folder)
                durable_json(ready, record.model_dump(mode='json'))
                return self.uploads._info(self.owner, snapshot, record)
        finally:
            self.abort()

    def abort(self):
        if not self.closed:
            try:
                self.stream.close()
                self.path.unlink(missing_ok=True)
            finally:
                self.closed = True
                self.lock.release()
