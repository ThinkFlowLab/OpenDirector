"""Shared optional capability checks for new work; catalogs never perform I/O.

Configured adapters still own request construction and manual input rules.
Remote observations can reject a precisely matched request, but cannot add
adapters, rewrite configuration, or change an already accepted execution.
"""
from dataclasses import dataclass, replace
from collections import Counter
from math import ceil, lcm
import hashlib
import json
from urllib.parse import urlsplit

from opendirector.domain.omni_capabilities import timestamp
from opendirector.domain.image_inputs import image_input_policy
from opendirector.domain.input_rules import input_rules
from opendirector.domain.request_constraints import INPUT_ROLES, constraint_failure, input_details
from opendirector.domain.capability_messages import constraint_rejection
from opendirector.domain.voices import effective_speech_voice
from opendirector.domain.projects import ProjectError
from opendirector.integrations.capability_probe import CapabilityProbe, PAUSE_SECONDS, automatic, identity
from opendirector.integrations.generation_capability_parameters import generation_capability_parameters
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
    # None is a directory projection; an actual request fixes transmitted inputs.
    inputs: frozenset[str] | None = None
    input_counts: tuple[tuple[str, int], ...] | None = None
    parameters: tuple[tuple[str, str | int | float | bool], ...] = ()


def requests_for(config, *, inputs=None):
    """Only the protocols this application actually sends, including music."""
    kind, protocol = config['kind'], config.get('protocol', 'openai')
    def request(operation, profile, suffix, output):
        return RequestOperation(operation, profile, urlsplit(endpoint(config['url'], suffix)).path, output,
                                inputs=frozenset(inputs) if inputs is not None else None)
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


def generation_request(config, spec, references, *, parameters=None):
    candidates = requests_for(config)
    if not candidates:
        return None
    transmitted = [item for item in references if item.transmission == 'content']
    kinds = {item.asset.kind for item in transmitted}
    if spec.kind == 'image':
        profile = 'image_to_image' if 'image' in kinds else 'text_to_image'
    elif spec.kind == 'video':
        profile = 'video_to_video' if 'video' in kinds else 'image_to_video' if 'image' in kinds else 'text_to_video'
    elif spec.kind == 'audio':
        profile = 'lyrics_to_music' if spec.parameters.creationType == 'music' else 'text_to_speech'
    else:
        profile = 'text_response'
    request = next((item for item in candidates if item.profile == profile), None)
    if spec.kind == 'video' and any(item.transmission == 'latent' for item in references):
        # A cached continuation ID is not a video upload. Keep its profile
        # unknown unless declared, while retaining the actual route for pause.
        request = replace(candidates[0], profile='video_continuation')
    # The resolved reference transmission is the same one frozen for execution.
    # Music sends the prompt as instructions and lyrics (or arrangement tags
    # for instrumental music) as the text field on /audio/speech.
    inputs = {'text'}
    if spec.kind in {'text', 'video'}:
        inputs.update(kinds)
    elif spec.kind == 'image':
        inputs.update(kinds & {'image'})
    if profile == 'lyrics_to_music':
        inputs.add('instructions')
    counts = Counter(item.asset.kind for item in transmitted if item.asset.kind in inputs)
    counts['text'] = 1
    if profile == 'lyrics_to_music':
        counts['instructions'] = 1
    actual = generation_capability_parameters(config, spec.kind, parameters, has_images='image' in kinds) if parameters is not None else {}
    if profile == 'text_to_speech':
        voice = effective_speech_voice(config, getattr(getattr(spec, 'parameters', None), 'voice', None))
        counts['voice'] = 1
        inputs.add('voice')
        actual['voice'] = voice
    return replace(request, inputs=frozenset(inputs), input_counts=tuple(counts.items()),
                   parameters=tuple(actual.items())) if request else None


