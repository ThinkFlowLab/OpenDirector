/** Isolated Zhipu BigModel provider UI proof. Saves a fixture key and never calls a model service.
 * Start creation_server.py on 8029 and Vite on 5189 with its API proxy on 8029.
 * CREATION_WEB_URL, CREATION_API_URL and ZHIPU_SCREENSHOT_DIR override defaults.
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5189";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8029";
const output = process.env.ZHIPU_SCREENSHOT_DIR ?? "/tmp/opendirector-zhipu-evidence";
const modelIds = ["glm-5.3", "glm-5.3-flash", "glm-5.2"];
const canonicalURL = "https://open.bigmodel.cn/api/paas/v4";
const fixtureKey = "zhipu-browser-fixture-only-no-real-service";
const headers = { "X-OpenDirector-Request": "1", "Content-Type": "application/json" };
async function call(path, { method = "GET", body } = {}) {
  const response = await fetch(api + path, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, `Fixture API ${method} ${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}
const health = await call("/api/creation-test-health");
assert.equal(health.isolated, true, "Run only against creation_server.py");
assert.equal(health.provider, "fixture");
const webHealth = await (await fetch(base + "/api/creation-test-health", { headers })).json();
assert.equal(webHealth.root, health.root, "Web proxy must use the same isolated API");
const removedServices = new Set();
for (const config of await call("/api/model-configs")) {
  const serviceId = config.providerId ?? config.id;
  if (config.url.replace(/\/+$/, "") === canonicalURL && modelIds.includes(config.modelId) && !removedServices.has(serviceId)) {
    await call(`/api/model-services/${config.id}`, { method: "DELETE" });
    removedServices.add(serviceId);
  }
}
await mkdir(output, { recursive: true });
const projectId = crypto.randomUUID();
async function createPickerProject(locale) {
  const id = crypto.randomUUID();
  await call("/api/creation/projects/" + id + "/commands", {
    method: "POST",
    body: { commandId: crypto.randomUUID(), projectId: id, type: "project.create",
      payload: { name: "Zhipu picker " + locale + " " + id.slice(0, 8) } },
  });
  return id;
}
await call(`/api/creation/projects/${projectId}/commands`, {
  method: "POST",
  body: { commandId: crypto.randomUUID(), projectId, type: "project.create",
    payload: { name: `Zhipu provider UI fixture ${projectId.slice(0, 8)}` } },
});

const copy = {
  "zh-CN": {
    settings: "设置", models: "模型接入", agentOverview: "文本模型", chat: "对话",
    add: "添加服务", provider: "提供商", zhipu: "智谱 BigModel", url: "服务地址（Base URL）",
    reload: "载入支持的模型", save: "保存服务", cancel: "取消", manage: "管理", close: "关闭设置",
    chatEntry: "与 AI 对话", manual: "手动添加", manualAdd: "添加", manualId: "Model ID（服务的 served-model-name）",
  },
  "en-US": {
    settings: "Settings", models: "Model connections", agentOverview: "Text model", chat: "Chat",
    add: "Add service", provider: "Provider", zhipu: "Zhipu BigModel", url: "Service URL (Base URL)",
    reload: "Load supported models", save: "Save service", cancel: "Cancel", manage: "Manage", close: "Close settings",
    chatEntry: "Chat with AI", manual: "Add manually", manualAdd: "Add", manualId: "Model ID (the service's served-model-name)",
  },
};
const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(15000);
await page.addInitScript(() => {
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
  localStorage.setItem("opendirector.locale.v1", "zh-CN");
});
const requests = [];
const errors = [];
page.on("request", request => requests.push(request.url()));
page.on("pageerror", error => errors.push(error.message));
const shot = name => page.screenshot({ path: join(output, name), fullPage: true });
const provider = labels => page.getByRole("combobox", { name: labels.provider, exact: true });
// Filter an option card by its checkbox so glm-5.3 does not substring-match glm-5.3-flash.
const optionRow = modelId =>
  page.locator(".cw-model-option").filter({ has: page.getByRole("checkbox", { name: modelId, exact: true }) });
async function brandLogo(image) {
  await image.waitFor();
  await image.evaluate(element => element.decode());
  assert.ok(await image.evaluate(element => element.naturalWidth > 0));
  const source = await image.getAttribute("src");
  assert.ok(source.startsWith("data:image/svg+xml") || new URL(source, base).origin === new URL(base).origin);
}
async function openAgentCategory(labels) {
  await page.locator(".cw-model-setup-row")
    .filter({ has: page.locator("strong", { hasText: new RegExp(`^${labels.agentOverview}$`) }) })
    .getByRole("button").click();
}
async function provePreset(labels, locale) {
  await page.getByRole("button", { name: labels.add, exact: true }).click();
  const start = requests.length;
  await provider(labels).click();
  const option = page.getByRole("option", { name: labels.zhipu, exact: true });
  await brandLogo(option.locator("img.cw-model-logo"));
  await option.click();
  assert.equal(await provider(labels).innerText(), labels.zhipu);
  assert.equal(await page.getByLabel(labels.url, { exact: true }).inputValue(), canonicalURL);
  assert.equal(await page.locator(".cw-model-option").count(), modelIds.length);
  await brandLogo(provider(labels).locator("img.cw-model-logo"));
  for (const modelId of modelIds) {
    assert.equal(await page.getByRole("checkbox", { name: modelId, exact: true }).isChecked(), true);
    await brandLogo(optionRow(modelId).locator("img.cw-model-logo"));
  }
  await page.getByLabel("API Key", { exact: true }).fill(fixtureKey);
  await page.getByRole("button", { name: labels.reload, exact: true }).click();
  for (const modelId of modelIds)
    assert.equal(await page.getByRole("checkbox", { name: modelId, exact: true }).isChecked(), true);
  assert.ok(!requests.slice(start).some(url => url.includes("/model-configs/discover")), "Preset selection or reload must not discover remote models");
  await shot(`${locale}-mock-zhipu-provider.png`);
}
async function proveReopen(labels, locale) {
  const service = page.locator(".cw-model-service").filter({ hasText: canonicalURL });
  assert.equal(await service.count(), 1);
  assert.ok((await service.innerText()).includes(labels.zhipu));
  for (const logo of await service.locator("img.cw-model-logo").all())
    await brandLogo(logo);
  await service.getByRole("button", { name: labels.manage, exact: true }).click();
  assert.equal(await provider(labels).innerText(), labels.zhipu);
  for (const modelId of modelIds)
    assert.equal(await page.getByRole("checkbox", { name: modelId, exact: true }).isChecked(), true);
  assert.equal(await page.getByLabel("API Key", { exact: true }).inputValue(), "", "Saved key stays private");
  await brandLogo(provider(labels).locator("img.cw-model-logo"));
  await shot(`${locale}-mock-zhipu-reopened.png`);
  await page.getByRole("button", { name: labels.cancel, exact: true }).click();
}
async function proveManualAdd(labels, locale) {
  // The preset ships a curated list, but manual model IDs stay available like DeepSeek.
  await page.getByRole("button", { name: labels.add, exact: true }).click();
  await provider(labels).click();
  await page.getByRole("option", { name: labels.zhipu, exact: true }).click();
  const start = requests.length;
  await page.getByRole("button", { name: labels.manual, exact: true }).click();
  await page.getByLabel(labels.manualId, { exact: true }).fill("glm-4.7");
  await page.locator(".cw-model-manual").getByRole("button", { name: labels.manualAdd, exact: true }).click();
  assert.equal(await page.locator(".cw-model-option").count(), modelIds.length + 1);
  assert.equal(await page.getByRole("checkbox", { name: "glm-4.7", exact: true }).isChecked(), true);
  assert.ok(!requests.slice(start).some(url => url.includes("/model-configs/discover")), "Manual add must not discover remote models");
  await shot(`${locale}-mock-zhipu-manual-add.png`);
  await page.getByRole("button", { name: labels.cancel, exact: true }).click();
  await page.getByRole("button", { name: labels.add, exact: true }).waitFor();
}
async function proveAgentPicker(labels, locale) {
  // Each locale gets a fresh page. The browser context still shares the saved
  // model configuration. A separate project avoids competing for the current
  // project's single editing lease.
  const pickerProjectId = await createPickerProject(locale);
  const pickerPage = await context.newPage();
  pickerPage.setDefaultTimeout(15000);
  pickerPage.on("request", request => requests.push(request.url()));
  pickerPage.on("pageerror", error => errors.push(error.message));
  await pickerPage.addInitScript(({ locale: pickerLocale }) => {
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    localStorage.setItem("opendirector.locale.v1", pickerLocale);
  }, { locale });

  try {
    // The picker runtime inventory is a response fixture. The Default group lists
    // the saved agent model configs from the real API, so no provider endpoint is contacted.
    await pickerPage.route(/\/assistant\/runtimes$/, route => route.fulfill({
      json: [{
        id: "default", label: "Default", group: "default", modelSource: "settings",
        available: true, status: "ready", modelOverride: false,
      }],
    }));
    await pickerPage.goto(base + "/ai-tool/ai-canvas/" + pickerProjectId + "?creation=unified");
    await pickerPage.locator('.cw-workspace[aria-busy="false"]').waitFor();
    const pickerRow = pickerPage.getByRole("menuitemradio", { name: "glm-5.3", exact: true });
    const chatButton = pickerPage.getByRole("button", { name: labels.chatEntry, exact: true });
    if (await chatButton.getAttribute("aria-expanded") !== "true")
      await chatButton.click();
    const agentButton = pickerPage.getByRole("button", { name: /^Agent[:：]/ });
    await agentButton.click();
    await brandLogo(pickerRow.locator("img.cw-model-logo"));
    await pickerRow.click();
    await agentButton.click();
    assert.equal(
      await pickerRow.getAttribute("aria-checked"),
      "true", "Saved Zhipu model stays selected in the assistant picker",
    );
    await pickerPage.screenshot({
      path: join(output, locale + "-mock-zhipu-agent-picker.png"),
      fullPage: true,
    });
    await pickerPage.keyboard.press("Escape");
    if (await chatButton.getAttribute("aria-expanded") === "true")
      await chatButton.click({ force: true });
  } finally {
    await pickerPage.close().catch(() => {});
  }
}

try {
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  const zh = copy["zh-CN"];
  await page.getByRole("button", { name: zh.settings, exact: true }).click();
  await page.getByRole("button", { name: zh.models, exact: true }).click();
  await openAgentCategory(zh);
  await provePreset(zh, "zh-CN");
  await page.getByRole("button", { name: zh.save, exact: true }).click();
  await page.getByRole("button", { name: zh.add, exact: true }).waitFor();
  const saved = (await call("/api/model-configs")).filter(config => config.url === canonicalURL);
  assert.deepEqual(saved.map(config => config.modelId).sort(), [...modelIds].sort());
  assert.equal(new Set(saved.map(config => config.providerId)).size, 1);
  for (const model of saved) {
    assert.equal(model.kind, "agent");
    assert.ok(!JSON.stringify(model).includes(fixtureKey));
    assert.equal(Object.hasOwn(model, "apiKey"), false);
  }
  await proveReopen(zh, "zh-CN");
  await proveManualAdd(zh, "zh-CN");
  await page.getByRole("button", { name: zh.close, exact: true }).click();
  await proveAgentPicker(zh, "zh-CN");

  await page.getByRole("button", { name: zh.settings, exact: true }).click();
  await page.getByRole("button", { name: zh.models, exact: true }).click();
  await page.getByRole("button", { name: "通用", exact: true }).click();
  await page.locator("#settings-language").selectOption("en-US");
  const en = copy["en-US"];
  await page.getByRole("button", { name: en.models, exact: true }).click();
  await openAgentCategory(en);
  await provePreset(en, "en-US");
  await page.getByRole("button", { name: en.cancel, exact: true }).click();
  await proveReopen(en, "en-US");
  await proveManualAdd(en, "en-US");
  await page.getByRole("button", { name: en.close, exact: true }).click();
  await proveAgentPicker(en, "en-US");
  assert.ok(!requests.some(url => new URL(url).hostname === "open.bigmodel.cn"), "Browser must not contact the model provider");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, fixture: true, generation: "not submitted", base, api,
    projectURL: `${base}/ai-tool/ai-canvas/${projectId}?creation=unified`, screenshotDirectory: output,
    modelConfigIds: saved.map(config => config.id), checks: ["Chinese and English", "Z.ai brand logo",
      "canonical URL", "GLM models preselected without discovery", "save and reopen", "public models have no key",
      "manual model IDs stay available", "assistant picker lists and keeps the Zhipu model", "no provider request from the browser"] }));
} catch (error) {
  await shot("mock-zhipu-provider-failure.png").catch(() => {});
  throw error;
} finally {
  await browser.close();
}
