/** A tab reload after a lost lease release reopens its own project at once,
 * while a second live window is still refused with an explicit message. */
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

    // A genuinely separate live window still cannot open the same project.
    const other = await context.newPage();
    await other.addInitScript(() => sessionStorage.clear());
    const refused = other.waitForResponse((response) => response.url().includes("/open-canvas"));
    await other.goto(url);
    const response = await refused;
    assert.equal(response.status(), 409);
    const body = await response.json();
    assert.equal(body.code, "project_open_elsewhere");
    if (locale === "en-US") assert.match(body.detail, /another window/);
    else assert.match(body.detail, /其他窗口/);
    console.log(`PASS ${locale}: reload reopened in ${elapsed} ms; second window refused: ${body.detail}`);
    await context.close();
  }
} finally {
  await browser.close();
}
