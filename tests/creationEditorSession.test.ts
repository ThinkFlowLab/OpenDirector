import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CreationClient,
  CreationCommandError,
} from "../src/backend/creationClient.ts";
import { CreationProjection } from "../src/backend/creationProjection.ts";
import { CreationEditorSession } from "../src/backend/creationEditorSession.ts";
import type {
  ProjectSnapshot,
  CommandReceipt,
} from "../src/contracts/generated.ts";

async function fixture() {
  const snapshot = JSON.parse(
    readFileSync(
      new URL("./fixtures/creation-project.json", import.meta.url),
      "utf8",
    ),
  ) as ProjectSnapshot;
  const item = snapshot.canvasItems.find((i) => i.kind === "timeline")!;
  const client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  client.mediaUrl = async (id) => `blob:${id}`;
  client.textContent = async () => "fixture text";
  client.assetForSource = (src) =>
    snapshot.assets.find((a) => `blob:${a.id}` === src);
  client.view = async () => ({
    projectId: client.id,
    clientId: "fixture",
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedItemIds: [],
    activeEditorId: null,
    playheads: [],
    generationCounts: {},
  });
  const projection = new CreationProjection(client);
  const document = await projection.read();
  projection.baseline = document;
  projection.basis = snapshot;
  return { client, projection, document, item, snapshot };
}

test("an open editor retains its version basis after another writer changes the document", async () => {
  const { client, document, item, snapshot } = await fixture();
  const session = new CreationEditorSession(client, document, item.id);
  const timeline = structuredClone(
    document.nodes.find((n) => n.id === item.id)!.data.timeline!,
  );
  timeline.fps = timeline.fps === 24 ? 30 : 24;
  const editorId =
    item.binding.role === "editor" ? item.binding.objectRef.id : "";
  const original = snapshot.editorDocuments.find((d) => d.id === editorId)!;
  client.install({
    ...snapshot,
    eventCursor: snapshot.eventCursor + 1,
    editorDocuments: snapshot.editorDocuments.map((d) =>
      d.id === editorId ? { ...d, revision: d.revision + 1 } : d,
    ),
  });
  client.command = async (_type, _payload, versions) => {
    assert.equal(
      versions!.find((v) => v.id === editorId)!.revision,
      original.revision,
    );
    throw new CreationCommandError({
      issues: [{ code: "revision_conflict", message: "stale" }],
    } as unknown as CommandReceipt);
  };
  await assert.rejects(session.apply({ timeline }), /stale/);
  await assert.rejects(session.apply({ timeline }), /stale/);
  assert.equal(
    session.projection.basis.editorDocuments.find((d) => d.id === editorId)!
      .revision,
    original.revision,
  );
});

test("unknown editor delivery reuses exact command, new IDs and inputs across retries", async () => {
  const { client, document, item } = await fixture();
  const session = new CreationEditorSession(client, document, item.id);
  const timeline = structuredClone(
    document.nodes.find((n) => n.id === item.id)!.data.timeline!,
  );
  timeline.width += 2;
  const calls: unknown[] = [];
  client.command = async (...args) => {
    calls.push(structuredClone(args));
    if (calls.length === 1) throw new TypeError("offline");
    return { status: "applied" } as CommandReceipt;
  };
  await assert.rejects(session.apply({ timeline }), /offline/);
  await session.apply({ timeline });
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(
    session.projection.baseline.nodes.find((n) => n.id === item.id)!.data
      .timeline!.width,
    timeline.width,
  );
});

test("failed view saving cannot roll back an acknowledged business save or cause resubmission", async () => {
  const { client, projection, document } = await fixture();
  const edited = structuredClone(document);
  edited.nodes[0]!.position.x += 40;
  let batches = 0;
  client.batch = async (operations) => {
    if (operations.length) batches++;
    return undefined;
  };
  client.view = async () => {
    throw new Error("view unavailable");
  };
  assert.equal(await projection.save(edited), true);
  assert.equal(projection.baseline, edited);
  assert.match(projection.viewError, /view unavailable/);
  await projection.save(edited);
  assert.equal(batches, 1);
});

