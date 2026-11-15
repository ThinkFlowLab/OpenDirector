/** Real Moonshot Kimi evidence: the mainland chat preset drives the Default agent.
 * Requires a running OpenDirector (OPENDIRECTOR_URL and OPENDIRECTOR_API) on an
 * isolated OPENDIRECTOR_ROOT and MOONSHOT_API_KEY for a funded Moonshot account.
 * Contacts the real service and incurs charges. It writes one text asset.
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./engine.mjs";

const web = process.env.OPENDIRECTOR_URL ?? "http://127.0.0.1:5190";
const api = process.env.OPENDIRECTOR_API ?? "http://127.0.0.1:8040";
const key = process.env.MOONSHOT_API_KEY;
const output = process.env.KIMI_SCREENSHOTS ?? "/tmp/opendirector-kimi-evidence";
assert.ok(key, "Set MOONSHOT_API_KEY");
const url = "https://api.moonshot.cn/v1";
const headers = { "X-OpenDirector-Request": "1", "Content-Type": "application/json" };
async function call(path, body, method) {
  const response = await fetch(api + path, {
    headers, method: method ?? (body ? "POST" : "GET"),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.status === 204 ? null : response.json();
}
async function until(check, label, attempts = 900) {
  for (let i = 0; i < attempts; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw Error("Not observed: " + label);
}

assert.equal((await call("/api/creation-test-health")).isolated, true);
// The isolated server seeds a fixture agent connection; drop every agent
// connection so this real one is the default and the picker stays readable.
for (const item of (await call("/api/model-configs")).filter((entry) => entry.kind === "agent")) {
  await call(`/api/model-configs/${item.id}`, undefined, "DELETE");
}
const config = await call("/api/model-configs", {
  kind: "agent", url, modelId: "kimi-k3", apiKey: key,
  connectionType: "api", protocol: "openai", authMode: "bearer",
});
assert.equal(config.url, url);
// The preset deliberately pins no model list, so discovery must reach the service.
const discovered = await call("/api/model-configs/discover", {
  kind: "agent", url, modelId: config.modelId, apiKey: key, configId: config.id,
  connectionType: "api", protocol: "openai", authMode: "bearer",
});
assert.ok(discovered.models.includes("kimi-k3"), JSON.stringify(discovered));

const projectId = crypto.randomUUID();
await call(`/api/creation/projects/${projectId}/commands`, {
  commandId: crypto.randomUUID(), projectId, type: "project.create",
  payload: { name: `Kimi ${projectId.slice(0, 8)}` },
});
const state = () => call(`/api/creation/projects/${projectId}`);
const assets = async () => (await state()).assets;

await mkdir(output, { recursive: true });
const browser = await launchBrowser();
// Markdown rendering drops backticks and emphasis, so compare the visible text.
const flatten = (text) => (text ?? "").replace(/[`*_\s]/g, "");
const errors = [];
const prompt = {
  "zh-CN": "请把这个句子保存成工程里的一个文本素材，文件名用 kimi-note.txt：「Kimi 在 OpenDirector 中写入的第一段文字。」保存好后用一句话确认。",
  "en-US": "Save this sentence as a text asset named kimi-note.txt: “The first line Kimi wrote inside OpenDirector.” Then confirm in one sentence.",
}[process.env.KIMI_LOCALE ?? "zh-CN"];
try {
  for (const locale of ["zh-CN", "en-US"]) {
    const page = await browser.newPage({ locale, viewport: { width: 1500, height: 1000 } });
    page.setDefaultTimeout(60000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      // The API key never reaches the browser: all provider traffic stays server side.
      if (/moonshot\.(cn|ai)/.test(request.url())) errors.push("Browser contacted Moonshot directly");
    });
    await page.addInitScript(([id, language]) => {
      // Pin the UI language before first paint so the assertions below are stable.
      localStorage.setItem("opendirector.locale.v1", language);
      localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
      localStorage.setItem("opendirector.lastUnifiedFilesystemProject", id);
    }, [projectId, locale]);

    // 1. The preset shows the mainland endpoint before the key is entered.
    const settings = page.getByRole("button", {
      name: locale === "zh-CN" ? "设置" : "Settings", exact: true,
    });
    // A just-closed tab may still hold the project lease for up to a minute.
    const loading = page.locator(".canvas-loading-screen");
    for (let attempt = 1; ; attempt++) {
      await page.goto(`${web}/ai-tool/ai-canvas/${projectId}?creation=unified`);
      const ready = await loading.waitFor({ state: "detached", timeout: 20000 }).then(() => true, () => false);
      if (ready) break;
      assert.ok(attempt < 12, "canvas stays leased by the previous tab");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    await settings.click();
    await page.getByRole("button", {
      name: locale === "zh-CN" ? "模型接入" : "Model connections", exact: true,
    }).click();
    await page.locator(".cw-model-setup-row")
      .filter({ hasText: locale === "zh-CN" ? "文本模型" : "Text model" })
      .getByRole("button").click();
    await page.getByRole("button", { name: locale === "zh-CN" ? "对话" : "Chat", exact: true }).click();
    await page.getByRole("button", { name: locale === "zh-CN" ? "添加服务" : "Add service", exact: true }).click();
    await page.getByRole("combobox", { name: locale === "zh-CN" ? "提供商" : "Provider", exact: true }).click();
    await page.getByRole("listbox", { name: locale === "zh-CN" ? "提供商" : "Provider", exact: true })
      .getByRole("option", { name: locale === "zh-CN" ? "月之暗面 Kimi" : "Moonshot Kimi", exact: true })
      .click();
    const urlField = locale === "zh-CN" ? "服务地址（Base URL）" : "Service URL (Base URL)";
    assert.equal(await page.getByLabel(urlField).inputValue(), url);
    await page.screenshot({ path: `${output}/${locale}-1-preset.png` });
    await page.getByRole("button", { name: locale === "zh-CN" ? "取消" : "Cancel", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    if (locale === "en-US") { await page.close(); continue; }

    // 2. A real turn: the Default agent calls the bundled CLI and writes the asset.
    const panel = page.getByRole("complementary", { name: "AI 对话", exact: true });
    if (!(await panel.isVisible()))
      await page.getByRole("button", { name: "与 AI 对话", exact: true }).click();
    const editor = panel.getByRole("textbox", { name: "消息内容", exact: true });
    await editor.waitFor();
    await editor.fill(prompt);
    await panel.getByRole("button", { name: "发送消息", exact: true }).click();
    const conversation = () => call(`/api/creation/projects/${projectId}/assistant`);
    await until(async () => (await conversation()).messages.at(-1)?.status === "complete", "reply");
    const reply = (await conversation()).messages.at(-1);
    assert.equal(reply.model, "kimi-k3");
    assert.ok(reply.text.trim().length > 0);
    await until(async () => flatten(await panel.textContent()).includes(flatten(reply.text).slice(0, 16)), "rendered reply");
    await page.screenshot({ path: `${output}/zh-CN-2-reply.png` });

    // 3. The asset exists, was written by the agent, and names the Kimi model.
    const [asset] = await until(async () => {
      const list = (await assets()).filter((item) => item.name === "kimi-note.txt");
      return list.length ? list : null;
    }, "asset");
    assert.equal(asset.kind, "text");
    assert.equal(asset.provenance.source, "agent_written");
    assert.equal(asset.provenance.modelSnapshot.modelId, "kimi-k3");
    assert.equal(asset.provenance.modelSnapshot.url, url);
    await page.screenshot({ path: `${output}/zh-CN-3-canvas.png` });
    // 4. The asset list shows the file; adding it puts a text node on the canvas.
    const listing = page.getByRole("dialog", { name: "资产列表" });
    await page.getByRole("button", { name: "资产列表", exact: true }).click();
    await listing.getByText("kimi-note.txt", { exact: false }).first().waitFor();
    await page.screenshot({ path: `${output}/zh-CN-4-assets.png` });
    await listing.getByText("kimi-note.txt", { exact: false }).first().click();
    const node = page.locator(".react-flow").getByText("kimi-note.txt", { exact: false }).first();
    await node.waitFor();
    await page.screenshot({ path: `${output}/zh-CN-5-node.png` });

    // 5. Reopening the project still shows the node on the canvas.
    await page.reload();
    await node.waitFor();
    await page.screenshot({ path: `${output}/zh-CN-6-reopen.png` });
    await page.close();
  }
} finally {
  await browser.close();
}
assert.deepEqual(errors, []);
console.log("Kimi evidence written to " + output);
