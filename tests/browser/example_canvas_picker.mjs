/**
 * Isolated UI regression: the empty canvas offers the example picker, imports a
 * wrapped `.canvas` download, and reports a blocked page instead of importing it.
 *
 * Both samples ship as a ZIP around one `.canvas`, so the fixture mirrors that
 * shape; the failure case serves HTML like a blocked share link does.
 */
import assert from "node:assert/strict";
import { buildCanvasArchive } from "../../src/canvas/canvasArchive.ts";
import { createDocument, createNode } from "../../src/canvas/model.ts";
import { createZip } from "../../src/canvas/zipArchive.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright-core");
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
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json();
}

assert.equal((await call("/api/creation-test-health")).isolated, true);

// The fixture canvas has two nodes, so the import is observable by node count.
const document = {
  ...createDocument("测试示例画布"),
  nodes: [
    createNode("text", { x: 80, y: 120 }, { title: "说明", text: "示例文本" }),
    createNode("text", { x: 420, y: 120 }, { title: "备注", text: "另一个节点" }),
  ],
};
const archive = await buildCanvasArchive(document, {
  read: async () => {
    throw new Error("the fixture has no media");
  },
});
const wrapper = await createZip([
  { path: `${document.title}.canvas`, data: new Uint8Array(await archive.blob.arrayBuffer()) },
]);
const wrapperBytes = Buffer.from(await wrapper.arrayBuffer());

const sampleUrl = "https://lz.qaiu.top/fixture/example.zip";
const catalog = {
  schemaVersion: 1,
  items: [
    {
      id: "fixture-canvas",
      title: { "zh-CN": document.title, "en-US": "Fixture example canvas" },
      url: sampleUrl,
      filename: `${document.title}.zip`,
      contentKind: "zip-wrapper",
      bytes: wrapperBytes.byteLength,
      inner: { entry: `${document.title}.canvas`, archiveVersion: 2, nodes: 2 },
    },
  ],
};
const downloadHeaders = {
  // A cross-origin route still needs CORS headers: the app fetches, not navigates.
  "access-control-allow-origin": "*",
  "content-disposition": `attachment; filename="${document.title}.zip"`,
};

const projectId = crypto.randomUUID();
await call(`/api/creation/projects/${projectId}/commands`, {
  projectId,
  commandId: crypto.randomUUID(),
  type: "project.create",
  payload: { name: `Example picker ${projectId.slice(0, 8)}` },
});

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1500, height: 1000 } });
  await page.addInitScript(() =>
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
  );
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.route("**/example-canvases.json", (route) => route.fulfill({ json: catalog }));
  await page.route(sampleUrl, (route) =>
    route.fulfill({
      status: 200,
      headers: { ...downloadHeaders, "content-type": "application/octet-stream" },
      body: wrapperBytes,
    }),
  );

  const openCanvas = async () => {
    await page.goto(`${base}/ai-tool/ai-canvas/${projectId}`);
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    await page.getByRole("button", { name: /体验示例画布/ }).click();
    await page.locator(".cw-example-dialog").waitFor();
  };

  // 1. The picker lists the catalog entry with its measured size.
  await openCanvas();
  const dialog = page.locator(".cw-example-dialog");
  await dialog.getByText(document.title, { exact: true }).waitFor();
  assert.match(await dialog.locator(".cw-example-item small").first().innerText(), /MB|KB/);

  // 1b. The project menu reaches the same picker without returning to an empty canvas.
  await dialog.getByRole("button", { name: "关闭", exact: true }).first().click();
  await page.getByRole("button", { name: "切换项目", exact: true }).click();
  await page.getByRole("menuitem", { name: /示例画布/ }).click();
  await page.locator(".cw-example-dialog").waitFor();
  await page
    .locator(".cw-example-dialog")
    .getByText(document.title, { exact: true })
    .waitFor();

  // 2. Downloading the wrapped archive imports it and switches the canvas.
  await dialog.getByRole("button", { name: "下载并导入" }).click();
  await dialog.getByText(/已导入/).waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length === 2);
  assert.equal(await page.locator(".react-flow__node").count(), 2);
  await dialog.getByRole("button", { name: "关闭", exact: true }).first().click();

  // 3. A page instead of an archive is reported, and nothing is imported.
  await page.unroute(sampleUrl);
  await page.route(sampleUrl, (route) =>
    route.fulfill({
      status: 200,
      headers: { ...downloadHeaders, "content-type": "text/html" },
      body: "<!doctype html><html><body>请登录</body></html>",
    }),
  );
  await openCanvas();
  await page.locator(".cw-example-dialog").getByRole("button", { name: "下载并导入" }).click();
  await page.getByText(/服务器返回的是网页/).waitFor();
  assert.equal(await page.locator(".react-flow__node").count(), 0);
  // The manual fallback stays available for a blocked link.
  assert.equal(
    await page.locator(".cw-example-manual").count(),
    1,
  );

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
