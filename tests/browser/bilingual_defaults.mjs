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
  await projectName.filter({ hasText: /^未命名项目$/ }).waitFor();
  await welcome.selectOption("en-US");
  await page.locator(".cw-welcome-secondary").click();
  await projectName.filter({ hasText: /^Untitled project$/ }).waitFor();

  const switchLanguage = async (label, locale) => {
    await page.locator(".cw-language-toggle").getByRole("button", { name: label, exact: true }).click();
    await page.locator(`html[lang="${locale}"]`).waitFor({ state: "attached" });
  };
  const showChat = () => page.locator(".cw-chat-button").click();
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
