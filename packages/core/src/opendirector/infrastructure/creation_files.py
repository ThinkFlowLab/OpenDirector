"""Content verification and replayable file installs for creation commits."""
import hashlib
import os
from pathlib import Path
import tempfile
from uuid import UUID

from opendirector.domain.projects import ProjectError
from opendirector.infrastructure.directories import directory, sync_directory
from opendirector.infrastructure.local_projects import child
from opendirector.infrastructure.rename import rename_path
from opendirector.ports.files import CHUNK_BYTES, stream_identity


def delete_files(path, deletes):
    """Run only after manifest publication, retained in its recoverable intent."""
    assets = directory(child(path, 'assets'))
    for deletion in deletes:
        target = child(assets, str(deletion.assetId))
        if target.exists() or target.is_symlink():
            if file_identity(target) != (deletion.fingerprint, deletion.size):
                raise ProjectError('待删除文件内容已变化，文件及恢复日志已保留。', 409, code='storage_unavailable')
            target.unlink()
            sync_directory(assets)


def upload_directory(state_dir: Path, project_id: UUID, handle: UUID):
    parent = directory(child(state_dir, 'creation-uploads'))
    parent = directory(child(parent, str(project_id)))
    return directory(child(parent, str(handle)))


def file_identity(path):
    # child()/directory() protect the managed ancestors; O_NOFOLLOW also
    # protects the final open on platforms that support it.
    if path.is_symlink():
        raise ProjectError('素材文件不能是符号链接。', 409, code='storage_unavailable')
    with os.fdopen(os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)), 'rb') as stream:
        return stream_identity(stream)


def install_files(path, project_id, writes, state_dir, checkpoint):
    """Copy from retained staging before publishing metadata; never overwrite."""
    if not writes:
        return
    assets = directory(child(path, 'assets'))
    assets.mkdir(exist_ok=True)
    sync_directory(path)
    for write in writes:
        target = child(assets, str(write.assetId))
        expected = (write.fingerprint, write.size)
        if target.exists():
            if file_identity(target) != expected:
                raise ProjectError('素材文件与提交内容不一致，已阻止覆盖。', 409, code='storage_unavailable')
            continue
        source = child(upload_directory(state_dir, project_id, write.uploadHandle), 'content')
        if not source.is_file():
            raise ProjectError('待提交素材文件缺失，恢复日志已保留。', 409, code='storage_unavailable')
        fd, name = tempfile.mkstemp(prefix='.opendirector-asset-', dir=assets)
        temporary = Path(name)
        try:
            digest, size = hashlib.sha256(), 0
            with os.fdopen(fd, 'wb') as output, source.open('rb') as incoming:
                while chunk := incoming.read(CHUNK_BYTES):
                    digest.update(chunk)
                    size += len(chunk)
                    if size > write.size:
                        raise ProjectError('待提交文件内容已变化，原文件未覆盖。', 409, code='storage_unavailable')
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            if ('sha256:' + digest.hexdigest(), size) != expected:
                raise ProjectError('待提交文件内容已变化，原文件未覆盖。', 409, code='storage_unavailable')
            rename_path(temporary, target)
            sync_directory(assets)
            checkpoint('asset_installed')
        finally:
            temporary.unlink(missing_ok=True)


def cleanup_staging(project_id, writes, state_dir):
    for write in writes:
        folder = upload_directory(state_dir, project_id, write.uploadHandle)
        content = child(folder, 'content')
        if content.exists():
            content.unlink()
            sync_directory(folder)
