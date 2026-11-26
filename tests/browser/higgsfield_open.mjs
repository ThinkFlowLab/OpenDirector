/** Run with higgsfield_server.py: actual adapters, fixture HTTP, no paid calls. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5504";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8504";
const output = process.env.CREATION_SCREENSHOTS ?? "output/playwright/higgsfield";
const headers = { "X-OpenDirector-Request": "1", "Content-Type": "application/json" };
async function call(path, body, method = body ? "POST" : "GET") {
  const response = await fetch(api + path, { headers, method, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, await response.clone().text());
  return response.status === 204 ? null : response.json();
}
async function until(read, accept, label) {
  const deadline = Date.now() + 20000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    assert.ok(Date.now() < deadline, `${label}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
async function newProject(name) {
  const id = crypto.randomUUID();
  await call(`/api/creation/projects/${id}/commands`, {
    commandId: crypto.randomUUID(), projectId: id, type: "project.create", payload: { name: `${name} ${id.slice(0, 8)}` },
  });
  return id;
}
assert.equal((await call("/api/magi2-test-health")).provider, "higgsfield-mock-http");
await mkdir(output, { recursive: true });
const browser = await launchBrowser();
const evidence = [];
const copy = {
  "en-US": {
    settings: "Settings", models: "Model connections", overview: "Video model", add: "Add service",
    provider: "Provider", url: "Service URL (Base URL)", save: "Save service", close: "Close settings",
    saved: "Saved on this device", upload: "Choose local asset files", generate: "Generate",
    summary: "Text-to-video / first-last frames / image, video and audio references",
    error: "Use MP4 video and WAV audio references. Convert MOV to MP4 and MP3 to WAV before uploading.",
    settingsButton: "Generation settings", mode: "Video mode", settingsClose: "Close settings",
    audio: "Generate audio",
  },
  "zh-CN": {
    settings: "设置", models: "模型接入", overview: "视频模型", add: "添加服务",
    provider: "提供商", url: "服务地址（Base URL）", save: "保存服务", close: "关闭设置",
    saved: "已保存到本机", upload: "选择本地素材文件", generate: "提交生成",
    summary: "文生视频 / 首尾帧 / 图片、视频和音频参考",
    error: "参考视频需为 MP4，音频需为 WAV。MOV 请先转换为 MP4，MP3 请先转换为 WAV。",
    settingsButton: "生成参数", mode: "视频创作模式", settingsClose: "关闭参数",
    audio: "生成音频",
  },
};
try {
  for (const locale of ["en-US", "zh-CN"]) {
    const text = copy[locale];
    for (const model of await call("/api/model-configs")) {
      if (model.protocol === "higgsfield_open") await call(`/api/model-configs/${model.id}`, undefined, "DELETE");
    }
    const page = await browser.newPage({ locale, viewport: { width: 1600, height: 1050 } });
    page.setDefaultTimeout(20000);
    await page.addInitScript((value) => {
      localStorage.setItem("opendirector.locale.v1", value);
      localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    }, locale);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const project = await newProject(`MAGI-2 settings ${locale}`);
    await page.goto(`${base}/ai-tool/ai-canvas/${project}?creation=unified`);
    await page.getByText(text.saved, { exact: true }).waitFor();
    await page.getByRole("button", { name: text.settings, exact: true }).click();
    await page.getByRole("button", { name: text.models, exact: true }).click();
    await page.locator(".cw-model-setup-row").filter({ hasText: text.overview }).getByRole("button").click();
    await page.getByRole("button", { name: text.add, exact: true }).click();
    await page.getByRole("combobox", { name: text.provider, exact: true }).click();
    await page.getByRole("option", { name: "Higgsfield Open", exact: true }).click();
    assert.equal(await page.getByLabel(text.url, { exact: true }).inputValue(), "https://api.higgsfield.ai");
    assert.equal(await page.getByLabel("API Key", { exact: true }).getAttribute("placeholder"), "KEY_ID:KEY_SECRET");
    await page.getByLabel("API Key", { exact: true }).fill("fixture-id:fixture-secret");
    await page.getByRole("checkbox", { name: "sand/magi-2", exact: true }).check();
    await page.getByText(text.summary, { exact: true }).waitFor();
    await page.getByText("1080P", { exact: true }).waitFor();
    await page.screenshot({ path: join(output, `provider-${locale}.png`), fullPage: true });
    await page.getByText(text.summary, { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(output, `capabilities-${locale}.png`), fullPage: true });
    await page.getByRole("button", { name: text.save, exact: true }).click();
    await page.getByRole("button", { name: text.add, exact: true }).waitFor();
    await page.getByRole("button", { name: text.close, exact: true }).click();
    const model = (await call("/api/model-configs")).find((item) => item.protocol === "higgsfield_open");
    assert.equal(model.modelId, "sand/magi-2");
    assert.equal(model.inputRules.videoCapabilities.defaultDuration, 5);

    for (const scenario of [
      { name: "text", mode: "reference", files: [], roles: [], prompt: "A blue sphere moves slowly" },
      { name: "frames", mode: "first_frame", files: ["image.png", "image.png"], roles: ["first_frame", "last_frame"], prompt: "" },
      { name: "mixed", mode: "reference", files: ["image.png", "video.mp4", "audio.wav"], roles: ["reference", "reference", "reference"], prompt: "" },
      { name: "unsupported", mode: "reference", files: ["unsupported.mp3"], roles: ["reference"], prompt: "Animate" },
    ]) {
      const projectId = await newProject(`MAGI-2 ${scenario.name} ${locale}`);
      const snapshot = () => call(`/api/creation/projects/${projectId}`);
      await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
      await page.getByText(text.saved, { exact: true }).waitFor();
      for (const [index, name] of scenario.files.entries()) {
        const response = await fetch(api + `/api/magi2-test-media/${name}`, { headers });
        assert.ok(response.ok);
        await page.getByLabel(text.upload, { exact: true }).setInputFiles({
          name: `${index}-${name}`, mimeType: response.headers.get("content-type"), buffer: Buffer.from(await response.arrayBuffer()),
        });
        await until(snapshot, (value) => value.canvasItems.length === index + 1, "upload asset");
      }
      const sources = (await snapshot()).canvasItems;
      const created = await page.evaluate(async ({ projectId, modelId, sources, scenario }) => {
        const { creationClient } = await import("/src/backend/creationClient.ts");
        const client = creationClient(projectId);
        await client.refresh();
        const specId = crypto.randomUUID(), itemId = crypto.randomUUID();
        const receipt = await client.command("canvas.createGeneration", {
          spec: {
            id: specId, projectId, kind: "video", purpose: "generation", modelConfigId: modelId,
            prompt: scenario.prompt, parameters: { videoMode: scenario.mode, resolution: "1080P", durationSeconds: 4, aspectRatio: scenario.name === "frames" ? "9:16" : "16:9", generateAudio: true },
          },
          item: { id: itemId, projectId, kind: "video", position: { x: 450, y: 80 }, binding: { role: "generation", objectRef: { id: specId } } },
          references: scenario.roles.map((role, index) => ({ id: crypto.randomUUID(), projectId, targetSpecId: specId,
            binding: "follow_current", source: { id: sources[index].id }, role, order: index })),
        });
        assertReceipt(receipt);
        function assertReceipt(value) { if (value.status !== "applied") throw Error(JSON.stringify(value)); }
        return { specId, itemId };
      }, { projectId, modelId: model.id, sources, scenario });
      await page.reload();
      await page.locator(`.react-flow__node[data-id="${created.itemId}"]`).click();
      await page.getByRole("button", { name: text.settingsButton, exact: true }).click();
      await page.getByLabel(text.audio, { exact: true }).uncheck();
      await until(snapshot, (value) => value.generationSpecs.find((spec) => spec.id === created.specId)?.parameters.generateAudio === false, "audio disabled");
      if (scenario.name === "frames")
        await page.screenshot({ path: join(output, `parameters-${locale}.png`), fullPage: true });
      await page.getByRole("button", { name: text.settingsClose, exact: true }).click();
      await page.getByRole("button", { name: text.generate, exact: true }).click();
      if (scenario.name === "unsupported") {
        await page.getByText(text.error, { exact: false }).first().waitFor();
        assert.equal((await snapshot()).jobs.length, 0);
        await page.screenshot({ path: join(output, `format-error-${locale}.png`), fullPage: true });
        evidence.push({ locale, scenario: scenario.name, rejectedBeforeJob: true });
        continue;
      }
      const result = await until(snapshot, (value) => value.jobs.some((job) => job.status === "succeeded"), scenario.name);
      const job = result.jobs[0];
      assert.equal(job.adopted, true);
      assert.equal(job.execution.generateAudio, false);
      const expected = scenario.name === "text" ? "text-to-video" : scenario.name === "frames" ? "image-to-video" : "reference-to-video";
      const sent = (await call("/api/magi2-test-health")).calls.find((request) => request.key === job.id);
      assert.equal(sent.path, `/sand/magi-2/${expected}`);
      assert.equal(sent.payload.generate_audio, false);
      assert.equal(sent.payload.aspect_ratio, scenario.name === "frames" ? "9:16" : "16:9");
      assert.equal("prompt" in sent.payload, scenario.name === "text");
      if (scenario.name === "mixed") {
        for (const kind of ["image", "video", "audio"]) assert.equal(sent.payload[`${kind}_urls`].length, 1);
      }
      await page.reload();
      await page.getByText(text.saved, { exact: true }).waitFor();
      await page.locator(`.react-flow__node[data-id="${created.itemId}"]`).click();
      await page.waitForFunction((id) => [...document.querySelectorAll(`.react-flow__node[data-id="${id}"] video`)]
        .some((video) => video.readyState >= 2), created.itemId);
      await page.screenshot({ path: join(output, `${scenario.name}-${locale}.png`), fullPage: true });
      assert.deepEqual((await snapshot()).jobs, result.jobs);
      assert.equal((await call("/api/magi2-test-health")).calls.filter((request) => request.key === job.id).length, 1);
      evidence.push({ locale, scenario: scenario.name, projectId, jobId: job.id, assetId: job.asset.assetId, path: sent.path });
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  await writeFile(join(output, "acceptance.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: true, scenarios: evidence.length, output }));
} finally {
  await browser.close();
}
