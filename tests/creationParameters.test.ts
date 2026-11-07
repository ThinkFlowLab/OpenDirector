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
  hasMusicReference,
  isGenerationModel,
  serviceGenerationSettings,
  type ModelConfig,
} from "../src/backend/rules.ts";
import { generationDefaults } from "../src/canvas/generationCatalog.ts";
import { createNode } from "../src/canvas/model.ts";
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
    parameters: {
      voice: "voice-1",
      creationType: "audio",
      mode: "tts",
      voiceSelection: {
        connectionId: "connection-a",
        voiceId: "voice-1",
        source: "uploaded",
        name: "Narrator",
        hasReferenceAudio: true,
        embeddingDim: null,
        refText: "Hello",
      },
    },
    patch: { voiceName: "voice_2", voiceSelection: undefined },
    expected: { voice: "voice_2", voiceSelection: undefined },
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
      assert.equal(settings.resolution, "auto");
      assert.equal(settings.frameSlotsInitialized, true);
    }
    if (
      scenario.kind === "audio" &&
      scenario.parameters.creationType === "audio"
    ) {
      assert.equal(settings.voiceName, "voice-1");
      assert.deepEqual(
        settings.voiceSelection,
        scenario.parameters.voiceSelection,
      );
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
  assert.equal(settings.aspectRatio, "auto");
  assert.equal(settings.resolution, "auto");
  assert.equal(backendBlocker(settings, [], [config]), null);
  assert.deepEqual(backendAspectRatios(settings, config), [
    "auto",
    "1:1",
    "3:2",
  ]);
  assert.deepEqual(
    backendResolutions({ ...settings, aspectRatio: "3:2" }, config),
    ["auto", "1536x1024"],
  );
  assert.match(
    backendBlocker({ ...settings, aspectRatio: "16:9" }, [], [config])!,
    /不支持/,
  );
  const changed = serviceGenerationSettings(
    { ...settings, aspectRatio: "1:1", resolution: "1536x1024" },
    config,
  );
  assert.equal(changed.resolution, "auto");
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

test("a music node follows a connected recording only through YuE2 and a transcription model", () => {
  const audioConfig = (
    protocol: ModelConfig["protocol"],
    modelId: string,
    allowedKinds: string[],
  ): ModelConfig => ({
    id: crypto.randomUUID(),
    kind: "audio",
    url: "http://127.0.0.1:8240/v1",
    modelId,
    connectionType: "self_hosted",
    protocol,
    authMode: "none",
    inputRules: {
      profile:
        protocol === "vllm_omni_music" ? "vllm-omni-music" : "vllm-omni-score",
      allowedKinds,
      maxImages: 0,
      maxVideos: 0,
      maxAudios: allowedKinds.length,
      videoModes: [],
    } as unknown as ModelConfig["inputRules"],
  });
  const yue2 = audioConfig("vllm_omni_music", "m-a-p/YuE2-3B", ["audio"]);
  const minimax = audioConfig("vllm_omni_music", "MiniMax-Music3", []);
  const score = audioConfig("vllm_omni_score", "m-a-p/SheetSage2", []);
  const recording = createNode(
    "audio",
    { x: 0, y: 0 },
    { src: "data:audio/mpeg;base64,AA==", assetState: "ready" },
  );
  const settings = serviceGenerationSettings(
    {
      ...generationDefaults("audio"),
      modelConfigId: yue2.id,
      prompt: "爵士翻唱",
    },
    yue2,
    [],
    true,
  );
  assert.equal(isGenerationModel(score), false);
  assert.equal(hasMusicReference(settings, [], yue2), false);
  assert.equal(hasMusicReference(settings, [recording], yue2), true);
  // Without a reference the node composes from text alone, as before.
  assert.equal(backendBlocker(settings, [], [yue2]), null);
  assert.match(backendBlocker(settings, [recording], [yue2])!, /扒谱模型/);
  assert.equal(backendBlocker(settings, [recording], [yue2, score]), null);
  assert.equal(
    backendBlocker(
      { ...settings, scoreMode: "full" },
      [recording],
      [yue2, score],
    ),
    null,
  );
  assert.match(
    backendBlocker(
      { ...settings, modelConfigId: minimax.id },
      [recording],
      [minimax, score],
    )!,
    /不支持参照音乐/,
  );
  assert.match(
    backendBlocker({ ...settings, modelConfigId: score.id }, [], [score])!,
    /扒谱模型仅用于/,
  );
});

test("video audio controls and validation consume declared audio choices", () => {
  const config: ModelConfig = {
    id: crypto.randomUUID(), kind: "video", url: "https://fixture.invalid/v1",
    modelId: "fixture", protocol: "volcengine", connectionType: "api", authMode: "none",
    inputRules: { profile: "compatible", allowedKinds: ["text", "image"],
      maxImages: 8, maxVideos: 0, maxAudios: 0, videoModes: ["reference"], generateAudioOptions: [true] },
  };
  const settings = { ...generationDefaults("video"), modelConfigId: config.id,
    videoMode: "reference" as const, prompt: "test", audioEnabled: false };
  assert.equal(backendBlocker(settings, [], [config]), "当前视频适配器不支持关闭生成音频。");
  assert.equal(serviceGenerationSettings(settings, config, [], true).audioEnabled, true);
  const optional: ModelConfig = { ...config, inputRules: { ...config.inputRules, generateAudioOptions: [true, false] } };
  assert.equal(serviceGenerationSettings(settings, optional, [], true).audioEnabled, false);
  assert.notEqual(backendBlocker(settings, [], [optional]), "当前视频适配器不支持关闭生成音频。");
});

test("official H3 derives frame slots and output ratios from model capabilities", () => {
  const config: ModelConfig = {
    id: crypto.randomUUID(), kind: "video", url: "https://api.minimax.cn/v2", modelId: "MiniMax-H3",
    protocol: "minimax_video_v2", connectionType: "api", authMode: "bearer",
    inputRules: { profile: "minimax-h3-official", allowedKinds: ["text", "image", "video", "audio"],
      maxImages: 9, maxVideos: 3, maxAudios: 3, videoModes: ["first_frame", "reference"],
      frameRoles: ["first_frame", "last_frame"], aspectRatios: ["16:9", "9:16"],
      generateAudioOptions: [true], outputResolutions: ["768P", "2K"] },
  };
  const first = createNode("image", { x: 0, y: 0 });
  const last = createNode("image", { x: 500, y: 0 });
  for (const node of [first, last]) node.data.src = "data:image/png;base64,AA==";
  const settings = { ...generationDefaults("video"), modelConfigId: config.id, videoMode: "first-last" as const,
    firstFrameNodeId: first.id, lastFrameNodeId: last.id, resolution: "768P", durationSeconds: 5, prompt: "Animate" };
  assert.equal(backendBlocker(settings, [first, last], [config]), null);
  assert.deepEqual(backendAspectRatios({ ...settings, videoMode: "reference" }, config), ["auto", "16:9", "9:16"]);
  assert.deepEqual(backendAspectRatios(settings, config), ["auto"]);
  assert.match(backendBlocker(settings, [first], [config])!, /尾帧素材/);
  const local = { ...config, inputRules: { ...config.inputRules, frameRoles: null } };
  assert.match(backendBlocker(settings, [first, last], [local])!, /只支持首帧/);
});
