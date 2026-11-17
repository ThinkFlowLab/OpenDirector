import { generationDefaults } from "../src/canvas/generationCatalog.ts";
import { createNode } from "../src/canvas/model.ts";
import { backendBlocker, backendDurations, backendResolutions, serviceAudioSettings, serviceGenerationSettings, serviceVoice } from "../src/backend/rules.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { ModelConfig } from "../src/backend/rules.ts";
import { getActiveLocale, setActiveLocale, translate } from "../src/i18n/messages.ts";
import {
  applyModelResolution,
  newNodeGenerationSettings,
  resolveGenerationModel,
} from "../src/canvas/modelResolution.ts";
import { backendAspectRatios } from "../src/backend/rules.ts";

const config = (
  kind: ModelConfig["kind"],
  modelId: string,
  overrides: Partial<ModelConfig> = {},
): ModelConfig => ({
  id: `${kind}:${modelId}`,
  kind,
  url: "http://127.0.0.1:8010/v1",
  modelId,
  connectionType: "self_hosted",
  protocol: kind === "video" ? "vllm_omni" : "openai",
  authMode: "none",
  inputRules: {
    profile: "test",
    allowedKinds: ["text", "image", "video", "audio"],
    maxImages: 4,
    maxVideos: 0,
    maxAudios: 0,
    videoModes: kind === "video" ? ["first_frame", "reference"] : [],
  },
  ...overrides,
});

const zeta = config("video", "zeta-video");
const alpha = config("video", "alpha-video");
const image = config("image", "alpha-image");
const vision: ModelConfig = config("vision", "sam", { protocol: "openai" });

test("a configured model that still exists is kept", () => {
  const resolution = resolveGenerationModel(
    { modelConfigId: zeta.id },
    "video",
    [alpha, zeta],
  );
  assert.deepEqual(resolution, {
    status: "current",
    model: "zeta-video",
    modelConfigId: zeta.id,
  });
});

test("a node without a model falls back to the deterministic default", () => {
  const resolution = resolveGenerationModel({}, "video", [zeta, alpha]);
  assert.deepEqual(resolution, {
    status: "default",
    model: "alpha-video",
    modelConfigId: alpha.id,
  });
});

test("the default does not depend on the order the API returns", () => {
  const first = resolveGenerationModel({}, "video", [zeta, alpha]);
  const second = resolveGenerationModel({}, "video", [alpha, zeta]);
  assert.deepEqual(first, second);
});

test("a node without a model follows the assistant picker", () => {
  const resolution = resolveGenerationModel({}, "video", [alpha, zeta], {
    video: zeta.id,
  });
  assert.deepEqual(resolution, {
    status: "default",
    model: "zeta-video",
    modelConfigId: zeta.id,
  });
});

test("adding Kling preserves the selected provider for existing and newly created video nodes", () => {
  const kling = config("video", "kling-4.0", { protocol: "kling_video", connectionType: "api", authMode: "bearer" });
  const available = [zeta, kling];
  const preferred = { video: zeta.id };
  const existing = resolveGenerationModel({ modelConfigId: zeta.id }, "video", available, preferred);
  assert.ok(existing.status !== "unconfigured");
  assert.equal(existing.modelConfigId, zeta.id);
  assert.equal(newNodeGenerationSettings("video", available, preferred).modelConfigId, zeta.id);
  assert.equal(newNodeGenerationSettings("video", [kling, zeta], preferred).modelConfigId, zeta.id);
});

test("Kling published capabilities drive duration, resolution, audio and frame ratio controls", () => {
  const kling = config("video", "kling-4.0", {
    protocol: "kling_video", connectionType: "api", authMode: "bearer",
    inputRules: { profile: "kling-official", allowedKinds: ["text", "image"], maxImages: 10,
      maxVideos: 0, maxAudios: 0, videoModes: ["first_frame", "reference"], frameRoles: ["first_frame", "last_frame"],
      generateAudioOptions: [true], aspectRatios: ["21:9", "16:9", "9:16", "1:1"], outputResolutions: ["720P", "1080P"],
      videoCapabilities: { outputs: ["720P", "1080P"].map(resolution => ({ resolution, durations: Array.from({ length: 28 }, (_, index) => index + 3) })),
        defaultResolution: "1080P", defaultDuration: 5, dimensionStep: 2 } },
  });
  const next = serviceGenerationSettings({ ...generationDefaults("video"), durationSeconds: 60, resolution: "4K", audioEnabled: false }, kling, [], true);
  assert.equal(next.durationSeconds, 5);
  assert.equal(next.resolution, "1080P");
  assert.equal(next.audioEnabled, true);
  const frames = serviceGenerationSettings({ ...next, videoMode: "first-last", aspectRatio: "16:9" }, kling);
  assert.equal(frames.aspectRatio, "auto");
  assert.deepEqual(backendAspectRatios({ mode: "video", videoMode: "first-last" }, kling), ["auto"]);
  assert.ok(backendAspectRatios({ mode: "video", videoMode: "reference" }, kling).includes("21:9"));
});

