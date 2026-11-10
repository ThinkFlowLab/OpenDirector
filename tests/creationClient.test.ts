import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type {
  ProjectSnapshot,
  ObjectVersion,
  CanvasItem,
  TextGenerationSpec,
  ImageGenerationSpec,
  Asset,
  Reference,
} from "../src/contracts/generated.ts";
import {
  CreationClient,
  CreationCommandError,
  assetReference,
  type CreationOperation,
} from "../src/backend/creationClient.ts";
import { CreationProjection } from "../src/backend/creationProjection.ts";
import { createDocument, createNode } from "../src/canvas/model.ts";

function empty(): ProjectSnapshot {
  return {
    format: "opendirector-project",
    formatVersion: 2,
    project: { id: crypto.randomUUID(), name: "Test", revision: 1 },
    assets: [],
    generationSpecs: [],
    references: [],
    canvasItems: [],
    editorDocuments: [],
    jobs: [],
    results: [],
    eventCursor: 1,
    undoClearedThrough: 0,
  };
}

test("history reads coalesce per cursor, invalidate after changes and retry failures", async () => {
  const original = globalThis.fetch;
  const snapshot = empty();
  const client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  let reads = 0;
  globalThis.fetch = async () => {
    reads++;
    if (reads === 2)
      return Response.json({ detail: "temporary failure" }, { status: 503 });
    return Response.json([]);
  };
  try {
    await Promise.all([client.history(), client.history(), client.history()]);
    client.install({ ...snapshot });
    await client.history();
    assert.equal(reads, 1);
    client.install({ ...snapshot, eventCursor: 2 });
    await assert.rejects(client.history());
    await client.history();
    assert.equal(reads, 3);
  } finally {
    globalThis.fetch = original;
  }
});

test("rapid undo gestures choose consecutive targets and fresh revisions in the command queue", async () => {
  const original = globalThis.fetch;
  let snapshot = empty();
  const id = crypto.randomUUID();
  const item: CanvasItem = {
    id,
    projectId: snapshot.project.id,
    revision: 1,
    kind: "text",
    title: "Node",
    position: { x: 20, y: 0 },
    width: 320,
    height: 160,
    locked: false,
    visible: true,
    zIndex: 0,
    parentId: null,
    tags: [],
    editors: [],
    binding: { role: "empty", draftSpec: null, manualText: "" },
  };
  snapshot = { ...snapshot, canvasItems: [item] };
  const client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  const first = crypto.randomUUID(),
    second = crypto.randomUUID();
  const entries = [
    { commandId: second, state: "applied" },
    { commandId: first, state: "applied" },
  ];
  const sent: string[] = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/history")) return Response.json(entries);
    if (String(url).endsWith("/commands")) {
      const body = JSON.parse(options!.body as string);
      const target = entries.find(
        (entry) => entry.commandId === body.payload.targetCommandId,
      )!;
      assert.equal(target.state, "applied");
      assert.equal(
        body.expectedVersions[0].revision,
        snapshot.canvasItems[0]!.revision,
      );
      target.state = "undone";
      sent.push(target.commandId);
      snapshot = {
        ...snapshot,
        eventCursor: snapshot.eventCursor + 1,
        canvasItems: [
          {
            ...snapshot.canvasItems[0]!,
            revision: snapshot.canvasItems[0]!.revision + 1,
          },
        ],
      };
      return Response.json({
        commandId: body.commandId,
        projectId: snapshot.project.id,
        inputFingerprint: "a".repeat(64),
        status: "applied",
        changed: [],
        jobIds: [],
        issues: [],
        eventCursor: snapshot.eventCursor,
      });
    }
    return Response.json({ snapshot, edges: [] });
  };
  try {
    await Promise.all([client.undo(), client.undo()]);
    assert.deepEqual(sent, [second, first]);
  } finally {
    globalThis.fetch = original;
  }
});

test("visibility receipts reuse hydrated nodes but content and layout changes take a full projection read", async () => {
  const snapshot = empty();
  const node = createNode("text", { x: 10, y: 20 }, { text: "Saved text" });
  const item: CanvasItem = {
    id: node.id,
    projectId: snapshot.project.id,
    revision: 1,
    kind: "text",
    title: node.data.title,
    position: node.position,
    width: node.width,
    height: node.height,
    locked: false,
    visible: false,
    zIndex: 0,
    parentId: null,
    tags: [],
    editors: [],
    binding: { role: "empty", draftSpec: null, manualText: "Saved text" },
  };
  const basis = { ...snapshot, canvasItems: [item] };
  const client = new CommandCapture(snapshot.project.id);
  client.install(basis);
  let viewReads = 0;
  const view = client.view.bind(client);
  client.view = async () => {
    viewReads++;
    return view();
  };
  const projection = new CreationProjection(client);
  projection.basis = basis;
  projection.baseline = await projection.read(basis);
  const hydratedNode = projection.baseline.hiddenNodes![0];
  viewReads = 0;
  const shown = {
    ...basis,
    eventCursor: 2,
    canvasItems: [{ ...item, visible: true, revision: 2 }],
  };
  const quick = await projection.read(shown);
  assert.equal(viewReads, 0);
  assert.equal(quick.nodes[0], hydratedNode);
  assert.deepEqual(quick.hiddenNodes, []);
  assert.deepEqual(projection.baseline.nodes, []); // No mutation before acknowledgement is installed.
  // A save acknowledgement can advance the editing basis before the new content
  // is hydrated. It must not make the cached old text eligible for reuse.
  projection.basis = {
    ...basis,
    canvasItems: [
      {
        ...item,
        binding: {
          role: "empty",
          draftSpec: null,
          manualText: "New text while hidden",
        },
      },
    ],
  };
  const content = await projection.read({
    ...shown,
    canvasItems: [
      {
        ...shown.canvasItems[0]!,
        binding: {
          role: "empty",
          draftSpec: null,
          manualText: "New text while hidden",
        },
      },
    ],
  });
  assert.equal(viewReads, 1);
  assert.equal(content.nodes[0]?.data.text, "New text while hidden");
  const moved = await projection.read({
    ...shown,
    canvasItems: [{ ...shown.canvasItems[0]!, position: { x: 90, y: 70 } }],
  });
  assert.equal(viewReads, 2);
  assert.deepEqual(moved.nodes[0]?.position, { x: 90, y: 70 });
});

