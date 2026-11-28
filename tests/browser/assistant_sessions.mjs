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
    (value) =>
      value.messages.at(-1)?.status === "complete" &&
      value.activeTurnId === undefined,
    "First reply must be persisted and release the active turn",
  );
  await panel
    .getByText("已收到创作要求。这是隔离测试回复。", { exact: true })
    .waitFor();
  await panel.getByRole("button", { name: "停止回复", exact: true }).waitFor({ state: "hidden" });

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

  // Release the turn only after the full list has arrived in the stream.
  const suggestions = panel.getByRole("group", { name: "建议回复", exact: true });
  const send = panel.getByRole("button", { name: "发送消息", exact: true });
  const choice = "展开海边重逢的完整分镜";
  const listItems = panel.locator(".cw-chat-markdown ul").filter({ hasText: choice }).getByRole("listitem");
  await api("/creation-test-assistant-gate", { open: false });
  await editor.fill("建议回复验收");
  await send.click();
  await listItems.nth(3).waitFor();
  assert.equal(await suggestions.count(), 0);
  await api("/creation-test-assistant-gate", { open: true });
  const options = suggestions.getByRole("button");
  await options.last().waitFor();
  assert.equal(await options.count(), 3);

  const resize = panel.getByRole("separator", { name: "调整 AI 对话宽度" });
  const bounds = await resize.boundingBox();
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  const rows = () => options.evaluateAll((buttons) =>
    new Set(buttons.map((button) => button.getBoundingClientRect().top)).size,
  );
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 240, y, { steps: 5 });
  await page.mouse.up();
  const wideRows = await rows();
  const wideBounds = await resize.boundingBox();
  await page.mouse.move(wideBounds.x + wideBounds.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(x + 170, y, { steps: 5 });
  await page.mouse.up();
  assert.ok(await rows() > wideRows, "Suggested reply buttons should wrap as the panel narrows");
  await resize.press("End");

  const choiceButton = suggestions.getByRole("button", { name: choice, exact: true });
  let turnRequests = 0;
  page.on("request", (item) => {
    if (item.method() === "POST" && item.url().endsWith("/assistant/turns")) turnRequests++;
  });
  await editor.fill("我想自己回复");
  const typedDraft = await until(() => api(path), (value) => value.draft === "我想自己回复", "Save typed draft");
  assert.ok(await choiceButton.isVisible(), "Suggestions should remain visible while drafting");
  assert.equal(await choiceButton.getAttribute("title"), "用这条建议填写草稿");
  await choiceButton.click();
  const replacement = await until(() => api(path), (value) => value.draft === choice, "Save suggested text as a draft");
  assert.deepEqual(replacement.messages, typedDraft.messages);
  assert.equal(await editorText(), choice);
  assert.ok(await editor.evaluate((element) => element === document.activeElement));
  await editor.press("ControlOrMeta+z");
  assert.equal(await editorText(), "我想自己回复");
  await editor.fill("");
  const beforeChoice = await until(() => api(path), (value) => value.draft === "", "Clear previous draft");
  await choiceButton.click();
  assert.equal(await editorText(), choice, "Selecting a suggestion should fill the empty composer");
  const revised = choice + "！";
  await page.keyboard.insertText("！");
  const filled = await until(() => api(path), (value) => value.draft === revised, "Save the user's edit before sending");
  assert.deepEqual(filled.messages, beforeChoice.messages);
  assert.equal(turnRequests, 0);
  const request = page.waitForRequest((item) =>
    item.method() === "POST" && item.url().endsWith("/assistant/turns"),
  );
  await send.click();
  const submitted = (await request).postDataJSON();
  assert.equal(submitted.text, revised);
  assert.deepEqual(submitted.content, filled.draftContent);
  assert.deepEqual(submitted.assets, []);
  const afterChoice = await until(
    () => api(path),
    (value) => value.messages.length === beforeChoice.messages.length + 2 &&
      value.messages.at(-1)?.status === "complete",
    "Manually sending a suggested reply must persist one ordinary user turn",
  );
  assert.equal(afterChoice.messages.at(-2).role, "user");
  assert.equal(afterChoice.messages.at(-2).text, revised);
  assert.equal(turnRequests, 1);
  await suggestions.waitFor({ state: "detached" });
  await listItems.nth(3).waitFor();

  // A reference-only draft is editable too. Keep the attachment through replacement, reload and Send.
  await editor.fill("建议回复验收");
  await send.click();
  await choiceButton.waitFor();
  await panel.getByLabel("选择对话参考文件", { exact: true }).setInputFiles({
    name: "shot-notes.txt", mimeType: "text/plain", buffer: Buffer.from("Storyboard notes"),
  });
  const attached = await until(() => api(path), (value) => value.assets.length === 1, "Save attachment");
  await choiceButton.click();
  await until(() => api(path), (value) => value.draft.includes(choice), "Save choice with attachment");
  await panel.getByRole("button", { name: "使用技能", exact: true }).click();
  await panel.getByRole("option", { name: /character-replacement/ }).click();
  const alternate = "换一个安静克制的结尾";
  await suggestions.getByRole("button", { name: alternate, exact: true }).click();
  const edited = await until(() => api(path), (value) => value.draft.includes(alternate), "Replace the draft again");
  assert.deepEqual(edited.messages, attached.messages);
  assert.deepEqual(edited.assets, attached.assets);
  assert.deepEqual(edited.draftContent.filter((part) => part.type === "reference"),
    attached.draftContent.filter((part) => part.type === "reference"));
  assert.deepEqual(edited.skills, ["character-replacement"]);
  assert.deepEqual(edited.draftContent.filter((part) => part.type === "text").map((part) => part.text.trim()), [alternate]);
  await page.reload();
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  await show();
  await until(editorText, (text) => text.includes(alternate) && text.includes("shot-notes.txt") &&
    text.includes("/character-replacement"), "Restore edited draft");
  const manualRequest = page.waitForRequest((item) => item.method() === "POST" && item.url().endsWith("/assistant/turns"));
  await send.click();
  const manual = (await manualRequest).postDataJSON();
  assert.equal(manual.text, edited.draft);
  assert.deepEqual(manual.content, edited.draftContent);
  assert.deepEqual(manual.skills, edited.skills);
  assert.deepEqual(manual.assets, edited.assets.map((asset) => asset.id));
  await until(() => api(path), (value) => value.messages.length === edited.messages.length + 2 &&
    value.messages.at(-1)?.status === "complete", "Complete the manually submitted turn");

  const waitForConversation = (matches, label) => until(() => api(path), matches, label);
  const savedDraft = (text) => waitForConversation((state) => state.draft === text, `Persist draft "${text}"`);
  const expectComposer = (text) => until(editorText, (value) => value === text, `Restore composer "${text}"`);
  const mode = panel.locator("[data-assistant-mode-toggle]");
  await mode.click();
  await panel.locator('[data-assistant-mode-option="ask"]').click();
  await editor.fill("请先询问时长，再规划验收短片");
  await send.click();
  const deciding = await waitForConversation((value) =>
    value.decisions?.some((decision) => decision.status === "waiting_input") && !value.activeTurnId,
    "Wait for the first session to release its turn");
  const question = deciding.decisions.find((decision) => decision.status === "waiting_input");
  const decidingTitle = (await api(path + "/conversations")).items.find(
    (item) => item.id === deciding.conversationId,
  ).title;
  const answeringSession = picker.getByTitle(decidingTitle, { exact: true });
  const switchLanguage = async (label, locale) => {
    await page.locator(".cw-language-toggle").getByRole("button", { name: label, exact: true }).click();
    await page.locator(`html[lang="${locale}"]`).waitFor({ state: "attached" });
  };
  const card = panel.locator(`[data-question-summary-card="${question.requestId}"]`);
  const answerPanel = page.locator(`#canvas-assistant [data-question-answer-panel="${question.requestId}"]`);
  await answerPanel.getByText("8 秒（推荐）", { exact: true }).waitFor();
  await switchLanguage("EN", "en-US");
  await answerPanel.getByText("8 秒 (Recommended)", { exact: true }).waitFor();
  await switchLanguage("中文", "zh-CN");
  await answerPanel.locator('[data-question-option="8"]').press("ArrowDown");
  assert.equal(await answerPanel.locator(":focus").getAttribute("data-question-option"), "15");
  const defer = answerPanel.locator("[data-question-defer-button]");
  await defer.click();
  const normalDraft = "留给下一轮的普通聊天草稿";
  await editor.fill(normalDraft);
  await savedDraft(normalDraft);
  await card.click();
  await answerPanel.waitFor();
  assert.equal(await editorText(), "");
  assert.equal(await send.isEnabled(), false);
  const customAnswer = "12 秒，自定义结尾";
  await editor.fill(customAnswer);
  await defer.click();
  assert.equal(await editorText(), normalDraft);
  await card.click();
  await expectComposer(customAnswer);
  const answersPattern = /\/assistant\/decisions\/[^/]+\/answers$/;
  // Fetch the real receipt, then hold it until the browser has switched conversations.
  const intercepted = Promise.withResolvers();
  await page.route(answersPattern, (route) => intercepted.resolve(route), { times: 1 });
  await send.click();
  const answerRoute = await intercepted.promise;
  const response = await answerRoute.fetch();
  const answerReceipt = await response.json();
  assert.equal(answerReceipt.status, "answer_saved");
  assert.equal(answerReceipt.task.conversationId, deciding.conversationId);
  assert.equal(answerReceipt.decision.answers[0].customText, customAnswer);
  assert.equal((await api(path)).draft, normalDraft);
  await create.click();
  const other = await waitForConversation((value) =>
    value.conversationId !== deciding.conversationId, "Switch away from the answering session");
  await editor.fill("另一会话的草稿");
  await savedDraft("另一会话的草稿");
  const unexpectedStarts = [];
  const observe = (request) => {
    if (request.url().includes("/assistant/continuations/")) unexpectedStarts.push(request.url());
  };
  page.on("request", observe);
  const answerDelivered = page.waitForResponse((response) => answersPattern.test(response.url()));
  await answerRoute.fulfill({ response });
  await (await answerDelivered).finished();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.locator("[data-question-answer-panel]").waitFor({ state: "detached" });
  const stable = await api(path);
  assert.equal(stable.conversationId, other.conversationId);
  assert.deepEqual(stable.messages, []);
  assert.equal(await editorText(), "另一会话的草稿");
  assert.equal(await card.count(), 0);
  assert.deepEqual(unexpectedStarts, []);
  page.off("request", observe);
  await history.click();
  await answeringSession.click();
  await expectComposer(normalDraft);
  await card.locator(".cw-question-continue-button").click();
  const confirmPlan = panel.locator("[data-confirm-plan-button]");
  await confirmPlan.waitFor();
  await page.reload();
  await show();
  await confirmPlan.waitFor();
  assert.equal(await mode.getAttribute("data-mode"), "ask");

  await create.click();
  await waitForConversation((value) => value.conversationId !== deciding.conversationId,
    "Open a conversation without an Ask task");
  assert.equal(await mode.getAttribute("data-mode"), "auto");
  await history.click();
  await answeringSession.click();
  await confirmPlan.waitFor();
  assert.equal(await mode.getAttribute("data-mode"), "ask");
  await panel.locator(".cw-plan-confirmation-steps").getByText("工程变更", { exact: true }).waitFor();
  await switchLanguage("EN", "en-US");
  await page.locator("#canvas-assistant").getByRole("button", { name: "Confirm and execute", exact: true }).waitFor();
  await page.locator("#canvas-assistant .cw-plan-confirmation-steps")
    .getByText("Project change", { exact: true }).waitFor();
  await switchLanguage("中文", "zh-CN");
  assert.equal(await mode.getAttribute("data-mode"), "ask");

  const taskState = (state) => state.tasks?.find((task) => task.taskId === question.taskId);
  await confirmPlan.click();
  const failed = await waitForConversation((state) =>
    !state.activeTurnId && taskState(state)?.stage === "execution_failed", "Finish a rejected execution");
  assert.equal(await mode.getAttribute("data-mode"), "auto");
  await panel.locator("[data-adjust-plan-button]").click();
  await confirmPlan.waitFor({ state: "visible" });
  await expectComposer(normalDraft);
  assert.equal(await mode.getAttribute("data-mode"), "ask");

  const refinement = page.waitForRequest((request) =>
    request.method() === "POST" && request.url().endsWith("/assistant/turns"));
  await editor.fill("请改版计划");
  await send.click();
  assert.equal((await refinement).postDataJSON().mode, "ask");
  const refinedPlan = await waitForConversation((state) =>
    !state.activeTurnId && taskState(state)?.plan?.summary === "已保留自定义结尾并改版计划。", "Save the next plan in the original task");
  assert.equal(taskState(refinedPlan).planRevision, taskState(failed).planRevision + 2);

  await api("/creation-test-assistant-gate", { open: false });
  await panel.locator(`[data-plan-revision="${taskState(refinedPlan).planRevision}"] [data-confirm-plan-button]`).click();
  const executing = await waitForConversation((state) =>
    state.activeTurnId && taskState(state)?.stage === "executing",
    "Execution must have a service-assigned turn ID");
  await panel.locator('[data-assistant-mode-toggle][data-mode="auto"]').waitFor();
  const stopped = page.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/stop"));
  await panel.getByRole("button", { name: "停止回复", exact: true }).click();
  assert.ok((await stopped).url().endsWith(`/${executing.activeTurnId}/stop`));
  await waitForConversation((value) =>
    !value.activeTurnId && value.messages.at(-1)?.status === "stopped", "Stop the confirmed execution");

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
