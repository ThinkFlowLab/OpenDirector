"""Read an optional, explicit videoCapabilities extension on GET /models."""
import json
import logging

import httpx

from opendirector.domain.projects import ProjectError
from opendirector.domain.minimax_models import MINIMAX_MODELS
from opendirector.domain.kling_models import KLING_MODELS, kling_capabilities
from opendirector.domain.video_capabilities import VideoCapabilities
from opendirector.integrations.http_settings import MODEL_HTTP_HOOKS, auth_headers, trust_environment
from opendirector.integrations.volcengine import endpoint


logger = logging.getLogger(__name__)


async def read_service_models(config, transport=None):
    if config.get('protocol') == 'kling_video':
        return [{'id': name, 'videoCapabilities': kling_capabilities(name)} for name in KLING_MODELS]
    if config.get('protocol') == 'minimax_video_v2':
        return [{'id': name} for name in MINIMAX_MODELS]
    try:
        async with httpx.AsyncClient(event_hooks=MODEL_HTTP_HOOKS, transport=transport, trust_env=trust_environment(config['url'], config=config),
                                     timeout=15, follow_redirects=False) as client:
            async with client.stream('GET', endpoint(config['url'], '/models'), headers=auth_headers(config)) as response:
                if response.status_code != 200:
                    raise ProjectError(f'读取模型声明失败（HTTP {response.status_code}），未修改配置。')
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > 1024 * 1024:
                        raise ProjectError('模型声明超过 1 MB，未修改配置。')
                models = json.loads(data).get('data', [])
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
