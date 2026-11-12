"""Shared voice registry operations for HTTP, Agent and generation acceptance."""
import json
import logging
from pathlib import Path
import tempfile
from time import monotonic
from urllib.parse import quote, urlencode, urljoin, urlsplit

import httpx

from opendirector.domain.projects import ProjectError
from opendirector.domain.voices import VOICE_CREATE_TEXT_LIMITS, voice_error, voice_library_capabilities, valid_voice_name, voice_incompatibility
from opendirector.domain.zhipu_speech import ZHIPU_CLONE_MODEL, ZHIPU_CLONE_PREVIEW_TEXT, ZHIPU_PRESET_VOICES
from opendirector.integrations.http_settings import auth_headers, public_target_sync, trust_environment
from opendirector.integrations.volcengine import endpoint
from opendirector.media.probe import probe_file

logger = logging.getLogger(__name__)


# Trusted internal callers may omit the scope. Public adapters always pass the
# supplied connection, including None when a client omits a required field.
_CURRENT_CONNECTION = object()


def _public_https(url):
    """Pin an account listing's CDN preview to a checked public HTTPS address, keeping TLS identity."""
    failure = lambda: voice_error('voice_provider_error', 502)
    return public_target_sync(url, unsafe=failure, unresolved=failure, schemes=('https',))


