import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CreationClient,
  type CreationOperation,
} from "../src/backend/creationClient.ts";
import { CreationProjection } from "../src/backend/creationProjection.ts";
import {
  backendAspectRatios,
  backendBlocker,
  backendResolutions,
  serviceGenerationSettings,
  type ModelConfig,
} from "../src/backend/rules.ts";
import { generationDefaults } from "../src/canvas/generationCatalog.ts";
import type {
  ProjectSnapshot,
  GenerationSpec,
  CanvasItem,
} from "../src/contracts/generated.ts";

const cases = [
  {
    kind: "image",
    parameters: {
      size: "1536x1024",
      aspectRatio: "3:2",
      preset: "none",
      responseFormat: "url",
      outputFormat: "png",
    },
    patch: { aspectRatio: "2:3", resolution: "1024x1536" },
    expected: { size: "1024x1536", aspectRatio: "2:3" },
  },
  {
    kind: "video",
    parameters: {
      videoMode: "first_frame",
      durationSeconds: 8,
      aspectRatio: "9:16",
      resolution: "auto",
      generateAudio: false,
    },
    patch: { durationSeconds: 5, audioEnabled: true },
    expected: { durationSeconds: 5, generateAudio: true },
  },
  {
    kind: "audio",
    parameters: { voice: "voice-1", creationType: "audio", mode: "tts" },
    patch: { voiceName: "voice_2" },
    expected: { voice: "voice_2" },
  },
  {
    kind: "audio",
    parameters: {
      voice: null,
      creationType: "music",
      mode: "tts",
      lyrics: "[verse]\n雨落在窗前",
      durationSeconds: 45,
    },
    patch: { lyrics: "", durationSeconds: 120 },
    expected: { creationType: "music", lyrics: "", durationSeconds: 120 },
  },
] as const;
for (const scenario of cases)
  test(`${scenario.kind}${"creationType" in scenario.parameters ? ` (${scenario.parameters.creationType})` : ""}: saved parameters reopen, edit and submit from the same spec`, async () => {
    const base = JSON.parse(
      readFileSync(
        new URL("./fixtures/creation-project.json", import.meta.url),
        "utf8",
      ),
    ) as ProjectSnapshot;
    const original = base.canvasItems.find(
      (i) => i.kind === "image" && i.binding.role === "generation",
    )!;
    const spec = {
      ...base.generationSpecs.find((s) => s.kind === "image")!,
      kind: scenario.kind,
      currentResultId: null,
      parameters: scenario.parameters,
    } as GenerationSpec;
    const item = {
      ...original,
      kind: scenario.kind,
      binding: {
        role: "generation",
        materialOverride: null,
        objectRef: { objectType: "generation_spec", id: spec.id },
      },
      editors: [],
    } as CanvasItem;
    const snapshot = {
      ...base,
      canvasItems: [item],
      generationSpecs: [spec],
      assets: [],
      references: [],
      editorDocuments: [],
      jobs: [],
      results: [],
    };
    const client = new CreationClient(base.project.id);
    client.install(snapshot);
    client.view = async () => ({
      projectId: client.id,
      clientId: crypto.randomUUID(),
      viewport: { x: 0, y: 0, zoom: 1 },
      selectedItemIds: [],
      activeEditorId: null,
      playheads: [],
      generationCounts: { [item.id]: 3 },
    });
    const batches: CreationOperation[][] = [];
    client.batch = async (operations) => {
      batches.push(operations);
      return undefined;
    };
    const projection = new CreationProjection(client);
    const restored = await projection.read();
    const settings = restored.nodes[0]!.data.settings!;
    assert.equal(
      settings.count,
      3,
      "batch count is view state, not per-job execution",
    );
    assert.equal(settings.modelConfigId, spec.modelConfigId);
    if (scenario.kind === "image") {
      assert.equal(settings.aspectRatio, "3:2");
      assert.equal(settings.resolution, "1536x1024");
    }
    if (scenario.kind === "video") {
      assert.equal(settings.videoMode, "first-last");
      assert.equal(settings.aspectRatio, "9:16");
      assert.equal(settings.audioEnabled, false);
      assert.equal(settings.resolution, "自动");
      assert.equal(settings.frameSlotsInitialized, true);
    }
    if (
      scenario.kind === "audio" &&
      scenario.parameters.creationType === "audio"
    ) {
      assert.equal(settings.voiceName, "voice-1");
      assert.equal(settings.audioMode, "tts");
    }
    if (
      scenario.kind === "audio" &&
      scenario.parameters.creationType === "music"
    ) {
      assert.equal(settings.audioCreationType, "music");
      assert.equal(settings.lyrics, "[verse]\n雨落在窗前");
      assert.equal(settings.durationSeconds, 45);
    }
    projection.baseline = restored;
    projection.basis = snapshot;
    const next = structuredClone(restored);
    Object.assign(next.nodes[0]!.data.settings!, scenario.patch);
    await projection.save(next);
    const update = batches
      .flat()
      .find((op) => op.type === "generationSpec.update");
    assert.ok(update && update.type === "generationSpec.update");
    for (const [key, value] of Object.entries(scenario.expected))
      assert.equal(
        (update.payload.spec.parameters as Record<string, unknown>)[key],
        value,
      );
    assert.equal(update.payload.spec.id, spec.id);
    assert.equal(update.payload.spec.modelConfigId, spec.modelConfigId);
  });

