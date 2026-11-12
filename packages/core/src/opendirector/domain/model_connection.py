"""Connection fields for a model service, independent of stored configuration."""
from urllib.parse import urlsplit

from opendirector.domain.projects import ProjectError


def is_bigmodel_connection(config: dict) -> bool:
    """Official mainland BigModel presets share one bearer account across protocols."""
    kind = config.get('kind')
    return (config.get('url', '').rstrip('/') == 'https://open.bigmodel.cn/api/paas/v4'
            and config.get('connectionType') == 'api' and config.get('authMode') == 'bearer'
            and kind in {'agent', 'image', 'video', 'audio'}
            and config.get('protocol') == ('bigmodel_video' if kind == 'video' else 'openai'))


def same_connection_address(saved: dict, draft: dict) -> bool:
    return saved['url'] == draft['url'] or (is_bigmodel_connection(saved) and is_bigmodel_connection(draft))


def connection_fields(kind, connection_type='api', protocol=None, auth_mode=None, proxy_mode=None):
    if connection_type not in {'api', 'self_hosted'}:
        raise ProjectError('无效的接入方式。')
    protocol = protocol or ('openai' if kind == 'agent' or connection_type == 'self_hosted' and kind not in {'video', 'vision'}
                            else 'vllm_omni' if connection_type == 'self_hosted' else 'volcengine')
    allowed = {'agent': {'openai'}, 'image': {'openai', 'volcengine', 'vllm_omni_segmentation'},
               'video': {'kling_video', 'minimax_video_v2', 'vllm_omni', 'volcengine', 'vllm_omni_segmentation', 'vllm_omni_depth'},
               'audio': {'openai', 'volcengine', 'vllm_omni_music', 'vllm_omni_score'}, 'vision': {'vllm_omni'}}
    auth_mode = auth_mode or ('none' if connection_type == 'self_hosted' else 'bearer')
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
