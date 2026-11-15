import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { creationClient } from "../src/backend/creationClient.ts";
import { CreationProjection } from "../src/backend/creationProjection.ts";
import {
  activeBackendProjectId,
  releaseBackendProject,
} from "../src/backend/projects.ts";
import { invalidateCached } from "../src/backend/requestCache.ts";
import {
  cleanupUnreadableWorkspaceProjects,
  createWorkspaceProject,
  initializeWorkspace,
  openExampleWorkspaceProject,
  openWorkspaceProject,
  saveWorkspaceDocument,
  trashWorkspaceProject,
  type WorkspaceProject,
} from "../src/backend/workspace.ts";
import type { ProjectSnapshot } from "../src/contracts/generated.ts";
import {
  createDocument,
  createNode,
  type CanvasDocument,
} from "../src/canvas/model.ts";
import { EXAMPLE_PROJECT_TITLE } from "../src/canvas/assets.ts";

/** Entry/session orchestration; projection round-trips are exercised separately. */
let heartbeat: (() => void) | undefined;
function fixture(t: TestContext) {
  // Each test stands for a fresh page, whose list cache starts empty.
  invalidateCached();
  const oldFetch = globalThis.fetch;
  const descriptors = ["window", "localStorage"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  const oldOpen = CreationProjection.prototype.open,
    oldSave = CreationProjection.prototype.save;
  const projects = new Map<string, WorkspaceProject>();
  const documents = new Map<string, CanvasDocument>();
  const storage = new Map<string, string>();
  const location = { pathname: "/", search: "" };
  const calls: { path: string; method: string; body?: any }[] = [];
  let occupied = false,
    offline = false,
    lease: string | null = null;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location,
      setInterval: (callback: () => void) => {
        heartbeat = callback;
        return 1;
      },
      addEventListener() {},
    },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
    },
  });
  CreationProjection.prototype.open = async function () {
    // CreationClient.open() acquires the project lease with the same read.
    lease = this.client.id;
    const doc = documents.get(this.client.id)!;
    this.baseline = structuredClone(doc);
    return structuredClone(doc);
  };
  CreationProjection.prototype.save = async function (doc) {
    assert.equal(lease, doc.id);
    documents.set(doc.id, structuredClone(doc));
    return false;
  };
  globalThis.fetch = async (url, options) => {
    const path = String(url),
      method = options?.method ?? "GET";
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ path, method, body });
    assert.ok(path.startsWith("/api/creation/"), `Legacy request: ${path}`);
    if (path === "/api/creation/projects")
      return Response.json({
        projects: [...projects.values()],
        unreadable: occupied
          ? [
              {
                id: null,
                name: "Legacy",
                path: "/projects/Legacy",
                reason: "旧格式工程已保留",
              },
            ]
          : [],
        warnings: occupied ? ["旧格式工程已保留"] : [],
      });
    if (path === "/api/creation/projects/cleanup" && method === "POST") {
      occupied = false;
      return Response.json({ removed: ["Legacy"], failed: [] });
    }
    if (path.includes("/sessions/")) {
      // A heartbeat renewal keeps the lease on its project; an explicit close
      // releases it.
      if (method === "PUT") lease = body?.projectId ?? null;
      else lease = null;
      return Response.json({ ok: true });
    }
    const id = path.split("/")[4]!;
    if (method === "GET" && path === `/api/creation/projects/${id}` && documents.has(id))
      return Response.json({project: {
        id,
        name: documents.get(id)!.title,
        revision: 1,
      }, canvasItems: [
        ...(documents.get(id)?.nodes ?? []).map(node => ({...node, visible: true})),
        ...(documents.get(id)?.hiddenNodes ?? []).map(node => ({...node, visible: false})),
      ]});
    if (path.endsWith("/commands")) {
      if (offline) throw new TypeError("offline");
      if (body.type === "project.trash") {
        projects.delete(id);
        documents.delete(id);
        return Response.json({
          commandId: body.commandId,
          projectId: id,
          inputFingerprint: "trash",
          status: "applied",
          changed: [],
          jobIds: [],
          issues: [],
          eventCursor: 2,
        });
      }
      if (
        (occupied && body.payload.name === "未命名画布") ||
        [...projects.values()].some((p) => p.name === body.payload.name)
      )
        return Response.json({ detail: "已有同名项目" }, { status: 409 });
      projects.set(id, {
        id,
        name: body.payload.name,
        path: `/projects/${body.payload.name}`,
      });
      documents.set(id, { ...createDocument(body.payload.name), id });
      return Response.json({ status: "applied", issues: [], jobIds: [] });
    }
    if (path.includes("/receipts/"))
      return Response.json({ detail: "无回执" }, { status: 404 });
    if (path.endsWith("/canvas"))
      return Response.json({
        snapshot: { project: { id }, eventCursor: 1 },
        edges: [],
      });
    if (path.endsWith("/open")) {
      lease = id;
      return Response.json({ ok: true });
    }
    return Response.json(
      {
        detail: "不支持该工程格式；旧文件不会自动转换。",
        code: "unsupported_format",
      },
      { status: 409 },
    );
  };
  t.after(async () => {
    try {
      await releaseBackendProject();
    } finally {
      for (const id of projects.keys()) creationClient(id).close();
      globalThis.fetch = oldFetch;
      CreationProjection.prototype.open = oldOpen;
      CreationProjection.prototype.save = oldSave;
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  return {
    projects,
    documents,
    storage,
    location,
    calls,
    heartbeat: () => heartbeat?.(),
    occupy: () => {
      occupied = true;
    },
    offline: () => {
      offline = true;
    },
  };
}

test("unreadable project cleanup uses the dedicated command", async (t) => {
  const f = fixture(t);
  f.occupy();
  assert.deepEqual(await cleanupUnreadableWorkspaceProjects(), {
    removed: ["Legacy"],
    failed: [],
  });
  assert.ok(
    f.calls.some(
      (call) =>
        call.path === "/api/creation/projects/cleanup" &&
        call.method === "POST",
    ),
  );
});

test("plain entry shares concurrent initialization, then rereads the saved project", async (t) => {
  const f = fixture(t);
  const first = initializeWorkspace();
  assert.equal(initializeWorkspace(), first);
  const initial = await first;
  const updated = {
    ...initial,
    nodes: [createNode("image", { x: 20, y: 40 }, { title: "保存节点" })],
  };
  await saveWorkspaceDocument(updated);
  assert.deepEqual((await initializeWorkspace()).nodes, updated.nodes);
  assert.equal(f.projects.size, 1);
  assert.equal(
    f.storage.get("opendirector.lastUnifiedFilesystemProject"),
    initial.id,
  );
});

test("explicit unsupported project links reject instead of creating or opening another project", async (t) => {
  const f = fixture(t);
  await initializeWorkspace();
  f.calls.length = 0;
  f.location.pathname = `/ai-tool/ai-canvas/${crypto.randomUUID()}`;
  await assert.rejects(initializeWorkspace(), /不支持该工程格式/);
  assert.ok(f.calls.every((call) => call.method === "GET"));
  assert.equal(f.projects.size, 1);
});

test("plain entry ignores the legacy last-project hint and preserves occupied directories", async (t) => {
  const f = fixture(t);
  f.storage.set("opendirector.lastFilesystemProject", crypto.randomUUID());
  f.occupy();
  const doc = await initializeWorkspace();
  assert.equal(doc.title, "未命名画布 (2)");
  assert.equal(f.projects.size, 1);
});

test("failed project creation leaves the existing project writable", async (t) => {
  const f = fixture(t);
  const original = await initializeWorkspace();
  await assert.rejects(
    createWorkspaceProject(original.title, crypto.randomUUID()),
    /已有同名项目/,
  );
  await saveWorkspaceDocument({ ...original, title: "仍可保存" });
  assert.equal(f.documents.get(original.id)?.title, "仍可保存");
});

test("unknown creation outcome is not retried with another project identity", async (t) => {
  const f = fixture(t);
  f.offline();
  await assert.rejects(initializeWorkspace(), /无法连接/);
  assert.equal(
    f.calls.filter((call) => call.path.endsWith("/commands")).length,
    1,
  );
  assert.equal(f.projects.size, 0);
});

test("example opens share creation and reopen saved edits without rebuilding media", async (t) => {
  const f = fixture(t);
  let prepared = 0;
  const prepare = async () => {
    prepared++;
    return createDocument(EXAMPLE_PROJECT_TITLE);
  };
  const first = openExampleWorkspaceProject(EXAMPLE_PROJECT_TITLE, prepare);
  assert.equal(
    openExampleWorkspaceProject(EXAMPLE_PROJECT_TITLE, prepare),
    first,
  );
  const initial = await first;
  const edited = {
    ...initial,
    nodes: [
      createNode("text", undefined, { title: "我的修改", text: "保留内容" }),
    ],
  };
  await saveWorkspaceDocument(edited);
  const reopened = await openExampleWorkspaceProject(
    EXAMPLE_PROJECT_TITLE,
    prepare,
  );
  assert.deepEqual(reopened, edited);
  assert.equal(prepared, 1);
  assert.equal(f.projects.size, 1);
  assert.equal(
    f.calls.filter((call) => call.path.endsWith("/commands")).length,
    1,
  );
});

test("existing default example is opened without a stored hint or saving over it", async (t) => {
  const f = fixture(t);
  const project = await createWorkspaceProject(
    EXAMPLE_PROJECT_TITLE,
    crypto.randomUUID(),
  );
  const saved = {
    ...createDocument(EXAMPLE_PROJECT_TITLE),
    id: project.id,
    nodes: [createNode("text", undefined, { text: "现有示例的修改" })],
  };
  f.documents.set(project.id, saved);
  f.calls.length = 0;
  const reopened = await openExampleWorkspaceProject(
    EXAMPLE_PROJECT_TITLE,
    async () => {
      throw new Error("不应重新生成示例");
    },
  );
  assert.deepEqual(reopened, saved);
  assert.ok(f.calls.every((call) => !call.path.endsWith("/commands")));
  assert.equal(f.projects.size, 1);
});

test("renamed examples reopen by project identity and deleted examples are recreated", async (t) => {
  const f = fixture(t);
  const prepare = async () => ({...createDocument(EXAMPLE_PROJECT_TITLE),
    nodes: [createNode("text", undefined, {text: "保留的示例"})]});
  const initial = await openExampleWorkspaceProject(
    EXAMPLE_PROJECT_TITLE,
    prepare,
  );
  const renamed = { ...f.projects.get(initial.id)!, name: "我改过的示例" };
  f.projects.set(initial.id, renamed);
  f.documents.set(initial.id, { ...initial, title: renamed.name });
  const reopened = await openExampleWorkspaceProject(
    EXAMPLE_PROJECT_TITLE,
    prepare,
  );
  assert.equal(reopened.id, initial.id);
  assert.equal(reopened.title, renamed.name);
  // The list cache still contains this row: reopening must consult the server.
  f.projects.delete(initial.id);
  f.documents.delete(initial.id);
  const replacement = await openExampleWorkspaceProject(
    EXAMPLE_PROJECT_TITLE,
    prepare,
  );
  assert.notEqual(replacement.id, initial.id);
  assert.equal(replacement.title, EXAMPLE_PROJECT_TITLE);
  assert.equal(f.projects.size, 1);
});

test("an example created in another window is reopened after a definite name conflict", async (t) => {
  const f = fixture(t);
  const id = crypto.randomUUID();
  const saved = {
    ...createDocument(EXAMPLE_PROJECT_TITLE),
    id,
    nodes: [createNode("text", undefined, { text: "另一窗口已保存" })],
  };
  const reopened = await openExampleWorkspaceProject(
    EXAMPLE_PROJECT_TITLE,
    async () => {
      f.projects.set(id, {
        id,
        name: saved.title,
        path: `/projects/${saved.title}`,
      });
      f.documents.set(id, saved);
      return createDocument(EXAMPLE_PROJECT_TITLE);
    },
  );
  assert.deepEqual(reopened, saved);
  assert.equal(f.projects.size, 1);
  assert.equal(
    f.calls.filter((call) => call.path.endsWith("/commands")).length,
    1,
  );
});

test("an unreadable existing example fails without creating a replacement", async (t) => {
  const f = fixture(t);
  const prepare = async () => createDocument(EXAMPLE_PROJECT_TITLE);
  await openExampleWorkspaceProject(EXAMPLE_PROJECT_TITLE, prepare);
  f.calls.length = 0;
  const fetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("/api/creation/projects/") && !options?.method)
      return Response.json({detail: "示例无法读取"}, {status: 503});
    return fetch(url, options);
  };
  await assert.rejects(
    openExampleWorkspaceProject(EXAMPLE_PROJECT_TITLE, prepare),
    /示例无法读取/,
  );
  assert.equal(f.projects.size, 1);
  assert.ok(f.calls.every((call) => !call.path.endsWith("/commands")));
});

