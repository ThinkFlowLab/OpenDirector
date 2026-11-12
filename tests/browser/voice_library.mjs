/** Full bilingual voice-library UI with real storage/media and mocked provider HTTP. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { launchBrowser } from "./engine.mjs";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8030";
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5190";
const output =
  process.env.VOICE_SCREENSHOTS ?? "/tmp/opendirector-voice-evidence";
const headers = {
  "X-OpenDirector-Request": "1",
  "Content-Type": "application/json",
};
// Reopening includes cold module loading, project recovery and asset fetching.
// Keep ordinary interaction waits short, but budget this whole path explicitly.
const reopenTimeout = 45000;
// Optional deterministic slow-CI probe for the reopened asset request.
const reopenDelay = Number(process.env.VOICE_REOPEN_DELAY_MS ?? 0);
assert.ok(
  Number.isFinite(reopenDelay) && reopenDelay >= 0 && reopenDelay < reopenTimeout,
);
async function waitForSaved(page, label) {
  await page.getByText(label, { exact: true }).waitFor({ timeout: reopenTimeout });
}
const readTimeout = 15000;
async function call(path, body, origin = api) {
  const response = await fetch(origin + path, {
    headers,
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function until(check) {
  for (let i = 0; i < 200; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error("Expected persisted voice state was not observed");
}
async function reopenAudio(page, assetPath, savedLabel) {
  const started = Date.now();
  const statuses = [];
  let receive, timer;
  const received = new Promise((resolve) => { receive = resolve; });
  const observe = (response) => {
    if (new URL(response.url()).pathname !== assetPath ||
        response.request().method() !== "GET") return;
    statuses.push(response.status());
    receive(response);
  };
  page.on("response", observe);
  try {
    // Observe early responses, but give navigation its own deadline. A cold
    // document has not started the project's media read yet.
    await page.reload({ waitUntil: "domcontentloaded", timeout: reopenTimeout });
    await waitForSaved(page, savedLabel);
    console.log(JSON.stringify({
      event: "voice-reopen-ready", assetPath, elapsedMs: Date.now() - started,
    }));
    return await Promise.race([
      received,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `No reopened audio response; statuses=${JSON.stringify(statuses)}`,
        )), reopenTimeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    page.off("response", observe);
  }
}
async function fixtureRoot(origin) {
  const [voices, generation] = await Promise.all([
    call("/api/voice-test-health", undefined, origin),
    call("/api/creation-test-health", undefined, origin),
  ]);
  assert.equal(voices.isolated, true);
  assert.equal(voices.provider, "httpx-mock");
  assert.equal(generation.isolated, true);
  assert.equal(generation.provider, "fixture");
  assert.ok(generation.root);
  return generation.root;
}
assert.equal(
  await fixtureRoot(base),
  await fixtureRoot(api),
  "Vite must proxy to the same isolated fixture",
);
const common = {
  kind: "audio",
  url: "http://voice.test/v1",
  apiKey: "fixture-only-no-real-service",
  connectionType: "self_hosted",
  protocol: "openai",
  authMode: "bearer",
};
const configs = await call("/api/model-configs/batch", {
  ...common,
  modelIds: ["MOSS-TTS", "MOSS-TTS-Nano", "MOSS-TTS-Drama3"],
});
const other = await call("/api/model-configs", {
  ...common,
  url: "http://voice-b.test/v1",
  modelId: "MOSS-TTS",
});
const cloud = await call("/api/model-configs", {
  ...common,
  url: "https://api.mosi.cn/v1",
  modelId: "moss-tts-1.5-flash",
  connectionType: "api",
});
const [normal, nano, drama] = configs;
assert.equal(
  normal.inputRules.voiceLibrary.connectionId,
  nano.inputRules.voiceLibrary.connectionId,
);
const wav = Buffer.alloc(44 + 64000);
wav.write("RIFF");
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24);
wav.writeUInt32LE(32000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(64000, 40);
// Live WebM, like MediaRecorder output, has no duration in its container header.
function liveWebm(seconds) {
  return execFileSync("ffmpeg", [
    "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=sample_rate=16000",
    "-t", String(seconds), "-c:a", "libopus", "-f", "webm", "-live", "1", "pipe:1",
  ]);
}
const validWebm = liveWebm(2);
const longWebm = liveWebm(31);
const copy = {
  "en-US": {
    tools: "Canvas creation tools",
    add: "Add Audio",
    model: "Generation model",
    prompt: "Text to read",
    library: "Voice library",
    all: "All voices",
    mine: "My voices",
    favorites: "Favorites",
    create: "Create voice",
    name: "Voice name",
    recording: "Reference recording",
    preview: "Preview Sample voice",
    stop: "Stop previewing Sample voice",
    noPreview: "No preview available for Alice",
    selectableWithoutPreview: "No preview available. Select Cloud voice.",
    favorite: "Favorite Sample voice",
    unfavorite: "Unfavorite Sample voice",
    language: "Language",
    gender: "Gender",
    transcript: "Recording transcript",
    optional: "Recording transcript (optional)",
    consent: "Consent recording ID",
    generate: "Generate",
    saved: "Saved on this device",
    delete: "Delete voice",
    actions: "More actions for ",
    retry: "Retry",
    previousPage: "Previous page",
    nextPage: "Next page",
    noPageMatches: "No matching voices on this page.",
    selectionMissing:
      "The selected voice is no longer in this library. Choose another voice before generating.",
  },
  "zh-CN": {
    tools: "画布创作工具",
    add: "添加音频",
    model: "生成模型",
    prompt: "朗读文本",
    library: "音色库",
    all: "全部音色",
    mine: "我的音色",
    favorites: "收藏",
    create: "创建音色",
    name: "音色名称",
    recording: "参考录音",
    preview: "试听 Sample voice",
    stop: "停止试听 Sample voice",
    noPreview: "Alice 暂无试听音频",
    selectableWithoutPreview: "暂无试听音频。选择 Cloud voice。",
    favorite: "收藏 Sample voice",
    unfavorite: "取消收藏 Sample voice",
    language: "语言",
    gender: "性别",
    transcript: "录音逐字稿",
    optional: "录音逐字稿（选填）",
    consent: "授权录音 ID",
    generate: "提交生成",
    saved: "已保存到本机",
    delete: "删除音色",
    actions: "",
    retry: "重试",
    previousPage: "上一页",
    nextPage: "下一页",
    noPageMatches: "本页没有符合条件的音色。",
    selectionMissing: "所选音色已不在此音色库中。生成前请选择其他音色。",
  },
};
await mkdir(output, { recursive: true });
const browser = await launchBrowser();
const errors = [];
try {
  for (const [locale, L] of Object.entries(copy)) {
    const page = await browser.newPage({
      viewport: { width: 1500, height: 1000 },
    });
    page.setDefaultTimeout(readTimeout);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (
        /^https?:\/\/(voice\.test|voice-b\.test|api\.mosi\.cn)/.test(
          request.url(),
        )
      )
        errors.push("Browser contacted provider");
    });
    const id = crypto.randomUUID();
    await call(`/api/creation/projects/${id}/commands`, {
      commandId: crypto.randomUUID(),
      projectId: id,
      type: "project.create",
      payload: { name: `Voice library ${locale} ${id.slice(0, 8)}` },
    });
    const state = () => call(`/api/creation/projects/${id}`);
    const params = async () => (await state()).generationSpecs[0]?.parameters;
    await page.addInitScript((locale) => {
      localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
      localStorage.setItem("opendirector.locale.v1", locale);
      // Observe the actual fetch -> Blob -> player URL without importing a
      // development-only application module; this also runs against previews.
      const sources = new WeakMap();
      const urls = new Map();
      window.__voiceMediaSources = urls;
      const fetchMedia = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await fetchMedia(...args);
        const readBlob = response.blob.bind(response);
        response.blob = async (...args) => {
          const blob = await readBlob(...args);
          sources.set(blob, response.url);
          return blob;
        };
        return response;
      };
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        const url = create(blob);
        if (sources.has(blob)) urls.set(url, sources.get(blob));
        return url;
      };
    }, locale);
    const open = () =>
      page.getByRole("button", { name: L.library, exact: true }).click();
    const dialog = () =>
      page.getByRole("dialog", { name: L.library, exact: true });
    const assertSelectedVoice = async (expectedName) => {
      const choices = dialog().locator(".cw-voice-name");
      await choices.first().waitFor();
      const pressed = choices.and(dialog().getByRole("button", { pressed: true }));
      const unpressed = dialog().locator('.cw-voice-name[aria-pressed="false"]');
      assert.deepEqual(await pressed.allTextContents(), expectedName ? [expectedName] : []);
      assert.equal(await unpressed.count(), await choices.count() - (expectedName ? 1 : 0));
    };
    const selectModel = async (config) => {
      await page.getByRole("combobox", { name: L.model, exact: true }).click();
      await page
        .getByRole("listbox", { name: L.model, exact: true })
        .locator(`[data-option-id="config:${config.id}"]`)
        .click();
      await until(
        async () =>
          (await state()).generationSpecs[0]?.modelConfigId === config.id,
      );
    };
    try {
      await page.goto(`${base}/ai-tool/ai-canvas/${id}?creation=unified`, {
        waitUntil: "domcontentloaded",
        timeout: reopenTimeout,
      });
      await waitForSaved(page, L.saved);
      await page
        .getByRole("toolbar", { name: L.tools })
        .getByRole("button", { name: L.add, exact: true })
        .click();
      await selectModel(normal);
      await page
        .getByRole("textbox", { name: L.prompt, exact: true })
        .fill("Hello from the voice library.");
      let releaseList;
      const listingGate = new Promise((resolve) => {
        releaseList = resolve;
      });
      let failFirstList = true;
      await page.route("**/api/voices?**", async (route) => {
        if (route.request().method() !== "GET" || !failFirstList)
          return route.continue();
        await listingGate;
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            detail: "Fixture listing unavailable",
            code: "voice_provider_error",
          }),
        });
      });
      await open();
      await dialog().getByRole("status").waitFor();
      releaseList();
      await dialog().getByRole("alert").waitFor();
      failFirstList = false;
      await dialog()
        .getByRole("button", { name: L.retry, exact: true })
        .click();
      await dialog()
        .getByRole("button", { name: "Sample voice", exact: true })
        .waitFor();
      await assertSelectedVoice(null);
      assert.equal(await dialog().getByRole("tab").count(), 3);
      assert.equal(
        await dialog()
          .locator(".cw-voice-grid")
          .evaluate(
            (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
          ),
        4,
      );
      assert.equal(
        await dialog()
          .getByRole("button", { name: L.create, exact: true })
          .count(),
        1,
      );
      const noPreview = dialog().getByRole("img", { name: L.noPreview, exact: true });
      assert.equal(await noPreview.count(), 1);
      await noPreview.hover();
      assert.equal(await noPreview.getAttribute("title"), L.noPreview);
      assert.equal(await noPreview.evaluate(el => getComputedStyle(el).cursor), "default");
      await noPreview.click();
      await dialog().locator(".cw-voice-entry").filter({
        has: page.getByRole("button", { name: "Alice", exact: true }),
      }).click({ position: { x: 8, y: 8 } });
      assert.equal((await params()).voiceSelection, undefined);
      assert.ok(await dialog().getByRole("button", { name: "Alice", exact: true }).isDisabled());
      assert.equal(await dialog().getByRole("combobox").count(), 2);
      await dialog()
        .getByRole("combobox", { name: L.language, exact: true })
        .selectOption("English");
      assert.equal(
        await dialog()
          .getByRole("button", { name: "Alice", exact: true })
          .count(),
        0,
      );
      await dialog()
        .getByRole("combobox", { name: L.language, exact: true })
        .selectOption("");
      await dialog()
        .getByRole("button", { name: L.preview, exact: true })
        .click();
      await dialog()
        .getByRole("button", { name: L.stop, exact: true })
        .waitFor();
      assert.equal((await params()).voiceSelection, undefined);
      await dialog().getByRole("button", { name: L.stop, exact: true }).click();
      const previewRow = dialog()
        .locator(".cw-voice-entry")
        .filter({
          has: page.getByRole("button", { name: "Sample voice", exact: true }),
        });
      await previewRow.click({ position: { x: 8, y: 8 } });
      assert.equal((await params()).voiceSelection, undefined);
      await previewRow.hover();
      await dialog()
        .getByRole("button", { name: L.favorite, exact: true })
        .click();
      await page.screenshot({
        path: `${output}/${locale}-all-voices.png`,
        fullPage: true,
      });
      await dialog()
        .getByRole("tab", { name: L.favorites, exact: true })
        .click();
      await dialog().getByRole("button", { name: "Sample voice", exact: true }).waitFor();
      assert.equal(
        await dialog()
          .getByRole("button", { name: "Sample voice", exact: true })
          .count(),
        1,
      );
      await page.keyboard.press("Escape");
      assert.equal(await dialog().count(), 0);
      await open();
      await dialog().getByRole("tab", { name: L.all, exact: true }).focus();
      await page.keyboard.press("ArrowRight");
      assert.equal(
        await dialog()
          .getByRole("tab", { name: L.mine, exact: true })
          .getAttribute("aria-selected"),
        "true",
      );
      await page.getByRole("textbox", { name: L.prompt, exact: true }).click();
      assert.equal(await dialog().count(), 0);
      await open();
      await dialog().getByRole("tab", { name: L.mine, exact: true }).click();
      await dialog()
        .getByRole("button", { name: L.create, exact: true })
        .click();
      const createdName = `Narrator-${locale}`;
      const vllmVoiceId = createdName.toLowerCase();
      await dialog()
        .getByLabel(L.recording, { exact: true })
        .setInputFiles({
          name: "broken.wav",
          mimeType: "audio/wav",
          buffer: Buffer.from("not an audio file"),
        });
      await dialog().getByRole("alert").waitFor();
      assert.equal(
        await dialog()
          .getByRole("button", { name: L.create, exact: true })
          .isDisabled(),
        true,
      );
      await dialog().getByLabel(L.name, { exact: true }).fill(createdName);
      const consent = dialog().getByRole("textbox", {
        name: L.consent,
        exact: true,
      });
      assert.equal(await consent.getAttribute("required"), "");
      const recording = dialog().getByLabel(L.recording, { exact: true });
      await recording.setInputFiles({
        name: "recording.webm",
        mimeType: "audio/webm",
        buffer: validWebm,
      });
      await dialog().getByText(/recording\.webm .* 2\.0 /).waitFor();
      assert.ok(
        await dialog().getByRole("button", { name: L.create, exact: true }).isDisabled(),
      );
      await consent.fill("consent-fixture-01");
      await recording.setInputFiles({
        name: "too-long.webm",
        mimeType: "audio/webm",
        buffer: longWebm,
      });
      await dialog().getByText(/too-long\.webm .* 31\.0 /).waitFor();
      await dialog().getByRole("alert").waitFor();
      assert.ok(await dialog().getByRole("button", { name: L.create, exact: true }).isDisabled());
      await recording.setInputFiles({
        name: "recording.webm",
        mimeType: "audio/webm",
        buffer: validWebm,
      });
      await dialog()
        .getByRole("button", { name: L.create, exact: true })
        .click();
      await until(
        async () => (await params())?.voiceSelection?.voiceId === vllmVoiceId,
      );
      await until(async () => (await dialog().count()) === 0);
      await selectModel(drama);
      assert.equal((await params()).voiceSelection, undefined);
      assert.equal(
        await page
          .getByRole("button", { name: L.generate, exact: true })
          .isDisabled(),
        true,
      );
      await open();
      await dialog()
        .getByRole("button", { name: createdName, exact: true })
        .waitFor();
      assert.equal(
        await dialog()
          .getByRole("button", { name: createdName, exact: true })
          .isDisabled(),
        true,
      );
      await dialog()
        .getByRole("button", { name: L.create, exact: true })
        .click();
      assert.equal(
        await dialog()
          .getByLabel(L.transcript, { exact: true })
          .getAttribute("required"),
        "",
      );
      await page.keyboard.press("Escape");
      await open();
      await dialog()
        .getByRole("button", { name: "Sample voice", exact: true })
        .click();
      await until(async () => (await params()).voice === "sample");
      await selectModel(nano);
      assert.equal((await params()).voiceSelection.voiceId, "sample");
      await open();
      assert.equal(
        await dialog()
          .getByRole("button", { name: "default", exact: true })
          .isDisabled(),
        true,
      );
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: L.generate, exact: true }).click();
      await until(async () => (await state()).jobs[0]?.status === "succeeded");
      assert.equal(
        (await state()).jobs[0].inputSnapshot.spec.parameters.voiceSelection
          .voiceId,
        "sample",
      );
      await page.reload({ waitUntil: "domcontentloaded", timeout: reopenTimeout });
      await waitForSaved(page, L.saved);
      await page.locator(".react-flow__node").first().click();
      assert.match(
        await page
          .getByRole("button", { name: L.library, exact: true })
          .innerText(),
        /Sample voice/,
      );
      await open();
      await dialog()
        .getByRole("tab", { name: L.favorites, exact: true })
        .click();
      await dialog().getByRole("button", { name: "Sample voice", exact: true }).waitFor();
      assert.equal(
        await dialog()
          .getByRole("button", { name: "Sample voice", exact: true })
          .count(),
        1,
      );
      await page.screenshot({
        path: `${output}/${locale}-favorites.png`,
        fullPage: true,
      });
      await page.keyboard.press("Escape");
      await selectModel(other);
      assert.equal((await params()).voiceSelection, undefined);
      await open();
      await dialog()
        .getByRole("tab", { name: L.favorites, exact: true })
        .click();
      assert.equal(
        await dialog()
          .getByRole("button", { name: "Sample voice", exact: true })
          .count(),
        0,
      );
      await page.keyboard.press("Escape");
      await open();
      await dialog().getByRole("tab", { name: L.mine, exact: true }).click();
      await dialog().locator(".cw-voice-empty").waitFor();
      assert.equal(await dialog().locator(".cw-voice-empty").count(), 1);
      assert.equal(
        await dialog()
          .getByRole("button", { name: L.create, exact: true })
          .count(),
        1,
      );
      await page.keyboard.press("Escape");
      await selectModel(normal);
      await open();
      await dialog().getByRole("button", { name: "Sample voice", exact: true }).click();
      await until(async () => (await params()).voiceSelection?.voiceId === "sample");
      await open();
      await assertSelectedVoice("Sample voice");
      await dialog()
        .getByRole("button", { name: createdName, exact: true })
        .click();
      await until(async () => (await params()).voice === vllmVoiceId);
      await open();
      await assertSelectedVoice(createdName);
      await dialog().getByRole("tab", { name: L.mine, exact: true }).click();
      const entry = dialog()
        .locator(".cw-voice-entry")
        .filter({
          has: page.getByRole("button", { name: createdName, exact: true }),
        });
      let failDelete = true;
      await page.route("**/api/voices/*?**", async (route) => {
        if (route.request().method() !== "DELETE" || !failDelete)
          return route.continue();
        failDelete = false;
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            detail: "Fixture delete unavailable",
            code: "voice_provider_error",
          }),
        });
      });
      await entry.locator("summary").click();
      await entry.getByRole("button", { name: L.delete, exact: true }).click();
      await dialog()
        .getByRole("alertdialog")
        .getByRole("button", { name: L.delete, exact: true })
        .click();
      await dialog().getByRole("alert").waitFor();
      assert.equal(await entry.count(), 1);
      await dialog()
        .getByRole("alertdialog")
        .getByRole("button", { name: L.delete, exact: true })
        .click();
      await until(async () => (await entry.count()) === 0);
      assert.equal(
        (await params()).voiceSelection.voiceId,
        vllmVoiceId,
        "Deleting must not silently fall back to default",
      );
      await page.keyboard.press("Escape");
      await selectModel(cloud);
      await open();
      const cloudName = dialog().getByRole("button", { name: "Cloud voice", exact: true });
      const cloudRow = dialog().locator(".cw-voice-entry").filter({
        has: page.getByRole("button", { name: "Cloud voice", exact: true }),
      });
      for (const target of ["icon", "padding", "name", "keyboard"]) {
        if (target !== "icon") {
          await selectModel(normal);
          await selectModel(cloud);
          await open();
        }
        await cloudName.waitFor();
        assert.equal((await params()).voiceSelection, undefined);
        if (target === "icon") {
          const circle = await cloudRow.locator(".cw-voice-circle").boundingBox();
          assert.ok(circle);
          await page.mouse.click(circle.x + circle.width / 2, circle.y + circle.height / 2);
        } else if (target === "padding") {
          await cloudRow.hover();
          const favorite = cloudRow.locator(".cw-voice-favorite");
          await favorite.click();
          assert.equal(await favorite.getAttribute("aria-pressed"), "true");
          await favorite.click();
          await cloudRow.locator("summary").click();
          assert.ok(await cloudRow.locator("details[open] button").isVisible());
          await cloudRow.locator("summary").click();
          assert.equal((await params()).voiceSelection, undefined);
          await cloudRow.click({ position: { x: 8, y: 8 } });
        } else if (target === "name") {
          await cloudName.click();
        } else {
          await dialog().getByRole("button", { name: L.create, exact: true }).focus();
          await page.keyboard.press("Tab");
          assert.ok(await cloudName.evaluate(el => el === document.activeElement));
          assert.equal(await cloudName.getAttribute("title"), L.selectableWithoutPreview);
          assert.equal(await cloudRow.getByRole("img").count(), 0);
          await page.screenshot({ path: `${output}/${locale}-select-without-preview.png`, fullPage: true });
          await page.keyboard.press("Enter");
        }
        assert.equal(await dialog().count(), 0, `${target} must select and close the library`);
        const stored = await until(async () => {
          const current = await params();
          return current.voiceSelection?.voiceId === "cloud-built-in" && current;
        });
        assert.equal(stored.voice, "cloud-built-in");
        assert.equal(stored.voiceSelection.name, "Cloud voice");
        assert.equal(stored.voiceSelection.connectionId, cloud.inputRules.voiceLibrary.connectionId);
      }
      await open();
      await dialog()
        .getByRole("button", { name: L.create, exact: true })
        .click();
      assert.equal(
        await dialog().getByLabel(L.consent, { exact: true }).count(),
        0,
      );
      assert.equal(await dialog().getByRole("textbox").count(), 1);
      await dialog()
        .getByLabel(L.recording, { exact: true })
        .setInputFiles({
          name: "recording.wav",
          mimeType: "audio/wav",
          buffer: wav,
        });
      await dialog().getByLabel(L.name, { exact: true }).fill(createdName);
      await until(() =>
        dialog().getByRole("button", { name: L.create, exact: true }).isEnabled(),
      );
      await page.screenshot({
        path: `${output}/${locale}-create.png`,
        fullPage: true,
      });
      const [createdResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/voices" &&
            response.request().method() === "POST",
        ),
        dialog().getByRole("button", { name: L.create, exact: true }).click(),
      ]);
      assert.ok(createdResponse.ok());
      const cloudVoice = await createdResponse.json();
      assert.equal(cloudVoice.voiceId, `cloud-${createdName}`);
      assert.equal(
        cloudVoice.connectionId,
        cloud.inputRules.voiceLibrary.connectionId,
      );
      await until(async () => (await params()).voice === cloudVoice.voiceId);
      await open();
      const nextPage = dialog().getByRole("button", {
        name: L.nextPage,
        exact: true,
      });
      const previousPage = dialog().getByRole("button", {
        name: L.previousPage,
        exact: true,
      });
      const builtin = dialog().getByRole("button", {
        name: "Cloud voice",
        exact: true,
      });
      const uploaded = dialog().getByRole("button", {
        name: createdName,
        exact: true,
      });
      await builtin.waitFor();
      assert.equal(await previousPage.isDisabled(), true);
      assert.equal(await uploaded.count(), 0);
      assert.equal(
        await dialog().getByText(L.selectionMissing, { exact: true }).count(),
        0,
      );
      const continuation = (url) =>
        url.pathname === "/api/voices" &&
        url.searchParams.get("modelConfigId") === cloud.id &&
        url.searchParams.has("after");
      await page.route(continuation, (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            detail: "Fixture next page unavailable",
            code: "voice_provider_error",
          }),
        }),
      );
      await nextPage.click();
      await dialog().getByRole("alert").waitFor();
      assert.ok(await builtin.isVisible());
      await page.unroute(continuation);
      const [response] = await Promise.all([
        page.waitForResponse(
          (response) => continuation(new URL(response.url())) && response.ok(),
        ),
        dialog().getByRole("button", { name: L.retry, exact: true }).click(),
      ]);
      const query = new URL(response.url()).searchParams;
      assert.equal(query.get("pageSize"), "150");
      assert.equal(query.get("connectionId"), cloudVoice.connectionId);
      await uploaded.waitFor();
      assert.equal(await nextPage.isDisabled(), true);
      assert.equal(await builtin.count(), 0);
      const uploadedRow = dialog()
        .locator(".cw-voice-entry")
        .filter({
          has: page.getByRole("button", { name: createdName, exact: true }),
        });
      await uploadedRow.hover();
      await uploadedRow.locator(".cw-voice-favorite").click();
      await dialog()
        .getByRole("tab", { name: L.favorites, exact: true })
        .click();
      await previousPage.click();
      await dialog().getByText(L.noPageMatches, { exact: true }).waitFor();
      assert.equal(await uploaded.count(), 0);
      await nextPage.click();
      await uploaded.waitFor();
      await dialog().getByRole("tab", { name: L.all, exact: true }).click();
      await dialog()
        .getByRole("button", { name: createdName, exact: true })
        .waitFor();
      assert.equal(
        await dialog()
          .getByRole("button", { name: L.delete, exact: true })
          .count(),
        0,
      );
      await page.setViewportSize({ width: 560, height: 850 });
      assert.equal(
        await dialog()
          .locator(".cw-voice-grid")
          .evaluate(
            (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
          ),
        2,
      );
      await page.screenshot({
        path: `${output}/${locale}-narrow.png`,
        fullPage: true,
      });
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 1500, height: 1000 });
      const previousJobs = (await state()).jobs.map((job) => job.id);
      const player = page.locator(".cw-audio-preview audio");
      const previousSrc = await player.evaluate((audio) => audio.src);
      await page.getByRole("button", { name: L.generate, exact: true }).click();
      const job = await until(async () =>
        (await state()).jobs.find(
          (job) => !previousJobs.includes(job.id) && job.status === "succeeded",
        ),
      );
      const { model, spec } = job.inputSnapshot;
      assert.equal(model.modelConfigId, cloud.id);
      assert.equal(spec.parameters.voice, cloudVoice.voiceId);
      assert.equal(spec.parameters.voiceSelection.voiceId, cloudVoice.voiceId);
      assert.equal(
        spec.parameters.voiceSelection.connectionId,
        cloudVoice.connectionId,
      );
      const calls = (await call("/api/creation-test-health")).calls;
      assert.deepEqual(
        calls
          .filter((call) => call.id === job.id)
          .map((call) => call.parameters.voice),
        [cloudVoice.voiceId],
      );
      const snapshot = await state();
      const result = snapshot.results.find((result) => result.jobId === job.id);
      assert.equal(snapshot.generationSpecs[0].currentResultId, result.id);
      const asset = snapshot.assets.find(
        (asset) => asset.id === result.asset.assetId,
      );
      assert.equal(asset.kind, "audio");
      assert.ok(asset.metadata.durationSeconds > 0);
      await page.waitForFunction((previous) => {
        const audio = document.querySelector(".cw-audio-preview audio");
        return audio?.currentSrc && audio.currentSrc !== previous;
      }, previousSrc);
      await player.evaluate((audio) => audio.play());
      await page.waitForFunction(
        () => document.querySelector(".cw-audio-preview audio")?.ended,
      );
      assert.ok(
        await player.evaluate(
          (audio) =>
            audio.currentTime > 0 && audio.duration > 0 && audio.error === null,
        ),
      );
      await page.screenshot({
        path: `${output}/${locale}-moss-played.png`,
        fullPage: true,
      });

      const assetPath = `/api/creation/projects/${id}/assets/${asset.id}/content`;
      if (reopenDelay) {
        await page.route((url) => url.pathname === assetPath, async (route) => {
          await new Promise((resolve) => setTimeout(resolve, reopenDelay));
          await route.continue();
        });
      }
      const reopenedAudio = await reopenAudio(page, assetPath, L.saved);
      assert.ok(
        reopenedAudio.ok(),
        `Reopened audio GET ${assetPath}: HTTP ${reopenedAudio.status()}`,
      );
      assert.match(reopenedAudio.headers()["content-type"], /^audio\//);
      await page.locator(".react-flow__node").first().click();
      assert.ok(
        (
          await page
            .getByRole("button", { name: L.library, exact: true })
            .innerText()
        ).includes(createdName),
      );
      await player.waitFor();
      await page.waitForFunction(() => {
        const audio = document.querySelector(".cw-audio-preview audio");
        return audio?.currentSrc && audio.readyState > 0 && audio.error === null;
      });
      const reopenedMedia = await player.evaluate(async (audio) => {
        const response = await fetch(audio.currentSrc);
        const blob = await response.blob();
        const bytes = await blob.arrayBuffer();
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const hex = Array.from(new Uint8Array(digest), (value) =>
          value.toString(16).padStart(2, "0")).join("");
        return {
          sourcePath: new URL(window.__voiceMediaSources.get(audio.currentSrc)).pathname,
          mimeType: blob.type, size: bytes.byteLength, fingerprint: `sha256:${hex}`,
        };
      });
      assert.equal(reopenedMedia.sourcePath, assetPath);
      assert.match(reopenedMedia.mimeType, /^audio\//);
      assert.equal(reopenedMedia.size, asset.metadata.size);
      assert.equal(reopenedMedia.fingerprint, asset.fingerprint);
      await player.evaluate((audio) => audio.play());
      await page.waitForFunction(
        () => document.querySelector(".cw-audio-preview audio")?.ended,
      );
      assert.ok(await player.evaluate((audio) =>
        audio.currentTime > 0 && audio.duration > 0 && audio.error === null));
      const reopened = await state();
      assert.deepEqual(
        reopened.jobs.map((j) => j.id).sort(),
        [...previousJobs, job.id].sort(),
      );
      assert.equal(reopened.generationSpecs[0].currentResultId, result.id);
      assert.equal(
        reopened.results.find((r) => r.id === result.id).asset.assetId,
        asset.id,
      );
      assert.deepEqual(
        reopened.generationSpecs[0].parameters.voiceSelection,
        spec.parameters.voiceSelection,
      );
      assert.equal(
        (await call("/api/creation-test-health")).calls.length,
        calls.length,
      );
    } catch (error) {
      await page
        .screenshot({ path: `${output}/${locale}-failure.png`, fullPage: true })
        .catch(() => {});
      throw error;
    } finally {
      await page.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      locales: Object.keys(copy),
      evidence: output,
      provider: "mocked HTTP; real upload probing, storage and WAV generation",
    }),
  );
} finally {
  await browser.close();
}
