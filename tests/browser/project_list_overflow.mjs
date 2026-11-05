/** Many unreadable-project warnings must not push the project list out of the menu. */
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
await call(`/api/creation/projects/${id}/commands`, { projectId: id, commandId: crypto.randomUUID(),
  type: "project.create", payload: { name: `Project list ${id.slice(0, 8)}` } });
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 420, height: 760 } });
  // Skip the first-run model setup welcome; it covers the canvas.
  await page.addInitScript(() =>
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
  );
  page.setDefaultTimeout(15000);
  // Twenty legacy projects each add one warning line, as in a long-lived workspace.
  await page.route(/\/api\/creation\/projects(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const listed = await (await route.fetch()).json();
    const legacy = Array.from({ length: 20 }, () => crypto.randomUUID());
    await route.fulfill({ json: {
      projects: [...listed.projects, ...Array.from({ length: 25 }, (_, index) => ({
        id: crypto.randomUUID(), name: `Listed ${String(index + 1).padStart(2, "0")}`, path: "/fixture" }))],
      unreadable: legacy.map((project) => ({ id: project, name: project, path: "/fixture", reason: "legacy" })),
      warnings: legacy.map((project) => `工程 ${project} 使用旧格式，统一工程接口不支持读取或转换。`),
    } });
  });
  await page.goto(`${base}/ai-tool/ai-canvas/${id}`);
  await page.getByText("已保存到本机", { exact: true }).waitFor({ state: "attached" });
  await page.getByRole("button", { name: "切换项目", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Listed 01", exact: true }).waitFor();
  const outside = await page.evaluate(() => {
    const menu = document.querySelector(".cw-project-dropdown").getBoundingClientRect();
    return [...document.querySelectorAll(".cw-project-dropdown > :not(.cw-project-actions)")]
      .filter((element) => element.getBoundingClientRect().bottom > menu.bottom + 1)
      .map((element) => element.className);
  });
  assert.deepEqual(outside, [], "every menu section stays inside the menu");
  await page.locator(".cw-project-list").hover();
  await page.mouse.wheel(0, 4000);
  const last = page.getByRole("menuitemradio", { name: "Listed 25", exact: true });
  await page.waitForFunction((element) => {
    const row = element.getBoundingClientRect();
    const list = element.closest(".cw-project-list").getBoundingClientRect();
    return row.top >= list.top - 1 && row.bottom <= list.bottom + 1;
  }, await last.elementHandle());
  await page.getByRole("menuitem", { name: /清除不可读项目/ }).waitFor();
  console.log("PASS project list: warnings scroll inside the menu and every project stays reachable");
} finally {
  await browser.close();
}