class VoiceLibrary:
    def __init__(self, configs, transport=None, resolve_public=_public_https):
        self.configs, self.transport, self.resolve_public = configs, transport, resolve_public

    def _config(self, model_config_id):
        config = dict(self.configs.resolve(str(model_config_id), 'audio'))
        capabilities = voice_library_capabilities(config)
        if capabilities is None: raise voice_error('voice_library_unsupported', 409)
        return config, capabilities

    def _request(self, config, method, suffix='', *, path='/audio/voices', **kwargs):
        try:
            # Sync service runs in worker threads, including job preparation.
            with httpx.Client(transport=self.transport, trust_env=trust_environment(config['url'], config=config),
                              timeout=httpx.Timeout(120, connect=15), follow_redirects=False) as client:
                with client.stream(method, endpoint(config['url'], path) + suffix,
                                   headers=auth_headers(config), **kwargs) as response:
                    data = bytearray()
                    for chunk in response.iter_bytes():
                        data.extend(chunk)
                        if len(data) > 2 * 1024 * 1024: raise voice_error('voice_provider_protocol', 502)
                    if not response.is_success:
                        raise self._provider_failure(data, config, response.status_code)
                    value = json.loads(data) if data else {}
                    if not isinstance(value, dict): raise voice_error('voice_provider_protocol', 502)
                    # Zhipu reports some failures, such as an unsupported method, with HTTP 200.
                    if isinstance(value.get('error'), dict): raise self._provider_failure(data, config, 502)
                    return value
        except httpx.TimeoutException:
            raise voice_error('voice_provider_timeout', 504) from None
        except httpx.HTTPError:
            raise voice_error('voice_provider_error', 502) from None
        except (ValueError, TypeError):
            raise voice_error('voice_provider_protocol', 502) from None

    def _provider_failure(self, data, config, status):
        # Retain useful upstream detail; redact the configured credential
        # before it reaches either the HTTP or Agent presentation boundary.
        detail = self._provider_detail(data, config)
        try: error = json.loads(data).get('error') or {}
        except (ValueError, AttributeError): error = {}
        code = str(error.get('code', '')) if isinstance(error, dict) else ''
        if code == '1113': return voice_error('voice_provider_quota', 402)
        if code == '1214' and detail == '音色名称已存在': return voice_error('voice_name_taken', 409)
        if code == '1214' and detail.startswith('音色不存在'): return voice_error('voice_not_found', 404)
        error = voice_error('voice_provider_error', status if 400 <= status < 500 else 502)
        if detail: error.args = (str(error) + ' ' + detail,)
        return error

    @staticmethod
    def _provider_detail(data, config):
        try:
            value = json.loads(data)
            error = value.get('error', value.get('detail', ''))
            detail = error.get('message', '') if isinstance(error, dict) else error
            if not isinstance(detail, str): return ''
            secret = config.get('apiKey', '')
            if secret: detail = detail.replace(secret, '[redacted]')
            return detail[:1000]
        except (ValueError, AttributeError): return ''

    def _record(self, item, capabilities, *, source, has_audio=None, config=None):
        if not isinstance(item, dict): raise voice_error('voice_provider_protocol', 502)
        identity = item.get('id')
        # vLLM-Omni also documents name-only uploads. Its registry keys are lowercase.
        if 'id' not in item and capabilities['provider'] == 'vllm_omni' and source == 'uploaded':
            name = item.get('name')
            if valid_voice_name(name):
                identity = name.strip().lower()
        if not valid_voice_name(identity): raise voice_error('voice_provider_protocol', 502)
        name = item.get('name') or identity
        if not isinstance(name, str) or len(name) > 255: raise voice_error('voice_provider_protocol', 502)
        text = item.get('ref_text') or None
        if text is not None and (not isinstance(text, str) or len(text) > 100000): raise voice_error('voice_provider_protocol', 502)
        if has_audio is None:
            has_audio = source == 'uploaded' and (capabilities['provider'] == 'moss' or item.get('embedding_source', 'audio') == 'audio')
        dimension = item.get('embedding_dim')
        if not isinstance(dimension, int) or isinstance(dimension, bool) or not 0 < dimension <= 65536:
            dimension = None
        incompatible = voice_incompatibility(capabilities, has_audio, text, uploaded=source == 'uploaded', embedding_dim=dimension)
        if config is not None:
            model = config['modelId'].rsplit('/', 1)[-1].lower().replace('_', '-')
            if model.startswith('qwen3-tts') and model.endswith(('voicedesign', 'voice-design', 'voice.design')):
                incompatible = 'voice_model_unsupported'
        metadata = {}
        for field in ('gender', 'age', 'language', 'style', 'speaker_description', 'created_at', 'file_size', 'mime_type', 'embedding_source'):
            value = item.get(field)
            if isinstance(value, (str, int, float)) and not isinstance(value, bool): metadata[field] = str(value)[:2000]
        if isinstance(item.get('voice_style'), str): metadata['style'] = item['voice_style'][:2000]
        preview = None
        preview_locator = None
        locator = item.get('preview_url') or item.get('sample_url')
        if config is not None and isinstance(locator, str) and 0 < len(locator) <= 8192:
            try:
                locator = urljoin(config['url'].rstrip('/') + '/', locator)
                parsed = urlsplit(locator)
                valid = parsed.scheme in {'http', 'https'} and parsed.hostname and not parsed.username and not parsed.password and not parsed.fragment
                parsed.port
            except ValueError:
                valid = False
            if valid:
                preview_locator = locator
                preview = '/api/voices/' + quote(identity, safe='') + '/preview?' + urlencode({'modelConfigId': config['id'], 'connectionId': capabilities['connectionId']})
        return dict(connectionId=capabilities['connectionId'], voiceId=identity, name=name,
                    hasReferenceAudio=has_audio, embeddingDim=dimension, refText=text, source=source, previewUrl=preview,
                    metadata=metadata, compatible=incompatible is None, incompatibility=incompatible,
                    canDelete=capabilities['canDelete'] and source == 'uploaded'), preview_locator

    def _vllm_page(self, config, capabilities):
        value = self._request(config, 'GET')
        names, uploaded = value.get('voices'), value.get('uploaded_voices', [])
        if not isinstance(names, list) or not isinstance(uploaded, list) or len(names) + len(uploaded) > 10000:
            raise voice_error('voice_provider_protocol', 502)
        records = {}
        for name in names:
            record, locator = self._record({'id': name}, capabilities, source='builtin', has_audio=False, config=config)
            records[record['voiceId']] = (record, locator)
        seen_uploaded = set()
        for item in uploaded:
            record, locator = self._record(item, capabilities, source='uploaded', config=config)
            identity = record['voiceId']
            if identity in seen_uploaded: raise voice_error('voice_provider_protocol', 502)
            seen_uploaded.add(identity)
            records[identity] = (record, locator)
        return list(records.values()), None

    @staticmethod
    def _valid_cursor(cursor):
        return isinstance(cursor, str) and 0 < len(cursor) <= 2048 and cursor == cursor.strip() and cursor.isprintable()

    def _moss_page(self, config, capabilities, limit, after):
        params = {'limit': limit}
        if after is not None:
            params['after'] = after
        value = self._request(config, 'GET', params=params)
        items, more = value.get('data'), value.get('has_more')
        if not isinstance(items, list) or len(items) > limit or not isinstance(more, bool):
            raise voice_error('voice_provider_protocol', 502)
        cursor = value.get('next_cursor')
        if more and (not items or not self._valid_cursor(cursor) or cursor == after):
            raise voice_error('voice_provider_protocol', 502)
        if not more and cursor not in (None, ''):
            raise voice_error('voice_provider_protocol', 502)
        return [self._record(item, capabilities, source='uploaded', config=config) for item in items], cursor if more else None

    def _zhipu_page(self, config, capabilities):
        # The documented system voices are always available; the account's
        # OFFICIAL listing includes entries synthesis rejects, so it is not read.
        records = [self._record({'id': voice}, capabilities, source='builtin', has_audio=False, config=config)
                   for voice in ZHIPU_PRESET_VOICES]
        value = self._request(config, 'GET', path='/voice/list', params={'voiceType': 'PRIVATE'})
        items = value.get('voice_list')
        if not isinstance(items, list) or len(items) > 10000: raise voice_error('voice_provider_protocol', 502)
        for item in items:
            if not isinstance(item, dict) or item.get('voice_type') != 'PRIVATE':
                raise voice_error('voice_provider_protocol', 502)
            records.append(self._record({'id': item.get('voice'), 'name': item.get('voice_name'),
                                         'preview_url': item.get('download_url'), 'created_at': item.get('create_time')},
                                        capabilities, source='uploaded', has_audio=True, config=config))
        return records, None

    def _assert_current(self, config, capabilities):
        current, rules = self._config(config['id'])
        if rules != capabilities or current['modelId'] != config['modelId']:
            raise voice_error('voice_connection_changed', 409)

    def _pages(self, config, capabilities, limit, after=None):
        # A complete traversal may span many pages. Fail explicitly on a cycle
        # or elapsed deadline instead of imposing a voice-count ceiling.
        config = dict(config)
        deadline = monotonic() + 300
        seen_cursors = {after}
        seen_ids = set()
        while True:
            self._assert_current(config, capabilities)
            if capabilities['provider'] == 'moss':
                records, cursor = self._moss_page(config, capabilities, limit, after)
            elif capabilities['provider'] == 'zhipu':
                records, cursor = self._zhipu_page(config, capabilities)
            else:
                records, cursor = self._vllm_page(config, capabilities)
            for record, _ in records:
                identity = record['voiceId']
                if identity in seen_ids: raise voice_error('voice_provider_protocol', 502)
                seen_ids.add(identity)
            if cursor is not None and cursor in seen_cursors:
                raise voice_error('voice_provider_protocol', 502)
            if monotonic() >= deadline:
                raise voice_error('voice_provider_timeout', 504)
            self._assert_current(config, capabilities)
            yield records, cursor
            if cursor is None:
                return
            seen_cursors.add(cursor)
            after = cursor

    def list(self, model_config_id, *, page_size=None, after=None, connection_id=None):
        config, capabilities = self._config(model_config_id)
        if connection_id is not None and connection_id != capabilities['connectionId']:
            raise voice_error('voice_connection_changed', 409)
        if page_size is not None and (type(page_size) is not int or not 1 <= page_size <= 150):
            raise ProjectError('每页音色数量必须为 1 至 150。', 422)
        if after is not None:
            if connection_id is None:
                raise voice_error('voice_connection_changed', 409)
            if page_size is None or capabilities['provider'] != 'moss' or not self._valid_cursor(after):
                raise ProjectError('音色分页游标无效，请重新打开音色库。', 422)
        voices = []
        for records, cursor in self._pages(config, capabilities, page_size or 150, after):
            voices.extend(record for record, _ in records)
            if page_size is not None:
                break
        return dict(connectionId=capabilities['connectionId'], capabilities=capabilities, voices=voices, nextCursor=cursor)

    def _find(self, config, capabilities, voice_id):
        for records, _ in self._pages(config, capabilities, 150):
            for record, locator in records:
                if record['voiceId'] == voice_id:
                    return record, locator
        return None, None

    def create(self, model_config_id, data, *, filename, name, consent=None, ref_text=None, speaker_description=None, connection_id=_CURRENT_CONNECTION):
        config, capabilities = self._config(model_config_id)
        if connection_id is not _CURRENT_CONNECTION and connection_id != capabilities['connectionId']:
            raise voice_error('voice_connection_changed', 409)
        if not capabilities['supportsUploadedVoices']: raise voice_error('voice_model_unsupported')
        if not valid_voice_name(name): raise voice_error('voice_name_invalid')
        name = name.strip()
        if capabilities['provider'] == 'vllm_omni' and (not isinstance(consent, str) or not consent.strip()):
            raise voice_error('voice_consent_required')
        for field, value in [('refText', ref_text), ('speakerDescription', speaker_description)]:
            if value is None: continue
            if not isinstance(value, str): raise ProjectError('音色上传的文本字段必须是字符串。', 422)
            limit, code = VOICE_CREATE_TEXT_LIMITS[field]
            if len(value) > limit: raise voice_error(code)
        text = (ref_text or '').strip() or None
        if capabilities['requiresTranscript'] and not text: raise voice_error('voice_transcript_required')
        if not data or len(data) > capabilities['maxBytes']: raise voice_error('voice_size', 413)
        extension = Path(filename).suffix.lower().lstrip('.')
        if extension not in capabilities['formats']: raise voice_error('voice_format')
        with tempfile.TemporaryDirectory(prefix='opendirector-voice-') as folder:
            file = Path(folder) / ('sample.' + extension)
            file.write_bytes(data)
            try: media = probe_file(file, 'audio', include_container=True)
            except ProjectError as error:
                if error.status == 409: raise
                raise voice_error('voice_audio_invalid') from None
        # Validate actual demuxed container rather than trusting the filename.
        expected = {'wav': {'wav'}, 'mp3': {'mp3'}, 'flac': {'flac'}, 'ogg': {'ogg'}, 'aac': {'aac'},
                    'webm': {'matroska', 'webm'}, 'm4a': {'mov', 'mp4', 'm4a'}, 'mp4': {'mov', 'mp4', 'm4a'}}
        if not set(media['container'].split(',')) & expected[extension]: raise voice_error('voice_format')
        seconds = media['durationSeconds']
        if (capabilities['minSeconds'] is not None and seconds < capabilities['minSeconds']) or (capabilities['maxSeconds'] is not None and seconds > capabilities['maxSeconds']): raise voice_error('voice_duration')
        fields = {'name': name}
        if capabilities['provider'] == 'zhipu':
            return self._zhipu_create(config, capabilities, data, extension, name, text)
        if capabilities['provider'] == 'vllm_omni':
            fields['consent'] = consent.strip()
            if text: fields['ref_text'] = text
            if speaker_description: fields['speaker_description'] = speaker_description.strip()
        mime = {'wav': 'audio/wav', 'mp3': 'audio/mpeg', 'm4a': 'audio/mp4', 'mp4': 'audio/mp4', 'flac': 'audio/flac', 'ogg': 'audio/ogg', 'aac': 'audio/aac', 'webm': 'audio/webm'}[extension]
        value = self._request(config, 'POST', data=fields, files={'audio_sample': ('sample.' + extension, data, mime)})
        item = value.get('voice') if capabilities['provider'] == 'vllm_omni' else value
        if not isinstance(item, dict): raise voice_error('voice_provider_protocol', 502)
        if capabilities['provider'] == 'vllm_omni' and value.get('success') is not True: raise voice_error('voice_provider_protocol', 502)
        record, _ = self._record(item, capabilities, source='uploaded', has_audio=True, config=config)
        return record

    def _zhipu_create(self, config, capabilities, data, extension, name, text):
        # Upload the sample, register the clone, then delete the uploaded sample.
        # The registered voice keeps working without it; the generated preview
        # file remains because the listing's download URL serves it.
        mime = {'wav': 'audio/wav', 'mp3': 'audio/mpeg'}[extension]
        uploaded = self._request(config, 'POST', path='/files', data={'purpose': 'voice-clone-input'},
                                 files={'file': ('sample.' + extension, data, mime)})
        file_id = uploaded.get('id')
        if not isinstance(file_id, str) or not 0 < len(file_id) <= 512: raise voice_error('voice_provider_protocol', 502)
        try:
            payload = dict(model=ZHIPU_CLONE_MODEL, voice_name=name, input=ZHIPU_CLONE_PREVIEW_TEXT, file_id=file_id)
            if text: payload['text'] = text
            value = self._request(config, 'POST', path='/voice/clone', json=payload)
        finally:
            try:
                self._request(config, 'DELETE', '/' + quote(file_id, safe=''), path='/files')
            except ProjectError as cleanup:
                # The clone owns the outcome, so a failed cleanup must not replace it.
                # Record it instead: the sample outlives the request and only the
                # account holder can remove what is left behind.
                logger.warning('语音样本清理未完成，上传文件可能遗留在服务商账户：%s（%s）',
                               cleanup.code, cleanup.status, exc_info=True)
        voice = value.get('voice')
        if not valid_voice_name(voice): raise voice_error('voice_provider_protocol', 502)
        # Read back the registered entry for its preview locator and stable fields.
        record, _ = self._find(config, capabilities, voice)
        if record is None:
            record, _ = self._record({'id': voice, 'name': name}, capabilities, source='uploaded', has_audio=True, config=config)
        return record

    def preview(self, model_config_id, voice_id, connection_id):
        config, capabilities = self._config(model_config_id)
        if connection_id != capabilities['connectionId']: raise voice_error('voice_connection_changed', 409)
        _, url = self._find(config, capabilities, voice_id)
        if url is None: raise voice_error('voice_not_found', 404)
        parsed, configured = urlsplit(url), urlsplit(config['url'])
        def origin(value): return value.scheme, value.hostname, value.port or (443 if value.scheme == 'https' else 80)
        headers = auth_headers(config) if origin(parsed) == origin(configured) else {}
        target, extensions = url, {}
        if capabilities['provider'] == 'zhipu':
            # The listing hands out a third-party CDN URL: no credentials, public addresses only.
            target, headers, extensions = self.resolve_public(url)
        try:
            with httpx.Client(transport=self.transport, trust_env=trust_environment(url, config=config), timeout=30, follow_redirects=False) as client:
                with client.stream('GET', target, headers=headers, extensions=extensions) as response:
                    mime = response.headers.get('content-type', '').split(';')[0].lower()
                    # Zhipu's CDN labels WAV previews application/octet-stream; check the bytes instead.
                    sniff = capabilities['provider'] == 'zhipu'
                    if not response.is_success or not (mime.startswith('audio/') or sniff): raise voice_error('voice_provider_error', 502)
                    data = bytearray()
                    for chunk in response.iter_bytes():
                        data.extend(chunk)
                        if len(data) > 10 * 1024 * 1024: raise voice_error('voice_size', 413)
                    if sniff:
                        if not (data[:4] == b'RIFF' and data[8:12] == b'WAVE'): raise voice_error('voice_provider_error', 502)
                        mime = 'audio/wav'
                    self._assert_current(config, capabilities)
                    return bytes(data), mime
        except httpx.TimeoutException: raise voice_error('voice_provider_timeout', 504) from None
        except httpx.HTTPError: raise voice_error('voice_provider_error', 502) from None

    def delete(self, model_config_id, voice_id, connection_id):
        _, capabilities = self._config(model_config_id)
        if connection_id != capabilities['connectionId']: raise voice_error('voice_connection_changed', 409)
        if not capabilities['canDelete']: raise voice_error('voice_delete_unsupported', 409)
        listed = self.list(model_config_id)
        record = next((voice for voice in listed['voices'] if voice['voiceId'] == voice_id), None)
        if record is None: raise voice_error('voice_not_found', 404)
        if not record['canDelete']: raise voice_error('voice_delete_unsupported', 409)
        config, current = self._config(model_config_id)
        if current['connectionId'] != connection_id: raise voice_error('voice_connection_changed', 409)
        if current['provider'] == 'zhipu':
            value = self._request(config, 'POST', path='/voice/delete', json={'voice': voice_id})
            if value.get('voice') != voice_id: raise voice_error('voice_provider_protocol', 502)
            return
        value = self._request(config, 'DELETE', '/' + quote(voice_id, safe=''))
        if value.get('success') is not True: raise voice_error('voice_provider_protocol', 502)

    def validate_selection(self, config, voice_id, selection):
        capabilities = voice_library_capabilities(config)
        if selection is not None:
            selection = selection.model_dump() if hasattr(selection, 'model_dump') else selection
            if capabilities is None or selection['connectionId'] != capabilities['connectionId'] or selection['voiceId'] != voice_id:
                raise voice_error('voice_connection_changed', 409)
        if capabilities is None:
            return
        if not selection and not capabilities['requiresReferenceAudio'] and capabilities['supportsUploadedVoices']:
            if not voice_id or not capabilities['requiresTranscript']:
                return
        if not voice_id: raise voice_error('voice_reference_required')
        if voice_id == 'default' and capabilities['requiresReferenceAudio']: raise voice_error('voice_reference_required')
        record, _ = self._find(config, capabilities, voice_id)
        if record is None: raise voice_error('voice_not_found', 409)
        if not record['compatible']: raise voice_error(record['incompatibility'])