test("unknown example creation is not retried with another project identity", async (t) => {
  const f = fixture(t);
  f.offline();
  await assert.rejects(
    openExampleWorkspaceProject(EXAMPLE_PROJECT_TITLE, async () =>
      createDocument(EXAMPLE_PROJECT_TITLE),
    ),
    /无法连接/,
  );
  assert.equal(
    f.calls.filter((call) => call.path.endsWith("/commands")).length,
    1,
  );
  assert.equal(f.projects.size, 0);
});


test("an empty saved example creates a separate usable example without overwriting it", async (t) => {
  const f = fixture(t);
  const old = await createWorkspaceProject(EXAMPLE_PROJECT_TITLE, crypto.randomUUID());
  const original = structuredClone(f.documents.get(old.id));
  const reopened = await openExampleWorkspaceProject(EXAMPLE_PROJECT_TITLE, async () => ({
    ...createDocument(EXAMPLE_PROJECT_TITLE),
    nodes: [createNode("text", undefined, {text: "示例内容"})],
  }));
  assert.notEqual(reopened.id, old.id);
  assert.equal(reopened.nodes.length, 1);
  assert.equal(reopened.title, EXAMPLE_PROJECT_TITLE + " (2)");
  assert.deepEqual(f.documents.get(old.id), original);
  assert.equal(f.projects.size, 2);
});


