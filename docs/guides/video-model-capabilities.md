# Video model capability configuration

Model connection details and output capabilities are stored separately in the local backend. Capabilities are declarative data: they contain no scripts and do not modify model weights, sampling steps or server memory. This implementation is independent of other products' code.

Generation history shows the requested video duration and the measured result duration separately. A 4-second FastH3 request that preserves the last anchor may produce 107 frames at 24 fps, displayed as a 4.458-second result.

## Interface

1. Open "Model connections", add or edit a video model, and fill in the base URL, Model ID and authentication.
2. Expand the collapsed "Video adapter" section for advanced settings. Choose the adapter for the `/videos` API. FastH3 uses eight steps and multi-asset references; each generation draws a new seed, keeps it with the job and reuses it when the job is recovered. FastH3 first/last frames (`fasth3_dual`) offers two generation modes on one model: its reference mode matches FastH3, while first/last-frame mode takes at most one first-frame and one last-frame anchor image, submits `fl2va` with `res_multistep` at 20 steps, and lands on the native 17n+5 frame grid, keeping the tail anchor at the grid's last frame instead of trimming to the requested duration. First/last-frame mode requires both anchors, rejects video and audio references, and is not combined with multi-asset references. Native H3 supports a first frame, asset references and continuation. The generic adapter sends only text and a single first frame, without H3 sampling parameters. When a model uses a custom name, choose the adapter explicitly.
3. Known models offer "Load adapter preset". Models without a declared capability show only "Auto" and "Service default duration".
4. Enable "Custom output specs" and fill in the resolution, supported durations and optional landscape pixel width and height for each tier. Durations accept `4-10,15`, meaning 4 to 10 seconds plus 15 seconds; tiers may declare different duration sets.
5. Set the default resolution, default duration and pixel alignment step, then save. Whether pixel sizes are required depends on the submitted parameters: adapters that send an explicit width and height need sizes, while adapters that send a resolution tier and let the service decide may leave them empty. Known H3 tiers may also use the adapter's built-in sizes. H3 aligns to 32 pixels and existing adapters stay within 4–15 seconds.

Switching models applies the new model's default resolution; a compatible selected duration is kept, otherwise the new default applies. After a duration change, the interface lists only resolutions that support it and resets inapplicable choices to default or auto. The backend validates again before accepting a job and never silently changes an unsupported combination into another duration.

Reference material decides the frame; an explicit resolution decides the output size; continuation keeps the previous clip's size and uses only auto. Existing provider mode restrictions still apply, such as the resolution limits of Seedance image-reference mode. Custom capabilities cannot change the upload protocol, enable unimplemented reference modes, or exceed a native adapter's limits.

Disabling "Custom output specs" and saving restores the adapter presets. Leaving the key empty while editing keeps the saved key; capability information never contains keys. Existing configurations keep their previous adapter and do not switch request formats because of a model alias; a new unknown model uses the generic adapter.

## Reading a service declaration

"Read service declaration" only requests `GET /models` from the configured service (the base URL usually already ends with `/v1`); it creates no generation job and saves nothing. It applies only after the user confirms and saves. It requires the entry with the exact Model ID to include `videoCapabilities`.

This is an optional OpenDirector extension, not a field guaranteed by OpenAI or vLLM. When the `/models` list only has model names, no resolution or duration is inferred and manual entry is still required. No inference server change is needed to use this feature, and local configuration alone is also fine.

Declaration example (format only; replace it with the parameters the service really supports):

```json
{
  "data": [
    {
      "id": "custom-video",
      "videoCapabilities": {
        "outputs": [
          { "resolution": "540P", "durations": [3, 5], "width": 960, "height": 540 },
          { "resolution": "720P", "durations": [5, 7], "width": 1280, "height": 720 }
        ],
        "defaultResolution": "720P",
        "defaultDuration": 7,
        "dimensionStep": 2
      }
    }
  ]
}
```

Each declaration allows at most 20 tiers; durations are integers from 1 to 60, and the usable range depends on the adapter and the service. Width and height are filled together or left empty; landscape width is not smaller than height, edges are 64–8192, and the values match the alignment step. The default resolution and duration must form a valid combination, and resolution names must not repeat.

A failed read, invalid fields or a missing declaration keeps the current configuration. A saved key is reused only when the base URL is identical; reading a new address requires the key again.

## Extension boundary

Adding a model under an existing adapter protocol, or changing output tiers, only needs configuration. A brand-new service that uses different upload, submit, poll or result-download protocols still needs its own adapter. Interface declarations do not guarantee that the remote model, account permissions or hardware can complete the configured request.

## MiniMax official video V2

When adding a video service, choose "MiniMax official video V2", enter `https://api.minimax.cn/v2` as the base URL and use a Bearer API key. The model list comes from built-in declarations; loading the list does not verify the key or account permissions. The connection is still managed by `providerId`, while the project references the model configuration's own `id`; a self-hosted model with the same name uses a separate connection and the `vllm_omni` protocol.

