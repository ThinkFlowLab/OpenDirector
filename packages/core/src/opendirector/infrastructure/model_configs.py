"""Application-wide model settings. Secrets never leave this store's API."""

from __future__ import annotations

import os
from pathlib import Path
from uuid import uuid4

from filelock import FileLock

from opendirector.domain.projects import ProjectError, identifier
from opendirector.domain.input_rules import input_rules
from opendirector.domain.capabilities import agent_input_modalities
from opendirector.domain.model_connection import connection_fields, is_bigmodel_connection, model_fields, same_connection_address
from opendirector.domain.video_capabilities import check_video_config
from opendirector.infrastructure.local_projects import child, read_json, write_json

MODEL_KINDS = ("agent", "image", "video", "audio", "vision")


def _provider_for_edit(models, existing, draft):
    provider_id = existing.get('providerId', existing['id'])
    # Moving a category off a shared account must not move other categories' keys or URLs.
    if not is_bigmodel_connection(draft) and any(
        item.get('providerId') == provider_id and item['kind'] != existing['kind'] for item in models
    ):
        new_id = str(uuid4())
        for item in models:
            if item.get('providerId') == provider_id and item['kind'] == existing['kind']:
                item['providerId'] = new_id
        return new_id
    return provider_id


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
                fields = model_fields(item["url"], item["modelId"], item["apiKey"])
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

    def resolve(self, config_id: str, kind: str, *, connection: dict | None = None) -> dict:
        with self.lock:
            item = next((item for item in self._read() if item["id"] == config_id), None)
            if item is None or (item["kind"] != kind and not (
                connection and is_bigmodel_connection(item) and is_bigmodel_connection(connection)
            )):
                raise ProjectError("所选模型不存在或类别不符，请在设置中配置并重新选择。", 409)
            return dict(item)

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
            draft = {'kind': kind, **fields, **connection}
            if connection['authMode'] == 'none':
                fields['apiKey'] = ''
            elif not fields['apiKey']:
                if not existing or not existing['apiKey']:
                    raise ProjectError('请填写 API Key，或将鉴权方式设为无需鉴权。')
                if not same_connection_address(existing, draft):
                    raise ProjectError('请填写该服务的 API Key；新地址不能复用原地址的密钥。')
                fields['apiKey'] = existing['apiKey']
            item = {'id': config_id or str(uuid4()), 'kind': kind, **fields, **connection}
            item['inputModalities'] = agent_input_modalities(kind, input_modalities if input_modalities is not None else (existing or {}).get('inputModalities'))
            item['videoAdapter'] = video_adapter if video_adapter is not None else (existing or {}).get('videoAdapter', 'auto')
            raw = video_capabilities if capabilities_supplied or video_capabilities is not None else (existing or {}).get('videoCapabilities')
            item['videoCapabilities'] = check_video_config(kind, connection['protocol'], item['videoAdapter'], raw)
            profile = input_rules(item)['profile']
            if item['videoCapabilities'] is not None and profile in {'fasth3-omni', 'vllm-omni-h3'}:
                check_video_config(kind, 'vllm_omni', 'fasth3' if profile == 'fasth3-omni' else 'minimax_h3', item['videoCapabilities'])
            if existing and 'providerId' in existing:
                item['providerId'] = _provider_for_edit(models, existing, item)
            if existing:
                models[models.index(existing)] = item
            else:
                models.append(item)
            if 'providerId' in item:
                for peer in models:
                    if peer.get('providerId') == item['providerId']:
                        peer.update({key: item[key] for key in ('url', 'apiKey', 'connectionType', 'authMode')})
                        if peer['kind'] == kind:
                            peer['proxyMode'] = item['proxyMode']
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
            draft = {'kind': kind, **fields[0], **connection}
            cross_category = existing and existing['kind'] != kind and not legacy_segmentation
            if cross_category and not (is_bigmodel_connection(existing) and is_bigmodel_connection(draft)):
                raise ProjectError('不能修改模型所属类别。')
            key = api_key.strip()
            if connection['authMode'] == 'none':
                key = ''
            elif not key:
                if not existing or not same_connection_address(existing, draft) or not existing['apiKey']:
                    raise ProjectError('请填写该服务的 API Key；新地址不能复用原地址的密钥。')
                key = existing['apiKey']
            provider_id = _provider_for_edit(models, existing, draft) if existing else str(uuid4())
            if cross_category:
                # Promote an explicitly selected standalone record, preserving its model ID.
                existing['providerId'] = provider_id
            previous = [item for item in models if (item.get('providerId') == provider_id and item['kind'] == kind)
                        or (item['id'] == config_id and not cross_category)]
            peers = {item['modelId']: item for item in previous}
            saved = []
            for field in fields:
                old = peers.get(field['modelId'])
                if old is None and len(previous) == 1 and len(fields) == 1:
                    old = previous[0]
                item = {'id': old['id'] if old else str(uuid4()), 'kind': kind, **field, **connection,
                        'apiKey': key, 'providerId': provider_id, 'videoAdapter': video_adapter or 'auto'}
                if cross_category and proxy_mode is None and previous:
                    item['proxyMode'] = (old or previous[0])['proxyMode']
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
                    item.update(url=fields[0]['url'], apiKey=key, connectionType=connection['connectionType'], authMode=connection['authMode'])
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
