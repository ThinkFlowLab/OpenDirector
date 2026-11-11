"""Connect directly to configured self-hosted origins; retain API/CDN proxies."""
import asyncio
from concurrent.futures import ThreadPoolExecutor, TimeoutError as LookupTimeout
from contextvars import ContextVar
from ipaddress import ip_address
import json
import logging
import socket
import time
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
from pydantic import JsonValue


def trust_environment(url, *, config=None):
    if config and config.get('proxyMode') == 'direct':
        return False
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


def log_parameters(value: JsonValue, *, secrets=()) -> JsonValue:
    if isinstance(value, dict):
        return {key: '[omitted]' if key.lower().replace('-', '_') in
                {'authorization', 'api_key', 'apikey', 'token', 'access_token', 'secret', 'password', 'cookie', 'b64_json'}
                or key == 'url' and isinstance(item, str) and not item.startswith(('http://', 'https://'))
                else log_parameters(item, secrets=secrets) for key, item in value.items()}
    if isinstance(value, list):
        return [log_parameters(item, secrets=secrets) for item in value]
    if isinstance(value, str):
        if value.startswith('data:'):
            return '[media omitted]'
        if value.startswith(('http://', 'https://')):
            try:
                url = urlsplit(value)
            except ValueError:
                return '[invalid URL omitted]'
            value = f'{url.scheme}://{url.netloc.rsplit("@", 1)[-1]}{url.path}'
        for secret in secrets:
            if secret:
                value = value.replace(secret, '[omitted]')
        if len(value) > MAX_LOG_VALUE_LENGTH:
            return value[:MAX_LOG_VALUE_LENGTH] + '[truncated]'
    return value


def _request_secrets(request):
    credential = request.headers.get('authorization', '').removeprefix('Bearer ')
    return tuple(request.extensions.get('model_secrets', ())) + ((credential,) if credential else ())


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
    secrets = _request_secrets(request)
    logger.debug(f'model.request {json.dumps({**identity, "method": request.method, "url": log_parameters(str(request.url), secrets=secrets), "parameters": log_parameters(parameters, secrets=secrets)}, ensure_ascii=False)}')


async def model_response(response: httpx.Response) -> None:
    identity = response.request.extensions['model_call']
    request_id = response.headers.get('x-request-id')
    if request_id and (len(request_id) > 200 or any(secret and secret in request_id for secret in _request_secrets(response.request))):
        request_id = None
    facts = {**identity, 'status': response.status_code, 'request_id': request_id}
    logger.info(f'model.response {json.dumps({**facts, "headers_ms": round((time.monotonic() - response.request.extensions["model_started"]) * 1000)})}')


MODEL_HTTP_HOOKS = {'request': [model_request], 'response': [model_response]}


# Unconfigured download hosts (result CDNs, voice previews) are resolved once,
# checked, and the request is pinned to the checked address so a second DNS
# answer cannot redirect it. Keep every such download on these helpers.
PUBLIC_LOOKUP_SECONDS = 15
_LOOKUPS = ThreadPoolExecutor(max_workers=4, thread_name_prefix='public-dns')


def _public_candidate(url, schemes):
    """Return (target, host, port) for a syntactically acceptable URL, or None."""
    try:
        target = httpx.URL(url)
        port = target.port
    except (httpx.InvalidURL, ValueError, TypeError):
        return None
    host = target.host.rstrip('.').lower()
    if (target.scheme not in schemes or not host or target.userinfo
            or '%' in host or host == 'localhost' or host.endswith('.localhost')
            or port is not None and not 0 < port < 65536):
        return None
    return target, host, port or (443 if target.scheme == 'https' else 80)


def _public_pin(target, answers):
    """Check every answer; pin to the first. None when any answer is not public."""
    addresses = [ip_address(answer) for answer in answers]
    if not addresses:
        return None
    for address in addresses:
        checked = getattr(address, 'ipv4_mapped', None) or address
        if not checked.is_global or checked.is_multicast or checked.is_reserved:
            return None
    # A pooled connection to one IP must not reuse another hostname's TLS identity.
    headers = {'Host': target.netloc.decode('ascii'), 'Connection': 'close'}
    return target.copy_with(host=str(addresses[0])), headers, {'sni_hostname': target.host}


def _literal(host):
    try:
        return [str(ip_address(host))]
    except ValueError:
        return None


def _lookup(host, port):
    return [answer[4][0] for answer in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)]


async def public_target(url, *, unsafe, unresolved, schemes=('http', 'https')):
    """Async: pin url to checked public addresses, or raise unsafe()/unresolved()."""
    candidate = _public_candidate(url, schemes)
    if candidate is None:
        raise unsafe()
    target, host, port = candidate
    answers = _literal(host)
    if answers is None:
        try:
            answers = await asyncio.wait_for(asyncio.to_thread(_lookup, host, port), timeout=PUBLIC_LOOKUP_SECONDS)
        except (OSError, UnicodeError, asyncio.TimeoutError):
            raise unresolved() from None
    pinned = _public_pin(target, answers)
    if pinned is None:
        raise unsafe()
    return pinned


def public_target_sync(url, *, unsafe, unresolved, schemes=('http', 'https')):
    """Worker-thread variant with the same DNS deadline as public_target."""
    candidate = _public_candidate(url, schemes)
    if candidate is None:
        raise unsafe()
    target, host, port = candidate
    answers = _literal(host)
    if answers is None:
        try:
            answers = _LOOKUPS.submit(_lookup, host, port).result(timeout=PUBLIC_LOOKUP_SECONDS)
        except (OSError, UnicodeError, LookupTimeout):
            raise unresolved() from None
    pinned = _public_pin(target, answers)
    if pinned is None:
        raise unsafe()
    return pinned