test("the picker preference never overrides an explicit node model", () => {
  const resolution = resolveGenerationModel(
    { modelConfigId: alpha.id },
    "video",
    [alpha, zeta],
    { video: zeta.id },
  );
  assert.equal(resolution.status, "current");
  assert.equal(resolution.modelConfigId, alpha.id);
});

test("a preference for another kind or a stale id falls back to the default", () => {
  const picked = (resolution: ReturnType<typeof resolveGenerationModel>) =>
    resolution.status === "unconfigured" ? null : resolution.modelConfigId;
  const wrongKind = resolveGenerationModel({}, "video", [alpha, zeta], {
    image: zeta.id,
  });
  assert.equal(picked(wrongKind), alpha.id);
  const stale = resolveGenerationModel({}, "video", [alpha, zeta], {
    video: "video:gone",
  });
  assert.equal(picked(stale), alpha.id);
});

test("a deleted configuration is reported instead of silently replaced", () => {
  const resolution = resolveGenerationModel(
    { modelConfigId: "video:gone" },
    "video",
    [alpha],
  );
  assert.deepEqual(resolution, {
    status: "orphaned",
    modelConfigId: "video:gone",
  });
});

test("a configuration of the wrong kind counts as orphaned", () => {
  const resolution = resolveGenerationModel(
    { modelConfigId: image.id },
    "video",
    [image, alpha],
  );
  assert.equal(resolution.status, "orphaned");
});

test("segmentation configurations are never offered for generation", () => {
  const resolution = resolveGenerationModel({}, "image", [vision]);
  assert.equal(resolution.status, "unconfigured");
});

test("no configured model of this kind reports unconfigured", () => {
  assert.equal(
    resolveGenerationModel({}, "audio", [alpha, image]).status,
    "unconfigured",
  );
});

test("applying a resolution writes the model and the configuration id", () => {
  const settings = { model: "本地交互演示", modelConfigId: undefined };
  const next = applyModelResolution(
    settings,
    resolveGenerationModel({}, "video", [alpha]),
  );
  assert.equal(next.model, "alpha-video");
  assert.equal(next.modelConfigId, alpha.id);
});

test("orphaned and unconfigured keep the stored values untouched", () => {
  const orphaned = { model: "旧模型", modelConfigId: "video:gone" };
  assert.deepEqual(
    applyModelResolution(
      orphaned,
      resolveGenerationModel(orphaned, "video", [alpha]),
    ),
    orphaned,
  );
  const unconfigured = { model: "旧模型", modelConfigId: undefined };
  assert.deepEqual(
    applyModelResolution(
      unconfigured,
      resolveGenerationModel(unconfigured, "audio", []),
    ),
    unconfigured,
  );
});

test("a new image node takes the selected adapter's ratio and size instead of the catalog 1:1", () => {
  const seedream = config("image", "doubao-seedream-5.0-flash", {
    protocol: "volcengine",
    inputRules: {
      ...image.inputRules,
      imageOutputs: [{ aspectRatio: "auto", size: "2K" }],
    },
  });
  const settings = newNodeGenerationSettings("image", [seedream]);
  assert.equal(settings.modelConfigId, seedream.id);
  assert.equal(settings.aspectRatio, "auto");
  assert.ok(["auto", "2K"].includes(settings.resolution));
});

test("a new image node keeps a ratio the adapter declares", () => {
  const fixed = config("image", "fixed-sizes", {
    inputRules: {
      ...image.inputRules,
      imageOutputs: [
        { aspectRatio: "1:1", size: "1024x1024" },
        { aspectRatio: "3:2", size: "1536x1024" },
      ],
    },
  });
  const settings = newNodeGenerationSettings("image", [fixed]);
  assert.equal(settings.aspectRatio, "1:1");
  assert.ok(["auto", "1024x1024"].includes(settings.resolution));
});