test("a lost command response resolves its original receipt without issuing another command", async () => {
  const fetch = globalThis.fetch,
    snapshot = empty(),
    client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  const seen: string[] = [];
  let receipt: unknown;
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    seen.push(path);
    if (path.endsWith("/commands")) {
      const body = JSON.parse(options!.body as string);
      receipt = {
        commandId: body.commandId,
        projectId: body.projectId,
        inputFingerprint: "a".repeat(64),
        status: "noop",
        changed: [],
        jobIds: [],
        issues: [],
        eventCursor: 1,
      };
      throw new TypeError("response lost after server commit");
    }
    if (path.includes("/receipts/")) return Response.json(receipt);
    return Response.json({ snapshot, edges: [] });
  };
  try {
    const result = await client.command("canvas.move", {
      items: [{ itemId: crypto.randomUUID(), position: { x: 1, y: 2 } }],
    });
    assert.equal(result.status, "noop");
    assert.equal(seen.filter((path) => path.endsWith("/commands")).length, 1);
    assert.equal(seen.filter((path) => path.includes("/receipts/")).length, 1);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("out of order refresh responses cannot roll back a newer snapshot or edge evidence", async () => {
  const fetch = globalThis.fetch,
    snapshot = empty(),
    client = new CreationClient(snapshot.project.id);
  client.install({ ...snapshot, eventCursor: 5 });
  client.referenceStates.set("edge", "used");
  globalThis.fetch = async () =>
    Response.json({
      snapshot: { ...snapshot, eventCursor: 3 },
      edges: [{ referenceId: "edge", state: "pending" }],
    });
  try {
    await client.refresh();
    assert.equal(client.snapshot.eventCursor, 5);
    assert.equal(client.referenceStates.get("edge"), "used");
    assert.throws(
      () =>
        client.install({
          ...snapshot,
          project: { ...snapshot.project, id: crypto.randomUUID() },
        }),
      /身份/,
    );
  } finally {
    globalThis.fetch = fetch;
  }
});

test("an unresolved generation delivery survives reload and replays its original body before another attempt", async () => {
  const previousStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage",
  );
  const saved = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
      removeItem: (key: string) => saved.delete(key),
    },
  });
  const fetch = globalThis.fetch,
    snapshot = empty(),
    client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  const submitted: Record<string, any>[] = [];
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (path.endsWith("/commands")) {
      const body = JSON.parse(options!.body as string);
      submitted.push(body);
      if (submitted.length === 1)
        throw new TypeError("response and receipt not yet available");
      return Response.json({
        commandId: body.commandId,
        projectId: body.projectId,
        inputFingerprint: "a".repeat(64),
        status: "accepted",
        changed: [],
        jobIds: [crypto.randomUUID()],
        issues: [],
        eventCursor: 1,
      });
    }
    if (path.includes("/receipts/"))
      return Response.json({ detail: "not committed yet" }, { status: 404 });
    return Response.json({ snapshot, edges: [] });
  };
  const specId = crypto.randomUUID();
  try {
    await assert.rejects(
      client.command("generation.submit", { specId, expectedSpecRevision: 1 }),
    );
    const reopened = new CreationClient(snapshot.project.id);
    reopened.install(snapshot);
    await reopened.command("generation.submit", {
      specId,
      expectedSpecRevision: 2,
    });
    assert.equal(submitted.length, 2);
    assert.deepEqual(submitted[0], submitted[1]);
    assert.equal(submitted[1]!.payload.expectedSpecRevision, 1);
    assert.equal(saved.size, 0);
  } finally {
    globalThis.fetch = fetch;
    if (previousStorage)
      Object.defineProperty(globalThis, "sessionStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("an accepted command whose snapshot refresh fails retains its original delivery", async () => {
  const previousFetch = globalThis.fetch;
  const snapshot = empty(),
    client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  const submitted: Record<string, any>[] = [];
  let refreshes = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/commands")) {
      const body = JSON.parse(options!.body as string);
      submitted.push(body);
      return Response.json({
        commandId: body.commandId,
        projectId: body.projectId,
        status: "accepted",
        inputFingerprint: "a".repeat(64),
        changed: [],
        jobIds: [crypto.randomUUID()],
        issues: [],
        eventCursor: 1,
      });
    }
    if (++refreshes === 1)
      throw new TypeError("connection lost after accepted reply");
    return Response.json({ snapshot, edges: [] });
  };
  const specId = crypto.randomUUID();
  try {
    await assert.rejects(
      client.command("generation.submit", { specId, expectedSpecRevision: 1 }),
    );
    await client.command("generation.submit", {
      specId,
      expectedSpecRevision: 2,
    });
    assert.deepEqual(submitted[0], submitted[1]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

class CommandCapture extends CreationClient {
  override async textContent() {
    return "Actual source";
  }
  batches: {
    operations: CreationOperation[];
    versions: readonly ObjectVersion[];
  }[] = [];
  override async batch(
    operations: CreationOperation[],
    versions: readonly ObjectVersion[],
  ) {
    this.batches.push({ operations, versions });
    return undefined;
  }
  override async view() {
    return {
      projectId: this.id,
      clientId: crypto.randomUUID(),
      viewport: { x: 0, y: 0, zoom: 1 },
      selectedItemIds: [],
      activeEditorId: null,
      playheads: [],
      generationCounts: {},
    };
  }
}

test("edited projections retain their original revision basis and emit semantic operations only", async () => {
  const snapshot = empty(),
    node = createNode("text");
  const spec: TextGenerationSpec = {
    id: crypto.randomUUID(),
    projectId: snapshot.project.id,
    revision: 1,
    kind: "text",
    purpose: "draft",
    prompt: "",
    promptContent: null,
    modelConfigId: null,
    currentResultId: null,
    parameters: { thinking: "auto", maxTokens: 8192 },
  };
  const item: CanvasItem = {
    id: node.id,
    projectId: snapshot.project.id,
    revision: 1,
    kind: "text",
    title: node.data.title,
    position: node.position,
    width: node.width,
    height: node.height,
    locked: false,
    visible: true,
    zIndex: 0,
    parentId: null,
    tags: [],
    editors: [],
    binding: {
      role: "empty",
      draftSpec: { objectType: "generation_spec", id: spec.id },
      manualText: null,
    },
  };
  const basis = { ...snapshot, canvasItems: [item], generationSpecs: [spec] };
  const client = new CommandCapture(snapshot.project.id);
  client.install(basis);
  const projection = new CreationProjection(client);
  const document = { ...createDocument(), id: client.id, nodes: [node] };
  projection.baseline = document;
  projection.basis = basis;
  client.install({
    ...basis,
    eventCursor: 2,
    canvasItems: [{ ...item, revision: 2, title: "Another actor changed it" }],
  });
  await projection.save({
    ...document,
    nodes: [{ ...node, position: { x: 100, y: 25 } }],
  });
  const batch = client.batches[0]!;
  assert.deepEqual(
    batch.operations.map((op) => op.type),
    ["canvas.move"],
  );
  assert.equal(batch.versions[0]!.revision, 1); // A stale form never acquires revision 2 silently.
  assert.ok(!JSON.stringify(batch).includes("Another actor changed it"));
});

function presentationFixture() {
  const snapshot = empty(),
    node = createNode("image");
  const spec: ImageGenerationSpec = {
    id: crypto.randomUUID(),
    projectId: snapshot.project.id,
    revision: 1,
    kind: "image",
    purpose: "generation",
    prompt: "",
    promptContent: null,
    modelConfigId: null,
    currentResultId: null,
    parameters: {
      size: "auto",
      aspectRatio: null,
      preset: "none",
      responseFormat: "url",
      outputFormat: "png",
    },
  };
  const item: CanvasItem = {
    id: node.id,
    projectId: snapshot.project.id,
    revision: 1,
    kind: "image",
    title: node.data.title,
    position: node.position,
    width: node.width,
    height: node.height,
    locked: false,
    visible: true,
    zIndex: 0,
    parentId: null,
    tags: [],
    editors: [],
    binding: {
      role: "generation",
      objectRef: { objectType: "generation_spec", id: spec.id },
      materialOverride: null,
    },
  };
  const basis = { ...snapshot, canvasItems: [item], generationSpecs: [spec] };
  const client = new CommandCapture(snapshot.project.id);
  client.install(basis);
  const projection = new CreationProjection(client);
  const document = { ...createDocument(), id: client.id, nodes: [node] };
  projection.baseline = document;
  projection.basis = basis;
  const conflict = new CreationCommandError({
    commandId: crypto.randomUUID(),
    projectId: client.id,
    inputFingerprint: "a".repeat(64),
    status: "rejected",
    changed: [],
    jobIds: [],
    eventCursor: basis.eventCursor + 1,
    issues: [
      {
        code: "revision_conflict",
        message: "stale",
        objectId: item.id,
        field: null,
      },
    ],
  });
  return { client, projection, document, basis, item, node, conflict };
}

test("a rejected move rebases over generated dimensions and preserves the generated result", async () => {
  const { client, projection, document, basis, item, node, conflict } =
    presentationFixture();
  const latest = {
    ...basis,
    eventCursor: basis.eventCursor + 1,
    canvasItems: [
      {
        ...item,
        revision: 2,
        width: item.width + 100,
        binding: {
          role: "material" as const,
          objectRef: {
            assetId: crypto.randomUUID(),
            revision: 1,
            kind: "image" as const,
            fingerprint: "a".repeat(64),
          },
        },
      },
    ],
  };
  const originalFetch = globalThis.fetch;
  const sent: {
    commandId: string;
    expectedVersions: ObjectVersion[];
    payload: { operations: CreationOperation[] };
  }[] = [];
  client.batch = async (operations, versions) => {
    await CreationClient.prototype.batch.call(client, operations, versions);
    return undefined;
  };
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/commands")) {
      const body = JSON.parse(options!.body as string);
      sent.push(body);
      if (sent.length === 1)
        return Response.json({
          ...conflict.receipt,
          commandId: body.commandId,
        });
      assert.equal(body.expectedVersions[0].revision, 2);
      return Response.json({
        ...conflict.receipt,
        commandId: body.commandId,
        status: "applied",
        issues: [],
        changed: [],
        eventCursor: 2,
      });
    }
    return Response.json({ snapshot: latest, edges: [] });
  };
  const edited = {
    ...document,
    nodes: [{ ...node, position: { x: 100, y: 25 } }],
  };
  try {
    assert.equal(await projection.save(edited, { saveView: false }), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(
    sent.map((batch) => batch.expectedVersions[0]!.revision),
    [1, 2],
  );
  assert.notEqual(sent[0]!.commandId, sent[1]!.commandId);
  assert.deepEqual(sent[1]!.payload.operations, [
    {
      type: "canvas.move",
      payload: { items: [{ itemId: node.id, position: { x: 100, y: 25 } }] },
    },
  ]);
  assert.equal(projection.baseline, edited);
  assert.deepEqual(projection.basis, latest);
  assert.equal(client.snapshot.canvasItems[0]!.binding.role, "material");
});

test("renaming sends only the edited field and rebases over a generated size", async () => {
  const { client, projection, document, basis, item, node, conflict } =
    presentationFixture();
  client.batch = async (operations, versions) => {
    client.batches.push({ operations, versions });
    client.install({
      ...basis,
      eventCursor: 2,
      canvasItems: [{ ...item, revision: 2, width: item.width + 100 }],
    });
    if (client.batches.length === 1) throw conflict;
    return undefined;
  };
  await projection.save(
    {
      ...document,
      nodes: [{ ...node, data: { ...node.data, title: "Renamed" } }],
    },
    { saveView: false },
  );
  assert.deepEqual(client.batches[1]!.operations, [
    { type: "canvas.update", payload: { itemId: node.id, title: "Renamed" } },
  ]);
  assert.equal(client.batches[1]!.versions[0]!.revision, 2);
});

for (const [label, change] of [
  ["position", { position: { x: 999, y: 999 } }],
  ["lock", { locked: true }],
  ["visibility", { visible: false }],
  ["parent", { parentId: crypto.randomUUID() }],
] as const) {
  test(`a move keeps its draft and rejects a concurrent ${label} change`, async () => {
    const { client, projection, document, basis, item, node, conflict } =
      presentationFixture();
    client.batch = async (operations, versions) => {
      client.batches.push({ operations, versions });
      client.install({
        ...basis,
        eventCursor: 2,
        canvasItems: [{ ...item, ...change, revision: 2 }],
      });
      throw conflict;
    };
    await assert.rejects(
      projection.save({
        ...document,
        nodes: [{ ...node, position: { x: 100, y: 25 } }],
      }),
      (error) => error === conflict,
    );
    assert.equal(client.batches.length, 1);
    assert.equal(projection.baseline, document);
    assert.equal(projection.basis, basis);
  });
}

test("a rename does not overwrite a concurrent rename", async () => {
  const { client, projection, document, basis, item, node, conflict } =
    presentationFixture();
  client.batch = async (operations, versions) => {
    client.batches.push({ operations, versions });
    client.install({
      ...basis,
      eventCursor: 2,
      canvasItems: [{ ...item, title: "Remote title", revision: 2 }],
    });
    throw conflict;
  };
  await assert.rejects(
    projection.save({
      ...document,
      nodes: [{ ...node, data: { ...node.data, title: "Local title" } }],
    }),
    (error) => error === conflict,
  );
  assert.equal(client.batches.length, 1);
  assert.equal(projection.basis, basis);
});

test("an unknown save outcome does not receive a new layout attempt", async () => {
  const { client, projection, document, node } = presentationFixture();
  client.batch = async (operations, versions) => {
    client.batches.push({ operations, versions });
    throw new TypeError("response lost");
  };
  await assert.rejects(
    projection.save({
      ...document,
      nodes: [{ ...node, position: { x: 100, y: 25 } }],
    }),
    /response lost/,
  );
  assert.equal(client.batches.length, 1);
});

test("layout recovery is bounded while new server revisions keep arriving", async () => {
  const { client, projection, document, basis, item, node, conflict } =
    presentationFixture();
  client.batch = async (operations, versions) => {
    client.batches.push({ operations, versions });
    const revision = client.batches.length + 1;
    client.install({
      ...basis,
      eventCursor: revision,
      canvasItems: [{ ...item, width: item.width + revision, revision }],
    });
    throw conflict;
  };
  await assert.rejects(
    projection.save({
      ...document,
      nodes: [{ ...node, position: { x: 100, y: 25 } }],
    }),
    (error) => error === conflict,
  );
  assert.equal(client.batches.length, 3);
  assert.equal(projection.basis, basis);
  assert.equal(projection.baseline, document);
});

test("a mixed prompt and layout edit preserves its original content versions", async () => {
  const { client, projection, document, basis, item, node, conflict } =
    presentationFixture();
  client.batch = async (operations, versions) => {
    client.batches.push({ operations, versions });
    client.install({
      ...basis,
      eventCursor: 2,
      canvasItems: [{ ...item, width: item.width + 100, revision: 2 }],
    });
    throw conflict;
  };
  await assert.rejects(
    projection.save({
      ...document,
      nodes: [
        {
          ...node,
          position: { x: 100, y: 25 },
          data: { ...node.data, prompt: "Local prompt" },
        },
      ],
    }),
    (error) => error === conflict,
  );
  assert.ok(
    client.batches[0]!.operations.some(
      (op) => op.type === "generationSpec.setPrompt",
    ),
  );
  assert.equal(client.batches.length, 1);
  assert.equal(projection.basis, basis);
});

test("reference replacement and hiding preserve the intended project relationships", async () => {
  const snapshot = empty(),
    source = createNode("text", undefined, { text: "Actual source" }),
    target = createNode("text");
  const asset: Asset = {
    id: crypto.randomUUID(),
    projectId: snapshot.project.id,
    revision: 1,
    kind: "text",
    name: "A.md",
    fingerprint: `sha256:${"a".repeat(64)}`,
    path: "",
    metadata: {
      mimeType: "text/markdown",
      size: 13,
      width: null,
      height: null,
      durationSeconds: null,
      frameRate: null,
      hasAudio: null,
      sampleRate: null,
      channels: null,
    },
    provenance: {
      source: "manual",
      jobId: null,
      toolTaskId: null,
      sourceItemId: null,
      editorDocumentId: null,
      editorRevision: null,
      sources: [],
      inputFingerprint: null,
      agentRunId: null,
      agentRuntime: null,
      modelSnapshot: null,
      prompt: null,
      importedFrom: null,
    },
  };
  const spec: TextGenerationSpec = {
    id: crypto.randomUUID(),
    projectId: snapshot.project.id,
    revision: 1,
    kind: "text",
    purpose: "generation",
    prompt: "",
    promptContent: null,
    modelConfigId: null,
    currentResultId: null,
    parameters: { thinking: "auto", maxTokens: 8192 },
  };
  const makeItem = (
    node: typeof source,
    binding: CanvasItem["binding"],
  ): CanvasItem =>
    ({
      id: node.id,
      projectId: snapshot.project.id,
      revision: 1,
      kind: "text",
      title: node.data.title,
      position: node.position,
      width: node.width,
      height: node.height,
      zIndex: 0,
      locked: false,
      visible: true,
      parentId: null,
      tags: [],
      editors: [],
      binding,
    }) as CanvasItem;
  const ref: Reference = {
    id: crypto.randomUUID(),
    projectId: snapshot.project.id,
    revision: 1,
    active: true,
    order: 0,
    role: "reference",
    binding: "follow_current",
    source: { objectType: "canvas_item", id: source.id },
    targetSpecId: spec.id,
  };
  const basis = {
    ...snapshot,
    assets: [asset],
    generationSpecs: [spec],
    references: [ref],
    canvasItems: [
      makeItem(source, { role: "material", objectRef: assetReference(asset) }),
      makeItem(target, {
        role: "generation",
        objectRef: { objectType: "generation_spec", id: spec.id },
        materialOverride: null,
      }),
    ],
  };
  const client = new CommandCapture(snapshot.project.id);
  client.install(basis);
  const projection = new CreationProjection(client),
    document = {
      ...createDocument(),
      id: client.id,
      nodes: [source, target],
      edges: [{ id: ref.id, source: source.id, target: target.id }],
    };
  projection.baseline = document;
  projection.basis = basis;
  // Removing a mention and re-adding the same source before autosave creates a
  // new local relation. The server must remove the old one before accepting it.
  const replacementId = crypto.randomUUID();
  const { generationContentPatch } =
    await import("../src/canvas/generationReferenceContent.ts");
  const replacement = generationContentPatch([
    { type: "text", text: "Based on " },
    {
      type: "reference",
      assetId: `node:${source.id}`,
      nodeId: source.id,
      referenceId: replacementId,
      name: source.data.title,
      fingerprint: null,
    },
  ]);
  await projection.save({
    ...document,
    nodes: [source, { ...target, data: { ...target.data, ...replacement } }],
    edges: [{ id: replacementId, source: source.id, target: target.id }],
  });
  const operations = client.batches[0]!.operations;
  const removeIndex = operations.findIndex(
    (op) => op.type === "reference.remove" && op.payload.referenceId === ref.id,
  );
  const addIndex = operations.findIndex(
    (op) =>
      op.type === "reference.add" && op.payload.reference.id === replacementId,
  );
  assert.ok(removeIndex >= 0 && addIndex > removeIndex);
  const update = operations.find(
    (op) => op.type === "generationSpec.setPrompt",
  );
  assert.ok(update?.type === "generationSpec.setPrompt");
  assert.deepEqual(update.payload.promptContent, [
    { type: "text", text: "Based on " },
    { type: "reference", referenceId: replacementId },
  ]);
  assert.ok(
    client.batches[0]!.versions.some(
      (version) => version.objectType === "reference" && version.id === ref.id,
    ),
  );
  projection.baseline = document;
  projection.basis = basis;
  client.batches = [];
  await projection.save({ ...document, nodes: [target], edges: [] });
  assert.deepEqual(
    client.batches[0]!.operations.map((op) => op.type),
    ["canvas.hide"],
  );
  assert.equal(client.snapshot.references[0]!.id, ref.id);
  // Display hiding must preserve every active business reference in the prompt.
  for (const binding of ["follow_current", "pinned", "pinned_source"] as const) {
    const reference: Reference =
      binding === "follow_current"
        ? ref
        : {
            ...ref, binding: "pinned", source: assetReference(asset),
            ...(binding === "pinned_source" ? { sourceVersion: { objectType: "canvas_item" as const, id: source.id, revision: 1 } } : {}),
          };
    const hidden = {
      ...basis,
      eventCursor: 2,
      canvasItems: basis.canvasItems.map((item) =>
        item.id === source.id ? { ...item, visible: false } : item,
      ),
      generationSpecs: [
        {
          ...spec,
          prompt: "",
          promptContent: [{ type: "reference" as const, referenceId: ref.id }],
        },
      ],
      references: [reference],
    };
    client.install(hidden);
    const rendered = await projection.read();
    assert.equal(rendered.edges.length, binding === "pinned" ? 0 : 1);
    assert.equal(rendered.hiddenNodes?.[0]?.id, source.id);
    const current = rendered.nodes[0]!;
    assert.equal(
      current.data.promptMentions?.[0]?.referenceId,
      ref.id,
    );
    projection.baseline = rendered;
    projection.basis = hidden;
    client.batches = [];
    if (binding === "pinned") {
      const replacementId = crypto.randomUUID();
      const replacement = generationContentPatch([
        { type: "text", text: "Keep " },
        {
          type: "reference",
          binding: "asset",
          assetId: asset.id,
          referenceId: replacementId,
          name: asset.name,
          fingerprint: asset.fingerprint,
        },
      ]);
      await projection.save({
        ...rendered,
        nodes: [{ ...current, data: { ...current.data, ...replacement } }],
      });
      const operations = client.batches[0]!.operations;
      const removeIndex = operations.findIndex(
        (op) =>
          op.type === "reference.remove" && op.payload.referenceId === ref.id,
      );
      const addIndex = operations.findIndex(
        (op) =>
          op.type === "reference.add" &&
          op.payload.reference.id === replacementId,
      );
      assert.ok(removeIndex >= 0 && addIndex > removeIndex);
      const prompt = operations.find(
        (op) => op.type === "generationSpec.setPrompt",
      );
      assert.ok(prompt?.type === "generationSpec.setPrompt");
      assert.deepEqual(prompt.payload.promptContent, [
        { type: "text", text: "Keep " },
        { type: "reference", referenceId: replacementId },
      ]);
      projection.baseline = rendered;
      projection.basis = hidden;
      client.batches = [];
    }
    await projection.save({
      ...rendered,
      nodes: [
        {
          ...current,
          data: {
            ...current.data,
            prompt: current.data.prompt + " with extra instructions",
          },
        },
      ],
    });
    const update = client.batches[0]!.operations.find(
      (op) => op.type === "generationSpec.setPrompt",
    );
    assert.equal(update?.type, "generationSpec.setPrompt");
    if (update?.type === "generationSpec.setPrompt")
      assert.equal(
        update.payload.promptContent?.some(
          (part) => part.type === "reference" && part.referenceId === ref.id,
        ),
        true,
      );
    const inactive = { ...reference, active: false, revision: 2 };
    const removed = {
      ...hidden,
      references: [inactive],
      generationSpecs: [{ ...spec, promptContent: [], prompt: "" }],
    };
    client.install(removed);
    const blank = await projection.read();
    projection.baseline = blank;
    projection.basis = removed;
    client.batches = [];
    await projection.save({
      ...blank,
      nodes: rendered.nodes,
      edges: rendered.edges,
    });
    const restored = client.batches[0]!;
    const restore = restored.operations.find(
      (op) => op.type === "reference.restore",
    );
    assert.equal(restore?.type, "reference.restore");
    if (restore?.type === "reference.restore") {
      assert.equal(restore.payload.reference.id, ref.id);
      assert.equal(restore.payload.reference.revision, 2);
      assert.equal(restore.payload.reference.active, true);
    }
    assert.ok(
      restored.versions.some(
        (version) =>
          version.objectType === "reference" &&
          version.id === ref.id &&
          version.revision === 2,
      ),
    );
    const prompt = restored.operations.find(
      (op) => op.type === "generationSpec.setPrompt",
    );
    if (binding === "pinned")
      assert.ok(
        prompt?.type === "generationSpec.setPrompt" &&
          prompt.payload.promptContent?.some(
            (part) => part.type === "reference" && part.referenceId === ref.id,
          ),
      );
    if (binding === "pinned") {
      const unpositioned = {
        ...hidden,
        generationSpecs: [
          { ...spec, prompt: "Plain instructions", promptContent: null },
        ],
      };
      client.install(unpositioned);
      const document = await projection.read();
      const targetNode = document.nodes[0]!;
      assert.equal(
        targetNode.data.promptContent?.find((part) => part.type === "reference")
          ?.referenceId,
        ref.id,
      );
      projection.baseline = document;
      projection.basis = unpositioned;
      client.batches = [];
      const { generationContentPatch } =
        await import("../src/canvas/generationReferenceContent.ts");
      await projection.save({
        ...document,
        nodes: [
          {
            ...targetNode,
            data: {
              ...targetNode.data,
              ...generationContentPatch([
                { type: "text", text: "Retained instructions" },
              ]),
            },
          },
        ],
      });
      assert.ok(
        client.batches[0]!.operations.some(
          (op) =>
            op.type === "reference.remove" && op.payload.referenceId === ref.id,
        ),
      );
    }
  }
});

test("cancel while refreshing a queued submit never sends a generation command", async () => {
  const snapshot = empty(),
    client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  let release!: () => void;
  client.refresh = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return snapshot;
  };
  let commands = 0;
  client.command = async () => {
    commands++;
    throw new Error("unexpected delivery");
  };
  const controller = new AbortController();
  const pending = client.submit(
    "node",
    "if_current",
    undefined,
    controller.signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  release();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(commands, 0);
});

test("cancel compares the same execution after confirmed progress conflicts, never retries unknown delivery or recovery", async () => {
  for (const scenario of [
    "progress",
    "unknown",
    "changed-input",
    "recover",
  ] as const) {
    const snapshot = JSON.parse(
      readFileSync(
        new URL("./fixtures/creation-project.json", import.meta.url),
        "utf8",
      ),
    ) as ProjectSnapshot;
    const client = new CreationClient(snapshot.project.id);
    let job = { ...snapshot.jobs[0]!, status: "running" as const };
    client.install({ ...snapshot, jobs: [job] });
    client.refresh = async () => {
      client.install({ ...snapshot, jobs: [job] });
      return client.snapshot;
    };
    let calls = 0;
    client.command = async (_type, _payload, versions) => {
      calls++;
      assert.equal(versions?.[0]?.revision, job.revision);
      if (calls === 1) {
        if (scenario === "unknown") throw new TypeError("receipt unavailable");
        job = {
          ...job,
          revision: job.revision + 1,
          ...(scenario === "changed-input"
            ? { inputFingerprint: "b".repeat(64) }
            : {}),
        };
        throw new CreationCommandError({
          commandId: crypto.randomUUID(),
          projectId: client.id,
          inputFingerprint: "a".repeat(64),
          status: "rejected",
          changed: [],
          jobIds: [],
          issues: [
            {
              code: "revision_conflict",
              message: "checkpoint advanced",
              objectId: job.id,
              field: null,
            },
          ],
          eventCursor: 1,
        });
      }
      return {
        commandId: crypto.randomUUID(),
        projectId: client.id,
        inputFingerprint: "a".repeat(64),
        status: "applied",
        changed: [],
        jobIds: [],
        issues: [],
        eventCursor: 2,
      };
    };
    const result = client.control(
      job.id,
      scenario === "recover" ? "recover" : "cancel",
    );
    if (scenario === "progress") {
      assert.equal((await result).status, "applied");
      assert.equal(calls, 2);
    } else {
      await assert.rejects(result);
      assert.equal(calls, 1);
    }
  }
});

test("an older square audio card projects as the compact control strip", async () => {
  const snapshot = empty();
  const audio = createNode("audio", { x: 10, y: 20 }, { title: "Voice" });
  const item: CanvasItem = {
    id: audio.id,
    projectId: snapshot.project.id,
    revision: 1,
    kind: "audio",
    title: audio.data.title,
    position: audio.position,
    width: 300,
    height: 300,
    locked: false,
    visible: true,
    zIndex: 0,
    parentId: null,
    tags: [],
    editors: [],
    binding: { role: "empty", draftSpec: null, manualText: null },
  };
  const basis = { ...snapshot, canvasItems: [item] };
  const client = new CommandCapture(snapshot.project.id);
  client.install(basis);
  const document = await new CreationProjection(client).read(basis);
  assert.equal(document.nodes[0]?.width, 300);
  assert.equal(document.nodes[0]?.height, 112);
});

test("a viewport-only save skips business preparation and batching", async () => {
  const snapshot = empty();
  const client = new CommandCapture(snapshot.project.id);
  client.install(snapshot);
  const projection = new CreationProjection(client);
  const document = {
    ...createDocument(),
    id: client.id,
    title: snapshot.project.name,
  };
  projection.prepare = async () => {
    throw new Error("view-only save must not prepare");
  };
  client.batch = async () => {
    throw new Error("view-only save must not batch");
  };
  await projection.saveView(document);
  assert.equal(projection.viewError, "");
});

test("clean business flush skips preparation and preserves the basis of unseen changes", async () => {
  const snapshot = empty();
  const client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  const projection = new CreationProjection(client);
  const document = {
    ...createDocument(),
    id: client.id,
    title: snapshot.project.name,
  };
  projection.basis = snapshot;
  projection.baseline = document;
  let batches = 0;
  client.batch = async (operations) => {
    batches++;
    assert.deepEqual(operations, []);
    return undefined;
  };
  client.view = async () => {
    throw new Error("history must not save view state");
  };
  const prepare = projection.prepare.bind(projection);
  projection.prepare = async () => {
    throw new Error("clean flush must not prepare");
  };
  client.install({ ...snapshot, eventCursor: snapshot.eventCursor + 1 });
  assert.equal(await projection.save(document, { saveView: false }), false);
  assert.equal(batches, 0);
  assert.equal(projection.basis, snapshot);
  assert.equal(projection.viewError, "");
  projection.prepare = prepare;
  // Normal saves still retain their independent view-state failure reporting.
  await projection.save(document);
  assert.match(projection.viewError, /must not save view/);
});

test("opening a project reads one snapshot that already carries reference edges", async () => {
  const original = globalThis.fetch;
  const snapshot = empty();
  const edge = { referenceId: crypto.randomUUID(), state: "used" as const };
  const requests: { path: string; method: string }[] = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url),
      method = options.method ?? "GET";
    requests.push({ path, method });
    if (path.endsWith("/open-canvas"))
      return Response.json({ snapshot, edges: [edge] });
    if (path.includes("/views/")) return new Response(null, { status: 204 });
    if (path.includes("/subscribe"))
      return new Response(new ReadableStream({ start() {} }));
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  const client = new CreationClient(snapshot.project.id);
  let duringInstall: string | undefined;
  client.listen(() => {
    duringInstall = client.referenceStates.get(edge.referenceId);
  });
  try {
    await client.open();
    assert.deepEqual(client.snapshot, snapshot);
    assert.equal(client.referenceStates.get(edge.referenceId), "used");
    // install() notifies listeners; they must already see the open-canvas edges.
    assert.equal(duringInstall, "used");
    assert.equal(
      requests.filter((request) => request.path.endsWith("/open-canvas"))
        .length,
      1,
    );
    assert.equal(
      requests.filter((request) => request.path.endsWith("/open")).length,
      0,
    );
    // The canvas projection is not read again just to learn the edges.
    assert.equal(
      requests.filter((request) => request.path.endsWith("/canvas")).length,
      0,
    );
    assert.equal(
      requests.filter((request) => request.path.includes("/views/")).length,
      1,
    );
  } finally {
    client.close();
    globalThis.fetch = original;
  }
});

test("a server that returns a bare snapshot falls back to the canvas read", async () => {
  const original = globalThis.fetch;
  const snapshot = empty();
  const edge = { referenceId: crypto.randomUUID(), state: "pending" as const };
  const requests: string[] = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    requests.push(`${options.method ?? "GET"} ${path}`);
    if (path.endsWith("/open-canvas")) return Response.json(snapshot);
    if (path.endsWith("/canvas")) return Response.json({ snapshot, edges: [edge] });
    if (path.includes("/views/")) return new Response(null, { status: 204 });
    if (path.includes("/subscribe"))
      return new Response(new ReadableStream({ start() {} }));
    throw new Error(`Unexpected request ${path}`);
  };
  const client = new CreationClient(snapshot.project.id);
  try {
    await client.open();
    assert.equal(client.referenceStates.get(edge.referenceId), "pending");
    assert.equal(
      requests.filter((request) => request.endsWith("/canvas")).length,
      1,
    );
  } finally {
    client.close();
    globalThis.fetch = original;
  }
});

