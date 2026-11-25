import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CreationClient,
  type CreationOperation,
} from "../src/backend/creationClient.ts";
import { assetSource } from "../src/backend/assetSource.ts";
import { CreationProjection } from "../src/backend/creationProjection.ts";
import type {
  EditorDocument,
  ObjectVersion,
  ProjectSnapshot,
} from "../src/contracts/generated.ts";

function fixture(generated = false) {
  const source = JSON.parse(
    readFileSync(
      new URL("./fixtures/creation-project.json", import.meta.url),
      "utf8",
    ),
  ) as ProjectSnapshot;
  const item = source.canvasItems.find(
    (item) =>
      item.kind === "image" &&
      item.binding.role === (generated ? "generation" : "material"),
  )!;
  if (item.kind !== "image") throw new Error("missing image fixture");
  const snapshot: ProjectSnapshot = {
    ...source,
    canvasItems: [{ ...item, editors: [] }],
    generationSpecs: generated ? source.generationSpecs : [],
    references: [],
    editorDocuments: [],
    jobs: generated ? source.jobs : [],
    results: generated ? source.results : [],
  };
  const client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  client.mediaUrl = async (id) => `blob:${id}`;
  client.assetForSource = (src) =>
    source.assets.find(
      (asset) =>
        src === `blob:${asset.id}` || src === assetSource(client.id, asset.id),
    );
  client.view = async () => ({
    projectId: client.id,
    clientId: crypto.randomUUID(),
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedItemIds: [],
    activeEditorId: null,
    playheads: [],
    generationCounts: {},
  });
  const batches: {
    operations: CreationOperation[];
    versions: readonly ObjectVersion[];
  }[] = [];
  client.batch = async (operations, versions) => {
    batches.push({ operations, versions });
    return undefined;
  };
  return { client, batches, item, snapshot };
}

test("image layer documents retain asset identities across projection, update and detach", async () => {
  const { client, batches, item, snapshot } = fixture();
  const projection = new CreationProjection(client);
  const document = await projection.read();
  projection.baseline = document;
  projection.basis = snapshot;
  const image = document.nodes[0]!;
  const edited = structuredClone(document);
  edited.nodes[0]!.data.layers = {
    format: "opendirector-layers",
    version: 1,
    width: 128,
    height: 128,
    background: "transparent",
    layers: [
      {
        id: "image-layer",
        name: "Original",
        visible: true,
        locked: false,
        opacity: 0.7,
        x: 12,
        y: 4,
        width: 128,
        height: 128,
        rotation: 15,
        flipX: true,
        flipY: false,
        content: {
          kind: "image",
          src: image.data.src!,
          width: 128,
          height: 128,
        },
        mask: [{ mode: "erase", size: 12, points: [{ x: 2, y: 3 }] }],
      },
    ],
  };
  await projection.save(edited);
  const batch = batches[0]!;
  const created = batch.operations.find((op) => op.type === "editor.create")!;
  assert.equal(created.type, "editor.create");
  const layerDocument = {
    ...created.payload.document,
    schemaVersion: 1,
    revision: 1,
    inputConnections: [],
  } as EditorDocument;
  assert.equal(layerDocument.kind, "layers");
  if (layerDocument.kind !== "layers") throw new Error("missing layers");
  const content = layerDocument.data.layers[0]!.content;
  assert.equal(content.kind, "image");
  if (content.kind !== "image") throw new Error("missing image");
  assert.equal(item.binding.role, "material");
  if (item.binding.role !== "material") throw new Error("missing source");
  assert.deepEqual(content.asset, item.binding.objectRef);
  assert.ok(!JSON.stringify(batch.operations).includes("blob:"));
  assert.ok(
    batch.operations.some(
      (op) =>
        op.type === "canvas.attachEditor" &&
        op.payload.editorId === layerDocument.id,
    ),
  );
  const attached = {
    ...snapshot,
    eventCursor: snapshot.eventCursor + 1,
    canvasItems: [
      {
        ...snapshot.canvasItems[0]!,
        revision: 2,
        editors: [
          {
            objectType: "editor_document" as const,
            id: layerDocument.id,
            kind: "layers" as const,
          },
        ],
      },
    ],
    editorDocuments: [layerDocument],
  };
  client.install(attached);
  const reopened = new CreationProjection(client);
  const restored = await reopened.read();
  assert.deepEqual(
    restored.nodes[0]!.data.layers,
    edited.nodes[0]!.data.layers,
  );
  reopened.baseline = restored;
  reopened.basis = attached;
  const update = structuredClone(restored);
  update.nodes[0]!.data.layers!.layers[0]!.opacity = 0.3;
  await reopened.save(update);
  assert.deepEqual(
    batches[1]!.operations.map((op) => op.type),
    ["editor.save"],
  );
  assert.ok(
    batches[1]!.versions.some(
      (v) =>
        v.objectType === "editor_document" &&
        v.id === layerDocument.id &&
        v.revision === 1,
    ),
  );
  assert.ok(
    batches[1]!.versions.some(
      (v) =>
        v.objectType === "canvas_item" && v.id === item.id && v.revision === 2,
    ),
  );
  const cleared = structuredClone(update);
  delete cleared.nodes[0]!.data.layers;
  await reopened.save(cleared);
  assert.deepEqual(batches[2]!.operations, [
    {
      type: "canvas.detachEditor",
      payload: { itemId: item.id, editorId: layerDocument.id },
    },
  ]);
  assert.equal(
    client.snapshot.editorDocuments.length,
    1,
    "Detaching retains the document for history",
  );
});

