/** Search/history preserve chat visibility and work alongside it (#118).
 * Run against creation_server.py --assistant-fixture; no real models are used.
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launchBrowser } from "./engine.mjs";
import { chooseGenerationModel } from "./model_picker.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const headers = {
  "X-OpenDirector-Request": "1",
  "X-OpenDirector-Session": crypto.randomUUID(),
  "Content-Type": "application/json",
};
async function api(path, body) {
  const response = await fetch(base + "/api" + path, {
    headers,
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function until(read, matches, label) {
  const deadline = Date.now() + 15000;
  while (true) {
    const value = await read();
    if (matches(value)) return value;
    assert.ok(Date.now() < deadline, label);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const health = await api("/creation-test-health");
assert.equal(health.isolated, true);
assert.equal(health.assistantFixture, true);
const projectId = crypto.randomUUID();
await api(`/creation/projects/${projectId}/commands`, {
  projectId,
  commandId: crypto.randomUUID(),
  type: "project.create",
  payload: { name: `Auxiliary panels ${projectId.slice(0, 8)}` },
});

const browser = await launchBrowser();
try {
  const page = await browser.newPage({
    locale: "zh-CN",
    viewport: { width: 1720, height: 1120 },
  });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const cancellations = [];
  page.on("request", (request) => {
    if (/\/assistant\/turns\/[^/]+\/stop$/.test(request.url()))
      cancellations.push("assistant.stop");
    if (request.method() === "POST" && request.url().endsWith("/commands")) {
      const type = request.postDataJSON()?.type;
      if (type === "job.cancel") cancellations.push(type);
    }
  });
  await page.route(/\/assistant\/runtimes(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: [
        {
          id: "default",
          label: "Default",
          group: "default",
          modelSource: "settings",
          available: true,
          status: "ready",
          modelOverride: false,
          supportsSkills: true,
        },
      ],
    }),
  );
  await page.addInitScript(() => {
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    localStorage.setItem("opendirector.locale.v1", "zh-CN");
  });
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}`);
  try {
    await page.locator(".cw-save-status .saved").waitFor({ state: "attached" });
  } catch (error) {
    console.error({ errors, page: await page.locator("body").innerText() });
    throw error;
  }

  const assistant = page.locator("#canvas-assistant");
  const editor = assistant.locator('[contenteditable="true"]').first();
  const chatButton = page.locator(".cw-chat-button");
  const draft = "Keep my draft / 保留草稿";
  const labels = {
    "zh-CN": {
      search: "资产列表",
      history: "生成历史",
      searchClose: "关闭资产列表",
      historyClose: "关闭侧栏",
    },
    "en-US": {
      search: "Asset list",
      history: "Generation history",
      searchClose: "Close asset list",
      historyClose: "Close sidebar",
    },
  };
  const auxiliary = (kind) =>
    page.locator(
      kind === "search"
        ? ".cw-creation-assets"
        : ".cw-side-panel:not(.from-left)",
    );
  const trigger = (kind, locale) =>
    page.getByRole("button", {
      name: labels[locale][kind],
      exact: true,
    });
  async function assertChat(open, label) {
    assert.equal(
      await chatButton.getAttribute("aria-expanded"),
      String(open),
      label,
    );
    assert.equal(await assistant.isVisible(), open, label);
    if (open)
      assert.equal(await editor.textContent(), draft, `${label}: draft`);
  }
  async function assertLayout(panel) {
    const chat = await assistant.boundingBox();
    const box = await panel.boundingBox();
    assert.ok(box && chat);
    assert.ok(
      box.x >= 0 && box.x + box.width <= page.viewportSize().width,
      "auxiliary panel must stay inside the viewport",
    );
    if (page.viewportSize().width >= chat.width + box.width + 52)
      assert.ok(
        box.x + box.width <= chat.x - 10,
        "with room available, auxiliary panel must sit left of chat",
      );
    // A visible DOM node can still be hidden behind the assistant.
    await panel.locator("button").first().click({ trial: true });
  }
  async function openAuxiliary(kind, locale) {
    await trigger(kind, locale).click();
    await auxiliary(kind).waitFor();
  }
  async function closeAuxiliary(kind, locale) {
    await auxiliary(kind)
      .getByRole("button", {
        name: labels[locale][`${kind}Close`],
        exact: true,
      })
      .click();
    await auxiliary(kind).waitFor({ state: "detached" });
  }

  await chatButton.click();
  await editor.fill(draft);
  for (const locale of ["zh-CN", "en-US"]) {
    // Use the actual language switch rather than reloading with new storage.
    await page
      .locator(".cw-language-toggle")
      .getByRole("button", {
        name: locale === "zh-CN" ? "中文" : "EN",
        exact: true,
      })
      .click();
    assert.equal(await page.locator("html").getAttribute("lang"), locale);
    for (const width of [1720, 1024, 800, 600, 390]) {
      await page.setViewportSize({ width, height: 1120 });
      for (const kind of ["search", "history"]) {
        await openAuxiliary(kind, locale);
        await assertChat(
          true,
          `${locale}/${width}: opening ${kind} preserves chat`,
        );
        await assertLayout(auxiliary(kind));
        if (
          process.env.CREATION_SCREENSHOTS &&
          locale === "zh-CN" &&
          (width === 1720 || width === 390)
        ) {
          await mkdir(process.env.CREATION_SCREENSHOTS, { recursive: true });
          await page.screenshot({
            path: join(
              process.env.CREATION_SCREENSHOTS,
              `${kind}-${width}.png`,
            ),
          });
        }
        await closeAuxiliary(kind, locale);
        await assertChat(true, `closing ${kind} preserves chat`);
        await openAuxiliary(kind, locale);
        await trigger(kind, locale).click();
        await auxiliary(kind).waitFor({ state: "detached" });
        await assertChat(true, `toggling ${kind} preserves chat`);
      }
    }
    await page.setViewportSize({ width: 1720, height: 1120 });
    await openAuxiliary("search", locale);
    await auxiliary("search").getByRole("textbox").focus();
    await page.keyboard.press("Escape");
    await auxiliary("search").waitFor({ state: "detached" });
    await assertChat(true, "Escape closes only search");
    await openAuxiliary("search", locale);
    await editor.click();
    await auxiliary("search").waitFor({ state: "detached" });
    await assertChat(true, "clicking chat dismisses only search");

    await openAuxiliary("history", locale);
    await openAuxiliary("search", locale);
    await auxiliary("history").waitFor({ state: "detached" });
    await openAuxiliary("history", locale);
    await auxiliary("search").waitFor({ state: "detached" });
    await assertChat(true, "switching auxiliary panels preserves chat");
    await closeAuxiliary("history", locale);

    await assistant
      .getByRole("button", {
        name: locale === "zh-CN" ? "收起 AI 对话" : "Collapse AI chat",
        exact: true,
      })
      .click();
    for (const kind of ["search", "history"]) {
      await openAuxiliary(kind, locale);
      await assertChat(false, "auxiliary panel must not open collapsed chat");
      await closeAuxiliary(kind, locale);
      await assertChat(false, "closing auxiliary panel must not open chat");
    }
    await openAuxiliary("history", locale);
    await chatButton.click();
    await assertChat(true, "explicitly opening chat preserves draft");
    assert.equal(
      await auxiliary("history").isVisible(),
      true,
      "opening chat must preserve history",
    );
    await assertLayout(auxiliary("history"));
    await closeAuxiliary("history", locale);
    await assistant.getByRole("separator").press("End");
    for (const kind of ["search", "history"]) {
      await openAuxiliary(kind, locale);
      await assertLayout(auxiliary(kind));
      await closeAuxiliary(kind, locale);
    }
    await assistant.getByRole("separator").dblclick();
    console.log(
      `PASS ${locale}: visibility, drafts, dismissal, layout and resizing`,
    );
  }

  // Keep a real stored generation job and an assistant turn active while browsing.
  await page
    .locator(".cw-language-toggle")
    .getByRole("button", {
      name: "中文",
      exact: true,
    })
    .click();
  await api("/creation-test-gate", { open: false });
  await api("/creation-test-assistant-gate", { open: false });
  await page
    .getByRole("toolbar", { name: "画布创作工具" })
    .getByRole("button", { name: "添加图片", exact: true })
    .click();
  await chooseGenerationModel(page, { label: "fixture-image" });
  await page
    .getByRole("textbox", { name: "生成提示词", exact: true })
    .fill("Isolated panel regression image");
  const state = () => api(`/creation/projects/${projectId}`);
  await until(
    state,
    (value) =>
      value.generationSpecs[0]?.prompt === "Isolated panel regression image" &&
      value.generationSpecs[0]?.modelConfigId,
    "generation config must persist",
  );
  await page.getByRole("button", { name: "提交生成", exact: true }).click();
  const running = await until(
    state,
    (value) => value.jobs[0]?.status === "running",
    "fixture generation must start",
  );
  const jobId = running.jobs[0].id;
  if (!(await assistant.isVisible())) await chatButton.click();
  const conversation = () => api(`/creation/projects/${projectId}/assistant`);
  await until(
    conversation,
    (value) => !!value.modelSelections.agent,
    "assistant model selection must persist",
  );
  await editor.fill("Isolated panel regression conversation");
  await assistant
    .getByRole("button", { name: "发送消息", exact: true })
    .click();
  await assistant.getByText("已收到创作要求。", { exact: false }).waitFor();
  const turn = await until(
    conversation,
    (value) => value.messages.at(-1)?.status === "streaming",
    "fixture reply must start",
  );
  assert.ok(turn.activeTurnId);
  await editor.fill(draft);
  for (const kind of ["search", "history"]) {
    await openAuxiliary(kind, "zh-CN");
    await assertChat(true, "active reply stays visible while browsing");
    await closeAuxiliary(kind, "zh-CN");
    const current = await conversation();
    assert.equal(current.activeTurnId, turn.activeTurnId);
    assert.equal(current.messages.at(-1).status, "streaming");
    assert.equal(
      (await state()).jobs.find((job) => job.id === jobId)?.status,
      "running",
    );
  }
  await api("/creation-test-assistant-gate", { open: true });
  await api("/creation-test-gate", { open: true });
  const complete = await until(
    conversation,
    (value) => value.messages.at(-1)?.status === "complete",
    "same reply must complete",
  );
  assert.equal(complete.messages.length, turn.messages.length);
  assert.equal(complete.activeTurnId, undefined);
  await until(
    state,
    (value) =>
      value.jobs.find((job) => job.id === jobId)?.status === "succeeded",
    "same generation job must complete",
  );
  await assistant
    .getByText("已收到创作要求。这是隔离测试回复。", { exact: true })
    .waitFor();
  for (const kind of ["search", "history"]) {
    await openAuxiliary(kind, "zh-CN");
    await closeAuxiliary(kind, "zh-CN");
    await assertChat(true, "completed conversation and draft remain available");
    assert.equal(
      (await conversation()).messages.length,
      complete.messages.length,
    );
  }
  assert.deepEqual(cancellations, [], "browsing panels must not cancel tasks");
  assert.deepEqual(errors, []);
  console.log(
    "PASS active reply, generation, completed messages and no cancellation",
  );
} finally {
  try {
    await api("/creation-test-assistant-gate", { open: true });
    await api("/creation-test-gate", { open: true });
  } finally {
    await browser.close();
  }
}