test("a no-op save skips command batches and unchanged view writes", async () => {
  const original = globalThis.fetch;
  const snapshot = empty();
  const client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  const projection = new CreationProjection(client);
  const document = { ...createDocument("Test"), id: snapshot.project.id };
  projection.baseline = document;
  const requests: { path: string; method: string }[] = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    requests.push({ path, method: options.method ?? "GET" });
    if (path.includes("/views/")) return new Response(null, { status: 204 });
    throw new Error(`Unexpected request ${options.method ?? "GET"} ${path}`);
  };
  try {
    assert.equal(await projection.save(document), false);
    assert.equal(
      requests.filter((request) => request.method === "PUT").length,
      0,
    );
    assert.equal(
      requests.filter((request) => request.path.endsWith("/commands")).length,
      0,
    );
    // The one lazy view read is shared; the identical viewport is not rewritten.
    assert.equal(
      requests.filter((request) => request.path.includes("/views/")).length,
      1,
    );
    // A real viewport change still persists, without touching the command log.
    await projection.saveView({
      ...document,
      viewport: { x: 12, y: -4, zoom: 2 },
    });
    const puts = requests.filter((request) => request.method === "PUT");
    assert.equal(puts.length, 1);
    assert.ok(puts[0]!.path.includes("/views/"));
    assert.equal(
      requests.filter((request) => request.path.endsWith("/commands")).length,
      0,
    );
  } finally {
    globalThis.fetch = original;
  }
});
