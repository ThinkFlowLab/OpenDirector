/** New nodes light up the canvas dots once; opening a canvas and undo/redo do not. */
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
const page = await browser.newPage({ locale: "en-US", viewport: { width: 1400, height: 900 } });
// Skip the first-run model setup welcome; it covers the canvas.
await page.addInitScript(() => localStorage.setItem("opendirector.modelSetup.v1", "dismissed"));
page.setDefaultTimeout(15000);
const projectId = crypto.randomUUID();
const checks = [];
const ripples = () => page.locator("[data-creation-ripple]").count();
try {
  await call(`/api/creation/projects/${projectId}/commands`, { commandId: crypto.randomUUID(), projectId,
    type: "project.create", payload: { name: `Creation ripple ${projectId.slice(0, 8)}` } });
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  await page.locator(".react-flow__pane").waitFor();
  await page.waitForTimeout(500);
  headers["X-OpenDirector-Session"] = await page.evaluate(async () => (await import("/src/backend/api.ts")).sessionId);
  assert.equal(await ripples(), 0, "an empty canvas must not ripple");

  await call(`/api/creation/projects/${projectId}/commands`, { commandId: crypto.randomUUID(), projectId,
    type: "canvas.show", payload: { item: { id: crypto.randomUUID(), projectId, kind: "image", position: { x: 0, y: 0 },
      width: 352, height: 352, title: "Remote node", binding: { role: "empty" } } } });
  await page.waitForSelector("[data-creation-ripple]");
  // The ripple is decorative: it sits under the nodes and never takes pointer input.
  assert.equal(await page.locator("[data-creation-ripple]").evaluate((element) => getComputedStyle(element).pointerEvents), "none");
  await page.waitForFunction(() => !document.querySelector("[data-creation-ripple]"), undefined, { timeout: 4000 });
  checks.push("remote creation ripples once and clears");

  await page.reload();
  await page.locator(".react-flow__node").first().waitFor();
  for (let i = 0; i < 8; i++) {
    assert.equal(await ripples(), 0, "opening a canvas must not ripple");
    await page.waitForTimeout(150);
  }
  checks.push("opening a canvas does not ripple");

  await page.locator(".react-flow__pane").click({ position: { x: 1000, y: 700 } });
  const before = await page.locator(".react-flow__node").count();
  await page.keyboard.press("t");
  await page.waitForFunction((count) => document.querySelectorAll(".react-flow__node").length > count, before);
  await page.waitForSelector("[data-creation-ripple]");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-creation-ripple]"), undefined, { timeout: 4000 });
  checks.push("local creation ripples once and clears");

  await page.locator(".react-flow__pane").click({ position: { x: 1200, y: 820 } });
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${mod}+z`);
  await page.waitForFunction((count) => document.querySelectorAll(".react-flow__node").length === count, before);
  await page.keyboard.press(`${mod}+Shift+z`);
  await page.waitForFunction((count) => document.querySelectorAll(".react-flow__node").length > count, before);
  for (let i = 0; i < 4; i++) {
    assert.equal(await ripples(), 0, "redo restoring a known node must not ripple");
    await page.waitForTimeout(100);
  }
  checks.push("undo and redo do not ripple");
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await browser.close();
}
