/** Voice library UI against isolated provider doubles; no real voice service call. */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launchBrowser } from "./engine.mjs";
import { chooseGenerationModel } from "./model_picker.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5189";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8029";
const output = process.env.VOICE_SCREENSHOT_DIR ?? "/tmp/opendirector-voice-library-evidence";
const headers = { "X-OpenDirector-Request": "1", "Content-Type": "application/json" };
async function call(path, body) {
  const response = await fetch(api + path, {
    headers,
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
async function until(check) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error("Expected the voice library state not observed");
}
function wavFixture() {
  const samples = 800;
  const data = Buffer.alloc(44 + samples * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + samples * 2, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24);
  data.writeUInt32LE(16000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(samples * 2, 40);
  return data;
}
assert.equal((await call("/api/creation-test-health")).isolated, true);
await call("/api/creation-test-gate", { open: true });
const models = await call("/api/model-configs");
const vllm = models.find((item) => item.kind === "audio" && item.modelId === "fixture-tts");
const moss = models.find((item) => item.kind === "audio" && item.modelId === "moss-tts-1.5-flash");
assert.ok(vllm && moss);
await mkdir(output, { recursive: true });
const browser = await launchBrowser();
const errors = [];
try {
  const id = crypto.randomUUID();
  await call(`/api/creation/projects/${id}/commands`, {
    projectId: id, commandId: crypto.randomUUID(), type: "project.create",
    payload: { name: `Voice library ${id.slice(0, 8)}` },
  });
  const state = () => call(`/api/creation/projects/${id}`);
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1500, height: 1000 } });
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() =>
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
  );
  await page.goto(`${base}/ai-tool/ai-canvas/${id}?creation=unified`);
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await page.getByRole("toolbar", { name: "Canvas creation tools" })
    .getByRole("button", { name: "Add Audio", exact: true }).click();
  await chooseGenerationModel(page, `config:${vllm.id}`);
  await page.getByRole("textbox", { name: "Text to read", exact: true }).fill("Voice library fixture.");
  const library = page.getByRole("button", { name: "Voice library", exact: true });
  await library.click();
  const panel = page.getByRole("dialog", { name: "Voice library", exact: true });
  await panel.getByRole("button", { name: "Select narrator", exact: true }).waitFor();
  assert.equal(await panel.locator(".cw-voice-filters").count(), 0);
  await page.getByRole("button", { name: "Close voice library", exact: true }).click();
  await until(async () => (await page.getByRole("dialog", { name: "Voice library", exact: true }).count()) === 0);
  await library.click();
  await page.getByRole("dialog", { name: "Voice library", exact: true }).getByRole("button", { name: "Select narrator", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await until(async () => (await page.getByRole("dialog", { name: "Voice library", exact: true }).count()) === 0);
  await library.click();
  await page.getByRole("dialog", { name: "Voice library", exact: true }).getByRole("button", { name: "Select narrator", exact: true }).waitFor();
  const grid = panel.locator(".cw-voice-grid");
  assert.equal(
    (await grid.evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length)),
    4,
  );
  assert.equal(await grid.locator(":scope > :first-child").getAttribute("class"), "cw-voice-create-tile");
  await panel.getByRole("button", { name: "Add narrator to favorites", exact: true }).click();
  await panel.getByRole("tab", { name: "Favorites", exact: true }).click();
  await panel.getByRole("button", { name: "Select narrator", exact: true }).waitFor();
  assert.equal(await panel.getByText("clone-one", { exact: true }).count(), 0);
  await panel.getByRole("tab", { name: "All voices", exact: true }).click();
  await panel.getByRole("button", { name: "Select clone-one", exact: true }).click();
  await until(async () => (await state()).generationSpecs[0]?.parameters.voice === "clone-one");
  assert.equal(await library.getAttribute("aria-expanded"), "false");
  await page.reload();
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await page.locator(".react-flow__node").first().click();
  await page.getByRole("button", { name: "Voice library", exact: true }).click();
  await page.getByRole("tab", { name: "Favorites", exact: true }).click();
  await page.getByRole("button", { name: "Select narrator", exact: true }).waitFor();
  await page.getByRole("tab", { name: "My voices", exact: true }).click();
  await page.getByRole("button", { name: "Create voice", exact: true }).click();
  await page.getByLabel("Voice name").fill("created voice");
  await page.getByLabel("Consent recording ID").fill("consent-1");
  await page.getByLabel(/Recording transcript/).fill("created transcript");
  await page.getByLabel("Audio sample").setInputFiles({
    name: "sample.wav", mimeType: "audio/wav", buffer: wavFixture(),
  });
  await page.locator(".cw-voice-file-info audio").waitFor();
  await page.getByRole("button", { name: "Create and select", exact: true }).click();
  await until(async () => (await state()).generationSpecs[0]?.parameters.voice === "created-clone");
  await page.getByRole("button", { name: "Voice library", exact: true }).click();
  await page.getByRole("tab", { name: "My voices", exact: true }).click();
  const created = page.getByRole("listitem").filter({ hasText: "created-clone" });
  await created.hover();
  await created.getByRole("button", { name: "Delete created-clone", exact: true }).click();
  await created.getByRole("button", { name: "Delete", exact: true }).click();
  await until(async () => (await page.getByRole("button", { name: "Select created-clone", exact: true }).count()) === 0);
  await page.getByRole("button", { name: "Close voice library", exact: true }).click();
  await chooseGenerationModel(page, `config:${moss.id}`);
  assert.equal(await page.getByRole("textbox", { name: "Voice ID (required)", exact: true }).inputValue(), "");
  await page.getByRole("button", { name: "Voice library", exact: true }).click();
  const mossPanel = page.getByRole("dialog", { name: "Voice library", exact: true });
  await mossPanel.getByRole("button", { name: "Select MOSS Alice", exact: true }).waitFor();
  assert.equal(await mossPanel.getByRole("button", { name: /^Delete / }).count(), 0);
  await mossPanel.getByRole("button", { name: "Load more voices", exact: true }).click();
  await mossPanel.getByRole("button", { name: "Select MOSS Bob", exact: true }).waitFor();
  await mossPanel.getByRole("button", { name: "Select MOSS Bob", exact: true }).click();
  await until(async () => (await state()).generationSpecs[0]?.parameters.voice === "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  await page.screenshot({ path: join(output, "voice-library.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, fixture: "isolated voice provider doubles",
    checks: ["four-column grid", "create first", "favorites survive reload", "select persists",
      "create/select/delete", "MOSS pagination and no delete"] }));
} finally {
  await browser.close();
}
