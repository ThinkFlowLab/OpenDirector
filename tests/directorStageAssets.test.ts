import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createLocalStage,
  parseLocalStageValue,
  probeStageAsset,
  sameLocalStage,
  unregisteredStageAssets,
} from "../src/canvas/stageDocument.ts";
import {
  CreationProjection,
  stageUploadTitle,
} from "../src/backend/creationProjection.ts";
import { CreationClient } from "../src/backend/creationClient.ts";
import type { ProjectSnapshot } from "../src/contracts/generated.ts";
import type { AssetRef } from "../src/contracts/generated.ts";

const asset = {
  assetId: "asset-gltf",
  revision: 2,
  fingerprint: `sha256:${"a".repeat(64)}`,
  kind: "file" as const,
};

test("GLB/GLTF stage objects accept transient previews and retain stable asset identity", () => {
  const stage = createLocalStage();
  const [person] = stage.objects;
  const imported = parseLocalStageValue({
    ...stage,
    objects: [
      {
        ...person,
        kind: "gltf",
        role: "character",
        format: "glb",
        source: "blob:director-preview",
        asset,
        animationNames: ["Walk"],
        hasAnimation: true,
        motionClips: [],
      },
    ],
  });
  assert.equal(imported.objects[0]!.asset?.assetId, "asset-gltf");
  assert.equal(imported.objects[0]!.source, "blob:director-preview");
  assert.deepEqual(
    parseLocalStageValue(JSON.parse(JSON.stringify(imported))),
    imported,
  );
  assert.equal(
    sameLocalStage(
      imported,
      parseLocalStageValue({
        ...imported,
        objects: [{ ...imported.objects[0]!, source: "blob:reloaded" }],
      }),
    ),
    true,
  );
});

test("a new local imported object may be previewed before its first project save", () => {
  const stage = createLocalStage();
  const [person] = stage.objects;
  const parsed = parseLocalStageValue({
    ...stage,
    objects: [
      {
        ...person,
        kind: "gltf",
        role: "scene",
        format: "gltf",
        source: "blob:unsaved-scene",
        animationNames: [],
        hasAnimation: false,
        motionClips: [],
      },
    ],
  });
  assert.equal(parsed.objects[0]!.asset, undefined);
  assert.equal(parsed.objects[0]!.role, "scene");
});

test("imported asset validation rejects missing identity, scene motion and absent animation data", () => {
  const stage = createLocalStage();
  const [person] = stage.objects;
  const base = {
    ...person,
    kind: "gltf",
    role: "character",
    format: "glb",
    asset,
    animationNames: [],
    hasAnimation: false,
    motionClips: [],
  };
  assert.throws(
    () =>
      parseLocalStageValue({
        ...stage,
        objects: [{ ...base, asset: undefined }],
      }),
    /舞台对象/,
  );
  assert.throws(
    () =>
      parseLocalStageValue({
        ...stage,
        objects: [
          {
            ...base,
            role: "scene",
            motionClips: [
              {
                id: "scene-motion",
                start: 0,
                duration: 1,
                motion: { preset: "idle", speed: 1, amount: 1 },
              },
            ],
          },
        ],
      }),
    /场景素材/,
  );
  assert.throws(
    () =>
      parseLocalStageValue({
        ...stage,
        objects: [
          {
            ...base,
            motionClips: [
              {
                id: "missing-animation",
                start: 0,
                duration: 1,
                motion: { preset: "walk", speed: 1, amount: 1 },
              },
            ],
          },
        ],
      }),
    /没有动画/,
  );
});

test("stage upload titles stay path-free whatever the object is named", () => {
  assert.equal(stageUploadTitle("hero/v2", "glb"), "hero_v2.glb");
  assert.equal(stageUploadTitle("a\\b\u0007c", "gltf"), "a_b_c.gltf");
  assert.equal(stageUploadTitle("   ", "glb"), "导入模型.glb");
  assert.equal(
    stageUploadTitle("长".repeat(300), "gltf").length <= 255,
    true,
  );
  assert.equal(stageUploadTitle("长".repeat(300), "gltf").endsWith(".gltf"), true);
});

test("stage JSON imports flag imported objects the project has not registered", () => {
  const stage = createLocalStage();
  const [person] = stage.objects;
  const foreign = parseLocalStageValue({
    ...stage,
    objects: [
      person,
      {
        ...person,
        id: "foreign-actor",
        kind: "gltf",
        name: "Foreign actor",
        role: "character",
        format: "glb",
        asset,
        animationNames: ["Walk"],
        hasAnimation: true,
        motionClips: [],
      },
      {
        ...person,
        id: "local-preview",
        kind: "gltf",
        name: "Unsaved import",
        role: "scene",
        format: "gltf",
        source: "blob:unsaved",
        animationNames: [],
        hasAnimation: false,
        motionClips: [],
      },
    ],
  });
  const registered = (ref: AssetRef) =>
    ref.assetId !== "asset-gltf" && ref.revision <= 5;
  const flagged = unregisteredStageAssets(foreign, registered);
  assert.deepEqual(
    flagged.map((object) => object.id),
    ["foreign-actor"],
  );
  // A pinned asset at an older revision than the registered one still resolves.
  assert.deepEqual(
    unregisteredStageAssets(foreign, () => true),
    [],
  );
});

