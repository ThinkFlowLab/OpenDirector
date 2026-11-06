/** MOSS speech UI with an isolated WAV fixture; no real MOSS synthesis call. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5189";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8029";
const output = process.env.MOSS_SCREENSHOT_DIR ?? "/tmp/opendirector-moss-speech-evidence";
const voiceId = "11111111-2222-4333-8444-555555555555";
const headers = { "X-OpenDirector-Request": "1", "Content-Type": "application/json" };
async function call(path, body) {
  const response = await fetch(api + path, { headers, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function until(check) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error("Expected saved speech input or audio result not observed");
}
const health = await call("/api/creation-test-health");
assert.equal(health.isolated, true);
assert.equal(health.provider, "fixture");
const webHealth = await (await fetch(base + "/api/creation-test-health", { headers })).json();
assert.equal(webHealth.root, health.root);
await call("/api/creation-test-gate", { open: true });
let config = (await call("/api/model-configs")).find(item => item.kind === "audio" && item.modelId === "moss-tts-1.5-flash" && item.url === "https://api.mosi.cn/v1");
config ??= await call("/api/model-configs", {
  kind: "audio", modelId: "moss-tts-1.5-flash", url: "https://api.mosi.cn/v1", apiKey: "fixture-only-no-real-service",
  connectionType: "api", protocol: "openai", authMode: "bearer",
});
assert.equal(config.inputRules.voiceRequired, true);
assert.equal(config.inputRules.referencesAllowed, false);
await mkdir(output, { recursive: true });
const copy = {
  "zh-CN": { tools: "画布创作工具", add: "添加音频", picker: "生成模型", prompt: "朗读文本", voice: "音色 ID（必填）", placeholder: "请输入音色 ID", library: "MOSS 音色库", generate: "提交生成", saved: "已保存到本机" },
  "en-US": { tools: "Canvas creation tools", add: "Add Audio", picker: "Generation model", prompt: "Text to read", voice: "Voice ID (required)", placeholder: "Enter a Voice ID", library: "MOSS voice library", generate: "Generate", saved: "Saved on this device" },
};
const browser = await launchBrowser();
const errors = [];
const projects = [];
try {
  for (const locale of ["zh-CN", "en-US"]) {
    const labels = copy[locale];
    const projectId = crypto.randomUUID();
    projects.push(projectId);
    await call(`/api/creation/projects/${projectId}/commands`, { commandId: crypto.randomUUID(), projectId,
      type: "project.create", payload: { name: `MOSS speech WAV fixture ${locale} ${projectId.slice(0, 8)}` } });
    const state = () => call(`/api/creation/projects/${projectId}`);
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://api.mosi.cn/**", route => { errors.push("Browser attempted a real model call"); return route.abort(); });
    await page.addInitScript(locale => {
      localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
      localStorage.setItem("opendirector.locale.v1", locale);
    }, locale);
    try {
      await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
      await page.getByText(labels.saved, { exact: true }).waitFor();
      await page.getByRole("toolbar", { name: labels.tools }).getByRole("button", { name: labels.add, exact: true }).click();
      await page.getByRole("combobox", { name: labels.picker, exact: true }).click();
      await page.getByRole("listbox", { name: labels.picker, exact: true }).locator(`[data-option-id="config:${config.id}"]`).click();
      await page.getByRole("textbox", { name: labels.prompt, exact: true }).fill("Local fixture playback for MOSS speech UI.");
      const voice = page.getByRole("textbox", { name: labels.voice, exact: true });
      assert.equal(await voice.inputValue(), "");
      assert.equal(await voice.getAttribute("placeholder"), labels.placeholder);
      assert.equal(await voice.getAttribute("aria-required"), "true");
      assert.equal(await voice.evaluate(input => input.required), true);
      assert.equal(await page.getByRole("link", { name: labels.library, exact: true }).getAttribute("href"), "https://create.moss.cn/");
      const generate = page.getByRole("button", { name: labels.generate, exact: true });
      assert.equal(await generate.isDisabled(), true);
      await page.screenshot({ path: join(output, `${locale}-mock-speech-voice-required.png`), fullPage: true });
      await voice.fill(voiceId);
      await until(async () => (await state()).generationSpecs[0]?.parameters.voice === voiceId);
      assert.equal(await generate.isEnabled(), true);
      await generate.click();
      await until(async () => (await state()).jobs[0]?.status === "succeeded");
      const snapshot = await state();
      const asset = snapshot.assets.find(asset => asset.id === snapshot.results[0].asset.assetId);
      assert.equal(asset.kind, "audio");
      assert.ok(asset.metadata.durationSeconds > 0);
      const player = page.locator(".cw-audio-preview audio");
      await player.waitFor();
      await player.evaluate(audio => audio.play());
      await page.waitForFunction(() => document.querySelector(".cw-audio-preview audio")?.ended);
      assert.ok(await player.evaluate(audio => audio.currentTime > 0 && audio.duration > 0 && audio.error === null));
      await page.screenshot({ path: join(output, `${locale}-mock-speech-wav-played.png`), fullPage: true });
      await page.reload();
      await page.getByText(labels.saved, { exact: true }).waitFor();
      const reopened = await state();
      assert.equal(reopened.jobs.length, 1);
      assert.equal(reopened.results[0].asset.assetId, asset.id);
      await page.locator(".react-flow__node").first().click();
      assert.equal(await page.getByRole("textbox", { name: labels.voice, exact: true }).inputValue(), voiceId);
      assert.ok(await page.locator(".cw-audio-preview audio").evaluate(audio => Boolean(audio.currentSrc || audio.src)));
    } catch (error) {
      await page.screenshot({ path: join(output, `${locale}-mock-speech-failure.png`), fullPage: true }).catch(() => {});
      throw error;
    } finally {
      await page.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, fixture: "local WAV, no real MOSS synthesis", locales: Object.keys(copy), projects, screenshotDirectory: output,
    checks: ["required manual Voice ID", "missing voice blocks generation", "UUID persists and reopens", "audio asset", "actual audio element playback", "reopen without duplicate generation"] }));
} finally {
  await browser.close();
}
