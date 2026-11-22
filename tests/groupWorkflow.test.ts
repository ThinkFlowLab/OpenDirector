import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflowSteps } from "../src/canvas/groupWorkflow.ts";

const edge = (source: string, target: string) => ({ source, target, intent: undefined });

function harness(fail: readonly string[] = []) {
  const events: string[] = [];
  const pending = new Map<string, () => void>();
  let active = 0,
    peak = 0;
  const runStep = (id: string) =>
    new Promise<boolean>((resolve) => {
      events.push(`start:${id}`);
      active++;
      peak = Math.max(peak, active);
      pending.set(id, () => {
        active--;
        events.push(`end:${id}`);
        resolve(!fail.includes(id));
      });
    });
  const finish = async (id: string) => {
    for (let tries = 0; !pending.has(id) && tries < 50; tries++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    pending.get(id)!();
    pending.delete(id);
    await new Promise((resolve) => setTimeout(resolve, 1));
  };
  return { events, runStep, finish, peak: () => peak };
}

test("independent steps run concurrently and dependents wait for their references", async () => {
  const h = harness();
  // a -> c, b -> c, d independent.
  const run = runWorkflowSteps(["a", "b", "c", "d"], [edge("a", "c"), edge("b", "c")], h.runStep);
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.deepEqual(h.events, ["start:a", "start:b", "start:d"]);
  await h.finish("a");
  assert.ok(!h.events.includes("start:c"), "c waits for b");
  await h.finish("b");
  assert.ok(h.events.includes("start:c"));
  await h.finish("c");
  await h.finish("d");
  assert.deepEqual(await run, { succeeded: ["a", "b", "c", "d"], failed: [], skipped: [] });
  assert.equal(h.peak(), 3);
});

test("a failure skips its downstream chain but not unrelated steps", async () => {
  const h = harness(["a"]);
  const run = runWorkflowSteps(["a", "b", "c", "x"], [edge("a", "b"), edge("b", "c")], h.runStep);
  await h.finish("a");
  await h.finish("x");
  assert.deepEqual(await run, { succeeded: ["x"], failed: ["a"], skipped: ["b", "c"] });
  assert.ok(!h.events.includes("start:b"));
});

test("reference cycles are skipped; inputs-only nodes and edit provenance add no dependency", async () => {
  const h = harness();
  const run = runWorkflowSteps(
    ["a", "b", "c"],
    [edge("a", "b"), edge("b", "a"), edge("material", "c"), { source: "a", target: "c", intent: "post_edit_result" }],
    h.runStep,
  );
  await h.finish("c");
  assert.deepEqual(await run, { succeeded: ["c"], failed: [], skipped: ["a", "b"] });
});

test("a dependency carried through a non-step node still orders the steps", async () => {
  const h = harness();
  // image a -> subject s -> video b: b must wait for a.
  const run = runWorkflowSteps(["a", "b"], [edge("a", "s"), edge("s", "b")], h.runStep);
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.deepEqual(h.events, ["start:a"]);
  await h.finish("a");
  await h.finish("b");
  assert.deepEqual(await run, { succeeded: ["a", "b"], failed: [], skipped: [] });
});

test("a step that throws counts as failed", async () => {
  const result = await runWorkflowSteps(["a", "b"], [edge("a", "b")], async (id) => {
    if (id === "a") throw new Error("boom");
    return true;
  });
  assert.deepEqual(result, { succeeded: [], failed: ["a"], skipped: ["b"] });
});
