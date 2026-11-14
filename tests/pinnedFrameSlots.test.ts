import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assetReference,
  CreationClient,
  type CreationOperation,
} from "../src/backend/creationClient.ts";
import { CreationProjection } from "../src/backend/creationProjection.ts";
import type {
  CanvasItem,
  GenerationSpec,
  ProjectSnapshot,
  Reference,
} from "../src/contracts/generated.ts";
import {
  applyCommand,
  createDocument,
  createNode,
  pruneFrameReferences,
  type CanvasDocument,
} from "../src/canvas/model.ts";
import {
  fillConnectedFrames,
  fillPinnedFrames,
  frameSlotPatch,
  frameSlotValue,
  PINNED_FRAME_PREFIX,
  pinnedFrameCandidates,
  swapFramePatch,
} from "../src/canvas/frameReferences.ts";
import { generationDefaults } from "../src/canvas/generationCatalog.ts";
import {
  copyGenerationSettings,
  isGenerationSettings,
} from "../src/canvas/dataBoundary.ts";
import { backendBlocker, type ModelConfig } from "../src/backend/rules.ts";

// #121: a video configuration that uses a fixed (pinned) asset as its first or
// last frame must show that asset in the frame slot, and slot edits and mode
// round trips must change the persisted reference role, not only the UI.

const base = JSON.parse(
  readFileSync(new URL("./fixtures/creation-project.json", import.meta.url), "utf8"),
) as ProjectSnapshot;
const images = base.assets.filter((asset) => asset.kind === "image");

function scenario(roles: Reference["role"][], videoMode = "first_frame") {
  const original = base.canvasItems.find(
    (item) => item.kind === "image" && item.binding.role === "generation",
  )!;
  const spec = {
    ...base.generationSpecs.find((s) => s.kind === "image")!,
    kind: "video",
    currentResultId: null,
    prompt: "",
    promptContent: null,
    parameters: {
      videoMode,
      durationSeconds: 5,
      aspectRatio: "16:9",
      resolution: "auto",
      generateAudio: false,
    },
  } as unknown as GenerationSpec;
  const item = {
    ...original,
    kind: "video",
    binding: {
      role: "generation",
      materialOverride: null,
      objectRef: { objectType: "generation_spec", id: spec.id },
    },
    editors: [],
  } as CanvasItem;
  const references = roles.map(
    (role, order) =>
      ({
        id: crypto.randomUUID(),
        revision: 1,
        projectId: base.project.id,
        targetSpecId: spec.id,
        binding: "pinned",
        source: assetReference(images[order]!),
        sourceVersion: null,
        subjectRole: null,
        order,
        role,
        active: true,
      }) as unknown as Reference,
  );
  let snapshot: ProjectSnapshot = {
    ...base,
    canvasItems: [item],
    generationSpecs: [spec],
    references,
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
    generationCounts: {},
  });
  const batches: CreationOperation[][] = [];
  client.batch = async (operations) => {
    batches.push(operations);
    // Apply the reference role edits and parameter changes so a later read
    // sees what the server would store.
    snapshot = {
      ...snapshot,
      eventCursor: snapshot.eventCursor + 1,
      references: snapshot.references.map((ref) => {
        const update = operations.find(
          (op) =>
            op.type === "reference.update" &&
            op.payload.reference.id === ref.id,
        );
        return update?.type === "reference.update"
          ? ({ ...ref, role: update.payload.reference.role, revision: ref.revision + 1 } as Reference)
          : ref;
      }),
      generationSpecs: snapshot.generationSpecs.map((current) => {
        const update = operations.find((op) => op.type === "generationSpec.update");
        return update?.type === "generationSpec.update"
          ? ({ ...current, parameters: update.payload.spec.parameters, revision: current.revision + 1 } as GenerationSpec)
          : current;
      }),
    };
    client.install(snapshot);
    return undefined;
  };
  const projection = new CreationProjection(client);
  const save = async (edit: (document: CanvasDocument) => void) => {
    const restored = await projection.read();
    projection.baseline = restored;
    projection.basis = snapshot;
    const next = structuredClone(restored);
    edit(next);
    batches.length = 0;
    await projection.save(next);
    return batches.flat();
  };
  return { projection, references, save, current: () => snapshot };
}

