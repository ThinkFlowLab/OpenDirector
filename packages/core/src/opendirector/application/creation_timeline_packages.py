"""One native bundle service for UI/API and execution-scoped Agent tools.

Archive members are untrusted. No archive path is ever used as an extraction
path; generated temporary filenames hold bounded, CRC/hash-verified bytes.
Only normal asset commands and a final creation.batch change project facts.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import struct
import tempfile
from uuid import UUID, uuid5
import zipfile

from pydantic import ValidationError
from opendirector.application.creation_assets import CreationAssets
from opendirector.application.creation_canvas import asset_ref
from opendirector.domain.creation.assets import AssetRef
from opendirector.domain.creation.commands import parse_command
from opendirector.domain.creation.editors import TimelineData
from opendirector.domain.creation.timeline_packages import (TimelinePackageManifest, TimelinePackageResource,
    TimelinePackageImportRequest, TimelinePackageImportReceipt)
from opendirector.domain.projects import ProjectError
from opendirector.domain.timeline_errors import timeline_error, timeline_error_message
from opendirector.domain.rule_facts import TIMELINE_DURATION_EPSILON, TIMELINE_FONT_TOTAL_BYTES
from opendirector.ports.files import CHUNK_BYTES
from opendirector.ports.gateway import gateway
from opendirector.installation import default_timeline_font
from opendirector.media.fonts import FONT_MIMES, require_font_characters

MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024
MAX_ENTRIES = 4096
MAX_JSON_BYTES = 16 * 1024 * 1024
LICENSE_PATH = 'licenses/NotoSansCJK-OFL.txt'
EXTENSIONS = {'font/otf': 'otf', 'font/ttf': 'ttf', 'text/plain': 'txt', 'text/markdown': 'md',
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/heic': 'heic', 'image/heif': 'heif',
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'audio/mp4': 'm4a',
    'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/flac': 'flac', 'audio/ogg': 'ogg', 'audio/webm': 'webm'}


def refs(data):
    values = [resource.asset for resource in data.importedAssets]
    values.extend(clip.resource.asset for track in data.tracks for clip in track.clips)
    values.extend(font.asset for font in data.fonts)
    values.extend(overlay.sourceAsset for overlay in data.overlays if overlay.sourceAsset)
    return tuple(dict.fromkeys(values))


def key(ref):
    return json.dumps(ref.model_dump(mode='json'), sort_keys=True, separators=(',', ':'))


def invalid():
    return timeline_error('timeline_package_invalid', 400)


class CreationTimelinePackages:
    def __init__(self, projects):
        self.projects = projects
        self.assets = CreationAssets(projects)
        self.imports = gateway().timeline_package_imports(projects)

    def export(self, project_id: UUID, editor_id: UUID, revision: int) -> Path:
        if type(revision) is not int or revision < 1:
            raise invalid()
        selected = next(((record.snapshot, doc) for record in self.projects.records(project_id)
            for doc in record.snapshot.editorDocuments if doc.id == UUID(str(editor_id)) and doc.revision == revision), None)
        if selected is None or selected[1].kind != 'timeline':
            raise timeline_error('timeline_revision_missing', 404)
        snapshot, document = selected
        resources = []
        for ref in refs(document.data):
            asset = self.assets._reference(snapshot, ref)
            extension = EXTENSIONS.get(asset.metadata.mimeType, 'bin')
            resources.append(TimelinePackageResource(source=ref, name=asset.name,
                path=f'assets/{asset.fingerprint[7:]}.{extension}', kind=asset.kind, mimeType=asset.metadata.mimeType,
                size=asset.metadata.size, fingerprint=asset.fingerprint))
        manifest = TimelinePackageManifest(resources=resources,
            requiredCapabilities=('timeline.text.v1',) if document.data.overlays or document.data.fonts else ())
        fd, name = tempfile.mkstemp(suffix='.timeline.zip')
        os.close(fd)
        target = Path(name)
        try:
            with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
                archive.writestr('manifest.json', manifest.model_dump_json())
                archive.writestr('timeline.json', document.data.model_dump_json())
                license_file = default_timeline_font().parent / 'LICENSE.txt'
                archive.writestr(LICENSE_PATH, license_file.read_bytes())
                written = set()
                for resource in resources:
                    if resource.path in written:
                        continue
                    if target.stat().st_size + resource.size > MAX_ARCHIVE_BYTES:
                        raise timeline_error('timeline_package_too_large', 413)
                    stream, _ = self.assets.open_media(project_id, resource.source.assetId, snapshot=snapshot)
                    with stream, archive.open(resource.path, 'w', force_zip64=True) as output:
                        shutil.copyfileobj(stream, output, CHUNK_BYTES)
                    written.add(resource.path)
            if target.stat().st_size > MAX_ARCHIVE_BYTES:
                raise timeline_error('timeline_package_too_large', 413)
            return target
        except BaseException:
            target.unlink(missing_ok=True)
            raise

    def export_execution_file(self, project_id, request, *, execution_directory):
        target = self.export(project_id, request.editorId, request.revision)
        try:
            with gateway().execution_file(execution_directory, request.path, create=True) as output, target.open('rb') as incoming:
                shutil.copyfileobj(incoming, output, CHUNK_BYTES)
            return dict(path=request.path, editorId=str(request.editorId), revision=request.revision)
        finally:
            target.unlink(missing_ok=True)

    def import_execution_file(self, project_id, request, *, execution_directory, session):
        handle = uuid5(request.operationId, 'archive-upload')
        value = TimelinePackageImportRequest(**request.model_dump(exclude={'path'}), uploadHandle=handle)
        # Replays use the durable fixed request and never need to reopen input bytes.
        prior = self.imports.read(project_id, request.operationId)
        if prior is not None:
            return self.import_package(project_id, value, session=session, source='agent')
        with gateway().execution_file(execution_directory, request.path) as stream:
            before = os.fstat(stream.fileno())
            writer = self.assets.uploads.begin(project_id, handle, session, 'package.timeline.zip', expected_kind='file')
            try:
                digest = hashlib.sha256()
                while chunk := stream.read(CHUNK_BYTES):
                    digest.update(chunk); writer.write(chunk)
                after = os.fstat(stream.fileno())
                if ((before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                        or 'sha256:' + digest.hexdigest() != request.archiveFingerprint):
                    raise invalid()
                writer.finish()
            finally:
                writer.abort()
        return self.import_package(project_id, value, session=session, source='agent')

    @staticmethod
    def _bounded_directory(path):
        """Bound central-directory work before ZipFile allocates entry objects.

        Native bundles fit ordinary single-disk EOCD limits. Per-file ZIP64
        headers emitted by zipfile remain supported; ZIP64 directories and
        multi-disk archives cannot be needed within our byte/entry budgets.
        """
        size = path.stat().st_size
        with path.open('rb') as stream:
            stream.seek(max(0, size - 65557))
            tail = stream.read(65557)
            offset = tail.rfind(b'PK\x05\x06')
            if offset < 0 or len(tail) - offset < 22:
                raise invalid()
            eocd_position = max(0, size - 65557) + offset
            # zipfile consults a locator immediately before ordinary EOCD even
            # when ordinary fields are not ZIP64 sentinels. Reject that override,
            # including a locator embedded in the final directory entry comment.
            for distance, signature in ((20, b'PK\x06\x07'), (76, b'PK\x06\x06')):
                if eocd_position >= distance:
                    stream.seek(eocd_position - distance)
                    if stream.read(4) == signature:
                        raise invalid()
            _, disk, directory_disk, disk_entries, entries, directory_size, directory_offset, comment_size = struct.unpack_from('<4s4H2LH', tail, offset)
            if (disk or directory_disk or entries != disk_entries or entries > MAX_ENTRIES
                    or directory_size > 8 * 1024 * 1024
                    or directory_offset + directory_size != eocd_position
                    or len(tail) - offset != 22 + comment_size):
                raise invalid()
            stream.seek(directory_offset)
            remaining, count = directory_size, 0
            while remaining:
                header = stream.read(46)
                if len(header) != 46 or header[:4] != b'PK\x01\x02':
                    raise invalid()
                name_size, extra_size, entry_comment_size = struct.unpack_from('<3H', header, 28)
                record_size = 46 + name_size + extra_size + entry_comment_size
                count += 1
                if record_size > remaining or count > MAX_ENTRIES:
                    raise invalid()
                stream.seek(record_size - 46, 1)
                remaining -= record_size
            if count != entries:
                raise invalid()

    def _validate(self, path, folder):
        if path.is_symlink() or path.stat().st_size > MAX_ARCHIVE_BYTES:
            raise invalid()
        try:
            self._bounded_directory(path)
            with zipfile.ZipFile(path) as archive:
                entries = archive.infolist()
                names = [entry.filename for entry in entries]
                if len(entries) > MAX_ENTRIES or len(names) != len(set(names)) or sum(e.file_size for e in entries) > MAX_EXPANDED_BYTES:
                    raise invalid()
                for entry in entries:
                    name = entry.filename
                    mode = entry.external_attr >> 16
                    if (not name or '\\' in name or '%' in name or any(ord(c) < 32 for c in name)
                            or PurePosixPath(name).is_absolute() or '..' in name.split('/') or '.' in name.split('/')
                            or name != str(PurePosixPath(name)) or entry.is_dir() or entry.flag_bits & 1
                            or stat.S_IFMT(mode) not in {0, stat.S_IFREG}
                            or entry.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}):
                        raise invalid()
                def read_json(name):
                    if archive.getinfo(name).file_size > MAX_JSON_BYTES:
                        raise invalid()
                    def unique_pairs(pairs):
                        result = {}
                        for k, v in pairs:
                            if k in result: raise ValueError('Duplicate JSON key')
                            result[k] = v
                        return result
                    return json.loads(archive.read(name), object_pairs_hook=unique_pairs)
                manifest = TimelinePackageManifest.model_validate(read_json('manifest.json'))
                data = TimelineData.model_validate(read_json('timeline.json'))
                if (data.fonts or data.overlays) and 'timeline.text.v1' not in manifest.requiredCapabilities:
                    raise invalid()
                if set(names) != {'manifest.json', 'timeline.json', LICENSE_PATH, *(r.path for r in manifest.resources)}:
                    raise invalid()
                if archive.getinfo(LICENSE_PATH).file_size > 64 * 1024:
                    raise invalid()
                archive.read(LICENSE_PATH)  # CRC validation also covers the license.
                resource_keys = [key(r.source) for r in manifest.resources]
                if len(set(resource_keys)) != len(resource_keys) or set(resource_keys) != {key(r) for r in refs(data)}:
                    raise invalid()
                extracted, inspected = {}, {}
                for index, resource in enumerate(manifest.resources):
                    gateway().asset_name(resource.name)
                    if archive.getinfo(resource.path).file_size != resource.size:
                        raise invalid()
                    if resource.path not in extracted:
                        target = folder / f'{index}.{EXTENSIONS.get(resource.mimeType, "bin")}'
                        total, digest = 0, hashlib.sha256()
                        with archive.open(resource.path) as incoming, target.open('xb') as output:
                            while chunk := incoming.read(CHUNK_BYTES):
                                total += len(chunk)
                                if total > resource.size:
                                    raise invalid()
                                digest.update(chunk); output.write(chunk)
                        if total != resource.size or 'sha256:' + digest.hexdigest() != resource.fingerprint:
                            raise invalid()
                        extracted[resource.path] = target
                    target = extracted[resource.path]
                    kind, metadata = gateway().inspect_file(target, resource.name, expected_kind=resource.kind)
                    if kind != resource.kind or metadata.mimeType != resource.mimeType:
                        raise invalid()
                    inspected[key(resource.source)] = (target, metadata)
                for overlay in data.overlays:
                    if overlay.sourceAsset and not inspected[key(overlay.sourceAsset)][0].read_text(encoding='utf-8-sig').strip():
                        raise invalid()
                used_fonts = set()
                for font in data.fonts:
                    path, metadata = inspected[key(font.asset)]
                    if metadata.mimeType not in FONT_MIMES:
                        raise invalid()
                    text = '\n'.join(overlay.text for overlay in data.overlays if overlay.fontId == font.id)
                    if text:
                        used_fonts.add(font.asset.fingerprint)
                        require_font_characters(path, font.asset.fingerprint, text)
                if sum(next(r.size for r in manifest.resources if r.fingerprint == fingerprint) for fingerprint in used_fonts) > TIMELINE_FONT_TOTAL_BYTES:
                    raise invalid()
                for track in data.tracks:
                    for clip in track.clips:
                        _, metadata = inspected[key(clip.resource.asset)]
                        if clip.resource.asset.kind != 'image' and metadata.durationSeconds is not None and clip.outPoint > metadata.durationSeconds + TIMELINE_DURATION_EPSILON:
                            raise invalid()
                return manifest, data, inspected
        except (ValidationError, ValueError, KeyError, zipfile.BadZipFile, EOFError, RuntimeError, NotImplementedError):
            raise invalid() from None

    def receipt(self, project_id, operation_id):
        return self.imports.receipt(project_id, operation_id)

    def import_package(self, project_id, request, *, session=None, source='ui'):
        request = TimelinePackageImportRequest.model_validate(request)
        with self.imports.lock(project_id, request.operationId):
            prior = self.imports.read(project_id, request.operationId)
            if prior and prior['request'] != request.model_dump(mode='json'):
                raise timeline_error('timeline_import_conflict', 409)
            if prior:
                receipt = TimelinePackageImportReceipt.model_validate(prior['receipt'])
                if receipt.status in {'applied', 'rejected'}:
                    return receipt
            else:
                receipt = TimelinePackageImportReceipt(operationId=request.operationId, status='registered',
                    editorId=request.replaceEditorId or uuid5(request.operationId, 'editor'))
            with self.projects.local.transaction() as db:
                self.projects._recover()
                project_path, _, _ = self.projects._load(db, project_id)
                self.projects._lease(db, project_id, project_path, session)
            folder = self.imports.folder(project_id, request.operationId)
            archive = gateway().child(folder, 'package.zip')
            # A staged immutable copy keeps retries independent of the original upload.
            if not archive.exists():
                with self.assets.uploads.lock(project_id, request.uploadHandle):
                    upload, _, record = self.assets.uploads.ready(project_id, request.uploadHandle, session)
                    if record.fingerprint != request.archiveFingerprint or record.metadata.size > MAX_ARCHIVE_BYTES:
                        raise invalid()
                    incoming = gateway().child(upload, 'content')
                    if gateway().file_identity(incoming) != (request.archiveFingerprint, record.metadata.size):
                        raise invalid()
                    temporary = gateway().child(folder, 'package.partial')
                    with incoming.open('rb') as incoming_stream, temporary.open('wb') as output_stream:
                        shutil.copyfileobj(incoming_stream, output_stream, CHUNK_BYTES)
                        output_stream.flush()
                        os.fsync(output_stream.fileno())
                    os.replace(temporary, archive)
                    gateway().sync_directory(folder)
            if gateway().file_identity(archive)[0] != request.archiveFingerprint:
                raise invalid()
            with tempfile.TemporaryDirectory(prefix='timeline-package-') as temporary:
                try:
                    manifest, data, inspected = self._validate(archive, Path(temporary))
                except ProjectError:
                    if prior is None:
                        archive.unlink(missing_ok=True)
                    raise
                self.imports.write(project_id, request, receipt)
                mapping = {}
                try:
                    for resource in manifest.resources:
                        identity = uuid5(request.operationId, 'resource:' + key(resource.source))
                        handle = uuid5(identity, 'upload')
                        command = parse_command(dict(commandId=identity, projectId=project_id, type='asset.import',
                            payload=dict(uploadHandle=handle, name=resource.name, expectedKind=resource.kind)))
                        result = self.projects.replay(command)
                        if result is None:
                            writer = self.assets.uploads.begin(project_id, handle, None, resource.name,
                                expected_kind=resource.kind, trusted=True)
                            try:
                                with inspected[key(resource.source)][0].open('rb') as stream:
                                    while chunk := stream.read(CHUNK_BYTES): writer.write(chunk)
                                writer.finish()
                            finally:
                                writer.abort()
                            result = self.assets.register(command, session=session, source=source, trusted_upload=True)
                        if result.status not in {'applied', 'noop'}:
                            raise timeline_error('timeline_registration_rejected', 409)
                        asset = self.assets.get(project_id, gateway().upload_asset_id(project_id, handle))
                        mapping[key(resource.source)] = asset_ref(asset).model_dump(mode='json')
                        registered = tuple(dict.fromkeys((*receipt.registeredAssetIds, asset.id)))
                        receipt = receipt.model_copy(update={'registeredAssetIds': registered, 'errorCode': None})
                        self.imports.write(project_id, request, receipt)
                    def remap(value):
                        if isinstance(value, dict):
                            if set(value) == {'assetId', 'revision', 'fingerprint', 'kind'}:
                                return mapping[key(AssetRef.model_validate(value))]
                            return {k: remap(v) for k, v in value.items()}
                        if isinstance(value, list): return [remap(v) for v in value]
                        return value
                    document = dict(id=receipt.editorId, projectId=project_id, kind='timeline',
                        revision=request.expectedRevision or 1, data=remap(data.model_dump(mode='json')))
                    operations = [dict(type='editor.save' if request.replaceEditorId else 'editor.create', payload=dict(document=document))]
                    versions = []
                    if request.replaceEditorId:
                        versions.append(dict(objectType='editor_document', id=request.replaceEditorId, revision=request.expectedRevision))
                    else:
                        operations.append(dict(type='canvas.show', payload=dict(item=dict(id=uuid5(request.operationId, 'canvas'),
                            projectId=project_id, kind='timeline', binding=dict(role='editor', objectRef=dict(id=receipt.editorId, kind='timeline'))))))
                    command = parse_command(dict(commandId=uuid5(request.operationId, 'apply'), projectId=project_id,
                        type='creation.batch', expectedVersions=versions, payload=dict(operations=operations)))
                    result = self.projects.execute(command, session=session, source=source)
                    receipt = receipt.model_copy(update={'status': 'applied' if result.status in {'applied', 'noop'} else 'rejected', 'receipt': result, 'errorCode': None})
                    self.imports.write(project_id, request, receipt)
                    archive.unlink(missing_ok=True)
                    return receipt
                except (ProjectError, OSError) as failure:
                    receipt = receipt.model_copy(update={'errorCode': failure.code if isinstance(failure, ProjectError) else 'storage_unavailable'})
                    self.imports.write(project_id, request, receipt)
                    raise
