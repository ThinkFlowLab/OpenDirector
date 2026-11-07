"""Shared voice registry operations for HTTP, Agent and generation acceptance."""
import json
from pathlib import Path
import tempfile
from time import monotonic
from urllib.parse import quote, urlencode, urljoin, urlsplit

import httpx

from opendirector.domain.projects import ProjectError
from opendirector.domain.voices import voice_error, voice_library_capabilities, valid_voice_name, voice_incompatibility
from opendirector.integrations.http_settings import auth_headers, trust_environment
from opendirector.integrations.volcengine import endpoint
from opendirector.media.probe import probe_file


class VoiceLibrary:
    def __init__(self, configs, transport=None):
        self.configs, self.transport = configs, transport

    def _config(self, model_config_id):
        config = dict(self.configs.resolve(str(model_config_id), 'audio'))
        capabilities = voice_library_capabilities(config)
        if capabilities is None: raise voice_error('voice_library_unsupported', 409)
        return config, capabilities

    def _request(self, config, method, suffix='', **kwargs):
        try:
            # Sync service runs in worker threads, including job preparation.
            with httpx.Client(transport=self.transport, trust_env=trust_environment(config['url'], config=config),
                              timeout=httpx.Timeout(120, connect=15), follow_redirects=False) as client:
                with client.stream(method, endpoint(config['url'], '/audio/voices') + suffix,
                                   headers=auth_headers(config), **kwargs) as response:
                    data = bytearray()
                    for chunk in response.iter_bytes():
                        data.extend(chunk)
                        if len(data) > 2 * 1024 * 1024: raise voice_error('voice_provider_protocol', 502)
                    if not response.is_success:
                        # Retain useful upstream detail; redact the configured credential
                        # before it reaches either the HTTP or Agent presentation boundary.
                        detail = self._provider_detail(data, config)
                        error = voice_error('voice_provider_error', response.status_code if 400 <= response.status_code < 500 else 502)
                        if detail: error.args = (str(error) + ' ' + detail,)
                        raise error
                    value = json.loads(data) if data else {}
                    if not isinstance(value, dict): raise voice_error('voice_provider_protocol', 502)
                    return value
        except httpx.TimeoutException:
            raise voice_error('voice_provider_timeout', 504) from None
        except httpx.HTTPError:
            raise voice_error('voice_provider_error', 502) from None
        except (ValueError, TypeError):
            raise voice_error('voice_provider_protocol', 502) from None

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

    def create(self, model_config_id, data, *, filename, name, consent=None, ref_text=None, speaker_description=None, connection_id=None):
        config, capabilities = self._config(model_config_id)
        if connection_id is not None and connection_id != capabilities['connectionId']: raise voice_error('voice_connection_changed', 409)
        if not capabilities['supportsUploadedVoices']: raise voice_error('voice_model_unsupported')
        if not valid_voice_name(name): raise voice_error('voice_name_invalid')
        name = name.strip()
        if capabilities['provider'] == 'vllm_omni' and (not isinstance(consent, str) or not consent.strip()):
            raise voice_error('voice_consent_required')
        text = (ref_text or '').strip() or None
        if capabilities['requiresTranscript'] and not text: raise voice_error('voice_transcript_required')
        if text and len(text) > 100000 or speaker_description and len(speaker_description) > 4000: raise voice_error('voice_name_invalid')
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

    def preview(self, model_config_id, voice_id, connection_id):
        config, capabilities = self._config(model_config_id)
        if connection_id != capabilities['connectionId']: raise voice_error('voice_connection_changed', 409)
        _, url = self._find(config, capabilities, voice_id)
        if url is None: raise voice_error('voice_not_found', 404)
        parsed, configured = urlsplit(url), urlsplit(config['url'])
        def origin(value): return value.scheme, value.hostname, value.port or (443 if value.scheme == 'https' else 80)
        headers = auth_headers(config) if origin(parsed) == origin(configured) else {}
        try:
            with httpx.Client(transport=self.transport, trust_env=trust_environment(url, config=config), timeout=30, follow_redirects=False) as client:
                with client.stream('GET', url, headers=headers) as response:
                    mime = response.headers.get('content-type', '').split(';')[0].lower()
                    if not response.is_success or not mime.startswith('audio/'): raise voice_error('voice_provider_error', 502)
                    data = bytearray()
                    for chunk in response.iter_bytes():
                        data.extend(chunk)
                        if len(data) > 10 * 1024 * 1024: raise voice_error('voice_size', 413)
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
