import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_PRESETS, matchingConnections, providerOptions, providerPresetFor } from "../src/canvas/providerPresets.ts";
import type { ModelConfig } from "../src/backend/rules.ts";
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
