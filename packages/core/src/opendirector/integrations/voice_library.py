"""Backend voice-library calls for vLLM-Omni and MOSS.

The browser sends only a model-configuration id. This service resolves the
private connection, adds its credentials, and returns normalized voice rows
without keys, consent values, or provider response text.
"""
from __future__ import annotations

import asyncio
import json
from urllib.parse import quote

import httpx

from opendirector.domain.projects import ProjectError
from opendirector.domain.voice_library import (voice_create_fields, voice_file, voice_id,
                                               voice_library_capabilities, voice_provider)
from opendirector.integrations.generation_errors import checked, protocol_failure, transport_failure
from opendirector.integrations.http_settings import MODEL_HTTP_HOOKS, auth_headers, trust_environment
from opendirector.integrations.volcengine import bounded, endpoint

_JSON_LIMIT = 2 * 1024 * 1024


def _client(service, config):
    return httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=service.transport,
                             trust_env=trust_environment(config['url'], config=config),
                             timeout=httpx.Timeout(30, connect=10), follow_redirects=False)


async def _json(response, stage, config):
    return json.loads(await bounded(response, stage=stage, secrets=(config.get('apiKey', ''),), limit=_JSON_LIMIT))


def _vllm_voice(name, uploaded=None):
    if not isinstance(name, str):
        raise protocol_failure('poll', message='音色服务返回了无法识别的音色列表。')
    uploaded = uploaded if isinstance(uploaded, dict) else None
    created = uploaded.get('created_at') if uploaded else None
    return {
        'id': name,
        'name': name,
        'provider': 'vllm-omni',
        'source': 'uploaded' if uploaded else 'builtin',
        'createdAt': created if isinstance(created, int) and not isinstance(created, bool) else None,
        'deletable': bool(uploaded),
        'hasReference': bool(uploaded and uploaded.get('ref_text')),
        'description': uploaded.get('speaker_description') if uploaded and isinstance(uploaded.get('speaker_description'), str) else None,
        'metadata': {},
    }


def _moss_voice(value):
    if not isinstance(value, dict):
        raise protocol_failure('poll', message='音色服务返回了无法识别的音色列表。')
    identifier = value.get('id')
    if not isinstance(identifier, str) or not identifier:
        raise protocol_failure('poll', message='音色服务返回了无法识别的音色列表。')
    name = value.get('name') if isinstance(value.get('name'), str) and value.get('name').strip() else identifier
    created = value.get('created_at')
    return {
        'id': identifier,
        'name': name,
        'provider': 'moss',
        'source': 'custom',
        'createdAt': created if isinstance(created, int) and not isinstance(created, bool) else None,
        'deletable': False,
        'hasReference': False,
        'description': None,
        'metadata': {},
    }


