/** Real Zhipu GLM-TTS evidence: preset narration and the clone lifecycle through the UI.
 * Requires a running OpenDirector (OPENDIRECTOR_URL) on an isolated OPENDIRECTOR_ROOT,
 * ZHIPU_API_KEY for a funded BigModel account, and ZHIPU_SAMPLE pointing to a 3–30 s WAV.
 * Contacts the real service and incurs charges; it deletes the voice it creates.
 */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { launchBrowser } from "./engine.mjs";

const base = process.env.OPENDIRECTOR_URL ?? "http://127.0.0.1:18238";
const key = process.env.ZHIPU_API_KEY;
const sample = process.env.ZHIPU_SAMPLE;
const output = process.env.ZHIPU_SCREENSHOTS ?? "/tmp/opendirector-zhipu-evidence";
assert.ok(key && sample, "Set ZHIPU_API_KEY and ZHIPU_SAMPLE");
const headers = { "X-OpenDirector-Request": "1", "Content-Type": "application/json" };
async function call(path, body) {
  const response = await fetch(base + path, { headers, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function until(check, attempts = 900) {
  for (let i = 0; i < attempts; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw Error("Expected state was not observed");
}
const copy = {
  "zh-CN": { tools: "画布创作工具", add: "添加音频", model: "生成模型", prompt: "朗读文本", library: "音色库",
    mine: "我的音色", create: "创建音色", name: "音色名称", recording: "参考录音", transcript: "录音逐字稿（选填）",
    generate: "提交生成", saved: "已保存到本机", delete: "删除音色",
    presetText: "这是 OpenDirector 使用智谱预置音色彤彤生成的旁白。", cloneText: "这是使用刚刚复刻的音色生成的旁白。" },
  "en-US": { tools: "Canvas creation tools", add: "Add Audio", model: "Generation model", prompt: "Text to read",
    library: "Voice library", mine: "My voices", create: "Create voice", name: "Voice name", recording: "Reference recording",
    transcript: "Recording transcript (optional)", generate: "Generate", saved: "Saved on this device", delete: "Delete voice",
    presetText: "OpenDirector narration with the Zhipu preset voice Tongtong.", cloneText: "Narration with the voice that was just cloned." },
};
const config = await call("/api/model-configs", { kind: "audio", url: "https://open.bigmodel.cn/api/paas/v4", modelId: "glm-tts",
  apiKey: key, connectionType: "api", protocol: "openai", authMode: "bearer" });
assert.equal(config.inputRules.profile, "zhipu-speech");
const recording = await readFile(sample);
await mkdir(output, { recursive: true });
const browser = await launchBrowser();
const errors = [];
try {
  for (const [locale, L] of Object.entries(copy)) {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    page.setDefaultTimeout(60000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (/bigmodel\.cn|ufileos\.com/.test(request.url())) errors.push("Browser contacted provider directly");
    });
    const id = crypto.randomUUID();
    await call(`/api/creation/projects/${id}/commands`, { commandId: crypto.randomUUID(), projectId: id,
      type: "project.create", payload: { name: `GLM-TTS ${locale} ${id.slice(0, 8)}` } });
    const state = () => call(`/api/creation/projects/${id}`);
    const params = async () => (await state()).generationSpecs[0]?.parameters;
    await page.addInitScript((locale) => {
      localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
      localStorage.setItem("opendirector.locale.v1", locale);
    }, locale);
    const dialog = () => page.getByRole("dialog", { name: L.library, exact: true });
    const open = () => page.getByRole("button", { name: L.library, exact: true }).click();
    const generate = async (text, count) => {
      await page.getByRole("textbox", { name: L.prompt, exact: true }).fill(text);
      await until(async () => (await params())?.voice);
      await page.getByRole("button", { name: L.generate, exact: true }).click();
      const job = await until(async () => {
        const jobs = (await state()).jobs;
        return jobs.length === count && ["succeeded", "failed"].includes(jobs.at(-1).status) && jobs.at(-1);
      });
      assert.equal(job.status, "succeeded", JSON.stringify(job));
      return job;
    };
    await page.goto(`${base}/ai-tool/ai-canvas/${id}?creation=unified`);
    await page.getByText(L.saved, { exact: true }).waitFor();
    await page.getByRole("toolbar", { name: L.tools }).getByRole("button", { name: L.add, exact: true }).click();
    await page.getByRole("combobox", { name: L.model, exact: true }).click();
    await page.getByRole("listbox", { name: L.model, exact: true }).locator(`[data-option-id="config:${config.id}"]`).click();
    await until(async () => (await state()).generationSpecs[0]?.modelConfigId === config.id);

    // Preset voice: the library lists the documented system voices.
    await open();
    await dialog().getByRole("button", { name: "tongtong", exact: true }).waitFor();
    for (const voice of ["chuichui", "xiaochen", "jam", "kazi", "douji", "luodo"])
      await dialog().getByRole("button", { name: voice, exact: true }).waitFor();
    await page.screenshot({ path: `${output}/${locale}-1-preset-library.png`, fullPage: true });
    await dialog().getByRole("button", { name: "tongtong", exact: true }).click();
    await until(async () => (await params()).voice === "tongtong");
    const preset = await generate(L.presetText, 1);
    assert.equal(preset.execution.voice, "tongtong");
    assert.equal(preset.execution.format, "wav");
    await page.locator("audio").first().waitFor({ state: "attached" });
    const presetSource = await page.locator("audio").first().getAttribute("src");
    assert.ok(presetSource, "The preset result must load a playable source");
    await page.screenshot({ path: `${output}/${locale}-2-preset-result.png`, fullPage: true });

    // Clone: upload, create and select the new voice.
    await open();
    await dialog().getByRole("tab", { name: L.mine, exact: true }).click();
    await dialog().getByRole("button", { name: L.create, exact: true }).click();
    const name = `od238-${locale}-${id.slice(0, 6)}`;
    await dialog().getByLabel(L.recording, { exact: true }).setInputFiles({ name: "sample.wav", mimeType: "audio/wav", buffer: recording });
    await dialog().getByLabel(L.name, { exact: true }).fill(name);
    await dialog().getByLabel(L.transcript, { exact: true }).fill(process.env.ZHIPU_SAMPLE_TEXT ?? "");
    await dialog().getByText(/sample\.wav/).waitFor();
    await page.screenshot({ path: `${output}/${locale}-3-clone-form.png`, fullPage: true });
    await dialog().getByRole("button", { name: L.create, exact: true }).click();
    const selection = await until(async () => (await params())?.voiceSelection?.name === name && (await params()).voiceSelection);
    assert.equal(selection.source, "uploaded");
    await until(async () => (await dialog().count()) === 0);
    const cloned = await generate(L.cloneText, 2);
    assert.equal(cloned.execution.voice, selection.voiceId);
    // The node is reused, so wait for its player to load the clone's own result.
    await until(async () => {
      const source = await page.locator("audio").first().getAttribute("src");
      return source && source !== presetSource;
    });
    await page.screenshot({ path: `${output}/${locale}-4-clone-result.png`, fullPage: true });

    // Delete the cloned voice from the library.
    await open();
    await dialog().getByRole("tab", { name: L.mine, exact: true }).click();
    const entry = dialog().locator(".cw-voice-entry").filter({ has: page.getByRole("button", { name, exact: true }) });
    await entry.waitFor();
    await entry.locator("summary").click();
    await entry.getByRole("button", { name: L.delete, exact: true }).click();
    await page.screenshot({ path: `${output}/${locale}-5-delete-confirm.png`, fullPage: true });
    await dialog().getByRole("alertdialog").getByRole("button", { name: L.delete, exact: true }).click();
    await until(async () => (await entry.count()) === 0);
    const listed = await call(`/api/voices?modelConfigId=${config.id}`);
    assert.ok(!listed.voices.some((voice) => voice.voiceId === selection.voiceId));
    await page.screenshot({ path: `${output}/${locale}-6-after-delete.png`, fullPage: true });
    console.log(locale, "preset", preset.id, "clone", selection.voiceId, "deleted");
    await page.close();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
