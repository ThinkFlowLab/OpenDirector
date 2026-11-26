/** Isolated API only: an empty model selector offers a way to configure that model type. */
import assert from "node:assert/strict";
import { addCanvasNode } from "./canvas_creation.mjs";
import { launchBrowser } from "./engine.mjs";
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const headers = {
  "X-OpenDirector-Request": "1",
  "Content-Type": "application/json",
};
async function call(path, body) {
  const response = await fetch(api + path, {
    headers,
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  assert.ok(
    response.ok,
    `${response.status}: ${await response.clone().text()}`,
  );
  return response.json();
}
assert.equal((await call("/api/creation-test-health")).isolated, true);
const configs = await call("/api/model-configs");
assert.equal(
  configs.some((item) => item.kind === "image"),
  true,
  "needs a fixture API with an image model",
);
assert.ok(configs.some((item) => item.kind === "agent"), "needs a fixture chat model");
const projectId = crypto.randomUUID();
await call(`/api/creation/projects/${projectId}/commands`, {
  commandId: crypto.randomUUID(),
  projectId,
  type: "project.create",
  payload: { name: "Configure model " + projectId.slice(0, 8) },
});
const browser = await launchBrowser();
try {
  const page = await browser.newPage({
    locale: "zh-CN",
    viewport: { width: 1600, height: 1000 },
  });
  await page.addInitScript(() => {
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    localStorage.setItem("opendirector.locale.v1", "zh-CN");
  });
  // The shared fixture may already contain video models from other tests.
  // Scope the empty video catalog to this page and keep the real image models.
  let onlyChatModel = false;
  await page.route("**/api/model-configs", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const models = await response.json();
    await route.fulfill({
      response,
      json: models.filter((item) => onlyChatModel ? item.kind === "agent" : item.kind !== "video"),
    });
  });
  page.setDefaultTimeout(15000);
  const errors = [];
  const generation = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST" && /generat|jobs/i.test(request.url()))
      generation.push(request.url());
  });
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}`);
  await page
    .getByText("已保存到本机", { exact: true })
    .waitFor()
    .catch(async (error) => {
      console.error(
        "Canvas did not open",
        page.url(),
        errors,
        await page.locator("body").innerText(),
      );
      throw error;
    });

  // Another category being configured must not hide the action.
  await addCanvasNode(page, "图片");
  await page.getByRole("textbox", { name: "生成提示词", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "配置图片模型", exact: true }).count(),
    0,
  );

  await addCanvasNode(page, "视频");
  const prompt = page.getByRole("textbox", { name: "生成提示词", exact: true });
  await prompt.fill("保留这段提示词");
  const action = page.getByRole("button", { name: "配置视频模型", exact: true });
  await action.focus();
  await page.keyboard.press("Enter");

  const dialog = page.locator("dialog#settings-dialog");
  await dialog.waitFor();
  assert.equal(
    await dialog
      .getByRole("button", { name: "视频", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );

  await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal((await prompt.innerText()).trim(), "保留这段提示词");
  await action.waitFor();
  // Reopen the same project with only its chat model exposed to this page.
  await page.getByTestId("workspace-mode-agent").click();
  onlyChatModel = true;
  await page.reload();
  const chat = page.locator("#canvas-assistant");
  const draft = chat.getByRole("textbox", { name: "消息内容", exact: true });
  const unsent = "等配置好模型后再发送";
  const draftSaved = page.waitForResponse((response) =>
    response.url().endsWith(`/creation/projects/${projectId}/assistant/draft`) &&
    response.request().method() === "PUT" && response.request().postDataJSON().draft === unsent);
  await draft.fill(unsent);
  for (const category of ["视频", "图片", "音频"]) {
    await chat.getByRole("button", { name: "模型配置：媒体模型", exact: true }).click();
    await chat.getByRole("tab", { name: new RegExp("^" + category) }).click();
    await chat.getByRole("button", { name: "添加模型", exact: true }).click();
    await dialog.getByRole("button", { name: category, exact: true, pressed: true }).waitFor();
    await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();
    assert.equal(await draft.innerText(), unsent);
  }

  await chat.getByRole("button", { name: /^Agent：/ }).click();
  await chat.getByRole("button", { name: "管理模型", exact: true }).click();
  await dialog.getByRole("button", { name: "对话", exact: true, pressed: true }).waitFor();
  await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();

  // The normal Settings entry retains General and the model overview.
  await page.getByRole("button", { name: "设置", exact: true }).click();
  assert.equal(await dialog.getByRole("button", { name: "通用" }).getAttribute("aria-current"), "page");
  await dialog.getByRole("button", { name: "模型接入", exact: true }).click();
  await dialog.locator(".cw-model-setup").waitFor();
  await dialog.getByRole("button", { name: "关闭设置", exact: true }).click();
  assert.ok((await draftSaved).ok());
  const saved = await call(`/api/creation/projects/${projectId}/assistant`);
  assert.equal(saved.draft, unsent);
  assert.deepEqual(saved.messages, []);
  assert.deepEqual(generation, []);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
console.log("composer configure model ok");