test("without a configured model a new node keeps the catalog defaults", () => {
  const settings = newNodeGenerationSettings("image", []);
  assert.equal(settings.modelConfigId, undefined);
  assert.equal(settings.aspectRatio, "1:1");
  assert.equal(settings.resolution, "2K");
});

test("new image nodes replace unsupported catalog sizing with adapter defaults", () => {
  const model = config("image", "moss-image-sft-1.0", {
    inputRules: { profile: "moss-image", allowedKinds: ["text"], maxImages: 0,
      maxVideos: 0, maxAudios: 0, videoModes: [],
      imageOutputs: [{ aspectRatio: "1:1", size: "1024x1024" }] },
  });
  const settings = newNodeGenerationSettings("image", [model], { image: model.id });
  assert.equal(settings.modelConfigId, model.id);
  assert.equal(settings.resolution, "auto");
  assert.equal(settings.aspectRatio, "1:1");
  assert.equal(backendBlocker({ ...settings, prompt: "Cloud cinema" }, [], [model]), null);
});

test("prompt length precheck follows the model's published limit and counts Unicode characters", () => {
  const model = config("image", "moss-image-sft-1.0", {
    inputRules: { ...image.inputRules, allowedKinds: ["text"], maxImages: 0,
      maxPromptCharacters: 4000,
      imageOutputs: [{ aspectRatio: "1:1", size: "1024x1024" }] },
  });
  const settings = newNodeGenerationSettings("image", [model]);
  assert.equal(backendBlocker({ ...settings, prompt: "🎬".repeat(4000) }, [], [model]), null);
  const previous = getActiveLocale();
  try {
    for (const locale of ["zh-CN", "en-US"] as const) {
      setActiveLocale(locale);
      assert.equal(
        backendBlocker({ ...settings, prompt: "🎬".repeat(4001) }, [], [model]),
        translate(locale, "errors.rules.promptTooLong", { limit: 4000 }),
      );
    }
  } finally {
    setActiveLocale(previous);
  }
  const stricter = { ...model, inputRules: { ...model.inputRules, maxPromptCharacters: 5 } };
  assert.ok(backendBlocker({ ...settings, prompt: "123456" }, [], [stricter]));
  const unlimited = { ...model, inputRules: { ...model.inputRules, maxPromptCharacters: null } };
  assert.equal(backendBlocker({ ...settings, prompt: "🎬".repeat(4001) }, [], [unlimited]), null);
});

test("MOSS layout JSON rejects text references with a localized explanation", () => {
  const model = config("image", "moss-image-sft-1.0", {
    inputRules: { ...image.inputRules, profile: "moss-image", allowedKinds: ["text"], maxImages: 0,
      imageOutputs: [{ aspectRatio: "1:1", size: "1024x1024" }] },
  });
  const settings = { ...newNodeGenerationSettings("image", [model]),
    prompt: '{"summary":{"caption":"A lake"},"items":[]}' };
  const note = createNode("text", undefined, { text: "Blue water" });
  const previous = getActiveLocale();
  try {
    for (const locale of ["zh-CN", "en-US"] as const) {
      setActiveLocale(locale);
      const issue = backendBlocker(settings, [note], [model]);
      assert.ok(issue);
      assert.match(issue, /JSON/);
      if (locale === "en-US") assert.doesNotMatch(issue, /[\u3400-\u9fff]/);
      assert.equal(backendBlocker(settings, [], [model]), null);
      assert.equal(backendBlocker({ ...settings, prompt: "A lake" }, [note], [model]), null);
    }
  } finally {
    setActiveLocale(previous);
  }
});

