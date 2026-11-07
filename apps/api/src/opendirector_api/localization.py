"""Localized user-facing errors for the local HTTP boundary.

Domain code keeps its Chinese copy for CLI and Agent traces. The HTTP boundary
chooses an English message from the stable error code when the caller asks for
English, so a missing translation never leaks Chinese into an English UI.
"""
from fastapi import Request


# Exact display translations for font validation. Business receipts retain their
# original diagnostic; these copies are selected only at the HTTP boundary.
TIMELINE_FONT_MESSAGES = {
    "Invalid or unsupported editable timeline package.": "可编辑时间线包无效或格式不受支持。",
    "Editable timeline packages must not exceed 512 MiB.": "可编辑时间线包不能超过 512 MiB。",
    "Timeline revision does not exist.": "所选时间线版本不存在。",
    "Timeline package import does not exist.": "该时间线包导入记录不存在。",
    "Import operation identity is already used by different input.": "该导入操作标识已用于不同输入，请保留原输入重试。",
    "Timeline resource registration was rejected.": "时间线资源登记被拒绝，请查询导入记录。",
    "Font files must not exceed 32 MiB.": "字体文件不能超过 32 MiB。",
    "Font file is unavailable.": "字体文件不可用，请恢复文件后重试。",
    "Only static TTF and OTF fonts are supported.": "仅支持静态 TTF 和 OTF 字体，不支持字体集合或可变字体。",
    "Font data is invalid or incomplete.": "字体数据无效或不完整，请检查实际格式。",
    "Font content differs from its recorded fingerprint.": "字体内容与登记指纹不一致，请恢复原文件。",
    "The selected font does not cover all text characters.": "所选字体未覆盖全部文字字符。",
    "Timeline fonts must not exceed 64 MiB in total.": "时间线实际使用的字体总量不能超过 64 MiB。",
    "Timeline font resource is not a verified static font.": "时间线字体资源不是已验证的静态字体。",
    "Timeline font format differs from its recorded MIME type.": "时间线字体实际格式与登记类型不一致。",
    "Bundled font fingerprint mismatch.": "内置字体指纹不一致，请重新安装应用。",
    "Bundled font is unavailable.": "内置字体不可用，请重新安装应用。",
}


def localized_timeline_font_message(language: str | None, message: str) -> str:
    chinese = TIMELINE_FONT_MESSAGES.get(message)
    if chinese is None:
        return message
    return message if wants_english_language(language) else chinese


def localized_timeline_font_receipt(language, receipt):
    if receipt is None:
        return None
    return receipt.model_copy(update={'issues': tuple(issue.model_copy(update={
        'message': localized_timeline_font_message(language, issue.message),
    }) for issue in receipt.issues)})

ENGLISH_BY_CODE = {
    "agent_dependency_unavailable": "Bundled Agent is unavailable. Reinstall with pip install --force-reinstall opendirector; for a source checkout, use pip install -e .",
    "invalid_input": "The request is invalid. Check the required fields and their formats.",
    "invalid_project": "The project or asset identifier is invalid.",
    "missing_object": "The requested item no longer exists.",
    "not_found": "The requested item no longer exists.",
    "revision_conflict": "This item changed since it was loaded. Reload it and try again.",
    "preview_expired": "The preview expired. Generate it again.",
    "reference_invalid": "A reference is no longer valid. Select it again and retry.",
    "role_restricted": "This item does not allow that operation.",
    "storage_unavailable": "A stored file is missing or has changed. Restore the file and try again.",
    "capability_unsupported": "This capability is not supported yet.",
    "operation_rejected": "The operation was rejected. Reload the item and try again.",
    "storage_busy": "Project storage is busy. Try again shortly.",
    "local_only": "Only this computer can access the project service.",
    "cross_origin": "File access from another site is not allowed.",
    "invalid_local_request": "This is not a valid local app request.",
}

ENGLISH_BY_STATUS = {
    400: "The request is invalid. Check the values and try again.",
    401: "Authentication is required. Sign in again and retry.",
    403: "This operation is not allowed.",
    404: "The requested item no longer exists.",
    409: "The item changed or is busy. Reload it and try again.",
    413: "The file or request is too large.",
    422: "The request could not be applied to the current project state.",
    500: "The local service hit an unexpected error. Check the terminal for details.",
    501: "This capability is not supported yet.",
    502: "The upstream service failed. Check its configuration and try again.",
    503: "The local service is unavailable. Check the terminal and try again.",
    504: "The upstream service timed out. Check the service and try again.",
}


def wants_english_language(value: str | None) -> bool:
    """Use the primary Accept-Language tag, matching the browser decision."""
    value = (value or "").strip()
    if not value:
        return False
    primary = value.split(",", 1)[0].split(";", 1)[0].strip().lower()
    return not primary.startswith("zh")


def wants_english(request: Request) -> bool:
    return wants_english_language(request.headers.get("accept-language"))


def localized_error_for_language(
    language: str | None,
    *,
    chinese: str,
    status: int,
    code: str = "operation_rejected",
) -> str:
    if chinese in TIMELINE_FONT_MESSAGES:
        return localized_timeline_font_message(language, chinese)
    if not wants_english_language(language):
        return chinese
    # A generic operation code must not hide a more specific HTTP status.
    generic = code in {"operation_rejected", "invalid_input"}
    if generic and status in {413, 502, 504}:
        return ENGLISH_BY_STATUS[status]
    specific = None if code == "operation_rejected" else ENGLISH_BY_CODE.get(code)
    return (
        specific
        or ENGLISH_BY_STATUS.get(status)
        or ENGLISH_BY_CODE["operation_rejected"]
    )


def localized_error(
    request: Request,
    *,
    chinese: str,
    status: int,
    code: str = "operation_rejected",
) -> str:
    return localized_error_for_language(
        request.headers.get("accept-language"),
        chinese=chinese,
        status=status,
        code=code,
    )
