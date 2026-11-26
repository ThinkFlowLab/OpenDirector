import assert from "node:assert/strict";
import test from "node:test";
test("a write rejected for a lapsed lease renews it and is resent once", async () => {
  const { request, setLeaseRecovery } = await import("../src/backend/api.ts");
  const original = globalThis.fetch;
  const calls: string[] = [];
  const renewed: string[] = [];
  const expired = () =>
    new Response(JSON.stringify({ detail: "会话已过期", code: "session_expired" }), { status: 409 });
  try {
    let answers = [expired(), new Response(JSON.stringify({ status: "applied" }), { status: 200 })];
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return answers.shift()!;
    }) as typeof fetch;
    setLeaseRecovery(async (projectId) => {
      renewed.push(projectId);
      return true;
    });
    assert.deepEqual(await request("/creation/projects/p1/commands", { method: "POST", body: "{}" }), {
      status: "applied",
    });
    assert.deepEqual(renewed, ["p1"]);
    assert.deepEqual(calls, ["/api/creation/projects/p1/commands", "/api/creation/projects/p1/commands"]);

    // A second rejection after renewing is reported, not retried forever.
    answers = [expired(), expired()];
    await assert.rejects(request("/creation/projects/p1/commands", { method: "POST" }), { code: "session_expired" });
    assert.equal(renewed.length, 2);

    // A renewal the server refuses (another window took the project) surfaces the original error.
    setLeaseRecovery(async () => false);
    answers = [expired()];
    await assert.rejects(request("/creation/projects/p1/commands", { method: "POST" }), { code: "session_expired" });

    // Paths outside a project, and other 409s, are never renewed.
    setLeaseRecovery(async (projectId) => {
      renewed.push(projectId);
      return true;
    });
    answers = [expired()];
    await assert.rejects(request("/creation/sessions/s1", { method: "PUT" }), { code: "session_expired" });
    answers = [new Response(JSON.stringify({ code: "revision_conflict" }), { status: 409 })];
    await assert.rejects(request("/creation/projects/p1/commands", { method: "POST" }), { code: "revision_conflict" });
    assert.equal(renewed.length, 2);
  } finally {
    globalThis.fetch = original;
    setLeaseRecovery(undefined);
  }
});
