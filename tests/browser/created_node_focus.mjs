/** Remote creation changes only the viewport; no paid generation. */
import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const headers = { "X-OpenDirector-Request": "1", "Content-Type": "application/json" };
async function call(path, body) {
  const response = await fetch(api + path, { headers, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
assert.equal((await call("/api/creation-test-health")).isolated, true);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
// Skip the first-run model setup welcome; it covers the canvas.
await page.addInitScript(() =>
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
);
page.setDefaultTimeout(15000);
const projectId = crypto.randomUUID();
try {
  await call(`/api/creation/projects/${projectId}/commands`, { commandId: crypto.randomUUID(), projectId,
    type: "project.create", payload: { name: `Viewport focus ${projectId.slice(0, 8)}` } });
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  await page.locator(".cw-chat-button").click();
  await page.locator(".cw-assistant-panel:not([hidden])").waitFor();
  headers["X-OpenDirector-Session"] = await page.evaluate(async () => (await import("/src/backend/api.ts")).sessionId);
  const create = async (x, y) => {
    const id = crypto.randomUUID();
    await call(`/api/creation/projects/${projectId}/commands`, { commandId: crypto.randomUUID(), projectId,
      type: "canvas.show", payload: { item: { id, projectId, kind: "image", position: { x, y },
        width: 352, height: 528, title: "Remote node", binding: { role: "empty" } } } });
    await page.locator(`.react-flow__node[data-id="${id}"]`).waitFor({ state: "attached" });
    return id;
  };
  const transform = () => page.locator(".react-flow__viewport").getAttribute("style");
  const checkCentered = async (id) => {
    await page.waitForFunction((id) => {
      const node = document.querySelector(`.react-flow__node[data-id="${id}"]`).getBoundingClientRect();
      const panel = document.querySelector(".cw-assistant-panel").getBoundingClientRect();
      return node.left > 75 && node.right < panel.left - 10 && node.top > 72 && node.bottom < innerHeight - 65 &&
        Math.abs((node.left + node.right) / 2 - (80 + panel.left - 16) / 2) < 50;
    }, id);
  };
  const editor = page.locator(".cw-assistant-panel [contenteditable=true]").first();
  await editor.fill("继续创作");
  const first = await create(0, 0);
  await checkCentered(first);
  assert.ok(await editor.evaluate((element) => element === document.activeElement));
  assert.equal(await page.locator(".react-flow__node.selected").count(), 0);
  await page.screenshot({ path: "/tmp/created-node-focus.png" });
  await page.waitForTimeout(250);
  await page.mouse.move(100, 800);
  await page.mouse.down();
  const before = await transform();
  await create(5000, 5000);
  await page.waitForTimeout(300);
  assert.equal(await transform(), before, "creation must not move the viewport during a pointer gesture");
  await page.mouse.up();
  await page.waitForTimeout(250);
  assert.equal(await transform(), before, "blocked creation must not steal the view after the gesture");
  const third = await create(7000, 3000);
  await checkCentered(third);
  await page.waitForTimeout(250);
  await page.mouse.move(1000, 800);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(1100, 830, { steps: 5 });
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(250);
  const navigated = await transform();
  await call(`/api/creation/projects/${projectId}/commands`, { commandId: crypto.randomUUID(), projectId,
    type: 'canvas.update', payload: { itemId: third, title: 'Updated title' },
    expectedVersions: [{ objectType: 'canvas_item', id: third, revision: 1 }] });
  await page.getByText('Updated title', { exact: true }).waitFor({ state: 'attached' });
  await page.waitForTimeout(250);
  assert.equal(await transform(), navigated, 'updates to existing nodes must not undo manual navigation');
  await page.locator('.cw-workspace').focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node.selected').length === 3);
  const multiViewport = await transform();
  await create(9000, 9000);
  await page.waitForTimeout(300);
  assert.equal(await transform(), multiViewport, 'multi-selection must retain its view');
  assert.equal(await page.locator('.react-flow__node.selected').count(), 3);
  const snapshot = await call(`/api/creation/projects/${projectId}`);
  assert.deepEqual(snapshot.canvasItems.map((item) => item.position), [{ x: 0, y: 0 }, { x: 5000, y: 5000 }, { x: 7000, y: 3000 }, { x: 9000, y: 9000 }]);
  assert.equal(snapshot.jobs.length, 0);

  // Restoring an existing identity must not be mistaken for remote creation,
  // including when it arrives through the event stream rather than UI undo.
  const read = () => call(`/api/creation/projects/${projectId}`);
  const send = async (type, payload) => {
    const current = await read();
    return call(`/api/creation/projects/${projectId}/commands`, {
      commandId: crypto.randomUUID(), projectId, type, payload,
      expectedVersions: current.canvasItems.map((item) => ({ objectType: 'canvas_item', id: item.id, revision: item.revision })),
    });
  };
  const shown = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
  const selection = () => page.locator('.react-flow__node.selected').evaluateAll((nodes) => nodes.map((node) => node.dataset.id).sort());
  const assertViewRetained = async (before, selected, message) => {
    await page.waitForTimeout(350);
    assert.equal(await transform(), before, message);
    assert.deepEqual(await selection(), selected, 'history restoration must retain selection');
    assert.ok(await editor.evaluate((element) => element === document.activeElement), 'history restoration must retain assistant input focus');
  };
  // Clear multi-selection, then keep one distant node selected while a different
  // node is restored. A single selection must remain as well as its viewport.
  await page.locator('.cw-workspace').focus();
  await page.keyboard.press('Escape');
  await shown(third).locator('.cw-node-placeholder').click({ position: { x: 8, y: 8 } });
  await page.waitForTimeout(250);
  assert.deepEqual(await selection(), [third]);
  await editor.fill('保留我的视图和输入焦点');
  const hidden = await send('canvas.hide', { itemId: first });
  assert.equal(hidden.status, 'applied');
  await shown(first).waitFor({ state: 'detached' });
  await page.waitForTimeout(250);
  const beforeUndo = await transform(), selectedBeforeUndo = await selection();
  const undone = await send('history.undo', { targetCommandId: hidden.commandId });
  assert.equal(undone.status, 'applied');
  await shown(first).waitFor({ state: 'attached' });
  await assertViewRetained(beforeUndo, selectedBeforeUndo, 'undoing a hide must not reveal the restored node');

  await send('history.redo', { targetCommandId: hidden.commandId });
  await shown(first).waitFor({ state: 'detached' });
  await assertViewRetained(beforeUndo, selectedBeforeUndo, 'redoing a hide must retain the view');
  // Restoring again after reload also uses the persisted hidden identity.
  await page.waitForTimeout(1200); // Flush independent viewport preferences.
  await page.reload();
  await page.getByText('已保存到本机', { exact: true }).waitFor();
  if (!(await editor.isVisible())) await page.locator('.cw-chat-button').click();
  await editor.fill('重开后仍保留视图');
  headers['X-OpenDirector-Session'] = await page.evaluate(async () => (await import('/src/backend/api.ts')).sessionId);
  const beforeShow = await transform(), selectedBeforeShow = await selection();
  const hiddenItem = (await read()).canvasItems.find((item) => item.id === first);
  assert.equal(hiddenItem.visible, false);
  const restored = await send('canvas.show', { item: hiddenItem });
  assert.equal(restored.status, 'applied');
  await shown(first).waitFor({ state: 'attached' });
  await assertViewRetained(beforeShow, selectedBeforeShow, 're-showing a hidden node after reopen must retain the view');

  // A hidden-only snapshot can leave the visible projection unchanged. Its
  // authoritative identity still predates a later request to show the item.
  const hiddenId = crypto.randomUUID();
  const registered = await send('creation.batch', { operations: [
    { type: 'canvas.show', payload: { item: { id: hiddenId, projectId, kind: 'image',
      title: 'Previously registered', position: { x: 25000, y: 25000 },
      width: 352, height: 528, binding: { role: 'empty' } } } },
    { type: 'canvas.hide', payload: { itemId: hiddenId } },
  ] });
  assert.equal(registered.status, 'applied');
  let registeredSnapshotObserved = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    registeredSnapshotObserved = await page.evaluate(async ({ projectId, hiddenId }) => {
      const { workspaceProjection } = await import('/src/backend/workspace.ts');
      return workspaceProjection(projectId).basis?.canvasItems.some((item) => item.id === hiddenId) === true;
    }, { projectId, hiddenId });
    if (registeredSnapshotObserved) break;
    await page.waitForTimeout(100);
  }
  assert.equal(registeredSnapshotObserved, true, 'the hidden registration must reach the authoritative editing basis first');
  assert.equal(await shown(hiddenId).count(), 0);
  const beforeFirstShow = await transform(), selectedBeforeFirstShow = await selection();
  const registeredItem = (await read()).canvasItems.find((item) => item.id === hiddenId);
  assert.equal(registeredItem.visible, false);
  const firstShow = await send('canvas.show', { item: registeredItem });
  assert.equal(firstShow.status, 'applied');
  await shown(hiddenId).waitFor({ state: 'attached' });
  await assertViewRetained(beforeFirstShow, selectedBeforeFirstShow, 'showing a previously registered hidden identity must retain the view');

  // A genuinely new identity must still reveal itself after all restores.
  const fresh = await create(15000, 12000);
  await checkCentered(fresh);
  const entries = await call(`/api/creation/projects/${projectId}/history`);
  const creationId = entries[0].commandId;
  const undoneCreation = await send('history.undo', { targetCommandId: creationId });
  assert.equal(undoneCreation.status, 'applied');
  await shown(fresh).waitFor({ state: 'detached' });
  await page.mouse.move(700, 750);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(860, 800, { steps: 5 });
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(250);
  await editor.fill('重做时不要改变视图');
  const beforeRedo = await transform(), selectedBeforeRedo = await selection();
  const redone = await send('history.redo', { targetCommandId: creationId });
  assert.equal(redone.status, 'applied');
  await shown(fresh).waitFor({ state: 'attached' });
  await assertViewRetained(beforeRedo, selectedBeforeRedo, 'redoing creation must not reveal an existing identity');
  const final = await read();
  assert.deepEqual(final.canvasItems.map((item) => item.position), [...snapshot.canvasItems.map((item) => item.position), { x: 25000, y: 25000 }, { x: 15000, y: 12000 }]);
  assert.equal(final.jobs.length, 0);
  console.log(JSON.stringify({ passed: true, checks: ["assistant occlusion", "center origin and distant nodes", "preserve focus and selection", "respect pointer gesture and multi-selection", "undo and redo preserve viewport", "re-show hidden node after reopen", "show previously registered hidden identity", "redo creation preserves viewport", "fresh nodes still reveal", "unchanged authored positions"] }));
} finally {
  await browser.close();
}
