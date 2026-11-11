import { spawnOwned as spawn, stopOwned, pythonExecutable, sourcePythonPath } from "./host.mjs";
/** Real isolated UI / editor.save / Agent / reopen acceptance for timed text. */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser } from "./engine.mjs";
const root = await mkdtemp(join(tmpdir(), "opendirector-creation-text-edit-"));
const apiPort = process.env.TEXT_EDIT_API_PORT ?? "8047",
  webPort = process.env.TEXT_EDIT_WEB_PORT ?? "5197";
const api = `http://127.0.0.1:${apiPort}`,
  base = `http://127.0.0.1:${webPort}`;
let server,
  web,
  browser,
  logs = "";
function run(command, args, env = {}) {
  const p = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", (d) => (logs += d));
  p.stderr.on("data", (d) => (logs += d));
  return p;
}
async function until(check) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(logs.slice(-1500));
}
async function stop(p) {
  await stopOwned(p);
}
function start() {
  return run(
    pythonExecutable(),
    ["tests/browser/creation_server.py", "--port", apiPort, "--root", root],
    { PYTHONPATH: sourcePythonPath() },
  );
}
try {
  server = start();
  await until(
    async () =>
      (
        await fetch(api + "/api/creation-test-health", {
          headers: { "X-OpenDirector-Request": "1" },
        })
      ).ok,
  );
  web = run(
    "node",
    [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      webPort,
      "--strictPort",
    ],
    { OPENDIRECTOR_API_URL: api },
  );
  await until(async () => (await fetch(base)).ok);
  browser = await launchBrowser();
  const page = await browser.newPage({
    viewport: { width: 1700, height: 1100 },
  });
  page.setDefaultTimeout(30000);
  globalThis.debugPage = page;
  const errors = [];
  page.on("pageerror", (e) => { errors.push(e.message); console.error("PAGE ERROR", e.message); });
  await page.addInitScript(() => {
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    localStorage.setItem("opendirector.locale.v1", "en-US");
  });
  const bootstrap = (u) =>
    u.origin === new URL(base).origin && u.pathname === "/";
  await page.route(bootstrap, (r) =>
    r.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }),
  );
  await page.goto(base + "/");
  const f = await page.evaluate(async () => {
    const { createDocument, createNode } = await import("/src/canvas/model.ts");
    const { importWorkspaceDocument } =
      await import("/src/backend/workspace.ts");
    const n = createNode(
      "timeline",
      { x: 100, y: 100 },
      { title: "Text acceptance" },
    );
    n.data.timeline.tracks[0].title = "";
    const source = createNode(
      "text",
      { x: 700, y: 100 },
      { title: "Plain text source", text: "来源正文 Source" },
    );
    const saved = await importWorkspaceDocument({
      ...createDocument("Text UI " + crypto.randomUUID().slice(0, 8)),
      nodes: [n, source],
    });
    (await import("/src/backend/creationClient.ts"))
      .creationClient(saved.id)
      .close();
    await (await import("/src/backend/projects.ts")).releaseBackendProject();
    return { id: saved.id, item: n.id };
  });
  await page.unroute(bootstrap);
  const url = base + `/ai-tool/ai-canvas/${f.id}`;
  const state = async () =>
    await (
      await page.request.get(base + `/api/creation/projects/${f.id}`, {
        headers: { "X-OpenDirector-Request": "1" },
      })
    ).json();
  async function open() {
    await page.locator(".cw-workspace").focus();
    await page.keyboard.press("Shift+1");
    await page.waitForTimeout(250);
    await page
      .locator(`.react-flow__node[data-id="${f.item}"] .cw-node-title`)
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: /Open editor|打开编辑器/, exact: true })
      .click();
    await page.locator(".cw-timeline-dialog").waitFor();
  }
  await page.goto(url);
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await open();
  await page.getByRole("button", { name: "Add text", exact: true }).click();
  assert.equal(
    await page.getByLabel("Vertical position", { exact: true }).inputValue(),
    "0.82",
  );
  assert.equal(
    await page.getByLabel("Font size (px)", { exact: true }).inputValue(),
    "54",
  );
  assert.equal(
    await page.getByLabel("Background", { exact: true }).isChecked(),
    true,
  );
  assert.equal(
    await page.getByLabel("Background opacity", { exact: true }).inputValue(),
    "0.5",
  );
  console.log("STAGE created");
  const content = page.getByLabel("Text content", { exact: true });
  await content.waitFor();
  await content.dispatchEvent("compositionstart");
  await content.fill("你好 OpenDirector\n第二行");
  await content.dispatchEvent("compositionend", {
    data: "你好 OpenDirector\n第二行",
  });
  await content.blur();
  await page
    .locator(".cw-timeline-dialog")
    .getByRole("button", { name: "Undo", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector(".cw-timeline-text-inspector textarea")?.value ===
      "Text",
  );
  assert.equal(await content.inputValue(), "Text");
  await page
    .locator(".cw-timeline-dialog")
    .getByRole("button", { name: "Redo", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector(".cw-timeline-text-inspector textarea")?.value ===
      "你好 OpenDirector\n第二行",
  );
  console.log("STAGE undo-redo");
  assert.equal(await content.inputValue(), "你好 OpenDirector\n第二行");
  await page.getByLabel("Start (s)", { exact: true }).fill("1");
  await page.getByLabel("End (s)", { exact: true }).fill("4");
  const screen = await page.locator(".cw-timeline-screen").boundingBox();
  assert.ok(
    Math.abs(screen.width / screen.height - 16 / 9) < 0.01,
    "preview preserves output aspect ratio",
  );
  const undo = page
    .locator(".cw-timeline-dialog")
    .getByRole("button", { name: "Undo", exact: true });
  async function drag(locator, dx, dy = 0, cancel = false, preview = null) {
    const b = await locator.boundingBox();
    const before = await page.locator('.cw-timeline-text-item').boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      b.x + b.width / 2 + dx / 2,
      b.y + b.height / 2 + dy / 2,
    );
    await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy);
    if (preview) {
      // Assert while the pointer is still held: release-only jumps are wrong.
      await page.waitForFunction(({ x, width }) => {
        const rect = document.querySelector('.cw-timeline-text-item').getBoundingClientRect();
        return Math.abs(rect.x - x) < 2 && Math.abs(rect.width - width) < 2;
      }, {
        x: before.x + (preview === 'end' ? 0 : dx),
        width: before.width + (preview === 'move' ? 0 : preview === 'start' ? -dx : dx),
      }, { timeout: 3000 });
    }
    if (cancel) await page.keyboard.press("Escape");
    await page.mouse.up();
    if (cancel && preview) {
      const after = await page.locator('.cw-timeline-text-item').boundingBox();
      assert(Math.abs(after.x - before.x) < 2 && Math.abs(after.width - before.width) < 2);
    }
  }
  await drag(page.locator(".cw-timeline-text-move"), 20, 0, false, 'move');
  assert.equal(
    await page.getByLabel("Start (s)", { exact: true }).inputValue(),
    "1.5",
  );
  assert.equal(
    await page.getByLabel("End (s)", { exact: true }).inputValue(),
    "4.5",
  );
  await undo.click();
  assert.equal(
    await page.getByLabel("Start (s)", { exact: true }).inputValue(),
    "1",
  );
  await drag(
    page.getByRole("button", { name: "Adjust text end", exact: true }),
    40, 0, false, 'end',
  );
  assert.equal(
    await page.getByLabel("End (s)", { exact: true }).inputValue(),
    "5",
  );
  await undo.click();
  assert.equal(
    await page.getByLabel("End (s)", { exact: true }).inputValue(),
    "4",
  );
  await drag(page.getByRole('button', { name: 'Adjust text start', exact: true }), 20, 0, false, 'start');
  assert.equal(await page.getByLabel('Start (s)', { exact: true }).inputValue(), '1.5');
  assert.equal(await page.getByLabel('End (s)', { exact: true }).inputValue(), '4');
  await undo.click();
  assert.equal(await page.getByLabel('Start (s)', { exact: true }).inputValue(), '1');
  const seek = page.getByRole("slider", {
    name: "Timeline playhead",
    exact: true,
  });
  await seek.press("End");
  await seek.press("ArrowLeft");
  await drag(
    page.getByRole("button", { name: /^Drag text position:/ }),
    30,
    -20,
  );
  assert.notEqual(
    await page.getByLabel("Horizontal position", { exact: true }).inputValue(),
    "0.1",
  );
  await undo.click();
  assert.equal(
    await page.getByLabel("Horizontal position", { exact: true }).inputValue(),
    "0.1",
  );
  await drag(page.locator(".cw-timeline-text-move"), 40, 0, true, 'move');
  assert.equal(
    await page.getByLabel("Start (s)", { exact: true }).inputValue(),
    "1",
  );
  assert.equal(await page.locator(".cw-timeline-dialog").count(), 1);
  await page.getByRole("button", { name: "Apply edits", exact: true }).click();
  await page.locator(".cw-timeline-dialog").waitFor({ state: "hidden" });
  console.log("STAGE first saved");
  let s = await state(),
    editor = s.editorDocuments.find((d) => d.kind === "timeline");
  assert.equal(editor.data.overlays[0].text, "你好 OpenDirector\n第二行");
  assert.equal(editor.data.overlays[0].start, 1);
  assert.ok(editor.data.fonts[0].asset.assetId);
  const originalId = editor.data.overlays[0].id;
  // A clean open panel refreshes from the same public editor.save command.
  await open();
  await page.locator(".cw-timeline-text-move").click();
  await page.evaluate(
    async ({ pid, editor }) => {
      const { request, json } = await import("/src/backend/api.ts");
      const changed = structuredClone(editor);
      changed.data.overlays[0].text = "Agent 修改";
      const receipt = await request(
        `/creation/projects/${pid}/commands`,
        json("POST", {
          projectId: pid,
          commandId: crypto.randomUUID(),
          type: "editor.save",
          expectedVersions: [
            {
              objectType: "editor_document",
              id: editor.id,
              revision: editor.revision,
            },
          ],
          payload: { document: changed },
        }),
      );
      if (receipt.status !== "applied") throw Error(JSON.stringify(receipt));
      await (await import("/src/backend/creationClient.ts"))
        .creationClient(pid)
        .refresh();
    },
    { pid: f.id, editor },
  );
  console.log("STAGE agent saved");
  await page.waitForFunction(
    () =>
      document.querySelector(".cw-timeline-text-inspector textarea")?.value ===
      "Agent 修改",
  );
  assert.equal(await content.inputValue(), "Agent 修改");
  await content.fill("UI 接续");
  await content.blur();
  await page.getByRole("button", { name: "Apply edits", exact: true }).click();
  await page.locator(".cw-timeline-dialog").waitFor({ state: "hidden" });
  s = await state();
  editor = s.editorDocuments.find((d) => d.kind === "timeline");
  assert.equal(editor.data.overlays[0].id, originalId);
  assert.equal(editor.data.overlays[0].text, "UI 接续");
  await stop(server);
  server = start();
  await until(
    async () =>
      (
        await fetch(api + "/api/creation-test-health", {
          headers: { "X-OpenDirector-Request": "1" },
        })
      ).ok,
  );
  await page.reload();
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await open();
  await page.locator(".cw-timeline-text-item").click();
  assert.equal(await content.inputValue(), "UI 接续");
  await page.screenshot({ path: join(root, "text-ui-en.png") });
  await content.fill(" ");
  assert.equal(
    await page
      .getByRole("button", { name: "Apply edits", exact: true })
      .isDisabled(),
    true,
    "invalid uncommitted body cannot silently save the previous text",
  );
  await content.fill("UI 接续");
  await content.blur();
  for (const name of ["Export FCPXML", "XML + media ZIP"]) {
    const button = page.getByRole("button", { name, exact: true });
    assert.equal(await button.isDisabled(), true, `${name} cannot retain editable text`);
    assert.match(await button.getAttribute("title"), /editable package.*MP4/);
  }
  assert.equal(await page.getByText("FCPXML and XML + media ZIP cannot retain text or fonts. Use an editable package to continue editing, or MP4 for the rendered video.", { exact: true }).isVisible(), true);
  const exportNames = [
    "Render MP4",
    "Export editable JSON",
    "Export FCPXML",
    "XML + media ZIP",
    "Export editable package",
  ];
  await content.fill(" ");
  let invalidCommands = 0,
    invalidDownloads = 0;
  const trackInvalidRequest = (request) => {
    if (request.url().endsWith("/commands") && request.method() === "POST")
      invalidCommands++;
  };
  const trackInvalidDownload = () => invalidDownloads++;
  page.on("request", trackInvalidRequest);
  page.on("download", trackInvalidDownload);
  for (const name of exportNames) {
    const button = page.getByRole("button", { name, exact: true });
    assert.equal(
      await button.isDisabled(),
      true,
      `${name} must reject invalid pending text`,
    );
    await button.evaluate((button) => button.click());
  }
  await page.waitForTimeout(150);
  assert.equal(invalidCommands, 0);
  assert.equal(invalidDownloads, 0);
  assert.equal(await content.inputValue(), " ");
  page.off("request", trackInvalidRequest);
  page.off("download", trackInvalidDownload);
  await content.fill("UI 接续");
  await content.blur();
  // Uncommitted input survives a concurrent writer; formal save uses its original basis.
  await content.fill("Uncommitted draft");
  async function agentText(text, patch = {}) {
    return page.evaluate(
      async ({ pid, text, patch }) => {
        const { request, json } = await import("/src/backend/api.ts");
        const s = await request(`/creation/projects/${pid}`),
          d = s.editorDocuments.find((d) => d.kind === "timeline");
        const next = structuredClone(d);
        Object.assign(next.data.overlays[0], patch, { text });
        const r = await request(
          `/creation/projects/${pid}/commands`,
          json("POST", {
            projectId: pid,
            commandId: crypto.randomUUID(),
            type: "editor.save",
            expectedVersions: [
              { objectType: "editor_document", id: d.id, revision: d.revision },
            ],
            payload: { document: next },
          }),
        );
        if (r.status !== "applied") throw Error(JSON.stringify(r));
        await (await import("/src/backend/creationClient.ts"))
          .creationClient(pid)
          .refresh();
      },
      { pid: f.id, text, patch },
    );
  }
  await agentText("Remote version");
  await page
    .getByText(/^The project changed while this draft was open/)
    .waitFor();
  assert.equal(await content.inputValue(), "Uncommitted draft");
  await page.getByRole("button", { name: "Apply edits", exact: true }).click();
  await page.locator('.cw-timeline-dialog [role="alert"]').waitFor();
  assert.equal(await content.inputValue(), "Uncommitted draft");
  assert.equal(
    (await state()).editorDocuments.find((d) => d.kind === "timeline").data
      .overlays[0].text,
    "Remote version",
  );
  await page
    .locator(".cw-timeline-dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await open();
  await page.locator(".cw-timeline-text-move").click();
  assert.equal(await content.inputValue(), "Remote version");
  async function lock(value) {
    await page.evaluate(
      async ({ pid, item, value }) => {
        const { request, json } = await import("/src/backend/api.ts");
        const s = await request(`/creation/projects/${pid}`),
          i = s.canvasItems.find((i) => i.id === item);
        const r = await request(
          `/creation/projects/${pid}/commands`,
          json("POST", {
            projectId: pid,
            commandId: crypto.randomUUID(),
            type: "canvas.update",
            expectedVersions: [
              { objectType: "canvas_item", id: item, revision: i.revision },
            ],
            payload: { itemId: item, locked: value },
          }),
        );
        if (r.status !== "applied") throw Error(JSON.stringify(r));
        await (await import("/src/backend/creationClient.ts"))
          .creationClient(pid)
          .refresh();
      },
      { pid: f.id, item: f.item, value },
    );
  }
  await content.fill("Locked draft");
  await content.blur();
  await lock(true);
  await page.getByRole("button", { name: "Apply edits", exact: true }).click();
  await page.locator('.cw-timeline-dialog [role="alert"]').waitFor();
  assert.equal(await content.inputValue(), "Locked draft");
  await lock(false);
  await page
    .locator(".cw-timeline-dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await open();
  await page.locator(".cw-timeline-text-move").click();
  // Agent saves between pointer-down and pointer-up retain the gesture's original basis.
  const gestureBox = await page.locator(".cw-timeline-text-move").boundingBox();
  await page.mouse.move(
    gestureBox.x + gestureBox.width / 2,
    gestureBox.y + gestureBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    gestureBox.x + gestureBox.width / 2 + 20,
    gestureBox.y + gestureBox.height / 2,
  );
  await agentText("Gesture remote", { start: 2, end: 6 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Apply edits", exact: true }).click();
  await page
    .locator('.cw-timeline-dialog [role="alert"]')
    .waitFor({ timeout: 5000 });
  const remoteGesture = (await state()).editorDocuments.find(
    (d) => d.kind === "timeline",
  ).data.overlays[0];
  assert.equal(remoteGesture.text, "Gesture remote");
  assert.equal(remoteGesture.start, 2);
  assert.equal(remoteGesture.end, 6);
  assert.equal(
    await page.getByLabel("Start (s)", { exact: true }).inputValue(),
    "1.5",
  );
  await page
    .locator(".cw-timeline-dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await open();
  await page.locator(".cw-timeline-text-move").click();
  // Cancelling a pending gesture restores clean refresh and does not retain history.
  const cancelBox = await page.locator(".cw-timeline-text-move").boundingBox();
  await page.mouse.move(
    cancelBox.x + cancelBox.width / 2,
    cancelBox.y + cancelBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    cancelBox.x + cancelBox.width / 2 + 20,
    cancelBox.y + cancelBox.height / 2,
  );
  await agentText("Cancelled remote", { start: 3, end: 7 });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.waitForFunction(
    () =>
      document.querySelector(".cw-timeline-text-inspector textarea")?.value ===
      "Cancelled remote",
  );
  assert.equal(
    await page.getByLabel("Start (s)", { exact: true }).inputValue(),
    "3",
  );
  assert.equal(
    await page
      .locator(".cw-timeline-dialog")
      .getByRole("button", { name: "Undo", exact: true })
      .isDisabled(),
    true,
  );
  // Existing media gestures use the same guard; a full old snapshot cannot replace Agent edits.
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGNsYGhgIAUwkaR6VMOohiGlAQBCPQEgiSD+iQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page
    .getByLabel("Import timeline media", { exact: true })
    .setInputFiles([
      { name: "first.png", mimeType: "image/png", buffer: image },
      { name: "second.png", mimeType: "image/png", buffer: image },
    ]);
  await page.waitForFunction(
    () => document.querySelectorAll(".cw-timeline-clip").length === 2,
  );
  await page.getByRole("button", { name: "Apply edits", exact: true }).click();
  await page.locator(".cw-timeline-dialog").waitFor({ state: "hidden" });
  await open();
  const mediaBefore = (await state()).editorDocuments
    .find((d) => d.kind === "timeline")
    .data.tracks[0].clips.map((c) => c.id);
  const clipA = await page.locator(".cw-timeline-clip").nth(0).boundingBox(),
    clipB = await page.locator(".cw-timeline-clip").nth(1).boundingBox();
  await page.mouse.move(clipA.x + clipA.width / 2, clipA.y + clipA.height / 2);
  await page.mouse.down();
  await page.mouse.move(clipB.x + clipB.width - 10, clipB.y + clipB.height / 2);
  await agentText("Media gesture remote", { x: 0.15, maxWidth: 0.75 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Apply edits", exact: true }).click();
  await page
    .locator('.cw-timeline-dialog [role="alert"]')
    .waitFor({ timeout: 5000 });
  const mediaAfter = (await state()).editorDocuments.find(
    (d) => d.kind === "timeline",
  ).data;
  assert.equal(mediaAfter.overlays[0].text, "Media gesture remote");
  assert.deepEqual(
    mediaAfter.tracks[0].clips.map((c) => c.id),
    mediaBefore,
  );
  await page
    .locator(".cw-timeline-dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await open();
  await page.locator(".cw-timeline-text-move").click();
  // Plain text resource remains an immutable source after copying and editing its body.
  const originalSource = (await state()).assets.find((a) => a.kind === "text");
  await page
    .locator(".cw-timeline-text-actions select")
    .selectOption({ label: "Plain text source" });
  await page
    .getByRole("button", { name: "Create from text resource", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector(".cw-timeline-text-inspector textarea")?.value ===
      "来源正文 Source",
  );
  await content.fill("Edited source copy");
  await content.blur();
  await page
    .getByLabel("Import OTF or TTF font", { exact: true })
    .setInputFiles({
      name: "broken.ttf",
      mimeType: "font/ttf",
      buffer: Buffer.from("broken font bytes"),
    });
  await page.locator(".cw-timeline-dialog [role=alert]").waitFor();
  assert.equal(await content.inputValue(), "Edited source copy");
  await page
    .getByLabel("Import OTF or TTF font", { exact: true })
    .setInputFiles("public/fonts/NotoSansCJKsc-Regular.otf");
  await page.waitForFunction(
    () =>
      document.querySelector(".cw-timeline-text-inspector select")
        ?.selectedOptions[0]?.textContent === "NotoSansCJKsc-Regular.otf",
  );
  await page.getByLabel("Font size (px)", { exact: true }).fill("40");
  await page.getByLabel("Line height", { exact: true }).fill("1.5");
  await page.getByLabel("Vertical position", { exact: true }).fill("0.7");
  await page.getByLabel("Text width", { exact: true }).fill("0.7");
  await page.getByLabel("Background", { exact: true }).check();
  await page.getByLabel("Background opacity", { exact: true }).fill("0.6");
  await page.getByLabel("Background padding (px)", { exact: true }).fill("10");
  await page.getByLabel("Outline", { exact: true }).check();
  await page.getByLabel("Outline width (px)", { exact: true }).fill("2");
  await page.getByLabel("Vertical position", { exact: true }).fill("0.8");
  await content.fill("i".repeat(200));
  await content.blur();
  await page.waitForTimeout(300);
  assert.equal(
    await page
      .getByText(
        "Text extends below the frame. Output is cropped at the frame edge.",
        { exact: true },
      )
      .count(),
    0,
    "overflow warning measures the registered font instead of estimating glyph width",
  );
  await content.fill("Edited source copy");
  await content.blur();
  await page.getByLabel("Vertical position", { exact: true }).fill("0.7");
  await page
    .getByRole("button", { name: "Send backward", exact: true })
    .click();
  await page.getByRole("button", { name: "Apply edits", exact: true }).click();
  await page.locator(".cw-timeline-dialog").waitFor({ state: "hidden" });
  s = await state();
  editor = s.editorDocuments.find((d) => d.kind === "timeline");
  assert.equal(editor.data.overlays[0].text, "Edited source copy");
  assert.equal(editor.data.overlays[0].sourceAsset.assetId, originalSource.id);
  assert.equal(editor.data.overlays[0].style.background.padding, 10);
  assert.equal(editor.data.overlays[0].style.stroke.width, 2);
  assert.equal(editor.data.overlays[0].style.fontSize, 40);
  assert.equal(
    s.assets.find((a) => a.id === originalSource.id).fingerprint,
    originalSource.fingerprint,
  );
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await open();
  await page.locator(".cw-timeline-text-move").first().click();
  await page.getByLabel("文字内容", { exact: true }).waitFor();
  await page.getByRole("button", { name: "添加文字", exact: true }).waitFor();
  assert.equal(await page.getByText("FCPXML 和 XML + 素材 ZIP 无法保留文字或字体。请使用可编辑包继续编辑，或使用 MP4 导出渲染视频。", { exact: true }).isVisible(), true);
  for (const name of ["导出 FCPXML", "XML + 素材 ZIP"]) {
    const button = page.getByRole("button", { name, exact: true });
    assert.equal(await button.isDisabled(), true);
    assert.match(await button.getAttribute("title"), /可编辑包.*MP4/);
  }
  await page.screenshot({ path: join(root, "text-ui-zh.png") });
  await page.getByRole("button", { name: "删除文字", exact: true }).click();
  assert.equal(await page.locator(".cw-timeline-text-inspector").count(), 0);
  assert.equal(await page.locator(".cw-timeline-text-item").count(), 1);
  await page.getByRole("button", { name: "应用编辑", exact: true }).click();
  await page.locator(".cw-timeline-dialog").waitFor({ state: "hidden" });

  assert.deepEqual(errors, []);
  console.log(
    "PASS real UI IME/undo -> editor.save -> Agent -> UI -> API restart/reopen",
    root,
  );
} catch (error) {
  console.error(
    await globalThis.debugPage
      ?.locator("body")
      .innerText({ timeout: 1000 })
      .catch(() => ""),
  );
  throw error;
} finally {
  await browser?.close();
  await stop(web);
  await stop(server);
}
