"""Localized user-facing errors for the local HTTP boundary.

Domain code keeps its Chinese copy for CLI and Agent traces. The HTTP boundary
chooses an English message from the stable error code when the caller asks for
English, so a missing translation never leaks Chinese into an English UI.
"""
from fastapi import Request


from opendirector.domain.timeline_errors import timeline_error_message

from opendirector.domain.creation.commands import CommandReceipt

ENGLISH_BY_CODE = {
    'execution_file_link': 'Execution files must not have hard links.',
    'kling_model': 'This Kling protocol does not support the selected model.',
    'kling_mode': 'Kling currently supports first/last frames and image-reference generation.',
    'kling_image': 'Kling requires valid PNG or JPEG images up to 30 MB, at least 300 pixels on each edge, with an aspect ratio of 0.4–2.5. Video and audio references are not supported here.',
    'kling_frames': 'Choose frame inputs supported by the selected Kling model. Each slot accepts one image, and a last frame requires a first frame. Flash accepts only a first frame.',
    'kling_prompt': 'Enter a Kling prompt. English allows 26,000 characters and other text 11,000 characters; mixed text shares these limits proportionally.',
    'kling_aspect': 'Kling keyframe generation follows the image framing. Choose Auto for frames, or a supported ratio for text and image references.',
    'kling_output': 'Choose an output resolution and integer duration supported by the selected Kling model.',
    'kling_cancel': 'Remote Kling cancellation is not connected. The task may continue running and incur charges.',
    'tool_concept_translation': 'Use a short English subject description, or add a chat model in Models to translate it automatically.',
    'tool_no_video_match': 'The requested subject was not found in the video. Try a different description.',
    'voice_upload_type': 'Upload the voice recording using multipart/form-data.',
    'voice_upload_form': 'Check the recording, form fields and text lengths, then try the upload again.',
    'voice_model_unsupported': 'This checkpoint does not accept uploaded voices. Choose a Base model for voice cloning or a compatible built-in voice.',
    'voice_library_unsupported': 'This model does not have a confirmed voice library. Select a supported speech model.',
    'voice_connection_changed': 'The voice service or account changed. Reopen the library and select a voice again.',
    'voice_reference_required': 'This model needs a registered reference recording. Upload and select a voice; default cannot replace a recording.',
    'voice_transcript_required': 'This model needs an accurate recording transcript. Enter the transcript and create the voice again.',
    'voice_transcript_too_long': 'The recording transcript must be at most 100,000 characters.',
    'voice_description_too_long': 'The speaker description must be at most 4,000 characters.',
    'voice_not_found': 'The selected voice no longer exists. Refresh the library and select another voice.',
    'voice_delete_unsupported': 'This voice cannot be deleted. Only supported uploaded voices can be deleted.',
    'voice_consent_required': 'Enter the consent recording ID for this voice.',
    'voice_name_invalid': 'Enter a valid voice name without path separators or control characters.',
    'voice_audio_invalid': 'The recording could not be decoded. Check the actual audio format and file integrity.',
    'voice_format': 'This recording format is unsupported. Choose a listed format.',
    'voice_size': 'The recording exceeds the service file size limit.',
    'voice_duration': 'The recording duration is outside the service limits. Trim it and try again.',
    'voice_provider_protocol': 'The voice service returned an invalid response or pagination did not finish. Check its API version.',
    'voice_provider_error': 'The voice service request failed. Check the connection and account permissions.',
    'voice_provider_timeout': 'The voice service timed out. Check its status and try again.',
    'voice_name_taken': 'This account already has a voice with that name. Choose another name.',
    'voice_provider_quota': 'The voice service account has insufficient balance or resource packages. Top up and try again.',
    "moss_speech_text": "Enter the text to read aloud.",
    "moss_speech_voice": "Enter a Voice ID available to your MOSS account.",
    "moss_speech_reference": "MOSS speech generation does not accept references. Enter speech text and a Voice ID.",
    "zhipu_speech_text": "Enter the text to read aloud, at most 1,024 characters per GLM-TTS request.",
    "zhipu_speech_voice": "Select a voice available to your Zhipu account.",
    "zhipu_speech_reference": "GLM-TTS does not accept references. Enter speech text and select a voice.",
    "moss_prompt_limit": "MOSS requires a nonempty prompt of at most 4,000 characters, including text references.",
    "image_decode": "The image could not be decoded. Check its actual format and file integrity.",
    "asset_preview_unsupported": "This asset type does not support this preview format.",
    "image_pixel_limit": "Images must contain no more than 25 million pixels.",
    "minimax_image_reference": "MiniMax H3 references must be PNG, JPEG, WebP, HEIC, or HEIF, with edges of 128–8192 pixels and a long-to-short edge ratio of at most 4:1.",
    "minimax_image_count": "MiniMax H3 image editing accepts up to 16 reference images.",
    "minimax_image_bytes": "MiniMax H3 image reference requests cannot exceed 64 MiB.",
    "minimax_speech_text": "Enter the text to read aloud, up to 3,000 characters.",
    "minimax_speech_model": "Unsupported MiniMax speech model. Choose a model from the preset.",
    "minimax_speech_voice": "Choose a voice available to your MiniMax account from the voice library.",
    "minimax_speech_reference": "MiniMax speech synthesis does not accept references. Enter the text to read aloud and choose a voice.",
    "moss_image_size": "MOSS image dimensions must be 256–2048, multiples of 16, and no more than 2,097,152 pixels in total.",
    "moss_image_reference": "MOSS image generation does not accept image references or editing inputs.",
    "bigmodel_image_reference": "GLM-Image accepts text-to-image requests only. Remove image references or editing inputs.",
    "bigmodel_image_prompt": "Enter a GLM-Image prompt.",
    "bigmodel_image_size": "GLM-Image requires a preset size, or dimensions of 1024–2048 in multiples of 32.",
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
    specific = timeline_error_message(code, language)
    if specific is not None:
        return specific
    if not wants_english_language(language):
        return chinese
    # A generic operation code must not hide a more specific HTTP status.
    generic = code in {"operation_rejected", "invalid_input"}
    if generic and status in {413, 502, 504}:
        return ENGLISH_BY_STATUS[status]
    specific = None if code == "operation_rejected" else ENGLISH_BY_CODE.get(code)
    if code == 'voice_provider_error':
        from opendirector.domain.voices import VOICE_MESSAGES
        detail = chinese.removeprefix(VOICE_MESSAGES[code]).strip()
        return specific + (' ' + detail if detail else '')
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
