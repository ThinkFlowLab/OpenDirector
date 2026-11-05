import { chooseGenerationModel } from "./model_picker.mjs";
/** Real image/layer editing against the isolated creation fixture; no model calls. */
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
async function call(path, body) {
  const response = await fetch(api + path, {
    headers: {
      "X-OpenDirector-Request": "1",
      "Content-Type": "application/json",
    },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
assert.equal((await call("/api/creation-test-health")).isolated, true);
const projectId = crypto.randomUUID();
await call(`/api/creation/projects/${projectId}/commands`, {
  projectId,
  commandId: crypto.randomUUID(),
  type: "project.create",
  payload: { name: `Crop and copy ${projectId.slice(0, 8)}` },
});
const state = () => call(`/api/creation/projects/${projectId}`);
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await state();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Expected persisted layer state not observed");
}
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
// Skip the first-run model setup welcome; it covers the canvas.
await page.addInitScript(() =>
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
);
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const output = (snapshot, item) =>
  item.binding.materialOverride?.assetId ??
  snapshot.results.find(
    (r) =>
      r.id ===
      snapshot.generationSpecs.find((s) => s.id === item.binding.objectRef.id)
        ?.currentResultId,
  )?.asset.assetId;
async function saved() {
  await page.getByText("已保存到本机", { exact: true }).waitFor();
}
async function menu(itemId, action) {
  await page
    .locator(".react-flow__pane")
    .click({ position: { x: 100, y: 100 } });
  await page.keyboard.press("Escape");
  await page
    .locator(`.react-flow__node[data-id="${itemId}"] .cw-node-title`)
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: new RegExp(`^${action}`) }).click();
}
async function crop(itemId) {
  await menu(itemId, "编辑图片");
  await page.getByRole("combobox", { name: "裁剪比例" }).waitFor();
}
async function apply() {
  await page.getByRole("button", { name: "应用编辑", exact: true }).click();
  // Persisted state can precede the acknowledgement that clears this edit.
  await page
    .getByRole("combobox", { name: "裁剪比例" })
    .waitFor({ state: "hidden" });
}
try {
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}`);
  await saved();
  await page
    .getByRole("toolbar", { name: "画布创作工具" })
    .getByRole("button", { name: "添加图片", exact: true })
    .click();
  await chooseGenerationModel(page, { label: "fixture-image" });
  await page
    .getByRole("textbox", { name: "生成提示词", exact: true })
    .fill("A purple square for editable crop");
  await page.getByRole("button", { name: "提交生成", exact: true }).click();
  let snapshot = await until((s) => s.jobs[0]?.status === "succeeded");
  await saved();
  const original = snapshot.canvasItems[0];
  await page.waitForFunction((id) => {
    const image = document.querySelector(
      `.react-flow__node[data-id="${id}"] img.cw-image-preview`,
    );
    return (
      image instanceof HTMLImageElement &&
      image.complete &&
      image.naturalWidth === 320
    );
  }, original.id);
  await saved();
  const originalAsset = output(snapshot, original);
  const jobs = structuredClone(snapshot.jobs),
    results = structuredClone(snapshot.results);
  // A raw generated result can be copied without fabricating another execution.
  await menu(original.id, "复制副本");
  snapshot = await until((s) => s.canvasItems.length === 2);
  await saved();
  const rawCopy = snapshot.canvasItems.find((i) => i.id !== original.id);
  assert.notEqual(rawCopy.binding.objectRef.id, original.binding.objectRef.id);
  assert.equal(output(snapshot, rawCopy), originalAsset);
  assert.equal(
    snapshot.generationSpecs.find((s) => s.id === rawCopy.binding.objectRef.id)
      .currentResultId,
    null,
  );
  await crop(original.id);
  await page.getByRole("button", { name: "旋转 90°" }).click();
  await page.getByRole("combobox", { name: "裁剪比例" }).selectOption("4:3");
  await page.getByRole("slider", { name: /亮度/ }).press("End");
  await apply();
  snapshot = await until((s) =>
    s.editorDocuments.some((d) => d.kind === "image_crop"),
  );
  await saved();
  const doc = snapshot.editorDocuments.find((d) => d.kind === "image_crop");
  assert.equal(doc.data.source.assetId, originalAsset);
  assert.equal(doc.data.options.rotation, 90);
  assert.equal(doc.data.options.aspect, "4:3");
  assert.equal(doc.data.options.brightness, 200);
  assert.deepEqual([doc.data.width, doc.data.height], [240, 180]);
  const firstOutput = output(
    snapshot,
    snapshot.canvasItems.find((i) => i.id === original.id),
  );
  assert.notEqual(firstOutput, originalAsset);
  await page.reload();
  await saved();
  await crop(original.id);
  assert.equal(
    await page.getByRole("combobox", { name: "裁剪比例" }).inputValue(),
    "4:3",
  );
  assert.equal(
    await page.getByRole("slider", { name: /亮度/ }).inputValue(),
    "200",
  );
  await page.getByRole("combobox", { name: "裁剪比例" }).selectOption("9:16");
  await apply();
  snapshot = await until((s) =>
    s.editorDocuments.some((d) => d.id === doc.id && d.revision === 2),
  );
  await saved();
  const revised = snapshot.editorDocuments.find((d) => d.id === doc.id);
  assert.deepEqual([revised.data.width, revised.data.height], [180, 320]);
  assert.equal(revised.data.source.assetId, originalAsset);
  const editedOriginal = structuredClone(
    snapshot.canvasItems.find((i) => i.id === original.id),
  );
  const secondOutput = output(snapshot, editedOriginal);
  await menu(original.id, "复制副本");
  snapshot = await until((s) => s.canvasItems.length === 3);
  await saved();
  const copy = snapshot.canvasItems.find(
    (i) => i.id !== original.id && i.id !== rawCopy.id,
  );
  const copiedDoc = snapshot.editorDocuments.find(
    (d) => d.id === copy.editors.find((e) => e.kind === "image_crop").id,
  );
  assert.notEqual(copiedDoc.id, doc.id);
  assert.deepEqual(copiedDoc.data, revised.data);
  assert.equal(output(snapshot, copy), secondOutput);
  await crop(copy.id);
  await page.getByRole("combobox", { name: "裁剪比例" }).selectOption("1:1");
  await page.getByRole("button", { name: "旋转 90°" }).click();
  await apply();
  snapshot = await until((s) =>
    s.editorDocuments.some((d) => d.id === copiedDoc.id && d.revision === 2),
  );
  await saved();
  assert.deepEqual(
    snapshot.canvasItems.find((i) => i.id === original.id),
    editedOriginal,
  );
  assert.deepEqual(
    snapshot.editorDocuments.find((d) => d.id === doc.id),
    revised,
  );
  assert.notEqual(
    output(
      snapshot,
      snapshot.canvasItems.find((i) => i.id === copy.id),
    ),
    secondOutput,
  );
  assert.deepEqual(snapshot.jobs, jobs);
  assert.deepEqual(snapshot.results, results);
  await page.reload();
  await saved();
  await crop(copy.id);
  assert.equal(
    await page.getByRole("combobox", { name: "裁剪比例" }).inputValue(),
    "1:1",
  );
  await page.getByRole("button", { name: "关闭图片编辑" }).click();
  // Switching editors must start from the current composite, not resurrect
  // another editor's earlier pixels or discard its retained history.
  await crop(copy.id);
  await page.getByRole("button", { name: "图层工作台", exact: true }).click();
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .getByLabel("图层文字内容", { exact: true })
    .fill("Crop then layers");
  await page.getByRole("button", { name: "应用到画布", exact: true }).click();
  await page
    .getByRole("button", { name: "应用到画布", exact: true })
    .waitFor({ state: "hidden" });
  snapshot = await until((s) =>
    s.canvasItems
      .find((i) => i.id === copy.id)
      .editors.some((e) => e.kind === "layers"),
  );
  await saved();
  const layered = snapshot.canvasItems.find((i) => i.id === copy.id);
  const layerOutput = output(snapshot, layered);
  assert.ok(!layered.editors.some((e) => e.kind === "image_crop"));
  assert.ok(snapshot.editorDocuments.some((d) => d.id === copiedDoc.id));
  await crop(copy.id);
  assert.equal(
    await page.getByRole("combobox", { name: "裁剪比例" }).inputValue(),
    "original",
  );
  await page.getByRole("button", { name: "旋转 90°" }).click();
  await apply();
  snapshot = await until((s) =>
    s.canvasItems
      .find((i) => i.id === copy.id)
      .editors.some((e) => e.kind === "image_crop"),
  );
  await saved();
  const latestCopy = snapshot.canvasItems.find((i) => i.id === copy.id);
  assert.ok(!latestCopy.editors.some((e) => e.kind === "layers"));
  const latestCrop = snapshot.editorDocuments.find(
    (d) => d.id === latestCopy.editors.find((e) => e.kind === "image_crop").id,
  );
  assert.equal(latestCrop.data.source.assetId, layerOutput);
  assert.deepEqual(
    snapshot.canvasItems.find((i) => i.id === original.id),
    editedOriginal,
  );
  const assetId = output(
    snapshot,
    snapshot.canvasItems.find((i) => i.id === copy.id),
  );
  const size = await page.evaluate(
    async ({ projectId, assetId }) => {
      const response = await fetch(
        `/api/creation/projects/${projectId}/assets/${assetId}/content`,
        { headers: { "X-OpenDirector-Request": "1" } },
      );
      const image = await createImageBitmap(await response.blob());
      const dimensions = [image.width, image.height];
      image.close();
      return dimensions;
    },
    { projectId, assetId },
  );
  assert.deepEqual(size, [240, 240]);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      projectId,
      checks: [
        "UI generation",
        "raw generated copy",
        "crop and rotation retained",
        "reopen and recrop original",
        "independent copied spec and editor",
        "original unchanged",
        "crop and layer switching preserves current content",
        "real PNG decode",
      ],
    }),
  );
} catch (error) {
  console.error(await page.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
}
