import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Conversation } from "../src/backend/chat.ts";
import {
  currentChat,
  flushChatDraft,
  rememberChat,
} from "../src/backend/chatDrafts.ts";
import { request } from "../src/backend/api.ts";
import {
  openBackendProject,
  releaseBackendProject,
  requireActiveBackendProject,
} from "../src/backend/projects.ts";

const listeners = new Map<string, () => void>();
let heartbeat: () => void;
const draft = (text: string): Conversation => ({
  messages: [],
  draft: text,
  assets: [],
  thinking: "auto",
  modelSelections: {},
});

function fixture(t: TestContext, unified = true) {
  const beforeFetch = globalThis.fetch;
  const beforeWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { search: unified ? "" : "" },
      setInterval: (callback: () => void) => {
        heartbeat = callback;
        return 1;
      },
      addEventListener: (name: string, callback: () => void) =>
        listeners.set(name, callback),
    },
  });
  const prefix = unified ? "/api/creation" : "/api";
  const calls: {
    path: string;
    method: string;
    value: Record<string, unknown>;
    keepalive?: boolean;
  }[] = [];
  let lease: string | null = null;
  let saved: Conversation | undefined;
  let intercept:
    | ((path: string, options: RequestInit) => Promise<Response | undefined>)
    | undefined;
  globalThis.fetch = (async (url, options: RequestInit = {}) => {
    const path = String(url),
      method = options.method ?? "GET";
    const value = options.body ? JSON.parse(String(options.body)) : {};
    calls.push({ path, method, value, keepalive: options.keepalive });
    const response = await intercept?.(path, options);
    if (response) return response;
    if (path.endsWith("/open")) {
      lease = path.split("/").at(-2)!;
      return Response.json({ ok: true });
    }
    if (path.startsWith(`${prefix}/sessions/`)) {
      if (method === "PUT") lease = value.projectId;
      if (method === "DELETE") lease = null;
      if (method === "POST") {
        const draftSaved = value.projectId === lease;
        if (draftSaved) {
          saved = value.conversation;
          lease = null;
        }
        return Response.json({ ok: true, draftSaved });
      }
      return Response.json({ ok: true });
    }
    if (path.endsWith("/draft")) return Response.json({ ok: true });
    throw new Error(`Unexpected request ${method} ${path}`);
  }) as typeof fetch;
  t.after(async () => {
    intercept = undefined;
    try {
      await releaseBackendProject();
    } finally {
      globalThis.fetch = beforeFetch;
      if (beforeWindow)
        Object.defineProperty(globalThis, "window", beforeWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
  return {
    calls,
    prefix,
    saved: () => saved,
    lease: () => lease,
    expire: () => {
      lease = null;
    },
    intercept: (value: typeof intercept) => {
      intercept = value;
    },
  };
}

test("unconnected assistant drafts never write legacy project data", async (t) => {
  const f = fixture(t),
    id = crypto.randomUUID();
  await openBackendProject(id, "A");
  rememberChat(id, draft("temporary"));
  await flushChatDraft(id);
  await releaseBackendProject();
  assert.equal(currentChat(id)?.draft, "temporary");
  assert.equal(f.saved(), undefined);
  assert.equal(f.lease(), null);
  assert.ok(f.calls.every((call) => call.path.startsWith("/api/creation/")));
});

test("page exit releases the unified session with keepalive and tolerates a repeated exit", async (t) => {
  const f = fixture(t),
    id = crypto.randomUUID();
  await openBackendProject(id, "A");
  rememberChat(id, draft("exit draft"));
  listeners.get("pagehide")!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  rememberChat(id, draft("late stale draft"));
  listeners.get("pagehide")!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const close = f.calls.filter((call) => call.method === "DELETE");
  assert.equal(close.length, 2);
  assert.ok(close.every((call) => call.method === "DELETE" && call.keepalive));
  assert.equal(f.saved(), undefined);
  assert.equal(currentChat(id)?.draft, "late stale draft");
  assert.equal(f.calls.filter((call) => call.path.endsWith("/open")).length, 1);
});

test("release errors prevent release or switching and preserve the active draft", async (t) => {
  const f = fixture(t),
    id = crypto.randomUUID(),
    next = crypto.randomUUID();
  await openBackendProject(id, "A");
  rememberChat(id, draft("keep this"));
  f.intercept(async (path, options) =>
    path.includes("/sessions/") && options.method === "DELETE"
      ? Response.json(
          { detail: "部分素材尚未保存，项目对话未覆盖，请重试。" },
          { status: 409 },
        )
      : undefined,
  );
  await assert.rejects(releaseBackendProject(), /部分素材尚未保存/);
  await assert.rejects(openBackendProject(next, "B"), /部分素材尚未保存/);
  assert.equal(
    await requireActiveBackendProject(id, new AbortController().signal),
    id,
  );
  assert.equal(currentChat(id)?.draft, "keep this");
  assert.equal(f.lease(), id);
  assert.equal(
    f.calls.some((call) => call.path.endsWith(`/${next}/open`)),
    false,
  );
});

test("a failed target open reacquires the old project without writing chat drafts", async (t) => {
  const f = fixture(t),
    id = crypto.randomUUID(),
    next = crypto.randomUUID();
  await openBackendProject(id, "A");
  rememberChat(id, draft("saved before switch"));
  f.intercept(async (path) =>
    path.endsWith(`/${next}/open`)
      ? Response.json({ detail: "目标项目不可用" }, { status: 409 })
      : undefined,
  );
  await assert.rejects(openBackendProject(next, "B"), /目标项目不可用/);
  assert.equal(f.lease(), id);
  assert.equal(f.saved(), undefined);
  assert.equal(
    await requireActiveBackendProject(id, new AbortController().signal),
    id,
  );
  assert.equal(f.calls.at(-1)!.path, `${f.prefix}/projects/${id}/open`);
});

test("pending heartbeat completes before close and cannot reacquire the released lease", async (t) => {
  const f = fixture(t),
    id = crypto.randomUUID();
  await openBackendProject(id, "A");
  rememberChat(id, draft("closed"));
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.intercept(async (path, options) => {
    if (path.includes("/sessions/") && options.method === "PUT") {
      entered();
      await blocked;
    }
    return undefined;
  });
  heartbeat();
  await started;
  const closing = releaseBackendProject();
  await Promise.resolve();
  assert.equal(
    f.calls.some((call) => call.method === "DELETE"),
    false,
  );
  release();
  await closing;
  heartbeat();
  await Promise.resolve();
  assert.equal(f.lease(), null);
  assert.equal(f.calls.at(-1)!.method, "DELETE");
});

test("expired close neither reopens the project nor claims to save the stale draft", async (t) => {
  const f = fixture(t),
    id = crypto.randomUUID();
  await openBackendProject(id, "A");
  rememberChat(id, draft("stale"));
  f.expire();
  await releaseBackendProject();
  assert.equal(f.saved(), undefined);
  assert.equal(currentChat(id)?.draft, "stale");
  assert.equal(f.calls.filter((call) => call.path.endsWith("/open")).length, 1);
});

test("unified projects retain their own session endpoint for switches and page exit", async (t) => {
  const f = fixture(t, true),
    id = crypto.randomUUID(),
    next = crypto.randomUUID();
  await openBackendProject(id, "A");
  await openBackendProject(next, "B");
  listeners.get("pagehide")!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const closes = f.calls.filter((call) => call.method === "DELETE");
  assert.equal(closes.length, 2);
  assert.ok(
    closes.every((call) => call.path.startsWith("/api/creation/sessions/")),
  );
  assert.equal(closes.at(-1)!.keepalive, true);
  assert.equal(
    f.calls.some((call) => call.path.endsWith("/close")),
    false,
  );
});

const expired = () =>
  Response.json({ detail: "会话已过期", code: "session_expired" }, { status: 409 });

test("a lapsed-lease recovery waits for a pending switch and never reacquires the project left", async (t) => {
  const f = fixture(t),
    id = crypto.randomUUID(),
    next = crypto.randomUUID();
  await openBackendProject(id, "A");
  let release!: () => void, entered!: () => void;
  const closing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.intercept(async (path, options) => {
    if (path.includes("/sessions/") && options.method === "DELETE") {
      entered();
      await blocked;
    }
    if (path.endsWith(`/${id}/commands`)) return expired();
    return undefined;
  });
  const switching = openBackendProject(next, "B");
  await closing;
  // A save from the editor being left is rejected while the close is in flight.
  const save = request(`/creation/projects/${id}/commands`, { method: "POST", body: "{}" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  await switching;
  await assert.rejects(save, { code: "session_expired" });
  assert.equal(f.lease(), next);
  assert.equal(
    f.calls.some((call) => call.method === "PUT" && call.value.projectId === id),
    false,
  );
});

test("writes rejected together for a lapsed lease share one renewal", async (t) => {
  const f = fixture(t),
    id = crypto.randomUUID();
  await openBackendProject(id, "A");
  f.expire();
  f.intercept(async (path) =>
    path.endsWith(`/${id}/commands`)
      ? f.lease() === id
        ? Response.json({ status: "applied" })
        : expired()
      : undefined,
  );
  const saves = [1, 2, 3].map(() =>
    request(`/creation/projects/${id}/commands`, { method: "POST", body: "{}" }),
  );
  assert.deepEqual(await Promise.all(saves), [1, 2, 3].map(() => ({ status: "applied" })));
  assert.equal(f.calls.filter((call) => call.method === "PUT").length, 1);
  assert.equal(f.lease(), id);
});
