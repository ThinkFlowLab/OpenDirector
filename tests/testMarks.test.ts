import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  browserCatalog, marks, options, ROOT, select, unitCatalog,
} from "../scripts/pre-commit/test-marks.ts";
import type { Entry } from "../scripts/pre-commit/test-marks.ts";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "test marks 中文 "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "tests/browser"), { recursive: true });
  return root;
}

function json(root: string, file: string, value: unknown) {
  writeFileSync(join(root, file), JSON.stringify(value), "utf8");
}

test("classifications must be explicit and invalid marks fail", () => {
  assert.throws(() => marks({}), /unknown layer/);
  assert.throws(() => marks({ layer: "merge" }), /unknown hardware/);
  assert.throws(() => marks({ hardware: "cuda" }), /unknown layer/);
  assert.deepEqual(marks({ layer: "merge", hardware: "cuda" }), { layer: "merge", hardware: "cuda" });
  for (const value of ["unit", "Ready", "", null, ["ready", "merge"]]) {
    assert.throws(() => marks({ layer: value }), /unknown layer/);
  }
  for (const value of ["gpu", "CPU", "cards_2", "", null, ["cpu", "gpu"]]) {
    assert.throws(() => marks({ layer: "ready", hardware: value }), /unknown hardware/);
  }
});

test("layer and hardware selection intersect and preserve environment lanes", () => {
  const entries: Entry[] = [
    { file: "a", script: "a", layer: "ready", hardware: "cpu", lanes: ["gate", "production"] },
    { file: "b", script: "b", layer: "merge", hardware: "cpu", lanes: ["extended"] },
    { file: "c", script: "c", layer: "nightly", hardware: "cuda", lanes: ["perf"] },
  ];
  assert.deepEqual(select(entries, {}), entries);
  assert.deepEqual(select(entries, options(["--layer", "ready,merge", "--hardware", "cpu"]).selection), entries.slice(0, 2));
  assert.deepEqual(select(entries, { lane: "production", layers: ["ready"] }), [entries[0]]);
  assert.deepEqual(select(entries, { hardware: ["cpu"], layers: ["nightly"] }), []);
});

test("selectors reject typos and missing values rather than running everything", () => {
  for (const args of [["--layer"], ["--hardware", "--list"], ["--layer", "read"], ["--hardware", "cpu,"], ["--lane", "nightly"], ["--typo"]]) {
    assert.throws(() => options(args));
  }
  assert.deepEqual(options(["--test-name-pattern=保存"], { passthrough: true }).forwarded, ["--test-name-pattern=保存"]);
});

test("unit inventory rejects missing, stale, duplicate and unsafe registrations", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "tests/one.test.ts"), "throw new Error('never import during discovery')");
  const save = (tests: unknown[]) => json(root, "tests/frontend-manifest.json", { schemaVersion: 1, tests });
  save([{ file: "one.test.ts", layer: "ready", hardware: "cpu" }]);
  assert.deepEqual(unitCatalog(root), [{ file: "one.test.ts", script: "tests/one.test.ts", layer: "ready", hardware: "cpu" }]);
  for (const entries of [[], [{ file: "missing.test.ts" }], [{ file: "one.test.ts" }, { file: "one.test.ts" }], [{ file: "../one.test.ts" }]]) {
    save(entries);
    assert.throws(() => unitCatalog(root));
  }
});

test("browser inventories preserve helpers, fixture requirements and multiple lanes", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "tests/browser/sample.mjs"), "throw new Error('inventory must not execute scripts')");
  const entry = { file: "sample.mjs", lanes: ["extendedFixture", "production"], fixture: true, layer: "nightly", hardware: "cpu" };
  json(root, "tests/browser/manifest.json", { scripts: [entry, { file: "helper.mjs", helper: true }] });
  assert.deepEqual(browserCatalog(root), [{ ...entry, layer: "nightly", hardware: "cpu", script: "tests/browser/sample.mjs" }]);
  json(root, "tests/browser/manifest.json", { scripts: [entry, entry] });
  assert.throws(() => browserCatalog(root), /duplicate/);
  json(root, "tests/browser/manifest.json", { scripts: [{ file: "helper.mjs", helper: true, hardware: "cpu" }] });
  assert.throws(() => browserCatalog(root), /helpers/);
});

test("live catalogs conserve unit discovery and the default browser gate schedule", () => {
  const units = unitCatalog();
  assert.equal(units.length, new Set(units.map((entry) => entry.file)).size);
  const listing = spawnSync(process.execPath, ["scripts/run-browser-suite.mjs", "--list"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  const scheduled = JSON.parse(listing.stdout);
  assert.equal(scheduled.length, 21);
  assert.deepEqual(scheduled.find((entry: Entry) => entry.file === "timeline_workflow.mjs").env, { PYTHON: "python" });
  assert.deepEqual(scheduled.find((entry: Entry) => entry.file === "canvas_layers.mjs").args, ["--generated"]);
});

test("list queries and empty selections cannot accidentally start test bodies", () => {
  const listed = spawnSync(process.execPath, ["scripts/run-unit-tests.mjs", "--layer", "ready", "--hardware", "cpu", "--list"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), unitCatalog());
  for (const runner of ["scripts/run-unit-tests.mjs", "scripts/run-browser-suite.mjs"]) {
    const empty = spawnSync(process.execPath, [runner, "--hardware", "cuda"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /No matching/);
  }
  const listedBrowser = spawnSync(process.execPath, ["scripts/list-browser-tests.mjs", "--layer", "nightly", "--hardware", "cpu", "--lane", "extendedFixture"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(listedBrowser.status, 0, listedBrowser.stderr);
  const entries = JSON.parse(listedBrowser.stdout);
  assert.ok(entries.length > 0);
  assert.deepEqual(entries, select(browserCatalog(), {
    layers: ["nightly"], hardware: ["cpu"], lane: "extendedFixture",
  }));
});
