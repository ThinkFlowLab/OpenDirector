import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { assetSource } from "../src/backend/assetSource.ts";
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
  MEDIA_PRIORITY,
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

test("original media refuses orphaned HEIF previews and preserves ordinary drafts", async () => {
  const snapshot = empty(), client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  const original = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (input) => {
    requested.push(String(input));
    return new Response("original", { headers: { "Content-Type": "image/heic" } });
  };
  try {
    for (const suffix of ["heic", "heif"])
      await assert.rejects(client.originalMedia("blob:display", `image/${suffix}`), /素材|media/);
    assert.equal(requested.length, 0);
    const asset = { id: crypto.randomUUID(), metadata: { mimeType: "image/heic" } } as Asset;
    client.install({ ...snapshot, assets: [asset] });
    client.rememberSource("blob:display", asset.id);
    assert.equal(await (await client.originalMedia("blob:display", "image/heic")).text(), "original");
    assert.ok(requested[0]!.endsWith(`/assets/${asset.id}/content`));
    await client.originalMedia("blob:draft", "image/png");
    assert.equal(requested[1], "blob:draft");
  } finally {
    globalThis.fetch = original;
  }
});

test("HEIF file import rejects unavailable previews without returning an empty resource", async () => {
  const snapshot = empty(), client = new CreationClient(snapshot.project.id);
  const asset = {
    id: crypto.randomUUID(), kind: "image", revision: 1, fingerprint: "original",
    name: "photo.heic", metadata: { mimeType: "image/heic", size: 100, width: 10, height: 20 },
  } as Asset;
  client.install({ ...snapshot, assets: [asset] });
  client.importBlob = async () => assetReference(asset);
  const error = new Error("preview unavailable");
  client.mediaUrl = async () => { throw error; };
  const projection = new CreationProjection(client);
  for (const suffix of ["heic", "heif"]) {
    await assert.rejects(
      projection.importFile(new File(["original"], `photo.${suffix}`, { type: "application/octet-stream" })),
      value => value === error,
    );
  }
  assert.equal(client.snapshot.assets[0], asset);
});

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

test("group assembly begins after queued writes and allows edits while rendering", { timeout: 3000 }, async () => {
  const original = globalThis.fetch;
  const snapshot = empty();
  const client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  const gate = () => {
    let resolve = () => {};
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  };
  const priorWrite = gate();
  const render = gate();
  const started = gate();
  const writes: string[] = [];
  let assemblyCompleted = false;
  globalThis.fetch = async (url, options) => {
    if (!String(url).endsWith("/commands")) return Response.json({ snapshot, edges: [] });
    assert.equal(typeof options?.body, "string");
    if (typeof options?.body !== "string") throw new Error("Expected command body");
    const body = JSON.parse(options.body);
    writes.push(body.type);
    if (body.type === "canvas.move") await priorWrite.promise;
    if (body.type === "group.assemble") {
      started.resolve();
      await render.promise;
      assemblyCompleted = true;
    }
    return Response.json({ commandId: body.commandId, status: "applied" });
  };
  try {
    const itemId = crypto.randomUUID();
    const pendingMove = client.command("canvas.move", { items: [{ itemId, position: { x: 9, y: 5 } }] });
    const pendingAssembly = client.command("group.assemble", { groupId: crypto.randomUUID(), jobIds: [crypto.randomUUID()] });
    await Promise.resolve();
    assert.ok(!writes.includes("group.assemble"));
    priorWrite.resolve();
    await pendingMove;
    await started.promise;
    await client.command("canvas.hide", { itemId });
    assert.deepEqual(writes, ["canvas.move", "group.assemble", "canvas.hide"]);
    assert.equal(assemblyCompleted, false);
    render.resolve();
    await pendingAssembly;
  } finally {
    priorWrite.resolve();
    render.resolve();
    globalThis.fetch = original;
  }
});