test("image controls and validation derive from declared protocol output choices", () => {
  const config: ModelConfig = {
    id: crypto.randomUUID(),
    kind: "image",
    url: "http://fixture.invalid/v1",
    modelId: "fixture",
    protocol: "openai",
    connectionType: "self_hosted",
    authMode: "none",
    inputRules: {
      profile: "compatible",
      allowedKinds: ["text", "image"],
      maxImages: 8,
      maxVideos: 0,
      maxAudios: 0,
      videoModes: [],
      imageOutputs: [
        { aspectRatio: "1:1", size: "1024x1024" },
        { aspectRatio: "3:2", size: "1536x1024" },
      ],
    },
  };
  const settings = serviceGenerationSettings(
    {
      ...generationDefaults("image"),
      prompt: "test",
      modelConfigId: config.id,
      aspectRatio: "16:9",
    },
    config,
    [],
    true,
  );
  assert.equal(settings.aspectRatio, "自动");
  assert.equal(settings.resolution, "自动");
  assert.equal(backendBlocker(settings, [], [config]), null);
  assert.deepEqual(backendAspectRatios(settings, config), [
    "自动",
    "1:1",
    "3:2",
  ]);
  assert.deepEqual(
    backendResolutions({ ...settings, aspectRatio: "3:2" }, config),
    ["自动", "1536x1024"],
  );
  assert.match(
    backendBlocker({ ...settings, aspectRatio: "16:9" }, [], [config])!,
    /不支持/,
  );
  const changed = serviceGenerationSettings(
    { ...settings, aspectRatio: "1:1", resolution: "1536x1024" },
    config,
  );
  assert.equal(changed.resolution, "自动");
});

test("an audio node composes with a music model and reads aloud with a speech model", () => {
  const audioConfig = (protocol: ModelConfig["protocol"]): ModelConfig => ({
    id: crypto.randomUUID(),
    kind: "audio",
    url: "http://127.0.0.1:8240/v1",
    modelId: protocol === "vllm_omni_music" ? "m-a-p/YuE2-3B" : "tts",
    connectionType: "self_hosted",
    protocol,
    authMode: "none",
    inputRules: {
      profile: protocol === "vllm_omni_music" ? "vllm-omni-music" : "tts",
      allowedKinds: [],
      maxImages: 0,
      maxVideos: 0,
      maxAudios: 0,
      videoModes: [],
    } as unknown as ModelConfig["inputRules"],
  });
  const music = audioConfig("vllm_omni_music");
  const speech = audioConfig("openai");
  const reading = {
    ...generationDefaults("audio"),
    modelConfigId: speech.id,
    audioMode: "tts" as const,
    prompt: "温暖的钢琴与弦乐",
  };
  const composing = serviceGenerationSettings(
    { ...reading, modelConfigId: music.id },
    music,
    [],
    true,
  );
  // Speech nodes keep their 5 s default, which is no valid music length.
  assert.equal(composing.audioCreationType, "music");
  assert.equal(composing.durationSeconds, 30);
  assert.equal(backendBlocker(composing, [], [music, speech]), null);
  assert.match(
    backendBlocker({ ...composing, prompt: " " }, [], [music])!,
    /音乐风格/,
  );
  assert.match(
    backendBlocker({ ...composing, durationSeconds: 400 }, [], [music])!,
    /8–360/,
  );
  assert.match(
    backendBlocker({ ...composing, audioCreationType: "audio" }, [], [music])!,
    /音乐生成/,
  );
  const back = serviceGenerationSettings(
    { ...composing, modelConfigId: speech.id },
    speech,
    [],
    true,
  );
  assert.equal(back.audioCreationType, "audio");
  assert.equal(backendBlocker(back, [], [speech]), null);
});
