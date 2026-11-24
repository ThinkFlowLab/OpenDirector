/** Run with creation_server.py on 8019 and its Vite proxy on 5179.
 * Override the URLs with CREATION_API_URL and CREATION_WEB_URL.
 */
import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";
import { startZhipuCatalog, zhipuBaseURL, zhipuFixtureKey, zhipuModelsPath } from "./zhipu_catalog_fixture.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const headers = { "X-OpenDirector-Request": "1", "Content-Type": "application/json" };
const modelId = `glm-discovery-fixture-${crypto.randomUUID()}`;
const projectId = crypto.randomUUID();
const projectURL = `${base}/ai-tool/ai-canvas/${projectId}?creation=unified`;

async function call(path, { method = "GET", body } = {}) {
  const response = await fetch(api + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `Fixture API ${method} ${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}

const health = await call("/api/creation-test-health");
assert.equal(health.isolated, true, "Run only against creation_server.py");
assert.equal(health.provider, "fixture");
const webHealth = await fetch(`${base}/api/creation-test-health`, { headers });
assert.ok(webHealth.ok);
assert.equal((await webHealth.json()).root, health.root, "Web proxy must use the same isolated API");
await call(`/api/creation/projects/${projectId}/commands`, {
  method: "POST",
  body: { commandId: crypto.randomUUID(), projectId, type: "project.create",
    payload: { name: `New model discovery ${projectId.slice(0, 8)}` } },
});

const browser = await launchBrowser();
let catalog;
try {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1500, height: 1000 } });
  page.setDefaultTimeout(15000);
  await page.addInitScript(() => {
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    localStorage.setItem("opendirector.locale.v1", "en-US");
  });
  catalog = await startZhipuCatalog(page, () => ({ status: 200, ids: [modelId] }));
  // Runtime availability is fixed for the test. Model choices come from saved settings.
  await page.route(/\/assistant\/runtimes$/, route => route.fulfill({
    json: [{
      id: "default", label: "Default", group: "default", modelSource: "settings",
      available: true, status: "ready", modelOverride: false,
    }],
  }));

  const button = name => page.getByRole("button", { name, exact: true });
  const picker = page.locator(".cw-model-picker");
  const discovered = picker.getByRole("checkbox", { name: modelId, exact: true });
  async function openTextModels() {
    await page.locator('.cw-workspace[aria-busy="false"]').waitFor();
    await button("Settings").click();
    await button("Model connections").click();
    await page.locator(".cw-model-setup-row")
      .filter({ has: page.getByText("Text model", { exact: true }) })
      .getByRole("button").click();
  }

  await page.goto(projectURL);
  await openTextModels();
  await button("Add service").click();
  await page.getByRole("combobox", { name: "Provider", exact: true }).click();
  await page.getByRole("option", { name: "Zhipu BigModel", exact: true }).click();
  assert.equal(await discovered.count(), 0, "The new model must be absent before discovery");
  assert.deepEqual(catalog.requests, [], "Selecting a preset must not query the provider");
  await page.getByLabel("API Key", { exact: true }).fill(zhipuFixtureKey);
  for (const option of await picker.locator(".cw-model-option > label > input[type=checkbox]").all()) {
    await option.uncheck();
  }

  await button("Fetch models").click();
  await discovered.waitFor();
  assert.deepEqual(catalog.requests, [{ method: "GET", path: zhipuModelsPath, authorized: true }]);
  assert.equal(await discovered.isChecked(), false, "The discovered model needs an explicit selection");
  await discovered.check();
  await button("Save service").click();
  await button("Add service").waitFor();

  const configs = await call("/api/model-configs");
  const saved = configs.find(config => config.modelId === modelId);
  assert.ok(saved?.providerId, "Save must persist the selected model in a model service");
  assert.equal(saved.kind, "agent");
  assert.equal(saved.url, zhipuBaseURL);
  assert.deepEqual(configs.filter(config => config.providerId === saved.providerId).map(config => config.modelId), [modelId]);

  await page.reload();
  await openTextModels();
  await page.locator(".cw-model-service").filter({ hasText: modelId })
    .getByRole("button", { name: "Manage", exact: true }).click();
  assert.equal(await discovered.isChecked(), true, "The saved model stays selected after reload");
  await button("Cancel").click();
  await button("Close settings").click();

  const chat = button("Chat with AI");
  if (await chat.getAttribute("aria-expanded") !== "true") await chat.click();
  const agent = page.getByRole("button", { name: /^Agent:/ });
  const assistantModel = page.getByRole("menuitemradio", { name: modelId, exact: true });
  await agent.click();
  await assistantModel.click();
  await agent.click();
  assert.equal(await assistantModel.getAttribute("aria-checked"), "true", "The assistant uses the new saved model");
  console.log(JSON.stringify({ passed: true, modelId, checks: ["GET /models", "explicit selection", "saved model after reload", "assistant selection"] }));
} finally {
  await browser.close();
  catalog?.close();
  const configs = await call("/api/model-configs");
  const saved = configs.find(config => config.kind === "agent" && config.url === zhipuBaseURL && config.modelId === modelId);
  if (saved) await call(`/api/model-services/${saved.id}`, { method: "DELETE" });
}
