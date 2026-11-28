import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";

// One address and credential must configure several modalities in one pass:
// per-kind discovery, per-kind save, one providerId, and a failing modality
// that is reported without discarding the ones that saved.
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const headers = { "X-OpenDirector-Request": "1", "Content-Type": "application/json" };
const health = await fetch(base + "/api/creation-test-health", { headers });
assert.ok(health.ok && (await health.json()).isolated, "Requires an isolated creation API");

const projectId = crypto.randomUUID();
const projectPath = `/api/creation/projects/${projectId}`;
const create = await fetch(base + projectPath + "/commands", {
  method: "POST", headers,
  body: JSON.stringify({
    projectId, commandId: crypto.randomUUID(), type: "project.create",
    payload: { name: `Connection journey ${projectId.slice(0, 8)}` },
  }),
});
assert.ok(create.ok, await create.text());

const suffix = projectId.slice(0, 8);
const chatModels = [`connection-chat-a-${suffix}`, `connection-chat-b-${suffix}`];
const imageModel = `connection-image-${suffix}`;
const connectionUrl = `http://127.0.0.1:12345/v1/${suffix}`;
const before = await (await fetch(base + "/api/model-configs", { headers })).json();
const createdIds = [];
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(() => {
    try { localStorage.setItem("opendirector.modelSetup.v1", "dismissed"); } catch {}
  });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let discoveryCalls = 0;
  await page.route("**/api/model-configs/discover-many", async (route) => {
    discoveryCalls += 1;
    const { kinds } = route.request().postDataJSON();
    return route.fulfill({
      json: {
        results: kinds.map(({ kind, protocol }) => kind === "video"
          ? { kind, protocol, models: [], error: { code: "model_list_http_error", message: "HTTP 401 from the fixture" } }
          : { kind, protocol, models: kind === "agent" ? chatModels : [imageModel], error: null }),
      },
    });
  });

  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?setup=models`);
  const dialog = page.locator("dialog");
  await dialog.getByRole("button", { name: "Add a connection (multi-modal)", exact: true }).click();
  const form = dialog.getByRole("form", { name: "Add a connection" });
  await form.getByLabel("Service URL (Base URL)").fill(connectionUrl);
  await form.getByRole("checkbox", { name: "No key required" }).check();
  await form.getByRole("checkbox", { name: "Image generation", exact: true }).check();
  await form.getByRole("checkbox", { name: "Video generation", exact: true }).check();
  await form.getByRole("button", { name: "Fetch models", exact: true }).click();
  await form.getByRole("checkbox", { name: chatModels[0], exact: true }).waitFor();
  assert.equal(discoveryCalls, 1);
  assert.equal(await form.getByRole("checkbox", { name: imageModel, exact: true }).count(), 1);
  const videoRegion = form.getByRole("region", { name: "Video generation" });
  await videoRegion.getByText("HTTP 401 from the fixture").waitFor();
  assert.ok(await form.getByRole("button", { name: "Save connection", exact: true }).isDisabled());

  await form.getByRole("checkbox", { name: chatModels[0], exact: true }).check();
  await form.getByRole("checkbox", { name: imageModel, exact: true }).check();
  await form.getByRole("button", { name: "Save connection", exact: true }).click();
  await form.waitFor({ state: "hidden" });

  const listed = await (await fetch(base + "/api/model-configs", { headers })).json();
  const added = listed.filter((item) => item.modelId === chatModels[0] || item.modelId === imageModel);
  assert.deepEqual(added.map((item) => item.kind).sort(), ["agent", "image"]);
  assert.equal(new Set(added.map((item) => item.providerId)).size, 1);
  assert.ok(added.every((item) => item.providerId));
  createdIds.push(...added.map((item) => item.id));

  assert.deepEqual(errors, []);

  // Both modalities appear as one service in settings, not two.
  const textRow = dialog.locator(".cw-model-setup-row").filter({ hasText: "Text model" });
  await textRow.getByRole("button").first().click();
  const service = dialog.locator(".cw-model-service").filter({ hasText: connectionUrl });
  await service.first().waitFor();
  assert.equal(await service.count(), 1);
  const row = await service.first().innerText();
  assert.ok(row.includes(chatModels[0]), row);
  console.log("Multimodal connection configured two modalities from one address and key");
} finally {
  await browser.close();
  for (const id of createdIds) await fetch(base + "/api/model-configs/" + id, { method: "DELETE", headers });
  const leftovers = [chatModels[0], imageModel];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const after = await (await fetch(base + "/api/model-configs", { headers })).json();
    if (!after.some((item) => leftovers.includes(item.modelId))) break;
    for (const item of after.filter((row) => leftovers.includes(row.modelId))) {
      await fetch(base + "/api/model-configs/" + item.id, { method: "DELETE", headers });
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const remaining = await (await fetch(base + "/api/model-configs", { headers })).json();
  assert.deepEqual(remaining.filter((item) => leftovers.includes(item.modelId)), []);
}