test("a numbered example with only hidden nodes creates a fresh example and preserves hidden content", async (t) => {
  const f = fixture(t);
  const prepare = async () => ({...createDocument(EXAMPLE_PROJECT_TITLE),
    nodes: [createNode("text", undefined, {text: "示例"})]});
  const initial = await openExampleWorkspaceProject(EXAMPLE_PROJECT_TITLE, prepare);
  const name = EXAMPLE_PROJECT_TITLE + " (9)";
  f.projects.set(initial.id, {...f.projects.get(initial.id)!, name});
  const hidden = {...initial, title: name, nodes: [], hiddenNodes: initial.nodes};
  f.documents.set(initial.id, hidden);
  const reopened = await openExampleWorkspaceProject(EXAMPLE_PROJECT_TITLE, prepare);
  assert.notEqual(reopened.id, initial.id);
  assert.equal(reopened.nodes.length, 1);
  assert.deepEqual(f.documents.get(initial.id), hidden);
});

test("opening a canvas adopts the lease its read acquired instead of opening twice", async (t) => {
  const f = fixture(t);
  const document = await initializeWorkspace();
  // CreationProjection.open() stands in for the POST /open-canvas read that
  // acquires the session lease; the workspace must not release it and open the
  // same project again through the projects entrypoint.
  assert.equal(
    f.calls.some(
      (call) => call.path.endsWith("/open") && call.method === "POST",
    ),
    false,
  );
  assert.equal(
    f.calls.some((call) => call.path.includes("/sessions/")),
    false,
  );
  assert.equal(f.storage.get("opendirector.lastUnifiedFilesystemProject"), document.id);
});

