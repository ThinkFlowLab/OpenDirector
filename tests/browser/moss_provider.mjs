/** Isolated provider UI proof. Saves a fixture key; never calls a model service.
 * Start creation_server.py on 8029 and Vite on 5189 with its API proxy on 8029.
 * CREATION_WEB_URL, CREATION_API_URL and MOSS_SCREENSHOT_DIR override defaults.
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5189";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8029";
const output = process.env.MOSS_SCREENSHOT_DIR ?? "/tmp/opendirector-moss-evidence";
const modelIds = ["moss-image-sft-1.0", "moss-image-base-1.0"];
const speechModelIds = ["moss-tts-1.5-flash", "moss-tts-1.0-pro",
  "moss-tts-1.5-flash-2026-06-26", "moss-tts-1.0-pro-2026-02-07"];
const canonicalURL = "https://api.mosi.cn/v1";
const fixtureKey = "moss-browser-fixture-only-no-real-service";
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
  if (config.url.replace(/\/+$/, "") === canonicalURL && [...modelIds, ...speechModelIds].includes(config.modelId) && !removedServices.has(serviceId)) {
    await call(`/api/model-services/${config.id}`, { method: "DELETE" });
    removedServices.add(serviceId);
  }
}
await mkdir(output, { recursive: true });
const projectId = crypto.randomUUID();
await call(`/api/creation/projects/${projectId}/commands`, {
  method: "POST",
  body: { commandId: crypto.randomUUID(), projectId, type: "project.create",
    payload: { name: `MOSS provider UI fixture ${projectId.slice(0, 8)}` } },
});

const copy = {
  "zh-CN": {
    settings: "设置", models: "模型接入", imageOverview: "图片模型", image: "图片", audio: "音频",
    add: "添加服务", provider: "提供商", moss: "MOSS 开放平台", url: "服务地址（Base URL）",
    reload: "载入支持的模型", save: "保存服务", cancel: "取消", manage: "管理", close: "关闭设置",
    general: "通用", language: "语言", defaultImage: "vLLM-Omni 图片接口", defaultAudio: "vLLM-Omni 语音合成接口",
    custom: "OpenAI 兼容", fetch: "获取模型", discoveryError: "服务返回 HTTP 401，请检查 API Key。",
  },
  "en-US": {
    settings: "Settings", models: "Model connections", imageOverview: "Image model", image: "Image", audio: "Audio",
    add: "Add service", provider: "Provider", moss: "MOSS Open Platform", url: "Service URL (Base URL)",
    reload: "Load supported models", save: "Save service", cancel: "Cancel", manage: "Manage", close: "Close settings",
    general: "General", language: "Language", defaultImage: "vLLM-Omni image API", defaultAudio: "vLLM-Omni speech synthesis API",
    custom: "OpenAI compatible", fetch: "Fetch models", discoveryError: "Service returned HTTP 401. Check the API Key.",
  },
};
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
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
async function officialLogo(image) {
  await image.waitFor();
  await image.evaluate(element => element.decode());
  assert.ok(await image.evaluate(element => element.naturalWidth > 0));
  assert.equal(await image.evaluate(element => element.classList.contains("cw-brand-mono")), false);
  assert.equal(await image.evaluate(element => getComputedStyle(element).filter), "none");
  const source = await image.getAttribute("src");
  assert.ok(source.startsWith("data:image/svg+xml") || new URL(source, base).origin === new URL(base).origin);
  assert.match(source, /moss\.svg|moss-[^/]+\.svg|data:image\/svg\+xml/);
}
async function openImageCategory(labels) {
  await page.locator(".cw-model-setup-row")
    .filter({ has: page.locator("strong", { hasText: new RegExp(`^${labels.imageOverview}$`) }) })
    .getByRole("button").click();
}
async function provePreset(labels, locale, kind = "image") {
  const expectedModels = kind === "image" ? modelIds : speechModelIds;
  await page.getByRole("button", { name: labels.add, exact: true }).click();
  assert.equal(await provider(labels).innerText(), kind === "image" ? labels.defaultImage : labels.defaultAudio, "Existing default provider is unchanged");
  const start = requests.length;
  await provider(labels).click();
  const option = page.getByRole("option", { name: labels.moss, exact: true });
  await officialLogo(option.locator("img.cw-model-logo"));
  await option.click();
  assert.equal(await provider(labels).innerText(), labels.moss);
  assert.equal(await page.getByLabel(labels.url, { exact: true }).inputValue(), canonicalURL);
  assert.equal(await page.locator(".cw-model-option").count(), expectedModels.length);
  await officialLogo(provider(labels).locator("img.cw-model-logo"));
  for (const modelId of expectedModels) {
    assert.equal(await page.getByRole("checkbox", { name: modelId, exact: true }).isChecked(), true);
    await officialLogo(page.locator(".cw-model-option").filter({ has: page.getByRole("checkbox", { name: modelId, exact: true }) }).locator("img.cw-model-logo"));
  }
  await page.getByLabel("API Key", { exact: true }).fill(fixtureKey);
  await page.getByRole("button", { name: labels.reload, exact: true }).click();
  for (const modelId of expectedModels)
    assert.equal(await page.getByRole("checkbox", { name: modelId, exact: true }).isChecked(), true);
  assert.ok(!requests.slice(start).some(url => url.includes("/model-configs/discover")), "Preset selection/reload must not discover remote models");
  await shot(`${locale}-mock-moss-${kind}-provider.png`);
}
async function proveReopen(labels, locale, kind = "image") {
  const service = page.locator(".cw-model-service").filter({ hasText: canonicalURL });
  assert.equal(await service.count(), 1);
  assert.ok((await service.innerText()).includes(labels.moss));
  for (const logo of await service.locator("img.cw-model-logo").all())
    await officialLogo(logo);
  await service.getByRole("button", { name: labels.manage, exact: true }).click();
  assert.equal(await provider(labels).innerText(), labels.moss);
  for (const modelId of kind === "image" ? modelIds : speechModelIds)
    assert.equal(await page.getByRole("checkbox", { name: modelId, exact: true }).isChecked(), true);
  assert.equal(await page.getByLabel("API Key", { exact: true }).inputValue(), "", "Saved key stays private");
  await officialLogo(provider(labels).locator("img.cw-model-logo"));
  await shot(`${locale}-mock-moss-${kind}-reopened.png`);
  await page.getByRole("button", { name: labels.cancel, exact: true }).click();
}
async function proveAudio(labels, locale, save = false) {
  await page.getByRole("button", { name: labels.audio, exact: true }).click();
  await provePreset(labels, locale, "audio");
  await page.getByRole("button", { name: save ? labels.save : labels.cancel, exact: true }).click();
  await page.getByRole("button", { name: labels.add, exact: true }).waitFor();
  const audio = (await call("/api/model-configs")).filter(config => config.url === canonicalURL && config.kind === "audio");
  assert.deepEqual(audio.map(config => config.modelId), speechModelIds);
  for (const model of audio) {
    assert.equal(model.inputRules.voiceRequired, true);
    assert.equal(model.inputRules.referencesAllowed, false);
    assert.equal(model.inputRules.voiceLibrary.provider, "moss");
    assert.equal(Object.hasOwn(model.inputRules, "maxPromptCharacters"), false);
  }
  assert.equal(new Set(audio.map(model => model.inputRules.voiceLibrary.connectionId)).size, 1);
  assert.ok(!JSON.stringify(audio).includes(fixtureKey));
  await proveReopen(labels, locale, "audio");
}
async function proveDiscoveryError(labels) {
  await page.getByRole("button", { name: labels.add, exact: true }).click();
  await provider(labels).click();
  await page.getByRole("option", { name: labels.custom, exact: true }).click();
  await page.getByLabel(labels.url, { exact: true }).fill("http://127.0.0.1:12345/v1");
  await page.getByLabel("API Key", { exact: true }).fill(fixtureKey);
  const endpoint = "**/api/model-configs/discover";
  await page.route(endpoint, route => route.fulfill({
    status: 401, contentType: "application/json",
    body: JSON.stringify({ detail: labels.discoveryError }),
  }));
  try {
    await page.getByRole("button", { name: labels.fetch, exact: true }).click();
    const alert = page.locator('.cw-model-picker [role="alert"]');
    await alert.waitFor();
    const text = await alert.innerText();
    assert.ok(text.includes(labels.discoveryError), `Actual discovery cause missing: ${text}`);
    assert.ok(!text.includes("{error}"));
  } finally {
    await page.unroute(endpoint);
    await page.getByRole("button", { name: labels.cancel, exact: true }).click();
  }
}

