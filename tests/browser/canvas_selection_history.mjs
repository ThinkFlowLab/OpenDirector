/** Selection owns canvas shortcuts; only explicit editing owns text input. */
import assert from "node:assert/strict";
import { chooseGenerationModel } from "./model_picker.mjs";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
});
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
  });
  // Skip the first-run model setup welcome; it covers the canvas.
  await page.addInitScript(() =>
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
  );
  page.setDefaultTimeout(15000);
  const headers = { "X-OpenDirector-Request": "1" };
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const get = async (path) => {
    const response = await page.request.get(base + path, { headers });
    assert.equal(response.ok(), true, await response.text());
    return response.json();
  };
  assert.equal((await get("/api/creation-test-health")).isolated, true);
  async function until(read) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const result = await read();
      if (result) return result;
      await page.waitForTimeout(80);
    }
    throw new Error("Canvas selection state did not settle");
  }
  const checked = [];
  for (const kind of ["文本", "图片", "视频", "音频"]) {
    const projectId = crypto.randomUUID();
    const path = `/api/creation/projects/${projectId}`;
    const response = await page.request.post(base + path + "/commands", {
      headers,
      data: {
        type: "project.create",
        commandId: crypto.randomUUID(),
        projectId,
        payload: { name: `Selection ${projectId.slice(0, 8)}` },
      },
    });
    assert.equal(response.status(), 200);
    await page.goto(`${base}/ai-canvas/${projectId}`);
    const saved = () =>
      page.getByText("已保存到本机", { exact: true }).waitFor();
    await saved();
    const state = () => get(path);
    async function count(n) {
      const snapshot = await until(async () => {
        const snapshot = await state();
        return (
          snapshot.canvasItems.filter((item) => item.visible).length === n &&
          snapshot
        );
      });
      await until(
        async () => (await page.locator(".react-flow__node").count()) === n,
      );
      await saved();
      return snapshot;
    }
    await page
      .getByRole("toolbar", { name: "画布创作工具" })
      .getByRole("button", { name: `添加${kind}`, exact: true })
      .click();
    const original = (await count(1)).canvasItems[0];
    if (kind === "图片") {
      const model = (await get("/api/model-configs")).find(
        (model) => model.modelId === "Qwen/Qwen-Image-2.1",
      );
      assert.ok(model);
      await chooseGenerationModel(page, `config:${model.id}`);
      await saved();
    }
    const node = page.locator(`.react-flow__node[data-id="${original.id}"]`);
    const body = node.locator(
      kind === "文本" ? ".cw-text-display" : ".cw-node-placeholder",
    );
    await body.click({ position: { x: 8, y: 8 } });
    await page.waitForTimeout(350);
    assert.equal(
      await page
        .locator(".cw-workspace")
        .evaluate((el) => document.activeElement === el),
      true,
    );
    await body.click({ position: { x: 8, y: 8 } });
    await page.waitForTimeout(350);
    assert.equal(
      await page.locator(".cw-text-editor").count(),
      0,
      "Repeated single clicks must not edit text",
    );
    assert.equal(
      await page
        .locator(".cw-workspace")
        .evaluate((el) => document.activeElement === el),
      true,
    );

    // No test-side focus() workaround: these keys follow the actual node click.
    await page.keyboard.press("Control+c");
    await page.keyboard.press("Control+v");
    await count(2);
    await page.keyboard.press("Control+d");
    await count(3);
    await page.keyboard.press("Backspace");
    await count(2);
    await until(() =>
      page.getByRole("button", { name: "撤销", exact: true }).isEnabled(),
    );
    await page.keyboard.press("Control+z");
    await count(3);
    await until(() =>
      page.getByRole("button", { name: "撤销", exact: true }).isEnabled(),
    );
    await body.click({ position: { x: 8, y: 8 } });
    await page.keyboard.press("Delete");
    await count(2);
    await until(() =>
      page.getByRole("button", { name: "撤销", exact: true }).isEnabled(),
    );
    await page.keyboard.press("Control+z");
    await count(3);
    await until(() =>
      page.getByRole("button", { name: "撤销", exact: true }).isEnabled(),
    );

    if (kind === "文本") {
      await body.click({ position: { x: 8, y: 8 } });
      await page.keyboard.press("Enter");
      const editor = node.locator(".cw-text-editor");
      await editor.waitFor();
      await editor.fill("ABC");
      await editor.press("End");
      await editor.press("Backspace");
      assert.equal(await editor.inputValue(), "AB");
      assert.equal(await page.locator(".react-flow__node").count(), 3);
      await editor.press("Escape");
      await editor.waitFor({ state: "detached" });
      assert.equal(
        await page
          .locator(".cw-workspace")
          .evaluate((el) => document.activeElement === el),
        true,
      );
      await saved();
      const binding = (await state()).canvasItems.find(
        (item) => item.id === original.id,
      ).binding;
      const assetId =
        binding.materialOverride?.assetId ?? binding.objectRef?.assetId;
      assert.ok(assetId);
      const content = await page.request.get(
        base + path + `/assets/${assetId}/content`,
        { headers },
      );
      assert.equal(content.status(), 200);
      assert.equal(await content.text(), "AB");
      await body.dblclick({ position: { x: 8, y: 8 } });
      await editor.waitFor();
      await editor.press("Escape");
      await page.getByRole("button", { name: "编辑文本", exact: true }).click();
      await editor.waitFor();
      await editor.press("Escape");
    }

    // Explicit expansion focuses the prompt; editing never deletes canvas nodes.
    await body.click({ position: { x: 8, y: 8 } });
    await page.getByRole("button", { name: "展开会话框", exact: true }).click();
    const dock = page.locator(".cw-composer-dock");
    await until(() =>
      dock.evaluate(
        (el) =>
          el.querySelector('[contenteditable="true"]') ===
          document.activeElement,
      ),
    );
    await page.keyboard.insertText("prompt");
    await page.keyboard.press("Backspace");
    assert.equal(await page.locator(".react-flow__node").count(), 3);
    await page.keyboard.press("Escape");
    assert.equal(await dock.getAttribute("data-expanded"), "false");
    await body.click({ position: { x: 8, y: 8 } });
    await saved();

    if (kind === "文本") {
      // Hold one save in flight while several debounce windows elapse.
      let release, started;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const held = new Promise((resolve) => {
        started = resolve;
      });
      const writes = [];
      const routePattern = `**${path}/commands`;
      await page.route(routePattern, async (route) => {
        writes.push(route.request().postDataJSON());
        if (writes.length === 1) {
          started();
          await gate;
        }
        await route.continue();
      });
      const x = (await state()).canvasItems.find(
        (item) => item.id === original.id,
      ).position.x;
      await page.keyboard.press("ArrowRight");
      await held;
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press("ArrowRight");
        await page.waitForTimeout(600);
      }
      release();
      await saved();
      assert.equal(
        (await state()).canvasItems.find((item) => item.id === original.id)
          .position.x,
        x + 5,
      );
      assert.equal(
        writes.length,
        2,
        "Only the active and latest queued automatic save should be sent",
      );
      await page.unroute(routePattern);

      // A definitive lock timeout retries the same command, then confirms save.
      const retries = [];
      await page.route(routePattern, async (route) => {
        retries.push(route.request().postData());
        if (retries.length === 1)
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              detail: "项目存储正忙，请稍后重试。",
              code: "storage_busy",
            }),
          });
        else await route.continue();
      });
      await page.keyboard.press("ArrowRight");
      await saved();
      assert.equal(retries.length, 2);
      assert.equal(retries[0], retries[1]);
      assert.equal(
        (await state()).canvasItems.find((item) => item.id === original.id)
          .position.x,
        x + 6,
      );
      assert.equal(await page.getByText(/保存失败/).count(), 0);
      await page.unroute(routePattern);
    }
    checked.push(kind);
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      checked,
      selectionShortcuts: true,
      explicitTextEditing: true,
      expandedPromptFocus: true,
      autosaveCoalesced: true,
      storageBusyRetry: true,
      errors,
    }),
  );
} finally {
  await browser.close();
}
