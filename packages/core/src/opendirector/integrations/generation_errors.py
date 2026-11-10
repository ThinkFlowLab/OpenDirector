"""Safe provider diagnostics: allowlisted identifiers, never raw response text."""

import json
import logging
import re
from urllib.parse import unquote

from opendirector.domain.generation import GenerationError, GenerationFailure
from opendirector.integrations.http_settings import MODEL_JOB_CONTEXT


logger = logging.getLogger(__name__)

_REASONS = {
    'input': ('生成服务拒绝了输入内容或参数。', '请检查生成要求、参数和模型支持范围。'),
    'reference': ('生成服务拒绝了参考素材。', '请更换符合服务要求的参考素材，再决定是否重新生成。'),
    'authentication': ('生成服务鉴权失败。', '请在设置中检查 API Key。'),
    'permission': ('生成服务拒绝了访问请求。', '请检查 API Key 是否正确及有效、模型调用权限和服务安全策略。'),
    'quota': ('模型账户余额或套餐额度不足。', '请核对账户余额和套餐额度。'),
    'rate_limit': ('模型调用频率或配额受限。', '请核对调用频率及套餐额度后再操作。'),
    'temporary': ('生成服务暂时不可用。', '请先核对已有任务，再处理当前步骤。'),
    'provider': ('生成服务未能完成当前操作。', '请核对原任务；错误码和请求标识可用于向供应商排查。'),
}

# MiniMax content moderation: 1026 rejects the input, 1027 the generated output.
MINIMAX_SENSITIVE = {
    '1026': ('供应商判定输入内容涉及敏感信息，已拒绝生成。',
             '请修改提示词或更换参考素材后再生成；相同输入重试仍会被拒绝。'),
    '1027': ('供应商判定生成内容涉及敏感信息，已拒绝交付。',
             '请调整提示词或参考素材，避免可能触发审核的角色或内容后再生成；相同输入重试仍会被拒绝。'),
}


def _identifier(value, limit, secrets):
    if isinstance(value, int) and not isinstance(value, bool):
        value = str(value)
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,' + str(limit - 1) + '}', value):
        return None
    if any(secret and secret in value for secret in secrets):
        return None
    return value


