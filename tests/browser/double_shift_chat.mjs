/** A held Enter must save the inline project title without reopening its editor. */
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
const id = crypto.randomUUID();
const initial = `Title ${id.slice(0, 8)}`;

await call(`/api/creation/projects/${id}/commands`, {
  projectId: id, commandId: crypto.randomUUID(), type: "project.create", payload: { name: initial },
});
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ locale: "en-US" });
  await page.addInitScript(() => localStorage.setItem("opendirector.modelSetup.v1", "dismissed"));
  await page.goto(`${base}/ai-tool/ai-canvas/${id}`);
  const trigger = page.locator(".cw-project-chevron");
  await trigger.waitFor();
  await page.locator('.cw-workspace[aria-busy="false"]').waitFor();
  await trigger.focus();
  const tap = async () => { await page.keyboard.press("Shift"); await page.keyboard.press("Shift"); };
  await tap();
  const editor = page.locator('#canvas-assistant [contenteditable="true"]').first();
  await editor.waitFor();
  await page.waitForFunction(() => document.activeElement?.closest('#canvas-assistant [contenteditable="true"]'));
  await page.keyboard.insertText("Keep this draft");
  await tap();
  await page.waitForFunction(() => document.querySelector("#canvas-assistant").hidden);
  assert.equal(await trigger.evaluate(element => document.activeElement === element), true);
  await tap();
  await editor.waitFor();
  assert.ok((await editor.textContent()).includes("Keep this draft"));
  console.log("PASS double Shift: toggles chat, focuses input, restores focus and preserves draft");
} finally { await browser.close(); }
