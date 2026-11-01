"""Connect directly to configured self-hosted origins; retain API/CDN proxies."""
from contextvars import ContextVar
from ipaddress import ip_address
import json
import logging
import time
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
from pydantic import JsonValue


def trust_environment(url, *, config=None):
    target = urlsplit(url)
    if config and config.get('connectionType') == 'self_hosted':
        base = urlsplit(config.get('url', ''))
        def origin(parts):
            return (parts.scheme, parts.hostname,
                    parts.port or {'http': 80, 'https': 443}.get(parts.scheme))
        if origin(target) == origin(base):
            return False
    host = (target.hostname or '').rstrip('.').lower()
    if host == 'localhost':
        return False
    try:
        address = ip_address(host)
    except ValueError:
        return True
    mapped = getattr(address, 'ipv4_mapped', None)
    return not (address.is_loopback or mapped is not None and mapped.is_loopback)


def auth_headers(config):
    """Bearer authentication unless the model has no key or is configured without auth."""
    return {'Authorization': f"Bearer {config['apiKey']}"} if config.get('apiKey') and config.get('authMode') != 'none' else {}


logger = logging.getLogger(__name__)
MAX_LOG_VALUE_LENGTH = 16384
MODEL_JOB_CONTEXT: ContextVar[tuple[str, str] | None] = ContextVar('model_job_context', default=None)


def log_parameters(value: JsonValue) -> JsonValue:
    if isinstance(value, dict):
        return {key: '[omitted]' if key.lower().replace('-', '_') in
                {'authorization', 'api_key', 'apikey', 'token', 'access_token', 'secret', 'password', 'cookie', 'b64_json'}
                else log_parameters(item) for key, item in value.items()}
    if isinstance(value, list):
        return [log_parameters(item) for item in value]
    if isinstance(value, str):
        if value.startswith('data:'):
            return '[media omitted]'
        if value.startswith(('http://', 'https://')):
            try:
                url = urlsplit(value)
            except ValueError:
                return '[invalid URL omitted]'
            return f'{url.scheme}://{url.netloc.rsplit("@", 1)[-1]}{url.path}'
        if len(value) > MAX_LOG_VALUE_LENGTH:
            return value[:MAX_LOG_VALUE_LENGTH] + '[truncated]'
    return value


async def model_request(request: httpx.Request) -> None:
    context = MODEL_JOB_CONTEXT.get()
    identity: dict[str, JsonValue] = {'call_id': str(uuid4()), 'project_id': context[0] if context else None,
                                     'job_id': context[1] if context else None}
    request.extensions['model_call'] = identity
    request.extensions['model_started'] = time.monotonic()
    if not logger.isEnabledFor(logging.DEBUG):
        return
    parameters = request.extensions.get('model_parameters')
    if 'json' in request.headers.get('content-type', ''):
        try:
            parameters = json.loads(request.content)
        except (httpx.RequestNotRead, ValueError):
            parameters = '[unavailable JSON omitted]'
    logger.debug(f'model.request {json.dumps({**identity, "method": request.method, "url": log_parameters(str(request.url)), "parameters": log_parameters(parameters)}, ensure_ascii=False)}')


async def model_response(response: httpx.Response) -> None:
    identity = response.request.extensions['model_call']
    facts = {**identity, 'status': response.status_code, 'request_id': response.headers.get('x-request-id')}
    logger.info(f'model.response {json.dumps({**facts, "headers_ms": round((time.monotonic() - response.request.extensions["model_started"]) * 1000)})}')


MODEL_HTTP_HOOKS = {'request': [model_request], 'response': [model_response]}
