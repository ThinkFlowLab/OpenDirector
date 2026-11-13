import assert from "node:assert/strict";
import test from "node:test";
import {
  backendBlocker,
  serviceGenerationSettings,
  type ModelConfig,
} from "../src/backend/rules.ts";
import { generationDefaults } from "../src/canvas/generationCatalog.ts";
import { createVoice, voiceIssue } from "../src/backend/voices.ts";
import {
  copyGenerationSettings,
  isGenerationSettings,
} from "../src/canvas/dataBoundary.ts";
import { getNodeGenerationSettings } from "../src/canvas/generationSettings.ts";
import { createNode } from "../src/canvas/model.ts";

test("voice registration keeps all upload data in the multipart body", async (test) => {
  const fields = {
    name: "Narrator", connectionId: "sample-connection", consent: "sample-consent-id",
    refText: "Sample transcript", speakerDescription: "Sample description",
  };
  const file = new File(["sample audio"], "sample.wav", { type: "audio/wav" });
  const send = test.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "/api/voices?modelConfigId=model-1");
    assert.equal(new Headers(options.headers).has("Content-Type"), false);
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get("audio_sample"), file);
    for (const [name, value] of Object.entries(fields)) assert.equal(options.body.get(name), value);
    return Response.json({ voiceId: "server-id" });
  });
  assert.equal((await createVoice("model-1", file, fields)).voiceId, "server-id");
  assert.equal(send.mock.callCount(), 1);
});

const selection = {
  connectionId: "service-a",
  voiceId: "Alice",
  source: "uploaded" as const,
  name: "Alice",
  hasReferenceAudio: true,
  embeddingDim: null,
  refText: "Hello.",
};
const config: ModelConfig = {
  id: "model-a",
  kind: "audio",
  modelId: "MOSS-TTS",
  url: "http://localhost:8000/v1",
  connectionType: "self_hosted",
  protocol: "openai",
  authMode: "none",
  inputRules: {
    profile: "tts",
    allowedKinds: [],
    maxImages: 0,
    maxVideos: 0,
    maxAudios: 0,
    videoModes: [],
    voiceLibrary: {
      provider: "vllm_omni",
      connectionId: "service-a",
      requiresTranscript: false,
      acceptsTranscript: true,
      requiresReferenceAudio: false,
      canDelete: true,
      supportsUploadedVoices: true,
      referenceEmbeddingDimension: null,
      maxBytes: 1000000,
      formats: ["wav"],
      minSeconds: null,
      maxSeconds: null,
    },
  },
};
const settings = {
  ...generationDefaults("audio"),
  modelConfigId: config.id,
  audioCreationType: "audio" as const,
  audioMode: "tts" as const,
  prompt: "Hello world",
  voiceName: "Alice",
  voiceSelection: selection,
};

test("switching speech models retains only a compatible connection-scoped voice", () => {
  const next = serviceGenerationSettings(
    settings,
    { ...config, modelId: "Another-TTS" },
    [],
    true,
  );
  assert.deepEqual(next.voiceSelection, selection);
  assert.equal(next.voiceName, "Alice");
  const other = serviceGenerationSettings(
    settings,
    {
      ...config,
      inputRules: {
        ...config.inputRules,
        voiceLibrary: {
          ...config.inputRules.voiceLibrary!,
          connectionId: "service-b",
        },
      },
    },
    [],
    true,
  );
  assert.equal(other.voiceName, undefined);
  assert.equal(other.voiceSelection, undefined);
});

test("a changed endpoint/account cannot silently use the previous voice without switching models", () => {
  const changed = {
    ...config,
    inputRules: {
      ...config.inputRules,
      voiceLibrary: {
        ...config.inputRules.voiceLibrary!,
        connectionId: "changed-account",
      },
    },
  };
  assert.ok(backendBlocker(settings, [], [changed]));
  assert.equal(backendBlocker(settings, [], [config]), null);
});

test("Drama3 requires stored transcript and Nano does not treat default as reference audio", () => {
  const drama = {
    ...config,
    inputRules: {
      ...config.inputRules,
      voiceLibrary: {
        ...config.inputRules.voiceLibrary!,
        requiresTranscript: true,
      },
    },
  };
  assert.ok(
    backendBlocker(
      { ...settings, voiceSelection: { ...selection, refText: null } },
      [],
      [drama],
    ),
  );
  assert.equal(backendBlocker(settings, [], [drama]), null);
  const nano = {
    ...config,
    inputRules: {
      ...config.inputRules,
      voiceLibrary: {
        ...config.inputRules.voiceLibrary!,
        requiresReferenceAudio: true,
      },
    },
  };
  assert.ok(
    backendBlocker(
      {
        ...settings,
        voiceName: "default",
        voiceSelection: {
          ...selection,
          voiceId: "default",
          hasReferenceAudio: false,
        },
      },
      [],
      [nano],
    ),
  );
  assert.ok(
    backendBlocker(
      { ...settings, voiceName: "default", voiceSelection: undefined },
      [],
      [nano],
    ),
  );
});

test("voice identity survives the canvas boundary with an independent copy", () => {
  const copy = copyGenerationSettings(settings);
  assert.deepEqual(copy.voiceSelection, selection);
  assert.notEqual(copy.voiceSelection, selection);
  assert.equal(isGenerationSettings(settings), true);
  assert.equal(
    isGenerationSettings({ ...settings, voiceSelection: { voiceId: "Alice" } }),
    false,
  );
});

