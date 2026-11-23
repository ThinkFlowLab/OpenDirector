/** Conversation Trace report export (#421): real UI click, real browser download.
 * Run against creation_server.py --assistant-fixture; no model or provider is called.
 *
 * Real: project, conversation, turns (fixture agent, runtimes default and codex),
 * trace log files on disk, the Trace page and the browser download.
 * Fixture: linked Jobs. The fixture agent cannot create Jobs with Agent lineage,
 * so only GET .../assistant/turns/<id>/jobs is answered by page.route. Job lineage
 * itself is covered by tests/test_agent_job_lineage.py.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const evidence = process.env.TRACE_EXPORT_EVIDENCE_DIR;
const headers = {
  "X-OpenDirector-Request": "1",
  "X-OpenDirector-Session": crypto.randomUUID(),
  "Content-Type": "application/json",
};
async function api(path, body) {
  const response = await fetch(base + "/api" + path, {
    headers,
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, path + ": " + (await response.clone().text()));
  return response.json();
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const health = await api("/creation-test-health");
assert.equal(health.isolated, true);
assert.equal(health.assistantFixture, true);
await api("/creation-test-assistant-gate", { open: true });

const unique = crypto.randomUUID().slice(0, 8);
const projectId = crypto.randomUUID();
await api(`/creation/projects/${projectId}/commands`, {
  projectId,
  commandId: crypto.randomUUID(),
  type: "project.create",
  payload: { name: `Trace export ${unique}` },
});
await api(`/creation/projects/${projectId}/open`, {});
const assistant = `/creation/projects/${projectId}/assistant`;
const modelId = (await api("/model-configs")).find((model) => model.kind === "agent").id;

// Four executed turns with two runtimes. No prompt text here is a secret: the
// report may show the request preview by design.
const specs = [
  { runtime: "default", text: `Plan the opening shot ${unique}` },
  { runtime: "codex", text: `Render the second scene ${unique}` },
  { runtime: "default", text: `Add the closing title ${unique}` },
  { runtime: "codex", text: `Review the final cut ${unique}` },
];
const turns = [];
for (const spec of specs) {
  const id = crypto.randomUUID();
  const response = await fetch(base + "/api" + assistant + "/turns", {
    method: "POST",
    headers,
    body: JSON.stringify({ id, text: spec.text, runtime: spec.runtime, modelId }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  await response.text();
  turns.push({ ...spec, id });
}
const conversation = await api(assistant);
const conversationId = conversation.conversationId;
const indexed = await api(`${assistant}/conversations/${conversationId}/trace`);
assert.deepEqual(
  indexed.turns.map((turn) => [turn.id, turn.runtime, turn.status]),
  turns.map((turn) => [turn.id, turn.runtime, "complete"]),
);

// Seed trace logs next to the project (the server and this script share a machine).
const projects = join(health.root, "projects");
let directory;
for (const name of await readdir(projects)) {
  try {
    const info = JSON.parse(await readFile(join(projects, name, "project.json"), "utf8"));
    if (info.id === projectId) directory = join(projects, name);
  } catch {}
}
assert.ok(directory, "project directory must be found under the isolated root");
const SECRETS = [
  "SENTINEL_PROMPT_" + unique,
  "SENTINEL_SYSTEM_" + unique,
  "SENTINEL_TOOL_ARGS_" + unique,
  "SENTINEL_TOOL_RESULT_" + unique,
  "sk-DEMO" + unique + "KEYVALUE",
];
const [prompt, system, args, result, key] = SECRETS;
const line = (value) => JSON.stringify(value) + "\n";
const logs = {
  // opencode-style log for turn 1
  [`${turns[0].id}.opencode.jsonl`]:
    line({ event: "session.start", message: system }) +
    line({ native: { type: "tool", part: { state: { status: "completed", input: { path: args, apiKey: key }, output: result } } } }) +
    line({ event: "assistant.message", text: prompt }),
  // codex-style log for turn 2
  [`${turns[1].id}.codex.jsonl`]:
    line({ native: { type: "thread.started" } }) +
    line({ native: { type: "item.completed", item: { id: "i1", type: "command_execution", status: "completed", command: args, aggregated_output: result } } }) +
    line({ native: { type: "item.completed", item: { id: "i2", type: "agent_message", status: "failed", text: prompt } } }),
  // turn 3 has no log at all. Turn 4: partial and invalid JSON lines around one valid event.
  [`${turns[3].id}.codex.jsonl`]:
    "not json " + key + "\n" +
    line({ native: { type: "item.started", item: { id: "p1", status: "in_progress", command: args } } }) +
    `{"native":{"type":"item.completed","item":{"command":"${result}`,
};
await mkdir(join(directory, "agent-runs"), { recursive: true });
for (const [name, content] of Object.entries(logs))
  await writeFile(join(directory, "agent-runs", name), content);

const jobIds = {
  succeeded: `job-succeeded-${unique}`,
  failed: `job-failed-${unique}`,
  running: `job-running-${unique}`,
};
const jobPayload = {
  [turns[0].id]: [{ jobId: jobIds.succeeded, status: "succeeded", adopted: true }],
  [turns[1].id]: [{ jobId: jobIds.failed, status: "failed", adopted: false }],
  [turns[2].id]: [{ jobId: jobIds.running, status: "running", adopted: false }],
};
const failingJobs = turns[3].id;

const tracePage = (query) =>
  `${base}/?traceProject=${projectId}&${query}`;
const unescape = (text) => text.replace(/\\([\\`*_{}[\]()#+.!|])/g, "$1");
const section = (report, number) => {
  const found = report.split(/^## /m).find((part) => part.startsWith(`Turn ${number}\n`));
  assert.ok(found, `Turn ${number} section`);
  return unescape(found);
};

const labels = {
  "zh-CN": { exportButton: "导出轨迹报告（.md）", failed: "导出轨迹报告失败，请重试。",
    empty: "该对话还没有已执行的轮次。", title: "对话轨迹" },
  "en-US": { exportButton: "Export report (.md)", failed: "Could not export the trace report. Please retry.",
    empty: "This conversation has no executed turns.", title: "Conversation trace" },
};

const browser = await launchBrowser();
try {
  async function openContext(locale) {
    const context = await browser.newContext({ locale, viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    await context.addInitScript((value) => {
      localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
      localStorage.setItem("opendirector.locale.v1", value);
    }, locale);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const seen = { errors: [], requests: [] };
    page.on("pageerror", (error) => seen.errors.push(error.message));
    page.on("request", (request) => {
      if (request.url().startsWith(base)) seen.requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    await page.route(/\/assistant\/turns\/[^/]+\/jobs(?:\?.*)?$/, (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const turn = new URL(route.request().url()).pathname.split("/").at(-2);
      if (turn === failingJobs) return route.fulfill({ status: 500, json: { detail: "Jobs fixture failure" } });
      return route.fulfill({ json: jobPayload[turn] ?? [] });
    });
    return { context, page, seen };
  }
  async function exportReport(page, seen, text) {
    const before = seen.requests.length;
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: text.exportButton, exact: true }).click(),
    ]);
    // The click itself performs only GETs (trace logs and job lists).
    const during = seen.requests.slice(before);
    assert.ok(during.length > 0 && during.every((entry) => entry.startsWith("GET ")), JSON.stringify(during));
    assert.ok(!during.some((entry) => /\/traces\/[^/]+\/model$/.test(entry)), "raw model requests not fetched");
    assert.ok(!during.some((entry) => /\/stop$|\/events$|\/resume|\/cancel|\/turns$/.test(entry)));
    assert.equal(download.suggestedFilename(), `opendirector-trace-${conversationId}.md`);
    const path = await download.path();
    assert.ok(path, "download must be saved");
    return readFile(path, "utf8");
  }
  function assertReport(report) {
    assert.match(report, /^# OpenDirector Agent Trace Report/);
    assert.ok(report.includes(projectId) && report.includes(conversationId));
    // Every executed turn is present, not only the expanded one.
    for (const [index, turn] of turns.entries()) {
      const part = section(report, index + 1);
      assert.ok(part.includes(`Turn ID: ${turn.id}`), `turn ${index + 1} id`);
      assert.ok(part.includes(`Runtime: ${turn.runtime}`), `turn ${index + 1} runtime`);
      assert.ok(part.includes("Status: complete"), `turn ${index + 1} status`);
      assert.ok(part.includes(turn.text), `turn ${index + 1} request preview`);
    }
    const [one, two, three, four] = [1, 2, 3, 4].map((number) => section(report, number));
    assert.ok(one.includes("#### opencode") && !one.includes("#### codex"));
    assert.ok(two.includes("#### codex") && !two.includes("#### opencode"));
    assert.ok(!report.includes("#### model"), "raw model requests are not exported");
    // Event kinds and statuses only.
    assert.match(one, /- session\.start\n/);
    assert.match(one, /- tool \(completed\)/);
    assert.match(one, /- assistant\.message\n/);
    assert.match(two, /- item\.completed \(completed\)/);
    assert.match(two, /- item\.completed \(failed\)/);
    // Linked Jobs.
    assert.match(one, new RegExp(`${jobIds.succeeded}: succeeded \\(adopted\\)`));
    assert.match(two, new RegExp(`${jobIds.failed}: failed \\(not adopted\\)`));
    assert.match(three, new RegExp(`${jobIds.running}: running \\(not adopted\\)`));
    assert.ok(three.includes("Trace not recorded"), "missing log");
    assert.ok(four.includes("Job data unavailable"), "failed job request");
    assert.match(four, /- item\.started \(in_progress\)/);
    assert.ok(!/- item\.completed/.test(four), "a cut line must not create an event");
    // No raw content or credentials.
    for (const secret of SECRETS) assert.ok(!report.includes(secret), `report leaks ${secret}`);
    assert.ok(!/sk-DEMO/.test(report));
  }
  function assertReadOnly(seen) {
    assert.deepEqual(seen.errors, []);
    // Navigating away makes the app shell release its editing-session lease (DELETE
    // /api/creation/sessions/<id>, src/backend/api.ts). That is page lifecycle, not export.
    const writes = seen.requests.filter((entry) => !entry.startsWith("GET ") &&
      !/^DELETE \/api\/creation\/sessions\/[0-9a-f-]+$/.test(entry));
    assert.deepEqual(writes, [], "export must not write or call providers");
  }

  for (const locale of ["zh-CN", "en-US"]) {
    const text = labels[locale];
    const { context, page, seen } = await openContext(locale);
    try {
      // Only turn 2 is expanded; the report still covers all four turns.
      await page.goto(tracePage(`conversation=${conversationId}&turn=${turns[1].id}`));
      await page.getByRole("heading", { name: text.title, exact: true }).waitFor();
      const button = page.getByRole("button", { name: text.exportButton, exact: true });
      await button.waitFor();
      assert.equal(await button.isEnabled(), true);
      await page.locator(`#turn-${turns[1].id}[open]`).waitFor();
      assert.equal(await page.locator("details[open]").count(), 1);
      if (evidence) {
        await mkdir(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, `trace-page-${locale}.png`), fullPage: true });
      }
      const report = await exportReport(page, seen, text);
      assertReport(report);
      assert.equal(await button.isEnabled(), true, "button is usable again");
      assert.equal(await page.getByRole("alert").count(), 0);
      assert.equal(await page.locator("details[open]").count(), 1, "export does not expand turns");
      if (evidence) {
        const viewer = await context.newPage();
        await viewer.setContent(`<pre style="font:14px/1.5 monospace;white-space:pre-wrap">${report
          .replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`);
        await viewer.screenshot({ path: join(evidence, `report-${locale}.png`), fullPage: true });
        await viewer.close();
      }

      // An old single-turn link for a listed turn resolves to the conversation and exports.
      await page.goto(`${base}/?traceProject=${projectId}&turn=${turns[2].id}&runtime=opencode`);
      await page.getByRole("heading", { name: text.title, exact: true }).waitFor();
      assertReport(await exportReport(page, seen, text));

      // An unknown turn keeps the single-turn page, which has no export button.
      const unknown = crypto.randomUUID();
      await page.goto(`${base}/?traceProject=${projectId}&turn=${unknown}&runtime=opencode`);
      await page.locator("code", { hasText: unknown }).waitFor();
      assert.equal(await page.getByRole("button", { name: text.exportButton, exact: true }).count(), 0);
      assertReadOnly(seen);
    } finally {
      await context.close();
    }
  }

  // Export failure shows an alert and leaves the button usable.
  {
    const text = labels["en-US"];
    const { context, page, seen } = await openContext("en-US");
    try {
      await page.addInitScript(() => {
        URL.createObjectURL = () => {
          throw new Error("blocked for test");
        };
      });
      await page.goto(tracePage(`conversation=${conversationId}&turn=${turns[0].id}`));
      const button = page.getByRole("button", { name: text.exportButton, exact: true });
      await button.waitFor();
      let downloaded = false;
      page.on("download", () => (downloaded = true));
      await button.click();
      await page.getByRole("alert").filter({ hasText: text.failed }).waitFor();
      assert.equal(await button.isEnabled(), true);
      await sleep(300);
      assert.equal(downloaded, false);
      assert.deepEqual(seen.errors.filter((message) => !message.includes("blocked for test")), []);
    } finally {
      await context.close();
    }
  }

  // An empty conversation (a new one behind the executed one) disables export.
  const emptyId = crypto.randomUUID();
  await api(`${assistant}/conversations`, { id: emptyId });
  for (const locale of ["zh-CN", "en-US"]) {
    const text = labels[locale];
    const { context, page, seen } = await openContext(locale);
    try {
      await page.goto(tracePage(`conversation=${emptyId}`));
      await page.getByText(text.empty, { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: text.exportButton, exact: true }).isDisabled(), true);
      assertReadOnly(seen);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
console.log("trace report export: ok");
