import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CreationClient,
  type CreationOperation,
} from "../src/backend/creationClient.ts";
import { CreationProjection } from "../src/backend/creationProjection.ts";
import { createDocument, createNode } from "../src/canvas/model.ts";
import { assembleNode } from "../src/canvas/editorAssembly.ts";
import type {
  ObjectVersion,
  ProjectSnapshot,
} from "../src/contracts/generated.ts";
import type { CanvasDocument } from "../src/canvas/model.ts";

/** An empty project that an archive is about to be imported into. */
function emptyProject() {
  const source = JSON.parse(
    readFileSync(
      new URL("./fixtures/creation-project.json", import.meta.url),
      "utf8",
    ),
  ) as ProjectSnapshot;
  const snapshot: ProjectSnapshot = {
    ...source,
    canvasItems: [],
    generationSpecs: [],
    references: [],
    editorDocuments: [],
    jobs: [],
    results: [],
  };
  const client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  client.mediaUrl = async (id) => `blob:${id}`;
  client.assetForSource = () => undefined;
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
  // Uploads are an HTTP round trip; the projection only needs a reference back.
  const uploaded: { name: string; importedFrom?: string }[] = [];
  client.importBlob = async (
    _blob,
    name,
    _kind,
    _handle,
    importedFrom?: "generated" | "edited",
  ) => {
    uploaded.push({ name, importedFrom });
    const asset = source.assets[0]!;
    return {
      assetId: asset.id,
      revision: asset.revision,
      fingerprint: asset.fingerprint,
      kind: asset.kind,
    };
  };
  return { client, batches, snapshot, uploaded };
}

function archiveDocument(
  mediaRole: "asset" | "generation",
  projectId: string,
) {
  const document: CanvasDocument = createDocument("导入");
  document.id = projectId;
  document.nodes = [
    createNode(
      "image",
      { x: 0, y: 0 },
      {
        src: "data:image/png;base64,aGVsbG8=",
        mimeType: "image/png",
        title: "图片生成.png",
        mediaRole,
        ...(mediaRole === "generation"
          ? {
              generationProvenance: {
                source: "generated" as const,
                jobId: "6f1d1f3e-0000-4000-8000-000000000000",
                inputFingerprint: "a".repeat(64),
              },
            }
          : {}),
      },
    ),
  ];
  return document;
}

for (const withProvenance of [true, false]) {
  test(`an imported generation node is shown as a generation item (provenance: ${withProvenance})`, async () => {
    const { client, batches, snapshot, uploaded } = emptyProject();
    const projection = new CreationProjection(client);
    const baseline = await projection.read();
    projection.baseline = baseline;
    projection.basis = snapshot;
    const document = archiveDocument("generation", client.id);
    if (!withProvenance) delete document.nodes[0]!.data.generationProvenance;
    await projection.save(document);

    const operations = batches[0]!.operations;
    const show = operations.find(
      (op) => op.type === "canvas.show",
    ) as Extract<CreationOperation, { type: "canvas.show" }>;
    assert.ok(show, "the node is shown");
    const binding = show.payload.item.binding;
    assert.ok(binding, "the item carries a binding");

    if (withProvenance) {
      // The show itself must carry the generation binding: converting a
      // material item afterwards is refused by the backend.
      assert.equal(binding.role, "generation");
      assert.ok("materialOverride" in binding);
      assert.ok(
        !operations.some((op) => op.type === "canvas.configure"),
        "no late upgrade attempt",
      );
      const spec = operations.findIndex(
        (op) => op.type === "generationSpec.create",
      );
      const shown = operations.indexOf(show);
      assert.ok(spec >= 0 && spec < shown, "the spec exists before the show");
      assert.equal(uploaded[0]?.importedFrom, "generated");
    } else {
      // A v1 archive has no evidence, so the node stays a plain material.
      assert.equal(binding.role, "material");
      assert.equal(uploaded[0]?.importedFrom, undefined);
    }
    assert.ok(
      !operations.some((op) => op.type === "canvas.materialize"),
      "a new node is never materialized",
    );
  });
}

test("an imported group is created before the members that name it", async () => {
  // Documents list nodes in visual order, so a group can come after its own
  // members. A batch applies in sequence: the member would then name a parent
  // that does not exist yet and the whole import would be refused.
  const { client, batches, snapshot } = emptyProject();
  const projection = new CreationProjection(client);
  projection.baseline = await projection.read();
  projection.basis = snapshot;
  const projectId = client.id;
  const document: CanvasDocument = createDocument("分组顺序");
  document.id = projectId;
  const group = createNode("group", { x: 0, y: 0 }, { title: "图片生成" });
  const child = createNode(
    "image",
    { x: 10, y: 10 },
    {
      src: "data:image/png;base64,aGVsbG8=",
      mimeType: "image/png",
      title: "图片生成预览",
      mediaRole: "asset",
    },
  );
  child.parentId = group.id;
  // Deliberately the wrong order: the member is listed first.
  document.nodes = [child, group];

  await projection.save(document);
  const operations = batches[0]!.operations;

  const shown = operations
    .map((op, index) => ({ op, index }))
    .filter(
      (entry) =>
        entry.op.type === "canvas.show" &&
        (entry.op.payload.item.id === child.id ||
          entry.op.payload.item.id === group.id),
    );
  const groupIndex = operations.findIndex(
    (op) => op.type === "canvas.show" && op.payload.item.id === group.id,
  );
  const childIndex = operations.findIndex(
    (op) => op.type === "canvas.show" && op.payload.item.id === child.id,
  );
  assert.equal(shown.length, 2, "both nodes are shown");
  assert.ok(groupIndex >= 0, "the group is created");
  assert.ok(childIndex >= 0, "the member is created");
  assert.ok(
    groupIndex < childIndex,
    "the group exists before the member that names it",
  );
});