test("an in-progress assembly waits for the original command receipt", { timeout: 6000 }, async () => {
  const original = globalThis.fetch;
  const snapshot = empty();
  const client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  const commandId = crypto.randomUUID();
  const receipt = { commandId, status: "applied" };
  let submissions = 0;
  let receiptReads = 0;
  globalThis.fetch = async (url, options) => {
    const path = String(url);
    if (path.endsWith("/commands")) {
      submissions++;
      return Response.json({ code: "workflow_assembly_busy" }, { status: 409 });
    }
    if (path.endsWith(`/receipts/${commandId}`)) {
      assert.ok(options?.signal);
      receiptReads++;
      if (receiptReads === 1) return Response.json({}, { status: 404 });
      return Response.json(receipt);
    }
    return Response.json({ snapshot, edges: [] });
  };
  try {
    const result = await client.command("group.assemble", {
      groupId: crypto.randomUUID(), jobIds: [crypto.randomUUID()],
    }, [], undefined, commandId);
    assert.deepEqual(result, receipt);
    assert.equal(submissions, 1);
    assert.equal(receiptReads, 2);
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

test("a confirmed generation rejection is not replayed after reload when refresh fails", async () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const saved = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
      removeItem: (key: string) => saved.delete(key),
    },
  });
  const previousFetch = globalThis.fetch;
  const snapshot = empty();
  const client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  const commandIds: string[] = [];
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).endsWith("/commands"));
    const { commandId } = JSON.parse(options!.body as string);
    commandIds.push(commandId);
    // The server returns the same rejection when the original ID is replayed.
    const rejected = commandId === commandIds[0];
    return Response.json({
      commandId,
      projectId: snapshot.project.id,
      status: rejected ? "rejected" : "accepted",
      inputFingerprint: "a".repeat(64),
      changed: [],
      jobIds: rejected ? [] : [crypto.randomUUID()],
      issues: rejected ? [{ code: "capability_unavailable", message: "First frame unsupported" }] : [],
      eventCursor: 1,
    });
  };
  client.refresh = async () => { throw new TypeError("connection lost after rejection"); };
  const payload = { specId: crypto.randomUUID(), expectedSpecRevision: 1 };
  try {
    const first = await client.command("generation.submit", payload).catch((error) => error);
    const reopened = new CreationClient(snapshot.project.id);
    reopened.install(snapshot);
    reopened.refresh = async () => snapshot;
    assert.equal((await reopened.command("generation.submit", payload)).status, "accepted");
    assert.notEqual(commandIds[0], commandIds[1]);
    assert.ok(first instanceof CreationCommandError);
    assert.equal(first.receipt.issues[0]?.code, "capability_unavailable");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage)
      Object.defineProperty(globalThis, "sessionStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
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
      faceEmphasis: false,
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

test("cancelling a staged Blob upload deletes the handle before registering an asset", async () => {
  const snapshot = empty();
  const client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  const signal = new AbortController();
  const handle = crypto.randomUUID();
  const path = `/api/creation/projects/${snapshot.project.id}/uploads/${handle}`;
  const calls: [string, string][] = [];
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const method = options?.method ?? "GET";
    calls.push([String(url), method]);
    if (method === "PUT") {
      assert.equal(options?.signal, signal.signal);
      signal.abort();
    } else {
      assert.equal(options?.signal?.aborted ?? false, false);
    }
    return Response.json({});
  };
  try {
    await assert.rejects(
      client.importBlob(new Blob(["image"]), "image.png", "image", handle, undefined, signal.signal),
      { name: "AbortError" },
    );
    assert.deepEqual(calls, [[path, "PUT"], [path, "DELETE"]]);
  } finally {
    globalThis.fetch = fetch;
  }
});

test("canvas video and audio import preview original File bytes without downloading them again", async () => {
  const snapshot = empty();
  const client = new CreationClient(snapshot.project.id);
  const projection = new CreationProjection(client);
  const signal = new AbortController().signal;
  for (const [kind, name, mimeType] of [
    ["video", "Windows on SteamDeck！上手测试.mp4", "video/mp4"],
    ["audio", "voice.wav", "audio/wav"],
  ] as const) {
    const file = new File(["original bytes"], name, {
      type: kind === "audio" ? "application/octet-stream" : mimeType,
    });
    const asset = {
      id: crypto.randomUUID(), kind, name, revision: 1, fingerprint: "original",
      metadata: { mimeType, size: file.size, durationSeconds: 2 },
    } as Asset;
    client.install({ ...snapshot, assets: [asset] });
    client.importBlob = async (body, filename, mediaKind, _handle, _origin, uploadSignal) => {
      assert.equal(body, file);
      assert.equal(filename, name);
      assert.equal(mediaKind, kind);
      assert.equal(uploadSignal, signal);
      return assetReference(asset);
    };
    client.blob = async () => assert.fail("Imported media was fetched again");
    const resource = await projection.importFile(file, signal);
    assert.equal(resource.assetId, asset.id);
    assert.equal(resource.durationSeconds, 2);
    assert.equal(resource.src, assetSource(client.id, asset.id));
  }
});

