/** A tab reload after a lost lease release reopens its own project at once,
 * while a second live window previews and can take over editing. */
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
const saved = { "zh-CN": "已保存到本机", "en-US": "Saved on this device" };

const browser = await launchBrowser();
try {
  for (const locale of ["en-US", "zh-CN"]) {
    const id = crypto.randomUUID();
    await call(`/api/creation/projects/${id}/commands`, { projectId: id, commandId: crypto.randomUUID(),
      type: "project.create", payload: { name: `Session lease ${locale} ${id.slice(0, 8)}` } });
    const url = `${base}/ai-tool/ai-canvas/${id}`;
    const context = await browser.newContext({ locale, viewport: { width: 1280, height: 800 } });
    await context.addInitScript((value) => {
      localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
      localStorage.setItem("opendirector.locale.v1", value);
    }, locale);
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const openStatuses = [];
    page.on("console", (m) => { if (process.env.DEBUG && m.type() === "error") console.log("console:", m.text()); });
    page.on("response", (response) => {
      if (process.env.DEBUG && response.url().includes("/api/creation/") && !response.url().includes("/assets/")) console.log(response.request().method(), response.status(), response.url().slice(-60));
      if (response.url().includes("/open-canvas")) openStatuses.push(response.status());
    });
    await page.goto(url);
    await page.getByText(saved[locale], { exact: true }).waitFor({ state: "attached" });

    // A lost pagehide release (crash, killed process): the old page's DELETE
    // never leaves it. Only this page's fetch is replaced; the reload is fresh.
    const stale = await page.evaluate(() => {
      const original = window.fetch;
      window.fetch = (input, init) =>
        String(input).includes("/creation/sessions/") && init?.method === "DELETE"
          ? Promise.reject(new TypeError("dropped"))
          : original(input, init);
      return sessionStorage.getItem("opendirector.session.v1");
    });
    assert.ok(stale, "the tab records its session");
    if (process.env.DEBUG) console.log("--- reload");
    const started = Date.now();
    await page.reload();
    // The old page's lease was still live, so the reload itself released it.
    assert.notEqual(await page.evaluate(() => sessionStorage.getItem("opendirector.session.v1")), stale);
    await page.getByText(saved[locale], { exact: true }).waitFor({ state: "attached" });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 15000, `reload reopened after ${elapsed} ms`);
    assert.deepEqual(openStatuses.filter((status) => status === 409), [], `${locale}: reload must not be refused`);

    const copy = locale === "zh-CN" ? {
      open: "在新标签页打开", removed: "打开预览窗口", request: "在此编辑", requested: "已请求编辑权",
      accept: "保存并交接", decline: "继续在此编辑", mode: "预览模式",
    } : {
      open: "Open in new tab", removed: "Open preview window", request: "Edit in this window", requested: "Edit access requested",
      accept: "Save and hand off", decline: "Keep editing here", mode: "Preview mode",
    };

    assert.equal(await page.getByText(copy.removed, { exact: true }).count(), 0);
    await page.locator(".cw-project-chevron").click();
    const row = page.locator(".cw-project-row").filter({ has: page.locator('[aria-checked="true"]') });
    await row.hover();
    const popup = context.waitForEvent("page", { timeout: 20000 });
    await row.getByTitle(copy.open, { exact: true }).click();
    const other = await popup;
    await page.keyboard.press("Escape");
    other.setDefaultTimeout(20000);
    const preview = other.locator('[data-testid="canvas-workspace"][data-edit-mode="preview"]');
    await preview.getByText(copy.mode, { exact: true }).waitFor();
    assert.equal(await preview.getByText(copy.removed, { exact: true }).count(), 0);

    const oldSession = await page.evaluate(() => sessionStorage.getItem("opendirector.session.v1"));
    const itemId = crypto.randomUUID(), specId = crypto.randomUUID();
    const issue = (session, type, payload, expectedVersions = []) => fetch(
      `${api}/api/creation/projects/${id}/commands`, {
        method: "POST",
        headers: { ...headers, "X-OpenDirector-Session": session },
        body: JSON.stringify({ projectId: id, commandId: crypto.randomUUID(), type, payload, expectedVersions }),
      });
    const batch = await issue(oldSession, "creation.batch", { operations: [
      { type: "generationSpec.create", payload: { spec: { id: specId, projectId: id, kind: "text", purpose: "draft" } } },
      { type: "canvas.show", payload: { item: { id: itemId, projectId: id, kind: "text", title: "Synced from A",
        position: { x: 200, y: 100 }, binding: { role: "empty", draftSpec: { id: specId } } } } },
    ] });
    const batchBody = await batch.json();
    assert.ok(batch.ok && batchBody.status === "applied", JSON.stringify(batchBody));
    const previewTitle = preview.locator(".cw-node-title").filter({ hasText: "Synced from A" });
    await previewTitle.waitFor();
    await previewTitle.dblclick();
    assert.equal(await preview.locator(".cw-node-title-input").count(), 0);
    await other.getByTestId("canvas-workspace").evaluate((element) => {
      element.dataset.handoffProbe = "same-workspace";
    });
    await page.locator(".cw-node-title").filter({ hasText: "Synced from A" }).dblclick();
    const title = page.locator(".cw-node-title-input");
    await title.fill("Renamed in A");
    await title.press("Enter");
    await preview.getByText("Renamed in A", { exact: true }).waitFor();

    await preview.getByRole("button", { name: copy.request }).click();
    await page.getByRole("button", { name: copy.decline }).click();
    await preview.getByRole("button", { name: copy.request }).click();
    await preview.getByRole("button", { name: copy.requested }).waitFor();
    await page.getByRole("button", { name: copy.accept }).click();
    const oldPreview = page.locator('[data-testid="canvas-workspace"][data-edit-mode="preview"]');
    await oldPreview.getByText(copy.mode, { exact: true }).waitFor();
    const newEditor = other.locator('[data-testid="canvas-workspace"][data-edit-mode="edit"]');
    await newEditor.waitFor();
    assert.equal(await newEditor.getAttribute("data-handoff-probe"), "same-workspace");

    const newSession = await other.evaluate(() => sessionStorage.getItem("opendirector.session.v1"));
    const payload = { itemId, title: "Synced from B" };
    const updated = await call(`/api/creation/projects/${id}`);
    const revision = updated.canvasItems.find((item) => item.id === itemId).revision;
    const basis = [{ objectType: "canvas_item", id: itemId, revision }];
    const late = await issue(oldSession, "canvas.update", payload, basis);
    assert.equal(late.status, 409);
    assert.equal((await late.json()).code, "session_expired");
    const edit = await issue(newSession, "canvas.update", payload, basis);
    const editBody = await edit.json();
    assert.ok(edit.ok && editBody.status === "applied", JSON.stringify(editBody));
    await oldPreview.getByText("Synced from B", { exact: true }).waitFor();

    // Explicit release models a successful close without depending on browser
    // teardown delivery. The remaining window can acquire with one click.
    const released = await fetch(`${api}/api/creation/sessions/${newSession}`, { method: "DELETE", headers });
    assert.ok(released.ok);
    await oldPreview.getByRole("button", { name: copy.request }).click();
    await page.locator('[data-testid="canvas-workspace"][data-edit-mode="edit"]').waitFor();
    console.log(`PASS ${locale}: reload, live preview, decline, handoff, stale write protection and reacquire`);
    await context.close();
  }
} finally {
  await browser.close();
}
