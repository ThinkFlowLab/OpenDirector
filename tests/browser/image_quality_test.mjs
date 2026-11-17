import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./engine.mjs";
import { chooseGenerationModel } from "./model_picker.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const output = process.env.CREATION_SCREENSHOTS ?? "output/playwright";
async function call(path, body) {
  const response = await fetch(api + path, {
    headers: { "X-OpenDirector-Request": "1", "Content-Type": "application/json" },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function until(check) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Expected quality, frozen job, or result was not observed");
}
assert.equal((await call("/api/creation-test-health")).isolated, true);
await call("/api/creation-test-gate", { open: true });
await mkdir(output, { recursive: true });
const browser = await launchBrowser();
const errors = [];
try {
  for (const locale of ["zh-CN", "en-US"]) {
    const labels = locale === "zh-CN" ? {
      saved: "已保存到本机", toolbar: "画布创作工具", add: "添加图片",
      prompt: "生成提示词", parameters: "生成参数", panel: "生成参数设置",
      close: "关闭参数", quality: "图片质量", values: ["自动", "低", "中", "高"],
      generate: "提交生成",
    } : {
      saved: "Saved on this device", toolbar: "Canvas creation tools", add: "Add Image",
      prompt: "Prompt", parameters: "Generation settings", panel: "Generation settings",
      close: "Close settings", quality: "Image quality", values: ["Auto", "Low", "Medium", "High"],
      generate: "Generate",
    };
    const models = [];
    for (const modelId of ["gpt-image-2", "quality-compatible-fixture"]) {
      models.push(await call("/api/model-configs", {
        kind: "image", modelId, url: "http://127.0.0.1:12345/v1",
        apiKey: "", connectionType: "self_hosted", authMode: "none", protocol: "openai",
      }));
    }
    const id = crypto.randomUUID();
    await call(`/api/creation/projects/${id}/commands`, {
      commandId: crypto.randomUUID(), projectId: id,
      type: "project.create", payload: { name: `Image quality ${locale} ${id.slice(0, 8)}` },
    });
    const state = () => call(`/api/creation/projects/${id}`);
    const page = await browser.newPage({ locale, viewport: { width: 1600, height: 1100 } });
    await page.addInitScript((locale) => {
      localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
      localStorage.setItem("opendirector.locale.v1", locale);
    }, locale);
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(15000);
    try {
      await page.goto(`${base}/ai-tool/ai-canvas/${id}`);
      await page.getByText(labels.saved, { exact: true }).waitFor();
      await page.getByRole("toolbar", { name: labels.toolbar }).getByRole("button", { name: labels.add, exact: true }).click();
      await chooseGenerationModel(page, `config:${models[0].id}`);
      await page.getByRole("textbox", { name: labels.prompt, exact: true }).fill("A lighthouse by the sea");
      const open = () => page.getByRole("button", { name: labels.parameters, exact: true }).click();
      const panel = page.getByRole("dialog", { name: labels.panel });
      const qualityButton = (value) => panel.getByRole("button", { name: `${labels.quality} ${value}`, exact: true });
      const close = () => page.getByRole("button", { name: labels.close, exact: true }).click();
      await open();
      for (const value of labels.values) await qualityButton(value).waitFor();
      assert.equal(await qualityButton(labels.values[0]).getAttribute("aria-pressed"), "true");
      await qualityButton(labels.values[3]).click();
      await until(async () => (await state()).generationSpecs[0]?.parameters.quality === "high");
      await page.screenshot({ path: `${output}/image-quality-${locale}.png` });
      if (locale === "zh-CN") {
        await page.getByRole("button", { name: "EN", exact: true }).click();
        if (!(await page.getByRole("dialog", { name: "Generation settings", exact: true }).isVisible()))
          await page.getByRole("button", { name: "Generation settings", exact: true }).click();
        await page.getByRole("button", { name: "Image quality High", exact: true }).waitFor();
        assert.equal(await page.getByRole("button", { name: "Image quality High", exact: true }).getAttribute("aria-pressed"), "true");
        await page.getByRole("button", { name: "中文", exact: true }).click();
        if (!(await panel.isVisible())) await open();
        await qualityButton(labels.values[3]).waitFor();
      }
      await close();
      await page.reload();
      await page.getByText(labels.saved, { exact: true }).waitFor();
      await page.locator(".react-flow__node").first().click();
      await open();
      assert.equal(await qualityButton(labels.values[3]).getAttribute("aria-pressed"), "true");
      await close();
      await page.getByRole("button", { name: labels.generate, exact: true }).click();
      await until(async () => (await state()).jobs[0]?.status === "succeeded");
      const snapshot = await state();
      const job = snapshot.jobs[0];
      assert.equal(job.inputSnapshot.spec.parameters.quality, "high");
      assert.equal(job.execution.quality, "high");
      assert.equal(job.adapterParameters.quality, "high");
      assert.equal(job.adopted, true);
      const sent = (await call("/api/creation-test-health")).calls.find((call) => call.id === job.id);
      assert.equal(sent.parameters.quality, "high");
      const asset = snapshot.assets.find((asset) => asset.id === job.asset.assetId);
      assert.equal(asset.metadata.mimeType, "image/png");
      assert.ok(asset.metadata.width > 0 && asset.metadata.height > 0);
      await page.locator(".react-flow__node img").first().evaluate((image) => image.decode());
      await chooseGenerationModel(page, `config:${models[1].id}`);
      await until(async () => {
        const spec = (await state()).generationSpecs[0];
        return spec.modelConfigId === models[1].id && spec.parameters.quality === undefined;
      });
      await open();
      assert.equal(await panel.getByRole("button", { name: new RegExp(`^${labels.quality} `) }).count(), 0);
      await close();
      await chooseGenerationModel(page, `config:${models[0].id}`);
      await open();
      assert.equal(await qualityButton(labels.values[0]).getAttribute("aria-pressed"), "true");
      await qualityButton(labels.values[3]).click();
      await until(async () => (await state()).generationSpecs[0]?.parameters.quality === "high");
      await qualityButton(labels.values[0]).click();
      await until(async () => (await state()).generationSpecs[0]?.parameters.quality === undefined);
      await close();
      await chooseGenerationModel(page, `config:${models[1].id}`);
      await until(async () => (await state()).generationSpecs[0]?.modelConfigId === models[1].id);
      await open();
      assert.equal(await panel.getByRole("button", { name: new RegExp(`^${labels.quality} `) }).count(), 0);
      await close();
      await page.getByRole("button", { name: labels.generate, exact: true }).click();
      await until(async () => (await state()).jobs.length === 2 && (await state()).jobs[1]?.status === "succeeded");
      const after = await state();
      assert.equal(after.jobs[0].inputSnapshot.spec.parameters.quality, "high");
      assert.equal(after.jobs[1].adapterParameters.quality, undefined);
      await page.reload();
      await page.getByText(labels.saved, { exact: true }).waitFor();
      assert.equal((await state()).jobs.length, 2);
      console.log(`PASS ${locale}: quality controls, save/reopen, frozen request, real PNG, Auto and compatible model`);
    } catch (error) {
      await page.screenshot({ path: `${output}/image-quality-${locale}-failure.png`, fullPage: true }).catch(() => {});
      throw error;
    } finally {
      await page.close();
    }
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
