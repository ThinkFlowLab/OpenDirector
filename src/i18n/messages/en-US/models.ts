/** Model connection and service forms. */
export const models = {
  "models.service.proxyMode": "Network connection mode",
  "models.service.proxySystem": "Use system proxy",
  "models.service.proxyDirect": "Direct (no proxy)",
  "models.service.proxyNote": "Applies to this model service's requests and result downloads. Use a direct connection if a proxy causes timeouts or disconnections.",
  "models.readFailed": "Could not read model settings.",
  "models.reload": "Reload",
  "models.categories": "Model categories",
  "models.category.agent": "Chat agent",
  "models.category.agentShort": "Chat",
  "models.category.image": "Image generation",
  "models.category.imageShort": "Image",
  "models.category.video": "Video generation",
  "models.category.videoShort": "Video",
  "models.category.audio": "Audio generation",
  "models.category.audioShort": "Audio",

  "models.services.heading": "Service connections",
  "models.services.hint":
    "Manage service URLs, authentication, and enabled models.",
  "models.services.add": "Add service",
  "models.services.empty": "No services configured",
  "models.services.support":
    "Supports provider APIs and self-hosted vLLM / vLLM-Omni services.",
  "models.services.manage": "Manage",
  "models.services.count": {
    one: "{count} model",
    other: "{count} models",
  },
  "models.services.remove": "Remove service",
  "models.services.removeConfirm": {
    one: "Remove this service and {count} model configuration? Project assets will be kept.",
    other:
      "Remove this service and {count} model configurations? Project assets will be kept.",
  },
  "models.services.removing": "Removing…",
  "models.services.confirmRemove": "Confirm removal",
  "models.cancel": "Cancel",

  "models.protocolName.volcengine": "Volcengine",
  "models.protocolName.segmentation": "Visual segmentation",
  "models.protocolName.depth": "Video depth",
  "models.protocolName.score": "Music transcription",
  "models.protocolName.music": "Music generation",
  "models.protocolName.vllmOmni": "Video API",
  "models.protocolName.openai": "OpenAI compatible",

  "models.service.add": "Add service",
  "models.service.edit": "Edit service",
  "models.service.back": "Back to service list",
  "models.service.connection": "Connection settings",
  "models.service.addressAndAuth": "URL and authentication",
  "models.service.notConfigured": "Not configured",
  "models.service.connectionInfo": "Connection details",
  "models.service.protocol": "API protocol",
  "models.service.connectionType": "Connection type",
  "models.service.selfHosted": "Self-hosted (vLLM / vLLM-Omni)",
  "models.service.providerApi": "Provider API",
  "models.service.provider": "Provider",
  "models.service.url": "Service URL (Base URL)",
  "models.service.noKey": "No key required",
  "models.service.keyConfigured": "Key configured",
  "models.service.noAuthPlaceholder": "This service requires no authentication",
  "models.service.savedKeyPlaceholder":
    "A key is saved; leave blank to keep it",
  "models.service.apiKeyPlaceholder":
    "Enter the API key provided by the service",
  "models.service.hideKey": "Hide key",
  "models.service.showKey": "Show key",
  "models.service.hide": "Hide",
  "models.service.show": "Show",
  "models.service.urlNote":
    "Self-hosted services usually use a /v1 URL; when connecting through an SSH tunnel, enter the local forwarded address.",
  "models.service.inputCapabilities": "Input capabilities",
  "models.service.referenceOutput": "References and output",
  "models.service.textInput": "Text",
  "models.service.imageInput": "Image understanding",
  "models.service.imageInputNote":
    "Enable only when the model natively accepts image input.",
  "models.service.officialSummary":
    "Text-to-video / first-last frame / multimodal references",
  "models.service.klingSummary": "Text-to-video / first-last frame / image references",
  "models.service.klingFlashSummary": "Text-to-video / first frame / image references",
  "models.service.klingReferences": "References: PNG or JPEG images. Native audio is included. Frame inputs determine the output aspect ratio.",
  "models.service.loadingNative": "Loading supported output specifications…",
  "models.service.officialReferences":
    "References: image, video, audio. Output includes audio.",
  "models.service.noCapabilityOutput":
    "No output specification is available. Fill it in manually.",
  "models.service.secondsRange": "{min}–{max} s",
  "models.service.modalitiesNote":
    "Applies to the models selected here. Enable only when the model and API support image understanding.",
  "models.service.segmentationNote":
    "Segmentation models are used for selections, layer separation, and matting; they do not generate images or videos.",
  "models.service.depthNote":
    "Depth models are used for depth-based motion capture; they do not generate video.",
  "models.service.scoreNote":
    "Transcription models convert reference music into a score for YuE2 reference generation; they do not generate audio themselves.",
  "models.service.videoAdapter": "Video adapter",
  "models.service.adapterAuto":
    "Auto-detect known models; use the generic first-frame API for others",
  "models.service.adapterFastH3":
    "FastH3-Omni (8 steps, multi-asset reference)",
  "models.service.adapterMiniMaxH3":
    "Native MiniMax-H3 (first frame, asset references, continuation)",
  "models.service.adapterStandard":
    "Generic /videos (text, single first frame)",
  "models.service.loadPreset": "Load adapter preset",
  "models.service.readService": "Read service declaration",
  "models.service.capabilityHelp":
    "The service must return a videoCapabilities extension for this model in /models; if it only returns model names, configure it manually.",
  "models.service.tooManyModels": "Each service can enable at most 200 models",
  "models.service.willEnable": {
    one: "Will enable {count} model",
    other: "Will enable {count} models",
  },
  "models.service.selectAtLeastOne": "Select at least one model",
  "models.service.saving": "Saving…",
  "models.service.cancel": "Cancel",
  "models.service.advancedConnection": "Advanced connection settings",
  "models.service.existingConnections":
    "Connections with the same address",
  "models.service.reuseConnection": "Reuse saved connection · {model}",
  "models.service.reuseHint":
    "Otherwise this will be saved as a separate connection.",
  "models.service.loadSupportedModels": "Load supported models",
  "models.service.minimaxNote":
    "The model list comes from the built-in declaration. Loading it does not verify the key or create a video task.",
  "models.service.save": "Save service",
  "models.service.testing": "Testing…",
  "models.service.testPassed": "Passed in {seconds} s",
  "models.service.noOutputPreset":
    "No output preset was detected. Enable custom output specs and fill them in.",

  "models.protocolOption.openaiAgent": "OpenAI-compatible API (including vLLM)",
  "models.protocolOption.openaiImage":
    "OpenAI-compatible API (including gpt-image and vLLM-Omni Z-Image-Turbo)",
  "models.protocolOption.volcengine": "Volcengine Ark / Agent Plan",
  "models.protocolOption.segmentation": "vLLM-Omni segmentation API (SAM 3)",
  "models.protocolOption.videos": "Async /videos API (including vLLM-Omni)",
  "models.protocolOption.minimaxVideo": "MiniMax official video V2",
  "models.protocolOption.klingVideo": "Kling official video API",
  "models.protocolOption.depth": "vLLM-Omni depth API (Video Depth Anything)",
  "models.protocolOption.tts":
    "OpenAI-compatible speech synthesis (including vLLM-Omni TTS)",
  "models.protocolOption.volcengineAudio": "Volcengine Speech / Agent Plan",
  "models.protocolOption.music":
    "vLLM-Omni music generation (MiniMax Music 3, YuE2)",
  "models.protocolOption.score": "vLLM-Omni transcription API (SheetSage2)",
} satisfies Record<string, string | { one: string; other: string }>;
