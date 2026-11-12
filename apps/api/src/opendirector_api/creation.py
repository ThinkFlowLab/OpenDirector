"""Authoritative project endpoints for the canvas creation workflow."""
from uuid import UUID
from pathlib import Path
from base64 import b64encode
from hashlib import sha256
from io import BytesIO
import asyncio
import json
import re
from urllib.parse import quote, unquote

from fastapi import APIRouter, Header, Query, Request
from pydantic import BaseModel, Field
from fastapi.responses import FileResponse, Response, StreamingResponse
from filelock import Timeout
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from opendirector.application.creation_assets import CreationAssets
from opendirector.application.creation_canvas import CreationCanvas
from opendirector.application.creation_history import CreationHistory
from opendirector.application.creation_timeline_packages import CreationTimelinePackages
from opendirector.domain.creation.timeline_packages import TimelinePackageImportRequest, TimelinePackageImportReceipt
from opendirector.domain.creation.assets import Asset, UploadInfo
from opendirector.domain.creation.base import MediaKind
from opendirector.domain.creation.commands import Command, CommandReceipt, Query as CreationQuery
from opendirector.domain.creation.project import ProjectSnapshot, ViewState
from opendirector.domain.projects import ProjectError
from opendirector.domain.timeline_errors import timeline_error, timeline_error_message
from opendirector.infrastructure.creation_projects import CreationProjects
from opendirector.media.fonts import MAX_FONT_BYTES, inspect_font
from opendirector_api.models import AssetSource, Session
from opendirector_api.localization import localized_receipt

from opendirector_api.localization import localized_error_for_language


class FontCoverageResponse(BaseModel):
    fingerprint: str = Field(pattern=r'^sha256:[0-9a-f]{64}$')
    # One bit per Unicode scalar position: fixed 139,264 bytes / 185,688 base64 chars.
    coverage: str = Field(min_length=185688, max_length=185688)


