/** Model selection in service configuration (issue #477).
 *
 * A user with one API key wants every model the service returns enabled. A new
 * service therefore starts with the discovered list selected, and each row is
 * its own checkbox: there is no search box and no bulk select-all row, because
 * fetching already answers "select everything", while a saved service keeps the
 * subset the user chose.
 *
 * Start creation_server.py on 8019 and its Vite proxy on 5179; override with
 * CREATION_WEB_URL and CREATION_API_URL. MODEL_SELECT_SCREENSHOT_DIR holds
 * screenshots.
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launchBrowser } from "./engine.mjs";
import {
  startZhipuCatalog,
  zhipuBaseURL as canonicalURL,
  zhipuFixtureKey as fixtureKey,
  zhipuModelsPath,
} from "./zhipu_catalog_fixture.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const output = process.env.MODEL_SELECT_SCREENSHOT_DIR ?? "/tmp/opendirector-model-select-evidence";
const bundled = ["glm-5.3", "glm-5.3-flash", "glm-5.2"];
// The service returns none of the bundled IDs, so a stale selection would be
// visible as extra rows the service no longer offers.
const modelIds = ["glm-4.5", "glm-4.5-air", "glm-4.6", "glm-4.6-flash", "glm-4.7", "glm-4.7-air"];
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

async function deleteService(configId) {
  // Deleting one member removes the service, so later members answer 404.
  const response = await fetch(`${api}/api/model-services/${configId}`, { method: "DELETE", headers });
  assert.ok(response.ok || response.status === 404, `Fixture API DELETE model service: ${response.status}`);
}

const health = await call("/api/creation-test-health");
assert.equal(health.isolated, true, "Run only against creation_server.py");
assert.equal(health.provider, "fixture");
const webHealth = await (await fetch(`${base}/api/creation-test-health`, { headers })).json();
assert.equal(webHealth.root, health.root, "Web proxy must use the same isolated API");

// A previous run on the same fixture server must not look like this run's save.
const removed = new Set();
for (const config of await call("/api/model-configs")) {
  const service = config.providerId ?? config.id;
  if (config.url.replace(/\/+$/, "") !== canonicalURL || removed.has(service)) continue;
  await deleteService(config.id);
  removed.add(service);
}

await mkdir(output, { recursive: true });
const copy = {
  "zh-CN": {
    settings: "设置", models: "模型接入", agentOverview: "文本模型", add: "添加服务",
    provider: "提供商", zhipu: "智谱 BigModel", fetch: "获取模型", fetched: "已获取 6 个模型",
    save: "保存服务", cancel: "取消", manage: "管理", refresh: "刷新列表",
    enabled: "将启用 6 个模型", none: "请选择至少一个模型",
    showDetails: id => `展开 ${id} 的服务能力`,
    hideDetails: id => `收起 ${id} 的服务能力`,
    capabilities: "服务能力", textInput: "文本", imageInput: "图片理解",
  },
  "en-US": {
    settings: "Settings", models: "Model connections", agentOverview: "Text model", add: "Add service",
    provider: "Provider", zhipu: "Zhipu BigModel", fetch: "Fetch models", fetched: "6 models fetched",
    save: "Save service", cancel: "Cancel", manage: "Manage", refresh: "Refresh list",
    enabled: "Will enable 6 models", none: "Select at least one model",
    showDetails: id => `Show service capabilities for ${id}`,
    hideDetails: id => `Hide service capabilities for ${id}`,
    capabilities: "Service capabilities", textInput: "Text", imageInput: "Image understanding",
  },
};

const browser = await launchBrowser();
let createdService = null;
let catalog = null;
try {
  const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1500, height: 1000 } });
  page.setDefaultTimeout(15000);
  await page.addInitScript(() => {
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    localStorage.setItem("opendirector.locale.v1", "zh-CN");
  });
  catalog = await startZhipuCatalog(page, () => ({ status: 200, ids: modelIds, ready: Promise.resolve() }));
  const button = (name, scope = page) => scope.getByRole("button", { name, exact: true });
  const picker = page.locator(".cw-model-picker");
  const footer = page.locator(".cw-model-save-status");
  const checked = () =>
    page.locator(".cw-model-option").evaluateAll(rows =>
      rows.filter(row => row.querySelector('input[type="checkbox"]').checked).length);
  const rowOf = (id, scope = page) => scope.locator(".cw-model-option")
    .filter({ has: scope.getByRole("checkbox", { name: id, exact: true }) });
  async function openAgentServices(labels, target = page) {
    await button(labels.settings, target).click();
    await button(labels.models, target).click();
    await target.locator(".cw-model-setup-row")
      .filter({ has: target.getByText(labels.agentOverview, { exact: true }) })
      .getByRole("button").click();
  }
  async function newProject(locale) {
    const id = crypto.randomUUID();
    await call(`/api/creation/projects/${id}/commands`, {
      method: "POST",
      body: { commandId: crypto.randomUUID(), projectId: id, type: "project.create",
        payload: { name: `Model select all ${locale} ${id.slice(0, 8)}` } },
    });
    return `${base}/ai-tool/ai-canvas/${id}?creation=unified`;
  }

  await page.goto(await newProject("zh-CN"));
  await openAgentServices(copy["zh-CN"]);
  await button(copy["zh-CN"].add).click();
  await page.getByRole("combobox", { name: copy["zh-CN"].provider, exact: true }).click();
  await page.getByRole("option", { name: copy["zh-CN"].zhipu, exact: true }).click();
  assert.equal(await page.locator(".cw-model-option").count(), bundled.length, "The preset starts with its bundled models");
  assert.equal(await checked(), bundled.length);
  await page.getByLabel("API Key", { exact: true }).fill(fixtureKey);

  // Discovery replaces the bundled list and selects everything it returned.
  await button(copy["zh-CN"].fetch).click();
  await picker.getByText(copy["zh-CN"].fetched, { exact: true }).waitFor();
  assert.deepEqual(catalog.requests, [{ method: "GET", path: zhipuModelsPath, authorized: true }]);
  assert.deepEqual(
    await page.locator(".cw-model-option").evaluateAll(rows => rows.map(row => row.querySelector("label").innerText.split("\n")[0].trim())),
    modelIds,
    "A stale bundled selection must not survive discovery",
  );
  assert.equal(await checked(), modelIds.length, "One API key selects every discovered model");
  await footer.getByText(copy["zh-CN"].enabled, { exact: true }).waitFor();

  // One count, one control per model: no search box and no bulk row.
  const toolbar = await picker.evaluate(element => ({
    heading: element.querySelector(".cw-model-picker-heading").innerText,
    extra: element.querySelectorAll(".cw-model-filterbar, .cw-model-search, .cw-model-bulk-action").length,
  }));
  assert.match(toolbar.heading, /已获取 6 个模型/, `fetch feedback stays in the heading: ${toolbar.heading}`);
  assert.doesNotMatch(toolbar.heading, /已选/, "the heading does not repeat the selection count");
  assert.equal(toolbar.extra, 0, "the picker offers neither search nor bulk selection");

  // A selected model keeps one compact line: capabilities and the availability
  // check live behind a per-row disclosure instead of expanding every row.
  const heights = await page.locator(".cw-model-option").evaluateAll(rows =>
    rows.map(row => Math.round(row.getBoundingClientRect().height)));
  assert.deepEqual(heights.map(height => height <= 48), modelIds.map(() => true),
    `selected rows keep one line: ${heights}`);
  assert.equal(await page.locator(".cw-model-option-details").count(), 0,
    "details start collapsed");
  const firstRow = rowOf(modelIds[0]);
  const detailsToggle = firstRow.getByRole("button", { name: copy["zh-CN"].showDetails(modelIds[0]), exact: true });
  assert.equal(await detailsToggle.getAttribute("aria-expanded"), "false");
  await detailsToggle.click();
  const details = page.locator(".cw-model-option-details");
  await details.getByText(copy["zh-CN"].capabilities, { exact: true }).waitFor();
  assert.equal(await details.getByText(copy["zh-CN"].textInput, { exact: true }).count(), 1);
  assert.equal(await details.getByText(copy["zh-CN"].imageInput, { exact: true }).count(), 1);
  assert.equal(await details.count(), 1, "expanding one model shows its details only");
  assert.ok(await firstRow.evaluate(row => row.getBoundingClientRect().height) > 48,
    "an expanded row grows past one line");
  assert.equal(await checked(), modelIds.length, "expanding details keeps the selection");
  await firstRow.getByRole("button", { name: copy["zh-CN"].hideDetails(modelIds[0]), exact: true }).click();
  assert.equal(await page.locator(".cw-model-option-details").count(), 0,
    "the row collapses again");
  await page.screenshot({ path: join(output, "zh-CN-selected.png"), fullPage: true });

  // A selection the user edited survives discovery, so refresh never re-enables
  // a model the user turned off.
  await page.getByRole("checkbox", { name: modelIds[0], exact: true }).uncheck();
  assert.equal(await checked(), modelIds.length - 1);
  await button(copy["zh-CN"].refresh).click();
  await picker.getByText(copy["zh-CN"].fetched, { exact: true }).waitFor();
  assert.equal(await page.getByRole("checkbox", { name: modelIds[0], exact: true }).isChecked(), false,
    "Discovery must not overwrite an edited selection");
  assert.equal(await checked(), modelIds.length - 1);

  // Clearing every checkbox asks for a selection instead of saving nothing.
  for (const id of modelIds)
    await page.getByRole("checkbox", { name: id, exact: true }).uncheck();
  assert.equal(await checked(), 0);
  await footer.getByText(copy["zh-CN"].none, { exact: true }).waitFor();
  await page.screenshot({ path: join(output, "zh-CN-none.png"), fullPage: true });
  for (const id of modelIds)
    await page.getByRole("checkbox", { name: id, exact: true }).check();
  assert.equal(await checked(), modelIds.length);

  // One save writes every enabled model.
  const beforeSave = (await call("/api/model-configs")).length;
  await button(copy["zh-CN"].save).click();
  await button(copy["zh-CN"].add).waitFor();
  const configs = await call("/api/model-configs");
  const services = new Set(configs.filter(config => config.url.replace(/\/+$/, "") === canonicalURL)
    .map(config => config.providerId ?? config.id));
  assert.equal(services.size, 1, "One save creates one model service");
  const [serviceId] = services;
  createdService = serviceId;
  const saved = configs.filter(config => config.providerId === serviceId);
  assert.deepEqual(saved.map(config => config.modelId).sort(), [...modelIds].sort());
  assert.equal(saved.every(config => config.kind === "agent" && config.url === canonicalURL), true);
  assert.equal(configs.length - beforeSave, modelIds.length, "One save writes a config per enabled model");

  // The same rows and labels are translated in English.
  const english = await browser.newPage({ locale: "en-US", viewport: { width: 1500, height: 1000 } });
  try {
    english.setDefaultTimeout(15000);
    await english.addInitScript(() => {
      localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
      localStorage.setItem("opendirector.locale.v1", "en-US");
    });
    await english.goto(await newProject("en-US"));
    await openAgentServices(copy["en-US"], english);
    await english.locator(".cw-model-service").filter({ hasText: canonicalURL }).first()
      .getByRole("button", { name: copy["en-US"].manage, exact: true }).click();
    const englishPicker = english.locator(".cw-model-picker");
    await englishPicker.locator(".cw-model-option").first().waitFor();
    assert.equal(await englishPicker.locator(".cw-model-filterbar, .cw-model-search, .cw-model-bulk-action").count(), 0,
      "the English picker offers neither search nor bulk selection");
    const englishFirst = english.locator(".cw-model-option").first();
    const englishToggle = englishFirst.getByRole("button", { name: copy["en-US"].showDetails(modelIds[0]), exact: true });
    assert.equal((await englishToggle.getAttribute("aria-label")), copy["en-US"].showDetails(modelIds[0]));
    await englishToggle.click();
    const englishDetails = english.locator(".cw-model-option-details");
    await englishDetails.getByText(copy["en-US"].capabilities, { exact: true }).waitFor();
    assert.equal(await englishDetails.getByText(copy["en-US"].imageInput, { exact: true }).count(), 1);
    assert.doesNotMatch(await englishDetails.innerText(), /[\u3400-\u9fff]/);
    await english.screenshot({ path: join(output, "en-US-selected.png"), fullPage: true });
    assert.equal(
      await english.locator(".cw-model-option").evaluateAll(rows =>
        rows.filter(row => row.querySelector('input[type="checkbox"]').checked).length),
      modelIds.length,
      "a saved service opens with its enabled models checked",
    );
    await english.getByRole("button", { name: copy["en-US"].cancel, exact: true }).click();
    await english.locator(".cw-model-service").filter({ hasText: canonicalURL }).first()
      .getByRole("button", { name: copy["en-US"].manage, exact: true }).waitFor();
  } finally {
    await english.close();
  }

  assert.equal(catalog.requests.length, 2, "Only the Chinese page discovers models");
  assert.ok(catalog.requests.every((request) =>
    request.method === "GET" && request.path === zhipuModelsPath && request.authorized));
  console.log(JSON.stringify({
    passed: true,
    checks: [
      "discovery selects every returned model for a new service",
      "a stale bundled selection does not survive discovery",
      "the picker has no search box and no bulk selection row",
      "the toolbar shows one count only",
      "selected models stay one line until their capability details are expanded",
      "an edited selection survives refresh",
      "clearing every checkbox asks for a selection",
      "one save writes one service with every enabled model",
      "both languages label the capability row",
    ],
  }));
} finally {
  // Leave the shared fixture server without the service this run created.
  if (createdService) {
    for (const config of await call("/api/model-configs")) {
      if (config.providerId === createdService || config.id === createdService)
        await deleteService(config.id);
    }
  }
  await browser.close();
  catalog?.close();
}
