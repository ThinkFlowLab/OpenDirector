/** Isolated fixture only: modified wheels zoom only within the canvas region. */
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:8019";
const api = process.env.CREATION_API_URL ?? base;
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
const health = await call("/api/creation-test-health");
assert.equal(health.isolated, true);
const projectId = crypto.randomUUID();
await call(`/api/creation/projects/${projectId}/commands`, {
  commandId: crypto.randomUUID(),
  projectId,
  type: "project.create",
  payload: { name: `Canvas wheel ${projectId.slice(0, 8)}` },
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
});
try {
  const page = await browser.newPage({
    locale: "zh-CN",
    viewport: { width: 1600, height: 1000 },
  });
  // Skip the first-run model setup welcome; it covers the canvas.
  await page.addInitScript(() =>
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
  );
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  await page.evaluate(() => {
    window.__modifiedWheels = [];
    document.addEventListener(
      "wheel",
      (event) => {
        if (event.ctrlKey || event.metaKey)
          window.__modifiedWheels.push(event.defaultPrevented);
      },
      { capture: true },
    );
  });
  const metrics = () =>
    page.evaluate(() => {
      const viewport = new DOMMatrix(
        getComputedStyle(document.querySelector(".react-flow__viewport"))
          .transform,
      );
      return {
        zoom: viewport.a,
        x: viewport.e,
        y: viewport.f,
        width: window.innerWidth,
        ratio: window.devicePixelRatio,
        scale: window.visualViewport.scale,
      };
    });
  const controls = [];
  const outsideCanvas = [];
  async function modifiedWheel(locator, name, zoomCanvas = true) {
    assert.equal(
      await locator.evaluate((element) => Boolean(element.closest(".cw-canvas-region"))),
      zoomCanvas,
      `${name}: verify the wheel target's region`,
    );
    await locator.hover();
    await page.waitForTimeout(100);
    const before = await metrics();
    const count = await page.evaluate(() => window.__modifiedWheels.length);
    await page.keyboard.down("Control");
    try {
      await page.mouse.wheel(0, -120);
    } finally {
      await page.keyboard.up("Control");
    }
    try {
      await page.waitForFunction(
        (count) => window.__modifiedWheels.length > count,
        count,
        { timeout: 3000 },
      );
    } catch (error) {
      console.error(JSON.stringify({ name, box: await locator.boundingBox() }));
      throw error;
    }
    await page.waitForTimeout(180);
    const after = await metrics();
    if (zoomCanvas) {
      assert.ok(after.zoom > before.zoom, `${name}: wheel must zoom the canvas`);
      assert.deepEqual(
        { ...after, zoom: before.zoom, x: before.x, y: before.y },
        before,
        `${name}: page UI must stay fixed`,
      );
    } else {
      assert.deepEqual(
        { zoom: after.zoom, x: after.x, y: after.y },
        { zoom: before.zoom, x: before.x, y: before.y },
        `${name}: wheel must preserve the canvas viewport`,
      );
    }
    const prevented = await page.evaluate(
      (count) => window.__modifiedWheels.slice(count),
      count,
    );
    if (zoomCanvas) {
      assert.ok(
        prevented.length && prevented.every(Boolean),
        `${name}: native default must be cancelled`,
      );
    }
    // Meta+wheel follows the same boundary without changing ordinary scrolling.
    const metaPrevented = await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return !element.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY: 120,
          metaKey: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      );
    });
    if (zoomCanvas) {
      assert.equal(metaPrevented, true);
      await page.waitForFunction(
        (zoom) =>
          Math.abs(
            new DOMMatrix(
              getComputedStyle(document.querySelector(".react-flow__viewport"))
                .transform,
            ).a - zoom,
          ) < 0.001,
        before.zoom,
      );
      controls.push(name);
    } else {
      await page.waitForTimeout(180);
      const afterMeta = await metrics();
      assert.deepEqual(
        { zoom: afterMeta.zoom, x: afterMeta.x, y: afterMeta.y },
        { zoom: before.zoom, x: before.x, y: before.y },
        `${name}: Meta+wheel must preserve the canvas viewport`,
      );
      outsideCanvas.push(name);
    }
  }
  await modifiedWheel(
    page.getByRole("toolbar", { name: "画布创作工具" }),
    "left toolbar",
  );
  // Real material bytes expose the node toolbar without contacting a model.
  await page
    .locator('.cw-workspace > input[type="file"]')
    .first()
    .setInputFiles({
      name: "wheel-fixture.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGNsYGhgIAUwkaR6VMOohiGlAQBCPQEgiSD+iQAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
  const material = page.locator(".react-flow__node").first();
  await material.waitFor();
  await material.click();
  await page.getByRole("toolbar", { name: "节点操作", exact: true }).waitFor();
  await modifiedWheel(
    page.getByRole("toolbar", { name: "节点操作", exact: true }),
    "node toolbar",
  );
  await page
    .getByRole("toolbar", { name: "画布创作工具" })
    .getByRole("button", { name: "添加视频", exact: true })
    .click();
  const editor = page.getByRole("textbox", { name: "生成提示词", exact: true });
  await editor.fill(
    Array.from({ length: 60 }, (_, i) => `镜头${i + 1}：保持动作与镜头。`).join(
      "\n",
    ),
  );
  await modifiedWheel(editor, "node composer");
  await editor.evaluate((element) => (element.scrollTop = 0));
  const originalZoom = (await metrics()).zoom;
  await editor.hover();
  await page.mouse.wheel(0, 240);
  await page.waitForFunction(
    () => document.querySelector('.cw-composer [role="textbox"]').scrollTop > 0,
  );
  assert.equal((await metrics()).zoom, originalZoom);
  await page.getByRole("button", { name: "生成参数", exact: true }).click();
  const parameters = page.getByRole("dialog", {
    name: "生成参数设置",
    exact: true,
  });
  await parameters.waitFor();
  await modifiedWheel(parameters, "portaled parameters", false);
  await parameters
    .getByRole("button", { name: "关闭参数", exact: true })
    .evaluate((element) => element.click());
  await parameters.waitFor({ state: "hidden" });
  const expandButton = page.getByRole("button", {
    name: "展开会话框",
    exact: true,
  });
  await expandButton.click();
  await page
    .locator('.cw-composer-dock[data-expanded="true"]')
    .waitFor({ state: "visible" });
  await page
    .getByRole("dialog", { name: "展开的节点会话框", exact: true })
    .waitFor();
  await modifiedWheel(editor, "expanded composer");
  await page.getByRole("button", { name: "收起会话框", exact: true }).click();
  const chatToggle = page.locator(".cw-chat-button");
  if (await chatToggle.getAttribute("aria-expanded") === "false") await chatToggle.click();
  await modifiedWheel(
    page.locator('.cw-assistant-composer [role="textbox"]'),
    "assistant sidebar",
    false,
  );
  await page.getByRole("button", { name: "收起 AI 对话", exact: true }).click();
  await page.getByRole("button", { name: "资产库", exact: true }).click();
  const library = page.getByRole("dialog", { name: "资产库", exact: true });
  await library.waitFor();
  await modifiedWheel(library, "asset library dialog", false);
  await page.getByRole("button", { name: "关闭资产库", exact: true }).click();
  // The same trusted wheel still changes React Flow zoom over real canvas areas.
  async function canvasWheel(point, name) {
    const before = await metrics();
    await page.mouse.move(point.x, point.y);
    await page.keyboard.down("Control");
    try {
      await page.mouse.wheel(0, -30);
    } finally {
      await page.keyboard.up("Control");
    }
    await page.waitForFunction(
      (zoom) =>
        Math.abs(
          new DOMMatrix(
            getComputedStyle(document.querySelector(".react-flow__viewport"))
              .transform,
          ).a - zoom,
        ) > 0.001,
      before.zoom,
    );
    const after = await metrics();
    assert.equal(after.width, before.width, name);
    assert.equal(after.ratio, before.ratio, name);
    assert.equal(after.scale, before.scale, name);
  }
  const blank = await page.evaluate(() => {
    for (const x of [180, 300, 1250, 1400])
      for (const y of [140, 240, 560]) {
        const element = document.elementFromPoint(x, y);
        if (
          element?.closest(".react-flow__pane") &&
          !element.closest(".react-flow__node,.nowheel")
        )
          return { x, y };
      }
    return null;
  });
  assert.ok(blank, "Need visible blank canvas");
  await canvasWheel(blank, "blank canvas");
  const box = await page.locator(".react-flow__node.selected").boundingBox();
  await canvasWheel(
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    "canvas node",
  );
  assert.equal(
    (await call("/api/creation-test-health")).calls.length,
    health.calls.length,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      isolated: true,
      controlsZoomCanvasOnly: controls,
      outsideCanvasRetainsViewport: outsideCanvas,
      canvasAndNodeZoom: true,
      nativePageZoomPreventedOnCanvas: true,
      ordinaryEditorScroll: true,
      errors,
    }),
  );
} finally {
  await browser.close();
}
