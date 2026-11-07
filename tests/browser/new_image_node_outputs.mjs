/** A toolbar image node starts with the selected adapter's outputs, so an
 * unsent draft never makes the canvas query fail (#86).
 * Uses the isolated creation_server.py; no generation is submitted.
 */
import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const headers = {
  "X-OpenDirector-Request": "1",
  "Content-Type": "application/json",
};
const raw = (path, init = {}) =>
  fetch(api + path, { ...init, headers: { ...headers, ...init.headers } });
async function call(path, body) {
  const response = await raw(
    path,
    body ? { method: "POST", body: JSON.stringify(body) } : {},
  );
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function until(read, matches, label) {
  const deadline = Date.now() + 15000;
  while (true) {
    const value = await read();
    if (matches(value)) return value;
    assert.ok(Date.now() < deadline, `${label}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

assert.equal((await call("/api/creation-test-health")).isolated, true);
// This adapter only declares automatic 2K output; the catalog default is 1:1.
const seedream =
  (await call("/api/model-configs")).find(
    (model) => model.modelId === "doubao-seedream-5.0-flash",
  ) ??
  (await call("/api/model-configs", {
    kind: "image",
    url: "https://fixture.invalid/api/v3",
    modelId: "doubao-seedream-5.0-flash",
    apiKey: "fixture",
    protocol: "volcengine",
    connectionType: "api",
    authMode: "bearer",
  }));
assert.deepEqual(seedream.inputRules.imageOutputs, [
  { aspectRatio: "auto", size: "2K" },
]);
const projectId = crypto.randomUUID();
const project = `/api/creation/projects/${projectId}`;
await call(project + "/commands", {
  commandId: crypto.randomUUID(),
  projectId,
  type: "project.create",
  payload: { name: `New image outputs ${projectId.slice(0, 8)}` },
});
// The user has chosen this image model in the assistant model picker, which
// is the model a new node takes. Release the session so the page can edit.
{
  const session = crypto.randomUUID();
  const scoped = { "X-OpenDirector-Session": session };
  assert.ok((await raw(project + "/open", { method: "POST", headers: scoped })).ok);
  const { conversationId } = await call(project + "/assistant");
  const draft = await raw(project + "/assistant/draft", {
    method: "PUT",
    headers: scoped,
    body: JSON.stringify({
      conversationId,
      runtime: "default",
      modelSelections: { image: seedream.id },
    }),
  });
  assert.ok(draft.ok, await draft.text());
  await raw(`/api/creation/sessions/${session}`, { method: "DELETE" });
}
const snapshot = () => call(project);
const submitted = (await call("/api/creation-test-health")).calls.length;

const browser = await launchBrowser();
const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1600, height: 1100 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const failedCanvas = [];
page.on("response", (response) => {
  if (/\/canvas(?:\?|$)/.test(response.url()) && response.status() >= 400)
    failedCanvas.push(response.status());
});
try {
  await page.addInitScript(() =>
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
  );
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  await page
    .getByText("已保存到本机", { exact: true })
    .waitFor({ state: "attached" });

  await page
    .getByRole("toolbar", { name: "画布创作工具" })
    .getByRole("button", { name: "添加图片", exact: true })
    .click();
  assert.match(
    await page
      .getByRole("combobox", { name: "生成模型", exact: true })
      .textContent(),
    /doubao-seedream-5\.0-flash/,
  );
  await page
    .locator(".cw-composer-body [contenteditable='true']")
    .first()
    .click();
  await page.keyboard.type("海边日落，电影感");

  // The autosaved draft uses an output the adapter declares.
  const saved = await until(
    snapshot,
    (value) =>
      value.generationSpecs.some(
        (spec) =>
          spec.kind === "image" &&
          spec.modelConfigId === seedream.id &&
          spec.prompt.includes("海边日落"),
      ),
    "draft autosaved with the prompt",
  );
  const spec = saved.generationSpecs.find((item) => item.kind === "image");
  assert.equal(spec.parameters.aspectRatio, null);
  assert.ok(["auto", "2K"].includes(spec.parameters.size), spec.parameters.size);

  // The canvas stays readable and the draft can be generated.
  const item = saved.canvasItems[0].id;
  const canvas = await raw(project + "/canvas");
  assert.equal(canvas.status, 200, await canvas.clone().text());
  assert.equal((await canvas.json()).capabilities[item].canGenerate, true);

  await page.reload();
  await page
    .getByText("已保存到本机", { exact: true })
    .waitFor({ state: "attached" });
  await page.waitForTimeout(1000);
  assert.equal((await raw(project + "/canvas")).status, 200);
  assert.equal(
    (await snapshot()).generationSpecs.find((value) => value.kind === "image")
      .parameters.aspectRatio,
    null,
  );
  assert.equal(
    (await call("/api/creation-test-health")).calls.length,
    submitted,
    "no generation submitted",
  );
  assert.deepEqual(failedCanvas, []);
  assert.deepEqual(errors, []);
  console.log("new image node outputs ok");
} catch (error) {
  await page
    .screenshot({ path: ".opendirector/new-image-node-outputs-failure.png" })
    .catch(() => {});
  throw error;
} finally {
  await browser.close();
}