for (const hidden of [false, true]) {
  test(`new ${hidden ? "hidden" : "visible"} image nodes attach copied layers after creation`, async () => {
    const { client, batches, snapshot } = fixture();
    const projection = new CreationProjection(client);
    const document = await projection.read();
    projection.baseline = document;
    projection.basis = snapshot;
    const copy = structuredClone(document.nodes[0]!);
    copy.id = crypto.randomUUID();
    copy.data.mediaRole = "asset";
    copy.data.layers = {
      format: "opendirector-layers",
      version: 1,
      width: 128,
      height: 128,
      background: "#ffffff",
      layers: [],
    };
    await projection.save({
      ...document,
      ...(hidden
        ? { hiddenNodes: [copy] }
        : { nodes: [...document.nodes, copy] }),
    });
    const operations = batches[0]!.operations;
    const show = operations.findIndex(
      (op) => op.type === "canvas.show" && op.payload.item.id === copy.id,
    );
    const attach = operations.findIndex(
      (op) =>
        op.type === "canvas.attachEditor" && op.payload.itemId === copy.id,
    );
    assert.ok(show >= 0 && attach > show);
    assert.equal(
      operations.filter((op) => op.type === "editor.create").length,
      1,
    );
  });
}

for (const generated of [false, true]) {
  test(`layer outputs use an explicit edit command for ${generated ? "generated" : "material"} images`, async () => {
    const { client, batches, snapshot } = fixture(generated);
    const projection = new CreationProjection(client);
    const document = await projection.read();
    projection.baseline = document;
    projection.basis = snapshot;
    const edited = structuredClone(document);
    const node = edited.nodes[0]!;
    const source = node.data.src;
    const output = snapshot.assets.find(
      (a) => a.kind === "image" && assetSource(client.id, a.id) !== source,
    )!;
    node.data.src = `blob:${output.id}`;
    node.data.layers = {
      format: "opendirector-layers",
      version: 1,
      width: 128,
      height: 128,
      background: "transparent",
      layers: [],
    };
    await projection.save(edited);
    const { operations, versions } = batches[0]!;
    assert.ok(!operations.some((op) => op.type === "canvas.materialize"));
    const applied = operations.find((op) => op.type === "canvas.applyEdit");
    assert.ok(applied && applied.type === "canvas.applyEdit");
    assert.equal(applied.payload.asset.assetId, output.id);
    assert.equal(assetSource(client.id, applied.payload.source.assetId), source);
    assert.ok(
      operations.findIndex((op) => op.type === "canvas.attachEditor") <
        operations.indexOf(applied),
    );
    assert.ok(
      versions.some((v) => v.objectType === "asset" && v.id === output.id),
    );
  });
}

