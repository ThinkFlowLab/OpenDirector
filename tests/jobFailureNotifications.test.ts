import assert from "node:assert/strict";
import test from "node:test";
import { JobFailureNotifications } from "../src/canvas/workspace/jobFailureNotifications.ts";

const failure = (id = "task", createdAt = 101) => ({
  id,
  status: "failed" as const,
  createdAt,
});

test("a synchronous rejection and its failed job projection notify once in either order", () => {
  for (const first of ["submission", "observer"]) {
    const watch = new JobFailureNotifications(100);
    watch.observe({ ...failure(), status: "running" });
    const notices =
      first === "submission"
        ? [watch.claim("task"), watch.observe(failure())]
        : [watch.observe(failure()), watch.claim("task")];
    assert.deepEqual(notices, [true, false]);
    assert.equal(watch.observe(failure()), false);
  }
});

test("an accepted job's background failure is reported once across repeated snapshots", () => {
  const watch = new JobFailureNotifications(100);
  assert.equal(watch.observe({ ...failure(), status: "running" }), false);
  assert.equal(watch.observe(failure()), true);
  assert.equal(watch.observe(failure()), false);
  assert.equal(watch.observe({ ...failure(), status: "interrupted" }), false);
});

test("a render of the prior running snapshot cannot reopen a claimed failure", () => {
  const watch = new JobFailureNotifications(100);
  watch.observe({ ...failure(), status: "running" });
  assert.equal(watch.claim("task"), true);
  assert.equal(watch.observe({ ...failure(), status: "running" }), false);
  assert.equal(watch.observe(failure()), false);
  // Only running after the failed projection establishes another attempt.
  assert.equal(watch.observe({ ...failure(), status: "running" }), false);
  assert.equal(watch.observe(failure()), true);
});

test("distinct tasks with the same failure each own a notification", () => {
  const watch = new JobFailureNotifications(100);
  assert.equal(watch.observe(failure("first")), true);
  assert.equal(watch.observe(failure("second")), true);
  assert.equal(watch.claim("first"), false);
  assert.equal(watch.claim("second"), false);
});

test("a resumed job can fail again under the same task ID", () => {
  const watch = new JobFailureNotifications(100);
  assert.equal(watch.observe(failure()), true);
  assert.equal(watch.observe({ ...failure(), status: "running" }), false);
  assert.equal(watch.observe({ ...failure(), status: "running" }), false);
  assert.equal(watch.observe(failure()), true);
  assert.equal(watch.claim("task"), false);
});

test("reopening does not repeat a recent historical failure", () => {
  const previous = new JobFailureNotifications(100);
  assert.equal(previous.observe(failure()), true);
  const reopened = new JobFailureNotifications(102);
  assert.equal(reopened.observe(failure()), false);
  assert.equal(reopened.observe(failure()), false);
  assert.equal(reopened.observe(failure("new-task", 103)), true);
});

test("an older job observed running still reports its later failure", () => {
  const watch = new JobFailureNotifications(100);
  assert.equal(
    watch.observe({ ...failure("old-task", 90), status: "running" }),
    false,
  );
  assert.equal(watch.observe(failure("old-task", 90)), true);
});

test("an unconfirmed submission does not consume a later execution failure", () => {
  const watch = new JobFailureNotifications(100);
  // An uncertain delivery remains running; only a definitive rejection claims failure.
  assert.equal(watch.observe({ ...failure(), status: "running" }), false);
  assert.equal(watch.observe({ ...failure(), status: "running" }), false);
  assert.equal(watch.observe(failure()), true);
});

test("confirmed recovery reports a second failure without an intermediate running snapshot", () => {
  const watch = new JobFailureNotifications(100);
  const original = { ...failure(), revision: 4 };
  assert.equal(watch.observe(original), true);
  watch.recovered("task", 4);
  assert.equal(watch.observe(original), false);
  assert.equal(watch.observe({ ...original, revision: 6 }), true);
  assert.equal(watch.observe({ ...original, revision: 6 }), false);
  assert.equal(
    watch.observe({ ...original, status: "running", revision: 5 }),
    false,
  );
  assert.equal(watch.observe({ ...original, revision: 6 }), false);
});

test("a recovery receipt cannot repeat a new failure already reported by the observer", () => {
  const watch = new JobFailureNotifications(100);
  watch.observe({ ...failure(), revision: 4 });
  watch.observe({ ...failure(), status: "running", revision: 5 });
  assert.equal(watch.observe({ ...failure(), revision: 6 }), true);
  watch.recovered("task", 4);
  assert.equal(watch.observe({ ...failure(), revision: 6 }), false);
});

test("a fast failure observed before its recovery receipt is still reported after confirmation", () => {
  const watch = new JobFailureNotifications(100);
  assert.equal(watch.observe({ ...failure(), revision: 4 }), true);
  assert.equal(watch.observe({ ...failure(), revision: 6 }), false);
  watch.recovered("task", 4);
  assert.equal(watch.observe({ ...failure(), revision: 6 }), true);
  assert.equal(watch.observe({ ...failure(), revision: 6 }), false);
});

test("revision changes alone do not announce another failure without successful recovery", () => {
  const watch = new JobFailureNotifications(100);
  assert.equal(watch.observe({ ...failure(), revision: 4 }), true);
  assert.equal(watch.observe({ ...failure(), revision: 5 }), false);
});

test("a confirmed recovery of historical failure can report new failure after reopening", () => {
  const watch = new JobFailureNotifications(200);
  assert.equal(watch.observe({ ...failure(), revision: 4 }), false);
  watch.recovered("task", 4);
  assert.equal(watch.observe({ ...failure(), revision: 6 }), true);
});