test("unchanged editor inputs still validate their original versions before rendering", async () => {
  const { client, document, item } = await fixture();
  const session = new CreationEditorSession(client, document, item.id);
  client.command = async (_type, payload, versions) => {
    assert.ok(
      "operations" in payload &&
        payload.operations.some((op) => op.type === "canvas.update"),
    );
    assert.ok(versions!.some((v) => v.objectType === "editor_document"));
    throw new CreationCommandError({
      issues: [{ code: "revision_conflict", message: "changed while open" }],
    } as unknown as CommandReceipt);
  };
  await assert.rejects(
    session.apply({
      timeline: document.nodes.find((n) => n.id === item.id)!.data.timeline,
    }),
    /changed while open/,
  );
});

test("a lost delivery survives a new editor session and resolves before a changed draft can be submitted", async (t) => {
  const original = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage",
  );
  const saved = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => saved.set(k, v),
      removeItem: (k: string) => saved.delete(k),
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  });
  const { client, document, item } = await fixture();
  const timeline = structuredClone(
    document.nodes.find((n) => n.id === item.id)!.data.timeline!,
  );
  timeline.width += 2;
  const calls: unknown[] = [];
  client.command = async (...args) => {
    calls.push(structuredClone(args));
    if (calls.length === 1) throw Error("unknown reply");
    return { status: "applied" } as CommandReceipt;
  };
  await assert.rejects(
    new CreationEditorSession(client, document, item.id).apply({ timeline }),
    /unknown reply/,
  );
  const resumed = new CreationEditorSession(client, document, item.id);
  await assert.rejects(
    resumed.apply({ timeline: { ...timeline, width: timeline.width + 2 } }),
    /上一次编辑保存已确认/,
  );
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(saved.size, 0);
});

test("dissolving a stack prepares one atomic edit and keeps its draft after rejection", async () => {
  const { client, document, snapshot } = await fixture();
  const item = snapshot.canvasItems.find((i) => i.kind === "stack")!;
  const session = new CreationEditorSession(client, document, item.id);
  const original = structuredClone(document);
  const deliveries: unknown[] = [];
  client.command = async (_type, payload, versions) => {
    assert.ok("operations" in payload);
    assert.ok(
      payload.operations.some(
        (op) => op.type === "canvas.hide" && op.payload.itemId === item.id,
      ),
    );
    assert.ok(
      versions!.some(
        (v) =>
          v.objectType === "canvas_item" &&
          v.id === item.id &&
          v.revision === item.revision,
      ),
    );
    deliveries.push(structuredClone(payload));
    throw new CreationCommandError({
      issues: [{ code: "locked", message: "stack locked" }],
    } as unknown as CommandReceipt);
  };
  await assert.rejects(
    session.apply({ stack: { nodeIds: [], activeIndex: 0 } }),
    /stack locked/,
  );
  await assert.rejects(
    session.apply({ stack: { nodeIds: [], activeIndex: 0 } }),
    /stack locked/,
  );
  assert.deepEqual(deliveries[0], deliveries[1]);
  assert.deepEqual(document, original);
  assert.deepEqual(session.projection.baseline, original);
});

