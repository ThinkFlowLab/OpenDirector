/** Original Trace archive export (#421): real UI click, real ZIP browser download.
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
// raw traces are intentionally sensitive; fixtures contain only synthetic sentinels.
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
  [turns[0].id + ".model.jsonl"]: line({ event: "model.request", payload: { messages: [{ content: system }], apiKey: key } }),
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
function unpack(zip) {
  const files = new Map();
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let offset = 0;
  while (offset + 4 < zip.length && view.getUint32(offset, true) === 0x04034b50) {
    assert.equal(view.getUint16(offset + 8, true), 0, "ZIP file uses STORE");
    const length = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const start = offset + 30 + nameLength + extraLength;
    files.set(name, zip.subarray(start, start + length));
    offset = start + length;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50, "central directory exists");
  assert.equal(view.getUint32(zip.length - 22, true), 0x06054b50, "ZIP end record exists");
  return files;
}

const labels = {
  "zh-CN": { exportButton: "下载原始轨迹（.zip）", failed: "原始轨迹下载失败（可能是来源不可用或超过容量上限），未保存不完整压缩包。",
    empty: "该对话还没有已执行的轮次。", title: "对话轨迹" },
  "en-US": { exportButton: "Download original trace (.zip)",
    failed: "Could not download original traces (an unavailable source or size limit may be the cause). No partial archive was saved.",
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
    page.on("dialog", (dialog) => dialog.accept()); // Accept the sensitive raw-data warning explicitly.
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
  async function exportArchive(page, seen, text) {
    const before = seen.requests.length;
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: text.exportButton, exact: true }).click(),
    ]);
    const during = seen.requests.slice(before);
    assert.ok(during.length > 0 && during.every((entry) => entry.startsWith("GET ")), JSON.stringify(during));
    assert.ok(during.some((entry) => /\/traces\/[^/]+\/model$/.test(entry)), "model requests are included");
    assert.ok(!during.some((entry) => /\/stop$|\/events$|\/resume|\/cancel|\/turns$/.test(entry)));
    assert.equal(download.suggestedFilename(), "opendirector-trace-" + conversationId + ".zip");
    const path = await download.path();
    assert.ok(path);
    return unpack(await readFile(path));
  }
  function assertArchive(files) {
    const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
    assert.equal(manifest.format, "opendirector-original-trace-archive");
    assert.equal(manifest.projectId, projectId);
    assert.equal(manifest.conversationId, conversationId);
    assert.equal(manifest.turns.length, 4);
    const names = [...files.keys()];
    assert.deepEqual(names, ["manifest.json", "turn-0001/model.jsonl", "turn-0001/opencode.jsonl",
      "turn-0002/codex.jsonl", "turn-0004/codex.jsonl"]);
    assert.ok(manifest.warning.includes("credentials"));
    assert.equal(manifest.turns[0].jobs[0].jobId, jobIds.succeeded);
    assert.equal(manifest.turns[1].jobs[0].status, "failed");
    assert.equal(manifest.turns[2].jobs[0].status, "running");
    assert.equal(manifest.turns[2].sources[0].status, "missing");
    assert.equal(manifest.turns[3].jobs, null);
    assert.equal(manifest.turns[0].sources[0].source, "model");
    for (const [file, content] of Object.entries(logs)) {
      const index = turns.findIndex((turn) => file.startsWith(turn.id + "."));
      const name = "turn-" + String(index + 1).padStart(4, "0") + "/" +
        file.slice(turns[index].id.length + 1);
      assert.equal(files.get(name)?.toString("utf8"), content, "raw byte-for-byte preservation: " + file);
    }
    const raw = [...files.values()].map((value) => value.toString("utf8")).join("\n");
    for (const sentinel of SECRETS)
      assert.ok(raw.includes(sentinel), "raw diagnostic content preserved: " + sentinel);
    assert.ok(raw.includes("not json "), "invalid JSONL lines must not be discarded");
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
      const files = await exportArchive(page, seen, text);
      assertArchive(files);
      assert.equal(await button.isEnabled(), true, "button is usable again");
      assert.equal(await page.getByRole("alert").count(), 0);
      assert.equal(await page.locator("details[open]").count(), 1, "export does not expand turns");
      if (evidence) await writeFile(join(evidence, "manifest-" + locale + ".json"), files.get("manifest.json"));

      // An old single-turn link for a listed turn resolves to the conversation and exports.
      await page.goto(`${base}/?traceProject=${projectId}&turn=${turns[2].id}&runtime=opencode`);
      await page.getByRole("heading", { name: text.title, exact: true }).waitFor();
      assertArchive(await exportArchive(page, seen, text));

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
console.log("original trace ZIP archive: ok");
