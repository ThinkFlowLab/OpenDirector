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
    assert.ok(completed.spendCalls.every(c => c.state === "completed" && Number(c.calculated) === 0.4));
    // Put the second batch above the remaining cap, then review it from chat.
    const controls = page.locator(".cw-spend-canvas");
    const cap = controls.getByLabel(en ? "Project cap" : "工程上限", {exact: true});
    if (!await cap.isVisible()) await controls.getByText(en ? "Spending controls" : "费用设置", {exact:true}).click();
    await cap.fill("2");
    await controls.getByRole("button", {name: en ? "Save" : "保存", exact: true}).click();
    await until(() => call(path), s => Number(s.project.spendPolicy?.cap) === 2);
    const second = () => page.evaluate(async ({pid, itemId}) => {
      const {creationClient} = await import("/src/backend/creationClient.ts");
      return creationClient(pid).submit(itemId, "if_current", undefined, undefined, 3);
    }, {pid, itemId});
    assert.equal((await second()).status, "awaiting_confirmation");
    const assistant = page.locator("#canvas-assistant");
    if (!await assistant.isVisible()) await page.locator(".cw-chat-button").click();
    const card = assistant.locator(".cw-spend-card");
    await card.getByText(/0\.80/).waitFor();
    await card.getByRole("button", {name: en ? "Cancel request" : "取消申请"}).click();
    await until(() => call(path), s => s.spendRequests.at(-1).status === "cancelled");
    assert.equal(posts.length - before, 3);
    const third = await second();
    assert.equal(third.status, "awaiting_confirmation");
    const current = assistant.locator(`[data-spend-request="${third.spendRequestId}"]`);
    await current.getByLabel(en ? "New project cap" : "新的工程上限").fill("2.40");
    await current.getByRole("button", {name: en ? "Raise cap and run this batch" : "提高上限并运行本批"}).click();
    const raised = await until(() => call(path), s => s.jobs.length === 6 && s.jobs.every(j => j.status === "succeeded"));
    assert.equal(Number(raised.project.spendPolicy.cap), 2.4);
    assert.equal(raised.spendCalls.length, 6);
    assert.equal(posts.length - before, 6);
    assert.deepEqual(errors, []);
    console.log(locale, "USD 1.20 batch, zero calls pending, cancellation, USD 0.40 shortfall, chat approval, six settled calls");
    const grouped = crypto.randomUUID(), groupPath = `/api/creation/projects/${grouped}`;
    await call(groupPath + "/commands", {type: "project.create", commandId: crypto.randomUUID(), projectId: grouped, payload: {name: "Workflow " + grouped.slice(0, 8)}});
    await page.goto(`${web}/ai-tool/ai-canvas/${grouped}`);
    await page.locator(".cw-spend-toggle").waitFor();
    const groupId = await page.evaluate(async ({pid, modelId}) => {
      const {creationClient, objectVersion} = await import("/src/backend/creationClient.ts");
      const client = creationClient(pid), groupId = crypto.randomUUID();
      await client.command("canvas.show", {item: {id: groupId, projectId: pid, kind: "group", title: "Workflow", width: 820, height: 420, position: {x: 0, y: 0}}});
      for (const [i, prompt] of ["First panel", "Second panel"].entries()) {
        const specId = crypto.randomUUID();
        const parent = client.snapshot.canvasItems.find(item => item.id === groupId);
        await client.command("canvas.createGeneration", {
          spec: {id: specId, projectId: pid, kind: "image", purpose: "generation", modelConfigId: modelId, prompt, parameters: {size: "1024x1024"}},
          item: {id: crypto.randomUUID(), projectId: pid, kind: "image", parentId: groupId, position: {x: 60 + i * 360, y: 80},
            binding: {role: "generation", objectRef: {id: specId}}},
        }, [objectVersion("canvas_item", parent)]);
      }
      return groupId;
    }, {pid: grouped, modelId: model.id});
    const groupNode = page.locator(`.react-flow__node[data-id="${groupId}"]`);
    await groupNode.click({position: {x: 12, y: 14}});
    await page.locator(".cw-group-estimate summary").filter({hasText: "0.80"}).click();
    assert.equal(await page.locator(".cw-group-estimate li").count(), 2);
    assert.equal((await call(groupPath)).jobs.length, 0);
    assert.equal(posts.length - before, 6);
    await page.evaluate(async pid => {
      const {creationClient, objectVersion} = await import("/src/backend/creationClient.ts");
      const client = creationClient(pid);
      await client.command("spend.policy", {threshold: "0.60", currency: "USD"}, [objectVersion("project", client.snapshot.project)]);
    }, grouped);
    await page.getByRole("button", {name: en ? "Run workflow" : "运行工作流", exact: true}).click();
    const groupPending = await until(() => call(groupPath), s => s.spendRequests?.some(r => r.status === "pending"));
    assert.equal(groupPending.spendRequests.at(-1).groupItems.length, 2);
    assert.equal(groupPending.jobs.length, 0);
    await page.locator(".cw-spend-toggle").click();
    await page.locator(".cw-spend-canvas .cw-spend-card").getByRole("button", {name: en ? "Cancel request" : "取消申请"}).click();
    await until(() => call(groupPath), s => s.spendRequests.at(-1).status === "cancelled");
    assert.equal(posts.length - before, 6);
    assert.deepEqual(errors, []);
    console.log(locale, "two-step workflow preview USD 0.80, entire workflow cancelled with zero calls");
    await page.close();
  }
} finally {
  await browser.close();
  service.close();
  if (model) await call(`/api/model-configs/${model.id}`, null, "DELETE");
}
