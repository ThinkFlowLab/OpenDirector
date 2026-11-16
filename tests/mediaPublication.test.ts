import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import {
  CreationClient,
  CreationCommandError,
  assetReference,
} from "../src/backend/creationClient.ts";
import { CreationProjection } from "../src/backend/creationProjection.ts";
import { MediaPublication } from "../src/backend/mediaPublication.ts";
import type {
  CommandReceipt,
  ProjectSnapshot,
} from "../src/contracts/generated.ts";

const output = [
  {
    kind: "image" as const,
    src: "data:image/png;base64,eA==",
    mimeType: "image/png",
    title: "Output",
  },
];
function setup(t: TestContext) {
  let snapshot = JSON.parse(
    readFileSync(
      new URL("./fixtures/creation-project.json", import.meta.url),
      "utf8",
    ),
  ) as ProjectSnapshot;
  const source = snapshot.assets.find((a) => a.kind === "image")!;
  const item = {
    ...snapshot.canvasItems.find((i) => i.kind === "image")!,
    binding: { role: "material" as const, objectRef: assetReference(source) },
  };
  snapshot = {
    ...snapshot,
    canvasItems: snapshot.canvasItems.map((i) => (i.id === item.id ? item : i)),
  };
  const client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  let imports = 0;
  t.mock.method(CreationProjection.prototype, "importResource", async () => {
    imports++;
    return { ...assetReference(source), assetId: crypto.randomUUID() };
  });
  return { client, snapshot, item, imports: () => imports };
}
test("unknown publication repeats exact fixed input and identities, acknowledged output does not submit twice", async (t) => {
  const { client, snapshot, item, imports } = setup(t);
  const calls: unknown[] = [];
  client.command = async (...args) => {
    calls.push(structuredClone(args));
    if (calls.length === 1) throw Error("offline");
    return { status: "applied" } as CommandReceipt;
  };
  const publication = new MediaPublication(client, snapshot, item.id);
  await assert.rejects(publication.publish(output), /offline/);
  const ids = await publication.publish(output);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(imports(), 1);
  assert.deepEqual(await publication.publish(output), ids);
  assert.equal(calls.length, 2);
});
test("confirmed rejection retries the same imported outputs, keeps the original source version", async (t) => {
  const { client, snapshot, item, imports } = setup(t);
  const calls: any[] = [];
  client.command = async (...args) => {
    calls.push(structuredClone(args));
    if (calls.length === 1)
      throw new CreationCommandError({
        issues: [{ code: "locked", message: "locked" }],
      } as unknown as CommandReceipt);
    return { status: "applied" } as CommandReceipt;
  };
  const publication = new MediaPublication(client, snapshot, item.id);
  await assert.rejects(publication.publish(output), /locked/);
  await publication.publish(output);
  assert.equal(imports(), 1);
  assert.deepEqual(calls[0].slice(0, 4), calls[1].slice(0, 4));
  assert.notEqual(calls[0][4], calls[1][4]);
});
test("a new editor session resolves a lost publication before sending changed output", async (t) => {
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
  const { client, snapshot, item, imports } = setup(t);
  const calls: unknown[] = [];
  client.command = async (...args) => {
    calls.push(structuredClone(args));
    if (calls.length === 1) throw Error("lost reply");
    return { status: "applied" } as CommandReceipt;
  };
  await assert.rejects(
    new MediaPublication(client, snapshot, item.id).publish(output),
    /lost reply/,
  );
  await assert.rejects(
    new MediaPublication(client, snapshot, item.id).publish([
      { ...output[0], title: "Changed" },
    ]),
    /此前结果已保存/,
  );
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(imports(), 1);
  assert.equal(saved.size, 0);
});

