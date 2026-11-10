"""Editable output contracts. A declaration is data, never executable provider code."""
import re
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator

from opendirector.domain.projects import ProjectError
from opendirector.domain.minimax_models import MINIMAX_MODELS, minimax_capabilities
from opendirector.domain.kling_models import kling_capabilities

VideoAdapter = Literal['auto', 'fasth3', 'minimax_h3', 'standard']
Second = Annotated[StrictInt, Field(ge=1, le=60)]


class VideoOutput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    resolution: str = Field(pattern=r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,23}$', description='Requested output resolution.')
    durations: list[Second] = Field(min_length=1, max_length=60, description='Supported output durations in seconds.')
    width: Annotated[StrictInt, Field(ge=64, le=8192)] | None = Field(default=None, description='Width in pixels.')
    height: Annotated[StrictInt, Field(ge=64, le=8192)] | None = Field(default=None, description='Height in pixels.')

    @model_validator(mode='after')
    def normalize(self):
        self.resolution = self.resolution.upper()
        if self.resolution in {'AUTO', '自动'}:
            raise ValueError('自动是保留选项，不能作为输出规格。')
        if (self.width is None) != (self.height is None) or self.width is not None and self.width < self.height:
            raise ValueError('尺寸须同时填写横屏宽高，且宽不小于高。')
        self.durations = sorted(set(self.durations))
        return self


class VideoCapabilities(BaseModel):
    model_config = ConfigDict(extra='forbid')
    outputs: list[VideoOutput] = Field(min_length=1, max_length=20, description='Supported output resolution and duration combinations.')
    defaultResolution: str = Field(default='auto', description='Default output resolution or auto.')
    defaultDuration: Second = Field(default=5, description='Default output duration in seconds.')
    dimensionStep: Literal[1, 2, 8, 16, 32, 64] = Field(default=2, description='Required pixel alignment of output dimensions.')

    @model_validator(mode='after')
    def defaults_exist(self):
        labels = [item.resolution for item in self.outputs]
        if len(labels) != len(set(labels)):
            raise ValueError('分辨率不能重复。')
        self.defaultResolution = 'auto' if self.defaultResolution.lower() == 'auto' else self.defaultResolution.upper()
        matching = [item for item in self.outputs if self.defaultResolution in {'auto', item.resolution}]
        if not matching or not any(self.defaultDuration in item.durations for item in matching):
            raise ValueError('默认分辨率和时长必须属于已声明的输出规格。')
        if any(item.width is not None and (item.width % self.dimensionStep or item.height % self.dimensionStep)
               for item in self.outputs):
            raise ValueError('输出宽高须符合像素对齐步长。')
        return self


SEEDANCE_20 = re.compile(r'doubao-seedance-2[.-]0(?:[.-](mini|fast))?(?:[.-]\d{6})?')


def seedance_20_variant(model):
    """Ark's Seedance 2.0 ids: the full model, mini and fast, with an optional date suffix."""
    match = SEEDANCE_20.fullmatch(model.rsplit('/', 1)[-1].lower())
    return None if match is None else (match.group(1) or 'full')


def preset_capabilities(profile, model=''):
    if profile == 'kling-official':
        return kling_capabilities(model)
    if profile in {'fasth3-omni', 'vllm-omni-h3'}:
        return {'outputs': [{'resolution': label, 'durations': list(range(4, 16)), 'width': width, 'height': height}
                            for label, width, height in [('480P', 832, 480), ('768P', 1344, 768)]],
                'defaultResolution': 'auto', 'defaultDuration': 5, 'dimensionStep': 32}
    if profile == 'minimax-h3-official':
        return {'outputs': [{'resolution': label, 'durations': list(range(4, 16))} for label in ['768P', '2K']],
                'defaultResolution': '768P', 'defaultDuration': 5, 'dimensionStep': 2}
    if profile == 'seedance-2.0':
        # mini and fast stop at 720P; the full model adds 1080P and 4K.
        labels = ['480P', '720P'] if seedance_20_variant(model) in {'mini', 'fast'} else ['480P', '720P', '1080P', '4K']
        return {'outputs': [{'resolution': label, 'durations': list(range(4, 16))} for label in labels],
                'defaultResolution': 'auto', 'defaultDuration': 5, 'dimensionStep': 2}
    return None


