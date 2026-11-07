import assert from "node:assert/strict";
import test from "node:test";
import { setActiveLocale } from "../src/i18n/messages.ts";
import { generationDefaults } from "../src/canvas/generationCatalog.ts";
import { createNode } from "../src/canvas/model.ts";
import type { CanvasNode, GenerationSettings } from "../src/canvas/model.ts";
import {
  MUSIC_SECONDS,
  backendAspectRatios,
  backendBlocker,
  backendModel,
  backendReferenceIssue,
  backendVideoMode,
  isMusicModel,
  isScoreModel,
  modelLabel,
  referenceBudgetIssue,
  serviceAudioSettings,
  serviceGenerationSettings,
  serviceVoice,
  type ModelConfig,
} from "../src/backend/rules.ts";

setActiveLocale("zh-CN");

const model = (
  kind: ModelConfig["kind"],
  patch: Partial<ModelConfig> = {},
  rules: Partial<ModelConfig["inputRules"]> = {},
): ModelConfig => {
  const { inputRules: rulePatch, id, ...rest } = patch;
  return {
    id: id ?? `${kind}-config`,
    kind,
    url: "http://127.0.0.1:8010/v1",
    modelId: "org/fixture-model",
    connectionType: "self_hosted",
    protocol: "openai",
    authMode: "none",
    ...rest,
    inputRules: {
      profile: "fixture",
      allowedKinds: ["text", "image", "video", "audio"],
      maxImages: 2,
      maxVideos: 1,
      maxAudios: 1,
      videoModes: ["first_frame", "reference"],
      ...rules,
      ...rulePatch,
    },
  };
};

const media = (kind: "image" | "video" | "audio" | "text"): CanvasNode =>
  createNode(
    kind,
    { x: 0, y: 0 },
    kind === "text"
      ? { text: "旁白" }
      : { src: `data:${kind}/x;base64,AA==`, assetState: "ready" },
  );

const settings = (
  mode: GenerationSettings["mode"],
  patch: Partial<GenerationSettings> = {},
): GenerationSettings => ({
  ...generationDefaults(mode),
  modelConfigId: `${mode}-config`,
  prompt: "灯塔",
  resolution: "auto",
  aspectRatio: "auto",
  ...patch,
});

test("model identity, voice ids, and audio role follow the published configuration", () => {
  const music = model("audio", {
    id: "music",
    modelId: "m-a-p/YuE2-3B",
    protocol: "vllm_omni_music",
  });
  const speech = model("audio", { id: "speech", modelId: "tts" });
  assert.equal(modelLabel(music), "YuE2-3B");
  assert.equal(modelLabel({ modelId: "bare" }), "bare");
  assert.equal(modelLabel({ modelId: "org/" }), "org/");
  assert.equal(backendModel(settings("audio", { modelConfigId: "" }), [music]), undefined);
  assert.equal(backendModel(settings("audio", { modelConfigId: "missing" }), [music]), undefined);
  assert.equal(backendModel(settings("audio", { modelConfigId: "music" }), [speech, music]), music);
  assert.equal(serviceVoice({ voiceName: "Voice.1" }), "Voice.1");
  assert.equal(serviceVoice({ voiceName: "a".repeat(64) }), "a".repeat(64));
  assert.equal(serviceVoice({ voiceName: "a".repeat(65) }), undefined);
  assert.equal(serviceVoice({ voiceName: "动漫海绵" }), undefined);
  assert.equal(serviceVoice({ voiceName: "has space" }), undefined);
  assert.equal(serviceVoice({}), undefined);

  const image = settings("image");
  assert.equal(serviceAudioSettings(image, music), image);
  const short = settings("audio", { modelConfigId: "music", durationSeconds: 5 });
  assert.equal(serviceAudioSettings(short, music).audioCreationType, "music");
  assert.equal(serviceAudioSettings(short, music).durationSeconds, MUSIC_SECONDS.initial);
  const kept = settings("audio", { modelConfigId: "music", durationSeconds: 40 });
  assert.equal(serviceAudioSettings(kept, music).durationSeconds, 40);
  assert.equal(serviceAudioSettings(short, speech).audioCreationType, "audio");
  assert.equal(serviceAudioSettings(short, speech).durationSeconds, 5);
  assert.equal(isMusicModel(music), true);
  assert.equal(isMusicModel(speech), false);
  assert.equal(isScoreModel({ kind: "audio", protocol: "vllm_omni_score" }), true);
  assert.equal(isScoreModel(music), false);
});

test("changing models clears choices the new adapter does not publish", () => {
  const image = model("image", { id: "image" }, {
    imageOutputs: [{ aspectRatio: "1:1", size: "1024x1024" }],
    videoModes: [],
    allowedKinds: ["text"],
    maxImages: 0,
  });
  const changed = serviceGenerationSettings(
    settings("image", {
      modelConfigId: image.id,
      imagePreset: "product-views",
      voiceName: "音色",
      aspectRatio: "16:9",
      resolution: "2K",
    }),
    image,
    [],
    true,
  );
  assert.equal(changed.imagePreset, "none");
  assert.equal(changed.voiceName, undefined);
  assert.equal(changed.aspectRatio, "auto");
  assert.equal(changed.resolution, "auto");
  const kept = serviceGenerationSettings(
    settings("image", { modelConfigId: image.id, voiceName: "Voice.1" }),
    image,
    [],
    true,
  );
  assert.equal(kept.voiceName, "Voice.1");
});

