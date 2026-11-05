/** Isolated fixture only: native caret movement, dismissal and asset labels. */
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:8019";
const api = process.env.CREATION_API_URL ?? base;
const projectId = crypto.randomUUID(),
  seedSession = crypto.randomUUID();
const headers = {
  "X-OpenDirector-Request": "1",
  "X-OpenDirector-Session": seedSession,
  "Content-Type": "application/json",
};
async function call(path, body, method = body ? "POST" : "GET") {
  const response = await fetch(api + path, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.ok(
    response.ok,
    `${response.status}: ${await response.clone().text()}`,
  );
  return response.status === 204 ? null : response.json();
}
async function command(type, payload) {
  const result = await call(`/api/creation/projects/${projectId}/commands`, {
    commandId: crypto.randomUUID(),
    projectId,
    type,
    payload,
  });
  assert.equal(result.status, "applied", JSON.stringify(result));
  return result;
}
assert.equal(
  (await call("/api/creation-test-health")).isolated,
  true,
  "Use the isolated fixture API",
);
await command("project.create", {
  name: `Reference picker ${projectId.slice(0, 8)}`,
});
await call(`/api/creation/projects/${projectId}/open`, null, "POST");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGNsYGhgIAUwkaR6VMOohiGlAQBCPQEgiSD+iQAAAABJRU5ErkJggg==",
  "base64",
);
for (let index = 0; index < 3; index++) {
  const name = index < 2 ? "女王.jpg.jpg" : "后台未上画布.png";
  const handle = crypto.randomUUID();
  const upload = await fetch(
    `${api}/api/creation/projects/${projectId}/uploads/${handle}`,
    {
      method: "PUT",
      headers: {
        ...headers,
        "Content-Type": "application/octet-stream",
        "X-Asset-Name": encodeURIComponent(name),
        "X-Asset-Kind": "image",
      },
      body: png,
    },
  );
  assert.ok(upload.ok, await upload.text());
  await command("asset.import", {
    uploadHandle: handle,
    name,
    expectedKind: "image",
  });
}
const initial = await call(`/api/creation/projects/${projectId}`);
const sourceIds = [];
for (let index = 0; index < 3; index++) {
  const asset = initial.assets[index < 2 ? index : 0];
  const id = crypto.randomUUID();
  await command("canvas.show", {
    item: {
      id,
      projectId,
      kind: "image",
      title: index < 2 ? "女王.jpg.jpg" : "隐藏来源副本.jpg.jpg",
      visible: index < 2,
      position: { x: 150 + index * 210, y: 150 },
      width: 160,
      height: 160,
      binding: {
        role: "material",
        objectRef: {
          assetId: asset.id,
          revision: asset.revision,
          fingerprint: asset.fingerprint,
          kind: asset.kind,
        },
      },
    },
  });
  if (index < 2) sourceIds.push(id);
  else {
    const snapshot = await call(`/api/creation/projects/${projectId}`);
    const item = snapshot.canvasItems.find((item) => item.id === id);
    const result = await call(`/api/creation/projects/${projectId}/commands`, {
      commandId: crypto.randomUUID(),
      projectId,
      type: "canvas.hide",
      expectedVersions: [
        { objectType: "canvas_item", id, revision: item.revision },
      ],
      payload: { itemId: id },
    });
    assert.equal(result.status, "applied", JSON.stringify(result));
  }
}
await call(`/api/creation/sessions/${seedSession}`, null, "DELETE");
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
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let browserSession;
  page.on("request", (request) => {
    if (request.url().endsWith(`/projects/${projectId}/commands`))
      browserSession = request.headers()["x-opendirector-session"];
  });
  // Hold the expensive metadata read indefinitely. Canvas candidates and their
  // insertion must work even before it finishes, including the first opening.
  let releaseCatalog;
  const catalogGate = new Promise((resolve) => (releaseCatalog = resolve));
  page.on("close", () => releaseCatalog());
  let catalogReads = 0;
  await page.route("**/reference-catalog", async (route) => {
    catalogReads++;
    await catalogGate;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Fixture catalog unavailable" }),
    });
  });
  const openingTimes = [];
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  const picker = page.getByRole("dialog", {
    name: "引用项目资产",
    exact: true,
  });
  const checked = [];
  const persistedReferences = [];
  for (const kind of ["图片", "视频"]) {
    await page
      .getByRole("toolbar", { name: "画布创作工具" })
      .getByRole("button", { name: `添加${kind}`, exact: true })
      .click();
    const editor = page.getByRole("textbox", {
      name: "生成提示词",
      exact: true,
    });
    const opened = async () => {
      const start = performance.now();
      try {
        await picker.waitFor({ state: "visible" });
      } catch (error) {
        console.error(
          "Picker diagnostic",
          await editor.evaluate((element) => ({
            text: element.textContent,
            focused: document.activeElement === element,
            expanded: element.getAttribute("aria-expanded"),
            anchor: window.getSelection()?.anchorOffset,
            focus: window.getSelection()?.focusOffset,
            html: element.innerHTML,
          })),
        );
        throw error;
      }
      assert.equal(await editor.getAttribute("aria-expanded"), "true");
      await picker.getByRole("option").first().waitFor({ timeout: 1500 });
      assert.equal(await picker.getByRole("status").count(), 0);
      openingTimes.push(Math.round(performance.now() - start));
    };
    const closed = async () => {
      await picker.waitFor({ state: "hidden" });
      assert.equal(await editor.getAttribute("aria-expanded"), "false");
    };
    const caret = () =>
      editor.evaluate((element) => {
        const selection = window.getSelection();
        const range = selection.getRangeAt(0).cloneRange();
        range.selectNodeContents(element);
        range.setEnd(selection.focusNode, selection.focusOffset);
        return range.toString().replaceAll("\u200b", "").length;
      });
    await editor.fill("前@后");
    await editor.press("Home");
    await closed();
    await editor.press("ArrowRight");
    assert.equal(await caret(), 1);
    await closed();
    await editor.press("ArrowRight");
    assert.equal(await caret(), 2);
    await opened();
    await picker
      .getByRole("option", { name: "女王.jpg 图片 · 画布素材", exact: true })
      .first()
      .waitFor();
    assert.equal(
      await picker
        .getByRole("option", { name: "女王.jpg 图片 · 画布素材", exact: true })
        .count(),
      2,
    );
    assert.equal(
      await picker.getByRole("option").count(),
      2,
      "Only the two independent visible sources belong in this picker",
    );
    assert.equal(
      await picker.getByText("女王.jpg.jpg", { exact: true }).count(),
      0,
    );
    // A hovered summary must not consume the editor's picker dismissal.
    const summaryPanel = page.getByRole("tooltip", {
      name: "节点信息",
      exact: true,
    });
    await page.locator(".cw-node-info-trigger").hover();
    await summaryPanel.waitFor();
    await editor.press("Escape");
    await closed();
    assert.equal(await summaryPanel.isVisible(), false);
    await editor.press("ArrowRight");
    assert.equal(await caret(), 3);
    await closed();
    await editor.press("ArrowLeft");
    assert.equal(await caret(), 2);
    await opened();
    // Clicking elsewhere inside the same editor must dismiss the portal too.
    await editor.click({ position: { x: 2, y: 8 } });
    await closed();
    await page.waitForTimeout(100);
    await closed();
    // Selected text and the left side of @ must never trigger the picker.
    await editor.press("End");
    await editor.press("Shift+ArrowLeft");
    await closed();
    await editor.press("Home");
    await editor.press("ArrowRight");
    await closed();
    await editor.press("ArrowRight");
    await opened();
    // Typing a normal character after @ closes; removing it reopens.
    await editor.press("x");
    await closed();
    await editor.press("Backspace");
    await opened();
    await editor.press("Enter");
    try {
      await closed();
    } catch (error) {
      console.error(
        JSON.stringify({
          kind,
          notice: await page
            .locator(".cw-reference-mention-notice")
            .allTextContents(),
          picker: await picker.innerText(),
          editor: await editor.innerText(),
        }),
      );
      throw error;
    }
    await editor.locator("[data-reference]").waitFor();
    assert.equal(
      await editor.locator(".cw-chat-reference-label").textContent(),
      "女王.jpg",
    );
    const reference = await editor
      .locator("[data-reference]")
      .getAttribute("data-reference");
    const part = JSON.parse(reference);
    assert.equal(part.nodeId, sourceIds[0]);
    await page.locator(`.react-flow__edge[data-id]`).first().waitFor();
    // The edge can be optimistic; wait for the server acknowledgement before
    // checking source identity or continuing with further text edits.
    const deadline = Date.now() + 5000;
    let persisted;
    do {
      const saved = await call(`/api/creation/projects/${projectId}`);
      persisted = saved.references.find(
        (ref) => ref.id === part.referenceId && ref.active,
      );
      if (!persisted) await new Promise((resolve) => setTimeout(resolve, 100));
    } while (!persisted && Date.now() < deadline);
    assert.ok(persisted, "Choosing a canvas source must persist its reference");
    assert.equal(persisted.source.id, sourceIds[0]);
    persistedReferences.push(persisted.id);
    const sizes = await editor.evaluate((element) => {
      const input = getComputedStyle(element);
      const chip = element.querySelector("[data-reference]");
      const thumbnail = chip.querySelector("img");
      return {
        font: input.fontSize,
        sidebarFont: getComputedStyle(document.querySelector(".cw-rail-label"))
          .fontSize,
        lineHeight: parseFloat(input.lineHeight),
        chipHeight: chip.getBoundingClientRect().height,
        thumbnailHeight: thumbnail.getBoundingClientRect().height,
      };
    });
    assert.equal(sizes.font, sizes.sidebarFont);
    assert.ok(sizes.chipHeight <= sizes.lineHeight, JSON.stringify(sizes));
    assert.ok(sizes.thumbnailHeight <= sizes.lineHeight, JSON.stringify(sizes));
    await page.getByRole("button", { name: "展开会话框", exact: true }).click();
    assert.equal(
      await editor.locator("[data-reference]").getAttribute("data-reference"),
      reference,
    );
    await page.getByRole("button", { name: "收起会话框", exact: true }).click();
    assert.equal(
      await editor.locator("[data-reference]").getAttribute("data-reference"),
      reference,
    );
    // Atomic reference chips occupy one editing position, including in new lines.
    await editor.press("End");
    await editor.press("Enter");
    await editor.pressSequentially("中文@尾");
    await closed();
    await editor.press("ArrowLeft");
    await opened();
    await editor.press("Escape");
    await editor.press("ArrowLeft");
    await closed();
    checked.push(kind);
  }
  assert.equal(catalogReads, 1, "Reopening must not restart the prefetch");
  const failedCatalog = page.waitForResponse("**/reference-catalog");
  releaseCatalog();
  await failedCatalog;
  // Failure of optional metadata must not disable local references either.
  const editor = page.getByRole("textbox", { name: "生成提示词", exact: true });
  await editor.press("End");
  await editor.press("@");
  await picker.getByRole("option").first().waitFor({ timeout: 1500 });
  assert.equal(await picker.getByRole("alert").count(), 0);
  await editor.press("Escape");
  assert.equal(catalogReads, 1);
  const snapshot = await call(`/api/creation/projects/${projectId}`);
  assert.equal(snapshot.assets.length, 3);
  assert.equal(
    snapshot.assets.filter((asset) => asset.name === "女王.jpg.jpg").length,
    2,
  );
  assert.equal(persistedReferences.length, 2);
  // Changes to the live canvas must appear without refreshing the catalog.
  assert.ok(browserSession);
  const mutate = async (type, payload, expectedVersions = []) => {
    const response = await fetch(
      `${api}/api/creation/projects/${projectId}/commands`,
      {
        method: "POST",
        headers: { ...headers, "X-OpenDirector-Session": browserSession },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          projectId,
          type,
          payload,
          expectedVersions,
        }),
      },
    );
    assert.ok(response.ok, await response.clone().text());
    const receipt = await response.json();
    assert.equal(receipt.status, "applied", JSON.stringify(receipt));
  };
  const removed = snapshot.canvasItems.find((item) => item.id === sourceIds[0]);
  await mutate("canvas.hide", { itemId: removed.id }, [
    { objectType: "canvas_item", id: removed.id, revision: removed.revision },
  ]);
  await page.locator(`.react-flow__node[data-id="${removed.id}"]`).waitFor({
    state: "hidden",
  });
  await editor.fill("新素材 @");
  await picker.getByRole("option").first().waitFor({ timeout: 1500 });
  assert.equal(await picker.getByRole("option").count(), 1);
  const addedId = crypto.randomUUID();
  const asset = snapshot.assets[0];
  await mutate("canvas.show", {
    item: {
      id: addedId,
      projectId,
      kind: "image",
      title: "新加入.png",
      visible: true,
      position: { x: 500, y: 500 },
      width: 160,
      height: 160,
      binding: {
        role: "material",
        objectRef: {
          assetId: asset.id,
          revision: asset.revision,
          fingerprint: asset.fingerprint,
          kind: asset.kind,
        },
      },
    },
  });
  await picker
    .getByRole("option", { name: "新加入.png 图片 · 画布素材", exact: true })
    .waitFor();
  assert.equal(await picker.getByRole("option").count(), 2);
  assert.equal(
    catalogReads,
    1,
    "Canvas changes must not require a catalog read",
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      isolated: true,
      editors: checked,
      correctCaretBoundary: true,
      pointerDismissal: true,
      typedCharacterDismissal: true,
      atomicReferences: true,
      normalizedLabels: true,
      independentAssetsPreserved: true,
      persistedReferences: persistedReferences.length,
      catalogReadIndependent: true,
      catalogReads,
      liveCanvasChanges: true,
      openingCheckMs: openingTimes,
      errors,
    }),
  );
} finally {
  await browser.close();
}
