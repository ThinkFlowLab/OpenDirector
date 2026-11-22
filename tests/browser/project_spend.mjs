/** Full batch review against a loopback image provider, in both UI languages. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { launchBrowser } from "./engine.mjs";

const web = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
async function call(path, payload, method = payload ? "POST" : "GET") {
  const response = await fetch(api + path, {
    method, headers: { "X-OpenDirector-Request": "1", "Content-Type": "application/json" },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.status === 204 ? null : response.json();
}
async function until(read, matches) {
  const deadline = Date.now() + 45000;
  let value;
  do {
    value = await read();
    if (matches(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw Error("Timed out waiting for project state: " + JSON.stringify(value.jobs?.map(j => [j.status, j.errorDetails])));
}
assert.ok((await call("/api/creation-test-health")).httpGenerationFixture);
const picture = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=1024x1024",
  "-frames:v", "1", "-threads", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"]);
assert.equal(picture.status, 0);
const posts = [];
const service = createServer(async (req, res) => {
  if (req.url !== "/v1/images/generations") { res.writeHead(404).end(); return; }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  posts.push(JSON.parse(Buffer.concat(chunks)));
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ b64_json: picture.stdout.toString("base64") }] }));
});
service.listen(0, "127.0.0.1");
await once(service, "listening");
const browser = await launchBrowser();
let model;
try {
  model = await call("/api/model-configs", { kind: "image", modelId: "review-image", url: `http://127.0.0.1:${service.address().port}/v1`,
    authMode: "none", connectionType: "api", protocol: "openai", capabilityAutoCheck: false });
  await call(`/api/model-configs/${model.id}/price`, { unit: "request", rate: "0.40", currency: "USD" }, "PUT");
  for (const locale of ["zh-CN", "en-US"]) {
    const en = locale === "en-US", pid = crypto.randomUUID(), path = `/api/creation/projects/${pid}`;
    await call(path + "/commands", { type: "project.create", commandId: crypto.randomUUID(), projectId: pid, payload: { name: "Spend " + pid.slice(0, 8) } });
    const page = await browser.newPage({ locale, viewport: { width: 1480, height: 940 } });
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(locale => {
      localStorage.setItem("opendirector.locale.v1", locale);
      localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    }, locale);
    await page.goto(`${web}/ai-tool/ai-canvas/${pid}`);
    const toggle = page.locator(".cw-spend-toggle");
    await toggle.click();
    await page.getByText(en ? "Spending controls" : "费用设置", { exact: true }).click();
    await page.getByLabel(en ? "Confirm above" : "单批确认阈值").fill("1");
    await page.getByRole("button", { name: en ? "Save" : "保存", exact: true }).click();
    await until(() => call(path), s => Number(s.project.spendPolicy?.threshold) === 1);
    await toggle.click();
    const itemId = await page.evaluate(async ({ pid, modelId }) => {
      const { creationClient } = await import("/src/backend/creationClient.ts");
      const specId = crypto.randomUUID(), itemId = crypto.randomUUID();
      await creationClient(pid).command("canvas.createGeneration", {
        spec: { id: specId, projectId: pid, kind: "image", purpose: "generation", modelConfigId: modelId, prompt: "Blue", parameters: { size: "1024x1024" } },
        item: { id: itemId, projectId: pid, kind: "image", position: { x: 0, y: 0 }, binding: { role: "generation", objectRef: { id: specId } } },
      });
      return itemId;
    }, { pid, modelId: model.id });
    await page.locator(`.react-flow__node[data-id="${itemId}"]`).click();
    const composer = page.locator(".cw-generation-composer");
    await composer.locator(".cw-parameter-trigger").click();
    await page.locator(".cw-count-options").getByRole("button", { name: "3", exact: true }).click();
    await composer.locator(".cw-parameter-trigger").click();
    await composer.locator(".cw-spend-estimate summary").filter({ hasText: "1.20" }).waitFor();
    const before = posts.length;
    await composer.locator("button.cw-run-button").click();
    await toggle.filter({ hasText: "(1)" }).or(toggle.filter({ hasText: "（1）" })).waitFor();
    const pending = await call(path);
    assert.equal(pending.jobs.length, 0);
    assert.equal(pending.spendCalls?.length ?? 0, 0);
    assert.equal(posts.length, before);
    await toggle.click();
    const approve = page.getByRole("button", { name: en ? "Run this batch" : "确认运行本批", exact: true });
    await approve.click();
    const completed = await until(() => call(path), s => s.jobs.length === 3 && s.jobs.every(j => j.status === "succeeded"));
    assert.equal(completed.spendCalls.length, 3);
    assert.equal(new Set(completed.jobs.map(job => job.id)).size, 3);
    assert.equal(posts.length - before, 3);
    assert.ok(posts.slice(before).every(post => post.prompt === "Blue" && post.n === 1));
    assert.deepEqual(errors, []);
    console.log(locale, "USD 1.20 shown; 0 calls pending; 3 jobs and 3 provider requests");
    await page.close();
  }
} finally {
  await browser.close();
  service.close();
  if (model) await call(`/api/model-configs/${model.id}`, null, "DELETE");
}
