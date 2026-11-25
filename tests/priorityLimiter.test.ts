import assert from "node:assert/strict";
import test from "node:test";
import { PriorityLimiter } from "../src/backend/priorityLimiter.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve));

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("reads stay within the limit and urgent work starts first", async () => {
  const limiter = new PriorityLimiter(1);
  const blocker = gate();
  const order: string[] = [];
  const run = (name: string, priority: number, key?: string) =>
    limiter.run(async () => {
      order.push(name);
    }, { priority, key });
  const first = limiter.run(() => blocker.promise);
  const reads = [run("visible-1", 1), run("visible-2", 1, "two"), run("action", 0)];
  limiter.prioritize("two", 0);
  await tick();
  assert.deepEqual(order, []);
  blocker.resolve();
  await Promise.all([first, ...reads]);
  assert.deepEqual(order, ["action", "visible-2", "visible-1"]);
});

test("a cancelled queued read never starts and frees its place", async () => {
  const limiter = new PriorityLimiter(1);
  const blocker = gate();
  const controller = new AbortController();
  let started = false;
  const first = limiter.run(() => blocker.promise);
  const cancelled = limiter.run(async () => {
    started = true;
  }, { signal: controller.signal });
  const next = limiter.run(async () => "next");
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  blocker.resolve();
  await first;
  assert.equal(await next, "next");
  assert.equal(started, false);
});

test("a failed read releases its slot", async () => {
  const limiter = new PriorityLimiter(1);
  await assert.rejects(limiter.run(async () => {
    throw new Error("failed");
  }));
  assert.equal(await limiter.run(async () => "after"), "after");
});