def provider_failure(value, *, stage, headers=None, http_status=None, secrets=(), expected_task_id=None, provider=None):
    value = value if isinstance(value, dict) else {}
    error = value.get('error')
    error = error if isinstance(error, dict) else value
    code = _identifier(error.get('code', error.get('type')), 160, secrets)
    headers = headers or {}
    request_id = None
    for candidate in (headers.get('x-request-id'), headers.get('x-tt-logid'),
                      value.get('request_id'), value.get('requestId'), error.get('request_id')):
        request_id = _identifier(candidate, 200, secrets)
        if request_id:
            break
    # Some Ark errors supply the request ID only in error.message. Extract the
    # bounded identifier; the message itself is never persisted or displayed.
    if not request_id and isinstance(error.get('message'), str):
        match = re.search(r'\brequest\s*[_ -]?id\s*[:=]\s*([A-Za-z0-9_.:-]{1,200})(?![A-Za-z0-9_.:-])', error['message'][:8192], re.I)
        if match:
            request_id = _identifier(match[1].rstrip('.'), 200, secrets)
    category = {400: 'input', 401: 'authentication', 402: 'quota', 403: 'permission',
                404: 'input', 413: 'input', 422: 'input', 429: 'rate_limit'}.get(http_status, 'temporary' if http_status and http_status >= 500 else 'provider')
    name = (code or '').lower()
    if name.startswith(('inputimagesensitivecontentdetected', 'inputvideosensitivecontentdetected', 'inputaudiosensitivecontentdetected')):
        category = 'reference'
    elif name.startswith(('inputtext', 'outputtextsensitive', 'outputimagesensitive', 'outputvideosensitive')) or code in {'45000000', '45000001', '45001001'}:
        category = 'input'
    elif name.startswith(('authentication', 'invalidapikey', 'invalid_api_key', 'unauthorized')):
        category = 'authentication'
    elif name.startswith(('permissiondenied', 'accessdenied', 'forbidden')):
        category = 'permission'
    elif name.startswith(('quotaexceeded', 'insufficientquota', 'insufficient_quota', 'insufficientbalance', 'accountoverdue',
                          'billinghardlimit', 'billing_hard_limit', 'organizationquota', 'organization_quota')):
        category = 'quota'
    elif name.startswith(('ratelimit', 'rate_limit', 'throttl')):
        category = 'rate_limit'
    elif name.startswith(('moderation_blocked', 'moderationblocked', 'content_policy', 'contentpolicy', 'safety_system', 'safetysystem')):
        # OpenAI Images reports refused prompts or pictures as a moderation block.
        category = 'input'
    elif code == '55000000':
        category = 'temporary'
    diagnostic_text = error.get('message', '')
    if code == '1113' and isinstance(diagnostic_text, str) and ('余额' in diagnostic_text or '资源包' in diagnostic_text):
        # Zhipu BigModel reports an empty balance as HTTP 429; retrying cannot help.
        category = 'quota'
    message, suggestion = _REASONS[category]
    if provider == 'kling':
        kling_categories = {'1000': 'authentication', '1001': 'authentication', '1002': 'authentication',
            '1003': 'authentication', '1004': 'authentication', '1100': 'permission', '1101': 'quota',
            '1102': 'quota', '1103': 'permission', '1200': 'input', '1201': 'input', '1202': 'input',
            '1203': 'input', '1300': 'input', '1301': 'input', '1302': 'rate_limit',
            '1303': 'rate_limit', '1304': 'permission', '5000': 'temporary', '5001': 'temporary', '5002': 'temporary'}
        category = kling_categories.get(code, category)
        message, suggestion = _REASONS[category]
        if code in {'1300', '1301'}:
            message, suggestion = ('供应商判定提示词或参考图片违反内容政策，已拒绝生成。',
                                   '请调整提示词或参考素材后再生成；当前输入和已有结果保留。')
    diagnostic = error.get('message', '')
    diagnostic = diagnostic[:8192].lower() if isinstance(diagnostic, str) else ''
    if http_status in {400, 422} and category == 'input':
        if 'reference_audio cannot be the only reference' in diagnostic:
            category, message = 'reference', '音频参考不能单独使用，请搭配参考图片。'
            suggestion = '保留当前输入，添加参考图片后再生成。'
        elif re.search(r'(?:not support|unsupported|not supported)', diagnostic) and re.search(r'(?:reference_(?:image|video|audio)|image_url|video_url|audio_url|input_audio)', diagnostic):
            category, message = 'reference', '供应商拒绝了参考类型或输入组合。'
            suggestion = '请核对参考类型和生成模式，或选择其他已适配模型；当前输入和已有结果保留。'
    if name == 'voice_not_found' or (code == '1214' and diagnostic.startswith('音色不存在')):
        category, message = 'input', '所选音色不存在或不可用。'
        suggestion = '请检查音色 ID 是否属于当前账户可用的音色。'
    elif name == 'inputimagesensitivecontentdetected.privacyinformation':
        message = '供应商判定参考图片可能包含真人，已拒绝生成。'
    elif code in MINIMAX_SENSITIVE:
        # A moderation verdict is deterministic: the same input fails again, so
        # the suggestion must lead to changing it rather than retrying.
        category, (message, suggestion) = 'input', MINIMAX_SENSITIVE[code]
    elif name.startswith(('moderation_blocked', 'moderationblocked')):
        message, suggestion = ('供应商判定提示词或参考图片违反内容政策，已拒绝生成。',
                               '请调整提示词或参考素材后再生成；当前输入和已有结果保留。')
    elif category == 'provider' and value.get('status') in {'cancelled', 'expired'}:
        message = '供应商任务已取消。' if value['status'] == 'cancelled' else '供应商任务已过期。'
    elif http_status == 404:
        message = '供应商未找到该任务。' if stage in {'poll', 'cancel'} else '生成接口或模型不存在。'
    if stage == 'download':
        category, message = 'temporary', '生成结果下载失败。'
        suggestion = '请核对原任务和结果链接，恢复下载前不要直接重新生成。'
    terminal_status = None
    if stage == 'poll' and value.get('status') in {'failed', 'cancelled', 'expired'}:
        # vLLM can return a failed Video object with HTTP 500. A gateway error
        # is not terminal evidence: require the queried job's exact identity.
        if http_status == 200 or (http_status == 500 and expected_task_id
                and value.get('object') == 'video' and value.get('id') == expected_task_id):
            terminal_status = value['status']
    if terminal_status == 'failed' and (category == 'temporary' or provider == 'kling' and category == 'provider'):
        category, message = 'provider', '生成服务任务已失败。'
        suggestion = '请排查任务失败原因，确认后可重新生成。'
    context = MODEL_JOB_CONTEXT.get()
    logger.error(f'model.error {json.dumps({"project_id": context[0] if context else None, "job_id": context[1] if context else None, "stage": stage, "error_type": "ProviderError", "status": http_status, "request_id": request_id, "provider_code": code})}')
    return GenerationError(GenerationFailure(category=category, stage=stage, message=message,
        suggestion=suggestion, providerCode=code, requestId=request_id, httpStatus=http_status,
        providerStatus=terminal_status))