test("reference checks reject empty, missing, and frame-incompatible sources", () => {
  const video = model("video", { id: "video" });
  const videoSettings = settings("video", { modelConfigId: video.id });
  const empty = createNode("text");
  assert.match(backendReferenceIssue(empty, videoSettings, video)!, /文本节点为空/);
  const foreign = model("video", { id: "video" }, { allowedKinds: ["image"] });
  assert.match(
    backendReferenceIssue(media("text"), videoSettings, foreign)!,
    /不接收文本/,
  );
  const lost = createNode("image", undefined, { src: "data:image/png;base64,AA==", assetState: "missing" });
  assert.match(backendReferenceIssue(lost, videoSettings, video)!, /丢失/);
  assert.match(backendReferenceIssue(createNode("group"), videoSettings, video)!, /不接收此类/);
  const frames = settings("video", { modelConfigId: video.id, videoMode: "first-last" });
  assert.match(backendReferenceIssue(media("video"), frames, video)!, /视频或音频/);
  assert.match(backendReferenceIssue(media("audio"), frames, video)!, /视频或音频/);
});

test("derived video mode and ratios follow the adapter, not the requested label", () => {
  const referenceOnly = model("video", { id: "video" }, { videoModes: ["reference"] });
  const requested = settings("video", { modelConfigId: referenceOnly.id, videoMode: "reference" });
  assert.equal(backendVideoMode(requested, [], referenceOnly), "reference");
  assert.equal(
    backendVideoMode(
      settings("video", { videoMode: "continuation" }),
      [],
      referenceOnly,
    ),
    "continuation",
  );
  assert.equal(
    backendVideoMode(settings("video", { videoMode: "first-last" }), [], referenceOnly),
    "first_frame",
  );
  const volcengine = model("video", {
    id: "video",
    protocol: "volcengine",
    inputRules: {
      profile: "volcengine",
      allowedKinds: ["text", "image"],
      maxImages: 1,
      maxVideos: 0,
      maxAudios: 0,
      videoModes: ["reference"],
    },
  });
  assert.deepEqual(
    backendAspectRatios(settings("video", { videoMode: "continuation" }), volcengine),
    ["auto"],
  );
  assert.ok(
    backendAspectRatios(settings("video", { videoMode: "reference" }), volcengine).includes(
      "16:9",
    ),
  );
});

test("submission blockers name the rule that fails before a request is sent", () => {
  const image = model("image", { id: "image" }, { videoModes: [] });
  const video = model("video", { id: "video" });
  assert.match(
    backendBlocker(settings("image", { modelConfigId: video.id }), [], [video])!,
    /类型与节点不符/,
  );
  assert.match(
    backendBlocker(
      settings("image", { modelConfigId: image.id, imagePreset: "product-views" }),
      [],
      [image],
    )!,
    /三视图/,
  );
  const music = model("audio", {
    id: "music",
    protocol: "vllm_omni_music",
    inputRules: {
      profile: "music",
      allowedKinds: ["text"],
      maxImages: 0,
      maxVideos: 0,
      maxAudios: 0,
      videoModes: [],
    },
  });
  const composing = serviceGenerationSettings(
    settings("audio", { modelConfigId: music.id, prompt: "钢琴" }),
    music,
    [],
    true,
  );
  assert.match(
    backendBlocker({ ...composing, lyrics: "词".repeat(5001) }, [], [music])!,
    /5000/,
  );
  const speech = model("audio", { id: "speech" });
  assert.match(
    backendBlocker(
      settings("audio", { modelConfigId: speech.id, audioCreationType: "music" }),
      [],
      [speech],
    )!,
    /文本朗读/,
  );
  assert.match(
    backendBlocker(
      settings("audio", {
        modelConfigId: speech.id,
        audioMode: "tts",
        voiceName: "bad voice",
      }),
      [],
      [speech],
    )!,
    /音色标识/,
  );
  const first = media("image");
  assert.match(
    backendBlocker(
      settings("video", {
        modelConfigId: video.id,
        videoMode: "first-last",
        firstFrameNodeId: first.id,
      }),
      [],
      [video],
    )!,
    /首帧素材/,
  );
});

test("reference budgets count each source once and skip continuation clips", () => {
  const image = model("image", { id: "image" }, {
    imageBytes: 20,
    requestBytes: 12,
    maxImages: 4,
    videoModes: [],
  });
  const photo = createNode("image", undefined, { src: "picture", byteSize: 8 });
  assert.equal(referenceBudgetIssue([photo, photo], image), null);
  const other = createNode("image", undefined, { src: "other", byteSize: 8 });
  assert.match(referenceBudgetIssue([photo, other], image)!, /预算/);
  photo.data.byteSize = 1;
  other.data.byteSize = 1;
  const limited = model("image", { id: "limited" }, {
    imageBytes: 20,
    requestBytes: 12,
    maxImages: 1,
    videoModes: [],
  });
  assert.match(referenceBudgetIssue([photo, other], limited)!, /数量/);

  const agent = model("agent", { id: "agent" }, { maxImages: 0, maxVideos: 0 });
  const clip = createNode("video", undefined, { src: "clip", byteSize: 4 });
  assert.equal(referenceBudgetIssue([clip], agent), null);
  assert.match(referenceBudgetIssue([photo], agent)!, /数量/);

  const video = model("video", { id: "video" }, {
    videoBytes: 1,
    videoModes: ["continuation"],
    maxVideos: 1,
  });
  const previous = createNode("video", undefined, {
    src: "data:video/mp4;base64,AA==",
    assetState: "ready",
    byteSize: 20,
  });
  assert.match(referenceBudgetIssue([previous], video)!, /大小限制/);
  assert.equal(
    referenceBudgetIssue(
      [previous],
      video,
      settings("video", { modelConfigId: video.id, videoMode: "continuation" }),
    ),
    null,
  );

  const novel = createNode("text", undefined, { text: "字".repeat(70_000) });
  const textModel = model("image", { id: "image" }, { maxImages: 0 });
  assert.match(referenceBudgetIssue([novel], textModel)!, /大小限制/);
});
