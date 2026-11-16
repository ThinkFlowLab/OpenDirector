/** Text cards: Markdown, native editing buffers, fullscreen handoff and resize commits. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const headers = { "X-OpenDirector-Request": "1" };
const health = await fetch(`${base}/api/creation-test-health`, { headers });
assert.equal(health.ok, true, "Requires isolated creation_server.py and Vite");
assert.equal((await health.json()).isolated, true);
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1500, height: 1000 } });
  page.setDefaultTimeout(15000);
  await page.addInitScript(() => {
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    localStorage.setItem("opendirector.locale.v1", "en-US");
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const bootstrap = (url) => url.origin === new URL(base).origin && url.pathname === "/";
  await page.route(bootstrap, (route) => route.fulfill({ contentType: "text/html", body: "<html></html>" }));
  await page.goto(base);
  const fixture = await page.evaluate(async () => {
    const { createDocument, createNode } = await import("/src/canvas/model.ts");
    const { importWorkspaceDocument } = await import("/src/backend/workspace.ts");
    const { releaseBackendProject } = await import("/src/backend/projects.ts");
    const markdown = '# Heading 标题\n\n- **Bold** and *italic*\n\n> Quote\n\n[External](https://example.com)\n\n```js\nconst x = `hello`;\n```\n\n| A | B |\n| - | - |\n| x | y |\n' + "\nParagraph 中文\n".repeat(80);
    const node = createNode("text", { x: 180, y: 120 }, { title: "Markdown notes", text: markdown });
    const saved = await importWorkspaceDocument({
      ...createDocument("Text regression " + crypto.randomUUID().slice(0, 8)),
      nodes: [node], viewport: { x: 0, y: 0, zoom: 0.8 },
    });
    (await import("/src/backend/creationClient.ts")).creationClient(saved.id).close();
    await releaseBackendProject();
    return { id: saved.id, itemId: node.id, markdown };
  });
  await page.unroute(bootstrap);
  await page.goto(`${base}/ai-tool/ai-canvas/${fixture.id}`);
  const node = page.locator(`.react-flow__node[data-id="${fixture.itemId}"]`);
  await node.waitFor();
  const readItem = async () => {
    const response = await page.request.get(`${base}/api/creation/projects/${fixture.id}`, { headers });
    assert.equal(response.status(), 200);
    return (await response.json()).canvasItems.find((item) => item.id === fixture.itemId);
  };
  const waitItem = async (predicate) => {
    for (let i = 0; i < 80; i++) {
      const item = await readItem();
      if (await predicate(item)) return item;
      await page.waitForTimeout(100);
    }
    throw Error("Persisted text item did not reach the expected state");
  };
  const coherentCodeBlock = async (surface) => {
    const header = surface.locator('[data-streamdown="code-block-header"]');
    assert.equal(await header.count(), 1, "Fixture has a fenced language header");
    assert.equal(await header.isVisible(), false, "Language identifier must not float above the code");
    assert.equal(await surface.locator("pre code").textContent(), "const x = `hello`;");
  };
  const display = node.locator(".cw-text-display");
  await display.locator("h1").waitFor();
  for (const tag of ["ul", "blockquote", "[data-streamdown=strong]", "em", "[data-streamdown=link]", "pre", "table"]) {
    assert.equal(await display.locator(tag).count(), 1, tag);
  }
  await coherentCodeBlock(display);
  const viewport = await page.locator(".react-flow__viewport").getAttribute("style");
  await display.hover();
  await page.mouse.wheel(0, 250);
  await page.waitForTimeout(100);
  assert.equal(await page.locator(".react-flow__viewport").getAttribute("style"), viewport, "Text scrolling keeps zoom");
  await display.evaluate((element) => { element.scrollTop = 0; });

  // An unselected card's bottom-right corner starts a drag, not a resize.
  await page.locator(".react-flow__pane").click({ position: { x: 20, y: 80 } });
  await page.mouse.move(10, 10);
  const handle = node.locator(".cw-text-resize");
  assert.equal((await node.getAttribute("class")).includes("selected"), false);
  assert.equal(await handle.count(), 0, "Unselected, unhovered cards have no grip");
  const beforeDrag = await readItem();
  const corner = await node.boundingBox();
  await page.mouse.move(corner.x + corner.width - 5, corner.y + corner.height - 5);
  assert.equal(await handle.count(), 0, "Hovering an unselected corner keeps it draggable");
  await page.mouse.down();
  await page.mouse.move(corner.x + corner.width + 35, corner.y + corner.height + 20, { steps: 10 });
  await page.mouse.up();
  const dragged = await waitItem((item) => item.position.x !== beforeDrag.position.x);
  assert.deepEqual([dragged.width, dragged.height], [beforeDrag.width, beforeDrag.height]);
  await handle.waitFor();
  await page.waitForTimeout(600);
  const before = await readItem();
  let writes = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/commands")) writes++;
  });
  const grip = await handle.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 130, grip.y + grip.height / 2 + 65, { steps: 12 });
  await page.waitForTimeout(650);
  assert.equal(writes, 0, "No persistence during resize");
  await page.mouse.up();
  const resized = await waitItem((item) => item.width !== before.width && item.height !== before.height);
  assert.equal(resized.binding.objectRef.assetId, before.binding.objectRef.assetId, "Resize preserves source");
  assert.equal(writes, 1, "One write after releasing the resize grip");
  console.log("Resize persisted", { before: [before.width, before.height], after: [resized.width, resized.height], writes });
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.locator(".cw-workspace").focus();
  await page.keyboard.press(`${modifier}+z`);
  await waitItem((item) => item.width === before.width && item.height === before.height);
  await page.keyboard.press(`${modifier}+Shift+z`);
  await waitItem((item) => item.width === resized.width && item.height === resized.height);
  await page.screenshot({ path: join(tmpdir(), "issue336-canvas-en.png") });

  await display.dblclick({ position: { x: 60, y: 35 } });
  const inline = node.locator(".cw-text-editor");
  await inline.waitFor();
  // A native composition buffer can be ahead of the document during a rerender.
  const composing = fixture.markdown + "\n输入中的草稿";
  await inline.evaluate((element, value) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(element, value);
    element.setSelectionRange(value.length, value.length);
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true }));
  }, composing);
  await page.mouse.move(10, 10);
  await inline.hover();
  await page.waitForTimeout(100);
  assert.equal(await inline.inputValue(), composing, "Rerender must not rewrite an inline composition buffer");
  assert.equal(await inline.evaluate((element) => document.activeElement === element), true);
  await inline.evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    element.setSelectionRange(2, 9, "backward");
    element.dispatchEvent(new Event("select", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Expand editor", exact: true }).click();
  const win = page.locator(".cw-text-window");
  await win.waitFor();
  const editor = win.locator("textarea");
  const state = (area) => area.evaluate((element) => ({
    text: element.value, range: [element.selectionStart, element.selectionEnd, element.selectionDirection],
    scrollTop: element.scrollTop,
  }));
  assert.deepEqual((await state(editor)).range, [2, 9, "backward"]);
  assert.equal(await editor.inputValue(), composing);
  const windowBox = await win.boundingBox();
  assert.deepEqual([windowBox.width, windowBox.height], [1500, 1000]);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await win.locator("table").waitFor();
  await coherentCodeBlock(win);
  const beforeLink = page.url();
  await win.locator("[data-streamdown=link]").click();
  await win.getByRole("dialog", { name: "Open external link" }).waitFor();
  assert.equal(page.url(), beforeLink);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(220);
  await page.screenshot({ path: join(tmpdir(), "issue336-fullscreen-en.png") });
  await page.getByRole("button", { name: "Edit source", exact: true }).click();
  assert.deepEqual((await state(editor)).range, [2, 9, "backward"]);
  await editor.evaluate((element) => element.setSelectionRange(element.value.length, element.value.length));
  await editor.press("Enter");
  await page.keyboard.insertText("全屏输入保留光标和滚动 — edited in fullscreen");
  await editor.evaluate((element) => {
    element.setSelectionRange(2, 9, "backward");
    element.dispatchEvent(new Event("select", { bubbles: true }));
    element.scrollTop = 180;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const edited = await state(editor);
  assert.ok(edited.text.includes("全屏输入保留光标和滚动"));
  assert.equal(edited.scrollTop, 180, "Fixture scrolls in fullscreen as well as inline");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await inline.waitFor();
  assert.deepEqual(await state(inline), edited, "Fullscreen handoff keeps typed CJK, selection and scroll");
  assert.equal(await inline.evaluate((element) => document.activeElement === element), true);
  assert.ok((await node.getAttribute("class")).includes("selected"));
  const changed = await waitItem(async (item) => {
    const content = await page.request.get(`${base}/api/creation/projects/${fixture.id}/assets/${item.binding.objectRef.assetId}/content`, { headers });
    return await content.text() === edited.text;
  });
  await inline.press("Escape");
  await page.reload();
  await node.locator("h1").waitFor();
  assert.equal((await readItem()).width, resized.width);
  const content = await page.request.get(`${base}/api/creation/projects/${fixture.id}/assets/${changed.binding.objectRef.assetId}/content`, { headers });
  assert.equal(await content.text(), edited.text);
  console.log("Markdown code blocks, uncontrolled composition, fullscreen text/range/scroll, undo and reopen passed");

  await page.evaluate(async ({ id, itemId }) => {
    const { creationClient, objectVersion } = await import("/src/backend/creationClient.ts");
    const client = creationClient(id);
    const item = client.snapshot.canvasItems.find((item) => item.id === itemId);
    await client.command("canvas.update", { itemId, locked: true }, [objectVersion("canvas_item", item)]);
  }, fixture);
  await page.waitForTimeout(500);
  await node.click();
  assert.equal(await handle.count(), 0, "Selected locked cards have no resize grip");
  await display.dblclick({ position: { x: 60, y: 35 } });
  assert.equal(await inline.count(), 0, "Locked card rejects source editing");
  await page.getByRole("button", { name: "Expand editor", exact: true }).click();
  await editor.waitFor();
  assert.equal(await editor.getAttribute("readonly"), "");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await node.click();
  await page.getByRole("button", { name: "展开编辑", exact: true }).click();
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await win.locator("table").waitFor();
  await coherentCodeBlock(win);
  await page.waitForTimeout(220);
  await page.screenshot({ path: join(tmpdir(), "issue336-fullscreen-zh.png") });
  assert.deepEqual(errors, []);
  console.log("Unselected corner drag, locked surfaces and both locales passed", fixture.id);
  console.log("Screenshots:", ["issue336-canvas-en.png", "issue336-fullscreen-en.png", "issue336-fullscreen-zh.png"].map((name) => join(tmpdir(), name)));
} finally {
  await browser.close();
}
