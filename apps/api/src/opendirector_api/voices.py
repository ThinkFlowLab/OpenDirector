"""HTTP adapter for the shared provider voice registry."""
from uuid import UUID

from fastapi import APIRouter, Query, Request, Response
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

from opendirector.domain.projects import ProjectError
from opendirector.domain.voices import voice_error


_TEXT_LIMITS = {'name': 200, 'connectionId': 200, 'consent': 4000, 'refText': 100000, 'speakerDescription': 4000}


async def _voice_upload(request, max_bytes):
    if request.headers.get('content-type', '').partition(';')[0].strip().lower() != 'multipart/form-data':
        raise ProjectError('请通过 multipart/form-data 表单上传音色录音。', 415, code='voice_upload_type')
    # Allow four UTF-8 bytes per text character, plus bounded multipart headers.
    body_limit = max_bytes + 4 * sum(_TEXT_LIMITS.values()) + 16384

    async def bounded_stream():
        total = 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > body_limit:
                raise voice_error('voice_size', 413)
            yield chunk

    parser = MultiPartParser(request.headers, bounded_stream(), max_files=1, max_fields=len(_TEXT_LIMITS),
                             max_part_size=4 * max(_TEXT_LIMITS.values()))
    try:
        form = await parser.parse()
    except MultiPartException:
        raise ProjectError('无法解析音色上传表单，请检查录音和文本字段。', 422, code='voice_upload_form') from None
    try:
        audio = form.get('audio_sample')
        if not isinstance(audio, UploadFile) or not audio.filename or len(audio.filename) > 255:
            raise voice_error('voice_audio_invalid')
        if audio.size is None or audio.size > max_bytes:
            raise voice_error('voice_size', 413)
        fields = {}
        for field, value in form.multi_items():
            if field == 'audio_sample' and value is audio:
                continue
            if field not in _TEXT_LIMITS or field in fields or not isinstance(value, str) or len(value) > _TEXT_LIMITS[field]:
                raise ProjectError('音色上传表单的字段或长度无效，请检查后重试。', 422, code='voice_upload_form')
            fields[field] = value
        return audio.filename, await audio.read(), fields
    finally:
        await form.close()


def voice_routes(voices):
    router = APIRouter(prefix='/api/voices')

    @router.get('')
    async def list_voices(modelConfigId: UUID, pageSize: int | None = Query(default=None, ge=1, le=150),
                          after: str | None = Query(default=None, min_length=1, max_length=2048),
                          connectionId: str | None = Query(default=None, min_length=1, max_length=200)):
        return await run_in_threadpool(voices.list, str(modelConfigId), page_size=pageSize, after=after,
                                       connection_id=connectionId)

    @router.post('')
    async def create_voice(request: Request, modelConfigId: UUID):
        _, capabilities = await run_in_threadpool(voices._config, str(modelConfigId))
        filename, data, fields = await _voice_upload(request, capabilities['maxBytes'])
        return await run_in_threadpool(voices.create, str(modelConfigId), data, filename=filename,
                                      name=fields.get('name', ''), consent=fields.get('consent'),
                                      connection_id=fields.get('connectionId'), ref_text=fields.get('refText'),
                                      speaker_description=fields.get('speakerDescription'))

    @router.delete('/{voice_id}', status_code=204)
    async def delete_voice(voice_id: str, modelConfigId: UUID, connectionId: str = Query(max_length=200)):
        await run_in_threadpool(voices.delete, str(modelConfigId), voice_id, connectionId)
        return Response(status_code=204)

    @router.get('/{voice_id}/preview')
    async def preview_voice(voice_id: str, modelConfigId: UUID, connectionId: str = Query(max_length=200)):
        data, mime = await run_in_threadpool(voices.preview, str(modelConfigId), voice_id, connectionId)
        return Response(content=data, media_type=mime, headers={'Cache-Control': 'no-store'})

    return router