function mediaFixture() {
  const snapshot = JSON.parse(
    readFileSync(
      new URL("./fixtures/creation-project.json", import.meta.url),
      "utf8",
    ),
  ) as ProjectSnapshot;
  const client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  client.textContent = async () => "fixture text";
  client.view = async () => ({
    projectId: client.id,
    clientId: "fixture",
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedItemIds: [],
    activeEditorId: null,
    playheads: [],
    generationCounts: {},
  });
  return { client, snapshot };
}

test("canvas structure is projected without waiting for any node media", async () => {
  const { client, snapshot } = mediaFixture();
  let mediaReads = 0;
  client.mediaUrl = () => {
    mediaReads += 1;
    return new Promise<string>(() => {});
  };
  const document = await new CreationProjection(client).read();
  assert.equal(mediaReads, 0);
  assert.equal(
    document.nodes.length + (document.hiddenNodes?.length ?? 0),
    snapshot.canvasItems.length,
  );
  const image = document.nodes.find(
    (node) => node.type === "image" && node.data.backendAssetId,
  )!;
  assert.equal(
    image.data.src,
    assetSource(client.id, image.data.backendAssetId!),
  );
  assert.equal(image.data.assetState, "ready");
});

test("a display URL for the current asset is not saved as new material", async () => {
  const { client, snapshot } = mediaFixture();
  const operations: CreationOperation[] = [];
  client.batch = async (next) => {
    operations.push(...next);
    return undefined;
  };
  const projection = new CreationProjection(client);
  const document = await projection.read();
  projection.baseline = document;
  projection.basis = snapshot;
  const edited = structuredClone(document);
  const image = edited.nodes.find(
    (node) => node.type === "image" && node.data.backendAssetId,
  )!;
  client.rememberSource("blob:displayed", image.data.backendAssetId!);
  image.data.src = "blob:displayed";
  await projection.save(edited, { saveView: false });
  assert.ok(!operations.some((op) => op.type === "canvas.materialize"));
});

test("opening a canvas keeps text with the snapshot and reads originals by asset", async () => {
  const original = globalThis.fetch;
  const { snapshot } = mediaFixture();
  const text = snapshot.assets.find((asset) => asset.kind === "text")!;
  const image = snapshot.assets.find((asset) => asset.kind === "image")!;
  const paths: string[] = [];
  globalThis.fetch = async (url) => {
    const path = String(url);
    paths.push(path);
    if (path.endsWith("/open-canvas"))
      return Response.json({
        snapshot,
        edges: [],
        texts: { [text.id]: "kept with structure" },
      });
    if (path.includes("/views/")) return new Response(null, { status: 204 });
    if (path.includes("/subscribe"))
      return new Response(new ReadableStream({ start() {} }));
    if (path.endsWith(`/assets/${image.id}/content`))
      return new Response("original", { status: 200 });
    throw new Error(`Unexpected request ${path}`);
  };
  const client = new CreationClient(snapshot.project.id);
  try {
    await client.open();
    assert.equal(await client.textContent(text.id), "kept with structure");
    assert.ok(!paths.some((path) => path.includes(`/assets/${text.id}/`)));
    const source = assetSource(client.id, image.id);
    assert.equal(client.assetForSource(source)?.id, image.id);
    assert.equal(client.assetForSource(assetSource("other", image.id)), undefined);
    assert.equal(await (await client.originalMedia(source)).text(), "original");
    // Displayed bytes are reused directly: the desktop CSP blocks fetching blob URLs.
    const url = await client.mediaUrl(image.id);
    const reads = paths.length;
    assert.equal(await (await client.originalMedia(source)).text(), "original");
    assert.equal(paths.length, reads);
    assert.ok(!paths.includes(url));
  } finally {
    client.close();
    globalThis.fetch = original;
  }
});

