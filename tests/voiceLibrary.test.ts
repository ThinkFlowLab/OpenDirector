import assert from "node:assert/strict";
import test from "node:test";
import type { ModelConfig } from "../src/backend/rules.ts";
import {
  backendBlocker,
  serviceConnectionId,
  serviceGenerationSettings,
} from "../src/backend/rules.ts";
import {
  isVoiceFavorite,
  readVoiceFavorites,
  toggleVoiceFavorite,
  writeVoiceFavorites,
} from "../src/canvas/voiceFavorites.ts";
import { generationDefaults } from "../src/canvas/generationCatalog.ts";

const library = {
  provider: "vllm-omni" as const,
  canCreate: true,
  canDelete: true,
  requiresConsent: true,
  requiresRefText: false,
  maxBytes: 10 * 1024 * 1024,
  maxDurationSeconds: null,
  formats: ["wav", "mp3"],
  pagination: "none" as const,
  preview: false,
};

function model(id: string, providerId?: string, overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id,
    providerId,
    kind: "audio",
    url: "http://127.0.0.1:8000/v1",
    modelId: id,
    connectionType: "self_hosted",
    protocol: "openai",
    authMode: "none",
    inputRules: {
      profile: "tts", allowedKinds: [], maxImages: 0, maxVideos: 0,
      maxAudios: 0, videoModes: [], voiceRequired: true, voiceLibrary: library,
    },
    ...overrides,
  };
}

function settings() {
  return {
    ...generationDefaults("audio"),
    audioMode: "tts" as const,
    modelConfigId: "a",
    prompt: "Read this.",
    voiceName: "voice-one",
    voiceConnectionId: "provider-a",
    voiceProvider: "vllm-omni" as const,
    voiceHasReference: true,
  };
}

test("a voice survives a model change within one service connection", () => {
  const first = model("a", "provider-a");
  const second = model("b", "provider-a");
  assert.equal(serviceConnectionId(first), "provider-a");
  const next = serviceGenerationSettings(
    { ...settings(), modelConfigId: second.id },
    second,
    [],
    true,
  );
  assert.equal(next.voiceName, "voice-one");
  assert.equal(next.voiceConnectionId, "provider-a");
});

test("a voice is cleared when the connection or adapter changes", () => {
  const second = model("b", "provider-b");
  assert.equal(
    serviceGenerationSettings({ ...settings(), modelConfigId: second.id }, second, [], true)
      .voiceName,
    undefined,
  );
  const moss = model("m", "provider-a", {
    inputRules: { ...model("a", "provider-a").inputRules, voiceLibrary: { ...library, provider: "moss", canDelete: false } },
  });
  assert.equal(
    serviceGenerationSettings({ ...settings(), modelConfigId: moss.id }, moss, [], true)
      .voiceName,
    undefined,
  );
});

test("a model requiring a transcript clears a voice without reference data", () => {
  const strict = model("drama-3", "provider-a", {
    inputRules: { ...model("a", "provider-a").inputRules, voiceLibrary: { ...library, requiresRefText: true } },
  });
  assert.equal(
    serviceGenerationSettings({ ...settings(), voiceHasReference: false }, strict, [], true)
      .voiceName,
    undefined,
  );
  const kept = serviceGenerationSettings(
    { ...settings(), voiceHasReference: true },
    strict,
    [],
    true,
  );
  assert.equal(kept.voiceName, "voice-one");
});

test("generation blocks a voice that belongs to another connection", () => {
  const config = model("a", "provider-a");
  assert.ok(backendBlocker({ ...settings(), voiceConnectionId: "provider-b" }, [], [config]));
  assert.equal(backendBlocker(settings(), [], [config]), null);
});

test("favorites are scoped by connection, provider, and voice id", () => {
  const stored = new Map<string, string>();
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      stored.set(key, value);
    },
  };
  const one = { connectionId: "a", provider: "vllm-omni" as const, voiceId: "voice" };
  const two = { connectionId: "b", provider: "vllm-omni" as const, voiceId: "voice" };
  const values = toggleVoiceFavorite(one, []);
  assert.equal(isVoiceFavorite(one, values), true);
  assert.equal(isVoiceFavorite(two, values), false);
  writeVoiceFavorites(values, storage);
  assert.deepEqual(readVoiceFavorites(storage), [one]);
  const removed = toggleVoiceFavorite(one, values);
  assert.deepEqual(removed, []);
});