def preview_font_coverage(value: bytes) -> FontCoverageResponse:
    inspection = inspect_font(BytesIO(value))
    mask = bytearray(0x110000 // 8)
    for code in inspection.characters:
        mask[code >> 3] |= 1 << (code & 7)
    return FontCoverageResponse(fingerprint='sha256:' + sha256(value).hexdigest(),
                                coverage=b64encode(mask).decode('ascii'))


class TemporaryPackageResponse(FileResponse):
    """Package lifetime ends on completion, disconnect, or cancelled response."""
    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            Path(self.path).unlink(missing_ok=True)


def creation_routes(projects: CreationProjects, generation=None):
    router = APIRouter(prefix='/api/creation', tags=['Unified creation projects'])
    assets = CreationAssets(projects)
    canvas = CreationCanvas(projects)
    history = CreationHistory(projects, assets=assets)
    timeline_packages = CreationTimelinePackages(projects)

    @router.post('/fonts/inspect', response_model=FontCoverageResponse)
    async def inspect_preview_font(request: Request, response: Response,
                                   content_length: int | None = Header(default=None, ge=0)):
        # Read-only byte inspection also works for unregistered local drafts.
        # No filesystem paths, project changes, text, or session acquisition.
        if content_length is not None and content_length > MAX_FONT_BYTES:
            raise timeline_error('timeline_font_too_large', 413)
        value = bytearray()
        async for chunk in request.stream():
            if len(value) + len(chunk) > MAX_FONT_BYTES:
                raise timeline_error('timeline_font_too_large', 413)
            value.extend(chunk)
        response.headers['Cache-Control'] = 'no-store'
        return await run_in_threadpool(preview_font_coverage, bytes(value))

    @router.get('/projects')
    def list_projects():
        return projects.list_projects()

    @router.post('/projects/cleanup')
    def cleanup_unreadable_projects():
        return projects.cleanup_unreadable()

    @router.get('/storage')
    def storage():
        # Deleting a project is only promised to be recoverable when the
        # platform actually recycles the directory.
        return {'projectDelete': projects.delete_mode}

    @router.get('/projects/{project_id}', response_model=ProjectSnapshot)
    def snapshot(project_id: UUID):
        return projects.snapshot(project_id)

    @router.post('/projects/{project_id}/open', response_model=ProjectSnapshot)
    def open_project(project_id: UUID, x_opendirector_session: UUID = Header()):
        return projects.open(project_id, str(x_opendirector_session))

    @router.post('/projects/{project_id}/open-canvas')
    def open_project_canvas(project_id: UUID, x_opendirector_session: UUID = Header()):
        # The canvas needs its reference edges on first render too. Reuse the
        # single snapshot this open read already published instead of making the
        # page read the same project again through GET /canvas. The no-flag
        # route above still returns a bare ProjectSnapshot.
        snapshot = projects.open(project_id, str(x_opendirector_session))
        return {'snapshot': snapshot, 'edges': canvas.reference_edges(project_id, snapshot)}

    @router.put('/sessions/{session_id}')
    def heartbeat(session_id: UUID, value: Session):
        projects.heartbeat(str(session_id), value.projectId)
        return {'ok': True}

    @router.delete('/sessions/{session_id}')
    def release(session_id: UUID):
        projects.local.release(str(session_id))
        return {'ok': True}

    @router.post('/projects/{project_id}/commands', response_model=CommandReceipt)
    async def execute(project_id: UUID, value: Command, request: Request, x_opendirector_session: UUID | None = Header(default=None),
                      x_canvas_import: str | None = Header(default=None)):
        # Source is selected by the trusted entrypoint, never by a payload flag.
        if value.projectId != project_id:
            raise ProjectError('命令不属于当前工程。')
        session = str(x_opendirector_session) if x_opendirector_session else None
        if value.type == 'artifact.publish':
            raise ProjectError('产物发布需要服务端执行上下文，不能通过路径直接访问本机文件。', 403)
        if value.type == 'job.checkpoint':
            raise ProjectError('任务执行事实只能由后台写入。', 403)
        if x_canvas_import is not None and value.type != 'asset.import':
            raise ProjectError('归档来源只能随素材导入声明。', 400)
        imported_from = x_canvas_import if x_canvas_import in {'generated', 'edited'} else None
        if x_canvas_import is not None and imported_from is None:
            raise ProjectError('归档来源必须是 generated 或 edited。', 400)
        if value.type in {'generation.submit', 'job.cancel', 'job.recover'}:
            if generation is None:
                raise ProjectError('任务服务不可用。', 503)
            receipt = await generation.execute(value, session=session)
        else:
            receipt = await run_in_threadpool(projects.execute, value, session=session, imported_from=imported_from)
        return localized_receipt(request, receipt)

    def package_display_receipt(request, result):
        if result.receipt is None:
            return result
        displayed = result.receipt.model_copy(update={'issues': tuple(issue.model_copy(update={
            'message': localized_error_for_language(request.headers.get('accept-language'), chinese=issue.message,
                status=409, code=issue.code),
        }) for issue in result.receipt.issues)})
        return result.model_copy(update={'receipt': displayed})

    @router.get('/projects/{project_id}/timelines/{editor_id}/package')
    def export_timeline_package(project_id: UUID, editor_id: UUID, revision: int = Query(ge=1)):
        path = timeline_packages.export(project_id, editor_id, revision)
        return TemporaryPackageResponse(path, media_type='application/zip', filename=f'{editor_id}.timeline.zip',
            headers={'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'})

    @router.post('/projects/{project_id}/timeline-package-imports', response_model=TimelinePackageImportReceipt)
    def import_timeline_package(project_id: UUID, value: TimelinePackageImportRequest,
                                request: Request, x_opendirector_session: UUID = Header()):
        return package_display_receipt(request, timeline_packages.import_package(project_id, value, session=str(x_opendirector_session)))

    @router.get('/projects/{project_id}/timeline-package-imports/{operation_id}', response_model=TimelinePackageImportReceipt)
    def timeline_package_receipt(project_id: UUID, operation_id: UUID, request: Request):
        return package_display_receipt(request, timeline_packages.receipt(project_id, operation_id))

    @router.get('/projects/{project_id}/canvas/{item_id}/status')
    async def item_status(project_id: UUID, item_id: UUID, wait_seconds: float = Query(default=0, ge=0, le=30)):
        return await canvas.wait_item_status(project_id, item_id, wait_seconds)

    @router.get('/projects/{project_id}/canvas')
    def projection(project_id: UUID):
        return canvas.projection(project_id)

    @router.post('/projects/{project_id}/queries')
    async def query(project_id: UUID, value: CreationQuery):
        if value.projectId != project_id:
            raise ProjectError('查询不属于当前工程。')
        result = await canvas.query(value)
        if value.type == 'asset.preview' and 'preview' in result:
            result['preview'].pop('path')
            result['preview']['url'] = f'/api/creation/projects/{project_id}/assets/{value.objectId}/preview'
        return result

    @router.get('/projects/{project_id}/assets/{asset_id}/preview')
    async def asset_preview(project_id: UUID, asset_id: UUID):
        target = projects.local.state_dir / 'previews' / str(project_id)
        result = await run_in_threadpool(assets.preview, project_id, asset_id, target)
        if 'preview' not in result:
            return result
        return FileResponse(result['preview']['path'], media_type=result['preview']['mimeType'])

    @router.get('/projects/{project_id}/history')
    def operations(project_id: UUID):
        return history.operations(project_id)

    @router.get('/projects/{project_id}/reference-catalog')
    def reference_catalog(project_id: UUID):
        return history.reference_catalog(project_id)

    @router.get('/projects/{project_id}/specs/{spec_id}/versions')
    def versions(project_id: UUID, spec_id: UUID):
        return history.versions(project_id, spec_id)

    @router.get('/projects/{project_id}/version-counts')
    def version_counts(project_id: UUID):
        return history.version_counts(project_id)

    @router.get('/projects/{project_id}/items/{item_id}/versions')
    def node_versions(project_id: UUID, item_id: UUID):
        return history.node_versions(project_id, item_id)

    @router.get('/projects/{project_id}/asset-list')
    def asset_list(project_id: UUID, text: str = Query(default='', max_length=1000),
                   usage: str = Query(default='all', pattern='^(all|used|unused)$'),
                   visibility: str = Query(default='all', pattern='^(all|visible|hidden)$'),
                   category: str = Query(default='all', pattern='^(all|image|video|audio|text|subject|timeline)$'),
                   offset: int = Query(default=0, ge=0), limit: int = Query(default=100, ge=1, le=200)):
        return history.asset_list(project_id, text=text, usage=usage, visibility=visibility, category=category, offset=offset, limit=limit)

    @router.post('/projects/{project_id}/asset-delete-preview')
    def asset_delete_preview(project_id: UUID, value: dict):
        try:
            return history.delete_preview(project_id, value['assetIds'], value.get('clearHistory', False))
        except (KeyError, ValueError, TypeError):
            raise ProjectError('删除选择无效。') from None

    @router.get('/projects/{project_id}/receipts/{command_id}', response_model=CommandReceipt)
    def receipt(project_id: UUID, command_id: UUID, request: Request):
        return localized_receipt(request, projects.receipt(project_id, command_id))

    @router.get('/projects/{project_id}/changes')
    def changes(project_id: UUID, after: int = Query(default=0, ge=0), limit: int = Query(default=100, ge=1, le=200)):
        # Pull and streaming consumers share this persisted outbox cursor.
        return projects.changes(project_id, after=after, limit=limit)

    @router.get('/projects/{project_id}/subscribe')
    async def subscribe(project_id: UUID, request: Request, after: int = Query(default=0, ge=0)):
        initial = await run_in_threadpool(projects.changes, project_id, after=after)
        # The persisted cursor is authoritative; reconnects never depend on a
        # process-local listener. Fetch clients carry the local request headers.
        async def events():
            cursor, changes = after, initial
            while not await request.is_disconnected():
                if changes is None:
                    try:
                        changes = await run_in_threadpool(projects.changes, project_id, after=cursor)
                    except Timeout:
                        # Resume this stream at the same cursor after contention.
                        await asyncio.sleep(1)
                        continue
                if changes['events']:
                    for event in changes['events']:
                        yield json.dumps(event.model_dump(mode='json'), ensure_ascii=False) + '\n'
                        cursor = event.cursor
                else:
                    yield '\n'  # Keep-alive; no fabricated business event.
                    await asyncio.sleep(1)
                changes = None
        return StreamingResponse(events(), media_type='application/x-ndjson', headers={'Cache-Control': 'no-store'})

    @router.get('/projects/{project_id}/views/{client_id}', response_model=ViewState)
    def read_view(project_id: UUID, client_id: UUID):
        view = projects.view(project_id, client_id, missing_ok=True)
        return Response(status_code=204) if view is None else view

    @router.put('/projects/{project_id}/views/{client_id}', response_model=ViewState)
    def save_view(project_id: UUID, client_id: UUID, value: ViewState, x_opendirector_session: UUID = Header()):
        return projects.view(project_id, client_id, value, session=str(x_opendirector_session))

    @router.put('/projects/{project_id}/uploads/{handle_id}', response_model=UploadInfo)
    async def upload(project_id: UUID, handle_id: UUID, request: Request,
                     x_opendirector_session: UUID = Header(), x_asset_name: str = Header(max_length=4096),
                     x_asset_kind: MediaKind | None = Header(default=None)):
        writer = await run_in_threadpool(assets.uploads.begin, project_id, handle_id, str(x_opendirector_session),
                                        unquote(x_asset_name), expected_kind=x_asset_kind)
        try:
            async for chunk in request.stream():
                await run_in_threadpool(writer.write, chunk)
            return await run_in_threadpool(writer.finish)
        finally:
            # Also runs on ClientDisconnect and cancelled request bodies.
            writer.abort()

    @router.put('/projects/{project_id}/uploads/{handle_id}/copy', response_model=UploadInfo)
    def copy_upload(project_id: UUID, handle_id: UUID, source: AssetSource, x_opendirector_session: UUID = Header()):
        return assets.stage_copy(project_id, handle_id, str(x_opendirector_session), source.projectId, source.assetId,
                                 source.fingerprint)

    @router.get('/projects/{project_id}/uploads/{handle_id}', response_model=UploadInfo)
    def upload_info(project_id: UUID, handle_id: UUID, x_opendirector_session: UUID = Header()):
        return assets.uploads.info(project_id, handle_id, str(x_opendirector_session))

    @router.delete('/projects/{project_id}/uploads/{handle_id}', response_model=UploadInfo)
    def cancel_upload(project_id: UUID, handle_id: UUID, x_opendirector_session: UUID = Header()):
        return assets.uploads.cancel(project_id, handle_id, str(x_opendirector_session))

    @router.get('/projects/{project_id}/assets', response_model=list[Asset])
    def list_assets(project_id: UUID):
        return assets.list(project_id)

    @router.get('/projects/{project_id}/assets/{asset_id}', response_model=Asset)
    def describe_asset(project_id: UUID, asset_id: UUID):
        return assets.get(project_id, asset_id)

    @router.get('/projects/{project_id}/assets/{asset_id}/thumbnail')
    def thumbnail(project_id: UUID, asset_id: UUID):
        value, asset = assets.thumbnail(project_id, asset_id)
        return Response(value, media_type='image/webp', headers={
            'Cache-Control': 'private, no-cache', 'ETag': '"thumbnail-' + asset.fingerprint + '"',
            'X-Content-Type-Options': 'nosniff'})

    @router.get('/projects/{project_id}/assets/{asset_id}/browser-image')
    def browser_image(project_id: UUID, asset_id: UUID,
                      if_none_match: str | None = Header(default=None, alias='If-None-Match')):
        match = re.fullmatch(r'"browser-image-v2-(sha256:[0-9a-f]{64})"', if_none_match or '')
        value, asset = assets.browser_image(project_id, asset_id, known_fingerprint=match[1] if match else None)
        return Response(value, status_code=304 if value is None else 200, media_type='image/png', headers={
            'Cache-Control': 'private, no-cache', 'ETag': '"browser-image-v2-' + asset.fingerprint + '"',
            'X-Content-Type-Options': 'nosniff'})

    @router.get('/projects/{project_id}/assets/{asset_id}/content')
    def content(project_id: UUID, asset_id: UUID, range_header: str | None = Header(default=None, alias='Range'),
                if_none_match: str | None = Header(default=None, alias='If-None-Match')):
        stream, asset = assets.open_media(project_id, asset_id)
        size, etag = asset.metadata.size, '"' + asset.fingerprint + '"'
        headers = {'Accept-Ranges': 'bytes', 'ETag': etag, 'Cache-Control': 'private, no-cache',
                   'X-Content-Type-Options': 'nosniff',
                   'Content-Disposition': ('attachment' if asset.kind == 'file' else 'inline')
                       + "; filename*=utf-8''" + quote(asset.name, safe='')}
        if range_header is None and if_none_match == etag:
            stream.close()
            return Response(status_code=304, headers=headers)
        start, end = 0, size - 1
        if range_header is not None:
            try:
                match = re.fullmatch(r'bytes=(\d*)-(\d*)', range_header) if len(range_header) <= 128 else None
                if match is None or not any(match.groups()) or not size:
                    raise ValueError()
                first, last = match.groups()
                if first:
                    start, end = int(first), min(int(last), size - 1) if last else size - 1
                else:
                    suffix = int(last)
                    if suffix <= 0:
                        raise ValueError()
                    start = max(0, size - suffix)
                if start > end or start >= size:
                    raise ValueError()
            except ValueError:
                stream.close()
                return Response(status_code=416, headers={**headers, 'Content-Range': f'bytes */{size}'})
            headers['Content-Range'] = f'bytes {start}-{end}/{size}'
        headers['Content-Length'] = str(end - start + 1)
        async def chunks():
            try:
                stream.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    data = await run_in_threadpool(stream.read, min(1024 * 1024, remaining))
                    if not data:
                        break
                    remaining -= len(data)
                    yield data
            finally:
                stream.close()
        return StreamingResponse(chunks(), status_code=206 if range_header else 200,
            media_type=asset.metadata.mimeType, headers=headers, background=BackgroundTask(stream.close))

    return router
