import assert from "node:assert/strict";
import test from "node:test";
import { readTurnJobs, turnJobView, type TurnJob } from "../src/canvas/traceJobs.ts";
import { setActiveLocale } from "../src/i18n/messages.ts";
import { defaultTranslate } from "../src/canvas/assistantTranslate.ts";

const t = defaultTranslate;
setActiveLocale("en-US");
const base = { callId: "c", commandId: "k", errorDetails: null, asset: null, adopted: false };
const job = (over: Partial<TurnJob>): TurnJob => ({ jobId: "j", status: "running", ...base, ...over });
const ok = (body: unknown) => ({ ok: true, json: async () => body });

test("multiple jobs keep order and localized status", async () => {
  const jobs = await readTurnJobs(ok([job({ jobId: "a", status: "queued" }), job({ jobId: "b" })]));
  assert.deepEqual(jobs.map((j) => turnJobView(j, t).key), ["a", "b"]);
  assert.equal(turnJobView(jobs[0], t).statusText, "Queued");
  assert.equal(turnJobView(jobs[1], t).statusText, "Running");
});

test("succeeded job shows its asset and adoption", () => {
  const view = turnJobView(job({
    status: "succeeded", adopted: true,
    asset: { assetId: "a1", revision: 2, fingerprint: "f", kind: "image" } as TurnJob["asset"],
  }), t);
  assert.equal(view.assetText, "Result: image a1 r2");
  assert.equal(view.adoptedText, "Adopted");
  assert.equal(view.errorText, null);
});

test("failed job shows the localized failure", () => {
  const view = turnJobView(job({
    status: "failed",
    errorDetails: { message: "生成服务暂时不可用。", category: "provider" } as TurnJob["errorDetails"],
  }), t);
  assert.equal(view.statusText, "Failed");
  assert.ok(view.errorText && !/[\u4e00-\u9fff]/.test(view.errorText));
});

test("empty response yields no jobs", async () => {
  assert.deepEqual(await readTurnJobs(ok([])), []);
});

test("non-ok, malformed or throwing responses yield no jobs", async () => {
  assert.deepEqual(await readTurnJobs({ ok: false, json: async () => [job({})] }), []);
  assert.deepEqual(await readTurnJobs(ok({ detail: "x" })), []);
  assert.deepEqual(await readTurnJobs({ ok: true, json: async () => { throw new Error("bad"); } }), []);
});

test("status and asset text follow the active locale", () => {
  setActiveLocale("zh-CN");
  try {
    const view = turnJobView(job({ status: "succeeded", asset: { assetId: "a1", revision: 2, fingerprint: "f", kind: "image" } as TurnJob["asset"] }), t);
    assert.equal(view.statusText, "已完成");
    assert.equal(view.assetText, "结果：image a1 r2");
  } finally {
    setActiveLocale("en-US");
  }
});