class VoiceLibrary:
    def __init__(self, configs, transport=None):
        self.configs, self.transport = configs, transport

    async def _config(self, config_id):
        return await asyncio.to_thread(self.configs.resolve, str(config_id), 'audio')

    @staticmethod
    def _capabilities(config):
        capabilities = voice_library_capabilities(config)
        if capabilities is None:
            raise ProjectError('所选模型不支持音色库。', 409, code='voice_library_unsupported')
        return capabilities

    async def list(self, config_id, cursor=None, limit=20):
        config = await self._config(config_id)
        capabilities = self._capabilities(config)
        provider = voice_provider(config)
        params = {}
        if provider == 'moss':
            params['limit'] = max(1, min(int(limit or 20), 150))
            if cursor:
                if not isinstance(cursor, str) or len(cursor) > 512:
                    raise ProjectError('音色列表游标无效。', 422, code='voice_library_cursor')
                params['after'] = cursor
        try:
            async with _client(self, config) as client:
                async with client.stream('GET', endpoint(config['url'], '/audio/voices'),
                                         headers=auth_headers(config), params=params) as response:
                    value = await _json(response, 'poll', config)
        except httpx.TimeoutException:
            raise transport_failure('poll', timeout=True) from None
        except httpx.HTTPError:
            raise transport_failure('poll') from None
        except (ValueError, TypeError, KeyError):
            raise protocol_failure('poll', message='音色服务返回了无法识别的音色列表。') from None
        if provider == 'moss':
            rows = value.get('data')
            if not isinstance(rows, list):
                raise protocol_failure('poll', message='音色服务返回了无法识别的音色列表。')
            has_more = bool(value.get('has_more'))
            next_cursor = value.get('next_cursor') if has_more else None
            if has_more and not isinstance(next_cursor, str):
                raise protocol_failure('poll', message='音色服务返回了无法识别的分页结果。')
            return {'voices': [_moss_voice(item) for item in rows], 'hasMore': has_more,
                    'nextCursor': next_cursor, 'capabilities': capabilities}
        voices, uploaded = value.get('voices'), value.get('uploaded_voices')
        if not isinstance(voices, list) or not isinstance(uploaded, list):
            raise protocol_failure('poll', message='音色服务返回了无法识别的音色列表。')
        uploaded_by_name = {item['name']: item for item in uploaded
                            if isinstance(item, dict) and isinstance(item.get('name'), str)}
        rows = [_vllm_voice(name, uploaded_by_name.get(name)) for name in voices if isinstance(name, str)]
        seen = {item['id'] for item in rows}
        rows.extend(_vllm_voice(name, item) for name, item in uploaded_by_name.items() if name not in seen)
        return {'voices': rows, 'hasMore': False, 'nextCursor': None, 'capabilities': capabilities}

    async def create(self, config_id, *, filename, data, content_type, name, consent, ref_text, speaker_description):
        config = await self._config(config_id)
        capabilities = self._capabilities(config)
        filename = voice_file(filename, len(data), config)
        fields = voice_create_fields(config, name=name, consent=consent, ref_text=ref_text,
                                     speaker_description=speaker_description)
        provider = voice_provider(config)
        form = {key: value for key, value in fields.items() if value}
        if provider == 'vllm-omni':
            if fields['name']:
                form['name'] = fields['name']
            if fields['consent']:
                form['consent'] = fields['consent']
            if fields['ref_text']:
                form['ref_text'] = fields['ref_text']
            if fields['speaker_description']:
                form['speaker_description'] = fields['speaker_description']
        else:
            if name.strip():
                form['name'] = name.strip()
        mime = content_type if isinstance(content_type, str) and content_type.startswith('audio/') else 'application/octet-stream'
        files = {'audio_sample': (filename, data, mime)}
        try:
            async with _client(self, config) as client:
                async with client.stream('POST', endpoint(config['url'], '/audio/voices'),
                                         headers=auth_headers(config), data=form, files=files) as response:
                    value = await _json(response, 'submit', config)
        except httpx.TimeoutException:
            raise transport_failure('submit', timeout=True) from None
        except httpx.HTTPError:
            raise transport_failure('submit') from None
        except (ValueError, TypeError, KeyError):
            raise protocol_failure('submit', message='音色服务返回了无法识别的创建结果。') from None
        if provider == 'vllm-omni':
            voice = value.get('voice') if isinstance(value, dict) else None
            created = _vllm_voice(voice.get('name') if isinstance(voice, dict) else None, voice)
        else:
            created = _moss_voice(value)
        created['deletable'] = capabilities['canDelete']
        created['hasReference'] = bool(provider == 'vllm-omni' and fields['ref_text'])
        return created

    async def delete(self, config_id, voice):
        config = await self._config(config_id)
        capabilities = self._capabilities(config)
        if not capabilities['canDelete']:
            raise ProjectError('当前服务不支持删除音色。', 409, code='voice_library_delete_unsupported')
        target = voice_id(voice)
        try:
            async with _client(self, config) as client:
                response = await client.request('DELETE', endpoint(config['url'], '/audio/voices/' + quote(target, safe='')),
                                                headers=auth_headers(config))
                await checked(response, stage='submit', secrets=(config.get('apiKey', ''),))
        except httpx.TimeoutException:
            raise transport_failure('submit', timeout=True) from None
        except httpx.HTTPError:
            raise transport_failure('submit') from None