const roleUpdates = (operations: CreationOperation[]) =>
  operations.flatMap((op) =>
    op.type === "reference.update"
      ? [[op.payload.reference.id, op.payload.reference.role] as const]
      : [],
  );

test("a pinned first and last frame reopen in their frame slots", async () => {
  const { projection, references } = scenario(["first_frame", "last_frame"]);
  const restored = await projection.read();
  const settings = restored.nodes[0]!.data.settings!;
  assert.equal(settings.videoMode, "first-last");
  assert.equal(settings.firstFrameReferenceId, references[0]!.id);
  assert.equal(settings.lastFrameReferenceId, references[1]!.id);
  assert.equal(settings.firstFrameNodeId, undefined);
  assert.equal(settings.lastFrameNodeId, undefined);
});

test("a pinned image without a frame role does not fill a slot", async () => {
  const { projection } = scenario(["reference"]);
  const settings = (await projection.read()).nodes[0]!.data.settings!;
  assert.equal(settings.firstFrameReferenceId, undefined);
  assert.equal(settings.lastFrameReferenceId, undefined);
});

test("clearing a pinned frame slot demotes the reference role", async () => {
  const { save, references } = scenario(["first_frame"]);
  const operations = await save((document) => {
    delete document.nodes[0]!.data.settings!.firstFrameReferenceId;
  });
  assert.deepEqual(roleUpdates(operations), [[references[0]!.id, "reference"]]);
  assert.ok(
    !operations.some((op) => op.type === "reference.remove"),
    "clearing a slot keeps the fixed asset as an ordinary reference",
  );
});

test("choosing a pinned image for a slot promotes its role", async () => {
  const { save, references } = scenario(["reference"]);
  const operations = await save((document) => {
    document.nodes[0]!.data.settings!.firstFrameReferenceId = references[0]!.id;
  });
  assert.deepEqual(roleUpdates(operations), [[references[0]!.id, "first_frame"]]);
});

test("swapping pinned frames swaps their persisted roles", async () => {
  const { save, references } = scenario(["first_frame", "last_frame"]);
  const operations = await save((document) => {
    const settings = document.nodes[0]!.data.settings!;
    settings.firstFrameReferenceId = references[1]!.id;
    settings.lastFrameReferenceId = references[0]!.id;
  });
  assert.deepEqual(
    new Map(roleUpdates(operations)),
    new Map([
      [references[0]!.id, "last_frame"],
      [references[1]!.id, "first_frame"],
    ]),
  );
});

test("an unchanged save keeps pinned frame roles", async () => {
  const { save } = scenario(["first_frame", "last_frame"]);
  const operations = await save((document) => {
    document.nodes[0]!.data.settings!.durationSeconds = 8;
  });
  assert.deepEqual(roleUpdates(operations), []);
  assert.ok(operations.some((op) => op.type === "generationSpec.update"));
});

test("a reference-mode round trip restores the pinned first frame", async () => {
  const { projection, references, current } = scenario(["first_frame"]);
  const restored = await projection.read();
  projection.baseline = restored;
  projection.basis = current();
  // Same in-memory canvas document across both saves, as in the composer.
  const document = structuredClone(restored);
  const settings = document.nodes[0]!.data.settings!;
  settings.videoMode = "reference";
  await projection.save(structuredClone(document));
  assert.equal(current().references[0]!.role, "reference");
  assert.equal(
    (current().generationSpecs[0]!.parameters as { videoMode?: string })
      .videoMode,
    "reference",
  );
  projection.baseline = await projection.read();
  projection.basis = current();
  settings.videoMode = "first-last";
  await projection.save(structuredClone(document));
  assert.equal(current().references[0]!.role, "first_frame");
  assert.equal(
    (await projection.read()).nodes[0]!.data.settings!.firstFrameReferenceId,
    references[0]!.id,
  );
});

