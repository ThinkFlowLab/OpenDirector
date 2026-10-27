import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { wait } from "../src/backend/generation.ts";

test("wait removes its abort listener once the delay resolves", async () => {
  const controller = new AbortController();
  await wait(5, controller.signal);
  assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
});

test("wait rejects and clears the timer when aborted mid-delay", async () => {
  const controller = new AbortController();
  const pending = wait(60_000, controller.signal);
  controller.abort(new Error("已取消"));
  const failure = await pending.then(
    () => null,
    (error: unknown) => error,
  );
  assert.equal((failure as Error | null)?.message, "已取消");
  assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
});