test("timeline text fonts and immutable sources project both ways through the shared editor.save command", async () => {
  const { client, projection, document, item, snapshot } = await fixture();
  const font = snapshot.assets.find((a) => a.kind === "file")!,
    source = snapshot.assets.find((a) => a.kind === "text")!;
  const ref = (a: typeof font) => ({
    assetId: a.id,
    revision: a.revision,
    fingerprint: a.fingerprint,
    kind: a.kind,
  });
  const saved = snapshot.editorDocuments.find((d) => d.kind === "timeline")!;
  const enriched = {
    ...saved,
    data: {
      ...saved.data,
      fonts: [{ id: "font", title: "Fixture font", asset: ref(font) }],
      overlays: [
        {
          id: "a",
          start: 1,
          end: 3,
          text: "中文\nMixed",
          x: 0.1,
          y: 0.8,
          maxWidth: 0.8,
          fontId: "font",
          style: {
            fontSize: 18,
            color: "#FFFFFF",
            align: "center",
            lineHeight: 1.2,
            background: null,
            stroke: null,
          },
          sourceAsset: ref(source),
        },
      ],
    },
  };
  const view = await projection.editorData(enriched as never);
  assert.equal(view.timeline!.fonts![0]!.src, `blob:${font.id}`);
  assert.deepEqual(view.timeline!.overlays![0]!.source!.asset, ref(source));
  const node = document.nodes.find((n) => n.id === item.id)!;
  Object.assign(node.data, view);
  projection.baseline = structuredClone(document);
  const session = new CreationEditorSession(client, document, item.id);
  const edited = structuredClone(view.timeline!);
  edited.overlays![0]!.text = "Agent 与 UI 继续编辑";
  const operations: unknown[] = [];
  client.command = async (type, payload) => {
    operations.push({ type, payload });
    return { status: "applied" } as CommandReceipt;
  };
  await session.apply({ timeline: edited });
  const batch = operations[0] as {
    type: string;
    payload: {
      operations: {
        type: string;
        payload: { document: { data: Record<string, unknown> } };
      }[];
    };
  };
  const command =
    batch.type === "creation.batch"
      ? batch.payload.operations.find((o) => o.type === "editor.save")!
      : (operations[0] as (typeof batch.payload.operations)[number]);
  assert.equal(command.type, "editor.save");
  const data = command.payload.document.data as {
    fonts: { asset: unknown }[];
    overlays: { text: string; sourceAsset: unknown }[];
  };
  assert.equal(data.overlays[0]!.text, "Agent 与 UI 继续编辑");
  assert.deepEqual(data.fonts[0]!.asset, ref(font));
  assert.deepEqual(data.overlays[0]!.sourceAsset, ref(source));
  assert.ok(!JSON.stringify(data).includes("blob:"));
});

test("unavailable text source keeps its immutable identity and fails saving rather than rewriting empty text", async () => {
  const { client, projection, snapshot } = await fixture();
  const saved = snapshot.editorDocuments.find((d) => d.kind === "timeline")!;
  const missing = {
    assetId: "00000000-0000-0000-0000-000000087999",
    revision: 1,
    fingerprint: "sha256:" + "b".repeat(64),
    kind: "text",
  };
  const font = snapshot.assets.find((a) => a.kind === "file")!;
  const formal = {
    ...saved,
    data: {
      ...saved.data,
      fonts: [
        {
          id: "font",
          title: "Fixture",
          asset: {
            assetId: font.id,
            revision: font.revision,
            fingerprint: font.fingerprint,
            kind: font.kind,
          },
        },
      ],
      overlays: [
        {
          id: "a",
          start: 1,
          end: 3,
          text: "Keep this",
          x: 0.1,
          y: 0.8,
          maxWidth: 0.8,
          fontId: "font",
          style: {
            fontSize: 18,
            color: "#FFFFFF",
            align: "center",
            lineHeight: 1.2,
            background: null,
            stroke: null,
          },
          sourceAsset: missing,
        },
      ],
    },
  };
  const view = await projection.editorData(formal as never);
  assert.deepEqual(view.timeline!.overlays![0]!.source!.asset, missing);
  assert.equal(view.timeline!.overlays![0]!.source!.src, undefined);
  client.writeText = async () => {
    throw new Error("must not create empty source");
  };
  const doc = await projection.read();
  projection.baseline = structuredClone(doc);
  const item = doc.nodes.find((n) => n.type === "timeline")!;
  const session = new CreationEditorSession(client, doc, item.id);
  await assert.rejects(session.apply({ timeline: view.timeline! }));
});
