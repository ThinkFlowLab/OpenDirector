/** Bilingual image admission and assistant parameter rejection. Start the isolated
 * creation server with --http-generation-fixture --assistant-fixture. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const headers = { "X-OpenDirector-Request": "1", "Content-Type": "application/json" };
async function call(path, body, method = body ? "POST" : "GET") {
  const response = await fetch(api + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, await response.clone().text());
  return response.status === 204 ? null : response.json();
}
async function until(read, accepts, label) {
  const deadline = Date.now() + 20000;
  let value;
  do {
    value = await read();
    if (accepts(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw Error(`${label}: ${JSON.stringify(value)}`);
}
const health = await call("/api/creation-test-health");
assert.equal(health.httpGenerationFixture, true);
assert.equal(health.assistantFixture, true);
const pictures = ["red", "green", "blue"].map((color) => {
  const result = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=32x32`,
    "-frames:v", "1", "-threads", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"]);
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
});
let chatMaximum = 1024;
const posts = [];
function declaration() {
  const route = (path) => ({ transport: "http", method: "POST", path, exposure: "enabled" });
  const model = (id, operation, profile, output, path, request) => ({ id, operations: {
    [operation]: { support: "supported", exposure: "enabled", profiles: [{ id: profile,
      support: "supported", required_inputs: ["text"], outputs: [output], routes: [{ ...route(path), request }] }] },
  } });
  return { object: "omni.capabilities", schema_version: 1, observed_at: new Date().toISOString(),
    routes: [route("/v1/images/edits"), route("/v1/chat/completions")], models: [
      model("review-images", "image_edit", "image_to_image", "image", "/v1/images/edits",
        { inputs: { image: { support: "supported", min_count: 2, max_count: 2 } } }),
      model("review-assistant", "chat", "text_response", "text", "/v1/chat/completions",
        { parameters: { max_tokens: { type: "integer", maximum: chatMaximum } } }),
    ] };
}
const service = createServer(async (request, response) => {
  try {
    if (request.url === "/v1/omni/capabilities") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(declaration()));
      return;
    }
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/images/edits");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const form = await new Request("http://fixture/v1/images/edits", {
      method: "POST", headers: request.headers, body: Buffer.concat(chunks),
    }).formData();
    const fields = {}, files = [];
    for (const [name, value] of form) {
      if (typeof value === "string") fields[name] = value;
      else files.push({ name, size: value.size });
    }
    posts.push({ fields, files });
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      data: [{ b64_json: pictures[0].toString("base64") }],
    }));
  } catch (error) { response.writeHead(500).end(String(error)); }
});
service.listen(0, "127.0.0.1");
await once(service, "listening");
const browser = await launchBrowser();
const evidence = [], configs = [];
let page;
try {
  // This server owns disposable settings. Leave one assistant choice for the UI.
  for (const config of await call("/api/model-configs"))
    if (config.kind === "agent") await call(`/api/model-configs/${config.id}`, null, "DELETE");
  for (const [kind, modelId] of [["image", "review-images"], ["agent", "review-assistant"]])
    configs.push(await call("/api/model-configs", { kind, modelId,
      url: `http://127.0.0.1:${service.address().port}/v1`, apiKey: "", protocol: "openai",
      connectionType: "self_hosted", authMode: "none" }));
  for (const locale of ["en-US", "zh-CN"]) {
    const en = locale === "en-US";
    chatMaximum = 1024;
    delete headers["X-OpenDirector-Session"];
    page = await browser.newPage({ locale, viewport: { width: 1600, height: 1100 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      const session = request.headers()["x-opendirector-session"];
      if (session) headers["X-OpenDirector-Session"] = session;
    });
    await page.addInitScript((locale) => {
      localStorage.setItem("opendirector.locale.v1", locale);
      localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    }, locale);
    await page.route(/\/assistant\/runtimes(?:\?.*)?$/, (route) => route.fulfill({ json: [{
      id: "default", label: "Default", group: "default", modelSource: "settings", available: true,
      status: "ready", modelOverride: false, supportsSkills: true,
    }] }));
    const projectId = crypto.randomUUID(), path = `/api/creation/projects/${projectId}`;
    await call(path + "/commands", { type: "project.create", projectId, commandId: crypto.randomUUID(),
      payload: { name: `Input admission ${locale}` } });
    await page.goto(`${base}/ai-tool/ai-canvas/${projectId}`);
    const saved = page.getByText(en ? "Saved on this device" : "已保存到本机", { exact: true });
    await saved.waitFor();
    for (const [index, buffer] of pictures.entries()) {
      await page.getByLabel(en ? "Choose local asset files" : "选择本地素材文件", { exact: true })
        .setInputFiles({ name: `source-${index}.png`, mimeType: "image/png", buffer });
      await until(() => call(path), (s) => s.canvasItems.length === index + 1, "uploaded image");
      await saved.waitFor();
    }
    const sources = (await call(path)).canvasItems.map((item) => item.id);
    const nodes = [];
    for (const count of [1, 2, 3]) {
      nodes.push(await page.evaluate(async ({ projectId, configId, sources, count }) => {
        const { creationClient } = await import("/src/backend/creationClient.ts");
        const client = creationClient(projectId);
        await client.refresh();
        const specId = crypto.randomUUID(), itemId = crypto.randomUUID();
        const receipt = await client.command("canvas.createGeneration", {
          spec: { id: specId, projectId, kind: "image", purpose: "generation", modelConfigId: configId,
            prompt: "Combine these images", parameters: {} },
          item: { id: itemId, projectId, kind: "image", position: { x: count * 320, y: 500 },
            binding: { role: "generation", objectRef: { id: specId } } },
          references: sources.slice(0, count).map((sourceId, order) => ({ id: crypto.randomUUID(), projectId,
            targetSpecId: specId, binding: "follow_current", source: { id: sourceId }, role: "reference", order })),
        });
        if (receipt.status !== "applied") throw Error(JSON.stringify(receipt));
        return { specId, itemId };
      }, { projectId, configId: configs[0].id, sources, count }));
    }
    const observed = await call("/api/model-configs/availability", { configIds: configs.map((c) => c.id), manual: true });
    const imageOperations = observed.models.find((m) => m.configId === configs[0].id).operations;
    assert.equal(imageOperations.find((o) => o.profile === "image_to_image").status, "unavailable");
    assert.equal(imageOperations.find((o) => o.profile === "images_to_image").status, "available");
    const composer = page.locator(".cw-generation-composer");
    const postsBefore = posts.length;
    for (const index of [0, 2, 1]) {
      await page.locator(".cw-workspace").focus();
      await page.keyboard.press("Shift+1");
      await page.locator(`.react-flow__node[data-id="${nodes[index].itemId}"]`).click();
      await composer.waitFor();
      const run = composer.locator("button.cw-run-button");
      await until(() => run.isEnabled(), (enabled) => enabled === (index === 1), "image count admission");
      assert.match(await composer.innerText(), /Combine these images/);
      if (index !== 1) {
        assert.equal((await call(path)).jobs.length, 0);
        assert.equal(posts.length, postsBefore);
      } else await run.click();
    }
    const snapshot = await until(() => call(path), (s) => s.jobs.some((j) => j.status === "succeeded"), "image result");
    assert.equal(posts.length, postsBefore + 1);
    assert.equal(posts.at(-1).files.length, 2);
    assert.equal(snapshot.jobs.length, 1);
    assert.equal(snapshot.jobs[0].inputSnapshot.references.length, 2);
    assert.equal(snapshot.jobs[0].inputSnapshot.model.modelId, "review-images");
    assert.equal(snapshot.jobs[0].technicalCheck.status, "passed");
    const panel = page.getByRole("complementary", { name: en ? "AI chat" : "AI 对话", exact: true });
    if (!(await panel.isVisible()))
      await page.getByRole("button", { name: en ? "Chat with AI" : "与 AI 对话", exact: true }).click();
    const editor = panel.getByRole("textbox", { name: en ? "Message content" : "消息内容", exact: true });
    await editor.fill("Keep this assistant draft");
    const before = await until(() => call(path + "/assistant"),
      (s) => s.draft === "Keep this assistant draft", "saved assistant draft");
    assert.equal(before.modelSelections.agent, configs[1].id);
    const contexts = (await call("/api/creation-test-health")).assistantContexts.length;
    const rejection = page.waitForResponse((r) => r.url().endsWith("/assistant/turns") && r.status() === 409);
    await panel.getByRole("button", { name: en ? "Send message" : "发送消息", exact: true }).click();
    await rejection;
    await panel.getByText(en ? "The selected parameter does not meet the service requirements." : "所选参数不符合服务要求。", { exact: true }).waitFor();
    assert.equal(await editor.textContent(), "Keep this assistant draft");
    const rejected = await call(path + "/assistant");
    assert.deepEqual(rejected.messages, []);
    assert.equal(rejected.draft, before.draft);
    assert.deepEqual(rejected.modelSelections, before.modelSelections);
    assert.equal((await call("/api/creation-test-health")).assistantContexts.length, contexts);
    if (process.env.CREATION_SCREENSHOTS) {
      await mkdir(process.env.CREATION_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: join(process.env.CREATION_SCREENSHOTS, `input-admission-${locale}.png`) });
    }
    chatMaximum = 8192;
    await call("/api/model-configs/availability", { configIds: [configs[1].id], manual: true });
    await panel.getByRole("button", { name: en ? "Send message" : "发送消息", exact: true }).click();
    const accepted = await until(() => call(path + "/assistant"),
      (s) => s.messages.length === 2 && s.messages[1].status === "complete", "accepted assistant reply");
    assert.equal(accepted.messages[0].text, before.draft);
    assert.equal((await call("/api/creation-test-health")).assistantContexts.length, contexts + 1);
    assert.deepEqual(errors, []);
    evidence.push({ locale, imageJobs: 1, uploadedImages: 2, rejectedAssistantTurns: 0, acceptedAssistantTurns: 1 });
    await page.close();
  }
  console.log(JSON.stringify({ passed: true, evidence, posts }));
} finally {
  await browser.close();
  for (const config of configs) await call(`/api/model-configs/${config.id}`, null, "DELETE");
  await new Promise((resolve) => service.close(resolve));
}
