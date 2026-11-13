/** HEIF upload failures and save acknowledgements, including the production build. */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const file = process.env.HEIF_REVIEW_FILE ?? new URL("../fixtures/heif/oriented.heic", import.meta.url);
const name = typeof file === "string" ? basename(file) : "oriented.heic";
const bytes = await readFile(file);
const headers = { "X-OpenDirector-Request": "1", "Content-Type": "application/json" };
async function call(path, body) {
  const response = await fetch(api + path, { headers,
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function until(read, check, label) {
  const deadline = Date.now() + 20000;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    assert.ok(Date.now() < deadline, `${label}: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
const health = await call("/api/creation-test-health");
assert.equal(health.isolated, true);
assert.equal((await (await fetch(base + "/api/creation-test-health", { headers })).json()).root, health.root);
const browser = await launchBrowser();
const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(20000);
await page.addInitScript(() => localStorage.setItem("opendirector.modelSetup.v1", "dismissed"));
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await mkdir("test-results/heif/recovery", { recursive: true });
try {
  for (const locale of ["en-US", "zh-CN"]) {
    const en = locale === "en-US";
    const saved = en ? "Saved on this device" : "已保存到本机";
    for (const mode of ["upload", "drop", "node", "reference", "video-reference", "failure"]) {
      const reference = mode === "reference" || mode === "video-reference";
      const id = crypto.randomUUID(), project = `/api/creation/projects/${id}`;
      await call(project + "/commands", { commandId: crypto.randomUUID(), projectId: id,
        type: "project.create", payload: { name: `HEIF ${mode} ${locale} ${id.slice(0, 8)}` } });
      const snapshot = () => call(project);
      await page.goto(`${base}/ai-tool/ai-canvas/${id}?creation=unified`);
      await page.locator(".cw-language-toggle").getByRole("button", { name: en ? "EN" : "中文", exact: true }).click();
      await page.getByText(saved, { exact: true }).waitFor();
      let uploadStarted;
      const uploading = new Promise(resolve => { uploadStarted = resolve; });
      const onRequest = request => {
        if (request.method() === "PUT" && request.url().includes(project + "/uploads/")) uploadStarted();
      };
      page.on("request", onRequest);
      const commandRoute = async route => {
        const command = route.request().postDataJSON();
        if (command.type === "creation.batch" && command.payload.operations.some(op => op.type === "canvas.show"))
          await uploading;
        await route.continue();
      };
      const previewRoute = async route => {
        if (mode === "failure") {
          await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ detail: "Preview unavailable" }) });
          return;
        }
        await until(snapshot, value => value.canvasItems.length === 1, "initial node save");
        await page.getByText(saved, { exact: true }).waitFor();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.unroute("**/browser-image", previewRoute);
        await route.continue();
      };
      const freshNode = mode === "node" || reference;
      try {
        if (freshNode) {
          await page.route("**/commands", commandRoute);
          await page.route("**/browser-image", previewRoute);
          await page.getByRole("button", { name: mode === "video-reference"
            ? (en ? "Add Video" : "添加视频") : (en ? "Add Image" : "添加图片"), exact: true }).click();
        } else if (mode === "failure") await page.route("**/browser-image", previewRoute);
        const upload = { name, mimeType: "application/octet-stream", buffer: bytes };
        if (mode === "node") {
          const node = page.locator(".react-flow__node");
          await node.hover();
          const choosing = page.waitForEvent("filechooser");
          await node.getByRole("button", { name: en ? "Upload Image" : "上传图片", exact: true }).click();
          await (await choosing).setFiles(upload);
        } else if (reference) {
          await page.getByLabel(en ? "Upload node reference" : "上传节点参考", { exact: true }).setInputFiles(upload);
        } else if (mode === "drop") {
          await page.evaluate(({ encoded, name }) => {
            const transfer = new DataTransfer();
            transfer.items.add(new File([Uint8Array.from(atob(encoded), c => c.charCodeAt(0))], name));
            document.querySelector(".react-flow__pane").dispatchEvent(new DragEvent("drop", {
              bubbles: true, cancelable: true, dataTransfer: transfer, clientX: 500, clientY: 400 }));
          }, { encoded: bytes.toString("base64"), name });
        } else await page.getByLabel(en ? "Choose local asset files" : "选择本地素材文件", { exact: true }).setInputFiles(upload);

        if (mode === "failure") {
          await page.getByText(/Preview unavailable/).waitFor();
          const failed = await snapshot();
          assert.equal(failed.assets.length, 1, "the original remains available");
          assert.equal(failed.canvasItems.length, 0, "no empty generation item or false success");
          assert.equal(await page.locator(".react-flow__node").count(), 0);
        } else {
          const stored = await until(snapshot, value => reference
            ? value.references.some(ref => ref.active)
            : value.canvasItems.some(item => item.binding.role === "material"), mode);
          assert.equal(stored.assets.length, 1);
          const asset = stored.assets[0];
          assert.equal(asset.metadata.mimeType, "image/heic");
          const original = await fetch(api + project + `/assets/${asset.id}/content`, { headers });
          assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
          for (const reloaded of [false, true]) {
            if (reloaded) {
              await page.reload();
              await page.getByText(saved, { exact: true }).waitFor();
              if (reference) await page.locator(".react-flow__node").click();
            }
            const image = page.locator(reference ? ".cw-chat-reference img" : "img.cw-image-preview").first();
            await image.waitFor();
            assert.deepEqual(await image.evaluate(async img => {
              await img.decode(); return [img.naturalWidth, img.naturalHeight];
            }), [asset.metadata.width, asset.metadata.height]);
          }
          if (reference) {
            const ref = stored.references.find(ref => ref.active);
            const source = stored.canvasItems.find(item => item.id === ref.source.id);
            assert.equal(source.binding.objectRef.assetId, asset.id);
          } else assert.equal(stored.canvasItems.length, 1);
        }
        await page.screenshot({ path: `test-results/heif/recovery/${mode}-${locale}.png`, fullPage: true });
        console.log(`PASS ${mode} ${locale} ${name}`);
      } finally {
        uploadStarted();
        page.off("request", onRequest);
        await page.unroute("**/commands", commandRoute);
        await page.unroute("**/browser-image", previewRoute);
      }
    }
  }
  assert.deepEqual(errors, []);
} finally {
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await browser.close();
}