test("only fixed images in the prompt are frame candidates", () => {
  const content = [
    { type: "text" as const, text: "A " },
    { type: "reference" as const, binding: "asset" as const, assetId: "img", referenceId: "r1", name: "still.png" },
    { type: "reference" as const, binding: "asset" as const, assetId: "img", referenceId: "r1", name: "still.png" },
    { type: "reference" as const, binding: "asset" as const, assetId: "clip", referenceId: "r2", name: "clip.mp4" },
    { type: "reference" as const, assetId: "node:n", nodeId: "n", referenceId: "r3", name: "node" },
    { type: "reference" as const, binding: "asset" as const, assetId: "gone", referenceId: "r4", name: "gone.png" },
  ];
  const assets = [
    { id: "img", name: "still.png", type: "image/png", size: 1, fingerprint: "a" },
    { id: "clip", name: "clip.mp4", type: "video/mp4", size: 1, fingerprint: "b" },
  ];
  assert.deepEqual(pinnedFrameCandidates(content, assets), [
    { referenceId: "r1", assetId: "img", name: "still.png" },
  ]);
  assert.deepEqual(pinnedFrameCandidates(undefined, assets), []);
});

test("a slot holds either a node or a fixed asset", () => {
  const settings = {
    ...generationDefaults("video"),
    videoMode: "first-last" as const,
    firstFrameNodeId: "node-a",
  };
  assert.equal(frameSlotValue(settings, "first"), "node-a");
  assert.equal(frameSlotValue(settings, "last"), "");
  const pinned = { ...settings, ...frameSlotPatch("first", PINNED_FRAME_PREFIX + "r1") };
  assert.equal(pinned.firstFrameNodeId, undefined);
  assert.equal(pinned.firstFrameReferenceId, "r1");
  assert.equal(frameSlotValue(pinned, "first"), PINNED_FRAME_PREFIX + "r1");
  const node = { ...pinned, ...frameSlotPatch("first", "node-b") };
  assert.equal(node.firstFrameNodeId, "node-b");
  assert.equal(node.firstFrameReferenceId, undefined);
  const cleared = { ...pinned, ...frameSlotPatch("first", "") };
  assert.equal(frameSlotValue(cleared, "first"), "");
  const swapped = {
    ...pinned,
    lastFrameNodeId: "node-c",
    ...swapFramePatch({ ...pinned, lastFrameNodeId: "node-c" }),
  };
  assert.equal(swapped.firstFrameNodeId, "node-c");
  assert.equal(swapped.lastFrameReferenceId, "r1");
  assert.equal(swapped.firstFrameReferenceId, undefined);
  assert.equal(swapped.lastFrameNodeId, undefined);
});

test("removing the fixed image from the prompt empties its slot", () => {
  const settings = {
    ...generationDefaults("video"),
    videoMode: "first-last" as const,
    firstFrameReferenceId: "r1",
    lastFrameReferenceId: "r2",
  };
  const kept = pruneFrameReferences(settings, [
    { type: "reference", binding: "asset", assetId: "img", referenceId: "r1", name: "a" },
  ]);
  assert.equal(kept.firstFrameReferenceId, "r1");
  assert.equal(kept.lastFrameReferenceId, undefined);
  assert.equal(pruneFrameReferences(settings, undefined), settings);
  const document = {
    ...createDocument(),
    nodes: [
      {
        ...createNode("video", { x: 0, y: 0 }),
        id: "video",
        data: {
          ...createNode("video", { x: 0, y: 0 }).data,
          settings,
          promptContent: [
            { type: "reference" as const, binding: "asset" as const, assetId: "img", referenceId: "r1", name: "a" },
            { type: "reference" as const, binding: "asset" as const, assetId: "img2", referenceId: "r2", name: "b" },
          ],
        },
      },
    ],
  };
  const edited = applyCommand(document, {
    type: "update-node",
    id: "video",
    patch: {
      data: {
        promptContent: [{ type: "reference", binding: "asset", assetId: "img2", referenceId: "r2", name: "b" }],
      },
    },
  });
  const next = edited.nodes[0]!.data.settings!;
  assert.equal(next.firstFrameReferenceId, undefined);
  assert.equal(next.lastFrameReferenceId, "r2");
});

