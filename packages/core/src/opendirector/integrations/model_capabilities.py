"""Read service model lists and resolve video capabilities."""
import json
import logging

import httpx

from opendirector.domain.projects import ProjectError
from opendirector.domain.minimax_models import MINIMAX_MODELS
from opendirector.domain.kling_models import KLING_MODELS, kling_capabilities
from opendirector.domain.bigmodel_video import COGVIDEO_MODEL, cogvideo_capabilities
from opendirector.domain.video_capabilities import VideoCapabilities
from opendirector.integrations.http_settings import MODEL_HTTP_HOOKS, auth_headers, trust_environment
from opendirector.integrations.volcengine import endpoint


logger = logging.getLogger(__name__)


def _model_list_hint(status):
    """Name the likely cause so a 401 is not read as a model-capability verdict."""
    if status == 401:
        return '密钥无效、已过期或无权访问该地址'
    if status == 403:
        return '该密钥无权访问此地址，或该接口未对当前账号开放'
    if status == 404:
        return '该地址没有 /models 接口，请检查 Base URL（通常以 /v1 结尾）'
    if status == 405:
        return '该地址不接受 GET /models，请检查 Base URL'
    if status == 429:
        return '请求过于频繁或额度不足'
    if status >= 500:
        return '服务端暂时不可用'
    return '服务返回了未预期的状态'


async def read_service_models(config, transport=None):
    if config.get('protocol') == 'bigmodel_video':
        return [{'id': COGVIDEO_MODEL, 'videoCapabilities': cogvideo_capabilities()}]
    if config.get('protocol') == 'kling_video':
        return [{'id': name, 'videoCapabilities': kling_capabilities(name)} for name in KLING_MODELS]
    if config.get('protocol') == 'minimax_video_v2':
        return [{'id': name} for name in MINIMAX_MODELS]
    is_text_model = config.get('kind') == 'agent'
    try:
        async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=transport, trust_env=trust_environment(config['url'], config=config),
                                     timeout=15, follow_redirects=False) as client:
            async with client.stream('GET', endpoint(config['url'], '/models'), headers=auth_headers(config)) as response:
                if response.status_code != 200:
                    raise ProjectError(
                        f'读取模型列表失败（HTTP {response.status_code}，'
                        f'GET {endpoint(config["url"], "/models")}）：{_model_list_hint(response.status_code)}；'
                        f'未修改配置。',
                        code='model_list_http_error' if is_text_model else None)
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > 1024 * 1024:
                        raise ProjectError('模型声明超过 1 MB，未修改配置。')
                models = json.loads(data).get('data', None if is_text_model else [])
        if not isinstance(models, list) or any(not isinstance(item, dict) or not isinstance(item.get('id'), str)
                                               or not item['id'].strip() or len(item['id']) > 200 for item in models):
            raise ProjectError('服务返回的模型列表格式无效。')
        return models
    except ProjectError as error:
        logger.error(f'model.error {json.dumps({"stage": "models", "error_type": type(error).__name__, "model": config["modelId"]})}')
        raise
    except (httpx.HTTPError, ValueError, TypeError, AttributeError) as error:
        logger.error(f'model.error {json.dumps({"stage": "models", "error_type": type(error).__name__, "model": config["modelId"]})}')
        raise ProjectError('无法读取模型列表，请检查服务地址、鉴权和 /models 接口。') from None


async def read_video_capabilities(config, transport=None):
    models = await read_service_models(config, transport)
    matching = [item for item in models if item['id'] == config['modelId']]
    if len(matching) != 1 or not matching[0].get('videoCapabilities'):
        raise ProjectError('服务未为该 Model ID 返回明确的 videoCapabilities 声明，请手动配置输出规格；未修改配置。')
    try:
        return VideoCapabilities.model_validate(matching[0]['videoCapabilities']).model_dump(exclude_none=True)
    except (ValueError, TypeError):
        raise ProjectError('无法读取有效的视频能力声明，请检查连接或手动配置；未修改配置。') from None
