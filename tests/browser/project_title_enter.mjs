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
const renamed = `${initial} renamed`;
await call(`/api/creation/projects/${id}/commands`, {
  projectId: id, commandId: crypto.randomUUID(), type: "project.create", payload: { name: initial },
});
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ locale: "en-US" });
  await page.addInitScript(() => localStorage.setItem("opendirector.modelSetup.v1", "dismissed"));
  await page.goto(`${base}/ai-tool/ai-canvas/${id}`);
  await page.locator(".cw-project-name").click();
  await page.locator(".cw-project-name-field input").fill(renamed);
  await page.keyboard.down("Enter");
  await page.waitForFunction(name => document.querySelector(".cw-project-name")?.textContent === name, renamed);
  // The key is still down when asynchronous saving restores focus to the title button.
  await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");
  assert.equal(await page.locator(".cw-project-name-field input").count(), 0);
  assert.equal((await call(`/api/creation/projects/${id}`)).project.name, renamed);
  // A fresh key press still provides keyboard access to editing.
  await page.locator(".cw-project-name").press("Enter");
  await page.locator(".cw-project-name-field input").waitFor();
  await page.keyboard.press("Escape");
  await page.locator(".cw-project-chevron").click();
  await page.locator(".cw-project-create").click();
  const input = page.locator(".cw-project-name-field input");
  await input.waitFor();
  assert.equal(await input.evaluate(element => document.activeElement === element && element.selectionStart === 0 && element.selectionEnd === element.value.length), true);
  assert.ok((await input.inputValue()).length > 0);
  console.log("PASS new project: title focused and fully selected");
  console.log("PASS project title: held Enter saves once; fresh Enter can edit again");
} finally {
  await browser.close();
}
