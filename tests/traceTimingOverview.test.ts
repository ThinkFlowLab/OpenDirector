import assert from "node:assert/strict";
import test from "node:test";
import { barPercent, buildTimingOverview, MIN_BAR_PERCENT, statusBadgeClass } from "../src/canvas/traceTimingOverview.ts";

const turn = (id: string, number: number, durationMs?: unknown, status = "complete") =>
  ({ id, number, text: id, runtime: "default", model: null, status, durationMs });

test("multi-turn bars are linear against the longest turn", () => {
  const { rows, maxMs, hasTiming } = buildTimingOverview([turn("a", 1, 1000), turn("b", 2, 4000), turn("c", 3, 2000)]);
  assert.equal(maxMs, 4000);
  assert.equal(hasTiming, true);
  assert.deepEqual(rows.map((r) => r.fraction), [0.25, 1, 0.5]);
  assert.deepEqual(rows.map((r) => r.slowest), [false, true, false]);
});

test("single turn: full bar, not flagged slowest", () => {
  const { rows } = buildTimingOverview([turn("a", 1, 500)]);
  assert.equal(rows[0].fraction, 1);
  assert.equal(rows[0].slowest, false);
});

test("zero duration has a marker and no bar fraction beyond 0", () => {
  const { rows } = buildTimingOverview([turn("a", 1, 0), turn("b", 2, 100)]);
  assert.equal(rows[0].zero, true);
  assert.equal(rows[0].kind, "timed");
  assert.equal(rows[0].durationMs, 0);
  assert.equal(rows[1].zero, false);
  const only = buildTimingOverview([turn("a", 1, 0)]);
  assert.equal(only.rows[0].fraction, 0);
  assert.equal(only.rows[0].slowest, false);
  assert.equal(only.hasTiming, true);
});

test("missing durationMs is unavailable without a bar", () => {
  const { rows, hasTiming, maxMs } = buildTimingOverview([turn("a", 1), turn("b", 2, null)]);
  assert.deepEqual(rows.map((r) => r.kind), ["unavailable", "unavailable"]);
  assert.deepEqual(rows.map((r) => r.fraction), [null, null]);
  assert.equal(hasTiming, false);
  assert.equal(maxMs, null);
});

test("running turn has no duration or bar and does not affect the scale", () => {
  const { rows, maxMs } = buildTimingOverview([turn("a", 1, 1000), turn("b", 2, 999999, "streaming")]);
  assert.equal(rows[1].kind, "running");
  assert.equal(rows[1].durationMs, null);
  assert.equal(rows[1].fraction, null);
  assert.equal(maxMs, 1000);
});

test("stopped and interrupted keep status and bar when duration is valid", () => {
  const { rows } = buildTimingOverview([turn("a", 1, 2000, "stopped"), turn("b", 2, 1000, "interrupted"), turn("c", 3, undefined, "stopped")]);
  assert.deepEqual(rows.map((r) => r.status), ["stopped", "interrupted", "stopped"]);
  assert.deepEqual(rows.map((r) => r.kind), ["timed", "timed", "unavailable"]);
  assert.equal(rows[1].fraction, 0.5);
});

test("magnitudes from ms to hours stay linear with a minimum visible width", () => {
  const { rows } = buildTimingOverview([turn("a", 1, 5), turn("b", 2, 3_600_000)]);
  assert.ok((rows[0].fraction as number) < 0.001);
  assert.equal(barPercent(rows[0].fraction as number), MIN_BAR_PERCENT);
  assert.equal(barPercent(1), 100);
  assert.equal(barPercent(0), 0);
  assert.equal(barPercent(0.5), 50);
});

test("rows are keyed by turn id, not index", () => {
  const { rows } = buildTimingOverview([turn("x", 1, 10), turn("y", 2, 20)]);
  assert.deepEqual(rows.map((r) => r.id), ["x", "y"]);
  assert.deepEqual(rows.map((r) => r.number), [1, 2]);
});

test("reordered input keeps ids attached to their data; ties keep input order", () => {
  const { rows } = buildTimingOverview([turn("c", 3, 30), turn("a", 1, 10), turn("b", 2, 20), turn("d", 2, 25)]);
  assert.deepEqual(rows.map((r) => r.id), ["a", "b", "d", "c"]);
  assert.equal(rows.find((r) => r.id === "c")?.durationMs, 30);
  assert.equal(rows.find((r) => r.id === "a")?.durationMs, 10);
});

test("equal slowest turns are all marked", () => {
  const { rows } = buildTimingOverview([turn("a", 1, 50), turn("b", 2, 50), turn("c", 3, 10)]);
  assert.deepEqual(rows.map((r) => r.slowest), [true, true, false]);
});

test("timestamps are never used to infer duration", () => {
  const { rows } = buildTimingOverview([{ ...turn("a", 1), startedAt: "2024-01-01T00:00:00Z", finishedAt: "2024-01-01T00:00:09Z" }]);
  assert.equal(rows[0].kind, "unavailable");
  assert.equal(rows[0].durationMs, null);
});

test("garbage input never throws", () => {
  const inputs: unknown[] = [null, undefined, 5, "x", {}, [null, undefined, 1, "a", [], {}],
    [turn("a", 1, Number.NaN), turn("b", 2, -5), turn("c", 3, Infinity), turn("d", 4, "10"), turn("e", 5, {})],
    [{ id: 1, number: "2" }, { id: "", number: 1 }, { id: "z" }, { id: "w", number: NaN, status: 7 }]];
  for (const input of inputs) assert.doesNotThrow(() => buildTimingOverview(input));
  const { rows } = buildTimingOverview(inputs[6]);
  assert.ok(rows.every((r) => r.kind === "unavailable" && r.fraction === null));
  assert.deepEqual(buildTimingOverview(null).rows, []);
  const odd = buildTimingOverview(inputs[7]);
  assert.deepEqual(odd.rows.map((r) => r.id), ["z", "w"]);
});

test("unrecognised status gets a neutral badge class, recognised ones keep theirs", () => {
  const { rows } = buildTimingOverview([turn("a", 1, 100, "weird"), turn("b", 2, 100, "stopped"), turn("c", 3, 100)]);
  assert.equal(rows[0].status, null);
  assert.equal(statusBadgeClass(rows[0].status), "is-turn-unknown");
  assert.equal(statusBadgeClass(rows[1].status), "is-turn-stopped");
  assert.equal(statusBadgeClass(rows[2].status), "is-turn-complete");
});
