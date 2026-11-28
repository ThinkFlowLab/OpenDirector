/** Turn timing (#468): Chat and Trace show the same recorded duration, legacy turns show none.
 * Real UI and API with the local assistant fixture; only model replies are fixtures.
 * Start creation_server.py with --assistant-fixture before running this check.
 */
import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const headers = {
  "X-OpenDirector-Request": "1",
  "X-OpenDirector-Session": crypto.randomUUID(),
};
async function api(path, value) {
  const response = await fetch(base + "/api" + path, {
    headers: { ...headers, "Content-Type": "application/json" },
    ...(value ? { method: "POST", body: JSON.stringify(value) } : {}),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function until(read, matches, label) {
  const deadline = Date.now() + 15000;
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
    saved: "Saved on this device", panel: "AI chat", toolbar: "Chat with AI",
    editor: "Message content", send: "Send message", done: "Completed",
    unavailable: "Unavailable", turns: "Turns", stopped: "Reply stopped", interrupted: "Reply interrupted", reply: "已收到创作要求。这是隔离测试回复。",
    messages: ["Beach film", "Forest film"],
  },
  "zh-CN": {
    saved: "已保存到本机", panel: "AI 对话", toolbar: "与 AI 对话",
    editor: "消息内容", send: "发送消息", done: "已完成",
    unavailable: "不可用", turns: "轮次", stopped: "已停止回复", interrupted: "回复已中断", reply: "已收到创作要求。这是隔离测试回复。",
    messages: ["海边短片", "森林短片"],
  },
};
const duration = String.raw`(?:\d+ ms|\d+\.\d s|\d+m \d+s|\d+h \d+m)`;
const runtimes = [{
  id: "default", label: "Default", group: "default", modelSource: "settings",
  available: true, status: "ready", modelOverride: false, supportsSkills: true,
}];
const stripTiming = (value) => {
  for (const item of value.messages ?? value.turns ?? [])
    for (const key of ["startedAt", "finishedAt", "durationMs"]) delete item[key];
  return value;
};

// An aborted fetch (React effect cleanup, page close) disposes the response mid-read.
async function respondWithoutTiming(route) {
  if (route.request().method() !== "GET") return route.continue().catch(() => {});
  try {
    const response = await route.fetch();
    const body = stripTiming(await response.json());
    await route.fulfill({ status: response.status(), json: body });
  } catch (error) {
    if (process.env.DEBUG_TIMING) console.error(error.message);
    await route.continue().catch(() => {});
  }
}

const browser = await launchBrowser();
try {
  for (const locale of ["en-US", "zh-CN"]) {
    const words = copy[locale];
    const newPage = async (projectId) => {
      const page = await browser.newPage({ locale, viewport: { width: 1440, height: 1000 } });
      page.setDefaultTimeout(15000);
      page.on("pageerror", (error) => assert.fail(error.message));
      await page.route(/\/assistant\/runtimes(?:\?.*)?$/, (route) => route.fulfill({ json: runtimes }));
      await page.addInitScript(([id, current]) => {
        localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
        localStorage.setItem("opendirector.locale.v1", current);
        localStorage.setItem("opendirector.lastUnifiedFilesystemProject", id);
      }, [projectId, locale]);
      return page;
    };
    const projectId = crypto.randomUUID();
    await api(`/creation/projects/${projectId}/commands`, {
      type: "project.create", projectId, commandId: crypto.randomUUID(),
      payload: { name: "Timing " + projectId.slice(0, 8) },
    });
    const path = `/creation/projects/${projectId}/assistant`;
    const openChat = async (page) => {
      await page.goto(base);
      return openPanel(page);
    };
    const openPanel = async (page) => {
      await page.getByText(words.saved, { exact: true }).waitFor({ state: "attached" }).catch(async (error) => {
        console.error(await page.locator("body").innerText());
        throw error;
      });
      const panel = page.getByRole("complementary", { name: words.panel, exact: true });
      if (!(await panel.isVisible()))
        await page.getByRole("button", { name: words.toolbar, exact: true }).click();
      await panel.getByRole("textbox", { name: words.editor, exact: true }).waitFor();
      return panel;
    };

    const page = await newPage(projectId);
    const panel = await openChat(page);
    const editor = panel.getByRole("textbox", { name: words.editor, exact: true });
    for (const [index, text] of words.messages.entries()) {
      await editor.fill(text);
      await panel.getByRole("button", { name: words.send, exact: true }).click();
      await until(
        () => api(path),
        (value) => value.messages.length === (index + 1) * 2 && value.messages.at(-1)?.status === "complete",
        "Reply must be persisted",
      );
    }
    const stored = await api(path);
    const replies = stored.messages.filter((message) => message.role === "assistant");
    for (const reply of replies) {
      assert.ok(Number.isInteger(reply.durationMs) && reply.durationMs >= 0, JSON.stringify(reply));
      assert.ok(reply.startedAt && reply.finishedAt);
    }
    // Chat: both the earlier reply and the latest reply carry a status and duration.
    const timings = panel.locator(".cw-assistant-turn-timing");
    await until(() => timings.count(), (count) => count === 2, "Both replies show timing");
    const chat = await timings.allTextContents();
    for (const text of chat) assert.match(text, new RegExp(`^${words.done} · ${duration}$`));

    // Trace: same durations, old behaviours intact.
    const conversationId = stored.conversationId;
    const first = stored.messages[0].id;
    const second = stored.messages[2].id;
    const traceUrl = `${base}/?${new URLSearchParams({
      traceProject: projectId, conversation: conversationId, turn: first, runtime: "opencode",
    })}`;
    const traceRequests = [];
    const tracePage = await newPage(projectId);
    tracePage.on("request", (request) => traceRequests.push(request.url()));
    await tracePage.goto(traceUrl);
    const rows = tracePage.locator(".cw-trace-turn");
    await until(() => rows.count(), (count) => count === 2, "Both turns listed");
    const traced = async () => tracePage.locator(".cw-trace-turn-duration").allTextContents();
    await until(traced, (value) => value.length === 2, "Both turns show a duration");
    const strip = (text) => text.split(" · ")[1];
    assert.deepEqual(await traced(), chat.map(strip));
    await tracePage.locator(".cw-trace-turn-meta").first().getByText(words.done, { exact: true }).waitFor();
    assert.equal(await rows.nth(0).evaluate((node) => node.open), true, "Deep link opens its turn");
    assert.equal(await rows.nth(1).evaluate((node) => node.open), false);
    assert.ok(!traceRequests.some((url) => url.includes(`/traces/${second}`)), "Collapsed turn must not load");
    await rows.nth(0).locator(":scope > summary").click();
    assert.equal(await rows.nth(0).evaluate((node) => node.open), false, "Turn collapses");
    await tracePage.getByRole("navigation", { name: words.turns, exact: true })
      .getByRole("button", { name: "2", exact: true }).click();
    assert.equal(await rows.nth(1).evaluate((node) => node.open), true, "Turn nav opens turn 2");
    await until(
      async () => traceRequests.some((url) => url.includes(`/traces/${second}`)),
      Boolean, "Opening a turn loads it",
    );
    await tracePage.reload();
    await until(traced, (value) => value.length === 2, "Durations survive reload");
    assert.deepEqual(await traced(), chat.map(strip));
    await tracePage.close();

    // Legacy turns recorded before timing: nothing invented in Chat, "Unavailable" in Trace.
    const legacyTrace = await newPage(projectId);
    await legacyTrace.route(/\/assistant\/conversations\/[^/]+\/trace$/, async (route) => {
      await respondWithoutTiming(route);
    });
    await legacyTrace.goto(traceUrl);
    await until(() => legacyTrace.locator(".cw-trace-turn-duration").allTextContents(),
      (value) => value.length === 2 && value.every((text) => text === words.unavailable),
      "Legacy turns show Unavailable");
    await legacyTrace.close();
    // Same tab (one editor tab per project): reload with the stored turns stripped of timing.
    await page.route(new RegExp(`/projects/${projectId}/assistant$`), respondWithoutTiming);
    await page.reload();
    const legacyPanel = await openPanel(page);
    await legacyPanel.getByText(words.reply, { exact: true }).first().waitFor();
    assert.equal(await legacyPanel.locator(".cw-assistant-turn-timing").count(), 0);
    // Stopped and interrupted replies: Chat shows the bare duration beside the panel's own status line.
    await page.unroute(new RegExp(`/projects/${projectId}/assistant$`), respondWithoutTiming);
    const ended = [["interrupted", 820], ["stopped", 3100]];
    await page.route(new RegExp(`/projects/${projectId}/assistant$`), async (route) => {
      if (route.request().method() !== "GET") return route.continue().catch(() => {});
      try {
        const response = await route.fetch();
        const body = await response.json();
        const assistant = body.messages.filter((message) => message.role === "assistant");
        for (const [index, [status, durationMs]] of ended.entries())
          Object.assign(assistant[index], { status, durationMs });
        await route.fulfill({ status: response.status(), json: body });
      } catch {
        await route.continue().catch(() => {});
      }
    });
    await page.reload();
    const endedPanel = await openPanel(page);
    const endedTimings = endedPanel.locator(".cw-assistant-turn-timing");
    await until(() => endedTimings.allTextContents(), (value) => value.length === 2, "Ended replies show timing");
    assert.deepEqual(await endedTimings.allTextContents(), ["820 ms", "3.1 s"]);
    assert.equal(await endedPanel.getByText(words.interrupted, { exact: true }).count(), 1);
    assert.equal(await endedPanel.getByText(words.stopped, { exact: true }).count(), 1);
    assert.equal(await endedPanel.getByText(words.done, { exact: false }).count(), 0, "Ended replies are not labelled Completed");
    await page.close();
  }
  console.log("assistant turn timing browser check passed");
} finally {
  await browser.close();
}
