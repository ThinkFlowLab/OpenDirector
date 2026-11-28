"""Localized user-facing errors for the local HTTP boundary.

Domain code keeps its Chinese copy for CLI and Agent traces. The HTTP boundary
chooses an English message from the stable error code when the caller asks for
English, so a missing translation never leaks Chinese into an English UI.
"""
import re

from fastapi import Request


from opendirector.domain.timeline_errors import timeline_error_message

from opendirector.domain.creation.assets import ASSET_DOWNLOAD_ENGLISH
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
    **ASSET_DOWNLOAD_ENGLISH,
    "desktop_auth_required": "The desktop connection has expired. Reopen the application.",
    'h3_timeline_guides_single_model': 'Configure timeline guides for an individual FastH3 model.',
    'h3_timeline_guides_source_limit': 'An H3 segment accepts one source video reference.',
    'h3_timeline_guides_deployment': 'Enable timeline guides only for a compatible self-hosted FastH3 video endpoint.',
    'h3_timeline_guides_unsupported': 'H3 source video segments require a self-hosted H3 endpoint with timeline guides and Reference mode.',
    'image_quality_unsupported': 'This model does not support the selected image quality. Choose Auto or select another model.',
    'bigmodel_video_model': 'The BigModel video protocol supports CogVideoX-3 only.',
    'bigmodel_video_output': 'Choose a supported CogVideoX-3 pixel size and a 5- or 10-second duration. The size determines the aspect ratio.',
    'bigmodel_video_image': 'CogVideoX-3 frame images must be valid PNG or JPEG files, up to 5 MB each.',
    'bigmodel_video_frames': 'Use text, one first-frame image, or an explicit first/last pair. Each frame slot accepts one image; a last frame requires a first frame. Reference and continuation modes are not supported.',
    'bigmodel_video_prompt': 'CogVideoX-3 prompts allow up to 512 characters. Provide a prompt or frame image.',
    'bigmodel_video_cancel': 'Remote BigModel video cancellation is not connected. The task may continue running and incur charges.',
    'workflow_assembly_busy': 'This assembly run is already processing. Wait for its result.',
    'workflow_media_invalid': 'The source frame range, dimensions, frame rate, or soundtrack does not match the assembly.',
    'workflow_media_failed': 'Media processing failed. Check FFmpeg and the source videos.',
    'segment_run_busy': 'This Run has an unresolved execution. Check its execution status before starting again.',
    'segment_run_unavailable': 'The Run execution service is unavailable.',
    'segment_run_no_execution': 'This Run has no execution available to pause or resume.',
    'segment_run_not_paused': 'This Run has no paused execution to resume.',
    'segment_run_invalid_state': 'This action is unavailable in the execution’s current state.',
    'segment_run_stale_execution': 'This Run’s execution changed. Refresh its status and select the execution again.',
    'segment_run_incompatible_result': 'The selected result is incompatible with this Run’s frozen inputs or selected guides.',
    'agent_run_candidate_review_required': 'A group segment is awaiting candidate adoption. Review the candidate and end the turn with a report if it fails.',
    'segment_run_candidate_missing': 'The selected candidate is unavailable in this execution.',
    'segment_run_guide_mismatch': 'The continuation guide does not match the result produced by its upstream step in this execution.',
    'segment_run_job_missing': 'The segment execution did not return a matching job.',
    'segment_run_job_unsettled': 'The original segment job can still be recovered. Check that job before starting again.',
    'segment_run_reconciliation_pending': 'The original provider task is still unresolved.',
    'segment_run_remote_missing': 'The provider could not find the original task. Regenerate this segment to continue.',
    'submission_unknown': 'The provider may have received the request. Check that submission before retrying.',
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
    run_messages = {
        '只能通过发布命令创建 Run。': 'Use the Run publication command to create a published Run.',
        '请使用分段计划保存命令创建草稿。': 'Use the segment plan save command to create a draft.',
        '请先发布 Run 草稿。': 'Publish the Run draft before starting it.',
        '计划已发布，无法直接修改。': 'This published Run cannot be edited directly.',
        '请选择可见且未锁定的已发布 Run。': 'Select a visible, unlocked published Run.',
        '请先解锁 Run 计划节点。': 'Unlock the Run plan node first.',
        '已发布片段须通过 Run 执行。': 'Start the published Run to execute its segments.',
        '部署配置已变化，请发布新的 Run。': 'The model deployment configuration changed. Publish a new Run.',
        '请选择未发布且未锁定的 Run 草稿。': 'Select an unlocked, visible top-level Run draft.',
        '发布 Run 需要可见时间线和未使用的成片节点。': 'A Run needs a visible timeline and an unused output slot.',
        '此时间线或成片节点已属于其他 Run。': 'The timeline or output slot belongs to another Run.',
        'Run 时间线须匹配帧率，并配置画面轨与原声音轨。': 'Use a timeline with the source frame rate, a video track, and an original soundtrack track.',
        'Run 原声须覆盖完整交付区间。': 'The original soundtrack must cover the full delivery range.',
        '发布前须固定随机种子、清除素材覆盖并等待已有任务结束。': 'Set a sampling seed, clear asset overrides, and wait for existing jobs before publishing.',
        '发布 Run 前须固定素材和肖像的引用版本。': 'Pin asset and portrait reference versions before publishing.',
        '每个分段须固定一个源视频引用。': 'Pin one source video reference for each segment.',
        'Run 需要可见的片段节点。': 'Make all segment nodes visible before publishing this Run.',
        '分段 Run 需要 FastH3 或 vLLM-Omni MiniMax-H3 部署。': 'Segmented Runs require a FastH3 or vLLM-Omni MiniMax-H3 deployment.',
        'Run 续接片段需要支持时间线导帧的部署。': 'Continuations require a deployment that supports timeline guides.',
        'Run 导帧需要支持时间线导帧的部署。': 'Run guides require a deployment that supports timeline guides.',
        'H3 导帧来源必须是有效的固定图片或原始视频。': 'An H3 guide must reference a valid pinned image or original video.',
        'H3 导帧素材和普通参考必须使用不同的素材。': 'The H3 guide and ordinary references must use different assets.',
        'H3 导帧帧号超出生成窗口。': 'The H3 guide frame lies outside the generation window.',
        'H3 导帧图片超过模型图片大小限制。': 'The H3 guide image exceeds the model image size limit.',
        '导帧素材不能作为提示词中的普通素材引用。': 'The prompt cannot cite a guide asset as an ordinary reference.',
        'Run 帧数或帧率与实际源片不一致。': 'The frame count or frame rate does not match the source video.',
        '工程在核对期间已更新，请重新发布 Run。': 'The project changed during validation. Review and publish the Run again.',
        '模型配置在核对期间已更新，请重新发布 Run。': 'The model configuration changed during validation. Review and publish the Run again.',
    }
    if chinese in run_messages:
        return run_messages[chinese]
    if code == 'invalid_input':
        measured = re.fullmatch(r'片段「(.*)」实测输入 (\d+) 帧，请求 (\d+) 帧。.*', chinese, re.DOTALL)
        if measured:
            name, actual, requested = measured.groups()
            return (f'{name}: input {actual} frames, requested {requested} frames. '
                    'Both must match 17k+5 with k >= 6 (at least 107 frames).')
        if re.fullmatch(r'片段「.*」无法按 24 FPS 解码数帧。', chinese, re.DOTALL):
            return 'The segment input could not be decoded and counted at 24 FPS.'
    if code == 'invalid_input' and chinese == '分组片段提交时必须指定来源画布节点（originItemId）。':
        return 'Submitting a grouped segment requires its source canvas node (originItemId).'
    if code == 'invalid_input' and chinese == '聊天引用超过数量上限，请移除部分引用。':
        return 'The chat reference limit was exceeded. Remove some references and retry.'
    if code == 'invalid_input' and chinese == '视频裁切需要视频来源节点。':
        return 'Select a video canvas node as the source for this trim.'
    if code == 'invalid_input' and chinese == '裁切结束时间超出来源视频时长。':
        return 'The trim ends after the source video. Choose an end time within the source duration.'
    if status == 409 and chinese == '此视频裁切正在进行，请等待结果。':
        return 'This trim is already running. Wait for its result.'
    if code == 'reference_invalid':
        fasth3_image = re.fullmatch(r'FastH3 参考图“(.+)”的两边须为 256–5760 像素，宽高比须为 0.4–2.5。', chinese, re.DOTALL)
        if fasth3_image:
            return f'Each side of the FastH3 reference image “{fasth3_image[1]}” must be 256–5760 pixels and its aspect ratio must be 0.4–2.5.'
        guide_plan_messages = {
            '已确认的导帧计划不能取消约束、改换锚点或移除原有片段。': 'A confirmed guide plan must retain its guide requirement, anchor and existing steps.',
            'H3 分段计划必须启用时间线导帧约束。': 'Enable the timeline guide requirement for this H3 segment plan.',
            '导帧计划的每个片段都必须绑定视频生成配置。': 'Bind each guide plan step to a video generation configuration.',
            '导帧计划中的片段必须使用各自的生成配置。': 'Each guide plan step needs its own generation configuration.',
            '已接受任务的导帧部署已变化或不再支持导帧。': 'The deployment captured by this job changed or no longer supports timeline guides.',
        }
        if chinese in guide_plan_messages:
            return guide_plan_messages[chinese]
        wrong_step = re.fullmatch(r'必须从计划中的片段节点 ([0-9a-f-]{36}) 提交。', chinese)
        if wrong_step:
            return f'Submit from the planned segment node {wrong_step[1]}.'
        wrong_plan = re.fullmatch(r'片段「(.+)」的导帧计划与冻结任务不一致。', chinese, re.DOTALL)
        if wrong_plan:
            return f'The guide plan for segment “{wrong_plan[1]}” differs from the frozen job.'
        wrong_anchor_guide = re.fullmatch(r'锚点「(.+)」的冻结图片导帧与发布配置不一致。', chinese, re.DOTALL)
        if wrong_anchor_guide:
            return f'The frozen guide image for anchor “{wrong_anchor_guide[1]}” differs from the published configuration.'
        wrong_source = re.fullmatch(r'片段「(.+)」的冻结导帧来源与本次采用的上游结果不一致。', chinese, re.DOTALL)
        if wrong_source:
            return f'The frozen guide source for segment “{wrong_source[1]}” differs from the adopted upstream result.'
        unavailable_guide = re.fullmatch(r'片段「(.+)」的冻结导帧素材无法读取。', chinese, re.DOTALL)
        if unavailable_guide:
            return f'The frozen guide asset for segment “{unavailable_guide[1]}” could not be read.'
        chat_reference = re.fullmatch(r'聊天引用 ([0-9a-f-]+) 的来源或素材版本已失效，请重新选择此引用。', chinese)
        if chat_reference:
            return f'Chat reference {chat_reference[1]} has a stale source or asset version. Select it again and retry.'
        unknown_chat_reference = re.fullmatch(r'聊天引用 ([0-9a-f-]+) 不属于当前对话。', chinese)
        if unknown_chat_reference:
            return f'Chat reference {unknown_chat_reference[1]} does not belong to the current conversation.'
        guide_segment = re.fullmatch(r'片段「(.+)」必须使用有效的 H3 时间线导帧。', chinese, re.DOTALL)
        if guide_segment:
            return f'Segment “{guide_segment[1]}” requires a valid H3 timeline guide.'
        segment = re.fullmatch(r'组装片段「(.+)」的生成任务缺少来源画布节点（originItemId）。', chinese, re.DOTALL)
        if segment:
            return f'The generation job for assembly segment “{segment[1]}” is missing its source canvas node (originItemId).'
        job = re.fullmatch(
            r'生成任务「([0-9a-f-]{36})」（规格 ([0-9a-f-]{36})）缺少来源画布节点（originItemId），无法确定对应的组装片段。',
            chinese,
        )
        if job:
            return (f'Generation job {job[1]} (spec {job[2]}) is missing its source canvas node (originItemId). '
                    'The assembly segment could not be identified.')
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
