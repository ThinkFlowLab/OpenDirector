/** Real HEIF bytes through the UI and project storage; generation uses the fixture provider. */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { readZip } from "../../src/canvas/zipArchive.ts";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const headers = { "X-OpenDirector-Request": "1", "Content-Type": "application/json" };
async function call(path, body) {
  const response = await fetch(api + path, { headers,
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function until(read, check, label) {
  const deadline = Date.now() + 30000;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    assert.ok(Date.now() < deadline, `${label}: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
const health = await call("/api/creation-test-health");
assert.equal(health.isolated, true);
assert.equal(health.provider, "fixture");
assert.equal((await (await fetch(base + "/api/creation-test-health", { headers })).json()).root, health.root);
const models = [];
for (const modelId of ["MiniMax-H3-Image", "MiniMax-H3-Image-Highspeed"])
  models.push((await call("/api/model-configs")).find(model => model.modelId === modelId) ??
    await call("/api/model-configs", { kind: "image", url: "https://api.minimax.cn/v1", modelId,
      apiKey: "fixture-only", protocol: "openai", connectionType: "api", authMode: "bearer" }));
const heic = await readFile(new URL("../fixtures/heif/oriented.heic", import.meta.url));
const heif = await readFile(new URL("../fixtures/heif/oriented.heif", import.meta.url));
const projectId = crypto.randomUUID();
const project = `/api/creation/projects/${projectId}`;
await call(project + "/commands", { commandId: crypto.randomUUID(), projectId,
  type: "project.create", payload: { name: `HEIF import ${projectId.slice(0, 8)}` } });
const targetId = crypto.randomUUID(), targetName = `HEIF paste ${targetId.slice(0, 8)}`;
await call(`/api/creation/projects/${targetId}/commands`, { commandId: crypto.randomUUID(), projectId: targetId,
  type: "project.create", payload: { name: targetName } });
const snapshot = () => call(project);
const browser = await launchBrowser();
const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(20000);
await page.addInitScript(() => localStorage.setItem("opendirector.modelSetup.v1", "dismissed"));
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await mkdir("test-results/heif", { recursive: true });
try {
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  await page.getByLabel("选择本地素材文件", { exact: true }).setInputFiles({
    name: "portrait.HEIC", mimeType: "application/octet-stream", buffer: heic });
  await until(snapshot, value => value.canvasItems.length === 1 && value.assets.length === 1, "HEIC upload");
  await page.evaluate(async encoded => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], "portrait.heif"));
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    canvas.getContext("2d").fillRect(0, 0, 128, 128);
    for (const [suffix, type] of [["png", "image/png"], ["jpg", "image/jpeg"], ["webp", "image/webp"]]) {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, type));
      transfer.items.add(new File([blob], `reference.${suffix}`, { type }));
    }
    document.querySelector(".react-flow__pane").dispatchEvent(new DragEvent("drop", {
      bubbles: true, cancelable: true, dataTransfer: transfer, clientX: 400, clientY: 650 }));
  }, heif.toString("base64"));
  const imported = await until(snapshot, value => value.canvasItems.length === 5 && value.assets.length === 5, "mixed drop");
  assert.deepEqual(imported.canvasItems.map(item => item.title),
    ["portrait.HEIC", "portrait.heif", "reference.png", "reference.jpg", "reference.webp"]);
  const orderedAssets = imported.canvasItems.map(item => imported.assets.find(asset => item.binding.objectRef.assetId === asset.id));
  const originals = imported.assets.filter(asset => /image\/hei[cf]/.test(asset.metadata.mimeType));
  assert.equal(originals.length, 2);
  for (const asset of originals) {
    assert.deepEqual([asset.metadata.width, asset.metadata.height], [192, 320]);
    const response = await fetch(api + project + `/assets/${asset.id}/content`, { headers });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), asset.metadata.mimeType === "image/heic" ? heic : heif);
  }
  for (const locale of ["zh-CN", "en-US"]) {
    await page.locator(".cw-language-toggle").getByRole("button", { name: locale === "en-US" ? "EN" : "中文", exact: true }).click();
    await page.reload();
    await page.getByText(locale === "en-US" ? "Saved on this device" : "已保存到本机", { exact: true }).waitFor();
    for (const asset of originals) {
      const node = imported.canvasItems.find(item => item.binding.objectRef?.assetId === asset.id);
      assert.ok(node, JSON.stringify(imported.canvasItems));
      const pixels = await page.locator(`.react-flow__node[data-id="${node.id}"] img.cw-image-preview`).evaluate(async image => {
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const ctx = canvas.getContext("2d"); ctx.drawImage(image, 0, 0);
        return { size: [canvas.width, canvas.height], red: ctx.getImageData(96, 40, 1, 1).data[0],
          blue: ctx.getImageData(96, 280, 1, 1).data[2] };
      });
      assert.deepEqual(pixels.size, [192, 320]);
      assert.ok(pixels.red > 200 && pixels.blue > 200);
    }
    // An orphaned display PNG must not become a file named *.heic.
    await page.evaluate(async projectId => {
      const { creationClient } = await import("/src/backend/creationClient.ts");
      const client = creationClient(projectId);
      window.restoreHeifSource = () => { client.assetForSource = original; };
      const original = client.assetForSource;
      client.assetForSource = () => undefined;
    }, projectId);
    const unexpectedDownloads = [];
    const onDownload = download => unexpectedDownloads.push(download);
    page.on("download", onDownload);
    try {
      await page.locator(`.react-flow__node[data-id="${imported.canvasItems[0].id}"]`).click({ button: "right" });
      await page.getByRole("menuitem", { name: locale === "en-US" ? "Download asset" : "下载素材", exact: true }).click();
      await page.getByText(locale === "en-US" ? /Could not read the canvas media/ : /无法读取画布素材/).waitFor();
      assert.equal(unexpectedDownloads.length, 0);
    } finally {
      page.off("download", onDownload);
      await page.evaluate(() => { window.restoreHeifSource(); delete window.restoreHeifSource; });
    }
    await page.getByLabel(locale === "en-US" ? "Choose local asset files" : "选择本地素材文件", { exact: true }).setInputFiles({
      name: "corrupt.heic", mimeType: "image/heic", buffer: heic.subarray(0, 100) });
    await page.getByText(locale === "en-US" ? /image could not be decoded/ : /无法读取图片/).waitFor();
    const tooLarge = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 5001; canvas.height = 5000;
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page.getByLabel(locale === "en-US" ? "Choose local asset files" : "选择本地素材文件", { exact: true }).setInputFiles({
      name: "too-large.heif", mimeType: "image/heif", buffer: Buffer.from(tooLarge, "base64") });
    await page.getByText(locale === "en-US" ? /25 million pixels/ : /2500 万/).waitFor();
    assert.equal((await snapshot()).assets.length, 5);
    await page.screenshot({ path: `test-results/heif/${locale}.png`, fullPage: true });
  }
  const originalNode = imported.canvasItems[0];
  await page.locator(`.react-flow__node[data-id="${originalNode.id}"]`).click({ button: "right" });
  const originalDownload = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download asset", exact: true }).click();
  assert.deepEqual(await readFile(await (await originalDownload).path()), heic);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export canvas", exact: true }).click();
  const archiveFile = await (await download).path();
  const archive = await readZip(await readFile(archiveFile));
  for (const [suffix, bytes] of [["HEIC", heic], ["heif", heif]]) {
    const entry = [...archive].find(([path]) => path.endsWith(`.${suffix}`));
    assert.ok(entry, JSON.stringify([...archive.keys()]));
    assert.deepEqual(Buffer.from(entry[1]), bytes);
  }
  for (const model of models) {
    const created = await page.evaluate(async ({ projectId, model, sources }) => {
      const { creationClient } = await import("/src/backend/creationClient.ts");
      const client = creationClient(projectId);
      await client.refresh();
      const specId = crypto.randomUUID(), itemId = crypto.randomUUID();
      const receipt = await client.command("canvas.createGeneration", {
        spec: { id: specId, projectId, kind: "image", purpose: "generation", modelConfigId: model.id,
          prompt: "Combine references in order", parameters: { size: "auto" } },
        item: { id: itemId, projectId, kind: "image", title: model.modelId,
          position: { x: 500, y: 1000 }, binding: { role: "generation", objectRef: { id: specId } } },
        references: sources.map((asset, order) => ({ id: crypto.randomUUID(), projectId, targetSpecId: specId,
          binding: "pinned", order, source: { assetId: asset.id, revision: asset.revision, fingerprint: asset.fingerprint, kind: "image" } })),
      });
      if (receipt.status !== "applied") throw Error(JSON.stringify(receipt));
      return { itemId, specId };
    }, { projectId, model, sources: orderedAssets });
    await page.reload();
    await page.locator(`.react-flow__node[data-id="${created.itemId}"]`).click();
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    const completed = await until(snapshot, value => value.jobs.some(job => job.inputSnapshot.spec.id === created.specId && job.status === "succeeded"), "image edit");
    const job = completed.jobs.find(job => job.inputSnapshot.spec.id === created.specId);
    assert.equal(job.adopted, true);
    assert.deepEqual(job.inputSnapshot.references.map(reference => reference.asset.assetId), orderedAssets.map(asset => asset.id));
  }
  const freshCopy = await page.evaluate(async ({ projectId, assetId }) => {
    const { creationClient } = await import("/src/backend/creationClient.ts");
    const { CreationProjection } = await import("/src/backend/creationProjection.ts");
    const client = creationClient(projectId);
    await client.refresh();
    const copied = await new CreationProjection(client).importResource({
      kind: "image", title: "Copied output.heic", src: await client.mediaUrl(assetId), fresh: true,
      identity: "publication:heif-fixture" });
    return client.snapshot.assets.find(asset => asset.id === copied.assetId);
  }, { projectId, assetId: originalNode.binding.objectRef.assetId });
  assert.notEqual(freshCopy.id, originalNode.binding.objectRef.assetId);
  assert.equal(freshCopy.metadata.mimeType, "image/heic");
  const freshBytes = await fetch(api + project + `/assets/${freshCopy.id}/content`, { headers });
  assert.deepEqual(Buffer.from(await freshBytes.arrayBuffer()), heic);
  const timelineId = await page.evaluate(async ({ projectId, assets }) => {
    const { creationClient } = await import("/src/backend/creationClient.ts");
    const client = creationClient(projectId), itemId = crypto.randomUUID(), editorId = crypto.randomUUID();
    const resources = assets.map(asset => ({ title: "Photo", asset: {
      assetId: asset.id, kind: "image", revision: asset.revision, fingerprint: asset.fingerprint } }));
    const receipt = await client.command("creation.batch", { operations: [
      { type: "editor.create", payload: { document: { id: editorId, projectId, kind: "timeline", data: {
        fps: 24, width: 640, height: 360, importedAssets: resources,
        tracks: [{ id: "visual", kind: "visual", title: "Visual", clips: resources.map((resource, index) => ({
          id: `clip-${index}`, resource, inPoint: 0, outPoint: 1 })) }] } } } },
      { type: "canvas.show", payload: { item: { id: itemId, projectId, kind: "timeline", title: "HEIF timeline",
        position: { x: 700, y: 100 }, binding: { role: "editor", objectRef: { id: editorId, kind: "timeline" } } } } },
    ] });
    if (receipt.status !== "applied") throw Error(JSON.stringify(receipt));
    return itemId;
  }, { projectId, assets: originals });
  await page.reload();
  await page.locator(`.react-flow__node[data-id="${timelineId}"]`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open editor", exact: true }).click();
  await page.locator(".cw-timeline-dialog").waitFor();
  const [timelineDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "XML + media ZIP", exact: true }).click(),
  ]);
  const timelineFiles = await readZip(await readFile(await timelineDownload.path()));
  for (const [suffix, bytes] of [["heic", heic], ["heif", heif]]) {
    const entry = [...timelineFiles].find(([path]) => path.endsWith(`.${suffix}`));
    assert.ok(entry);
    assert.deepEqual(Buffer.from(entry[1]), bytes);
  }
  await page.locator(".cw-timeline-dialog").getByRole("button", { name: "Close editor", exact: true }).click();
  await page.locator(".cw-timeline-dialog").waitFor({ state: "hidden" });
  await page.locator(`.react-flow__node[data-id="${originalNode.id}"]`).click();
  await page.locator(".cw-workspace").focus();
  await page.keyboard.press("Control+c");
  await page.getByRole("button", { name: "Switch project", exact: true }).click();
  await page.getByRole("menuitemradio", { name: targetName, exact: true }).click();
  await page.locator(".cw-project-name").filter({ hasText: targetName }).waitFor();
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  // A missing source forces the fallback to use bytes captured before switching.
  await page.route("**/uploads/*/copy", route => route.fulfill({ status: 404,
    contentType: "application/json", body: JSON.stringify({ detail: "Source unavailable" }) }));
  await page.locator(".cw-workspace").focus();
  await page.keyboard.press("Control+v");
  const pasted = await until(() => call(`/api/creation/projects/${targetId}`),
    value => value.canvasItems.length === 1 && value.assets.length === 1, "HEIF cross-project paste");
  const pastedBytes = await fetch(`${api}/api/creation/projects/${targetId}/assets/${pasted.assets[0].id}/content`, { headers });
  assert.deepEqual(Buffer.from(await pastedBytes.arrayBuffer()), heic);
  const copiedImage = page.locator(".react-flow__node img.cw-image-preview");
  assert.deepEqual(await copiedImage.evaluate(async image => {
    await image.decode(); return [image.naturalWidth, image.naturalHeight];
  }), [192, 320]);
  await page.locator('input[type="file"][accept=".canvas,application/zip"]').setInputFiles(archiveFile);
  await page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length === 5);
  for (const node of imported.canvasItems.slice(0, 2)) {
    const image = page.locator(`.react-flow__node[data-id="${node.id}"] img.cw-image-preview`);
    assert.deepEqual(await image.evaluate(async image => {
      await image.decode(); return [image.naturalWidth, image.naturalHeight];
    }), [192, 320]);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, projectId, checks: ["upload", "mixed drop", "orientation", "reload", "bilingual rejection", "orphaned preview download rejection", "original download and archive round trip", "FCPXML original bytes", "both model submissions with fixture results", "cross-project paste fallback"] }));
} finally {
  await browser.close();
}
