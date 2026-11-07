/** Real UI copy/paste and history against an isolated creation server. */
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
});
try {
  const page = await browser.newPage({
    locale: "zh-CN",
    viewport: { width: 1500, height: 1000 },
  });
  // Skip the first-run model setup welcome; it covers the canvas.
  await page.addInitScript(() =>
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
  );
  page.setDefaultTimeout(15000);
  const headers = { "X-OpenDirector-Request": "1" };
  const errors = [],
    failed = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.url().includes("/api/creation/") && response.status() >= 400)
      failed.push(`${response.status()} ${response.url()}`);
  });
  assert.equal(
    (
      await (
        await page.request.get(base + "/api/creation-test-health", { headers })
      ).json()
    ).isolated,
    true,
  );
  const projectId = crypto.randomUUID();
  const created = await page.request.post(
    `${base}/api/creation/projects/${projectId}/commands`,
    {
      headers,
      data: {
        type: "project.create",
        projectId,
        commandId: crypto.randomUUID(),
        payload: { name: "History test " + projectId.slice(0, 8) },
      },
    },
  );
  assert.equal(created.status(), 200);
  await page.goto(`${base}/ai-canvas/${projectId}`);
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  const project = (
    await (
      await page.request.get(base + "/api/creation/projects", { headers })
    ).json()
  ).projects.find((item) => item.id === projectId);
  const path = base + "/api/creation/projects/" + project.id;
  const state = async () => (await page.request.get(path, { headers })).json();
  async function until(read) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const value = await read();
      if (value) return value;
      await page.waitForTimeout(80);
    }
    throw new Error("History state did not settle");
  }
  const shown = (snapshot) =>
    snapshot.canvasItems.filter((item) => item.visible);
  async function count(value) {
    const snapshot = await until(async () => {
      const s = await state();
      return shown(s).length === value && s;
    });
    await until(
      async () => (await page.locator(".react-flow__node").count()) === value,
    );
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    return snapshot;
  }
  await page
    .getByRole("toolbar", { name: "画布创作工具" })
    .getByRole("button", { name: "添加文本", exact: true })
    .click();
  const original = (await count(1)).canvasItems[0];
  await page
    .locator(`.react-flow__node[data-id="${original.id}"] .cw-node-title`)
    .click();
  const workspace = page.locator(".cw-workspace");
  await workspace.focus();
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  const two = await count(2);
  await workspace.focus();
  await page.keyboard.press("Control+v");
  const three = await count(3);
  const undo = page.getByRole("button", { name: "撤销", exact: true });
  const redo = page.getByRole("button", { name: "重做", exact: true });
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const held = new Promise((resolve) => {
    started = resolve;
  });
  let hold = true;
  await page.route(/\/commands$/, async (route) => {
    if (hold && route.request().postDataJSON().type === "history.undo") {
      hold = false;
      started();
      await gate;
    }
    await route.continue();
  });
  await undo.click();
  await held;
  assert.equal(await undo.isDisabled(), true);
  await workspace.focus();
  await page.keyboard.press("Control+z");
  release();
  await count(1);
  await until(() => redo.isEnabled());
  await redo.click();
  const firstRedo = await count(2);
  assert.deepEqual(
    shown(firstRedo)
      .map((item) => item.id)
      .sort(),
    shown(two)
      .map((item) => item.id)
      .sort(),
  );
  await until(() => redo.isEnabled());
  await redo.click();
  const secondRedo = await count(3);
  assert.deepEqual(
    shown(secondRedo)
      .map((item) => item.id)
      .sort(),
    shown(three)
      .map((item) => item.id)
      .sort(),
  );
  await until(() => undo.isEnabled());
  await undo.click();
  await count(2);
  // A new paste after undo starts a fresh branch.
  await workspace.focus();
  await page.keyboard.press("Control+v");
  await count(3);
  await until(() => redo.isDisabled());
  const history = await (
    await page.request.get(path + "/history", { headers })
  ).json();
  assert.equal(
    history.some((entry) => entry.state === "undone"),
    false,
  );
  await page.getByLabel("选择本地素材文件", { exact: true }).setInputFiles({
    name: "history-source.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGNsYGhgIAUwkaR6VMOohiGlAQBCPQEgiSD+iQAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  const uploaded = await count(4);
  const image = shown(uploaded).find((item) => item.kind === "image");
  assert.ok(image);
  const assetId = image.binding.objectRef.assetId;
  await page
    .locator(`.react-flow__node[data-id="${image.id}"] .cw-node-title`)
    .click();
  await workspace.focus();
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  const copiedImage = await count(5);
  assert.equal(copiedImage.assets.length, uploaded.assets.length);
  const images = shown(copiedImage).filter((item) => item.kind === "image");
  assert.equal(images.length, 2);
  assert.ok(images.every((item) => item.binding.objectRef.assetId === assetId));
  await until(() => undo.isEnabled());
  await undo.click();
  assert.equal((await count(4)).assets.length, uploaded.assets.length);
  await until(() => redo.isEnabled());
  await redo.click();
  assert.equal((await count(5)).assets.length, uploaded.assets.length);
  await page.reload();
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  await count(5);
  assert.deepEqual(errors, []);
  assert.deepEqual(failed, []);
  console.log(
    JSON.stringify({
      copyPaste: true,
      consecutiveUndoRedo: true,
      undoInFlightGuard: true,
      redoBranchCleared: true,
      mediaAssetReused: true,
      reopen: true,
      errors,
      failed,
    }),
  );
} finally {
  await browser.close();
}
