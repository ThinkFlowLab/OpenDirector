import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_PRESETS, matchingConnections, providerOptions, providerPresetFor } from "../src/canvas/providerPresets.ts";
import type { ModelConfig } from "../src/backend/rules.ts";
import { modelDescription } from "../src/canvas/modelDescriptions.ts";
import { getActiveLocale, setActiveLocale } from "../src/i18n/messages.ts";

test("provider presets separate official protocol from self-hosted model names", () => {
  const official = PROVIDER_PRESETS.find((item) => item.id === "minimax-video")!;
  assert.equal(official.url, "https://api.minimax.cn/v2");
  assert.equal(official.protocol, "minimax_video_v2");
  assert.equal(official.authMode, "bearer");
  assert.deepEqual(official.modelsByKind?.video, ["MiniMax-H3", "MiniMax-H3-Highspeed", "MiniMax-H3-Lite", "MiniMax-H3-Max"]);
  const model: ModelConfig = { ...official, id: "one", kind: "video", modelId: "MiniMax-H3", inputRules: { profile: "", allowedKinds: [], maxImages: 0, maxVideos: 0, maxAudios: 0, videoModes: [] } };
  assert.equal(providerPresetFor(model), "minimax-video");
  assert.equal(providerPresetFor({ ...model, connectionType: "self_hosted", protocol: "vllm_omni" }), "vllm-omni-video");
  assert.deepEqual(matchingConnections([{ ...model, providerId: "shared" }, { ...model, id: "two", providerId: "shared" }, { ...model, id: "three", providerId: "other" }], "video", { ...model, protocol: "minimax_video_v2", authMode: "bearer", apiKey: "" }).map((item) => item.id), ["one", "three"]);
});

test("MOSS presets offer the supported image and speech models by kind", () => {
  const preset = PROVIDER_PRESETS.find((item) => item.id === "moss");
  assert.ok(preset);
  assert.equal(preset.url, "https://api.mosi.cn/v1");
  assert.equal(preset.protocol, "openai");
  assert.equal(preset.connectionType, "api");
  assert.equal(preset.authMode, "bearer");
  assert.equal(preset.logoOrganization, "OpenMOSS-Team");
  assert.deepEqual(preset.kinds, ["image", "audio"]);
  assert.deepEqual(preset.modelsByKind, {
    image: ["moss-image-sft-1.0", "moss-image-base-1.0"],
    audio: ["moss-tts-1.5-flash", "moss-tts-1.0-pro", "moss-tts-1.5-flash-2026-06-26", "moss-tts-1.0-pro-2026-02-07"],
  });
  assert.ok(providerOptions("image").some((item) => item.id === "moss"));
  assert.ok(providerOptions("audio").some((item) => item.id === "moss"));
  for (const kind of ["agent", "video", "vision"] as const)
    assert.ok(!providerOptions(kind).some((item) => item.id === "moss"));
});

test("Kling is an optional official video service with a stable connection region", () => {
  const preset = PROVIDER_PRESETS.find((item) => item.id === "kling-video");
  assert.ok(preset);
  assert.deepEqual(preset.kinds, ["video"]);
  assert.deepEqual(preset.modelsByKind, { video: ["kling-4.0", "kling-4.0-flash"] });
  assert.equal(preset.protocol, "kling_video");
  assert.equal(preset.url, "https://api-beijing.klingai.com");
  assert.equal(preset.authMode, "bearer");
  const previous = getActiveLocale();
  try {
    for (const [locale, label] of [["zh-CN", "可灵官方视频"], ["en-US", "Kling official video"]] as const) {
      setActiveLocale(locale);
      assert.equal(providerOptions("video").find((item) => item.id === preset.id)?.name, label);
      assert.equal(preset.url, "https://api-beijing.klingai.com");
    }
    const model: ModelConfig = { ...preset, id: "kling", kind: "video", modelId: "kling-4.0",
      inputRules: { profile: "kling-official", allowedKinds: ["text", "image"], maxImages: 10, maxVideos: 0, maxAudios: 0, videoModes: ["first_frame", "reference"] } };
    assert.equal(providerPresetFor({ ...model, url: "https://api-singapore.klingai.com" }), preset.id);
  } finally { setActiveLocale(previous); }
});