test("a published default voice prefills a required selection without naming the provider", () => {
  const model = config("audio", "glm-tts", {
    inputRules: { profile: "zhipu-speech", allowedKinds: [], maxImages: 0, maxVideos: 0, maxAudios: 0,
      videoModes: [], voiceRequired: true, referencesAllowed: false, defaultVoice: "tongtong" },
  });
  const settings = { ...newNodeGenerationSettings("audio", [model]), prompt: "Read this text." };
  assert.equal(settings.voiceName, "tongtong");
  // A library selection always wins over the published default.
  const chosen = { ...settings, voiceName: "b7f05169-b935-522f-9b0a-b49336783d42" };
  assert.equal(serviceAudioSettings(chosen, model).voiceName, "b7f05169-b935-522f-9b0a-b49336783d42");
  // The same profile without a published default must not invent one.
  const { defaultVoice, ...withoutDefault } = model.inputRules;
  assert.equal(newNodeGenerationSettings("audio", [{ ...model, inputRules: withoutDefault }]).voiceName, undefined);
});

test("MOSS speech prefills a valid Voice ID and preserves selected or cleared voices", () => {
  const model = config("audio", "moss-tts-1.5-flash", {
    inputRules: { profile: "moss-speech", allowedKinds: [], maxImages: 0,
      maxVideos: 0, maxAudios: 0, videoModes: [], voiceRequired: true, referencesAllowed: false },
  });
  const settings = { ...newNodeGenerationSettings("audio", [model]), prompt: "Read this text." };
  assert.equal(settings.voiceName, "2890a3a4-0012-4997-a545-8b045fe83bbe");
  assert.equal(backendBlocker(settings, [], [model]), null);
  const voiceName = "7b6d1cef-9d2b-431d-b963-345678901234";
  assert.equal(serviceGenerationSettings({ ...settings, voiceName }, model, [], true).voiceName, voiceName);
  const cleared = { ...settings, voiceName: undefined };
  assert.equal(serviceGenerationSettings(cleared, model).voiceName, undefined);
  assert.equal(serviceAudioSettings(cleared, model).voiceName, undefined);
  const otherSpeech = { ...model, inputRules: { ...model.inputRules, profile: "other-speech" } };
  assert.equal(newNodeGenerationSettings("audio", [otherSpeech]).voiceName, undefined);
  const previous = getActiveLocale();
  try {
    for (const locale of ["zh-CN", "en-US"] as const) {
      setActiveLocale(locale);
      for (const invalid of [undefined, "", " ", "invalid voice"]) {
        assert.equal(backendBlocker({ ...settings, voiceName: invalid }, [], [model]),
          translate(locale, "errors.rules.voiceRequired"));
      }
      assert.equal(backendBlocker({ ...settings, voiceName }, [], [model]), null);
      assert.equal(serviceVoice({ voiceName }), voiceName);
      for (const source of [createNode("text", undefined, { text: "Unsent context" }), createNode("image")]) {
        assert.equal(backendBlocker({ ...settings, voiceName }, [source], [model]),
          translate(locale, "errors.rules.referencesUnsupported"));
      }
    }
    const optional = { ...model, inputRules: { ...model.inputRules, voiceRequired: undefined, referencesAllowed: undefined } };
    assert.equal(backendBlocker(settings, [], [optional]), null);
  } finally {
    setActiveLocale(previous);
  }
});


test("Flash publishes only 720P, 3–20 seconds and rejects a last frame", () => {
  const flash = config("video", "kling-4.0-flash", {
    protocol: "kling_video", connectionType: "api", authMode: "bearer",
    inputRules: { profile: "kling-official", allowedKinds: ["text", "image"], maxImages: 10,
      maxVideos: 0, maxAudios: 0, videoModes: ["first_frame", "reference"], frameRoles: ["first_frame"],
      generateAudioOptions: [true], aspectRatios: ["21:9", "16:9", "9:16", "1:1"], outputResolutions: ["720P"],
      videoCapabilities: { outputs: [{ resolution: "720P", durations: Array.from({ length: 18 }, (_, index) => index + 3) }],
        defaultResolution: "720P", defaultDuration: 5, dimensionStep: 2 } },
  });
  const settings = serviceGenerationSettings({ ...generationDefaults("video"), modelConfigId: flash.id,
    prompt: "Flash test", resolution: "1080P", durationSeconds: 30 }, flash);
  assert.equal(settings.resolution, "720P");
  assert.equal(settings.durationSeconds, 5);
  assert.deepEqual(backendDurations(flash), Array.from({ length: 18 }, (_, index) => index + 3));
  assert.deepEqual(backendResolutions(settings, flash), ["auto", "720P"]);
  assert.ok(backendBlocker({ ...settings, videoMode: "first-last", lastFrameNodeId: "tail" }, [], [flash]));
});