async def checked(response, *, stage, secrets=()):
    if 200 <= response.status_code < 300:
        return
    # Error pages may be HTML, huge, or echo credentials and signed URLs. Read a
    # bounded body only for parsing; do not attach it to exceptions or receipts.
    body = bytearray()
    async for chunk in response.aiter_bytes():
        body.extend(chunk[:max(0, 65536 - len(body))])
        if len(body) >= 65536:
            break
    try:
        value = json.loads(body)
    except (ValueError, UnicodeError):
        value = None
    expected_task_id = None
    if stage == 'poll' and response.status_code == 500:
        try:
            match = re.search(r'/videos/([^/]+)$', response.request.url.path)
        except RuntimeError:  # Detached responses cannot prove task identity.
            match = None
        if match:
            expected_task_id = _identifier(unquote(match[1]), 200, secrets)
    raise provider_failure(value, stage=stage, headers=response.headers,
        http_status=response.status_code, secrets=secrets, expected_task_id=expected_task_id)


def transport_failure(stage, *, timeout=False, status=None):
    context = MODEL_JOB_CONTEXT.get()
    logger.error(f'model.error {json.dumps({"project_id": context[0] if context else None, "job_id": context[1] if context else None, "stage": stage, "error_type": "TimeoutException" if timeout else "HTTPError"})}')
    unknown = stage == 'submit'
    return GenerationError(GenerationFailure(category='submission_unknown' if unknown else 'temporary', stage=stage,
        message='生成请求的提交结果不明。' if unknown else '生成服务连接超时或中断。',
        suggestion='请先核对供应商是否已接收请求，避免重复生成。' if unknown else '请核对已有任务，继续查询或下载前不要重新生成。'),
        status=status or (504 if timeout else 503))


def protocol_failure(stage, *, message='生成服务返回了无法识别或不完整的结果。'):
    context = MODEL_JOB_CONTEXT.get()
    logger.error(f'model.error {json.dumps({"project_id": context[0] if context else None, "job_id": context[1] if context else None, "stage": stage, "error_type": "ProtocolError"})}')
    unknown = stage == 'submit'
    return GenerationError(GenerationFailure(category='submission_unknown' if unknown else 'protocol', stage=stage,
        message=message,
        suggestion='请先核对请求是否已被接收，避免重复生成。' if unknown else '请核对原任务状态和接口协议。'))