test("connecting images never replaces a fixed frame", () => {
  const settings = {
    ...generationDefaults("video"),
    videoMode: "first-last" as const,
    firstFrameReferenceId: "r1",
    frameSlotsInitialized: true,
  };
  const image = {
    ...createNode("image", { x: 0, y: 0 }),
    id: "image",
  };
  image.data = { ...image.data, src: "blob:image" };
  const filled = fillConnectedFrames(settings, [image]);
  assert.equal(filled.firstFrameNodeId, undefined);
  assert.equal(filled.firstFrameReferenceId, "r1");
  assert.equal(filled.lastFrameNodeId, "image");
});

test("stored canvas documents keep fixed frame slots", () => {
  const settings = {
    ...generationDefaults("video"),
    videoMode: "first-last" as const,
    firstFrameReferenceId: "r1",
    lastFrameReferenceId: "r2",
  };
  assert.ok(isGenerationSettings(settings));
  assert.deepEqual(copyGenerationSettings(settings), settings);
  assert.equal(isGenerationSettings({ ...settings, firstFrameReferenceId: "" }), false);
  assert.equal(isGenerationSettings({ ...settings, lastFrameReferenceId: 3 }), false);
});

test("a model without last-frame support rejects a fixed last frame", () => {
  const config: ModelConfig = {
    id: crypto.randomUUID(),
    kind: "video",
    url: "http://fixture.invalid/v1",
    modelId: "fixture",
    protocol: "openai",
    connectionType: "self_hosted",
    inputRules: {
      allowedKinds: ["text", "image"],
      maxImages: 1, maxVideos: 0, maxAudios: 0,
      videoModes: ["first_frame"], frameRoles: ["first_frame"],
    },
  } as unknown as ModelConfig;
  const settings = {
    ...generationDefaults("video"),
    modelConfigId: config.id,
    videoMode: "first-last" as const,
    prompt: "go",
    lastFrameReferenceId: "r2",
  };
  assert.equal(
    backendBlocker(settings, [], [config]),
    backendBlocker({ ...settings, lastFrameReferenceId: undefined, lastFrameNodeId: "x" }, [], [config]),
  );
  assert.notEqual(backendBlocker(settings, [], [config]), null);
});

test("entering first-last fills empty slots with fixed images in prompt order", () => {
  const candidates = [
    { referenceId: "r1", assetId: "a1", name: "a" },
    { referenceId: "r2", assetId: "a2", name: "b" },
    { referenceId: "r3", assetId: "a3", name: "c" },
  ];
  const settings = { ...generationDefaults("video"), videoMode: "first-last" as const };
  const filled = fillPinnedFrames(settings, candidates);
  assert.equal(filled.firstFrameReferenceId, "r1");
  assert.equal(filled.lastFrameReferenceId, "r2");
  // A connected node keeps its slot; only the remaining slot takes a fixed image.
  const mixed = fillPinnedFrames({ ...settings, firstFrameNodeId: "node" }, candidates);
  assert.equal(mixed.firstFrameReferenceId, undefined);
  assert.equal(mixed.lastFrameReferenceId, "r1");
  // A model without last-frame support only fills the first slot.
  const firstOnly = fillPinnedFrames(
    { ...settings, modelConfigId: "config" },
    candidates,
    { supportsLastFrame: () => false },
  );
  assert.equal(firstOnly.firstFrameReferenceId, "r1");
  assert.equal(firstOnly.lastFrameReferenceId, undefined);
  // Other modes and an empty prompt change nothing.
  const reference = { ...settings, videoMode: "reference" as const };
  assert.equal(fillPinnedFrames(reference, candidates), reference);
  assert.equal(fillPinnedFrames(settings, []), settings);
});
