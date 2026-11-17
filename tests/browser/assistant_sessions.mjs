/** Real UI, session APIs and disk persistence; only model replies are fixtures.
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
const browser = await launchBrowser();
try {
  const page = await browser.newPage({
    locale: "zh-CN",
    viewport: { width: 1440, height: 1000 },
  });
  // Skip the first-run model setup welcome; it covers the canvas.
  await page.addInitScript(() =>
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
  );
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/\/assistant\/runtimes(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: [
        {
          id: "default",
          label: "Default",
          group: "default",
          modelSource: "settings",
          available: true,
          status: "ready",
          modelOverride: false,
          supportsSkills: true,
        },
      ],
    }),
  );
  const projectId = crypto.randomUUID();
  await api(`/creation/projects/${projectId}/commands`, {
    type: "project.create",
    projectId,
    commandId: crypto.randomUUID(),
    payload: { name: "会话测试 " + projectId.slice(0, 8) },
  });
  await page.addInitScript(
    (id) =>
      localStorage.setItem("opendirector.lastUnifiedFilesystemProject", id),
    projectId,
  );
  await page.goto(base);
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  const panel = page.getByRole("complementary", {
    name: "AI 对话",
    exact: true,
  });
  const show = async () => {
    if (!(await panel.isVisible()))
      await page
        .getByRole("button", { name: "与 AI 对话", exact: true })
        .click();
    await panel
      .getByRole("textbox", { name: "消息内容", exact: true })
      .waitFor();
  };
  await show();
  const editor = panel.getByRole("textbox", { name: "消息内容", exact: true });
  const editorText = async () =>
    (await editor.textContent()).replaceAll("\u200b", "");
  const create = panel.getByRole("button", { name: "新建会话", exact: true });
  const history = panel.getByRole("button", { name: "历史会话", exact: true });
  const picker = panel.getByRole("dialog", { name: "历史会话", exact: true });
  const path = `/creation/projects/${projectId}/assistant`;
  const first = await until(
    () => api(path),
    (value) => !!value.modelSelections.agent,
    "Default model must be saved",
  );
  // #246: repeated New on an empty or whitespace-only composer must not
  // accumulate sessions. The current browser editor normalizes blank input
  // to an empty draft; also click New while the composer still shows spaces.
  const historyCount = async () => (await api(path + "/conversations")).items.length;
  await create.click();
  await create.click();
  assert.equal(await historyCount(), 1, "New on an empty session must be reused");
  assert.equal((await api(path)).conversationId, first.conversationId);
  await editor.fill("   \n  ");
  await create.click();
  assert.equal(await historyCount(), 1, "Whitespace-only input must not open a second session");
  assert.equal((await api(path)).conversationId, first.conversationId);
  await editor.fill("");
  await until(editorText, (value) => value === "", "Composer must be cleared before the first send");
  await editor.fill("海边短片");
  await panel.getByRole("button", { name: "发送消息", exact: true }).click();
  await until(
    () => api(path),
    (value) => value.messages.at(-1)?.status === "complete",
    "First reply must be persisted",
  );
  await panel
    .getByText("已收到创作要求。这是隔离测试回复。", { exact: true })
    .waitFor();

  await editor.fill("海边草稿");
  await panel.getByLabel("选择对话参考文件", { exact: true }).setInputFiles({
    name: "story-reference.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("A private reference for the first session"),
  });
  const draft = await until(
    () => api(path),
    (value) => value.draft.includes("海边草稿") && value.assets.length === 1,
    "Reference draft must persist",
  );
  await create.click();
  const second = await until(
    () => api(path),
    (value) => value.conversationId !== first.conversationId,
    "New session must activate",
  );
  await until(
    editorText,
    (value) => value === "",
    "New session composer must be empty",
  );
  assert.equal(second.messages.length, 0);
  assert.equal(second.assets.length, 0);
  assert.deepEqual(second.modelSelections, draft.modelSelections);
  await editor.press("ControlOrMeta+z");
  assert.equal(
    await editorText(),
    "",
    "Editor undo must not restore another session's input",
  );

  await api("/creation-test-assistant-gate", { open: false });
  await editor.fill("森林短片");
  await panel.getByRole("button", { name: "发送消息", exact: true }).click();
  await panel.getByText("已收到创作要求。", { exact: true }).waitFor();
  assert.equal(await create.getAttribute("aria-disabled"), "true");
  await history.click();
  await picker
    .getByText("请先停止或等待当前回复结束，再切换会话", { exact: true })
    .waitFor();
  await until(
    () => picker.locator(".cw-assistant-session-row").count(),
    (value) => value === 2,
    "Two stored sessions must be listed",
  );
  assert.equal(
    await picker.locator(".cw-assistant-session-row:enabled").count(),
    0,
  );
  await page.keyboard.press("Escape");
  assert.ok(await panel.isVisible());
  assert.equal(await picker.count(), 0);
  await panel.getByRole("button", { name: "停止回复", exact: true }).click();
  await panel.getByText("已停止回复", { exact: true }).waitFor();
  await api("/creation-test-assistant-gate", { open: true });
  await editor.fill("森林草稿");

  await history.click();
  await picker
    .getByRole("textbox", { name: "搜索会话", exact: true })
    .fill("海边");
  await until(
    () => picker.locator(".cw-assistant-session-row").count(),
    (value) => value === 1,
    "Search must filter history",
  );
  await picker.getByRole("button", { name: /海边短片/ }).click();
  const restored = await until(
    () => api(path),
    (value) => value.conversationId === first.conversationId,
    "Original session must restore",
  );
  assert.equal(restored.draft, draft.draft);
  assert.deepEqual(restored.assets, draft.assets);
  assert.deepEqual(restored.modelSelections, draft.modelSelections);
  await until(
    editorText,
    (value) => value.includes("海边草稿") && value.includes("story-reference"),
    "Draft and reference chip must restore",
  );
  assert.equal(await panel.getByText("森林短片", { exact: true }).count(), 0);
  assert.ok(await panel.getByText("海边短片", { exact: true }).count());

  await page.reload();
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  await show();
  await until(
    editorText,
    (value) => value.includes("海边草稿"),
    "Active session draft must survive reload",
  );
  assert.equal((await api(path)).conversationId, first.conversationId);

  // A listing failure is recoverable and must not disable the working conversation.
  await page.route(/\/assistant\/conversations$/, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 503, json: { detail: "测试历史列表暂不可用" } })
      : route.continue(),
  );
  await page.reload();
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  await show();
  await until(
    editorText,
    (value) => value.includes("海边草稿"),
    "A history-list failure must not block loading the active chat",
  );
  assert.equal(await create.getAttribute("aria-disabled"), "false");
  await history.click();
  await picker.getByRole("alert").waitFor();
  await page.unroute(/\/assistant\/conversations$/);
  await picker.getByRole("button", { name: "重试", exact: true }).click();
  await picker.getByRole("button", { name: /森林短片/ }).waitFor();
  await picker
    .getByRole("textbox", { name: "搜索会话", exact: true })
    .fill("不存在的标题");
  await picker.getByText("没有找到匹配的会话", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  assert.ok(
    await history.evaluate((element) => element === document.activeElement),
  );
  assert.ok(await panel.isVisible());

  // Saving the outgoing draft is a prerequisite; failure preserves it and avoids creating a thread.
  await page.route(/\/assistant\/draft$/, (route) =>
    route.fulfill({ status: 503, json: { detail: "测试草稿保存失败" } }),
  );
  await create.click();
  await panel
    .getByRole("alert")
    .filter({ hasText: "测试草稿保存失败" })
    .waitFor();
  assert.equal((await api(path)).conversationId, first.conversationId);
  assert.equal((await api(path + "/conversations")).items.length, 2);
  assert.ok((await editorText()).includes("海边草稿"));
  await page.unroute(/\/assistant\/draft$/);
  await history.click();
  await picker.getByRole("button", { name: /森林短片/ }).waitFor();
  await picker
    .getByRole("textbox", { name: "搜索会话", exact: true })
    .fill("森林");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await until(
    editorText,
    (value) => value === "森林草稿",
    "Second session draft must remain independent",
  );
  const contexts = (await api("/creation-test-health")).assistantContexts;
  assert.ok(contexts.length >= 2);
  assert.ok(
    !JSON.stringify(contexts.at(-1)).includes("海边短片"),
    "New session model context must not contain the old story",
  );

  // History stays inside a narrow assistant, closes outside, and all header controls fit.
  await panel.evaluate((element) =>
    element.style.setProperty("--assistant-width", "300px"),
  );
  await history.click();
  await picker.locator(".cw-assistant-session-row").first().waitFor();
  const panelBox = await panel.boundingBox();
  for (const control of await panel
    .locator(".cw-assistant-header button")
    .all()) {
    const box = await control.boundingBox();
    assert.ok(
      box.x >= panelBox.x && box.x + box.width <= panelBox.x + panelBox.width,
    );
  }
  await panel.screenshot({
    path:
      process.env.ASSISTANT_SCREENSHOT ??
      "/tmp/opendirector-assistant-sessions.png",
  });
  await editor.click();
  assert.equal(await picker.count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    "Assistant sessions: create, switch, drafts, attachments, model context, streaming guard, reload, retry, undo isolation and narrow layout passed.",
  );
} finally {
  await api("/creation-test-assistant-gate", { open: true });
  await browser.close();
}