test("crop projection reopens original inputs and copies independent documents and specs", async () => {
  const { client, batches, snapshot, item } = fixture(true);
  const { INITIAL_CROP_OPTIONS } = await import("../src/canvas/imageCrop.ts");
  const { copySelection, pasteFragment } =
    await import("../src/canvas/operations.ts");
  const source = snapshot.results[0]!.asset;
  const crop: EditorDocument = {
    id: crypto.randomUUID(),
    projectId: client.id,
    schemaVersion: 1,
    revision: 1,
    inputConnections: [],
    kind: "image_crop",
    data: {
      source,
      options: { ...INITIAL_CROP_OPTIONS, rotation: 90, aspect: "4:3" },
      width: 240,
      height: 180,
    },
  };
  const attached: ProjectSnapshot = {
    ...snapshot,
    canvasItems: [
      {
        ...item,
        editors: [
          { objectType: "editor_document", id: crop.id, kind: "image_crop" },
        ],
      },
    ],
    editorDocuments: [crop],
  };
  client.install(attached);
  const projection = new CreationProjection(client);
  const document = await projection.read();
  projection.baseline = document;
  projection.basis = attached;
  assert.equal(
    document.nodes[0]!.data.imageCrop!.src,
    assetSource(client.id, source.assetId),
  );
  assert.equal(document.nodes[0]!.data.imageCrop!.options.rotation, 90);
  const copied = pasteFragment(document, copySelection(document, [item.id]));
  await projection.save(copied.document);
  const operations = batches[0]!.operations;
  const created = operations.find((op) => op.type === "editor.create");
  assert.ok(created && created.type === "editor.create");
  assert.notEqual(created.payload.document.id, crop.id);
  assert.equal(created.payload.document.kind, "image_crop");
  if (created.payload.document.kind !== "image_crop")
    throw new Error("missing crop");
  assert.deepEqual(created.payload.document.data, crop.data);
  const spec = operations.find((op) => op.type === "generationSpec.create");
  assert.ok(spec && spec.type === "generationSpec.create");
  assert.equal(spec.payload.spec.currentResultId, null);
  const shown = operations.find((op) => op.type === "canvas.show");
  assert.ok(shown && shown.type === "canvas.show");
  const binding = shown.payload.item.binding;
  assert.equal(binding?.role, "generation");
  if (!binding || binding.role !== "generation")
    throw new Error("missing generation");
  assert.equal(binding.materialOverride?.assetId, source.assetId);
  assert.ok(
    !operations.some(
      (op) => op.type === "canvas.applyEdit" || op.type === "editor.save",
    ),
  );
});