/** A timeline whose single clip was assembled from `source`. */
function assembledTimeline(projectId: string) {
  const document: CanvasDocument = createDocument("装配");
  document.id = projectId;
  const source = createNode("video", { x: 0, y: 0 }, {
    src: "data:video/mp4;base64,AAAA",
    mimeType: "video/mp4",
    media: { durationSeconds: 5 },
  });
  const timeline = createNode("timeline", { x: 200, y: 0 });
  const assembled = assembleNode(source, timeline).node;
  document.nodes = [source, assembled];
  document.edges = [
    {
      id: crypto.randomUUID(),
      source: source.id,
      target: assembled.id,
      intent: "assembly_input",
      assemblySlotId: assembled.data.timeline!.tracks
        .flatMap((track) => track.clips)[0]!.id,
    },
  ];
  return { document, source, timeline: assembled };
}

test("a clip still carrying the media it was assembled with keeps its link", async () => {
  const { client, batches, snapshot } = emptyProject();
  const projection = new CreationProjection(client);
  projection.baseline = await projection.read();
  projection.basis = snapshot;
  const { document } = assembledTimeline(client.id);
  await projection.save(document);

  const created = batches[0]!.operations.find(
    (op) => op.type === "editor.create",
  ) as Extract<CreationOperation, { type: "editor.create" }>;
  assert.equal(created.payload.document.inputConnections?.length, 1);
});

test("a link the project already recorded survives its source being regenerated", async () => {
  // The export/import pair is not the only path that produces a clip whose
  // source moved on: regenerating a node does it in place. Such a link is
  // already recorded, and the backend retains it, so the projection must keep
  // it instead of dropping it as if it were a fresh lie.
  const base = emptyProject();
  const { client, batches } = base;
  const { document, source, timeline } = assembledTimeline(client.id);
  const edge = document.edges[0]!;
  const asset = base.snapshot.assets[0]!;
  const editorId = crypto.randomUUID();
  const snapshot: ProjectSnapshot = {
    ...base.snapshot,
    canvasItems: [
      {
        id: timeline.id,
        projectId: client.id,
        revision: 1,
        kind: "timeline",
        title: "时间线 1",
        position: { x: 0, y: 0 },
        width: 720,
        height: 280,
        zIndex: 0,
        locked: false,
        visible: true,
        parentId: null,
        tags: [],
        binding: {
          role: "editor",
          objectRef: { objectType: "editor_document", id: editorId, kind: "timeline" },
        },
      },
    ],
    editorDocuments: [
      {
        id: editorId,
        projectId: client.id,
        revision: 1,
        schemaVersion: 1,
        kind: "timeline",
        inputConnections: [
          {
            id: edge.id,
            sourceId: source.id,
            slotId: edge.assemblySlotId!,
            asset: {
              assetId: asset.id,
              revision: asset.revision,
              fingerprint: asset.fingerprint,
              kind: asset.kind,
            },
          },
        ],
        data: { fps: 24, width: 64, height: 64, importedAssets: [], tracks: [] },
      },
    ],
  };
  client.install(snapshot);
  const projection = new CreationProjection(client);
  projection.baseline = await projection.read();
  projection.basis = snapshot;

  source.data.src = "data:video/mp4;base64,BBBB";
  // Any real edit is enough to make the document worth saving.
  timeline.data.timeline!.tracks[0]!.clips[0]!.outPoint = 4.5;
  await projection.save(document);

  const saved = batches[0]!.operations.find(
    (op) => op.type === "editor.save",
  ) as Extract<CreationOperation, { type: "editor.save" }> | undefined;
  assert.ok(saved, "the trimmed timeline is saved");
  assert.equal(
    saved.payload.document.inputConnections?.length,
    1,
    "the recorded link is retained",
  );
});

test("an archive whose clip outlived a regenerated source imports without the stale link", async () => {
  // Regenerating a source node leaves the assembled clip holding the media it
  // was assembled with, so an exported archive can pair a clip with a node that
  // no longer produces it. The clip is still valid on its own; the link is what
  // the backend refuses, because a fresh connection must name the source's
  // current media.
  const { client, batches, snapshot } = emptyProject();
  const projection = new CreationProjection(client);
  projection.baseline = await projection.read();
  projection.basis = snapshot;
  const { document, source } = assembledTimeline(client.id);
  source.data.src = "data:video/mp4;base64,BBBB";
  await projection.save(document);

  const created = batches[0]!.operations.find(
    (op) => op.type === "editor.create",
  ) as Extract<CreationOperation, { type: "editor.create" }>;
  assert.equal(
    created.payload.document.inputConnections?.length,
    0,
    "the stale link is not recreated",
  );
  const clips =
    "tracks" in created.payload.document.data
      ? created.payload.document.data.tracks.flatMap((track) => track.clips)
      : [];
  assert.equal(clips.length, 1, "the clip itself survives");
});
