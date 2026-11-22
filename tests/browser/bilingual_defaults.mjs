import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5180";
const health = await fetch(base + "/api/creation-test-health", {
  headers: { "X-OpenDirector-Request": "1" },
});
assert.ok(health.ok);
const { isolated, assistantFixture } = await health.json();
assert.ok(isolated && assistantFixture, "Requires an isolated --assistant-fixture server");
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1440, height: 1000 } });
  const opening = page.waitForRequest(request => new URL(request.url()).pathname.endsWith("/open-canvas"));
  await page.goto(base + "/?setup=welcome");
  const request = await opening;
  const project = new URL(request.url()).pathname.replace(/\/open-canvas$/, "");
  const session = request.headers()["x-opendirector-session"];
  assert.ok(session, "The browser must acquire the editing session");
  const projectName = page.locator(".cw-project-name");
  const welcome = page.locator("#welcome-language");
  const setup = page.locator("dialog.cw-welcome");
  await page.route("**/assistant/runtimes/default/status", (route) => route.fulfill({ json: {
    id: "default", label: "Default Agent", group: "default", modelSource: "settings",
    modelOverride: false, available: true, status: "ready",
  } }));
  await projectName.filter({ hasText: /^未命名项目$/ }).waitFor();
  await page.getByRole("heading", { name: "欢迎使用 OpenDirector" }).waitFor();
  assert.ok(await page.getByRole("button", { name: "开始设置" }).isVisible());
  assert.ok(await setup.getByRole("radio", { name: "画布模式", exact: true }).isChecked());
  await setup.getByRole("radio", { name: "纯净模式", exact: true }).check();
  assert.ok(await setup.getByRole("button", { name: "进入工作区", exact: true }).isVisible());
  const chineseCanvas = page.getByRole("img", { name: "OpenDirector 画布截图：六个分镜和下方的剪辑时间线" });
  await chineseCanvas.evaluate((element) => element.decode());
  const chineseCanvasSrc = await chineseCanvas.getAttribute("src");
  await welcome.selectOption("en-US");
  await page.getByRole("heading", { name: "Welcome to OpenDirector" }).waitFor();
  assert.ok(await setup.getByRole("radio", { name: "Agent mode", exact: true }).isChecked());
  await setup.getByRole("radio", { name: "Canvas mode", exact: true }).check();
  const englishCanvas = page.getByRole("img", { name: "OpenDirector canvas screenshot with six storyboard shots and the editing timeline below" });
  await englishCanvas.evaluate((element) => element.decode());
  assert.notEqual(await englishCanvas.getAttribute("src"), chineseCanvasSrc);
  await page.getByRole("button", { name: "Get started" }).click();
  await welcome.selectOption("zh-CN");
  await setup.getByRole("heading", { name: "连接LLM", exact: true }).waitFor();
  await setup.getByText("OpenDirector需要配置语言模型来理解你的创作需求、规划步骤和调用工具。", { exact: true }).waitFor();
  await setup.getByRole("button", { name: "配置语言模型", exact: true }).waitFor();
  await setup.getByRole("button", { name: "使用已有Harness", exact: true }).waitFor();
  await welcome.selectOption("en-US");
  await setup.getByText("OpenDirector needs a configured language model to understand what you want to create, plan the work, and use tools.", { exact: true }).waitFor();
  await setup.getByRole("button", { name: "Set up a language model", exact: true }).click();
  await page.getByRole("button", { name: /^fixture-agent/ }).click();
  await page.getByRole("heading", { name: "What do you want to do first?" }).waitFor();
  await welcome.selectOption("zh-CN");
  const videoTask = setup.getByRole("checkbox", { name: "做一段视频" });
  await videoTask.check();
  await setup.getByRole("heading", { name: "配置视频模型", exact: true }).waitFor();
  await setup.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("checkbox", { name: "生成配音" }).check();
  assert.ok(await videoTask.isChecked());
  await setup.getByRole("heading", { name: "配置语音合成模型", exact: true }).waitFor();
  await welcome.selectOption("en-US");
  await setup.getByRole("heading", { name: "Set up a text-to-speech model", exact: true }).waitFor();
  const filePicker = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import media", exact: true }).click();
  const chooser = await filePicker;
  assert.ok(chooser.isMultiple());
  await chooser.setFiles({ name: "first-run.txt", mimeType: "text/plain", buffer: Buffer.from("A first draft") });
  await setup.waitFor({ state: "hidden" });
  assert.equal(page.url(), `${base}/`);
  await page.locator(".react-flow__node-text").waitFor();
  await projectName.filter({ hasText: /^Untitled project$/ }).waitFor();

  const switchLanguage = async (label, locale) => {
    await page.locator(".cw-language-toggle").getByRole("button", { name: label, exact: true }).click();
    await page.locator(`html[lang="${locale}"]`).waitFor({ state: "attached" });
  };
  const showChat = async () => {
    const toggle = page.locator(".cw-chat-button");
    if (await toggle.getAttribute("aria-expanded") === "true") await toggle.click();
    await toggle.click();
    await page.locator('#canvas-assistant [contenteditable="true"]:focus').waitFor();
  };
  const heading = page.locator(".cw-assistant-header h2");
  const checkHistoryTitle = async (title) => {
    await page.locator("[data-session-history]").click();
    await page.locator(".cw-assistant-session-row strong")
      .filter({ hasText: new RegExp(`^${title}$`) }).waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".cw-assistant-session-row").waitFor({ state: "detached" });
  };
  await showChat();
  await heading.filter({ hasText: /^New conversation$/ }).waitFor();
  await checkHistoryTitle("New conversation");
  await switchLanguage("中文", "zh-CN");
  await projectName.filter({ hasText: /^未命名项目$/ }).waitFor();
  await heading.filter({ hasText: /^新会话$/ }).waitFor();
  await checkHistoryTitle("新会话");
  await switchLanguage("EN", "en-US");
  await projectName.filter({ hasText: /^Untitled project$/ }).waitFor();
  await heading.filter({ hasText: /^New conversation$/ }).waitFor();
  await checkHistoryTitle("New conversation");

  // Rename to the literal Chinese default. The explicit rename must override the automatic name.
  await projectName.click();
  const nameInput = page.locator(".cw-project-name-editor input");
  await nameInput.fill("未命名项目");
  await nameInput.press("Enter");
  await projectName.filter({ hasText: /^未命名项目$/ }).waitFor();

  const api = project + "/assistant";
  const headers = { "X-OpenDirector-Request": "1", "X-OpenDirector-Session": session };
  const conversation = await page.request.get(base + api, { headers });
  assert.ok(conversation.ok(), await conversation.text());
  const { conversationId } = await conversation.json();
  for (const [title, runtimeModel] of [["新会话", null], ["Second prompt", "CLI 默认模型"]]) {
    const response = await page.request.post(base + api + "/turns", {
      headers,
      data: { id: crypto.randomUUID(), conversationId, text: title, runtime: "codex", runtimeModel },
    });
    assert.ok(response.ok(), await response.text());
    assert.match(await response.text(), /"type"\s*:\s*"end"/);
  }
  await page.goto(base);
  await projectName.filter({ hasText: /^未命名项目$/ }).waitFor();
  await showChat();
  const models = page.locator(".cw-assistant-message-heading small");
  const checkNamedConversation = async (defaultModel) => {
    await heading.filter({ hasText: /^新会话$/ }).waitFor();
    await checkHistoryTitle("新会话");
    await models.first().filter({ hasText: defaultModel }).waitFor();
    assert.deepEqual(await models.allTextContents(), [defaultModel, "CLI 默认模型"]);
    assert.equal(await projectName.textContent(), "未命名项目");
  };
  await checkNamedConversation("CLI default model");
  await switchLanguage("中文", "zh-CN");
  await checkNamedConversation("CLI 默认模型");
  await switchLanguage("EN", "en-US");
  await checkNamedConversation("CLI default model");
  console.log("Browser bilingual defaults and custom names passed");
} finally {
  await browser.close();
}