test("switching canvases keeps the lease from the next project's read", async (t) => {
  const f = fixture(t);
  const first = await initializeWorkspace();
  const id = crypto.randomUUID();
  f.projects.set(id, { id, name: "Second", path: "/projects/Second" });
  f.documents.set(id, { ...createDocument("Second"), id });
  f.calls.length = 0;
  const next = await openWorkspaceProject(f.projects.get(id)!);
  assert.equal(next.id, id);
  // No DELETE /sessions, no POST /open: the canvas read already moved the lease.
  assert.deepEqual(f.calls, []);
  await saveWorkspaceDocument({ ...next, title: "Second saved" });
  assert.equal(f.documents.get(id)?.title, "Second saved");
  assert.notEqual(first.id, next.id);
});

test("trashing the open project reuses its in-memory snapshot", async (t) => {
  const f = fixture(t);
  const document = await initializeWorkspace();
  const project = f.projects.get(document.id)!;
  // The open CanvasWorkspace passes the client's snapshot so the delete does
  // not read the same project again only to name its revision.
  const known = {
    project: { id: document.id, name: document.title, revision: 7 },
  } as ProjectSnapshot;
  f.calls.length = 0;
  await trashWorkspaceProject(project, known);
  const rereads = f.calls.filter(
    (call) =>
      call.method === "GET" &&
      call.path === `/api/creation/projects/${document.id}`,
  );
  assert.deepEqual(rereads, []);
  const trash = f.calls.find((call) => call.path.endsWith("/commands"))!;
  assert.equal(trash.body.type, "project.trash");
  assert.equal(trash.body.expectedVersions[0].revision, 7);
  assert.ok(f.calls.some((call) => call.method === "DELETE"));
  assert.equal(f.projects.size, 0);
});

