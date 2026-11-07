/** MOSS speech UI with an isolated WAV fixture; no real MOSS synthesis call. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5189";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8029";
const output = process.env.MOSS_SCREENSHOT_DIR ?? "/tmp/opendirector-moss-speech-evidence";
const defaultVoiceId = "2890a3a4-0012-4997-a545-8b045fe83bbe";
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
  "zh-CN": { tools: "画布创作工具", add: "添加音频", picker: "生成模型", prompt: "朗读文本", voice: "音色 ID（必填）", placeholder: "请输入音色 ID", library: "MOSS 音色库", help: "在 MOSS 音色库选择音色，打开该音色的菜单，复制音色 ID，再粘贴到音色 ID 输入框。", generate: "提交生成", saved: "已保存到本机", voiceError: "请填写 MOSS 账户可用的音色 ID。" },
  "en-US": { tools: "Canvas creation tools", add: "Add Audio", picker: "Generation model", prompt: "Text to read", voice: "Voice ID (required)", placeholder: "Enter a Voice ID", library: "MOSS voice library", help: "Choose a voice in the MOSS voice library, open its menu, copy its Voice ID, and paste it into the Voice ID field.", generate: "Generate", saved: "Saved on this device", voiceError: "Enter a Voice ID available to your MOSS account." },
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
      assert.equal(await voice.inputValue(), defaultVoiceId);
      await until(async () => (await state()).generationSpecs[0]?.parameters.voice === defaultVoiceId);
      assert.equal(await voice.getAttribute("placeholder"), labels.placeholder);
      assert.equal(await voice.getAttribute("aria-required"), "true");
      assert.equal(await voice.evaluate(input => input.required), true);
      const library = page.getByRole("link", { name: labels.library, exact: true });
      assert.equal(await library.getAttribute("href"), "https://create.moss.cn/voice/library");
      assert.equal(await library.getAttribute("title"), labels.help);
      const alternateLocale = locale === "zh-CN" ? "en-US" : "zh-CN";
      const alternate = copy[alternateLocale];
      const languageButtons = page.locator(".cw-language-toggle button");
      await languageButtons.nth(alternateLocale === "zh-CN" ? 0 : 1).click();
      assert.equal(await page.locator("html").getAttribute("lang"), alternateLocale);
      assert.equal(await page.getByRole("link", { name: alternate.library, exact: true }).getAttribute("title"), alternate.help);
      assert.equal(await page.getByRole("textbox", { name: alternate.voice, exact: true }).inputValue(), defaultVoiceId);
      await languageButtons.nth(locale === "zh-CN" ? 0 : 1).click();
      const generate = page.getByRole("button", { name: labels.generate, exact: true });
      assert.equal(await generate.isEnabled(), true);
      await page.screenshot({ path: join(output, `${locale}-mock-speech-default-voice.png`), fullPage: true });
      await voice.fill("");
      await until(async () => (await state()).generationSpecs[0]?.parameters.voice === null);
      assert.equal(await voice.inputValue(), "");
      assert.equal(await generate.isDisabled(), true);
      await page.screenshot({ path: join(output, `${locale}-mock-speech-voice-required.png`), fullPage: true });
      await voice.fill("音色");
      await until(async () => (await state()).generationSpecs[0]?.parameters.voice === "音色");
      assert.equal(await generate.isDisabled(), true);
      await voice.fill(voiceId);
      await until(async () => (await state()).generationSpecs[0]?.parameters.voice === voiceId);
      await page.getByRole("combobox", { name: labels.picker, exact: true }).click();
      await page.getByRole("listbox", { name: labels.picker, exact: true }).locator(`[data-option-id="config:${config.id}"]`).click();
      assert.equal(await voice.inputValue(), voiceId);
      assert.equal((await state()).generationSpecs[0]?.parameters.voice, voiceId);
      const callsBefore = (await call("/api/creation-test-health")).calls.length;
      const rejectSubmission = async route => {
        const body = route.request().postDataJSON();
        if (body?.type !== "generation.submit") return route.continue();
        const spec = (await state()).generationSpecs.find(spec => spec.id === body.payload.specId);
        const updateResponse = await route.fetch({ postData: JSON.stringify({
          commandId: crypto.randomUUID(), projectId, type: "generationSpec.update",
          expectedVersions: [{ objectType: "generation_spec", id: spec.id, revision: spec.revision }],
          payload: { spec: { ...spec, parameters: { ...spec.parameters, voice: "音色" } } },
        }) });
        const updated = await updateResponse.json();
        assert.equal(updated.status, "applied");
        const revision = updated.changed.find(change => change.objectType === "generation_spec").revision;
        const response = await route.fetch({ postData: JSON.stringify({
          ...body,
          expectedVersions: body.expectedVersions.map(version =>
            version.objectType === "generation_spec" ? { ...version, revision } : version),
          payload: { ...body.payload, expectedSpecRevision: revision },
        }) });
        await route.fulfill({ response });
      };
      await page.route("**/commands", rejectSubmission);
      const [rejectedResponse] = await Promise.all([
        page.waitForResponse(response =>
          response.url().endsWith(`/api/creation/projects/${projectId}/commands`)
            && response.request().method() === "POST"
            && response.request().postDataJSON()?.type === "generation.submit"),
        generate.click(),
      ]);
      await page.unroute("**/commands", rejectSubmission);
      const rejected = await rejectedResponse.json();
      assert.equal(rejected.status, "rejected");
      assert.equal(rejected.issues[0].code, "moss_speech_voice");
      assert.equal(rejected.issues[0].message, labels.voiceError);
      await page.getByText(labels.voiceError, { exact: true }).waitFor();
      assert.equal((await state()).jobs.length, 0);
      assert.equal((await call("/api/creation-test-health")).calls.length, callsBefore);
      await page.screenshot({ path: join(output, `${locale}-mock-speech-invalid-voice.png`), fullPage: true });
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
    checks: ["default Voice ID persists and enables generation", "voice library link and localized instructions", "selected UUID survives model selection and reopens", "cleared voice stays empty and blocks generation", "invalid voice preserves code and localized rejection without a job or model call", "audio asset", "actual audio element playback", "reopen without duplicate generation"] }));
} finally {
  await browser.close();
}