try {
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  const zh = copy["zh-CN"];
  await page.getByRole("button", { name: zh.settings, exact: true }).click();
  await page.getByRole("button", { name: zh.models, exact: true }).click();
  await openImageCategory(zh);
  await provePreset(zh, "zh-CN");
  await page.getByRole("button", { name: zh.save, exact: true }).click();
  await page.getByRole("button", { name: zh.add, exact: true }).waitFor();
  const saved = (await call("/api/model-configs")).filter(config => config.url === canonicalURL && modelIds.includes(config.modelId));
  assert.deepEqual(saved.map(config => config.modelId).sort(), [...modelIds].sort());
  assert.equal(new Set(saved.map(config => config.providerId)).size, 1);
  for (const model of saved) {
    assert.equal(model.kind, "image");
    assert.equal(model.inputRules.maxImages, 0);
    assert.equal(model.inputRules.maxPromptCharacters, 4000);
    assert.ok(!JSON.stringify(model).includes(fixtureKey));
    assert.equal(Object.hasOwn(model, "apiKey"), false);
  }
  await proveReopen(zh, "zh-CN");
  await proveAudio(zh, "zh-CN", true);
  await proveDiscoveryError(zh);

  await page.getByRole("button", { name: zh.general, exact: true }).click();
  await page.locator("#settings-language").selectOption("en-US");
  const en = copy["en-US"];
  await page.getByRole("button", { name: en.models, exact: true }).click();
  await openImageCategory(en);
  await provePreset(en, "en-US");
  await page.getByRole("button", { name: en.cancel, exact: true }).click();
  await proveReopen(en, "en-US");
  await proveAudio(en, "en-US");
  await proveDiscoveryError(en);
  assert.ok(!requests.some(url => new URL(url).hostname === "api.mosi.cn"), "Browser must not contact the model provider");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, fixture: true, generation: "not submitted", base, api,
    projectURL: `${base}/ai-tool/ai-canvas/${projectId}?creation=unified`, screenshotDirectory: output,
    modelConfigIds: saved.map(config => config.id), checks: ["Chinese and English", "official local SVG with original colors",
      "canonical URL", "SFT and Base preselected without discovery", "speech model only in audio", "save and reopen image and audio", "public models have no key", "discovery failure cause in both languages"] }));
} catch (error) {
  await shot("mock-moss-provider-failure.png").catch(() => {});
  throw error;
} finally {
  await browser.close();
}
