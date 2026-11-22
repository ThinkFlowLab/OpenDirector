/** Mode changes preserve the same workspace and running work (#386).
 * Requires creation_server.py --assistant-fixture; no real models are used.
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launchBrowser } from "./engine.mjs";
import { chooseGenerationModel } from "./model_picker.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5180";
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
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function until(read, matches, label) {
  const deadline = Date.now() + 20000;
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
const projectId = crypto.randomUUID();
const root = `/creation/projects/${projectId}`;
await api(root + "/commands", {
  projectId,
  commandId: crypto.randomUUID(),
  type: "project.create",
  payload: { name: `Workspace modes ${projectId.slice(0, 8)}` },
});
const state = () => api(root);
const conversation = () => api(root + "/assistant");
const browser = await launchBrowser();
let page;
try {
  page = await browser.newPage({
    locale: "zh-CN",
    viewport: { width: 1720, height: 1120 },
  });
  page.setDefaultTimeout(15000);
  const errors = [], commands = [], stops = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/\/assistant\/turns\/[^/]+\/stop$/.test(request.url()))
      stops.push(request.url());
    if (request.method() === "POST" && request.url().endsWith("/commands"))
      commands.push(request.postDataJSON());
  });
  await page.route(/\/assistant\/runtimes(?:\?.*)?$/, (route) =>
    route.fulfill({ json: [{
      id: "default", label: "Default", group: "default", modelSource: "settings",
      available: true, status: "ready", modelOverride: false, supportsSkills: true,
    }] }),
  );
  await page.addInitScript(() => {
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
  });
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}`);
  await page.locator('.cw-workspace[aria-busy="false"]').waitFor();
  const workspace = page.locator("[data-workspace-mode]");
  const canvas = page.getByTestId("canvas-region");
  const assistant = page.locator("#canvas-assistant");
  const editor = assistant.locator('[contenteditable="true"]').first();
  const mode = (value) => page.getByTestId(`workspace-mode-${value}`);
  const settleLayout = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const selectMode = async (value) => {
    await mode(value).click();
    await until(() => workspace.getAttribute("data-workspace-mode"), (current) => current === value, `mode ${value}`);
    await settleLayout();
  };
  const viewport = () => page.locator(".react-flow__viewport").evaluate((element) => {
    const value = new DOMMatrix(getComputedStyle(element).transform);
    return [value.a, value.d, value.e, value.f];
  });
  const selection = () => page.locator(".react-flow__node.selected").evaluateAll((nodes) => nodes.map((node) => node.dataset.id).sort());
  const editorText = () => editor.evaluate((element) => element.textContent.replaceAll("\u200b", ""));
  async function setLocale(locale) {
    const current = await page.locator("html").getAttribute("lang");
    await page.getByRole("button", { name: current === "zh-CN" ? "设置" : "Settings", exact: true }).click();
    await page.locator("#settings-language").selectOption(locale);
    await page.locator(".cw-settings-close").click();
    assert.equal(await page.locator("html").getAttribute("lang"), locale);
  }
  async function screenshot(name) {
    if (!process.env.CREATION_SCREENSHOTS) return;
    await mkdir(process.env.CREATION_SCREENSHOTS, { recursive: true });
    await page.screenshot({ path: join(process.env.CREATION_SCREENSHOTS, `workspace-${name}.png`) });
  }
  async function assertLayout(value) {
    const chat = await assistant.boundingBox();
    assert.ok(chat && await assistant.isVisible(), "chat remains visible");
    if (value === "canvas") {
      const area = await canvas.boundingBox();
      assert.ok(area && await canvas.isVisible());
      assert.ok(chat.x + chat.width <= area.x + 2, "chat is left of the canvas without overlapping it");
      assert.ok(Math.abs(area.width / chat.width - 2) < 0.15, "default canvas/chat widths are 2:1");
    } else {
      assert.equal(await canvas.isVisible(), false, "agent mode hides the canvas");
      assert.equal(await canvas.locator(".react-flow__node").evaluateAll((nodes) => nodes.some((node) => node.checkVisibility({ opacityProperty: true, visibilityProperty: true }))), false, "React Flow children must not paint through the hidden canvas");
      assert.ok(Math.abs(chat.x + chat.width / 2 - page.viewportSize().width / 2) < 20, "agent chat is centered");
      assert.ok(chat.width <= 860, "wide agent chat keeps a readable width");
    }
  }

  // A fresh browser starts in canvas mode with chat already expanded.
  assert.equal(await workspace.getAttribute("data-workspace-mode"), "canvas");
  await editor.waitFor();
  assert.equal(await page.locator(".cw-chat-button").getAttribute("aria-expanded"), "true");
  await assertLayout("canvas");
  await page.setViewportSize({ width: 2560, height: 1440 });
  await settleLayout();
  await assertLayout("canvas");
  await page.setViewportSize({ width: 1720, height: 1120 });
  await settleLayout();
  await until(conversation, (value) => !!value.modelSelections.agent, "default agent model must be ready");

  await page.getByRole("toolbar", { name: "画布创作工具" }).getByRole("button", { name: "添加图片", exact: true }).click();
  await chooseGenerationModel(page, { label: "fixture-image" });
  const prompt = "Keep the node composer prompt across modes";
  await page.getByRole("textbox", { name: "生成提示词", exact: true }).fill(prompt);
  const prepared = await until(state, (value) => value.generationSpecs.some((spec) => spec.prompt === prompt && spec.modelConfigId), "image configuration must persist");
  const specId = prepared.generationSpecs.find((spec) => spec.prompt === prompt).id;
  const selected = await selection();
  assert.equal(selected.length, 1);

  // Change zoom through the real canvas gesture, then wait for its view save.
  const beforeZoom = await viewport();
  const viewSaved = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().includes(`${root}/views/`) && response.ok());
  const canvasBox = await canvas.boundingBox();
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.8, canvasBox.y + canvasBox.height * 0.7);
  await page.keyboard.down("Control");
  try { await page.mouse.wheel(0, -180); } finally { await page.keyboard.up("Control"); }
  await until(viewport, (value) => value[0] !== beforeZoom[0], "canvas zoom must change");
  await viewSaved;
  const savedViewport = await viewport();

  const draft = "Keep this draft / 保留这份草稿";
  await editor.fill(draft);
  await assistant.locator('input[type="file"]').setInputFiles({
    name: "mode-reference.txt", mimeType: "text/plain", buffer: Buffer.from("Mode switch reference"),
  });
  const savedChat = await until(conversation, (value) => value.draft.includes(draft) && value.assets.length === 1, "draft and reference must persist");
  const draftText = await editorText();
  await editor.evaluate((element) => { window.__workspaceModeEditor = element; });
  const snapshotBeforeSwitch = await state();
  const commandCount = commands.length;

  for (const locale of ["zh-CN", "en-US"]) {
    await setLocale(locale);
    const switcher = page.getByRole("group", { name: locale === "zh-CN" ? "创作方式" : "Creation mode", exact: true });
    for (const label of locale === "zh-CN" ? ["对话", "画布"] : ["Chat", "Canvas"]) {
      assert.equal(await switcher.getByRole("button", { name: label, exact: true }).innerText(), label);
    }
    for (const value of ["agent", "canvas", "agent", "canvas"]) {
      await selectMode(value);
      await assertLayout(value);
      assert.equal(await editor.evaluate((element) => element === window.__workspaceModeEditor), true, "mode and language changes keep the input DOM instance");
      assert.equal(await editorText(), draftText);
      const current = await conversation();
      assert.equal(current.conversationId, savedChat.conversationId);
      assert.deepEqual(current.assets, savedChat.assets);
      if (value === "canvas") {
        assert.deepEqual(await selection(), selected);
        assert.deepEqual(await viewport(), savedViewport);
        assert.equal(await page.getByRole("textbox", { name: locale === "zh-CN" ? "生成提示词" : "Prompt", exact: true }).evaluate((element) => element.isContentEditable ? element.textContent.replaceAll("\u200b", "") : element.value), prompt);
      }
    }
    await screenshot(`${locale}-canvas`);
    await selectMode("agent");
    await screenshot(`${locale}-agent`);
    // Hidden canvas handlers must not act on its retained selection.
    await mode("agent").focus();
    await page.keyboard.press("Delete");
    await assistant.hover();
    await page.keyboard.down("Control");
    try { await page.mouse.wheel(0, -120); } finally { await page.keyboard.up("Control"); }
    assert.deepEqual(await viewport(), savedViewport, "wheel over agent chat must not zoom the hidden canvas");
    await page.keyboard.press("Shift");
    await page.keyboard.press("Shift");
    await until(() => editor.evaluate((element) => element === document.activeElement || element.contains(document.activeElement)), Boolean, "double Shift focuses the agent composer");
    assert.equal(await assistant.isVisible(), true);
    await selectMode("canvas");
    assert.deepEqual(await selection(), selected, "Delete in agent mode leaves canvas selection intact");
  }
  assert.deepEqual(await state(), snapshotBeforeSwitch, "layout changes preserve project objects, versions and history cursor");
  assert.equal(commands.length, commandCount, "mode changes do not submit project commands");

  // The language control remains usable in agent mode through Settings.
  await selectMode("agent");
  await setLocale("zh-CN");
  assert.equal(await page.locator(".cw-language-toggle").isVisible(), false);
  assert.equal(await page.evaluate(() => localStorage.getItem("opendirector.workspaceMode.v1")), "agent");
  await page.reload();
  await page.locator('.cw-workspace[aria-busy="false"]').waitFor();
  await editor.waitFor();
  assert.equal(await workspace.getAttribute("data-workspace-mode"), "agent");
  assert.equal((await conversation()).conversationId, savedChat.conversationId);
  await until(editorText, (value) => value === draftText, "reload restores the same draft");
  assert.deepEqual((await conversation()).assets, savedChat.assets);
  await selectMode("canvas");

  // Narrow layouts still expose both mode controls and the same input instance.
  await editor.evaluate((element) => { window.__workspaceModeEditor = element; });
  for (const width of [600, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await selectMode("agent");
    for (const locale of ["zh-CN", "en-US"]) {
      await setLocale(locale);
      for (const value of ["agent", "canvas"]) {
        await mode(value).click({ trial: true });
        const button = await mode(value).boundingBox();
        assert.ok(button.x >= 0 && button.x + button.width <= width, "mode buttons stay inside the narrow window");
      }
      assert.equal(await editor.evaluate((element) => element === window.__workspaceModeEditor && element.isContentEditable), true);
      await editor.click({ trial: true });
      assert.equal(await editorText(), draftText);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "narrow page must not overflow horizontally");
      await screenshot(`${locale}-${width}-agent`);
      await selectMode("canvas");
      await page.locator(".cw-narrow-region-toggle").click();
      assert.equal(await canvas.isVisible(), true);
      assert.equal(await assistant.isVisible(), false);
      assert.equal(await page.locator(".cw-narrow-region-toggle").isVisible(), false, "narrow canvas has only the existing chat toggle");
      await page.locator(".cw-chat-button").click();
      assert.equal(await assistant.isVisible(), true);
      assert.equal(await editorText(), draftText);
      await selectMode("agent");
    }
  }
  await page.setViewportSize({ width: 1720, height: 1120 });
  await setLocale("zh-CN");
  await selectMode("canvas");

  // The earlier narrow-window checks deliberately preserve the zoom/pan.
  // Start this separate execution scenario by explicitly fitting the canvas.
  await workspace.focus();
  await page.keyboard.press("Shift+1");
  const node = page.locator(`.react-flow__node[data-id="${selected[0]}"]`);
  const nodeSurface = node.locator(".cw-placeholder-symbol");
  await nodeSurface.click();
  await page.getByRole("button", { name: "提交生成", exact: true }).waitFor();
  const beforeDrag = (await state()).canvasItems.find((item) => item.id === selected[0]).position;
  const dragZoom = (await viewport())[0];
  const handle = await nodeSurface.boundingBox();
  const origin = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + 80, origin.y + 40, { steps: 12 });
  await page.mouse.up();
  const moved = await until(state, (value) => {
    const position = value.canvasItems.find((item) => item.id === selected[0]).position;
    return position.x !== beforeDrag.x || position.y !== beforeDrag.y;
  }, "drag in the right canvas must persist its new position");
  const afterDrag = moved.canvasItems.find((item) => item.id === selected[0]).position;
  assert.ok(Math.abs((afterDrag.x - beforeDrag.x) * dragZoom - 80) < 16);
  assert.ok(Math.abs((afterDrag.y - beforeDrag.y) * dragZoom - 40) < 16);

  // Context menus use screen coordinates even inside the offset canvas region.
  const surface = await nodeSurface.boundingBox();
  const point = { x: surface.x + surface.width / 2, y: surface.y + surface.height / 2 };
  await page.mouse.click(point.x, point.y, { button: "right" });
  const menu = page.locator(".cw-context-menu").first();
  await menu.waitFor();
  const menuBox = await menu.boundingBox();
  assert.ok(Math.abs(menuBox.x - Math.max(8, Math.min(point.x, 1720 - menuBox.width - 8))) < 3, "node context menu uses the click's screen x");
  assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= 1720);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  const area = await canvas.boundingBox();
  const blank = { x: area.x + area.width * 0.6, y: area.y + 170 };
  await page.mouse.click(blank.x, blank.y, { button: "right" });
  await menu.waitFor();
  const blankMenu = await menu.boundingBox();
  assert.ok(Math.abs(blankMenu.x - blank.x) < 20 && Math.abs(blankMenu.y - blank.y) < 20, "blank canvas menu opens beside the actual pointer");
  assert.ok(blankMenu.x + blankMenu.width <= 1720 && blankMenu.y + blankMenu.height <= 1120);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });

  // Hold an actual stored Job and Agent turn while changing modes.
  await api("/creation-test-gate", { open: false });
  await api("/creation-test-assistant-gate", { open: false });
  const callsBefore = await api("/creation-test-health");
  await nodeSurface.click();
  await page.getByRole("button", { name: "提交生成", exact: true }).click();
  const running = await until(state, (value) => value.jobs.some((job) => job.status === "running" && job.inputSnapshot.spec.id === specId), "image job must be running");
  const jobId = running.jobs.find((job) => job.inputSnapshot.spec.id === specId).id;
  await editor.fill("Keep this Agent turn running across workspace modes");
  await assistant.getByRole("button", { name: "发送消息", exact: true }).click();
  const turn = await until(conversation, (value) => !!value.activeTurnId && value.messages.at(-1)?.status === "streaming", "assistant turn must be running");
  await editor.fill(draft);
  const runningCommandCount = commands.length;
  for (const value of ["agent", "canvas", "agent", "canvas"]) {
    await selectMode(value);
    assert.equal(await editor.evaluate((element) => element === window.__workspaceModeEditor), true);
    assert.equal((await conversation()).activeTurnId, turn.activeTurnId);
    assert.equal((await state()).jobs.find((job) => job.id === jobId).status, "running");
  }
  assert.equal(commands.length, runningCommandCount);
  assert.deepEqual(stops, []);
  assert.equal(commands.filter((command) => command.type === "job.cancel").length, 0);
  await api("/creation-test-assistant-gate", { open: true });
  await api("/creation-test-gate", { open: true });
  const complete = await until(conversation, (value) => value.messages.at(-1)?.status === "complete", "original assistant turn must complete");
  assert.equal(complete.messages.length, turn.messages.length);
  const finished = await until(state, (value) => value.jobs.find((job) => job.id === jobId)?.status === "succeeded", "original image job must complete");
  assert.equal(finished.jobs.length, running.jobs.length);
  const callsAfter = await api("/creation-test-health");
  assert.equal(callsAfter.calls.length, callsBefore.calls.length + 1);
  assert.equal(callsAfter.assistantContexts.length, callsBefore.assistantContexts.length + 1);
  assert.ok((await editorText()).includes(draft));
  if (process.env.CREATION_SCREENSHOTS) {
    for (const locale of ["zh-CN", "en-US"]) {
      await setLocale(locale);
      await selectMode("canvas");
      await workspace.focus();
      await page.keyboard.press("Shift+1");
      let previous, stable = 0;
      await until(viewport, (value) => {
        stable = JSON.stringify(value) === JSON.stringify(previous) ? stable + 1 : 0;
        previous = value;
        return stable >= 3;
      }, "fit viewport must settle before the review screenshot");
      const dismissNotification = page.locator(".cw-toast:not(.cw-toast-exiting) .cw-toast-close");
      while (await dismissNotification.count()) {
        await dismissNotification.first().click();
      }
      await page.waitForFunction(() => !document.querySelector(".cw-toast"));
      await screenshot(`${locale}-canvas-final`);
      await selectMode("agent");
      await screenshot(`${locale}-agent-final`);
    }
  }
  assert.deepEqual(errors, []);
  console.log("PASS workspace modes: bilingual layout, persistent preference, same input/draft/reference/session, viewport/selection and uninterrupted tasks");
} catch (error) {
  console.error(error);
  if (page) console.error({ page: (await page.locator("body").innerText()).slice(-6000) });
  throw error;
} finally {
  try {
    await api("/creation-test-assistant-gate", { open: true });
    await api("/creation-test-gate", { open: true });
  } finally {
    await browser.close();
  }
}
