"""Application-wide model settings. Secrets never leave this store's API."""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlsplit
from uuid import NAMESPACE_URL, uuid4, uuid5

from filelock import FileLock

from opendirector.domain.projects import ProjectError, identifier
from opendirector.domain.input_rules import input_rules
from opendirector.domain.capabilities import agent_input_modalities
from opendirector.domain.video_capabilities import check_video_config
from opendirector.domain.creation.models import BUILTIN_PLACEHOLDER_URL
from opendirector.infrastructure.local_projects import child, read_json, write_json

MODEL_KINDS = ("agent", "image", "video", "audio", "vision")

# Deterministic identity for the built-in placeholder generator, so every
# installation resolves the same config ID and reseeding stays idempotent.
BUILTIN_PLACEHOLDER_IMAGE_ID = str(uuid5(NAMESPACE_URL, 'opendirector/builtin/placeholder-image'))
BUILTIN_PLACEHOLDER = {'kind': 'image', 'modelId': 'placeholder'}


def connection_fields(kind, connection_type='api', protocol=None, auth_mode=None, proxy_mode=None):
    if connection_type not in {'api', 'self_hosted', 'builtin'}:
        raise ProjectError('无效的接入方式。')
    if connection_type == 'builtin':
        # The built-in placeholder never dials a network: no URL, no credentials.
        protocol, auth_mode, proxy_mode = 'placeholder', 'none', 'direct'
    protocol = protocol or ('openai' if kind == 'agent' or connection_type == 'self_hosted' and kind not in {'video', 'vision'}
                            else 'vllm_omni' if connection_type == 'self_hosted' else 'volcengine')
    allowed = {'agent': {'openai'}, 'image': {'openai', 'volcengine', 'vllm_omni_segmentation', 'placeholder'},
               'video': {'minimax_video_v2', 'vllm_omni', 'volcengine', 'vllm_omni_segmentation', 'vllm_omni_depth'},
               'audio': {'openai', 'volcengine', 'vllm_omni_music', 'vllm_omni_score'}, 'vision': {'vllm_omni'}}
    auth_mode = auth_mode or ('none' if connection_type in {'self_hosted', 'builtin'} else 'bearer')
    proxy_mode = proxy_mode if proxy_mode is not None else 'system'
    if protocol not in allowed.get(kind, set()) or auth_mode not in {'bearer', 'none'} or proxy_mode not in {'system', 'direct'}:
        raise ProjectError('接口协议或鉴权方式与模型类别不兼容。')
    return {'connectionType': connection_type, 'protocol': protocol, 'authMode': auth_mode, 'proxyMode': proxy_mode}


def model_fields(url: str, model_id: str, api_key: str) -> dict:
    url, model_id, api_key = url.strip(), model_id.strip(), api_key.strip()
    try:
        parts = urlsplit(url)
        valid = (parts.scheme in {"http", "https"} and parts.hostname and
                 not parts.username and not parts.password and not parts.query and not parts.fragment)
        parts.port  # Validate the port without making any network request.
    except ValueError:
        valid = False
    if not valid or len(url) > 2048 or any(character.isspace() for character in url):
        raise ProjectError("URL 应为 HTTP(S) 基础地址，不能包含账号、密码、查询参数或片段。")
    if not model_id or len(model_id) > 200 or any(ord(character) < 32 for character in model_id):
        raise ProjectError("Model ID 应为 1–200 个字符，不能包含控制字符。")
    if len(api_key) > 8192 or any(ord(character) < 32 for character in api_key):
        raise ProjectError("API Key 格式无效。")
    return {"url": url, "modelId": model_id, "apiKey": api_key}


