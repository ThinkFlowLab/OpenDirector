/** Stack/tool/director edits must await the same authoritative editor receipt. */
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
  args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
// Skip the first-run model setup welcome; it covers the canvas.
await page.addInitScript(() =>
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
);
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  assert.equal(
    (
      await (
        await page.request.get(base + "/api/creation-test-health", {
          headers: { "X-OpenDirector-Request": "1" },
        })
      ).json()
    ).isolated,
    true,
  );
  const bootstrap = (url) =>
    url.origin === new URL(base).origin && url.pathname === "/";
  await page.route(bootstrap, (r) =>
    r.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }),
  );
  await page.goto(base + "/");
  const f = await page.evaluate(async () => {
    const { createDocument, createNode } = await import("/src/canvas/model.ts");
    const { stackSelection } = await import("/src/canvas/operations.ts");
    const { createLocalStage } = await import("/src/canvas/stageDocument.ts");
    const { importWorkspaceDocument } =
      await import("/src/backend/workspace.ts");
    const a = createNode("text", { x: 100, y: 150 }, { text: "A", title: "A" }),
      b = createNode("text", { x: 500, y: 150 }, { text: "B", title: "B" });
    const tool = createNode(
      "tool",
      { x: 800, y: 150 },
      {
        title: "Acceptance tool",
        tool: { kind: "camera", fields: [{ name: "lens", values: ["35mm"] }] },
      },
    );
    const stage = createNode(
      "external",
      { x: 1200, y: 150 },
      { title: "Acceptance stage", localStage: createLocalStage() },
    );
    const document = stackSelection(
      {
        ...createDocument(
          "Structured editors " + crypto.randomUUID().slice(0, 8),
        ),
        nodes: [a, b, tool, stage],
      },
      [a.id, b.id],
    );
    const saved = await importWorkspaceDocument(document);
    (await import("/src/backend/creationClient.ts"))
      .creationClient(saved.id)
      .close();
    await (await import("/src/backend/projects.ts")).releaseBackendProject();
    return {
      id: saved.id,
      tool: tool.id,
      stage: stage.id,
      stack: document.nodes.at(-1).id,
    };
  });
  await page.unroute(bootstrap);
  const url = base + `/ai-tool/ai-canvas/${f.id}`;
  const state = async () =>
    await (
      await page.request.get(base + `/api/creation/projects/${f.id}`, {
        headers: { "X-OpenDirector-Request": "1" },
      })
    ).json();
  const saved = () => page.getByText("已保存到本机", { exact: true }).waitFor();
  async function open(id) {
    await page.locator(".cw-workspace").focus();
    await page.keyboard.press("Shift+1");
    await page.waitForTimeout(400);
    await page
      .locator(`.react-flow__node[data-id="${id}"] .cw-node-title`)
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "打开编辑器", exact: true })
      .click();
    await page.getByRole("button", { name: "应用编辑", exact: true }).waitFor();
  }
  await page.goto(url);
  await saved();
  for (const kind of ["tool", "stack", "stage"]) {
    await open(f[kind]);
    if (kind === "tool")
      await page.locator(".cw-tool-field textarea").fill("50mm\n85mm");
    if (kind === "stack")
      await page
        .getByRole("button", { name: "下一个堆叠资源", exact: true })
        .click();
    if (kind === "stage")
      await page.getByLabel("机位名称", { exact: true }).fill("Saved camera");
    const before = await state();
    let blocked = true;
    const route = async (r) => {
      const body = r.request().postDataJSON();
      if (
        blocked &&
        body.payload?.operations?.some((op) => op.type === "editor.save")
      )
        return r.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({ detail: "fixture: structured save rejected" }),
        });
      return r.continue();
    };
    await page.route("**/commands", route);
    await page.getByRole("button", { name: "应用编辑", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({ hasText: "fixture: structured save rejected" })
      .waitFor();
    assert.deepEqual((await state()).editorDocuments, before.editorDocuments);
    assert.equal(
      await page.getByRole("button", { name: "应用编辑", exact: true }).count(),
      1,
    );
    blocked = false;
    await page.getByRole("button", { name: "应用编辑", exact: true }).click();
    await page.locator(".cw-domain-dialog").waitFor({ state: "hidden" });
    await saved();
    await page.unroute("**/commands", route);
    const committed = await state();
    assert.notDeepEqual(committed.editorDocuments, before.editorDocuments);
    await page.reload();
    await saved();
    await open(f[kind]);
    if (kind === "tool")
      assert.equal(
        await page.locator(".cw-tool-field textarea").inputValue(),
        "50mm\n85mm",
      );
    if (kind === "stack")
      assert.equal(
        committed.editorDocuments.find((d) => d.kind === "stack").data
          .activeIndex,
        1,
      );
    if (kind === "stage")
      assert.equal(
        await page.getByLabel("机位名称", { exact: true }).inputValue(),
        "Saved camera",
      );
    assert.deepEqual(
      (await state()).editorDocuments,
      committed.editorDocuments,
    );
    await page.getByRole("button", { name: "关闭编辑器", exact: true }).click();
    console.log(
      `PASS ${kind}: rejected save retains draft; acknowledged retry survives reload with editable structure`,
    );
  }
  if (process.argv.includes("--publish")) {
    await open(f.stage);
    await page.getByLabel("舞台总时长", { exact: true }).fill("0.5");
    await page
      .getByRole("button", { name: "合成预演 MP4", exact: true })
      .click();
    await page
      .getByRole("button", { name: "将预演视频加入画布", exact: true })
      .waitFor({ timeout: 60000 });
    const before = await state();
    let reject = true;
    const route = async (r) => {
      if (reject && r.request().postDataJSON().type === "canvas.publishMedia")
        return r.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({
            detail: "fixture: stage publication refused",
          }),
        });
      return r.continue();
    };
    await page.route("**/commands", route);
    await page
      .getByRole("button", { name: "将预演视频加入画布", exact: true })
      .click();
    await page.getByRole("alert").waitFor();
    assert.equal((await state()).canvasItems.length, before.canvasItems.length);
    reject = false;
    await page
      .getByRole("button", { name: "将预演视频加入画布", exact: true })
      .click();
    await page
      .getByRole("button", { name: "已加入画布", exact: true })
      .waitFor();
    await page.unroute("**/commands", route);
    const after = await state();
    const output = after.assets.find(
      (a) => a.provenance.sourceItemId === f.stage,
    );
    assert.ok(output);
    assert.equal(output.provenance.source, "rendered");
    assert.ok(Math.abs(output.metadata.durationSeconds - 0.5) < 0.15);
    const frozen = after.editorDocuments.find(
      (d) => d.id === output.provenance.editorDocumentId,
    );
    assert.equal(frozen.kind, "director");
    assert.equal(frozen.data.duration, 0.5);
    await page.reload();
    await saved();
    assert.deepEqual(
      (await state()).assets.find((a) => a.id === output.id),
      output,
    );
    console.log(
      "PASS director real MP4: confirmed stage snapshot, rejection retains rendered output, retry and reopen preserve provenance",
    );
  }
  await open(f.stack);
  let rejectDissolve = true;
  const dissolveRoute = async (route) => {
    if (
      rejectDissolve &&
      route
        .request()
        .postDataJSON()
        .payload?.operations?.some(
          (op) => op.type === "canvas.hide" && op.payload.itemId === f.stack,
        )
    )
      return route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ detail: "fixture: dissolve refused" }),
      });
    return route.continue();
  };
  await page.route("**/commands", dissolveRoute);
  await page
    .getByRole("button", { name: "解散堆叠，保留全部节点", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "fixture: dissolve refused" })
    .waitFor();
  assert.equal(
    (await state()).canvasItems.find((i) => i.id === f.stack).visible,
    true,
  );
  rejectDissolve = false;
  await page
    .getByRole("button", { name: "解散堆叠，保留全部节点", exact: true })
    .click();
  await page.locator(".cw-domain-dialog").waitFor({ state: "hidden" });
  await saved();
  await page.unroute("**/commands", dissolveRoute);
  const dissolved = await state();
  assert.equal(
    dissolved.canvasItems.find((i) => i.id === f.stack).visible,
    false,
  );
  assert.equal(
    dissolved.canvasItems.filter((i) => i.kind === "text" && i.visible).length,
    2,
  );
  console.log(
    "PASS stack dissolution: refusal retains editor; retry releases original members atomically",
  );
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, projectId: f.id }));
} catch (error) {
  console.error((await page.locator("body").innerText()).slice(-2500));
  throw error;
} finally {
  await browser.close();
}