test("failed output preparation retains successful imports and retries the same upload handle", async (t) => {
  const { client, snapshot, item } = setup(t);
  t.mock.restoreAll();
  const handles: string[] = [];
  const reference = assetReference(
    snapshot.assets.find((a) => a.kind === "image")!,
  );
  client.importBlob = async (_blob, _name, _kind, handle) => {
    handles.push(handle!);
    if (handles.length === 2) throw Error("lost import reply");
    return { ...reference, assetId: crypto.randomUUID() };
  };
  client.command = async () => ({ status: "applied" }) as CommandReceipt;
  const publisher = new MediaPublication(client, snapshot, item.id);
  const outputs = [...output, { ...output[0], title: "Second" }];
  await assert.rejects(publisher.publish(outputs), /lost import reply/);
  await publisher.publish(outputs);
  assert.equal(handles.length, 3, "first successful import is reused");
  assert.equal(
    handles[1],
    handles[2],
    "unknown asset import keeps its upload identity",
  );
});

test("new local results retain normal node dimensions and avoid earlier published results", async (t) => {
  const { client, snapshot, item } = setup(t);
  const occupied = {
    ...item,
    id: crypto.randomUUID(),
    position: { x: item.position.x + item.width + 100, y: item.position.y },
  };
  client.install({
    ...snapshot,
    canvasItems: [...snapshot.canvasItems, occupied],
  });
  client.command = async (_type, payload) => {
    assert.ok("outputs" in payload);
    const placed = payload.outputs[0];
    assert.ok(
      (placed.position?.y ?? 0) >= occupied.position.y + occupied.height + 64,
    );
    assert.ok(placed.width! > 0 && placed.height! > 0);
    return { status: "applied" } as CommandReceipt;
  };
  await new MediaPublication(client, client.snapshot, item.id).publish(output);
});

test("reopening a refused publication reuses prepared assets instead of importing duplicate files", async (t) => {
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
  const { client, snapshot, item, imports } = setup(t);
  const calls: unknown[][] = [];
  client.command = async (...args) => {
    calls.push(structuredClone(args));
    if (calls.length === 1)
      throw new CreationCommandError({
        issues: [{ code: "locked", message: "locked" }],
      } as unknown as CommandReceipt);
    return { status: "applied" } as CommandReceipt;
  };
  await assert.rejects(
    new MediaPublication(client, snapshot, item.id).publish(output),
    /locked/,
  );
  await new MediaPublication(client, snapshot, item.id).publish(output);
  assert.equal(imports(), 1);
  assert.deepEqual(calls[0]!.slice(0, 4), calls[1]!.slice(0, 4));
  assert.notEqual(calls[0]![4], calls[1]![4]);
  assert.equal(saved.size, 0);
});
test("a director stage publication freezes the director document as its source", async (t) => {
  const snapshot = JSON.parse(
    readFileSync(
      new URL("./fixtures/creation-project.json", import.meta.url),
      "utf8",
    ),
  ) as ProjectSnapshot;
  const document = snapshot.editorDocuments.find(
    (candidate) => candidate.kind === "director",
  )!;
  const item = snapshot.canvasItems.find(
    (candidate) => candidate.kind === "external",
  )!;
  const client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  t.mock.method(CreationProjection.prototype, "importResource", async () => ({
    ...assetReference(
      snapshot.assets.find((asset) => asset.kind === "image")!,
    ),
    assetId: crypto.randomUUID(),
  }));
  const calls: unknown[][] = [];
  client.command = async (...args) => {
    calls.push(structuredClone(args));
    return { status: "applied" } as CommandReceipt;
  };
  const publication = new MediaPublication(client, snapshot, item.id);
  const ids = await publication.publish(output);
  assert.equal(ids.length, 1);
  const payload = calls[0]![1]! as {
    source: unknown;
    sourceEditorId: string;
    document: { id: string; kind: string; data: typeof document.data };
  };
  assert.equal(payload.source, null);
  assert.equal(payload.sourceEditorId, document.id);
  assert.equal(payload.document.kind, "director");
  assert.notEqual(payload.document.id, document.id);
  assert.deepEqual(payload.document.data, document.data);
});
