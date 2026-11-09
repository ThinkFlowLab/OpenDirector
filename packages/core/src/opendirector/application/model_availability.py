"""Shared optional capability checks for new work; catalogs never perform I/O.

Configured adapters still own request construction and manual input rules.
Remote observations can reject a precisely matched request, but cannot add
adapters, rewrite configuration, or change an already accepted execution.
"""
from dataclasses import dataclass
import hashlib
import json
from urllib.parse import urlsplit

from opendirector.domain.omni_capabilities import timestamp
from opendirector.domain.projects import ProjectError
from opendirector.integrations.capability_probe import CapabilityProbe, PAUSE_SECONDS, automatic, identity
from opendirector.integrations.volcengine import endpoint


class AvailabilityError(ProjectError):
    def __init__(self, code, message):
        super().__init__(message, 409)
        self.code = code


@dataclass(frozen=True)
class RequestOperation:
    operation: str
    profile: str
    path: str
    output: str
    method: str = 'POST'


def requests_for(config):
    """Only the protocols this application actually sends, including music."""
    kind, protocol = config['kind'], config.get('protocol', 'openai')
    def request(operation, profile, suffix, output):
        return RequestOperation(operation, profile, urlsplit(endpoint(config['url'], suffix)).path, output)
    if kind == 'agent':
        return [request('chat', 'text_response', '/chat/completions', 'text')]
    if kind == 'image' and protocol == 'openai':
        return [request('image_generation', 'text_to_image', '/images/generations', 'image'),
                request('image_edit', 'image_to_image', '/images/edits', 'image')]
    if kind == 'video' and protocol == 'vllm_omni':
        return [request('video_generation', profile, '/videos', 'video')
                for profile in ('text_to_video', 'image_to_video', 'video_to_video')]
    if kind == 'audio' and protocol in {'openai', 'vllm_omni_music'}:
        return [request('speech', 'lyrics_to_music' if protocol == 'vllm_omni_music' else 'text_to_speech', '/audio/speech', 'audio')]
    # Ark/Minimax and specialized segmentation, depth, score protocols have
    # different wire contracts. A shared media label proves no Omni operation.
    return []


def generation_request(config, spec, references):
    candidates = requests_for(config)
    if not candidates:
        return None
    transmitted = [item for item in references if item.transmission != 'context_only']
    kinds = {item.asset.kind for item in transmitted}
    if spec.kind == 'image':
        profile = 'image_to_image' if 'image' in kinds else 'text_to_image'
    elif spec.kind == 'video':
        profile = 'video_to_video' if 'video' in kinds else 'image_to_video' if 'image' in kinds else 'text_to_video'
    elif spec.kind == 'audio':
        profile = 'lyrics_to_music' if spec.parameters.creationType == 'music' else 'text_to_speech'
    else:
        profile = 'text_response'
    return next((item for item in candidates if item.profile == profile), None)


def tool_request(config, capability):
    profile = {'text.chat': 'text_response', 'image.generate': 'text_to_image', 'image.edit': 'image_to_image', 'image.cutout': 'image_to_image',
               'video.generate': 'text_to_video', 'video.first_frame': 'image_to_video',
               'video.edit': 'video_to_video',
               'audio.speech': 'text_to_speech', 'audio.music': 'lyrics_to_music'}.get(capability)
    return next((item for item in requests_for(config) if item.profile == profile), None)