test("tool drafts persist source identities, reopen parameters and reject stale source projection", async () => {
  const { client, batches, item, snapshot } = fixture();
  const projection = new CreationProjection(client);
  const document = await projection.read();
  projection.baseline = document;
  projection.basis = snapshot;
  const edited = structuredClone(document);
  edited.nodes[0]!.data.taskDraft = {
    version: 1,
    tool: "smart-edit",
    sourceNodeIds: [item.id],
    parameters: { prompt: "edit next", annotationDocument: "saved annotation" },
    selection: {
      sourceNodeId: item.id,
      width: 128,
      height: 128,
      boxes: [{ x: 2, y: 3, width: 10, height: 12 }],
    },
  };
  await projection.save(edited);
  const created = batches[0]!.operations.find(
    (op) => op.type === "editor.create",
  )!;
  assert.equal(created.type, "editor.create");
  if (created.type !== "editor.create") throw new Error("missing editor");
  const editor = {
    ...created.payload.document,
    schemaVersion: 1,
    revision: 1,
  } as EditorDocument;
  assert.equal(editor.kind, "media_edit");
  if (editor.kind !== "media_edit" || item.binding.role !== "material")
    throw new Error("missing media draft");
  assert.deepEqual(editor.data.sourceItems, [item.id]);
  assert.deepEqual(editor.data.sources, [item.binding.objectRef]);
  assert.equal(
    batches[0]!.operations.some((op) => op.type === "canvas.applyEdit"),
    false,
  );
  const attached: ProjectSnapshot = {
    ...snapshot,
    editorDocuments: [editor],
    canvasItems: [
      {
        ...item,
        revision: 2,
        editors: [
          { objectType: "editor_document", id: editor.id, kind: "media_edit" },
        ],
      },
    ],
  };
  client.install(attached);
  const reopened = new CreationProjection(client);
  const restored = await reopened.read();
  assert.deepEqual(
    restored.nodes[0]!.data.taskDraft,
    edited.nodes[0]!.data.taskDraft,
  );
  reopened.baseline = restored;
  reopened.basis = attached;
  const next = structuredClone(restored);
  next.nodes[0]!.data.taskDraft!.parameters.prompt = "new intent";
  await reopened.save(next);
  assert.deepEqual(
    batches[1]!.operations.map((op) => op.type),
    ["editor.save"],
  );
  assert.ok(
    batches[1]!.versions.some(
      (v) =>
        v.objectType === "editor_document" &&
        v.id === editor.id &&
        v.revision === 1,
    ),
  );
  const originalRef = item.binding.objectRef;
  const replacement = {
    ...snapshot.assets.find((a) => a.id === originalRef.assetId)!,
    id: crypto.randomUUID(),
  };
  client.install({
    ...attached,
    assets: [...snapshot.assets, replacement],
    canvasItems: [
      {
        ...item,
        editors:
          attached.canvasItems[0]!.kind === "image"
            ? attached.canvasItems[0]!.editors
            : [],
        binding: {
          role: "material",
          objectRef: { ...item.binding.objectRef, assetId: replacement.id },
        },
      },
    ],
  });
  const changed = await new CreationProjection(client).read();
  assert.equal(
    changed.nodes[0]!.data.taskDraft,
    undefined,
    "old selection cannot attach to replacement pixels of the same size",
  );
});

test("repeated project projections reuse immutable mask bytes", async (t) => {
  const { client, item, snapshot } = fixture();
  if (item.binding.role !== "material") throw new Error("missing material");
  const ref = item.binding.objectRef;
  const editor: EditorDocument = {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    projectId: client.id,
    revision: 1,
    kind: "media_edit",
    inputConnections: [],
    data: {
      tool: "smart-edit",
      sources: [ref],
      sourceItems: [item.id],
      parameters: {},
      selection: { source: ref, width: 128, height: 128, mask: ref, boxes: [] },
    },
  };
  const host = globalThis as unknown as Record<string, unknown>;
  const original = Object.getOwnPropertyDescriptor(host, "FileReader");
  class Reader {
    result = "data:image/png;base64,bWFzaw==";
    onload: (() => void) | null = null;
    readAsDataURL() {
      queueMicrotask(() => this.onload?.());
    }
  }
  Object.defineProperty(host, "FileReader", {
    configurable: true,
    value: Reader,
  });
  t.after(() => {
    if (original) Object.defineProperty(host, "FileReader", original);
    else delete host.FileReader;
  });
  let downloads = 0;
  client.blob = async () => {
    downloads++;
    return new Blob(["mask"], { type: "image/png" });
  };
  const projection = new CreationProjection(client);
  const first = await projection.editorData(editor);
  const second = await projection.editorData({ ...editor, revision: 2 });
  assert.deepEqual(first, second);
  assert.equal(
    downloads,
    1,
    "status/configuration notifications do not re-download the mask",
  );
  const imported = await projection.importResource({
    kind: "image",
    title: "selection",
    src: first.taskDraft!.selection!.maskDataUrl,
  });
  assert.deepEqual(
    imported,
    ref,
    "reopened unmodified masks retain original identity",
  );
});