def capability_fields(config, rules):
    capabilities = config.get('videoCapabilities') or preset_capabilities(rules['profile'], config['modelId'])
    if rules['profile'] == 'minimax-h3-official' and config['modelId'] in MINIMAX_MODELS:
        native = minimax_capabilities(config['modelId'])
        if config.get('videoCapabilities'):
            allowed = {item['resolution']: item['durations'] for item in native['outputs']}
            if any(item['resolution'] not in allowed or any(second not in allowed[item['resolution']] for second in item['durations'])
                   for item in capabilities['outputs']):
                raise ProjectError('输出规格超出所选 MiniMax 型号支持的范围。')
        else:
            capabilities = native
    if rules['profile'] == 'kling-official':
        validate_kling_outputs(capabilities, config['modelId'])
    rules['videoCapabilities'] = capabilities
    rules['outputResolutions'] = [item['resolution'] for item in capabilities['outputs']] if capabilities else []
    return rules


def validate_kling_outputs(capabilities, model_id='kling-4.0'):
    native = kling_capabilities(model_id)
    allowed = {item['resolution']: item['durations'] for item in native['outputs']}
    if any(item['resolution'] not in allowed or any(second not in allowed[item['resolution']] for second in item['durations'])
           or item.get('width') is not None or item.get('height') is not None for item in capabilities['outputs']):
        raise ProjectError('可灵输出规格无效，请选择所选型号支持的分辨率和整数时长。', 422, code='kling_output')


def check_video_config(kind, protocol, adapter, capabilities):
    if adapter not in {'auto', 'fasth3', 'minimax_h3', 'standard'}:
        raise ProjectError('无效的视频适配方式。')
    if kind != 'video' and (adapter != 'auto' or capabilities is not None):
        raise ProjectError('输出能力配置仅适用于视频模型。')
    if protocol == 'vllm_omni_segmentation' and (adapter != 'auto' or capabilities is not None):
        raise ProjectError('视觉分割接口不支持视频生成输出规格。')
    if protocol == 'vllm_omni_depth' and (adapter != 'auto' or capabilities is not None):
        raise ProjectError('视频深度接口不支持视频生成输出规格。')
    if adapter != 'auto' and protocol != 'vllm_omni':
        raise ProjectError('所选视频适配方式需要 /videos 接口协议。')
    if capabilities is not None:
        try:
            capabilities = VideoCapabilities.model_validate(capabilities).model_dump(exclude_none=True)
        except ValueError:
            raise ProjectError('视频输出规格无效，请检查分辨率、尺寸、时长和默认值。') from None
        if protocol == 'kling_video':
            validate_kling_outputs(capabilities)
            return capabilities
        if protocol == 'minimax_video_v2':
            if any(item['resolution'].upper() not in {'480P', '768P', '2K'} or
                   any(second not in range(4, 16) for second in item['durations']) or
                   item.get('width') is not None or item.get('height') is not None for item in capabilities['outputs']):
                raise ProjectError('MiniMax-H3 官方接口支持 480P、768P、2K 和 4—15 秒，具体取决于型号，不接受自定义像素尺寸。')
            return capabilities
        if adapter in {'fasth3', 'minimax_h3'}:
            if any(not 4 <= second <= 15 for item in capabilities['outputs'] for second in item['durations']):
                raise ProjectError('当前 H3 适配支持 4–15 秒，不能通过能力配置扩大此范围。')
            if capabilities['dimensionStep'] != 32:
                raise ProjectError('H3 输出宽高必须按 32 像素对齐（像素对齐步长须为 32）。')
        # The /videos resolver needs explicit pixels, except for the two H3 buckets
        # it derives itself; saving an unusable declaration would only fail later.
        derived = {'480P', '768P'} if adapter in {'fasth3', 'minimax_h3'} else set()
        if any(item.get('width') is None and item['resolution'] not in derived for item in capabilities['outputs']):
            raise ProjectError('该适配方式需要为每个输出规格填写像素宽高（H3 的 480P、768P 可按档位推算）。')
    return capabilities


def validate_video_duration(config, seconds, resolution=None):
    from opendirector.domain.input_rules import input_rules
    capabilities = input_rules(config).get('videoCapabilities')
    if capabilities:
        choices = [item for item in capabilities['outputs']
                   if not resolution or resolution in {'auto', '自动'} or item['resolution'] == resolution.upper()]
        if not any(seconds in item['durations'] for item in choices):
            raise ProjectError('当前模型的分辨率与时长组合不受支持，请重新选择；未提交生成。')
