import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Conversation } from "../src/backend/chat.ts";
import {
  currentChat,
  flushChatDraft,
  rememberChat,
} from "../src/backend/chatDrafts.ts";
import {
  openBackendProject,
  releaseBackendProject,
  requireActiveBackendProject,
} from "../src/backend/projects.ts";

const listeners = new Map<string, (event?: { persisted?: boolean }) => void>();
let heartbeat: () => void;
const draft = (text: string): Conversation => ({
  messages: [],
  draft: text,
  assets: [],
  thinking: "auto",
  modelSelections: {},
});

function fixture(t: TestContext, unified = true) {
  listeners.get("pageshow")?.();
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
    headers?: HeadersInit;
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
    calls.push({
      path,
      method,
      value,
      keepalive: options.keepalive,
      headers: options.headers,
    });
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

test("pagehide fences an unacknowledged open and BFCache restoration reacquires", async (t) => {
  const f = fixture(t),
    id = crypto.randomUUID();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.intercept(async (path) => {
    if (path.endsWith("/open")) await pending;
    return undefined;
  });
  const opening = openBackendProject(id, "A");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const issued = new Headers(
    f.calls.find((call) => call.path.endsWith("/open"))!.headers,
  ).get("X-OpenDirector-Session-Generation");
  listeners.get("pagehide")!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const release = f.calls.find((call) => call.method === "DELETE")!;
  assert.equal(
    new Headers(release.headers).get("X-OpenDirector-Session-Generation"),
    issued,
  );
  finish();
  await opening;
  const before = f.calls.length;
  heartbeat();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.calls.length, before);
  listeners.get("pageshow")!({ persisted: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const reacquired = f.calls
    .filter((call) => call.path.endsWith("/open"))
    .at(-1)!;
  assert.ok(
    Number(
      new Headers(reacquired.headers).get("X-OpenDirector-Session-Generation"),
    ) > Number(issued),
  );
});

test("heartbeat recovers an absent row but never reopens a fenced page", async (t) => {
  const f = fixture(t),
    id = crypto.randomUUID();
  await openBackendProject(id, "A");
  let code = "session_not_open";
  f.intercept(async (_path, options) =>
    options.method === "PUT"
      ? Response.json({ code, detail: code }, { status: 409 })
      : undefined,
  );
  heartbeat();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.calls.filter((call) => call.path.endsWith("/open")).length, 2);
  code = "session_stale";
  heartbeat();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.calls.filter((call) => call.path.endsWith("/open")).length, 2);
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
