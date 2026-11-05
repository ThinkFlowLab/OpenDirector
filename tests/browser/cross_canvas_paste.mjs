/** Isolated model double + real project storage: copy media between canvases (#69). */
import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";
import { chooseGenerationModel } from "./model_picker.mjs";
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const headers = { "X-OpenDirector-Request": "1", "Content-Type": "application/json" };
async function call(path, body) {
  const response = await fetch(api + path, { headers, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function until(check) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error("Expected persisted state not observed");
}
assert.equal((await call("/api/creation-test-health")).isolated, true);
await call("/api/creation-test-gate", { open: true });
const project = async (label) => {
  const id = crypto.randomUUID();
  const name = `${label} ${id.slice(0, 8)}`;
  await call(`/api/creation/projects/${id}/commands`, { projectId: id, commandId: crypto.randomUUID(),
    type: "project.create", payload: { name } });
  return { id, name, state: () => call(`/api/creation/projects/${id}`) };
};
const source = await project("Paste source");
const target = await project("Paste target");
const browser = await launchBrowser();
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  // Skip the first-run model setup welcome; it covers the canvas.
  await page.addInitScript(() =>
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
  );
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  const saved = () => page.getByText("已保存到本机", { exact: true }).waitFor();
  const nodes = page.locator(".react-flow__node");
  const loadedImages = (count) => page.waitForFunction((count) => {
    const images = [...document.querySelectorAll(".react-flow__node img.cw-image-preview")];
    return images.length === count && images.every((image) => image.complete && image.naturalWidth > 0);
  }, count);
  await page.goto(`${base}/ai-tool/ai-canvas/${source.id}`);
  await saved();
  // One generated image and one upload.
  await page.getByRole("toolbar", { name: "画布创作工具" }).getByRole("button", { name: "添加图片", exact: true }).click();
  await chooseGenerationModel(page, { label: "fixture-image" });
  await page.getByRole("textbox", { name: "生成提示词", exact: true }).fill("Copied generation");
  await until(async () => (await source.state()).generationSpecs[0]?.modelConfigId);
  await saved();
  await page.getByRole("button", { name: "提交生成", exact: true }).click();
  await until(async () => (await source.state()).jobs[0]?.status === "succeeded");
  await page.locator(".cw-generating").waitFor({ state: "hidden" });
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    canvas.getContext("2d").fillRect(0, 0, 64, 64);
    return canvas.toDataURL().split(",")[1];
  });
  await page.getByLabel("选择本地素材文件", { exact: true }).setInputFiles({
    name: "upload.png", mimeType: "image/png", buffer: Buffer.from(png, "base64"),
  });
  await until(async () => (await source.state()).canvasItems.length === 2);
  await saved();
  await loadedImages(2);

  await page.locator(".cw-workspace").focus();
  await page.keyboard.press("Control+a");
  await page.waitForFunction(() => document.querySelectorAll(".react-flow__node.selected").length === 2);
  await page.keyboard.press("Control+c");
  // Switching closes the source client and revokes its preview URLs.
  await page.getByRole("button", { name: "切换项目", exact: true }).click();
  await page.getByRole("menuitemradio", { name: target.name, exact: true }).click();
  await page.locator(".cw-project-name").filter({ hasText: target.name }).waitFor();
  await saved();
  await page.locator(".cw-workspace").focus();
  // Saved media is copied on the server: no bytes go up or come back down.
  const transfers = [];
  const watch = (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/uploads\/[^/]+(\/copy)?$/.test(path) && request.method() === "PUT" || path.endsWith("/content"))
      transfers.push(`${request.method()} ${path.replace(/^.*\/projects\/[^/]+/, "")}`);
  };
  page.on("request", watch);
  await page.keyboard.press("Control+v");
  await nodes.nth(1).waitFor();
  await loadedImages(2);
  page.off("request", watch);
  assert.deepEqual(transfers.map((entry) => entry.replace(/[0-9a-f-]{36}/g, "<id>")).sort(),
    ["PUT /uploads/<id>/copy", "PUT /uploads/<id>/copy"]);
  const pasted = await until(async () => {
    const snapshot = await target.state();
    return snapshot.canvasItems.filter((item) => item.visible).length === 2 && snapshot;
  });
  await saved();
  assert.equal(await page.getByText(/保存失败/).count(), 0);
  assert.deepEqual(pasted.canvasItems.map((item) => item.binding.role).sort(), ["material", "material"]);
  assert.equal(pasted.jobs.length, 0, "a copy must not claim the source project's generation task");
  assert.deepEqual(pasted.assets.map((asset) => asset.provenance.source), ["upload", "upload"]);
  assert.ok(pasted.assets.every((asset) => asset.projectId === target.id));

  // Paste again: the copied media is registered once per target project.
  await page.keyboard.press("Control+v");
  await until(async () => (await target.state()).canvasItems.filter((item) => item.visible).length === 4);
  await saved();
  assert.equal((await target.state()).assets.length, 2);

  // Reopening the target, with every preview cache gone, still reads the media.
  await page.reload();
  await saved();
  await loadedImages(4);
  assert.equal((await source.state()).canvasItems.length, 2, "the source canvas is unchanged");
  assert.deepEqual(errors, []);
  console.log("PASS cross-canvas paste: media registered in the target, saved and readable after reopening");
} finally {
  await browser.close();
}