def _revision(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()[:24]


class ModelAvailability:
    def __init__(self, configs, probe=None):
        self.configs = configs
        self.probe = probe or CapabilityProbe()

    def prepare(self, config, *, manual=False):
        self.probe.query(config, manual=manual)
        return identity(config)

    def assert_identity(self, config, prepared):
        if identity(config) != prepared:
            raise AvailabilityError('capability_connection_changed', '能力检查期间模型服务已变化，请重新提交。')

    def decision(self, config, request):
        observation = self.probe.peek(config)
        result = dict(operation=request.operation, profile=request.profile, method=request.method,
                      path=request.path, output=request.output, status='unknown', reasonCode='not_checked',
                      checkedAt=None, expiresAt=None)
        if not observation:
            return result
        result.update(checkedAt=round(observation.checked * 1000), expiresAt=round(observation.expires * 1000), reasonCode=observation.reason)
        document = observation.document
        if document is None:
            return result
        model = next((item for item in document.models if item.id == config['modelId']), None)
        operation = model.operations.get(request.operation) if model else None
        if operation is None:
            result['reasonCode'] = 'model_not_declared' if model is None else 'operation_not_declared'
            return result
        profile = next((item for item in operation.profiles if item.id == request.profile), None)
        if operation.support == 'unsupported':
            result.update(status='unavailable', reasonCode='operation_unsupported')
        elif operation.exposure == 'disabled':
            result.update(status='unavailable', reasonCode='operation_disabled')
        elif profile is None:
            result['reasonCode'] = 'profile_not_declared'
        elif profile.support == 'unsupported':
            result.update(status='unavailable', reasonCode='profile_unsupported')
        else:
            route = next((item for item in profile.routes if item.transport == 'http'
                          and item.method == request.method and item.path == request.path), None)
            exposed = next((item for item in document.routes if item.transport == 'http'
                            and item.method == request.method and item.path == request.path), None)
            if route is None:
                result['reasonCode'] = 'route_not_declared'
            elif route.exposure == 'disabled' or (exposed and exposed.exposure == 'disabled'):
                result.update(status='unavailable', reasonCode='route_disabled')
            elif operation.support == profile.support == 'supported' and profile.outputs and request.output not in profile.outputs:
                result.update(status='unavailable', reasonCode='output_unsupported')
            elif operation.support == profile.support == 'supported' and request.output in profile.outputs:
                result.update(status='available', reasonCode='supported')
            else:
                result['reasonCode'] = 'declaration_incomplete'
            # Only a route which serves this exact request can establish pause.
            execution = operation.execution
            if route and execution.state == 'paused' and execution.scope == 'deployment':
                try:
                    timestamp(execution.observed_at)  # Validate provenance, without comparing unrelated machine clocks.
                    if self.probe.clock() < observation.received + PAUSE_SECONDS:
                        result.update(status='unavailable', reasonCode='execution_paused', expiresAt=round((observation.checked + PAUSE_SECONDS) * 1000))
                except (ValueError, TypeError, AttributeError):
                    pass
        return result

    def require(self, config, request, prepared=None):
        if prepared is not None:
            self.assert_identity(config, prepared)
        if request is None:
            return
        decision = self.decision(config, request)
        if decision['status'] == 'unavailable':
            code = 'capability_paused' if decision['reasonCode'] == 'execution_paused' else 'capability_unavailable'
            raise AvailabilityError(code, '模型执行入口已暂停，请稍后重试。' if code == 'capability_paused'
                                    else '服务明确不支持当前请求，请查看模型能力并修改选择。')

    def model(self, config):
        operations = [self.decision(config, request) for request in requests_for(config)]
        states = {item['status'] for item in operations}
        state = ('unavailable' if states == {'unavailable'} else 'available' if states == {'available'} else 'unknown')
        observation = self.probe.peek(config)
        value = dict(configId=config.get('id'), modelId=config['modelId'], identity=identity(config), autoCheck=automatic(config),
                     status=state, reasonCode=(operations[0]['reasonCode'] if operations and len(states) == 1 else 'mixed_operations' if operations else 'adapter_not_mapped'),
                     checkedAt=round(observation.checked * 1000) if observation else None,
                     expiresAt=min((item['expiresAt'] for item in operations if item['expiresAt'] is not None), default=None), operations=operations)
        return {**value, 'revision': _revision(value)}

    def list(self):
        values = [self.model(private) for _, private in self.configs.catalog_snapshot()]
        return {'revision': _revision(values), 'models': values}

    def catalog(self):
        return [{**public, 'availability': self.model(private)} for public, private in self.configs.catalog_snapshot()]

    def refresh(self, config_ids=None, *, manual=False):
        if type(manual) is not bool or (config_ids is not None and not 1 <= len(config_ids) <= 200):
            raise ProjectError('能力刷新参数无效，请指定 1–200 个模型配置。', 422)
        if manual and not config_ids:
            raise ProjectError('手动检查需要指定模型配置。', 422)
        selected = set(config_ids) if config_ids is not None else None
        values = self.configs.list()
        if selected is not None and selected - {item['id'] for item in values}:
            raise ProjectError('模型配置已被删除，请重新加载。', 404)
        seen = set()
        for item in values:
            if selected is not None and item['id'] not in selected:
                continue
            config = self.configs.resolve(item['id'], item['kind'])
            if not manual and not automatic(config):
                continue
            key = identity(config, service=True)
            if key not in seen:
                self.prepare(config, manual=manual)
                seen.add(key)
        return self.list()
