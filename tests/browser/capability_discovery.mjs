/** Real UI and application, with a controllable HTTP capability service and fixture generation. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const headers = {
  "X-OpenDirector-Request": "1",
  "Content-Type": "application/json",
};
async function call(path, body, method = body ? "POST" : "GET") {
  const requestHeaders = { ...headers };
  if (body?.type === "project.create")
    delete requestHeaders["X-OpenDirector-Session"];
  const response = await fetch(api + path, {
    method,
    headers: requestHeaders,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.ok(
    response.ok,
    `${response.status}: ${await response.clone().text()}`,
  );
  return response.status === 204 ? null : response.json();
}
async function until(check) {
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error("Expected persisted capability workflow state was not observed");
}
assert.equal((await call("/api/creation-test-health")).isolated, true);
let mode = "unsupported",
  delay = 0,
  queries = 0;
const served = `capability-image-${crypto.randomUUID().slice(0, 8)}`;
function document() {
  const route = {
    transport: "http",
    method: "POST",
    path: "/v1/images/generations",
    exposure: "enabled",
  };
  const operations = Object.fromEntries(
    [
      "chat",
      "image_generation",
      "image_edit",
      "video_generation",
      "speech",
      "audio_generation",
    ].map((id) => [
      id,
      { support: "unknown", exposure: "unknown", profiles: [] },
    ]),
  );
  operations.image_generation = {
    support: mode === "unsupported" ? "unsupported" : "supported",
    exposure: "enabled",
    profiles: [
      {
        id: "text_to_image",
        support: mode === "unsupported" ? "unsupported" : "supported",
        required_inputs: ["text"],
        outputs: ["image"],
        routes: [route],
      },
    ],
    execution: {
      state: mode === "paused" ? "paused" : "unpaused",
      scope: "deployment",
      observed_at: new Date().toISOString(),
    },
  };
  return {
    object: "omni.capabilities",
    schema_version: 1,
    observed_at: new Date().toISOString(),
    models: [{ id: served, stage_ids: ["7"], operations }],
    stages: [{ id: "7", type: "diffusion", depends_on: [] }],
    routes: [route],
  };
}
const service = createServer((request, response) => {
  if (request.url !== "/v1/omni/capabilities") {
    response.writeHead(404).end();
    return;
  }
  queries += 1;
  const body = document(),
    status = mode === "legacy" ? 404 : 200;
  setTimeout(() => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  }, delay);
});
service.listen(0, "127.0.0.1");
await once(service, "listening");
const serviceUrl = `http://127.0.0.1:${service.address().port}/v1`;
const browser = await launchBrowser();
const page = await browser.newPage({
  locale: "en-US",
  viewport: { width: 1500, height: 1000 },
});
await page.addInitScript(() => {
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
  localStorage.setItem("opendirector.locale.v1", "en-US");
});
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  const session = request.headers()["x-opendirector-session"];
  if (session) headers["X-OpenDirector-Session"] = session;
});
let saved;
try {
  const projectId = crypto.randomUUID();
  const projectPath = `/api/creation/projects/${projectId}`;
  const command = (type, payload, extra = {}) =>
    call(`${projectPath}/commands`, {
      commandId: crypto.randomUUID(),
      projectId,
      type,
      payload,
      ...extra,
    });
  await command("project.create", {
    name: `Capability checks ${projectId.slice(0, 8)}`,
  });
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Model connections", exact: true })
    .click();
  await page
    .locator(".cw-model-setup-row")
    .filter({ hasText: "Image model" })
    .getByRole("button")
    .click();
  await page.getByRole("button", { name: "Add service", exact: true }).click();
  await page
    .getByLabel("Service URL (Base URL)", { exact: true })
    .fill(serviceUrl);
  await page.getByRole("button", { name: "Add manually", exact: true }).click();
  await page
    .getByLabel("Model ID (the service's served-model-name)", { exact: true })
    .fill(served);
  await page
    .locator(".cw-model-manual")
    .getByRole("button", { name: "Add", exact: true })
    .click();
  const draft = page.locator(".cw-model-editor .cw-model-availability");
  const previousQueries = queries;
  await page
    .getByLabel("Service URL (Base URL)", { exact: true })
    .fill(serviceUrl + "/");
  await page.waitForTimeout(150);
  assert.equal(
    queries,
    previousQueries,
    "editing a form must not query the model server",
  );
  await page
    .getByLabel("Service URL (Base URL)", { exact: true })
    .fill(serviceUrl);
  delay = 350;
  const lateDraft = page.waitForResponse((response) =>
    response.url().endsWith("/model-configs/availability/check"),
  );
  await draft
    .getByRole("button", { name: "Check service capabilities", exact: true })
    .click();
  await page
    .getByLabel("Service URL (Base URL)", { exact: true })
    .fill(serviceUrl + "/changed");
  await lateDraft;
  await page.waitForTimeout(50);
  assert.equal(
    await draft
      .getByText(
        "This model does not support this operation. Choose a suitable model.",
      )
      .count(),
    0,
    "an old draft response must not describe the edited connection",
  );
  await page
    .getByLabel("Service URL (Base URL)", { exact: true })
    .fill(serviceUrl);
  delay = 0;
  await draft
    .getByRole("button", { name: "Check service capabilities", exact: true })
    .click();
  await draft
    .getByText(
      "This model does not support this operation. Choose a suitable model.",
    )
    .first()
    .waitFor();
  assert.equal(
    (await call("/api/model-configs")).some((item) => item.modelId === served),
    false,
    "a draft check must not save a model",
  );
  assert.equal(
    await page
      .getByLabel("Automatically check service capabilities", { exact: true })
      .isChecked(),
    true,
  );
  await page.getByRole("button", { name: "Save service", exact: true }).click();
  await page
    .getByRole("button", { name: "Add service", exact: true })
    .waitFor();
  saved = (await call("/api/model-configs")).find(
    (item) => item.modelId === served,
  );
  assert.ok(saved);
  const serviceCard = page
    .locator(".cw-model-service")
    .filter({ hasText: served });
  await serviceCard.locator("summary").click();
  await serviceCard
    .getByText(
      "This model does not support this operation. Choose a suitable model.",
    )
    .first()
    .waitFor();

  // Create a real generation object and prove API rejection has no job/provider side effect.
  const specId = crypto.randomUUID(),
    itemId = crypto.randomUUID();
  await command("canvas.createGeneration", {
    spec: {
      id: specId,
      projectId,
      kind: "image",
      purpose: "generation",
      prompt: "Preserve this prompt",
      modelConfigId: saved.id,
      parameters: {},
    },
    item: {
      id: itemId,
      projectId,
      kind: "image",
      title: "Capability example",
      position: { x: 300, y: 200 },
      binding: { role: "generation", objectRef: { id: specId } },
    },
    references: [],
  });
  let snapshot = await call(projectPath);
  const spec = snapshot.generationSpecs.find((item) => item.id === specId);
  const callsBefore = (await call("/api/creation-test-health")).calls.length;
  const denied = await command(
    "generation.submit",
    { specId, expectedSpecRevision: spec.revision, originItemId: itemId },
    {
      expectedVersions: [
        { objectType: "generation_spec", id: specId, revision: spec.revision },
        {
          objectType: "canvas_item",
          id: itemId,
          revision: snapshot.canvasItems.find((item) => item.id === itemId)
            .revision,
        },
      ],
    },
  );
  assert.equal(denied.status, "rejected");
  assert.equal((await call(projectPath)).jobs.length, 0);
  assert.equal(
    (await call("/api/creation-test-health")).calls.length,
    callsBefore,
  );

  const refreshUrl = "**/api/model-configs/availability";
  await page.route(
    refreshUrl,
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Fixture service unavailable" }),
      }),
    { times: 1 },
  );
  await serviceCard
    .getByRole("button", { name: "Check service capabilities", exact: true })
    .click();
  await serviceCard.getByRole("alert").waitFor();
  await page.unroute(refreshUrl);
  mode = "supported";
  await serviceCard
    .getByRole("button", { name: "Check service capabilities", exact: true })
    .click();
  await serviceCard
    .getByText("The service declares support for this request.")
    .first()
    .waitFor();
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await page.reload();
  const node = page.locator(`.react-flow__node[data-id="${itemId}"]`);
  await node.click();
  const composer = page.locator(".cw-generation-composer");
  await composer.waitFor();
  assert.match(await composer.innerText(), /Preserve this prompt/);
  const generate = composer.locator("button.cw-run-button");
  await generate.waitFor();
  assert.equal(await generate.isEnabled(), true);
  await generate.click();
  snapshot = await until(async () => {
    const value = await call(projectPath);
    return value.jobs.some((job) => job.status === "succeeded") &&
      value.assets.length > 0 &&
      value.results.length > 0
      ? value
      : null;
  });
  assert.equal(snapshot.jobs.length, 1);
  assert.equal(snapshot.jobs[0].inputSnapshot.model.modelId, served);
  assert.ok(snapshot.assets.length > 0);
  assert.deepEqual(
    [snapshot.assets[0].metadata.width, snapshot.assets[0].metadata.height],
    [320, 240],
  );
  assert.equal(snapshot.jobs[0].technicalCheck.status, "passed");
  const decoded = await page.evaluate(async (path) => {
    const response = await fetch(path, {
      headers: { "X-OpenDirector-Request": "1" },
    });
    if (!response.ok) throw Error(`Media download failed: ${response.status}`);
    const bitmap = await createImageBitmap(await response.blob());
    const size = [bitmap.width, bitmap.height];
    bitmap.close();
    return size;
  }, `${projectPath}/assets/${snapshot.assets[0].id}/content`);
  assert.deepEqual(decoded, [320, 240]);
  assert.equal(
    (await call("/api/creation-test-health")).calls.length,
    callsBefore + 1,
  );
  const history = JSON.stringify(snapshot.jobs[0].inputSnapshot);

  // A paused observation expires locally even without another successful response.
  mode = "paused";
  await call("/api/model-configs/availability", {
    configIds: [saved.id],
    manual: true,
  });
  await page.reload();
  await page.locator(`.react-flow__node[data-id="${itemId}"]`).click();
  await until(
    async () =>
      await page
        .locator(".cw-generation-composer button.cw-run-button")
        .isDisabled(),
  );
  await page.locator(".cw-generation-composer button.cw-run-button").hover();
  await page
    .getByText("Execution is paused. Resume the service and try again.")
    .first()
    .waitFor();
  await until(
    async () =>
      await page
        .locator(".cw-generation-composer button.cw-run-button")
        .isEnabled(),
  );
  assert.equal(
    JSON.stringify((await call(projectPath)).jobs[0].inputSnapshot),
    history,
  );

  // A second browser context exercises the actual Chinese presentation and legacy fallback.
  const chinese = await browser.newPage({
    locale: "zh-CN",
    viewport: { width: 1500, height: 1000 },
  });
  await chinese.addInitScript(() => {
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    localStorage.setItem("opendirector.locale.v1", "zh-CN");
  });
  mode = "legacy";
  const chineseProjectId = crypto.randomUUID();
  await call(`/api/creation/projects/${chineseProjectId}/commands`, {
    commandId: crypto.randomUUID(),
    projectId: chineseProjectId,
    type: "project.create",
    payload: { name: `能力检查中文界面 ${chineseProjectId.slice(0, 8)}` },
  });
  await chinese.goto(
    `${base}/ai-tool/ai-canvas/${chineseProjectId}?creation=unified`,
  );
  await chinese.getByRole("button", { name: "设置", exact: true }).click();
  await chinese.getByRole("button", { name: "模型接入", exact: true }).click();
  await chinese
    .locator(".cw-model-setup-row")
    .filter({ hasText: "图片模型" })
    .getByRole("button")
    .click();
  const chineseService = chinese
    .locator(".cw-model-service")
    .filter({ hasText: served });
  await chineseService.locator("summary").click();
  await chineseService
    .getByRole("button", { name: "检查服务能力", exact: true })
    .click();
  await chineseService
    .getByText("服务未提供可识别的能力接口，继续使用手动配置。")
    .first()
    .waitFor();
  await until(
    async () =>
      await chineseService
        .getByRole("button", { name: "检查服务能力", exact: true })
        .isEnabled(),
  );
  await chineseService
    .locator(".cw-model-availability")
    .scrollIntoViewIfNeeded();
  if (process.env.CREATION_SCREENSHOT)
    await chinese.screenshot({
      path: process.env.CREATION_SCREENSHOT,
      fullPage: true,
    });
  assert.equal(
    (await call("/api/model-configs")).find((item) => item.id === saved.id)
      .modelId,
    served,
  );
  assert.equal(
    JSON.stringify((await call(projectPath)).jobs[0].inputSnapshot),
    history,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      queries,
      checks: [
        "draft isolation",
        "stale draft response",
        "no query on typing",
        "save unsupported configuration",
        "zero-job rejection",
        "real UI submission and saved media",
        "pause expiration",
        "immutable history",
        "Chinese legacy fallback",
      ],
    }),
  );
  await chinese.close();
} finally {
  if (saved) await call(`/api/model-configs/${saved.id}`, undefined, "DELETE");
  await browser.close();
  service.closeAllConnections();
  await new Promise((resolve) => service.close(resolve));
}
