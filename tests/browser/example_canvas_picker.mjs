/**
 * Isolated UI regression: the empty canvas imports the two hosted samples
 * directly with a progress bar, the project menu still opens the full picker,
 * and a blocked page is reported instead of imported.
 *
 * The catalog ships inside the app, so the check intercepts the sample URLs
 * themselves; the fixture is a ZIP around one `.canvas`, like the real hosts
 * serve, and the failure case returns HTML like a blocked share link does.
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

// The bundled catalog points the two buttons at these hosts.
const samplePattern = /^https:\/\/lz\.qaiu\.top\//;
const downloadHeaders = {
  // A cross-origin route still needs CORS headers: the app fetches, not navigates.
  "access-control-allow-origin": "*",
  "content-disposition": `attachment; filename="${document.title}.zip"`,
};
const served = (contentType = "application/octet-stream") => ({
  status: 200,
  headers: { ...downloadHeaders, "content-type": contentType },
  body: contentType === "text/html" ? "<!doctype html><html><body>请登录</body></html>" : wrapperBytes,
});

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

  // A short delay makes the streaming progress observable on a ~1 KB fixture.
  await page.route(samplePattern, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill(served());
  });

  const openCanvas = async () => {
    await page.goto(`${base}/ai-tool/ai-canvas/${projectId}`);
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    // The example buttons enable once the canvas is ready.
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll("button")].find((item) =>
        item.textContent?.includes("体验图片示例"),
      );
      return !!button && !button.disabled;
    });
  };

  // 1. The empty-state button downloads, shows progress, imports and closes the bar.
  await openCanvas();
  await page.getByRole("button", { name: "体验图片示例" }).click();
  await page.locator(".cw-empty-example-status").waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length === 2);
  assert.equal(await page.locator(".react-flow__node").count(), 2);
  // The progress block lives in the empty state, which the imported canvas replaces.
  assert.equal(await page.locator(".cw-empty-example-status").count(), 0);

  // 2. The project menu still reaches the full picker.
  // The switch saves the new project first; the switcher is disabled until then.
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="切换项目"]');
    return !!button && !button.disabled;
  });
  await page.getByRole("button", { name: "切换项目", exact: true }).click();
  await page.getByRole("menuitem", { name: "示例画布", exact: true }).click();
  const dialog = page.locator(".cw-example-dialog");
  await dialog.waitFor();
  // The catalog ships with the app, so the rows carry its titles.
  await dialog.getByText("图像创作示例画布", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "关闭", exact: true }).first().click();

  // 3. A page instead of an archive is reported inline, and nothing is imported.
  await page.unroute(samplePattern);
  await page.route(samplePattern, (route) => route.fulfill(served("text/html")));
  await openCanvas();
  await page.getByRole("button", { name: "体验图片示例" }).click();
  await page.getByText(/服务器返回的是网页/).waitFor();
  assert.equal(await page.locator(".react-flow__node").count(), 0);

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
