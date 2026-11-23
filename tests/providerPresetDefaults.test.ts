import assert from "node:assert/strict";
import test from "node:test";
import { servicePresetDefaults } from "../src/canvas/providerPresets.ts";

test("default OpenAI compatible preset uses API connection and bearer auth", () => {
  const defaults = servicePresetDefaults("custom", "openai");
  assert.equal(defaults.url, "https://api.openai.com/v1");
  assert.equal(defaults.protocol, "openai");
  assert.equal(defaults.connectionType, "api");
  assert.equal(defaults.authMode, "bearer");
});

test("self-hosted vLLM-Omni defaults keep self_hosted connection and optional auth", () => {
  for (const [presetId, fallback, expectedProtocol] of [
    ["vllm-omni-image", "openai", "openai"],
    ["vllm-omni-video", "vllm_omni", "vllm_omni"],
    ["vllm-omni-speech", "openai", "openai"],
    ["vllm-omni-music", "vllm_omni_music", "vllm_omni_music"],
  ] as const) {
    const defaults = servicePresetDefaults(presetId, fallback);
    assert.equal(defaults.url, "");
    assert.equal(defaults.protocol, expectedProtocol);
    assert.equal(defaults.connectionType, "self_hosted");
    assert.equal(defaults.authMode, "none");
  }
});