test("an upload transcript requirement permits plain speech and the default voice", () => {
  const capabilities = {
    ...config.inputRules.voiceLibrary!,
    requiresTranscript: true,
  };
  const plain = {
    ...selection,
    source: "builtin" as const,
    voiceId: "default",
    hasReferenceAudio: false,
    refText: null,
  };
  assert.equal(voiceIssue(undefined, capabilities), null);
  assert.equal(voiceIssue(plain, capabilities), null);
  assert.equal(
    voiceIssue({ ...selection, refText: null }, capabilities),
    "voiceLibrary.transcriptRequired",
  );
  assert.equal(voiceIssue(selection, capabilities), null);
});

test("scoped provider names are not coerced into legacy ASCII identifiers", () => {
  const value = {
    ...settings,
    voiceName: "我的音色",
    voiceSelection: { ...selection, voiceId: "我的音色", name: "我的音色" },
  };
  assert.equal(backendBlocker(value, [], [config]), null);
  assert.equal(
    serviceGenerationSettings(value, config, [], true).voiceName,
    "我的音色",
  );
});

test("uploaded voices cannot follow a switch to CustomVoice and direct embeddings must match Base dimensions", () => {
  const custom = {
    ...config,
    inputRules: {
      ...config.inputRules,
      voiceLibrary: {
        ...config.inputRules.voiceLibrary!,
        supportsUploadedVoices: false,
      },
    },
  };
  assert.ok(backendBlocker(settings, [], [custom]));
  assert.equal(
    serviceGenerationSettings(settings, custom, [], true).voiceSelection,
    undefined,
  );
  const base = {
    ...config,
    inputRules: {
      ...config.inputRules,
      voiceLibrary: {
        ...config.inputRules.voiceLibrary!,
        requiresReferenceAudio: true,
        referenceEmbeddingDimension: 1024,
      },
    },
  };
  const direct = {
    ...settings,
    voiceSelection: {
      ...selection,
      hasReferenceAudio: false,
      embeddingDim: 1024,
    },
  };
  assert.equal(backendBlocker(direct, [], [base]), null);
  assert.ok(
    backendBlocker(
      direct,
      [],
      [
        {
          ...base,
          inputRules: {
            ...base.inputRules,
            voiceLibrary: {
              ...base.inputRules.voiceLibrary!,
              referenceEmbeddingDimension: 2048,
            },
          },
        },
      ],
    ),
  );
});

test("direct embeddings report the same incompatibility as the voice registry", () => {
  const capabilities = {
    ...config.inputRules.voiceLibrary!,
    requiresReferenceAudio: true,
    requiresTranscript: true,
    referenceEmbeddingDimension: 1024,
  };
  const direct = { ...selection, hasReferenceAudio: false, refText: null };
  assert.equal(
    voiceIssue({ ...direct, embeddingDim: 2048 }, capabilities),
    "voiceLibrary.modelUnsupported",
  );
  assert.equal(voiceIssue(direct, capabilities), "voiceLibrary.referenceRequired");
  assert.equal(
    voiceIssue({ ...direct, embeddingDim: 1024 }, capabilities),
    "voiceLibrary.transcriptRequired",
  );
  assert.equal(
    voiceIssue({ ...selection, embeddingDim: 2048 }, capabilities),
    null,
  );
});

test("a model that lost its voice library cannot strand a node on the old voice", () => {
  // The operator edited this same model config into a plain OpenAI-compatible
  // TTS, so the node keeps its modelId but the capability is gone. The composer
  // only offers the library while that capability exists, so a stored selection
  // would block generation with no control left to replace it.
  const withoutLibrary = {
    ...config,
    inputRules: {
      ...config.inputRules,
      voiceLibrary: undefined,
    },
  };
  assert.ok(
    backendBlocker(settings, [], [withoutLibrary]),
    "the raw settings are blocked on a voice the model cannot use",
  );
  const serviced = serviceGenerationSettings(settings, withoutLibrary, [], false);
  assert.equal(serviced.voiceSelection, undefined);
  assert.equal(serviced.voiceName, undefined);
  assert.equal(backendBlocker(serviced, [], [withoutLibrary]), null);
});

test("a model that keeps its voice library still retains the stored selection", () => {
  const serviced = serviceGenerationSettings(settings, config, [], false);
  assert.deepEqual(serviced.voiceSelection, selection);
  assert.equal(serviced.voiceName, "Alice");
  assert.equal(backendBlocker(serviced, [], [config]), null);
});

/** The composer reads a node through here, so this is the boundary that decides
 * what the blocker and the run both see after a model configuration changes. */
function readSettings(models: readonly ModelConfig[]) {
  const node = createNode("audio", { x: 0, y: 0 });
  return getNodeGenerationSettings(
    { ...node, data: { ...node.data, settings } },
    models,
  );
}

test("reopening a node on a model without the voice library drops the stored voice", () => {
  const withoutLibrary = {
    ...config,
    inputRules: { ...config.inputRules, voiceLibrary: undefined },
  };
  const read = readSettings([withoutLibrary]);
  assert.equal(read.voiceSelection, undefined);
  assert.equal(read.voiceName, undefined);
  assert.equal(voiceIssue(read.voiceSelection, undefined), null);
});

test("reopening a node on a model that keeps the library still reads its voice", () => {
  const read = readSettings([config]);
  assert.deepEqual(read.voiceSelection, selection);
  assert.equal(read.voiceName, "Alice");
});