This adapter serves `MiniMax-H3`, `MiniMax-H3-Highspeed`, `MiniMax-H3-Lite` and `MiniMax-H3-Max`, limiting output tiers and integer durations per model. First/last-frame mode lets you choose a first frame, a last frame or both; with no frame selected it generates from text. Reference mode supports images, video and audio, including a standalone audio reference. First/last frames cannot be mixed with multimodal references. The first/last-frame output ratio is decided by the service from the inputs; text-generation auto resolves to `16:9`. Custom pixel sizes and cached continuation are not accepted.

Local assets are encoded as Base64 from their actual bytes, are not uploaded to any extra hosting service, and are not compressed automatically. PNG, JPEG and WEBP images, MP4 and MOV video, and WAV and MP3 audio are supported; dimensions, counts, per-file size, duration, frame rate and codec are checked before submission. The encoded request must stay within the official request budget, and an over-budget request is rejected explicitly. URL and `mm_file://` inputs, HEIC/HEIF and callback notifications are outside this adapter's scope.

An accepted job freezes its model, parameters, media and reference purposes. For a known remote task, recovery keeps querying the original task; an unknown submission is not resent automatically. Results download as local assets and enter the existing candidate and adoption flow; CDN downloads do not carry the API key. Stopping local execution does not mean the remote task was cancelled — this adapter does not implement remote cancellation, so the task may keep running and billing.

Protocol references: [create task](https://platform.minimax.cn/docs/api-reference/video-generation-v2-create), [query task](https://platform.minimax.cn/docs/api-reference/video-generation-v2-query). Real service calls and generation quality need to be verified separately with a configured account.

## Providers and per-model settings

Higgsfield Open supports `sand/magi-2` through one video connection: text, first/last frames and mixed image/video/audio references. Output is 1080p at 4–30 seconds with optional generated audio. See the [MAGI-2 guide](higgsfield-magi-2.md) for setup, input limits and recovery.

Kling 4.0 uses the separate `kling_video` protocol and picks the official submit path for text, first/last frames and image references, sharing the existing task query, recovery and result-adoption flow. Its fixed capabilities are published by the backend. `kling-4.0` supports 720P / 1080P, 3–30 seconds and first/last frames; `kling-4.0-flash` supports 720P, 3–20 seconds and a first frame, without a last frame. Both models support image references and native audio, and do not accept custom pixel sizes. Setup and input limits are in the [English guide](kling-video.md) and the [Chinese guide](kling-video.zh-CN.md).

MiniMax official video offers four models; adding a service selects all of them by default, and they become active after saving. Editing an existing service keeps the previous selection. Standard H3 supports 768P / 2K and 4–15 seconds; Highspeed and Lite support 480P / 768P and 4–15 seconds; Max supports 480P / 768P and 5–15 seconds. Output tiers and durations are validated per model by the backend.

When adding a service, choose a provider first. The provider list is split into "Custom API" and "vLLM-Omni compatible", and each group lists only the connection types it supports. The video page lists MiniMax official video, Kling official video, Volcengine Ark / Agent Plan, and the "vLLM-Omni compatible" group, which contains video, segmentation and depth APIs. Selecting an entry fixes the protocol and connection type, so the form no longer offers a global protocol list for a second classification. Advanced connection settings hold parameters such as the address; self-hosted addresses are entered by the user. The MiniMax chat preset uses the [official OpenAI-compatible endpoint](https://platform.minimax.cn/docs/api-reference/text-openai-api), and the video preset uses the video V2 protocol.

When a saved connection already exists for the same category, address and protocol, you may explicitly reuse it to keep the key and model identity; otherwise a separate connection is created. Manual entries and fetched lists can be mixed, fetched results still need to be selected, and existing selections survive a list refresh.

The image page's "vLLM-Omni compatible" group holds image and segmentation APIs; the audio page holds speech synthesis, music generation and transcription APIs. Each entry fixes its protocol, so no global protocol choice is shown. "OpenAI compatible" on the chat, image and audio pages sits first in the "Custom API" group and merges official OpenAI with compatible services; it defaults to the official address, and both address and authentication are editable.

Each selected model shows its own capability card. Chat models declare image understanding independently; video models configure the adapter and output specs per model, while official H3 and Kling show fixed backend capabilities. Editing one model never overwrites the capabilities of another. Saving stores configuration only: it runs no inference test and does not switch the current creation model; chat models can run a connectivity test separately.

First/last-frame references use image assets with `role=first_frame` / `last_frame` and do not fill `subjectRole`, which marks a subject-media slot rather than a video's first frame. If an explicitly assigned frame would be filtered by the reference policy, submission returns `reference_invalid` and neither accepts the task nor degrades it to text-to-video; text-to-video without frames is still allowed. `fasth3_dual`'s first/last-frame mode requires both anchors: a missing anchor, or an attached audio or video reference, is rejected without creating a job.