function glbBuffer(payload: string): ArrayBuffer {
  const padded = payload + " ".repeat((4 - (payload.length % 4)) % 4);
  const body = new Uint8Array(12 + 8 + padded.length);
  const view = new DataView(body.buffer);
  body.set([0x67, 0x6c, 0x54, 0x46], 0);
  view.setUint32(4, 2, true);
  view.setUint32(8, body.length, true);
  view.setUint32(12, padded.length, true);
  body.set([0x4a, 0x53, 0x4f, 0x4e], 16);
  body.set(new TextEncoder().encode(padded), 20);
  return body.buffer;
}

test("stage asset probing distinguishes models, external resources and corruption", () => {
  const gltf = (document: unknown) =>
    new TextEncoder().encode(JSON.stringify(document)).buffer as ArrayBuffer;
  assert.deepEqual(
    probeStageAsset(glbBuffer(JSON.stringify({ asset: { version: "2.0" } }))),
    { format: "glb", external: false, compressed: false },
  );
  assert.deepEqual(
    probeStageAsset(
      glbBuffer(
        JSON.stringify({
          asset: { version: "2.0" },
          buffers: [{ uri: "scene.bin", byteLength: 4 }],
        }),
      ),
    ),
    { format: "glb", external: true, compressed: false },
  );
  assert.deepEqual(
    probeStageAsset(gltf({ asset: { version: "2.0" } })),
    { format: "gltf", external: false, compressed: false },
  );
  // Valid magic but truncated: the declared length exceeds the bytes present.
  const truncated = new Uint8Array(12);
  truncated.set([0x67, 0x6c, 0x54, 0x46], 0);
  new DataView(truncated.buffer).setUint32(8, 4096, true);
  assert.equal(probeStageAsset(truncated.buffer), undefined);
  // Valid container, unusable embedded JSON.
  assert.equal(probeStageAsset(glbBuffer("{not json")), "corrupt");
  assert.equal(probeStageAsset(glbBuffer("[1, 2, 3]")), "corrupt");
  assert.equal(probeStageAsset(gltf({ no: "document" })), undefined);
  assert.equal(probeStageAsset(gltf({ asset: { version: "2.0" } }).slice(0, 4)), undefined);
});

test("stage asset probing flags documents that need missing decoders", () => {
  const gltf = (document: unknown) =>
    new TextEncoder().encode(JSON.stringify(document)).buffer as ArrayBuffer;
  for (const extension of [
    "KHR_draco_mesh_compression",
    "EXT_meshopt_compression",
    "KHR_texture_basisu",
  ]) {
    assert.deepEqual(
      probeStageAsset(
        gltf({
          asset: { version: "2.0" },
          extensionsUsed: [extension],
        }),
      ),
      { format: "gltf", external: false, compressed: true },
      extension,
    );
    assert.deepEqual(
      probeStageAsset(
        glbBuffer(
          JSON.stringify({
            asset: { version: "2.0" },
            extensionsRequired: [extension],
          }),
        ),
      ),
      { format: "glb", external: false, compressed: true },
      extension,
    );
  }
  // Unrelated extensions stay importable.
  assert.deepEqual(
    probeStageAsset(
      gltf({
        asset: { version: "2.0" },
        extensionsUsed: ["KHR_materials_unlit"],
      }),
    ),
    { format: "gltf", external: false, compressed: false },
  );
});

test("director stage reads keep pinned identity when media bytes are unavailable", async () => {
  const source = JSON.parse(
    readFileSync(
      new URL("./fixtures/creation-project.json", import.meta.url),
      "utf8",
    ),
  ) as ProjectSnapshot;
  const client = new CreationClient(source.project.id);
  client.install(source);
  const unavailable = "00000000-0000-0000-0000-00000000000e";
  client.mediaUrl = async (id) => {
    if (id === unavailable) throw new Error("asset content gone");
    return `blob:${id}`;
  };
  client.view = async () => ({
    projectId: client.id,
    clientId: crypto.randomUUID(),
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedItemIds: [],
    activeEditorId: null,
    playheads: [],
    generationCounts: {},
  });
  const document = await new CreationProjection(client).read();
  const stage = document.nodes
    .map((node) => node.data.localStage)
    .find((value) => value?.objects.some((object) => object.kind === "gltf"));
  assert.ok(stage, "director stage node missing from projection");
  const imported = stage.objects.find((object) => object.kind === "gltf")!;
  assert.equal(imported.asset?.assetId, unavailable);
  assert.equal(imported.source, undefined);
  // The document stays valid without the preview URL; the editor shows the
  // unavailable-asset notice instead of failing to reopen.
  assert.deepEqual(
    parseLocalStageValue(JSON.parse(JSON.stringify(stage))).objects.find(
      (object) => object.kind === "gltf",
    )!.asset,
    imported.asset,
  );
});
