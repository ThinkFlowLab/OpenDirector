import { addCanvasNode } from "./canvas_creation.mjs";
import { chooseGenerationModel } from "./model_picker.mjs";
/** Isolated API only: independent duration control obeys model choices and persists. */
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:8019";
const api = process.env.CREATION_API_URL ?? base;
const headers = {
  "X-OpenDirector-Request": "1",
  "Content-Type": "application/json",
};
async function call(path, body) {
  const response = await fetch(api + path, {
    headers,
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  assert.ok(
    response.ok,
    `${response.status}: ${await response.clone().text()}`,
  );
  return response.json();
}
const health = await call("/api/creation-test-health");
assert.equal(health.isolated, true);
const fastConfig = await call("/api/model-configs", {
  kind: "video",
  modelId: "FastH3-Omni-fixture-bounds",
  url: "http://127.0.0.1:12345/v1",
  apiKey: "",
  connectionType: "self_hosted",
  protocol: "vllm_omni",
  authMode: "none",
  videoAdapter: "fasth3",
  videoCapabilities: {
    outputs: [
      {
        resolution: "480P",
        durations: Array.from({ length: 12 }, (_, i) => i + 4),
      },
    ],
    defaultResolution: "auto",
    defaultDuration: 5,
    dimensionStep: 32,
  },
});
const h3Config = await call("/api/model-configs", {
  kind: "video", modelId: "MiniMaxAI/MiniMax-H3",
  url: "http://127.0.0.1:12345/v1", apiKey: "",
  connectionType: "self_hosted", protocol: "vllm_omni", authMode: "none",
  videoAdapter: "minimax_h3", videoCapabilities: fastConfig.videoCapabilities,
});
const config = await call("/api/model-configs", {
  kind: "video",
  modelId: "fixture-duration-sparse",
  url: "http://127.0.0.1:12345/v1",
  apiKey: "fixture-only",
  connectionType: "api",
  protocol: "vllm_omni",
  authMode: "bearer",
  videoCapabilities: {
    outputs: [
      { resolution: "480P", width: 832, height: 480, durations: [3, 5, 7] },
    ],
    defaultResolution: "480P",
    defaultDuration: 5,
    dimensionStep: 2,
  },
});
// A configured service that does not publish its duration limits.
const unknown = await call("/api/model-configs", {
  kind: "video",
  modelId: "fixture-duration-unknown",
  url: "http://127.0.0.1:12345/v1",
  apiKey: "",
  connectionType: "self_hosted",
  protocol: "vllm_omni",
  authMode: "none",
  videoAdapter: "standard",
});
assert.equal(unknown.inputRules.videoCapabilities ?? null, null);
const projectId = crypto.randomUUID();
const created = await call(`/api/creation/projects/${projectId}/commands`, {
  commandId: crypto.randomUUID(),
  projectId,
  type: "project.create",
  payload: { name: "Duration UI " + projectId.slice(0, 8) },
});
assert.equal(created.status, "applied");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
});
try {
  const page = await browser.newPage({
    locale: "zh-CN",
    viewport: { width: 1600, height: 1000 },
  });
  // Skip the first-run model setup welcome; it covers the canvas.
  await page.addInitScript(() =>
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
  );
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}`);
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  await addCanvasNode(page, "视频");
  const editor = page.getByRole("textbox", { name: "生成提示词", exact: true });
  await chooseGenerationModel(page, `config:${fastConfig.id}`);
  await editor.fill(
    Array.from(
      { length: 30 },
      (_, i) => `镜头${i + 1}：保持原视频的镜头和动作，仅替换人物外观。`,
    ).join("\n"),
  );
  const trigger = page.getByRole("button", {
    name: "视频生成时长",
    exact: true,
  });
  const parameters = page.getByRole("button", {
    name: "生成参数",
    exact: true,
  });
  assert.doesNotMatch(await parameters.innerText(), /秒/);
  const order = await trigger.evaluate((element) => {
    const mode = document.querySelector('[aria-label="视频创作模式"]');
    const at = document.querySelector('[aria-label="引用已连接节点"]');
    return (
      !!(
        mode.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING
      ) &&
      !!(element.compareDocumentPosition(at) & Node.DOCUMENT_POSITION_FOLLOWING)
    );
  });
  assert.equal(order, true, "Duration belongs between video mode and @");
  const popup = page.getByRole("dialog", {
    name: "视频生成时长设置",
    exact: true,
  });
  const slider = popup.getByRole("slider", { name: "创作时长", exact: true });
  const select = popup.getByLabel("精确创作时长", {
    exact: true,
  });
  await trigger.click();
  await popup.waitFor();
  await slider.press("End");
  assert.equal(await slider.getAttribute("aria-valuetext"), "15 秒");
  assert.equal(await select.inputValue(), "15");
  assert.equal(await trigger.innerText(), "15 秒");
  assert.deepEqual(await popup.locator(".cw-duration-tick").allTextContents(), [
    "0",
    "5",
    "10",
    "15",
    "20",
    "25",
    "30",
  ]);
  const triggerBox = await trigger.boundingBox();
  const popupBox = await popup.boundingBox();
  assert.ok(
    Math.abs(triggerBox.y - popupBox.y - popupBox.height - 8) <= 1,
    JSON.stringify({ triggerBox, popupBox }),
  );
  assert.ok(popupBox.height <= 75, JSON.stringify(popupBox));
  assert.equal(
    await popup.getByRole("button").count(),
    0,
    "No close cross or heading",
  );
  assert.equal(await popup.locator(".cw-duration-notice").count(), 0);
  await select.fill("10");
  await select.press("Enter");
  assert.equal(await slider.getAttribute("aria-valuetext"), "10 秒");
  assert.equal(await trigger.innerText(), "10 秒");
  await select.fill("11");
  await trigger.click();
  await popup.waitFor({ state: "hidden" });
  assert.equal(await trigger.innerText(), "11 秒");
  await trigger.click();
  const clickSeconds = async (seconds) => {
    const box = await slider.boundingBox();
    await page.mouse.click(
      box.x + 3 + ((box.width - 6) * seconds) / 30,
      box.y + box.height / 2,
    );
  };
  await clickSeconds(2);
  assert.equal(await slider.inputValue(), "4");
  assert.equal(await trigger.innerText(), "4 秒");
  await popup.getByRole("status").getByText("当前模型支持的时长在 4 到 15 秒之间", { exact: true }).waitFor();
  await clickSeconds(25);
  assert.equal(await slider.inputValue(), "15");
  assert.equal(await trigger.innerText(), "15 秒");
  await popup.getByRole("status").getByText("当前模型支持的时长在 4 到 15 秒之间", { exact: true }).waitFor();
  const box = await slider.boundingBox();
  if (process.env.DURATION_SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.DURATION_SCREENSHOT_DIR}/duration-boundary.png`,
    });
  await page.mouse.move(
    box.x + 3 + ((box.width - 6) * 15) / 30,
    box.y + box.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2, {
    steps: 15,
  });
  await page.mouse.up();
  assert.equal(await slider.inputValue(), "15");
  await page.mouse.move(
    box.x + 3 + ((box.width - 6) * 15) / 30,
    box.y + box.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(box.x + 3, box.y + box.height / 2, { steps: 15 });
  await page.mouse.up();
  assert.equal(await slider.inputValue(), "4");
  await select.fill("31");
  await select.press("Enter");
  assert.equal(await select.inputValue(), "15");
  assert.equal(await trigger.innerText(), "15 秒");
  await select.fill("10");
  await select.press("Enter");
  if (process.env.DURATION_SCREENSHOT_DIR)
    await page.screenshot({
      path: `${process.env.DURATION_SCREENSHOT_DIR}/duration-control.png`,
    });
  await slider.press("Escape");
  await popup.waitFor({ state: "hidden" });
  await parameters.click();
  const parameterPanel = page.getByRole("dialog", {
    name: "生成参数设置",
    exact: true,
  });
  await parameterPanel.waitFor();
  assert.equal(
    await parameterPanel.getByRole("slider").count(),
    0,
    "Video duration has its own panel",
  );
  await parameterPanel.press("Escape");
  const model = page.getByRole("combobox", { name: "生成模型", exact: true });
  await chooseGenerationModel(page, `config:${config.id}`);
  await trigger.click();
  await popup.waitFor();
  assert.deepEqual(await popup.locator(".cw-duration-tick").allTextContents(), [
    "0",
    "5",
    "10",
    "15",
    "20",
    "25",
    "30",
  ]);
  await slider.press("Home");
  assert.equal(await slider.getAttribute("aria-valuetext"), "3 秒");
  await slider.press("ArrowRight");
  assert.equal(await slider.getAttribute("aria-valuetext"), "5 秒");
  await slider.press("End");
  assert.equal(await slider.getAttribute("aria-valuetext"), "7 秒");
  await select.fill("4");
  await select.press("Enter");
  await popup
    .getByRole("status")
    .getByText("该时长不受支持，可选：3、5、7s", { exact: true })
    .waitFor();
  assert.equal(await select.inputValue(), "3");
  await slider.press("End");
  await slider.press("Escape");
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  const snapshot = await call(`/api/creation/projects/${projectId}`);
  assert.equal(
    snapshot.generationSpecs.find((spec) => spec.kind === "video").parameters
      .durationSeconds,
    7,
  );
  await page.reload();
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  await page.locator(".react-flow__node").click();
  assert.equal(await trigger.innerText(), "7 秒");
  for (const decimalConfig of [fastConfig, h3Config]) {
    await chooseGenerationModel(page, `config:${decimalConfig.id}`);
    for (const [locale, language, triggerName, dialogName, inputName] of [
      ["zh-CN", "中文", "视频生成时长", "视频生成时长设置", "精确创作时长"],
      ["en-US", "EN", "Video duration", "Video duration settings", "Exact creation duration"],
    ]) {
      await page.getByRole("button", { name: language, exact: true }).click();
      const decimalTrigger = page.getByRole("button", { name: triggerName, exact: true });
      await decimalTrigger.click();
      const decimalPopup = page.getByRole("dialog", { name: dialogName, exact: true });
      const decimalInput = decimalPopup.getByLabel(inputName, { exact: true });
      const decimalSlider = decimalPopup.getByRole("slider");
      const minimum = Number(await decimalInput.getAttribute("min"));
      const maximum = Number(await decimalInput.getAttribute("max"));
      assert.ok(Number.isFinite(minimum) && maximum > minimum);
      const notice = decimalPopup.locator(".cw-duration-notice");
      for (const [key, endpoint, outside] of [
        ["Home", minimum, minimum - 1],
        ["End", maximum, maximum + 1],
      ]) {
        await decimalSlider.press(key);
        assert.equal(await decimalInput.inputValue(), String(endpoint), locale);
        assert.equal(await notice.count(), 0, locale);
        await decimalInput.fill(String(outside));
        await decimalInput.press("Enter");
        await notice.waitFor({ state: "visible" });
        assert.equal(await decimalInput.inputValue(), String(endpoint), locale);
        // A valid endpoint clears an existing warning immediately.
        await decimalSlider.press(key);
        assert.equal(await notice.count(), 0, locale);
      }
      await decimalInput.fill("15");
      await decimalInput.press("Enter");
      if (decimalConfig.id === h3Config.id)
        assert.match(await decimalPopup.locator(".cw-duration-output").innerText(), /362.*15\.083333/);
      assert.equal(await decimalPopup.locator(".cw-duration-notice").count(), 0);
      assert.equal(await decimalSlider.getAttribute("step"), "1");
      const dragBox = await decimalSlider.boundingBox();
      await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(dragBox.x + dragBox.width * 0.437, dragBox.y + dragBox.height / 2, { steps: 5 });
      await page.mouse.up();
      assert.ok(Number.isInteger(Number(await decimalInput.inputValue())), locale);
      await decimalInput.fill("8");
      await decimalInput.press("End");
      await decimalInput.pressSequentially(".");
      assert.equal(await decimalInput.inputValue(), "8.", locale);
      await decimalInput.pressSequentially("25", { delay: 100 });
      assert.equal(await decimalInput.inputValue(), "8.25", locale);
      await decimalInput.fill("6.583333");
      await decimalInput.press("Enter");
      assert.equal(await decimalInput.inputValue(), "6.583333", locale);
      assert.equal(await decimalInput.getAttribute("step"), "any");
      await decimalInput.press("Escape");
      await page.waitForTimeout(500);
      const saved = await call(`/api/creation/projects/${projectId}`);
      assert.equal(saved.generationSpecs.find(spec => spec.kind === "video").parameters.durationSeconds, 6.583333);
    }
  }
  await page.getByRole("button", { name: "中文", exact: true }).click();
  // The picker only lists configured services; one without published
  // durations must not offer invented choices.
  await chooseGenerationModel(page, `config:${unknown.id}`);
  assert.equal(
    await trigger.isDisabled(),
    true,
    "Unknown model limits cannot be invented",
  );
  assert.equal(
    (await call("/api/creation-test-health")).calls.length,
    health.calls.length,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      isolated: true,
      separateDurationControl: true,
      discreteChoices: [3, 5, 7],
      persistedAndReloaded: true,
      fixedAndUnknownModels: true,
      tickMarks: true,
      noGenerationSubmitted: true,
      errors,
    }),
  );
} finally {
  await browser.close();
}
