"""Localized user-facing errors for the local HTTP boundary.

Domain code keeps its Chinese copy for CLI and Agent traces. The HTTP boundary
chooses an English message from the stable error code when the caller asks for
English, so a missing translation never leaks Chinese into an English UI.
"""
from fastapi import Request

from opendirector.domain.creation.commands import CommandReceipt

ENGLISH_BY_CODE = {
    "moss_speech_text": "Enter the text to read aloud.",
    "moss_speech_voice": "Enter a Voice ID available to your MOSS account.",
    "moss_speech_reference": "MOSS speech generation does not accept references. Enter speech text and a Voice ID.",
    "moss_prompt_limit": "MOSS requires a nonempty prompt of at most 4,000 characters, including text references.",
    "moss_image_size": "MOSS image dimensions must be 256–2048, multiples of 16, and no more than 2,097,152 pixels in total.",
    "moss_image_reference": "MOSS image generation does not accept image references or editing inputs.",
    "moss_layout_reference": "MOSS layout JSON does not accept additional text references. Put the requirements in the JSON or remove the text references.",
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
    "placeholder_image_only": "The placeholder generator currently supports images only; video and audio placeholders are on the way.",
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


def localized_receipt(request: Request, receipt: CommandReceipt) -> CommandReceipt:
    return receipt.model_copy(update={'issues': tuple(
        issue.model_copy(update={'message': localized_error(request, chinese=issue.message, status=422, code=issue.code)})
        for issue in receipt.issues
    )})