def tool_request(config, capability, *, actual=False):
    profile = {'text.chat': 'text_response', 'image.generate': 'text_to_image', 'image.edit': 'image_to_image', 'image.cutout': 'image_to_image',
               'video.generate': 'text_to_video', 'video.first_frame': 'image_to_video',
               'video.edit': 'video_to_video',
               'audio.speech': 'text_to_speech', 'audio.music': 'lyrics_to_music'}.get(capability)
    request = next((item for item in requests_for(config) if item.profile == profile), None)
    if request is None or not actual:
        return request
    # These are the arguments of the existing tool adapters, not all source
    # assets: e.g. a video-to-video tool does not transmit an audio attachment.
    inputs = {'text'}
    if profile in {'image_to_image', 'image_to_video'}:
        inputs.add('image')
    elif profile == 'video_to_video':
        inputs.add('video')
    elif profile == 'lyrics_to_music':
        inputs.add('instructions')
    return replace(request, inputs=frozenset(inputs))


def _revision(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()[:24]


class ModelAvailability:
    def __init__(self, configs, probe=None):
        self.configs = configs
        self.probe = probe or CapabilityProbe()

    def prepare(self, config, *, manual=False):
        self.probe.query(config, manual=manual)
        return identity(config)

    def prepare_many(self, configs):
        """Check one acceptance's dependencies within a shared query budget."""
        configs = list(configs)
        self.probe.query_many(configs)
        return [identity(config) for config in configs]

    def assert_identity(self, config, prepared):
        if identity(config) != prepared:
            raise AvailabilityError('capability_connection_changed', '能力检查期间模型服务已变化，请重新提交。')

    def request_constraints(self, config, request):
        """Return only the complete constraint set for the actual HTTP route."""
        observation = self.probe.peek(config)
        if not observation or not observation.document or request is None:
            return None
        document = observation.document
        model = next((value for value in document.models if value.id == config['modelId']), None)
        operation = model.operations.get(request.operation) if model else None
        profile = next((value for value in operation.profiles if value.id == request.profile), None) if operation else None
        if not profile or operation.support == 'unsupported' or profile.support == 'unsupported':
            return None
        route = next((value for value in profile.routes if value.transport == 'http'
                      and value.path == request.path and value.method == request.method), None)
        exposed = next((value for value in document.routes if value.transport == 'http'
                        and value.path == request.path and value.method == request.method), None)
        if (route is None or route.exposure == 'disabled' or operation.exposure == 'disabled'
                or (exposed and exposed.exposure == 'disabled')):
            return None
        return route.request

    def image_execution_policy(self, config):
        policy = image_input_policy(config)
        request = next((value for value in requests_for(config) if value.profile == 'image_to_image'), None)
        contract = self.request_constraints(config, request)
        if contract is None:
            return policy
        images = contract.inputs.get('image')
        if images is not None:
            if images.support == 'unsupported':
                policy['maxImages'] = 0
            elif images.max_count is not None:
                policy['maxImages'] = min(policy['maxImages'], images.max_count)
        mask, role = contract.mask, contract.inputs.get('mask_image')
        if (mask is None or mask.support != 'supported' or role is None or role.support != 'supported'
                or mask.source_role != 'image' or mask.white != 'edit' or mask.black != 'preserve'
                or mask.binarize_threshold != 0.5 or mask.requires_same_size is not True
                or mask.geometry.state != 'known' or mask.geometry.multiple_of is None
                or mask.max_source_count is None or mask.source_resize is None or mask.source_resize.max_pixels is None
                or mask.source_resize.policy != 'downscale_preserve_aspect_ratio'
                or (role.max_count is not None and role.max_count < 1) or (role.min_count or 0) > 1
                or (images is not None and (images.min_count or 0) > 1)):
            return policy
        reference = contract.inputs.get('reference_image')
        max_reference = (reference.max_count if reference and reference.support == 'supported'
                         and reference.max_count is not None else 0)
        width, height = contract.parameters.get('width'), contract.parameters.get('height')
        policy['nativeMask'] = dict(field='mask_image', referenceField='reference_image' if max_reference else None,
            encoding='grayscale_white_edit', minImages=1, maxImages=min(policy['maxImages'], mask.max_source_count),
            maxReferenceImages=max_reference,
            minReferenceImages=reference.min_count or 0 if reference else 0,
            widthMultiple=lcm(mask.geometry.multiple_of, int(width.step)) if width and width.step and float(width.step).is_integer() else mask.geometry.multiple_of,
            heightMultiple=lcm(mask.geometry.multiple_of, int(height.step)) if height and height.step and float(height.step).is_integer() else mask.geometry.multiple_of,
            minWidth=max(1, ceil(width.minimum)) if width and width.minimum is not None else 1,
            minHeight=max(1, ceil(height.minimum)) if height and height.minimum is not None else 1,
            maxWidth=width.maximum if width else None, maxHeight=height.maximum if height else None,
            widthValues=width.enum if width else None, heightValues=height.enum if height else None,
            widthStep=width.step if width else None, heightStep=height.step if height else None,
            maxPixels=min(mask.source_resize.max_pixels, contract.max_output_pixels or mask.source_resize.max_pixels), sameSize=True)
        return policy

    def effective_input_rules(self, config):
        """Compose acceptance limits without writing them into saved settings."""
        rules = input_rules(config)
        if config['kind'] == 'image':
            rules['maxImages'] = self.image_execution_policy(config)['maxImages']
        return rules

    @staticmethod
    def _declaration(result):
        result['declaration'] = {key: result[key] for key in ('status', 'reasonCode', 'checkedAt', 'expiresAt')}
        return result

    def decision(self, config, request):
        observation = self.probe.peek(config)
        result = dict(operation=request.operation, profile=request.profile, method=request.method,
                      path=request.path, output=request.output, status='unknown', reasonCode='not_checked',
                      checkedAt=None, expiresAt=None, inputDetails=[])
        if not observation:
            return self._declaration(result)
        result.update(checkedAt=round(observation.checked * 1000), expiresAt=round(observation.expires * 1000), reasonCode=observation.reason)
        document = observation.document
        if document is None:
            return self._declaration(result)
        model = next((item for item in document.models if item.id == config['modelId']), None)
        operation = model.operations.get(request.operation) if model else None
        if operation is None:
            result['reasonCode'] = 'model_not_declared' if model is None else 'operation_not_declared'
            return self._declaration(result)
        profile = next((item for item in operation.profiles if item.id == request.profile), None)
        route = None
        exposed = next((item for item in document.routes if item.transport == 'http'
                        and item.method == request.method and item.path == request.path), None)
        if operation.support == 'unsupported':
            result.update(status='unavailable', reasonCode='operation_unsupported')
        elif operation.exposure == 'disabled':
            result.update(status='unavailable', reasonCode='operation_disabled')
        elif profile is None:
            if exposed and exposed.exposure == 'disabled':
                result.update(status='unavailable', reasonCode='route_disabled')
            else:
                result['reasonCode'] = 'profile_not_declared'
            route = next((route for item in operation.profiles for route in item.routes
                          if route.transport == 'http' and route.method == request.method and route.path == request.path), None)
        elif profile.support == 'unsupported':
            result.update(status='unavailable', reasonCode='profile_unsupported')
        else:
            route = next((item for item in profile.routes if item.transport == 'http'
                          and item.method == request.method and item.path == request.path), None)
            if route is None:
                result['reasonCode'] = 'route_not_declared'
            elif route.exposure == 'disabled' or (exposed and exposed.exposure == 'disabled'):
                result.update(status='unavailable', reasonCode='route_disabled')
            elif operation.support == profile.support == 'supported' and profile.outputs and request.output not in profile.outputs:
                result.update(status='unavailable', reasonCode='output_unsupported')
            elif operation.support == profile.support == 'supported' and request.output in profile.outputs:
                required = set(profile.required_inputs)
                if required - INPUT_ROLES:
                    result['reasonCode'] = 'input_contract_unknown'
                elif request.inputs is not None and required - request.inputs:
                    result.update(status='unavailable', reasonCode='required_inputs_missing')
                else:
                    result.update(status='available', reasonCode='supported')
            else:
                result['reasonCode'] = 'declaration_incomplete'
            contract = route.request if route is not None else None
            if contract is not None:
                result['inputDetails'] = input_details(contract)
                if config['kind'] == 'image' and 'image' in contract.inputs:
                    maximum = contract.inputs['image'].max_count
                    local_maximum = input_rules(config)['maxImages']
                    if maximum is not None and maximum > local_maximum:
                        result['inputDetails'].append(dict(name='image', source='application',
                            support='supported' if local_maximum else 'unsupported', maxCount=local_maximum))
                counts = dict(request.input_counts) if request.input_counts is not None else (
                    {role: 1 for role in request.inputs} if request.inputs is not None else None)
                failure = constraint_failure(contract, counts, dict(request.parameters))
                if failure and result['status'] != 'unavailable':
                    result.update(status='unavailable', reasonCode=failure[0])
        self._declaration(result)
        # Execution is an operation fact on the actual endpoint. An unknown
        # input profile does not invalidate a fresh deployment pause there.
        execution = operation.execution
        if route:
            try:
                timestamp(execution.observed_at)
                active = self.probe.clock() < observation.received + PAUSE_SECONDS
                result['execution'] = dict(state=execution.state if active else 'unknown', scope=execution.scope,
                    checkedAt=round(observation.checked * 1000),
                    expiresAt=round((observation.checked + PAUSE_SECONDS) * 1000) if active else None)
                if active and execution.state == 'paused' and execution.scope == 'deployment' and result['reasonCode'] != 'route_disabled':
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
            labels = {'text_response': '文字回复', 'image_response': '图片回复', 'text_to_image': '图片生成',
                      'image_to_image': '图片编辑', 'text_to_video': '文字生成视频', 'image_to_video': '图片生成视频',
                      'video_to_video': '视频编辑', 'text_to_speech': '语音合成', 'lyrics_to_music': '音乐生成'}
            label = labels.get(request.profile, '此操作')
            message = ('服务已暂停，请恢复后重试。' if code == 'capability_paused'
                       else f'服务未开放{label}。' if decision['reasonCode'] in {'route_disabled', 'operation_disabled'}
                       else '请补充所需素材。' if decision['reasonCode'] == 'required_inputs_missing'
                       else f'该模型不支持{label}。')
            contract = self.request_constraints(config, request)
            counts = dict(request.input_counts) if request.input_counts is not None else (
                {role: 1 for role in request.inputs} if request.inputs is not None else None)
            failure = constraint_failure(contract, counts, dict(request.parameters)) if contract else None
            if failure and decision['reasonCode'] == failure[0]:
                code, message = constraint_rejection(*failure)
            raise AvailabilityError(code, message)

    def model(self, config):
        operations = [self.decision(config, request) for request in requests_for(config)]
        for index, value in enumerate(operations):
            if value['profile'] != 'image_to_image':
                continue
            request = next(item for item in requests_for(config) if item.profile == 'image_to_image')
            contract = self.request_constraints(config, request)
            constraint = contract.inputs.get('image') if contract else None
            single = self.decision(config, replace(request, inputs=frozenset({'text', 'image'}),
                                                   input_counts=(('text', 1), ('image', 1))))
            operations[index] = single
            multi = {**value, 'profile': 'images_to_image'}
            declaration = dict(value['declaration'])
            if declaration['status'] != 'unavailable':
                if constraint and (constraint.support == 'unsupported' or constraint.max_count is not None and constraint.max_count < 2):
                    declaration.update(status='unavailable', reasonCode='input_count_unsupported')
                elif not constraint or (constraint.max_count is None and (constraint.min_count or 0) < 2):
                    declaration.update(status='unknown', reasonCode='input_count_unknown')
            multi['declaration'] = declaration
            if multi['reasonCode'] != 'execution_paused':
                multi.update(declaration)
            operations.insert(index + 1, multi)
            break
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
        seen, configs = set(), []
        for item in values:
            if selected is not None and item['id'] not in selected:
                continue
            config = self.configs.resolve(item['id'], item['kind'])
            if not manual and not automatic(config):
                continue
            key = identity(config, service=True)
            if key not in seen:
                configs.append(config)
                seen.add(key)
        self.probe.query_many(configs, manual=manual)
        return self.list()
