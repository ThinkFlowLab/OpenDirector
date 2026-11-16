/** Real plugin storage, native Skill discovery and bilingual settings; no model calls. */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const headers = { "X-OpenDirector-Request": "1", "Content-Type": "application/json" };
async function api(path, method = "GET", body) {
  const response = await fetch(base + "/api" + path, {
    method, headers, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
const health = await api("/creation-test-health");
assert.equal(health.isolated, true);
assert.ok(!(await api("/plugins")).installed.some((item) => item.manifest.id === "studio-brief"));
const projectId = crypto.randomUUID();
await api(`/creation/projects/${projectId}/commands`, "POST", {
  type: "project.create", projectId, commandId: crypto.randomUUID(),
  payload: { name: `Plugin UI ${projectId.slice(0, 8)}` },
});
const skillPath = `/creation/projects/${projectId}/assistant/skills`;
const pluginSkills = async (runtime) => (await api(`${skillPath}?runtime=${runtime}`)).filter((row) => row.source === "plugin");
const browser = await launchBrowser();
const screenshots = await mkdtemp(join(tmpdir(), "opendirector-plugins-ui-"));
const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15000);
await page.addInitScript(() => {
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
  if (!localStorage.getItem("opendirector.locale.v1")) localStorage.setItem("opendirector.locale.v1", "en-US");
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const settings = page.locator("#settings-dialog");
const plugins = page.locator(".cw-plugin-settings");
const installed = plugins.locator("section").first();
async function saved() {
  await page.waitForFunction(() => document.querySelector(".cw-plugin-settings")?.getAttribute("aria-busy") === "false");
  assert.equal(await plugins.getByRole("alert").count(), 0);
}
try {
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settings.getByRole("button", { name: "Plugins", exact: true }).click();
  await plugins.getByRole("button", { name: "Install Creative brief", exact: true }).click();
  await installed.getByRole("heading", { name: "Creative brief", exact: true }).waitFor();
  await saved();
  assert.equal(await installed.locator('input:checked').count(), 0);
  assert.deepEqual(await pluginSkills("default"), []);
  await installed.getByRole("checkbox", { name: "DeepSeek Harness", exact: true }).click();
  await saved();
  assert.equal((await pluginSkills("deepseek"))[0].pluginId, "studio-brief");
  assert.deepEqual(await pluginSkills("default"), []);
  await installed.getByRole("checkbox", { name: "Default", exact: true }).click();
  await saved();
  assert.equal(/[\u3400-\u9fff]/.test(await plugins.innerText()), false);
  await page.screenshot({ path: join(screenshots, "plugins-en.png") });
  await page.keyboard.press("Escape");
  const trigger = page.getByRole("button", { name: "Use skills", exact: true });
  if (!(await trigger.isVisible())) await page.getByRole("button", { name: "Chat with AI", exact: true }).click();
  await page.getByRole("textbox", { name: "Message content", exact: true }).fill("Prepare a creative brief");
  await trigger.click();
  await page.getByRole("option", { name: /Creative brief/ }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settings.getByRole("button", { name: "Plugins", exact: true }).click();
  await installed.getByRole("checkbox", { name: "Default", exact: true }).click();
  await saved();
  await page.keyboard.press("Escape");
  await trigger.click();
  await page.waitForFunction(() => !document.querySelector('.cw-skill-popover [role="status"]'));
  assert.equal(await page.getByRole("option", { name: /Creative brief/ }).count(), 0);
  await page.keyboard.press("Escape");
  let [rejected] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/assistant/turns")),
    page.getByRole("button", { name: "Send message", exact: true }).click(),
  ]);
  assert.equal(rejected.status(), 409);
  await page.getByText("A selected skill is unavailable for this harness. Remove it from the message and select an available skill.", { exact: true }).waitFor();
  await page.screenshot({ path: join(screenshots, "skill-error-en.png") });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settings.getByRole("button", { name: "Plugins", exact: true }).click();
  await plugins.locator('input[type="file"]').setInputFiles({ name: "invalid.zip", mimeType: "application/zip", buffer: Buffer.from("invalid") });
  await plugins.getByRole("alert").filter({ hasText: "Invalid plugin package" }).waitFor();
  await settings.getByRole("button", { name: "General", exact: true }).click();
  await settings.locator("#settings-language").selectOption("zh-CN");
  await settings.getByRole("button", { name: "插件", exact: true }).click();
  await installed.getByRole("heading", { name: "创作简报", exact: true }).waitFor();
  assert.equal(await installed.getByRole("checkbox", { name: "DeepSeek Harness", exact: true }).isChecked(), true);
  await page.screenshot({ path: join(screenshots, "plugins-zh.png") });
  await plugins.locator('input[type="file"]').setInputFiles({ name: "invalid.zip", mimeType: "application/zip", buffer: Buffer.from("invalid") });
  await plugins.getByRole("alert").filter({ hasText: "插件包无效" }).waitFor();
  await plugins.locator('input[type="file"]').setInputFiles(fileURLToPath(new URL("../../plugins/examples/studio-brief.zip", import.meta.url)));
  await saved();
  assert.equal(await installed.getByRole("checkbox", { name: "DeepSeek Harness", exact: true }).isChecked(), true);
  await page.reload();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await settings.getByRole("button", { name: "插件", exact: true }).click();
  await installed.getByRole("heading", { name: "创作简报", exact: true }).waitFor();
  assert.equal(await installed.getByRole("checkbox", { name: "DeepSeek Harness", exact: true }).isChecked(), true);
  await page.keyboard.press("Escape");
  const send = page.getByRole("button", { name: "发送消息", exact: true });
  if (!(await send.isVisible())) await page.getByRole("button", { name: "与 AI 对话", exact: true }).click();
  [rejected] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/assistant/turns")),
    send.click(),
  ]);
  assert.equal(rejected.status(), 409);
  await page.getByText("所选技能对当前引擎已不可用，请从消息中移除并重新选择。", { exact: true }).waitFor();
  await page.screenshot({ path: join(screenshots, "skill-error-zh.png") });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await settings.getByRole("button", { name: "插件", exact: true }).click();
  await installed.getByRole("button", { name: "卸载 创作简报", exact: true }).click();
  await saved();
  assert.deepEqual(await pluginSkills("deepseek"), []);
  assert.equal((await api("/creation-test-health")).calls.length, health.calls.length);
  assert.deepEqual(errors, []);
  console.log(`Plugins: install, per-harness activation, native discovery, disable, ZIP replay, reload, bilingual errors and uninstall passed. Screenshots: ${screenshots}`);
} catch (error) {
  await page.screenshot({ path: join(screenshots, "failure.png") });
  console.error(`Failure screenshot: ${screenshots}`);
  throw error;
} finally {
  try {
    const plugin = (await api("/plugins")).installed.find((item) => item.manifest.id === "studio-brief");
    if (plugin) await api("/plugins/studio-brief", "DELETE", { digest: plugin.digest });
  } finally {
    await browser.close();
  }
}
