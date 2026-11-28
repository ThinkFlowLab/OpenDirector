/** Trace timing overview (#468 Slice B): one row per turn above the turn list, linked to the existing details.
 * Real UI and API with the local assistant fixture; only model replies are fixtures.
 * Start creation_server.py with --assistant-fixture before running this check.
 *
 * Real data: turn durations are the persisted server-measured durationMs (read back through the API and
 * formatted with the app's own formatTurnDuration). The slow turn and the Running turn are real: the
 * assistant gate is closed while the turn runs (the only sleep is that real server-measured wait).
 * Route-rewritten data (documented where used): GET .../conversations/<id>/trace is fulfilled with edited JSON
 * for legacy (timing stripped), stopped/interrupted statuses, and the varied durations of the 50/100 turn
 * sessions. Nothing is rewritten for the other checks. Set SCREENSHOT_DIR to also save screenshots.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { launchBrowser } from "./engine.mjs";
import { formatTurnDuration } from "../../src/canvas/turnTiming.ts";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const shots = process.env.SCREENSHOT_DIR;
if (shots) mkdirSync(shots, { recursive: true });
// One editor session owns one project lease, so each project gets its own session id (sessions build in parallel).
const sessions = new Map();
const headersFor = (path) => {
  const project = path.match(/\/projects\/([0-9a-f-]{36})/)?.[1] ?? "";
  if (!sessions.has(project)) sessions.set(project, crypto.randomUUID());
  return { "X-OpenDirector-Request": "1", "X-OpenDirector-Session": sessions.get(project), "Content-Type": "application/json" };
};
async function api(path, value) {
  const response = await fetch(base + "/api" + path, {
    headers: headersFor(path),
    ...(value ? { method: "POST", body: JSON.stringify(value) } : {}),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function until(read, matches, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (true) {
    const value = await read();
    if (matches(value)) return value;
    assert.ok(Date.now() < deadline, `${label}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const health = await api("/creation-test-health");
assert.equal(health.isolated, true);
assert.equal(health.assistantFixture, true);
await api("/creation-test-assistant-gate", { open: true });

const copy = {
  "en-US": {
    title: "Timing overview", running: "Running", done: "Completed", stopped: "Stopped", interrupted: "Interrupted",
    unavailable: "Unavailable", noData: "No timing data", slowest: "Slowest turn", turns: "Turns",
    select: (n) => `Select turn ${n}`,
  },
  "zh-CN": {
    title: "耗时概览", running: "运行中", done: "已完成", stopped: "已停止", interrupted: "已中断",
    unavailable: "不可用", noData: "暂无耗时数据", slowest: "最慢的一轮", turns: "轮次",
    select: (n) => `选择第 ${n} 轮`,
  },
};
const runtimes = [{
  id: "default", label: "Default", group: "default", modelSource: "settings",
  available: true, status: "ready", modelOverride: false, supportsSkills: true,
}];
const traceUrl = (projectId, conversationId, turn) => `${base}/?${new URLSearchParams({
  traceProject: projectId, conversation: conversationId, turn, runtime: "opencode",
})}`;
const tracePath = (projectId, conversationId) => `/creation/projects/${projectId}/assistant/conversations/${conversationId}/trace`;

async function newProject(label) {
  const projectId = crypto.randomUUID();
  await api(`/creation/projects/${projectId}/commands`, {
    type: "project.create", projectId, commandId: crypto.randomUUID(),
    payload: { name: `${label} ${projectId.slice(0, 8)}` },
  });
  await api(`/creation/projects/${projectId}/open`, {});
  return projectId;
}
// POST /turns answers with an event stream; with the gate open it ends when the turn is persisted.
// Response headers arrive with the first stream chunk, which a closed gate can delay: callers await `response` late.
function startTurn(projectId, text, conversationId = null) {
  const id = crypto.randomUUID();
  const response = api(`/creation/projects/${projectId}/open`, {}).then(() => fetch(`${base}/api/creation/projects/${projectId}/assistant/turns`, {
    method: "POST", headers: headersFor(`/projects/${projectId}`),
    body: JSON.stringify({ id, text, runtime: "codex", ...(conversationId ? { conversationId } : {}) }),
  })).then(async (value) => {
    assert.ok(value.ok, await value.clone().text());
    return value;
  });
  response.catch(() => {});
  return { id, response };
}
// The event stream is only detached (the run continues); completion is read from the persisted conversation.
async function settled(projectId, count, conversationId) {
  if (count > 1 && conversationId)
    return until(() => persisted(projectId, conversationId),
      (turns) => turns.length === count && turns.at(-1).status === "complete", "Turn must be persisted");
  return until(() => api(`/creation/projects/${projectId}/assistant`),
    (value) => value.messages.length === count * 2 && value.messages.at(-1)?.status === "complete", "Turn must be persisted");
}
async function runTurn(projectId, text, conversationId, count) {
  const { id, response } = startTurn(projectId, text, conversationId);
  await settled(projectId, count, conversationId);
  await (await response).body.cancel();
  return id;
}
const conversationOf = async (projectId) => (await api(`/creation/projects/${projectId}/assistant`)).conversationId;
const persisted = async (projectId, conversationId) => (await api(tracePath(projectId, conversationId))).turns;

const rewrite = (page, conversationId, mutate) =>
  page.route(new RegExp(`/assistant/conversations/${conversationId}/trace$`), async (route) => {
    if (route.request().method() !== "GET") return route.continue().catch(() => {});
    try {
      const response = await route.fetch();
      const body = await response.json();
      mutate(body);
      await route.fulfill({ status: response.status(), json: body });
    } catch {
      // An aborted fetch (effect cleanup, page close) disposes the response mid-read.
      await route.continue().catch(() => {});
    }
  });

const browser = await launchBrowser();
const perf = [];
const notes = [];
async function newPage(projectId, locale, viewport = { width: 1440, height: 1000 }) {
  const page = await browser.newPage({ locale, viewport });
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => assert.fail(error.message));
  await page.route(/\/assistant\/runtimes(?:\?.*)?$/, (route) => route.fulfill({ json: runtimes }));
  await page.addInitScript(([id, current]) => {
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    localStorage.setItem("opendirector.locale.v1", current);
    localStorage.setItem("opendirector.lastUnifiedFilesystemProject", id);
  }, [projectId, locale]);
  return page;
}
const rows = (page) => page.locator(".cw-trace-overview-row");
const values = (page) => page.locator(".cw-trace-overview-value").evaluateAll(
  (nodes) => nodes.map((node) => node.textContent.replace("▲", "").trim()));
const selectedNumbers = (page) => rows(page).evaluateAll(
  (nodes) => nodes.flatMap((node, index) => node.getAttribute("aria-pressed") === "true" ? [index + 1] : []));
const isOpen = (page, id) => page.locator(`#turn-${id}`).evaluate((node) => node.open);
const topOf = (page, id) => page.locator(`#turn-${id}`).evaluate((node) => node.getBoundingClientRect().top);
// Details top lands just under the sticky turn nav (scroll-margin-top 48px), so within 0..60px of the viewport top.
// A page too short to scroll that far (few collapsed turns, the old reveal() behaviour shared with the turn nav)
// may leave the details lower, but they must still be inside the viewport; allowShort accepts that and reports it.
async function placed(page, id, label, allowShort = true) {
  const state = await until(async () => ({ top: await topOf(page, id), height: await page.evaluate(() => innerHeight) }),
    ({ top, height }) => (top >= -2 && top <= 60) || (allowShort && top > 60 && top < height - 100), label);
  return state.top > 60;
}
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };

try {
  for (const locale of ["en-US", "zh-CN"]) {
    const words = copy[locale];
    const projectId = await newProject("Overview");
    // Three real turns: fast, deliberately slow (gate closed for ~1.2 s, a real server-measured wait), fast.
    const first = await runTurn(projectId, "Beach film", null, 1);
    const conversationId = await conversationOf(projectId);
    await api("/creation-test-assistant-gate", { open: false });
    const slow = startTurn(projectId, "Forest film", conversationId);
    await until(async () => (await persisted(projectId, conversationId)).at(-1)?.status,
      (status) => status === "streaming", "Slow turn must be running");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await api("/creation-test-assistant-gate", { open: true });
    await settled(projectId, 2, conversationId);
    await (await slow.response).body.cancel();
    const third = await runTurn(projectId, "Mountain film", conversationId, 3);
    const turns = await persisted(projectId, conversationId);
    assert.deepEqual(turns.map((turn) => turn.id), [first, slow.id, third]);
    for (const turn of turns) assert.ok(Number.isInteger(turn.durationMs) && turn.durationMs >= 0, JSON.stringify(turn));
    assert.ok(turns[1].durationMs >= 1000, `Slow turn recorded ${turns[1].durationMs} ms`);
    const expected = turns.map((turn) => formatTurnDuration(turn.durationMs));

    const page = await newPage(projectId, locale);
    await page.goto(traceUrl(projectId, conversationId, first));
    await until(() => rows(page).count(), (count) => count === 3, "Overview lists three turns");
    const overview = page.locator(".cw-trace-overview");
    assert.equal(await overview.getAttribute("aria-label"), words.title);
    // DOM order: export, overview, turn navigation, then the turn details.
    const order = await page.evaluate(() => {
      const follows = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      const overview = document.querySelector(".cw-trace-overview");
      return [document.querySelector(".cw-trace-export"), document.querySelector("nav.cw-trace-turnnav"),
        document.querySelector(".cw-trace-turn")].map((node, index) => index === 0 ? follows(node, overview) : follows(overview, node));
    });
    assert.deepEqual(order, [true, true, true], "Overview sits between export and the turn list");
    assert.equal(await page.locator(".cw-trace-overview .cw-trace-turn").count(), 0);

    // Durations equal the persisted values, the slow turn is marked and has the longest bar.
    assert.deepEqual(await values(page), expected);
    const labels = await rows(page).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
    labels.forEach((label, index) => {
      assert.ok(label.startsWith(`${words.select(index + 1)}, ${words.done}, ${expected[index]}`), label);
      assert.equal(label.includes(words.slowest), index === 1, label);
    });
    assert.equal(await page.locator(".cw-trace-overview-row.is-slowest").count(), 1);
    assert.ok(await rows(page).nth(1).evaluate((node) => node.classList.contains("is-slowest")));
    const widths = await page.locator(".cw-trace-overview-bar").evaluateAll(
      (nodes) => nodes.map((node) => node.getBoundingClientRect().width));
    assert.equal(widths.length, 3);
    assert.ok(widths[1] > widths[0] * 5 && widths[1] > widths[2] * 5, `bar widths ${widths}`);
    assert.ok(widths[0] > 0 && widths[2] > 0, "Short turns still draw a bar");
    for (const box of await rows(page).evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height)))
      assert.ok(box >= 24, `Row height ${box}`);
    assert.equal(await page.locator(".cw-trace-overview [role=status]").count(), 0);

    // Selection follows the deep link, then a click: selected state, details open, lazy load, scroll.
    assert.deepEqual(await selectedNumbers(page), [1]);
    assert.equal(await isOpen(page, first), true);
    await page.waitForLoadState("networkidle");
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    await rows(page).nth(1).click();
    assert.deepEqual(await selectedNumbers(page), [2]);
    await until(() => isOpen(page, slow.id), Boolean, "Clicked turn opens");
    await until(async () => requests.some((url) => url.includes(`/traces/${slow.id}`)), Boolean, "Opening loads the turn");
    assert.ok(!requests.some((url) => url.includes(`/traces/${third}`)), "Other turns stay unloaded");
    // Near the viewport top, or the page cannot scroll further (three short turns).
    await placed(page, slow.id, "Details scroll into place");
    await page.locator(`#turn-${slow.id} .cw-trace-turn-meta`).getByText(words.done, { exact: true }).waitFor();

    // Keyboard: Tab from the export button reaches the rows in order; Enter and Space select.
    await page.locator(".cw-trace-export button").focus();
    await page.keyboard.press("Tab");
    assert.equal(await rows(page).nth(0).evaluate((node) => node === document.activeElement), true, "Tab reaches the first row");
    assert.ok(await rows(page).nth(0).evaluate((node) => getComputedStyle(node).outlineStyle !== "none" && parseFloat(getComputedStyle(node).outlineWidth) > 0),
      "Focused row has a visible outline");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    assert.equal(await rows(page).nth(2).evaluate((node) => node === document.activeElement), true);
    await page.keyboard.press("Enter");
    assert.deepEqual(await selectedNumbers(page), [3]);
    await until(() => isOpen(page, third), Boolean, "Enter opens turn 3");
    await page.keyboard.press("Shift+Tab");
    assert.equal(await rows(page).nth(1).evaluate((node) => node === document.activeElement), true);
    await page.keyboard.press("Space");
    assert.deepEqual(await selectedNumbers(page), [2]);
    assert.equal(await isOpen(page, slow.id), true);
    assert.equal(await page.locator("nav.cw-trace-turnnav").getByRole("button", { name: "2", exact: true }).count(), 1, "Turn nav kept");
    await page.evaluate(() => scrollTo(0, 0));
    await shot(page, `overview-${locale}`);

    // Light theme: the Trace page has dark-only styles, so the attribute changes nothing. Report, do not hide.
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    const light = await page.evaluate(() => {
      const row = document.querySelector(".cw-trace-overview-row");
      const channel = (value) => { const v = value / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      const luminance = (css) => { const [r, g, b] = css.match(/[\d.]+/g).map(Number); return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b); };
      const fg = luminance(getComputedStyle(row).color);
      const bg = luminance(getComputedStyle(document.querySelector(".cw-trace-overview-track")).backgroundColor);
      const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      return { pageBackground: (() => {
        for (let node = row; node; node = node.parentElement) {
          const color = getComputedStyle(node).backgroundColor;
          if (!color.startsWith("rgba(0, 0, 0, 0")) return color;
        }
        return "rgb(255, 255, 255)";
      })(), rowColor: getComputedStyle(row).color, trackContrast: Number(ratio.toFixed(2)) };
    });
    notes.push({ locale, lightThemeAttribute: light, finding: "Trace page ignores data-theme (dark-only CSS); text stays legible" });
    assert.ok(light.trackContrast >= 1.5 && luminanceIsDark(light.pageBackground), JSON.stringify(light));
    await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));

    // 360px: no horizontal overflow, rows still tappable.
    await page.setViewportSize({ width: 360, height: 800 });
    const fit = await page.evaluate(() => {
      const list = document.querySelector(".cw-trace-overview-list");
      return { page: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
        list: [list.scrollWidth, list.clientWidth] };
    });
    assert.ok(fit.page[0] <= fit.page[1] && fit.list[0] <= fit.list[1], JSON.stringify(fit));
    await page.evaluate(() => scrollTo(0, 0));
    await shot(page, `overview-${locale}-360`);
    await rows(page).nth(0).click();
    assert.deepEqual(await selectedNumbers(page), [1]);
    await page.close();

    // Legacy turns with durationMs stripped (route-rewritten GET): Unavailable, No timing data, details still open.
    const legacy = await newPage(projectId, locale);
    await rewrite(legacy, conversationId, (body) => {
      for (const turn of body.turns) for (const key of ["startedAt", "finishedAt", "durationMs"]) delete turn[key];
    });
    await legacy.goto(traceUrl(projectId, conversationId, first));
    await until(() => rows(legacy).count(), (count) => count === 3, "Legacy overview lists turns");
    assert.deepEqual(await values(legacy), [words.unavailable, words.unavailable, words.unavailable]);
    assert.equal(await legacy.getByRole("status").filter({ hasText: words.noData }).count(), 1);
    assert.equal(await legacy.locator(".cw-trace-overview-bar").count(), 0, "No invented bars");
    assert.equal(await legacy.locator(".cw-trace-overview-row.is-slowest").count(), 0);
    assert.equal(await isOpen(legacy, first), true, "Details open without timing");
    await rows(legacy).nth(2).click();
    await until(() => isOpen(legacy, third), Boolean, "Legacy click opens details");
    await legacy.close();

    // Stopped and interrupted turns keep their status and a trusted duration (rewritten statuses and durations).
    const ended = await newPage(projectId, locale);
    await rewrite(ended, conversationId, (body) => {
      Object.assign(body.turns[0], { status: "interrupted", durationMs: 820 });
      Object.assign(body.turns[1], { status: "stopped", durationMs: 3100 });
    });
    await ended.goto(traceUrl(projectId, conversationId, first));
    await until(() => rows(ended).count(), (count) => count === 3, "Ended overview lists turns");
    assert.deepEqual((await values(ended)).slice(0, 2), ["820 ms", "3.1 s"]);
    const endedLabels = await rows(ended).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
    assert.ok(endedLabels[0].includes(`${words.interrupted}, 820 ms`), endedLabels[0]);
    assert.ok(endedLabels[1].includes(`${words.stopped}, 3.1 s`) && endedLabels[1].includes(words.slowest), endedLabels[1]);
    await ended.close();

    // A real Running turn: the gate stays closed, so the server reports streaming and polling keeps going.
    await api("/creation-test-assistant-gate", { open: false });
    const held = startTurn(projectId, "Held film", conversationId);
    try {
      await until(async () => (await persisted(projectId, conversationId)).at(-1)?.status,
        (status) => status === "streaming", "Held turn must be running");
      const running = await newPage(projectId, locale);
      const polls = [];
      running.on("request", (request) => { if (request.url().endsWith(`/conversations/${conversationId}/trace`)) polls.push(Date.now()); });
      await running.goto(traceUrl(projectId, conversationId, first));
      await until(() => rows(running).count(), (count) => count === 4, "Running overview lists four turns");
      const row = rows(running).nth(3);
      // Running appears once: in the status badge only. No duration text, no number, no bar or zero marker.
      const occurrences = (text) => text.split(words.running).length - 1;
      assert.equal(occurrences(await row.innerText()), 1, "Running is shown exactly once in the row");
      assert.equal((await row.locator(".cw-trace-badge").textContent()).trim(), words.running);
      assert.equal((await row.locator(".cw-trace-overview-value").textContent()).trim(), "", "No duration text for a running turn");
      assert.doesNotMatch(await row.innerText(), /\d+(?:\.\d+)?\s*(?:ms|s)\b|\d+m \d+s|\d+h \d+m/, "No duration number for a running turn");
      assert.equal(await row.locator(".cw-trace-overview-bar, .cw-trace-overview-zero").count(), 0, "No bar for a running turn");
      const runningLabel = await row.getAttribute("aria-label");
      assert.ok(runningLabel.startsWith(`${words.select(4)}, ${words.running}`), runningLabel);
      assert.equal(occurrences(runningLabel), 1, "Running is announced exactly once");
      assert.deepEqual((await values(running)).slice(0, 3), expected);
      const before = polls.length;
      await until(async () => polls.length, (count) => count >= before + 2, "Polling continues while running", 10000);
      // Release the turn: the same page picks up the persisted duration without reload.
      await api("/creation-test-assistant-gate", { open: true });
      await settled(projectId, 4, conversationId);
      await (await held.response).body.cancel();
      const finished = (await persisted(projectId, conversationId)).at(-1);
      assert.equal(finished.status, "complete");
      await until(() => row.locator(".cw-trace-overview-value").textContent(),
        (text) => text.replace("▲", "").trim() === formatTurnDuration(finished.durationMs), "Running row settles to the persisted duration");
      assert.equal(await row.locator(".cw-trace-overview-bar").count(), 1);
      await running.close();
    } finally {
      await api("/creation-test-assistant-gate", { open: true });
    }
  }

  // Long sessions. 10 turns keep real durations. 50 and 100 turns create real turns through the API (their
  // real durations are all a few ms), then GET .../trace is rewritten so only durationMs varies by magnitude.
  const magnitudes = [120, 800, 2400, 12400, 65000, 400, 187000, 5200, 33000, 950];
  // Turn creation takes about a second per turn and project leases expire, so the three sessions are built in parallel.
  const built = await Promise.all([10, 50, 100].map(async (size) => {
    const projectId = await newProject(`Long ${size}`);
    await runTurn(projectId, "Turn 1", null, 1);
    const conversationId = await conversationOf(projectId);
    for (let index = 2; index <= size; index++) await runTurn(projectId, `Turn ${index}`, conversationId, index);
    return { size, projectId, conversationId };
  }));
  for (const { size, projectId, conversationId } of built) {
    const real = await persisted(projectId, conversationId);
    assert.equal(real.length, size);
    const durations = size === 10 ? real.map((turn) => turn.durationMs)
      : real.map((_, index) => magnitudes[(index * 7) % magnitudes.length] + index);
    const target = real[Math.floor(size / 2)].id;
    const page = await newPage(projectId, "en-US", { width: 1440, height: 800 });
    if (size !== 10) await rewrite(page, conversationId, (body) => body.turns.forEach((turn, index) => { turn.durationMs = durations[index]; }));
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    const started = Date.now();
    await page.goto(traceUrl(projectId, conversationId, real[0].id));
    await rows(page).nth(size - 1).waitFor();
    const overviewVisibleMs = Date.now() - started;
    assert.deepEqual(await values(page), durations.map((ms) => formatTurnDuration(ms)));
    await page.waitForLoadState("networkidle");
    const nodeCount = await page.evaluate(() => document.querySelectorAll(".cw-trace-overview *").length);
    const pageNodes = await page.evaluate(() => document.querySelectorAll("*").length);
    const loadRequests = () => requests.filter((url) => /\/traces\/|\/turns\/[^/]+\/jobs/.test(url));
    const idsOf = (urls) => new Set(urls.map((url) => url.match(/\/(?:traces|turns)\/([0-9a-f-]{36})/)?.[1]));
    const beforeClick = loadRequests().length;
    assert.deepEqual([...idsOf(loadRequests())], [real[0].id], "Only the deep-linked turn loaded");
    await page.evaluate((id) => {
      const marks = window.__marks = { click: 0, open: 0, records: 0 };
      const overview = document.querySelector(".cw-trace-overview");
      document.addEventListener("click", () => { marks.click = performance.now(); }, { capture: true, once: true });
      const details = document.getElementById(`turn-${id}`);
      new MutationObserver((_, observer) => { if (details.open) { marks.open = performance.now(); observer.disconnect(); } })
        .observe(details, { attributes: true, attributeFilter: ["open"] });
      const observer = window.__overviewObserver = new MutationObserver((records) => { marks.records += records.length; });
      observer.observe(overview, { subtree: true, childList: true, attributes: true, characterData: true });
    }, target);
    await rows(page).nth(Math.floor(size / 2)).click();
    await until(() => isOpen(page, target), Boolean, "Clicked turn opens");
    await until(() => selectedNumbers(page), (value) => value[0] === Math.floor(size / 2) + 1 && value.length === 1, "Selection moves");
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const marks = await page.evaluate(() => {
      const marks = window.__marks;
      marks.records += window.__overviewObserver.takeRecords().length;
      window.__overviewObserver.disconnect();
      return marks;
    });
    await page.waitForLoadState("networkidle");
    const opened = new Set([real[0].id, target]);
    assert.deepEqual([...idsOf(loadRequests())].sort(), [...opened].sort(), "Only opened turns load traces and jobs");
    const atEnd = await placed(page, target, "Details scroll to the top of the viewport", size === 10);
    assert.ok(marks.records <= 12, `Overview mutations must not scale with turns: ${marks.records}`);
    const afterClick = loadRequests().length, distinctAfterClick = idsOf(loadRequests()).size;
    // Opening a closed turn through its own summary selects it in the overview (no overview click involved).
    const viaSummary = 2;
    const summaryId = real[viaSummary].id;
    assert.equal(await isOpen(page, summaryId), false);
    await page.evaluate(() => scrollTo(0, 0));
    await page.locator(`#turn-${summaryId} > summary`).click();
    await until(() => isOpen(page, summaryId), Boolean, "Summary click opens the turn");
    await until(() => selectedNumbers(page), (value) => value.length === 1 && value[0] === viaSummary + 1, "Summary open selects the row");
    // Closing keeps the selection on that turn (it stays the last turn worked on; open state is shown by the turn nav).
    await page.locator(`#turn-${summaryId} > summary`).click();
    await until(() => isOpen(page, summaryId), (value) => value === false, "Summary click closes the turn");
    assert.deepEqual(await selectedNumbers(page), [viaSummary + 1]);

    // Far turn nav clicks: the matching overview row is visible inside the list (rows are found by turn id), the
    // list itself scrolled, and reveal() still puts the details at the page top. The last turn sits at the page end,
    // so the page cannot scroll its details to the top; a turn 20 from the end has enough page below it.
    const rowInList = (id) => page.evaluate((turnId) => {
      const list = document.querySelector(".cw-trace-overview-list");
      const box = list.getBoundingClientRect();
      const row = document.querySelector(`.cw-trace-overview-row[data-turn-id="${turnId}"]`).getBoundingClientRect();
      return { fits: row.top >= box.top - 1 && row.bottom <= box.bottom + 1, scrollTop: list.scrollTop };
    }, id);
    const far = [real[size - 1].id, ...(size > 10 ? [real[size - 20].id] : [])];
    for (const id of far) {
      const number = real.findIndex((turn) => turn.id === id) + 1;
      await page.evaluate(() => scrollTo(0, 0));
      await page.locator(".cw-trace-overview-list").evaluate((node) => { node.scrollTop = 0; });
      await page.locator("nav.cw-trace-turnnav").getByRole("button", { name: String(number), exact: true }).click();
      await until(() => isOpen(page, id), Boolean, `Turn ${number} opens`);
      await until(() => selectedNumbers(page), (value) => value.length === 1 && value[0] === number, `Row ${number} selected`);
      const inList = await until(() => rowInList(id), (state) => state.fits, `Row ${number} is visible in the overview list`);
      if (size > 10) assert.ok(inList.scrollTop > 0, `The list itself scrolled for row ${number}`);
      if (id !== real[size - 1].id) await placed(page, id, `Turn ${number} details end near the page top`, false);
      else await until(() => topOf(page, id), (top) => top >= -2 && top < 800 - 40, `Turn ${number} details are in view`);
    }

    perf.push({
      turns: size, overviewVisibleMs, clickToDetailsOpenMs: Number((marks.open - marks.click).toFixed(1)),
      scrollLimitedByPageEnd: atEnd, overviewNodes: nodeCount, pageNodes, overviewMutationsOnSelect: marks.records,
      requestsBeforeClick: beforeClick, requestsAfterClick: afterClick,
      distinctTurnsRequested: distinctAfterClick, durations: size === 10 ? "real" : "rewritten",
    });
    if (size === 50) {
      await page.evaluate(() => scrollTo(0, 0));
      await shot(page, "overview-50-turns");
    }
    await page.close();
  }
  console.log(JSON.stringify({ perf, notes }, null, 2));
  console.log("trace timing overview browser check passed");
} finally {
  await api("/creation-test-assistant-gate", { open: true }).catch(() => {});
  await browser.close();
}

function luminanceIsDark(css) {
  const [r, g, b] = css.match(/[\d.]+/g).map(Number);
  return (r + g + b) / 3 < 100;
}