class ModelConfigs:
    def __init__(self, repository: Path):
        self.directory = repository.resolve() / ".opendirector"
        if self.directory.is_symlink():
            raise ProjectError("模型配置目录不能是符号链接。", 409)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if os.name == "posix":
            self.directory.chmod(0o700)
        self.path = child(self.directory, "models.json")
        self.lock = FileLock(self.directory / "models.lock", timeout=15)

    def _read(self) -> list[dict]:
        if not self.path.exists() and not self.path.is_symlink():
            return []
        try:
            if os.name == "posix" and not self.path.is_symlink():
                self.path.chmod(0o600)
            value = read_json(self.path)
            if value["version"] != 1 or not isinstance(value["models"], list):
                raise ValueError()
            services = value.get('services', {})
            if not isinstance(services, dict) or any(set(service) != {'url', 'apiKey', 'connectionType', 'authMode'} for service in services.values()):
                raise ValueError()
            for item in value['models']:
                if 'providerId' in item:
                    identifier(item['providerId'])
                    item.update(services[item['providerId']])
            seen = set()
            for item in value["models"]:
                if not {'id', 'kind', 'url', 'modelId', 'apiKey'} <= set(item) or set(item) - {'id', 'kind', 'url', 'modelId', 'apiKey', 'connectionType', 'protocol', 'authMode', 'proxyMode', 'videoAdapter', 'videoCapabilities', 'providerId', 'inputModalities'}:
                    raise ValueError()
                identifier(item["id"])
                if item["id"] in seen or item["kind"] not in MODEL_KINDS:
                    raise ValueError()
                seen.add(item["id"])
                # Built-in entries carry a marker URL that is never dialed; the
                # HTTP(S) service validation does not apply to them.
                fields = (model_fields(item["url"], item["modelId"], item["apiKey"])
                          if item.get('connectionType') != 'builtin'
                          else {'url': item['url'], 'modelId': item['modelId'], 'apiKey': ''})
                item.update(connection_fields(item['kind'], item.get('connectionType', 'api'), item.get('protocol'), item.get('authMode'), item.get('proxyMode')))
                # Old /videos entries used the FastH3 request shape for every name.
                # Pin that adapter while new configurations use explicit detection.
                if 'videoAdapter' not in item:
                    item['videoAdapter'] = ('minimax_h3' if item['modelId'].rsplit('/', 1)[-1].lower() == 'minimax-h3'
                                            else 'fasth3') if item['kind'] == 'video' and item['protocol'] == 'vllm_omni' else 'auto'
                item['inputModalities'] = agent_input_modalities(item['kind'], item.get('inputModalities'))
                item['videoCapabilities'] = check_video_config(item['kind'], item['protocol'], item['videoAdapter'], item.get('videoCapabilities'))
                if item['authMode'] == 'bearer' and not fields['apiKey']:
                    raise ValueError()
            return value["models"]
        except (ValueError, TypeError, KeyError, AttributeError, ProjectError):
            raise ProjectError("模型配置文件无法读取，请检查 .opendirector/models.json；原文件未覆盖。", 409) from None

    @staticmethod
    def _public(item: dict) -> dict:
        return {**({'providerId': item['providerId']} if 'providerId' in item else {}), **{key: item[key] for key in ("id", "kind", "url", "modelId", "connectionType", "protocol", "authMode", "proxyMode", "videoAdapter", "videoCapabilities", "inputModalities")}, 'inputRules': input_rules(item)}

    def list(self) -> list[dict]:
        with self.lock:
            return [self._public(item) for item in self._read()]

    def agent(self, config_id: str) -> dict:
        """Resolve a private credential snapshot for a backend call only."""
        return self.resolve(config_id, "agent")

    def resolve(self, config_id: str, kind: str) -> dict:
        with self.lock:
            item = next((item for item in self._read() if item["id"] == config_id and item["kind"] == kind), None)
            if item is None:
                raise ProjectError("所选模型不存在或类别不符，请在设置中配置并重新选择。", 409)
            return dict(item)

    def ensure_builtin(self) -> dict:
        """Seed the built-in placeholder image generator once; idempotent per install."""
        with self.lock:
            models = self._read()
            existing = next((item for item in models
                             if item['kind'] == BUILTIN_PLACEHOLDER['kind'] and item['modelId'] == BUILTIN_PLACEHOLDER['modelId']), None)
            if existing is not None:
                return self._public(existing)
            models.append({'id': BUILTIN_PLACEHOLDER_IMAGE_ID, 'url': BUILTIN_PLACEHOLDER_URL, 'apiKey': '',
                           **BUILTIN_PLACEHOLDER, **connection_fields(BUILTIN_PLACEHOLDER['kind'], 'builtin')})
            self._write(models)
            # Reread so the stored entry gets the same normalization as any other.
            return next(self._public(item) for item in self._read() if item['id'] == BUILTIN_PLACEHOLDER_IMAGE_ID)

    def save(self, kind: str, url: str, model_id: str, api_key: str, config_id: str | None = None, *, connection_type='api', protocol=None, auth_mode=None, proxy_mode=None, video_adapter=None, video_capabilities=None, capabilities_supplied=False, input_modalities=None) -> dict:
        if kind not in MODEL_KINDS:
            raise ProjectError("无效的模型类别。")
        fields = model_fields(url, model_id, api_key)
        connection = connection_fields(kind, connection_type, protocol, auth_mode, proxy_mode)
        with self.lock:
            models = self._read()
            existing = next((item for item in models if item["id"] == config_id), None)
            if proxy_mode is None and existing:
                connection['proxyMode'] = existing['proxyMode']
            if config_id and not existing:
                raise ProjectError("模型配置已被删除，请重新加载。", 404)
            # An old standalone SAM entry may be edited through either media
            # category without replacing its identity or credential.
            legacy_segmentation = existing and existing['kind'] == 'vision' and kind in {'image', 'video'}
            if existing and existing["kind"] != kind and not legacy_segmentation:
                raise ProjectError("不能修改模型所属类别。")
            if connection['authMode'] == 'none':
                fields['apiKey'] = ''
            elif not fields['apiKey']:
                if not existing or not existing['apiKey']:
                    raise ProjectError('请填写 API Key，或将鉴权方式设为无需鉴权。')
                fields['apiKey'] = existing['apiKey']
            item = {'id': config_id or str(uuid4()), 'kind': kind, **fields, **connection}
            item['inputModalities'] = agent_input_modalities(kind, input_modalities if input_modalities is not None else (existing or {}).get('inputModalities'))
            item['videoAdapter'] = video_adapter if video_adapter is not None else (existing or {}).get('videoAdapter', 'auto')
            raw = video_capabilities if capabilities_supplied or video_capabilities is not None else (existing or {}).get('videoCapabilities')
            item['videoCapabilities'] = check_video_config(kind, connection['protocol'], item['videoAdapter'], raw)
            profile = input_rules(item)['profile']
            if item['videoCapabilities'] is not None and profile in {'fasth3-omni', 'vllm-omni-h3'}:
                check_video_config(kind, 'vllm_omni', 'fasth3' if profile == 'fasth3-omni' else 'minimax_h3', item['videoCapabilities'])
            if existing:
                models[models.index(existing)] = item
            else:
                models.append(item)
            if existing and 'providerId' in existing:
                item['providerId'] = existing['providerId']
                for peer in models:
                    if peer.get('providerId') == item['providerId']:
                        peer.update({key: item[key] for key in ('url', 'apiKey', 'connectionType', 'authMode', 'proxyMode')})
            self._write(models)
            return self._public(item)

    def delete(self, config_id: str) -> None:
        with self.lock:
            models = self._read()
            remaining = [item for item in models if item["id"] != config_id]
            if len(remaining) == len(models):
                raise ProjectError("模型配置已被删除，请重新加载。", 404)
            self._write(remaining)

    def _write(self, models: list[dict]) -> None:
        services = {}
        stored = []
        for model in models:
            item = dict(model)
            if 'providerId' in item:
                services[item['providerId']] = {key: item.pop(key) for key in ('url', 'apiKey', 'connectionType', 'authMode')}
            stored.append(item)
        write_json(self.path, {'version': 1, 'models': stored, 'services': services})

    def save_many(self, kind: str, url: str, model_ids: list[str], api_key: str,
                  config_id: str | None = None, *, connection_type='api', protocol=None,
                  auth_mode=None, proxy_mode=None, video_adapter=None, video_capabilities=None, input_modalities=None, model_options=None, capabilities_supplied=False) -> list[dict]:
        if kind not in MODEL_KINDS or not 1 <= len(model_ids) <= 200:
            raise ProjectError('请选择 1—200 个模型。')
        model_options = model_options or {}
        if set(model_options) - set(model_ids):
            raise ProjectError('模型能力配置必须属于本次选择的模型。')
        connection = connection_fields(kind, connection_type, protocol, auth_mode, proxy_mode)
        fields = [model_fields(url, model_id, api_key) for model_id in model_ids]
        if len({item['modelId'] for item in fields}) != len(fields):
            raise ProjectError('模型列表不能重复。')
        with self.lock:
            models = self._read()
            existing = next((item for item in models if item['id'] == config_id), None)
            if proxy_mode is None and existing:
                connection['proxyMode'] = existing['proxyMode']
            if config_id and not existing:
                raise ProjectError('模型配置已被删除，请重新加载。', 404)
            legacy_segmentation = existing and existing['kind'] == 'vision' and kind in {'image', 'video'}
            if existing and existing['kind'] != kind and not legacy_segmentation:
                raise ProjectError('不能修改模型所属类别。')
            key = api_key.strip()
            if connection['authMode'] == 'none':
                key = ''
            elif not key:
                if not existing or existing['url'] != fields[0]['url'] or not existing['apiKey']:
                    raise ProjectError('请填写该服务的 API Key；新地址不能复用原地址的密钥。')
                key = existing['apiKey']
            provider_id = existing.get('providerId', existing['id']) if existing else str(uuid4())
            previous = [item for item in models if item.get('providerId') == provider_id or item['id'] == config_id]
            peers = {item['modelId']: item for item in previous}
            saved = []
            for field in fields:
                old = peers.get(field['modelId'])
                if old is None and len(previous) == 1 and len(fields) == 1:
                    old = existing
                item = {'id': old['id'] if old else str(uuid4()), 'kind': kind, **field, **connection,
                        'apiKey': key, 'providerId': provider_id, 'videoAdapter': video_adapter or 'auto'}
                options = model_options.get(field['modelId'], {})
                item['videoAdapter'] = options.get('videoAdapter') or video_adapter or (old or {}).get('videoAdapter', 'auto')
                modalities = options.get('inputModalities', input_modalities if input_modalities is not None else (old or {}).get('inputModalities'))
                item['inputModalities'] = agent_input_modalities(kind, modalities)
                caps = options.get('videoCapabilities', video_capabilities if capabilities_supplied or video_capabilities is not None else (old or {}).get('videoCapabilities'))
                item['videoCapabilities'] = check_video_config(kind, connection['protocol'], item['videoAdapter'], caps)
                profile = input_rules(item)['profile']
                if item['videoCapabilities'] is not None and profile in {'fasth3-omni', 'vllm-omni-h3'}:
                    check_video_config(kind, 'vllm_omni', 'fasth3' if profile == 'fasth3-omni' else 'minimax_h3', item['videoCapabilities'])
                saved.append(item)
            remaining = [item for item in models if item not in previous]
            for item in remaining:
                if item.get('providerId') == provider_id:
                    item.update(url=fields[0]['url'], apiKey=key, connectionType=connection['connectionType'], authMode=connection['authMode'], proxyMode=connection['proxyMode'])
            self._write(remaining + saved)
            return [self._public(item) for item in saved]

    def delete_service(self, config_id: str) -> None:
        with self.lock:
            models = self._read()
            existing = next((item for item in models if item['id'] == config_id), None)
            if existing is None:
                raise ProjectError('服务配置已被删除，请重新加载。', 404)
            provider_id = existing.get('providerId')
            remaining = [item for item in models if item['id'] != config_id
                         and not (provider_id and item.get('providerId') == provider_id and item['kind'] == existing['kind'])]
            self._write(remaining)
