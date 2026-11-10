/** Check that tests/browser/manifest.json matches reality.
 *
 * The manifest is the single source of truth for which browser workflow runs
 * in which lane (PR gate, nightly extended / extended-fixture / production /
 * perf) and under which requirements. This check fails when:
 * - a script exists on disk but is not registered (or vice versa);
 * - a "production" lane entry imports "/src/*.ts" in-page (vite preview
 *   cannot serve dev-only imports);
 * - a script needing --assistant-fixture is assigned to a lane that runs on
 *   regular isolated services ("extended" / "perf");
 * - the manifest's "gate" lane disagrees with the browser scripts the
 *   gate actually invokes (scripts/run-browser-suite.mjs plus the
 *   fixture-phase scripts release-checks.yml runs directly).
 *
 * Run via `npm run check:browser-manifest` (part of Release checks).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const browserDir = "tests/browser";
const manifestPath = path.join(browserDir, "manifest.json");
const gateWorkflowPath = ".github/workflows/release-checks.yml";
// The gate's browser workflow list is owned by scripts/run-browser-suite.mjs;
// release-checks.yml only invokes fixture-phase scripts (auxiliary panels)
// directly next to it.
const gateSuitePath = "scripts/run-browser-suite.mjs";

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const entries = manifest.scripts;
const onDisk = fs
  .readdirSync(browserDir)
  .filter((file) => file.endsWith(".mjs"))
  .sort();

const problems = [];
const fail = (message) => problems.push(message);

const byFile = new Map(entries.map((entry) => [entry.file, entry]));
for (const file of onDisk) {
  if (!byFile.has(file)) fail(`${file} exists on disk but is not in the manifest`);
}
for (const entry of entries) {
  if (!byFile.get(entry)) continue;
  if (!onDisk.includes(entry.file)) fail(`${entry.file} is in the manifest but not on disk`);
}

const KNOWN_LANES = new Set(["gate", "extended", "extendedFixture", "production", "perf", "manual"]);
for (const entry of entries) {
  const text = entry.file === undefined ? "" : fs.readFileSync(path.join(browserDir, entry.file), "utf8");
  const importsSrc = text.includes('"/src/');
  const needsFixture = /assistant-fixture|assistantFixture/.test(text);
  const lanes = entry.lanes ?? [];
  const unknown = lanes.filter((lane) => !KNOWN_LANES.has(lane));
  if (unknown.length) fail(`${entry.file}: unknown lanes ${unknown.join(", ")}`);
  if (entry.helper) {
    if (lanes.length || entry.args) fail(`${entry.file}: helper entries must not carry lanes or args`);
    continue;
  }
  if (!lanes.length) fail(`${entry.file}: non-helper entry must declare at least one lane`);
  if (entry.previewSafe && importsSrc)
    fail(`${entry.file}: marked previewSafe but imports "/src/*.ts"`);
  if (lanes.includes("production") && !entry.previewSafe)
    fail(`${entry.file}: production lane requires previewSafe (vite preview cannot serve "/src" imports)`);
  if (needsFixture && !entry.fixture)
    fail(`${entry.file}: references the assistant fixture but is not marked fixture: true`);
  if (entry.fixture && !needsFixture)
    fail(`${entry.file}: marked fixture: true but never references the assistant fixture`);
  if (entry.fixture && (lanes.includes("extended") || lanes.includes("perf")))
    fail(`${entry.file}: fixture scripts cannot run on the regular extended/perf services`);
}

const gateFromManifest = new Set(
  entries.filter((entry) => (entry.lanes ?? []).includes("gate")).map((entry) => entry.file),
);
const gateWorkflow = fs.readFileSync(gateWorkflowPath, "utf8");
const gateSuite = fs.readFileSync(gateSuitePath, "utf8");
const gateFromWorkflow = new Set(
  [...gateSuite.matchAll(/tests\/browser\/([a-z0-9_]+\.mjs)/g)]
    .concat([...gateWorkflow.matchAll(/tests\/browser\/([a-z0-9_]+\.mjs)/g)])
    .map((match) => match[1]),
);
for (const file of gateFromManifest)
  if (!gateFromWorkflow.has(file))
    fail(`manifest "gate" lane: ${file} is not invoked by ${gateSuitePath} or ${gateWorkflowPath}`);
for (const file of gateFromWorkflow)
  if (!gateFromManifest.has(file))
    fail(`${gateSuitePath}/${gateWorkflowPath} invokes ${file} but the manifest "gate" lane does not include it`);

assert.equal(problems.length, 0, `browser manifest check failed:\n- ${problems.join("\n- ")}`);
const count = (lane) => entries.filter((entry) => (entry.lanes ?? []).includes(lane)).length;
console.log(
  `Browser manifest OK: ${entries.length} entries, ` +
    `gate=${count("gate")} extended=${count("extended")} extendedFixture=${count("extendedFixture")} ` +
    `production=${count("production")} perf=${count("perf")} manual=${count("manual")} helper=${entries.filter((entry) => entry.helper).length}`,
);
