"""Localized user-facing errors for the local HTTP boundary.

Domain code keeps its Chinese copy for CLI and Agent traces. The HTTP boundary
chooses an English message from the stable error code when the caller asks for
English, so a missing translation never leaks Chinese into an English UI.
"""
import re

from fastapi import Request


from opendirector.domain.timeline_errors import timeline_error_message

from opendirector.domain.creation.commands import CommandReceipt
from opendirector.domain.capabilities import Capability
from opendirector.domain.capability_messages import english_capability_message, missing_tool_model_message

ENGLISH_BY_CODE = {
    'higgsfield_model': 'Choose MAGI-2 with the official Higgsfield Open API address.',
    'higgsfield_key': 'Enter your Higgsfield Open KEY_ID:KEY_SECRET.',
    'higgsfield_output': 'MAGI-2 supports 1080p and whole-second durations from 4 to 30 seconds.',
    'higgsfield_parameters': 'Choose an aspect ratio and audio option supported by MAGI-2.',
    'higgsfield_mode': 'MAGI-2 supports first/last frames and reference media.',
    'higgsfield_image': 'Use valid JPEG, PNG, WebP, or GIF images, each smaller than 30 MB.',
    'higgsfield_format': 'Use MP4 video and WAV audio references. Convert MOV to MP4 and MP3 to WAV before uploading.',
    'higgsfield_media_size': 'Each reference video must be at most 200 MB; each audio file at most 15 MB.',
    'higgsfield_duration': 'Each reference video or audio clip must be 2–30 seconds. The total for each media type cannot exceed 30 seconds.',
    'higgsfield_reference_count': 'MAGI-2 accepts up to 10 images, 5 videos, and 5 audio references.',
    'higgsfield_reference_changed': 'A reference asset changed. Review the inputs before submitting again.',
    'higgsfield_frames': 'Each frame slot accepts one image. A last frame requires a first frame.',
    'higgsfield_references': 'Reference mode requires at least one image, video, or audio clip. Check the reference roles.',
    'higgsfield_prompt': 'MAGI-2 prompts allow up to 15,000 characters. Text-to-video requires a prompt.',
    "desktop_auth_required": "The desktop connection has expired. Reopen the application.",
    'prompt_optimization_empty': 'Enter a prompt to optimize.',
    'prompt_optimization_refs': 'Prompt references changed. Try again.',
    'prompt_optimization_node': 'Select an image or video node.',
    'prompt_optimization_model': 'Choose an available chat model in the Agent panel.',
    'prompt_optimization_vision': 'The selected chat model cannot use these visual references. Choose an Agent model with image or video input.',
    'prompt_optimization_cli': 'The selected Agent CLI could not optimize the prompt. Check its installation, login, and model.',
    'prompt_optimization_cli_unsupported': 'The selected Agent CLI does not support standalone prompt optimization. Switch the Agent or model in the Agent panel.',
    'prompt_optimization_media': 'The video reference duration is invalid.',
    'prompt_optimization_too_large': 'The references are too large for prompt optimization. Reduce their size or number and try again.',
    'prompt_optimization_result': 'The model did not return a usable prompt. Your original text was kept.',
    'prompt_optimization_provider': 'The text model could not optimize the prompt. Check its settings and try again. Your original text was kept.',
    'image_quality_unsupported': 'This model does not support the selected image quality. Choose Auto or select another model.',
    'bigmodel_video_model': 'The BigModel video protocol supports CogVideoX-3 only.',
    'bigmodel_video_output': 'Choose a supported CogVideoX-3 pixel size and a 5- or 10-second duration. The size determines the aspect ratio.',
    'bigmodel_video_image': 'CogVideoX-3 frame images must be valid PNG or JPEG files, up to 5 MB each.',
    'bigmodel_video_frames': 'Use text, one first-frame image, or an explicit first/last pair. Each frame slot accepts one image; a last frame requires a first frame. Reference and continuation modes are not supported.',
    'bigmodel_video_prompt': 'CogVideoX-3 prompts allow up to 512 characters. Provide a prompt or frame image.',
    'bigmodel_video_cancel': 'Remote BigModel video cancellation is not connected. The task may continue running and incur charges.',
    'execution_file_link': 'Execution files must not have hard links.',
    'kling_model': 'This Kling protocol does not support the selected model.',
    'kling_mode': 'Kling currently supports first/last frames and image-reference generation.',
    'kling_image': 'Kling requires valid PNG or JPEG images up to 30 MB, at least 300 pixels on each edge, with an aspect ratio of 0.4–2.5. Video and audio references are not supported here.',
    'kling_frames': 'Choose frame inputs supported by the selected Kling model. Each slot accepts one image, and a last frame requires a first frame. Flash accepts only a first frame.',
    'kling_prompt': 'Enter a Kling prompt. English allows 26,000 characters and other text 11,000 characters; mixed text shares these limits proportionally.',
    'kling_aspect': 'Kling keyframe generation follows the image framing. Choose Auto for frames, or a supported ratio for text and image references.',
    'kling_output': 'Choose an output resolution and integer duration supported by the selected Kling model.',
    'kling_cancel': 'Remote Kling cancellation is not connected. The task may continue running and incur charges.',
    'capability_unavailable': 'This request is not supported.',
    'capability_paused': 'Service paused. Resume it and try again.',
    'image_input_count': 'Too many input images.',
    'image_input_bytes': 'The input images exceed the size limit.',
    'image_input_mask': 'Check the image selection.',
    'tool_source_count': 'Check the number of source images.',
    'tool_source_type': 'Source assets must be images.',
    'capability_connection_changed': 'The model connection changed during the capability check. Submit again.',
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
    "asset_text_api_unavailable": "canvas text show requires a running API to read the complete Markdown source. Start the API and check OPENDIRECTOR_API_URL.",
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
    "canvas_run_layout_extent": "Canvas positions or dimensions are too large to arrange. Resize the affected items.",
    "canvas_run_layout_group": "Run layout is only available for top-level groups.",
    "canvas_run_layout_conflict": "Locked Run areas overlap. Unlock one of the groups and try again.",
    "canvas_run_layout_shared_object": "Two Runs use the same editable object. Copy the configuration or editor document and try again.",
    "storage_unavailable": "A stored file is missing or has changed. Restore the file and try again.",
    "capability_unsupported": "This capability is not supported yet.",
    "model_list_http_error": "Could not load the model list from the service.",
    "operation_rejected": "The operation was rejected. Reload the item and try again.",
    "storage_busy": "Project storage is busy. Try again shortly.",
    "project_open_elsewhere": "This project is open in another window. Close it there and try again.",
    "session_expired": "This project was closed or its session expired. Reopen it and save again.",
    "local_only": "Only this computer can access the project service.",
    "cross_origin": "File access from another site is not allowed.",
    "invalid_local_request": "This is not a valid local app request.",
    "ask_mode_runtime_unsupported": "Ask mode is available for Default, OpenCode, Claude Code, Codex, and DeepSeek Harness only.",
    "task_waiting_input": "This task is waiting for the user to answer the current question. Subsequent operations are paused.",
    "plan_confirmation_required": "This task is in the interactive planning stage. Confirm the current plan before modifying the project or starting generation.",
    "decision_answer_invalid": "Check the answers for each question and try again.",
    "decision_answer_conflict": "A different answer was already submitted for this question in another tab. Showing the saved answer.",
    "decision_version_invalidated": "Related assets or the plan version changed. This question is no longer valid and will not overwrite newer content.",
    "decision_not_answered": "Save an answer to this question before continuing the task.",
    "continuation_resume_failed": "Could not start the continuation. Check the Agent configuration and try again.",
    "continuation_status_unknown": "The previous execution status needs verification. To avoid duplicate paid calls, it was not resent automatically.",
    "plan_missing": "This task does not have a confirmable plan revision yet.",
    "plan_revision_stale": "The plan version changed and the previous confirmation is no longer valid. Confirm the latest plan version.",
    "plan_step_kind_mismatch": "Only inspection steps can record an inspection result.",
    "task_conversation_changed": "Return to the task's original conversation to continue.",
    "task_model_unavailable": "The original Agent model configuration could not be resolved.",
    "project_assistant_busy": "Another reply is currently running in this project. Wait for it to finish and then continue.",
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
    required_capability: Capability | None = None,
) -> str:
    specific = timeline_error_message(code, language)
    if specific is not None:
        return specific
    if not wants_english_language(language):
        return chinese
    if code == 'tool_model_missing':
        return missing_tool_model_message(required_capability, english=True)
    if code == 'model_list_http_error':
        upstream_status = re.search(r'HTTP ([0-9]{3})', chinese)
        if upstream_status:
            return f'Could not load the model list (HTTP {upstream_status[1]}).'
    if code.startswith(('capability_', 'image_input_', 'tool_source_')):
        translated = english_capability_message(chinese)
        if translated:
            return translated
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
    required_capability: Capability | None = None,
) -> str:
    return localized_error_for_language(
        request.headers.get("accept-language"),
        chinese=chinese,
        status=status,
        code=code,
        required_capability=required_capability,
    )


def localized_receipt(request: Request, receipt: CommandReceipt) -> CommandReceipt:
    return receipt.model_copy(update={'issues': tuple(
        issue.model_copy(update={'message': localized_error(request, chinese=issue.message, status=422, code=issue.code)})
        for issue in receipt.issues
    )})
