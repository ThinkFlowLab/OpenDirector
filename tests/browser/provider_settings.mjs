/** Provider presets, independent model cards and explicit save without inference. */
import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const headers = {
  "X-OpenDirector-Request": "1",
  "Content-Type": "application/json",
};
async function call(path, body) {
  const response = await fetch(api + path, {
    headers,
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
assert.equal((await call("/api/creation-test-health")).isolated, true);
const browser = await launchBrowser();
const page = await browser.newPage({ locale: "en-US", viewport: { width: 1500, height: 1000 } });
await page.addInitScript(() => {
  try { localStorage.setItem("opendirector.modelSetup.v1", "dismissed"); } catch {}
});
page.setDefaultTimeout(15000);
const calls = [];
page.on("request", (request) => calls.push(request.url()));
try {
  const projectId = crypto.randomUUID();
  await call(`/api/creation/projects/${projectId}/commands`, {
    commandId: crypto.randomUUID(),
    projectId,
    type: "project.create",
    payload: { name: `Provider UI ${projectId}` },
  });
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Model connections", exact: true }).click();
  await page.locator(".cw-model-setup-row").filter({ hasText: "Image model" }).getByRole("button").click();
  for (const [category, interfaces] of [
    ["Image", ["vLLM-Omni image API", "vLLM-Omni segmentation API"]],
    ["Audio", ["vLLM-Omni speech synthesis API", "vLLM-Omni music generation API", "vLLM-Omni transcription API"]],
    ["Chat", ["OpenAI compatible"]],
  ]) {
    await page.getByRole("button", { name: category, exact: true }).click();
    await page.getByRole("button", { name: "Add service", exact: true }).click();
    for (const name of interfaces) {
      await page.getByRole("combobox", { name: "Provider", exact: true }).click();
      assert.equal(await page.getByRole("listbox", { name: "Provider", exact: true }).getByRole("option").first().getAttribute("aria-label"), "OpenAI compatible");
      assert.equal(await page.getByRole("option", { name: "Custom service", exact: true }).count(), 0);
      await page.getByRole("option", { name, exact: true }).click();
      assert.equal(await page.getByText("API protocol", { exact: true }).count(), 0);
    }
    await page.screenshot({ path: `/tmp/provider-${category}.png` });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  }
  await page.getByRole("button", { name: "Video", exact: true }).click();
  await page.getByRole("button", { name: "Add service", exact: true }).click();
  await page.getByRole("combobox", { name: "Provider", exact: true }).click();
  assert.equal(await page.getByRole("option", { name: "Custom service", exact: true }).count(), 0);
  assert.equal(await page.getByRole("group", { name: "vLLM-Omni compatible", exact: true }).getByRole("option").count(), 3);
  for (const name of ["vLLM-Omni video API", "vLLM-Omni segmentation API", "vLLM-Omni depth API"]) {
    await page.getByRole("option", { name, exact: true }).click();
    assert.equal(await page.getByText("API protocol", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("combobox", { name: "Provider", exact: true }).innerText(), name);
    await page.getByRole("combobox", { name: "Provider", exact: true }).click();
  }
  await page.getByRole("textbox", { name: "Search Provider" }).fill("MiniMax");
  assert.equal(await page.getByRole("listbox", { name: "Provider", exact: true }).getByRole("option").count(), 1);
  await page.keyboard.press("Escape");
  await page.getByRole("combobox", { name: "Provider", exact: true }).click();
  await page.screenshot({ path: "/tmp/provider-picker-dark.png" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.waitForFunction(() => {
    const button = document.querySelector(".cw-provider-trigger");
    return Number(getComputedStyle(button).color.match(/\d+/)[0]) < 100;
  });
  await page.screenshot({ path: "/tmp/provider-picker-light.png" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.getByRole("option", { name: "MiniMax official video", exact: true }).click();
  assert.equal(
    await page.getByLabel("Service URL (Base URL)", { exact: true }).inputValue(),
    "https://api.minimax.cn/v2",
  );
  assert.equal(
    await page.locator(".cw-model-connection-details").getAttribute("open"),
    null,
  );
  for (const name of ["MiniMax-H3", "MiniMax-H3-Highspeed", "MiniMax-H3-Lite", "MiniMax-H3-Max"]) {
    assert.equal(await page.getByRole("checkbox", { name, exact: true }).isChecked(), true);
  }
  await page.getByLabel("API Key", { exact: true }).fill("fixture-only");
  await page
    .getByRole("button", { name: "Load supported models", exact: true })
    .click();
  await page.getByRole("checkbox", { name: "MiniMax-H3", exact: true }).check();
  await page
    .getByText("Text-to-video / first-last frame / multimodal references", { exact: true }).first()
    .waitFor();
  const logo = page.locator(".cw-model-option img.cw-model-logo").first();
  await logo.waitFor();
  await logo.evaluate((image) => image.decode());
  assert.ok(await logo.evaluate((image) => image.naturalWidth > 0));
  assert.match(await logo.getAttribute("src"), /(?:data:image\/svg\+xml|\/assets\/model-logos\/.*\.svg)/);
  assert.ok(await logo.evaluate((image) => image.classList.contains("cw-brand-mono")));
  await page.screenshot({ path: "/tmp/provider-settings-video.png" });
  await page.getByRole("button", { name: "Save service", exact: true }).click();
  await page.getByRole("button", { name: "Add service", exact: true }).waitFor();
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  await page.getByRole("button", { name: "Add service", exact: true }).click();
  await page.getByRole("combobox", { name: "Provider", exact: true }).click();
  await page.getByRole("option", { name: "DeepSeek", exact: true }).click();
  await page.getByLabel("API Key", { exact: true }).fill("fixture-only");
  for (const model of ["text-card", "image-card"]) {
    await page.getByRole("button", { name: "Add manually", exact: true }).click();
    await page
      .getByLabel("Model ID (the service's served-model-name)", { exact: true })
      .fill(model);
    await page
      .locator(".cw-model-manual")
      .getByRole("button", { name: "Add", exact: true })
      .click();
  }
  const card = page
    .locator(".cw-model-option")
    .filter({ hasText: "image-card" });
  const textCard = page.locator(".cw-model-option").filter({ hasText: "text-card" });
  await textCard.locator("summary").click();
  await textCard.getByRole("checkbox", { name: "Image understanding", exact: true }).uncheck();
  await card.locator("summary").click();
  await card.getByRole("checkbox", { name: "Image understanding", exact: true }).check();
  await page.screenshot({ path: "/tmp/provider-settings-agent.png" });
  await page.getByRole("button", { name: "Save service", exact: true }).click();
  await page.getByRole("button", { name: "Add service", exact: true }).waitFor();
  const models = await call("/api/model-configs");
  assert.deepEqual(
    models.find((model) => model.modelId === "image-card").inputModalities,
    ["text", "image"],
  );
  assert.deepEqual(
    models.find((model) => model.modelId === "text-card").inputModalities,
    ["text"],
  );
  assert.ok(
    !calls.some((url) => url.includes("test-agent")),
    "save must not run inference",
  );
  await page.getByRole("button", { name: "Add service", exact: true }).click();
  await page.getByRole("combobox", { name: "Provider", exact: true }).click();
  await page.getByRole("option", { name: "DeepSeek", exact: true }).click();
  await page.getByRole("button", { name: /Reuse saved connection/ }).click();
  assert.equal(
    await page.getByLabel("API Key", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await page
      .getByRole("checkbox", { name: "image-card", exact: true })
      .isChecked(),
    true,
  );
  await page.getByRole("button", { name: "Save service", exact: true }).click();
  await page.getByRole("button", { name: "Add service", exact: true }).waitFor();
  const reused = await call("/api/model-configs");
  assert.deepEqual(
    reused.map((model) => model.id).sort(),
    models.map((model) => model.id).sort(),
  );
  assert.deepEqual(
    reused.find((model) => model.modelId === "image-card").inputModalities,
    ["text", "image"],
  );
  await page.getByRole("button", { name: "Add service", exact: true }).click();
  await page.getByRole("combobox", { name: "Provider", exact: true }).click();
  await page.getByRole("option", { name: "DeepSeek", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal((await call("/api/model-configs")).length, models.length);
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.locator(".cw-chat-button").click();
  await page.getByRole("button", { name: "Model settings: Multimodal", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Model settings", exact: true });
  await picker.getByRole("tab", { name: /Video/ }).click();
  const modelLogo = picker.getByRole("option", { name: /^MiniMax-H3(?:\s|$)/ }).first().locator("img.cw-model-logo");
  await modelLogo.waitFor();
  await modelLogo.evaluate((image) => image.decode());
  assert.ok(await modelLogo.evaluate((image) => image.naturalWidth > 0));
  await page.screenshot({ path: "/tmp/assistant-model-logos.png" });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Agent:/ }).click();
  for (const name of ["OpenCode", "Codex", "Claude Code"]) {
    const row = page.getByRole("menuitemradio").filter({ has: page.locator("strong", { hasText: new RegExp(`^${name}$`) }) });
    const icon = row.locator("img.cw-brand-mono");
    await icon.waitFor();
    await icon.evaluate((image) => image.decode());
    assert.ok(await icon.evaluate((image) => image.naturalWidth > 0));
  }
  await page.screenshot({ path: "/tmp/harness-logos-fixed.png" });
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "provider presets",
        "official capability card",
        "independent model modalities",
        "save without inference",
        "explicit connection reuse",
        "cancel without mutation",
      ],
    }),
  );
} catch (error) {
  console.error("Browser state:", await page.locator("body").innerText().catch(() => "unavailable"));
  await page.screenshot({ path: "/tmp/provider-settings-failure.png" }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