test("an upload rejected for a lapsed lease is renewed and resent with the same file", async () => {
  const { setLeaseRecovery } = await import("../src/backend/api.ts");
  const snapshot = empty();
  const client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  const signal = new AbortController();
  const handle = crypto.randomUUID();
  const path = `/api/creation/projects/${snapshot.project.id}/uploads/${handle}`;
  const blob = new Blob(["rendered timeline"]);
  const puts: { body: unknown; name: string | null; session: string | null }[] = [];
  const renewed: string[] = [];
  const fetch = globalThis.fetch;
  setLeaseRecovery(async (projectId) => {
    renewed.push(projectId);
    return true;
  });
  globalThis.fetch = async (url, options) => {
    if ((options?.method ?? "GET") !== "PUT") return Response.json({});
    assert.equal(String(url), path);
    const headers = new Headers(options?.headers);
    puts.push({ body: options?.body, name: headers.get("X-Asset-Name"), session: headers.get("X-OpenDirector-Session") });
    if (puts.length === 1)
      return Response.json({ detail: "会话已过期", code: "session_expired" }, { status: 409 });
    // Stop before registration; the resend itself is what is under test.
    signal.abort();
    return Response.json({ fingerprint: "sha256:x" });
  };
  try {
    await assert.rejects(
      client.importBlob(blob, "合回原声 2.mp4", "video", handle, "edited", signal.signal),
      { name: "AbortError" },
    );
    assert.deepEqual(renewed, [snapshot.project.id]);
    assert.equal(puts.length, 2);
    for (const put of puts) {
      assert.equal(put.body, blob);
      assert.equal(put.name, encodeURIComponent("合回原声 2.mp4"));
      assert.ok(put.session);
    }
  } finally {
    globalThis.fetch = fetch;
    setLeaseRecovery(undefined);
  }
});

test("display reads stop only after every on-screen consumer leaves", async () => {
  const original = globalThis.fetch;
  const { client, snapshot } = mediaFixture();
  const image = snapshot.assets.find((asset) => asset.kind === "image")!;
  const signals: AbortSignal[] = [];
  globalThis.fetch = (async (_url, options) => {
    signals.push(options!.signal!);
    return new Promise<Response>((_, reject) => {
      options!.signal!.addEventListener("abort", () =>
        reject(options!.signal!.reason),
      );
    });
  }) as typeof fetch;
  try {
    const first = new AbortController();
    const second = new AbortController();
    const visible = { priority: MEDIA_PRIORITY.visible };
    const reads = [
      client.mediaUrl(image.id, { ...visible, signal: first.signal }),
      client.mediaUrl(image.id, { ...visible, signal: second.signal }),
    ];
    const settled = Promise.allSettled(reads);
    await new Promise((resolve) => setTimeout(resolve));
    assert.equal(signals.length, 1);
    first.abort();
    await new Promise((resolve) => setTimeout(resolve));
    assert.equal(signals[0]!.aborted, false);
    second.abort();
    await settled;
    await new Promise((resolve) => setTimeout(resolve));
    assert.equal(signals[0]!.aborted, true);
    // Scrolling away says nothing about the file, so the node stays available.
    assert.equal(client.mediaUnavailable(image.id), false);
  } finally {
    client.close();
    globalThis.fetch = original;
  }
});

test("a failed display read is reported and recovers on retry", async () => {
  const original = globalThis.fetch;
  const { client, snapshot } = mediaFixture();
  const image = snapshot.assets.find((asset) => asset.kind === "image")!;
  let healthy = false;
  let notifications = 0;
  client.listenMedia(() => (notifications += 1));
  globalThis.fetch = (async () =>
    healthy
      ? new Response("bytes", { headers: { "content-type": "image/png" } })
      : Response.json(
          { code: "storage_unavailable", detail: "missing" },
          { status: 409 },
        )) as typeof fetch;
  try {
    await assert.rejects(client.mediaUrl(image.id));
    assert.equal(client.mediaUnavailable(image.id), true);
    healthy = true;
    assert.match(await client.mediaUrl(image.id), /^blob:/);
    assert.equal(client.mediaUnavailable(image.id), false);
    assert.equal(notifications, 2);
  } finally {
    client.close();
    globalThis.fetch = original;
  }
  client.close();
});
