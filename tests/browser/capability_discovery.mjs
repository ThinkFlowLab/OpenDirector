/** Real UI and application, with a controllable HTTP capability service and fixture generation. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { dirname, extname, basename, join } from "node:path";
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
const queryEvents = [];
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
  const editRoute = {
    ...route,
    path: "/v1/images/edits",
    request: {
      inputs: {
        image: {
          support: "supported",
          min_count: 1,
          ...(mode === "partial" ? {} : { max_count: 3 }),
        },
        mask_image: { support: "supported", max_count: 1 },
      },
      parameters: {
        width: { support: "supported", minimum: 64, maximum: 2048, step: 16 },
      },
    },
  };
  operations.image_edit = {
    support: mode === "unsupported" ? "unsupported" : "supported",
    exposure: "enabled",
    profiles: [
      {
        id: "image_to_image",
        support: mode === "unsupported" ? "unsupported" : "supported",
        required_inputs: ["text", "image"],
        outputs: ["image"],
        routes: [editRoute],
      },
    ],
    execution: operations.image_generation.execution,
  };
  return {
    object: "omni.capabilities",
    schema_version: 1,
    observed_at: new Date().toISOString(),
    models: [{ id: served, stage_ids: ["7"], operations }],
    stages: [{ id: "7", type: "diffusion", depends_on: [] }],
    routes: [route, editRoute],
  };
}
const service = createServer((request, response) => {
  if (request.url !== "/v1/omni/capabilities") {
    response.writeHead(404).end();
    return;
  }
  queries += 1;
  const queryEvent = { mode, received: Date.now() };
  queryEvents.push(queryEvent);
  if (mode === "connection") {
    request.socket.destroy();
    return;
  }
  const body = document(),
    status =
      mode === "legacy"
        ? 404
        : mode === "authentication"
          ? 401
          : mode === "failure"
            ? 503
            : 200;
  setTimeout(() => {
    queryEvent.responded = Date.now();
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
const openConflicts = [];
const sessionRenewals = new Set();
const renewalFailures = [];
const screenshots = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("response", async (response) => {
  if (response.url().endsWith("/open-canvas") && response.status() === 409)
    openConflicts.push(await response.text().catch(() => "unavailable"));
});
page.on("request", (request) => {
  if (
    request.method() === "PUT" &&
    new URL(request.url()).pathname.startsWith("/api/creation/sessions/")
  )
    sessionRenewals.add(request);
  const session = request.headers()["x-opendirector-session"];
  if (session) headers["X-OpenDirector-Session"] = session;
});
page.on("requestfinished", async (request) => {
  if (!sessionRenewals.has(request)) return;
  const response = await request.response();
  if (response?.status() !== 200) renewalFailures.push(response?.status());
  sessionRenewals.delete(request);
});
page.on("requestfailed", (request) => {
  if (sessionRenewals.has(request)) renewalFailures.push(request.failure());
  sessionRenewals.delete(request);
});
async function reloadAfterRenewal() {
  // Advancing the capability clock can also start a session heartbeat. Finish
  // that request before pagehide releases the session during this reload.
  await until(() => sessionRenewals.size === 0);
  assert.deepEqual(
    renewalFailures,
    [],
    "session renewals complete before reload",
  );
  await page.reload();
}
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
  assert.equal(
    await page
      .getByLabel("Service URL (Base URL)", { exact: true })
      .getAttribute("placeholder"),
    "Enter your service's API base URL",
  );
  assert.doesNotMatch(
    await page.locator(".cw-model-editor").innerText(),
    /SSH|127\.0\.0\.1:8200/,
  );
  await page
    .getByLabel("Service URL (Base URL)", { exact: true })
    .fill(serviceUrl);
  await page.getByRole("button", { name: "Add manually", exact: true }).click();
  assert.equal(
    await page
      .getByLabel("Model ID (the service's served-model-name)", { exact: true })
      .getAttribute("placeholder"),
    "Enter the model ID from your service",
  );
  await page
    .getByLabel("Model ID (the service's served-model-name)", { exact: true })
    .fill(served);
  await page
    .locator(".cw-model-manual")
    .getByRole("button", { name: "Add", exact: true })
    .click();
  const draft = page.locator(".cw-model-editor .cw-model-availability");
  async function presentInBothLanguages(state, expected) {
    for (const locale of ["en-US", "zh-CN"]) {
      await page.evaluate((next) => {
        localStorage.setItem("opendirector.locale.v1", next);
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: "opendirector.locale.v1",
            newValue: next,
          }),
        );
      }, locale);
      await until(
        async () =>
          (await page.locator("html").getAttribute("lang")) === locale,
      );
      if (expected) {
        await draft.getByText(expected[locale], { exact: true }).waitFor();
        assert.equal(
          await draft.getByText(expected[locale], { exact: true }).count(),
          1,
          `${state}: shared reason appears once in ${locale}`,
        );
      }
      if (locale === "en-US")
        assert.doesNotMatch(await draft.innerText(), /[\u3400-\u9fff]/);
      else assert.doesNotMatch(await draft.innerText(), /\b(?:AM|PM)\b/);
      assert.equal(
        await page
          .getByLabel(
            locale === "en-US"
              ? "Service URL (Base URL)"
              : "服务地址（Base URL）",
            { exact: true },
          )
          .inputValue(),
        serviceUrl,
      );
      if (process.env.CREATION_SCREENSHOT) {
        const target = process.env.CREATION_SCREENSHOT;
        const path = join(
          dirname(target),
          `${basename(target, extname(target))}-${state}-${locale}.png`,
        );
        const option = page
          .locator(".cw-model-option")
          .filter({ has: page.locator(".cw-model-availability") });
        await option.scrollIntoViewIfNeeded();
        const bounds = await option.evaluate((element) => {
          const card = element
            .querySelector(".cw-model-availability")
            .getBoundingClientRect();
          const label = element.querySelector("label").getBoundingClientRect();
          const scroller = element
            .closest(".cw-model-editor-scroll")
            .getBoundingClientRect();
          const footer = element
            .closest("form")
            .querySelector("footer")
            .getBoundingClientRect();
          return {
            cardTop: card.top,
            cardBottom: card.bottom,
            labelBottom: label.bottom,
            labelWidth: label.width,
            cardWidth: card.width,
            visibleTop: scroller.top,
            visibleBottom: Math.min(scroller.bottom, footer.top),
          };
        });
        assert.ok(
          bounds.cardTop >= bounds.labelBottom,
          `${state}: capability card occupies the row below the model`,
        );
        assert.ok(
          bounds.labelWidth >= bounds.cardWidth * 0.9,
          `${state}: model identity retains the available width`,
        );
        assert.ok(
          bounds.cardTop >= bounds.visibleTop - 1 &&
            bounds.cardBottom <= bounds.visibleBottom + 1,
          `${state}: the capability card is fully visible above the footer: ${JSON.stringify(bounds)}`,
        );
        await option.screenshot({ path });
        screenshots.push(path);
      }
    }
    await page.evaluate(() => {
      localStorage.setItem("opendirector.locale.v1", "en-US");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "opendirector.locale.v1",
          newValue: "en-US",
        }),
      );
    });
    await until(
      async () => (await page.locator("html").getAttribute("lang")) === "en-US",
    );
  }
  assert.equal(
    await draft.getByText("Not checked", { exact: true }).count(),
    1,
  );
  const previousQueries = queries;
  await presentInBothLanguages("unchecked", {
    "en-US": "Not checked",
    "zh-CN": "尚未检查",
  });
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
    .getByRole("button", { name: /^(Check|Refresh|Retry)$/, exact: true })
    .click();
  await page
    .getByLabel("Service URL (Base URL)", { exact: true })
    .fill(serviceUrl + "/changed");
  await lateDraft;
  await page.waitForTimeout(50);
  assert.equal(
    await draft.getByText("Not supported").count(),
    0,
    "an old draft response must not describe the edited connection",
  );
  await page
    .getByLabel("Service URL (Base URL)", { exact: true })
    .fill(serviceUrl);
  delay = 0;
  await draft
    .getByRole("button", { name: /^(Check|Refresh|Retry)$/, exact: true })
    .click();
  await draft.getByText("Not supported").first().waitFor();
  assert.equal(
    (await call("/api/model-configs")).some((item) => item.modelId === served),
    false,
    "a draft check must not save a model",
  );
  assert.equal(
    await draft.getByText("Not supported", { exact: true }).count(),
    1,
  );

  // The real form keeps draft values while presenting each state and switching language.
  await presentInBothLanguages("unsupported", {
    "en-US": "Not supported",
    "zh-CN": "不支持",
  });
  const draftUrl = page.getByLabel("Service URL (Base URL)", { exact: true });
  async function checkDraft(nextMode) {
    mode = nextMode;
    await draft
      .getByRole("button", { name: /^(Check|Refresh|Retry)$/, exact: true })
      .click();
    await until(async () => !(await draft.getByRole("button").isDisabled()));
    assert.equal(await draftUrl.inputValue(), serviceUrl);
    assert.equal(
      (await call("/api/model-configs")).some(
        (item) => item.modelId === served,
      ),
      false,
    );
  }
  await checkDraft("supported");
  assert.equal(
    await draft.getByRole("status").count(),
    0,
    "normal state has no aggregate summary",
  );
  for (const label of [
    "Text to image",
    "Single-image editing",
    "Multi-image editing",
  ])
    assert.equal(await draft.getByText(label, { exact: true }).count(), 1);
  assert.equal(await draft.locator("[data-availability=available]").count(), 3);
  await draft.getByText("Input requirements", { exact: true }).click();
  await presentInBothLanguages("normal", null);
  assert.equal(
    await draft.getByText("Count 1–3", { exact: true }).count(),
    1,
    "the same service image limit appears once",
  );
  assert.equal(
    await draft.getByText("Region input", { exact: true }).count(),
    1,
  );
  assert.equal(
    await draft.getByText("Service declaration", { exact: true }).count(),
    1,
    "the common input-constraint source appears once",
  );
  await page.evaluate(() => {
    localStorage.setItem("opendirector.locale.v1", "zh-CN");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "opendirector.locale.v1",
        newValue: "zh-CN",
      }),
    );
  });
  await draft.getByText("多图编辑", { exact: true }).waitFor();
  assert.equal(await draft.getByText("选区输入", { exact: true }).count(), 1);
  assert.equal(await draft.getByText("1–3 张", { exact: true }).count(), 1);
  assert.equal(await draft.getByText("服务声明", { exact: true }).count(), 1);
  assert.equal(
    await page.getByLabel("服务地址（Base URL）", { exact: true }).inputValue(),
    serviceUrl,
  );
  await page.evaluate(() => {
    localStorage.setItem("opendirector.locale.v1", "en-US");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "opendirector.locale.v1",
        newValue: "en-US",
      }),
    );
  });
  await draft.getByText("Multi-image editing", { exact: true }).waitFor();
  await checkDraft("partial");
  assert.equal(await draft.getByRole("status").count(), 0);
  assert.equal(
    await draft.getByText("Image count not confirmed", { exact: true }).count(),
    1,
  );

  const draftCheckUrl = "**/api/model-configs/availability/check";
  await presentInBothLanguages("partial", {
    "en-US": "Image count not confirmed",
    "zh-CN": "多图数量待确认",
  });
  // Error observations last two seconds. Hold browser time so both screenshots
  // inspect the same response, without issuing another check on a locale change.
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  for (const [state, expected] of [
    [
      "legacy",
      {
        "en-US": "No capability declaration from this service",
        "zh-CN": "服务未提供能力声明",
      },
    ],
    [
      "connection",
      {
        "en-US": "Cannot connect. Check the service URL.",
        "zh-CN": "无法连接服务，请检查地址",
      },
    ],
    [
      "authentication",
      {
        "en-US": "Authentication failed. Check the API key.",
        "zh-CN": "认证失败，请检查密钥",
      },
    ],
    ["failure", { "en-US": "Check failed", "zh-CN": "检查失败" }],
  ]) {
    await checkDraft(state);
    await presentInBothLanguages(state, expected);
    assert.equal(
      await draft
        .getByText("Image count not confirmed", { exact: true })
        .count(),
      0,
      `${state}: no secondary multi-image reason`,
    );
    assert.equal(
      await draft.getByText("Not checked", { exact: true }).count(),
      0,
    );
    assert.equal(
      await draft.locator("li [data-availability=unknown]").count(),
      3,
    );
  }
  await page.route(
    draftCheckUrl,
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Fixture check failed" }),
      }),
    { times: 1 },
  );
  await checkDraft("supported");
  assert.equal(await draft.getByRole("alert").count(), 1);
  assert.equal(
    await draft.getByText("Not checked", { exact: true }).count(),
    0,
    "a failed check does not also say unchecked",
  );
  await page.unroute(draftCheckUrl);
  await page.clock.resume();
  await page.clock.setSystemTime(new Date());
  delay = 400;
  mode = "paused";
  await draft.getByRole("button", { name: "Retry", exact: true }).click();
  assert.equal(
    await draft.getByText("Checking…", { exact: true }).count(),
    1,
    "checking appears only on the button",
  );
  assert.equal(await draft.getByRole("status").count(), 0);
  await draft.getByText("Service paused", { exact: true }).waitFor();
  delay = 0;
  assert.equal(
    await draft.getByText("Service paused", { exact: true }).count(),
    1,
  );
  // Clock control lets each language capture the same unexpired observation.
  await page.clock.pauseAt(new Date());
  await presentInBothLanguages("paused", {
    "en-US": "Service paused",
    "zh-CN": "服务已暂停",
  });
  await page.clock.fastForward(5100);
  await until(
    async () =>
      (await draft.getByText("Service paused", { exact: true }).count()) === 0,
  );
  assert.equal(
    await draft.getByText("Service paused", { exact: true }).count(),
    0,
  );
  assert.equal(
    await draft.locator("[data-availability=available]").count(),
    3,
    "pause expiry restores the retained declaration",
  );
  await page.clock.fastForward(25100);
  await draft
    .getByText("Results expired. Refresh to check again.", { exact: true })
    .waitFor();
  assert.equal(
    await draft
      .getByText("Results expired. Refresh to check again.", { exact: true })
      .count(),
    1,
  );
  assert.equal(await draft.locator("li[data-stale]").count(), 3);
  await presentInBothLanguages("expired", {
    "en-US": "Results expired. Refresh to check again.",
    "zh-CN": "检查结果已过期，请刷新",
  });
  assert.equal(await draftUrl.inputValue(), serviceUrl);
  await page.clock.resume();
  await page.clock.setSystemTime(new Date());
  await checkDraft("unsupported");
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
  await serviceCard.locator("summary").first().click();
  await serviceCard.getByText("Not supported").first().waitFor();

  // Create a real generation object and prove API rejection has no job/provider side effect.
  const specId = crypto.randomUUID(),
    itemId = crypto.randomUUID();
  const created = await command("canvas.createGeneration", {
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
  assert.equal(created.status, "applied");
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
    .getByRole("button", { name: /^(Check|Refresh|Retry)$/, exact: true })
    .click();
  await serviceCard.getByRole("alert").waitFor();
  await page.unroute(refreshUrl);
  mode = "supported";
  await serviceCard
    .getByRole("button", { name: /^(Check|Refresh|Retry)$/, exact: true })
    .click();
  await serviceCard.getByText("Supported").first().waitFor();
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await reloadAfterRenewal();
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
  await reloadAfterRenewal();
  await page.locator(`.react-flow__node[data-id="${itemId}"]`).click();
  await until(
    async () =>
      await page
        .locator(".cw-generation-composer button.cw-run-button")
        .isDisabled(),
  );
  await page.locator(".cw-generation-composer button.cw-run-button").hover();
  await page.getByText("Service paused").first().waitFor();
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
  const matchesRefresh = (manual) => (response) => {
    if (
      !response.url().endsWith("/api/model-configs/availability") ||
      response.request().method() !== "POST"
    )
      return false;
    const body = response.request().postDataJSON();
    return (
      body.manual === manual &&
      body.configIds.includes(saved.id) &&
      (!manual || body.configIds.length === 1)
    );
  };
  // Opening a category checks its saved connections. Let that batch finish
  // before testing a manual refresh, which shares the bounded worker queue.
  const [categoryRefresh] = await Promise.all([
    chinese.waitForResponse(matchesRefresh(false)),
    chinese
      .locator(".cw-model-setup-row")
      .filter({ hasText: "图片模型" })
      .getByRole("button")
      .click(),
  ]);
  assert.equal(categoryRefresh.status(), 200);
  await categoryRefresh.finished();
  const chineseService = chinese
    .locator(".cw-model-service")
    .filter({ hasText: served });
  await chineseService.locator("summary").first().click();
  await until(
    async () =>
      await chineseService
        .getByRole("button", { name: /^(检查|刷新|重试)$/, exact: true })
        .isEnabled(),
  );
  const [legacyRefresh] = await Promise.all([
    chinese.waitForResponse(matchesRefresh(true)),
    chineseService
      .getByRole("button", { name: /^(检查|刷新|重试)$/, exact: true })
      .click(),
  ]);
  assert.equal(legacyRefresh.status(), 200);
  const legacyObservation = (await legacyRefresh.json()).models.find(
    (model) => model.configId === saved.id,
  );
  assert.equal(legacyObservation?.reasonCode, "protocol_unavailable");
  try {
    await chineseService.getByText("服务未提供能力声明").first().waitFor();
  } catch (failure) {
    throw new Error(
      JSON.stringify({
        observation: legacyObservation,
        displayed: await chineseService.innerText(),
        browserTime: await chinese.evaluate(() => Date.now()),
      }),
      { cause: failure },
    );
  }
  await until(
    async () =>
      await chineseService
        .getByRole("button", { name: /^(检查|刷新|重试)$/, exact: true })
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
      openConflicts,
      renewalFailures,
      screenshots,
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
} catch (failure) {
  console.error(
    JSON.stringify({
      failedPage: page.url(),
      pageErrors: errors,
      openConflicts,
      queryEvents,
      visibleText: await page
        .locator("body")
        .innerText()
        .catch(() => "unavailable"),
      canvasNodes: await page
        .locator(".react-flow__node")
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("data-id")),
        )
        .catch(() => []),
    }),
  );
  throw failure;
} finally {
  if (saved) await call(`/api/model-configs/${saved.id}`, undefined, "DELETE");
  await browser.close();
  service.closeAllConnections();
  await new Promise((resolve) => service.close(resolve));
}