test("MOSS provider labels follow the display language", () => {
  const previous = getActiveLocale();
  try {
    setActiveLocale("zh-CN");
    assert.equal(providerOptions("image").find((item) => item.id === "moss")?.name, "MOSS 开放平台");
    assert.equal(providerOptions("audio").find((item) => item.id === "moss")?.name, "MOSS 开放平台");
    setActiveLocale("en-US");
    assert.equal(providerOptions("image").find((item) => item.id === "moss")?.name, "MOSS Open Platform");
    assert.equal(providerOptions("audio").find((item) => item.id === "moss")?.name, "MOSS Open Platform");
  } finally {
    setActiveLocale(previous);
  }
});

test("a saved MOSS image connection reopens with its provider identity", () => {
  const preset = PROVIDER_PRESETS.find((item) => item.id === "moss");
  assert.ok(preset);
  for (const modelId of ["moss-image-sft-1.0", "moss-image-base-1.0"]) {
    const model: ModelConfig = {
      ...preset, id: "saved-moss", kind: "image", modelId,
      url: `${preset.url}/`,
      inputRules: { profile: "moss-image", allowedKinds: ["text"], maxImages: 0,
        maxVideos: 0, maxAudios: 0, videoModes: [], maxPromptCharacters: 4000 },
    };
    assert.equal(providerPresetFor(model), "moss");
    assert.equal(providerPresetFor({ ...model, kind: "agent" }), "custom");
    assert.equal(providerPresetFor({ ...model, url: "https://other.test/v1" }), "custom");
  }
});

test("saved MOSS image and audio connections share one provider brand", () => {
  const preset = PROVIDER_PRESETS.find((item) => item.id === "moss");
  assert.ok(preset);
  for (const kind of ["image", "audio"] as const) {
    for (const modelId of preset.modelsByKind?.[kind] ?? []) {
      const model: ModelConfig = {
        ...preset, id: `saved-moss-${kind}`, kind, modelId,
        inputRules: { profile: kind === "audio" ? "moss-speech" : "moss-image", allowedKinds: [], maxImages: 0,
          maxVideos: 0, maxAudios: 0, videoModes: [] },
      };
      assert.equal(providerPresetFor(model), "moss");
      assert.equal(providerOptions(kind).find((item) => item.id === "moss")?.logoOrganization, "OpenMOSS-Team");
    }
  }
});


test("Kling Flash descriptions distinguish first-frame capabilities in both languages", () => {
  const previous = getActiveLocale();
  try {
    const model = { protocol: "kling_video", modelId: "kling-4.0-flash" };
    setActiveLocale("en-US");
    assert.match(modelDescription(model)!, /720P.*first-frame.*3–20/);
    assert.doesNotMatch(modelDescription(model)!, /last/);
    setActiveLocale("zh-CN");
    assert.match(modelDescription(model)!, /720P.*首帧.*3–20/);
    assert.doesNotMatch(modelDescription(model)!, /尾帧/);
  } finally { setActiveLocale(previous); }
});

test("MiniMax H3 image preset exposes both models in both display languages", () => {
  const previous = getActiveLocale();
  try {
    const preset = PROVIDER_PRESETS.find((item) => item.id === "minimax-image")!;
    assert.equal(preset.url, "https://api.minimax.cn/v1");
    assert.deepEqual(preset.modelsByKind?.image, ["MiniMax-H3-Image", "MiniMax-H3-Image-Highspeed"]);
    for (const [locale, name] of [
      ["zh-CN", "MiniMax 官方图片"], ["en-US", "MiniMax Official Images"],
    ] as const) {
      setActiveLocale(locale);
      assert.equal(providerOptions("image").find((item) => item.id === preset.id)?.name, name);
    }
  } finally {
    setActiveLocale(previous);
  }
});
