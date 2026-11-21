/** Check that tests/browser/manifest.json matches reality.
 *
 * The manifest is the single source of truth for which browser workflow runs
 * in which lane (PR gate, nightly extended / extended-fixture / production /
 * perf) and under which requirements. This check fails when:
 * - a script exists on disk but is not registered (or vice versa);
 * - a "production" lane entry imports "/src" or "/tests" in-page (vite preview
 *   cannot serve dev-only modules);
 * - a page script forgets to dismiss the model-setup welcome;
 * - a script needing --assistant-fixture is assigned to a lane that runs on
 *   regular isolated services ("extended" / "perf");
 * - the manifest's "gate" lane disagrees with the browser scripts the
 *   gate actually invokes (scripts/run-browser-suite.mjs plus the
 *   fixture-phase scripts release-checks.yml runs directly).
 *
 * Run via `npm run check:browser-manifest` (part of Release checks).
 * With --lane extendedFixture/extendedHttpFixture, also validate the live
 * CREATION_API_URL and CREATION_WEB_URL services before running the lane.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

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

const FIXTURE_LANES = ["extendedFixture", "extendedHttpFixture"];
const KNOWN_LANES = new Set(["gate", "extended", ...FIXTURE_LANES, "production", "perf", "manual"]);
// Static harness pages do not open the workspace, so they do not see the welcome dialog.
// The bilingual defaults test exercises the welcome dialog itself.
const welcomeExempt = new Set(["assistant_activity.mjs", "bilingual_defaults.mjs"]);
for (const entry of entries) {
  const text = entry.file === undefined ? "" : fs.readFileSync(path.join(browserDir, entry.file), "utf8");
  const importsSrc = text.includes('"/src/');
  // vite preview serves dist only. In-page imports of source or test modules 404 there.
  const needsDevServer = /["'`]\/(?:src|tests)\//.test(text);
  const needsFixture = /assistant-fixture|assistantFixture/.test(text);
  const needsHttpFixture = /http-generation-fixture|httpGenerationFixture/.test(text);
  const lanes = entry.lanes ?? [];
  const unknown = lanes.filter((lane) => !KNOWN_LANES.has(lane));
  if (unknown.length) fail(`${entry.file}: unknown lanes ${unknown.join(", ")}`);
  if (entry.helper) {
    if (lanes.length || entry.args) fail(`${entry.file}: helper entries must not carry lanes or args`);
    continue;
  }
  if (!lanes.length) fail(`${entry.file}: non-helper entry must declare at least one lane`);
  if (entry.previewSafe && (importsSrc || needsDevServer))
    fail(`${entry.file}: marked previewSafe but imports a dev-server module ("/src" or "/tests")`);
  if (lanes.includes("production") && (!entry.previewSafe || needsDevServer))
    fail(`${entry.file}: production lane requires previewSafe and cannot import "/src" or "/tests" modules`);
  if (
    !entry.helper &&
    !welcomeExempt.has(entry.file) &&
    text.includes("newPage(") &&
    !text.includes("opendirector.modelSetup.v1")
  )
    fail(`${entry.file}: opens a browser page but does not dismiss the model-setup welcome`);
  if (needsFixture && !entry.fixture)
    fail(`${entry.file}: references the assistant fixture but is not marked fixture: true`);
  if (entry.fixture && !needsFixture)
    fail(`${entry.file}: marked fixture: true but never references the assistant fixture`);
  if (entry.fixture && (lanes.includes("extended") || lanes.includes("perf")))
    fail(`${entry.file}: fixture scripts cannot run on the regular extended/perf services`);
  if (needsHttpFixture !== Boolean(entry.httpGenerationFixture))
    fail(`${entry.file}: httpGenerationFixture must match the script's HTTP fixture requirement`);
  if (entry.httpGenerationFixture && lanes.some((lane) => lane !== "extendedHttpFixture"))
    fail(`${entry.file}: HTTP generation requires the separate extendedHttpFixture services`);
  if (lanes.includes("extendedHttpFixture") && !entry.httpGenerationFixture)
    fail(`${entry.file}: generic provider scripts cannot run in extendedHttpFixture`);
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

const nightly = fs.readFileSync(".github/workflows/nightly.yml", "utf8");
if (
  !nightly.includes("CREATION_WEB_URL=http://127.0.0.1:5180") ||
  !nightly.includes("CREATION_API_URL=http://127.0.0.1:8020")
)
  fail("nightly extendedFixture scripts must run against the fixture web (:5180) and API (:8020)");
for (const lane of FIXTURE_LANES) {
  if (!nightly.includes(`node scripts/check-browser-manifest.mjs --lane ${lane}`))
    fail(`nightly ${lane} must validate the running services before running browser scripts`);
}

assert.equal(problems.length, 0, `browser manifest check failed:\n- ${problems.join("\n- ")}`);
const { values: { lane } } = parseArgs({ options: { lane: { type: "string" } } });
if (lane !== undefined) {
  assert.ok(FIXTURE_LANES.includes(lane), `Unknown fixture lane: ${lane}`);
  const scripts = entries.filter((entry) => entry.lanes?.includes(lane));
  assert.ok(scripts.length, `${lane}: no scripts registered`);
  const healths = [];
  // Query both addresses: direct test calls and browser requests through Vite
  // must reach the same API with the flags required by the selected scripts.
  for (const key of ["CREATION_API_URL", "CREATION_WEB_URL"]) {
    assert.ok(process.env[key], `${lane}: ${key} is required`);
    const response = await fetch(new URL("/api/creation-test-health", process.env[key]), {
      headers: { "X-OpenDirector-Request": "1" }, signal: AbortSignal.timeout(5000),
    });
    assert.ok(response.ok, `${key}: health returned HTTP ${response.status}`);
    const health = await response.json();
    assert.equal(health.isolated, true, `${key}: expected isolated fixture service`);
    assert.ok(typeof health.root === "string" && health.root.length, `${key}: missing fixture root`);
    for (const entry of scripts) {
      assert.equal(health.httpGenerationFixture, Boolean(entry.httpGenerationFixture),
        `${key}: ${entry.file} requires httpGenerationFixture=${Boolean(entry.httpGenerationFixture)}`);
      if (entry.fixture)
        assert.equal(health.assistantFixture, true, `${key}: ${entry.file} requires assistantFixture=true`);
    }
    healths.push(health);
  }
  assert.equal(healths[0].root, healths[1].root, "API and web proxy must reach the same fixture");
  console.log(`${lane}: running API and web fixture configuration verified`);
}
const count = (lane) => entries.filter((entry) => (entry.lanes ?? []).includes(lane)).length;
console.log(
  `Browser manifest OK: ${entries.length} entries, ` +
    `gate=${count("gate")} extended=${count("extended")} extendedFixture=${count("extendedFixture")} extendedHttpFixture=${count("extendedHttpFixture")} ` +
    `production=${count("production")} perf=${count("perf")} manual=${count("manual")} helper=${entries.filter((entry) => entry.helper).length}`,
);