test("a heartbeat fired while a canvas loads cannot renew the old lease", async (t) => {
  const f = fixture(t);
  const first = await initializeWorkspace();
  const id = crypto.randomUUID();
  f.projects.set(id, { id, name: "Slow", path: "/projects/Slow" });
  f.documents.set(id, { ...createDocument("Slow"), id });
  const stub = CreationProjection.prototype.open;
  let enter!: () => void,
    release!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  CreationProjection.prototype.open = async function (this: CreationProjection) {
    enter();
    await gate;
    return stub.call(this);
  };
  try {
    const opening = openWorkspaceProject(f.projects.get(id)!);
    await entered;
    f.calls.length = 0;
    // The read owns the session queue: a renewal here would move the lease back
    // to the previous project in the middle of a large snapshot read.
    f.heartbeat();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      f.calls.some(
        (call) => call.method === "PUT" && call.path.includes("/sessions/"),
      ),
      false,
    );
    release();
    const opened = await opening;
    assert.equal(opened.id, id);
    // Once the read adopted the lease, renewals target the new project.
    assert.notEqual(first.id, id);
    f.heartbeat();
    for (let attempt = 0; attempt < 5; attempt++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    const renewals = f.calls.filter(
      (call) => call.method === "PUT" && call.path.includes("/sessions/"),
    );
    assert.equal(renewals.length, 1);
    assert.equal(renewals[0]!.body.projectId, id);
  } finally {
    CreationProjection.prototype.open = stub;
  }
});

test("a stale in-memory revision is reread and the trash retried once", async (t) => {
  const f = fixture(t);
  const document = await initializeWorkspace();
  const project = f.projects.get(document.id)!;
  let trashes = 0;
  const versions: number[] = [];
  const plain = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url),
      method = options.method ?? "GET";
    if (path.endsWith("/commands") && method === "POST") {
      const body = JSON.parse(String(options.body));
      if (body.type === "project.trash") {
        trashes += 1;
        versions.push(body.expectedVersions[0].revision);
        if (trashes === 1)
          return Response.json({
            commandId: body.commandId,
            projectId: body.projectId,
            inputFingerprint: "stale",
            status: "rejected",
            changed: [],
            jobIds: [],
            issues: [
              { code: "revision_conflict", message: "工程版本已变化。" },
            ],
            eventCursor: 1,
          });
      }
    }
    return plain(url, options);
  };
  try {
    await trashWorkspaceProject(project, {
      project: { id: document.id, name: document.title, revision: 3 },
    } as ProjectSnapshot);
  } finally {
    globalThis.fetch = plain;
  }
  // The rejected first attempt was followed by one authoritative reread.
  assert.equal(trashes, 2);
  assert.deepEqual(versions, [3, 1]);
  assert.equal(f.projects.size, 0);
});

