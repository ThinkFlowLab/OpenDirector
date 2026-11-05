/** Tool placeholder/regression loop against the isolated fixture API.
 * Covers both project formats; all generation is simulated, with real files.
 */
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
// Skip the first-run model setup welcome; it covers the canvas.
await page.addInitScript(() =>
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
);
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const headers = { "X-OpenDirector-Request": "1" };
const json = async (response) => {
  assert.ok(response.ok(), await response.text());
  return response.json();
};
const until = async (read, predicate, label) => {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await page.waitForTimeout(100);
  }
  throw new Error("Timeout: " + label);
};
try {
  assert.equal(
    (
      await json(
        await page.request.get(base + "/api/creation-test-health", { headers }),
      )
    ).isolated,
    true,
  );
  for (const unified of [false, true].filter(
    (value) =>
      !process.env.TOOL_PLACEHOLDER_MODE ||
      (value ? "unified" : "workspace") === process.env.TOOL_PLACEHOLDER_MODE,
  )) {
    const mode = unified ? "?creation=unified" : "";
    const api = unified ? "/api/creation" : "/api";
    const bootstrap = (url) =>
      url.origin === new URL(base).origin && url.pathname === "/";
    await page.route(bootstrap, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><head></head><body></body></html>",
      }),
    );
    await page.goto(base + "/" + mode);
    const fixture = await page.evaluate(async (unified) => {
      const { createDocument, createNode } =
        await import("/src/canvas/model.ts");
      const { importWorkspaceDocument } =
        await import("/src/backend/workspace.ts");
      const { releaseBackendProject } =
        await import("/src/backend/projects.ts");
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 48;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "blue";
      ctx.fillRect(0, 0, 64, 48);
      const source = createNode(
        "image",
        { x: 350, y: 250 },
        {
          title: "Tool source",
          src: canvas.toDataURL(),
          mimeType: "image/png",
          assetState: "ready",
          mediaRole: "asset",
        },
      );
      const value = {
        ...createDocument(
          "SAM compatibility " + crypto.randomUUID().slice(0, 8),
        ),
        nodes: [
          source,
          createNode("video", { x: 1050, y: 350 }, { title: "Video composer" }),
        ],
        viewport: { x: 0, y: 0, zoom: 0.8 },
      };
      const saved = await importWorkspaceDocument(value);
      if (unified)
        (await import("/src/backend/creationClient.ts"))
          .creationClient(saved.id)
          .close();
      await releaseBackendProject();
      return {
        id: saved.id,
        sourceId: source.id,
        videoId: saved.nodes.find((node) => node.type === "video").id,
        name: saved.title,
      };
    }, unified);
    await page.unroute(bootstrap);
    const url = `${base}/ai-tool/ai-canvas/${fixture.id}${mode}`;
    const tasks = async () =>
      (
        await json(
          await page.request.get(
            `${base}${api}/projects/${fixture.id}/tool-tasks`,
            { headers },
          ),
        )
      ).tasks;
    const gate = (open, outcome = "succeeded") =>
      page.request.post(base + "/api/creation-test-tool-gate", {
        headers,
        data: { open, outcome },
      });
    const source = () =>
      page.locator(`.react-flow__node[data-id="${fixture.sourceId}"]`);
    const load = async (hasSource = true) => {
      await page.goto(url);
      await page.getByText("已保存到本机", { exact: true }).waitFor();
      if (hasSource) await source().waitFor();
    };
    await load();
    const health = async () =>
      json(
        await page.request.get(base + "/api/creation-test-health", { headers }),
      );
    const openTool = async (name) => {
      await page.locator(".cw-workspace").focus();
      await page.keyboard.press("Shift+1");
      await page.waitForTimeout(400);
      const box = await source().boundingBox();
      await source().click({
        position: { x: box.width * 0.4, y: box.height * 0.4 },
      });
      await page.getByRole("button", { name, exact: true }).click();
    };
    const pixel = async (id, x, y) =>
      page
        .locator(`.react-flow__node[data-id="${id}"] img`)
        .first()
        .evaluate(
          async (image, { x, y }) => {
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(image, 0, 0);
            return [
              ...ctx.getImageData(
                Math.floor(x * canvas.width),
                Math.floor(y * canvas.height),
                1,
                1,
              ).data,
            ];
          },
          { x, y },
        );
    const before = await page.locator(".react-flow__node").count();
    await openTool("抠图");
    await page
      .locator(".image-action-editor")
      .getByText(/已识别 2 个对象/)
      .waitFor();
    assert.equal(
      await page.locator(".react-flow__node").count(),
      before,
      "preview never creates a node",
    );
    assert.equal((await tasks()).length, 0);
    await page
      .getByRole("button", {
        name: "快速选择：点击对象添加或移除",
        exact: true,
      })
      .click();
    const ink = page.locator(".iae-ink");
    const rect = await ink.boundingBox();
    await ink.click({
      position: { x: rect.width * 0.25, y: rect.height * 0.5 },
    });
    await page.getByText("已移除此对象。", { exact: true }).waitFor();
    await page.getByRole("button", { name: "撤销选区", exact: true }).click();
    await page.getByRole("button", { name: "重做选区", exact: true }).click();
    await page.getByRole("button", { name: "完成抠图", exact: true }).click();
    await page.locator(".image-action-editor").waitFor({ state: "detached" });
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll(".react-flow__node").length === count,
      before + 1,
    );
    const cutout = page
      .locator(".react-flow__node")
      .filter({ hasText: "· 抠图" });
    const cutoutId = await cutout.getAttribute("data-id");
    assert.equal((await pixel(cutoutId, 0.25, 0.5))[3], 0);
    assert.deepEqual(await pixel(cutoutId, 0.75, 0.5), [0, 0, 255, 255]);
    assert.equal(
      (await tasks()).length,
      0,
      "local confirmation creates no paid task",
    );
    await until(
      async () =>
        json(
          await page.request.get(
            `${base}${api}/projects/${fixture.id}${unified ? "" : "/workspace"}`,
            { headers },
          ),
        ),
      (saved) =>
        unified
          ? saved.canvasItems.some(
              (item) => item.id === cutoutId && item.visible,
            )
          : saved.document.nodes.some((node) => node.id === cutoutId),
      "local cutout saved before reload",
    );
    await load();
    assert.equal(
      await page.locator(`.react-flow__node[data-id="${cutoutId}"]`).count(),
      1,
    );
    console.log(
      `PASS ${unified ? "unified" : "workspace"}: owned SAM preview, instance toggles, undo/redo, alpha cutout and reload.`,
    );

    await openTool("抠图");
    await page.getByRole("button", { name: "完成抠图", exact: true }).waitFor();
    await page.waitForFunction(() => {
      const button = document.querySelector(
        'button[aria-label="自动选择主体"]',
      );
      return button && !button.disabled;
    });
    await until(
      health,
      (state) => state.selectionActive === 0,
      "initial recognition completed",
    );
    await page.request.post(base + "/api/creation-test-selection-gate", {
      headers,
      data: { open: false },
    });
    await page
      .getByRole("button", { name: "自动选择主体", exact: true })
      .click();
    await until(
      health,
      (state) => state.selectionActive > 0,
      "selection running",
    );
    await page
      .locator(".iae-selection-status")
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await until(
      health,
      (state) => state.selectionActive === 0,
      "upstream preview cancelled",
    );
    await page.getByRole("button", { name: "选择画笔", exact: true }).click();
    const manual = await page.locator(".iae-ink").boundingBox();
    await page.mouse.move(
      manual.x + manual.width * 0.4,
      manual.y + manual.height * 0.4,
    );
    await page.mouse.down();
    await page.mouse.move(
      manual.x + manual.width * 0.5,
      manual.y + manual.height * 0.5,
      { steps: 4 },
    );
    await page.mouse.up();
    await page.getByRole("button", { name: "撤销选区", exact: true }).click();
    await page
      .locator(".image-action-editor")
      .click({ position: { x: 15, y: 15 } });
    await page.keyboard.press("Escape");
    await page.request.post(base + "/api/creation-test-selection-gate", {
      headers,
      data: { open: true },
    });
    assert.equal((await tasks()).length, 0);
    console.log(
      `PASS ${unified ? "unified" : "workspace"}: cancel releases segmentation; manual edits remain usable.`,
    );

    await openTool("智能改图");
    await page.getByRole("button", { name: "画笔", exact: true }).click();
    const marked = await page.locator(".iae-ink").boundingBox();
    await page.mouse.move(
      marked.x + marked.width * 0.2,
      marked.y + marked.height * 0.3,
    );
    await page.mouse.down();
    await page.mouse.move(
      marked.x + marked.width * 0.7,
      marked.y + marked.height * 0.3,
      { steps: 8 },
    );
    await page.mouse.up();
    await page.getByRole("button", { name: "局部选区", exact: true }).click();
    await page.getByRole("button", { name: "框选识别", exact: true }).click();
    const selected = await page.locator(".iae-ink").boundingBox();
    await page.mouse.move(
      selected.x + selected.width * 0.2,
      selected.y + selected.height * 0.2,
    );
    await page.mouse.down();
    await page.mouse.move(
      selected.x + selected.width * 0.6,
      selected.y + selected.height * 0.7,
      { steps: 8 },
    );
    await page.mouse.up();
    await page
      .locator(".image-action-editor")
      .getByText(/已识别 1 个对象/)
      .waitFor();
    await page
      .getByPlaceholder("描述希望怎样修改这张图片")
      .fill("Make the selected area red");
    const model = (
      await json(
        await page.request.get(base + "/api/model-configs", { headers }),
      )
    ).find((model) => model.modelId === "Qwen/Qwen-Image-2.1");
    await page.getByLabel("编辑模型", { exact: true }).selectOption(model.id);
    await page.locator(".iae-generate").click();
    const result = (
      await until(
        tasks,
        (rows) => rows.length === 1 && rows[0].placement === "placed",
        "annotated edit placed",
      )
    )[0];
    assert.equal(result.modelConfigIds["image.edit"], model.id);
    assert.ok(result.annotationAssetId && result.maskAssetId);
    assert.equal(result.outputs[0].canvasItemId, result.canvas.targetNodeId);
    await page
      .locator(`.react-flow__node[data-id="${result.canvas.targetNodeId}"] img`)
      .waitFor();
    assert.deepEqual(
      await pixel(result.canvas.targetNodeId, 0.05, 0.05),
      [0, 0, 255, 255],
    );
    assert.deepEqual(
      await pixel(result.canvas.targetNodeId, 0.4, 0.4),
      [255, 0, 0, 255],
    );
    const calls = (await health()).imageEditCalls;
    assert.ok(
      calls.some(
        (call) => call.modelId === model.modelId && call.references === 1,
      ),
    );
    await load();
    assert.equal(
      await page
        .locator(`.react-flow__node[data-id="${result.canvas.targetNodeId}"]`)
        .count(),
      1,
    );
    console.log(
      `PASS ${unified ? "unified" : "workspace"}: selected model, annotation reference, exact mask boundary and stable result identity.`,
    );

    const video = page.locator(
      `.react-flow__node[data-id="${fixture.videoId}"]`,
    );
    await page.locator(".cw-workspace").focus();
    await page.keyboard.press("Shift+1");
    await page.waitForTimeout(350);
    await video.click();
    const modes = page.getByLabel("视频创作模式", { exact: true });
    await modes.selectOption("reference");
    await page.locator(".cw-reference-strip").waitFor();
    const referenceHeight = await page
      .locator(".cw-composer")
      .evaluate((element) => element.clientHeight);
    await modes.selectOption("first-last");
    await page.locator(".cw-frame-slots").waitFor();
    assert.equal(
      await page
        .locator(".cw-composer")
        .evaluate((element) => element.clientHeight),
      referenceHeight,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const hasOverflow = await page
      .locator(".cw-composer-footer")
      .evaluate((element) => element.scrollWidth > element.clientWidth + 1);
    assert.equal(hasOverflow, false, "compact footer fits a narrow viewport");
    await page.setViewportSize({ width: 1600, height: 1100 });
    console.log(
      `PASS ${unified ? "unified" : "workspace"}: equal video mode height and compact narrow footer.`,
    );
    await page.evaluate(async () => {
      await (await import("/src/backend/projects.ts")).releaseBackendProject();
    });
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS both project formats: SAM selection, cancellation, local cutout, annotated model editing and compact panel compatibility. Simulated models only.",
  );
} catch (error) {
  await page.screenshot({ path: "/tmp/opendirector-sam-compat-failure.png" });
  console.error((await page.locator("body").innerText()).slice(-2400));
  console.error(errors);
  throw error;
} finally {
  await page.request
    .post(base + "/api/creation-test-selection-gate", {
      headers,
      data: { open: true },
    })
    .catch(() => {});
  await browser.close();
}