test("a canvas read that outlives the lease renews it before adopting", async (t) => {
  const f = fixture(t);
  await initializeWorkspace();
  const id = crypto.randomUUID();
  f.projects.set(id, { id, name: "Slow", path: "/projects/Slow" });
  f.documents.set(id, { ...createDocument("Slow"), id });
  const stub = CreationProjection.prototype.open;
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  CreationProjection.prototype.open = async function (this: CreationProjection) {
    // Media hydration streams longer than the server's 60 s lease.
    now += 61_000;
    return stub.call(this);
  };
  try {
    f.calls.length = 0;
    const opened = await openWorkspaceProject(f.projects.get(id)!);
    assert.equal(opened.id, id);
    const renewals = f.calls.filter(
      (call) => call.method === "PUT" && call.path.includes("/sessions/"),
    );
    assert.equal(renewals.length, 1);
    assert.equal(renewals[0]!.body.projectId, id);
    assert.equal(
      f.calls.some((call) => call.method === "DELETE"),
      false,
    );
    // The renewed lease is the adopted one, so saving right after works.
    await saveWorkspaceDocument({ ...opened, title: "Slow saved" });
    assert.equal(f.documents.get(id)?.title, "Slow saved");
  } finally {
    Date.now = realNow;
    CreationProjection.prototype.open = stub;
  }
});

test("a long read that lost its lease fails instead of adopting it", async (t) => {
  const f = fixture(t);
  const first = await initializeWorkspace();
  const id = crypto.randomUUID();
  f.projects.set(id, { id, name: "Stolen", path: "/projects/Stolen" });
  f.documents.set(id, { ...createDocument("Stolen"), id });
  const stub = CreationProjection.prototype.open;
  const realNow = Date.now;
  let now = 2_000_000;
  Date.now = () => now;
  CreationProjection.prototype.open = async function (this: CreationProjection) {
    now += 61_000;
    return stub.call(this);
  };
  const plain = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (
      String(url).includes("/sessions/") &&
      (options.method ?? "GET") === "PUT"
    )
      return Response.json(
        { detail: "工程正在其他窗口中打开", code: "project_open_elsewhere" },
        { status: 409 },
      );
    return plain(url, options);
  };
  try {
    await assert.rejects(openWorkspaceProject(f.projects.get(id)!));
    // A failed adoption must not point heartbeats at the stolen project.
    assert.equal(activeBackendProjectId(), first.id);
    // The session moved with the read and the renewal was rejected, so this
    // window's lease is put back on the project the canvas is still showing.
    assert.equal(
      f.calls.filter(
        (call) =>
          call.method === "POST" &&
          call.path === `/api/creation/projects/${first.id}/open`,
      ).length,
      1,
    );
  } finally {
    globalThis.fetch = plain;
    Date.now = realNow;
    CreationProjection.prototype.open = stub;
  }
});

test("a read that fails after the lease moves restores the previous project", async (t) => {
  const f = fixture(t);
  const first = await initializeWorkspace();
  const id = crypto.randomUUID();
  f.projects.set(id, { id, name: "Broken", path: "/projects/Broken" });
  f.documents.set(id, { ...createDocument("Broken"), id });
  const stub = CreationProjection.prototype.open;
  CreationProjection.prototype.open = async function () {
    // Stands for client.open() having been accepted and the following view
    // read failing. The server lease is already on this project.
    throw new Error("view failed");
  };
  try {
    f.calls.length = 0;
    await assert.rejects(
      openWorkspaceProject(f.projects.get(id)!),
      /view failed/,
    );
    assert.equal(activeBackendProjectId(), first.id);
    assert.equal(
      f.calls.filter(
        (call) =>
          call.method === "POST" &&
          call.path === `/api/creation/projects/${first.id}/open`,
      ).length,
      1,
    );
  } finally {
    CreationProjection.prototype.open = stub;
  }
});
