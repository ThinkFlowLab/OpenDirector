import { chooseGenerationModel } from "./model_picker.mjs";
/** UI -> saved intent -> frozen request -> real media -> reload, with isolated models. */
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
async function call(path, body) {
  const response = await fetch(api + path, {
    headers: {
      "X-OpenDirector-Request": "1",
      "Content-Type": "application/json",
    },
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
  throw Error("Expected saved generation parameters or result not observed");
}
assert.equal((await call("/api/creation-test-health")).isolated, true);
await call("/api/creation-test-gate", { open: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox"],
});
const errors = [];
try {
  for (const scenario of ["image", "video", "audio", "FastH3-Omni"]) {
    const kind = scenario === "FastH3-Omni" ? "video" : scenario;
    const config = await call("/api/model-configs", {
      kind,
      modelId: scenario === "FastH3-Omni" ? scenario : `parameters-${kind}`,
      url: "http://127.0.0.1:12345/v1",
      apiKey: "",
      connectionType: "self_hosted",
      authMode: "none",
      protocol: kind === "video" ? "vllm_omni" : "openai",
      ...(kind === "video"
        ? {
            videoAdapter: scenario === "FastH3-Omni" ? "fasth3" : "standard",
            videoCapabilities: {
              outputs: [
                {
                  resolution: "480P",
                  width: 832,
                  height: 480,
                  durations: [5, 8],
                },
              ],
              defaultResolution: "480P",
              defaultDuration: 5,
              dimensionStep: 32,
            },
          }
        : {}),
    });
    const id = crypto.randomUUID();
    await call(`/api/creation/projects/${id}/commands`, {
      projectId: id,
      commandId: crypto.randomUUID(),
      type: "project.create",
      payload: { name: `Parameters ${kind} ${id.slice(0, 8)}` },
    });
    const state = () => call(`/api/creation/projects/${id}`);
    const page = await browser.newPage({
      locale: "zh-CN",
      viewport: { width: 1600, height: 1100 },
    });
    // Skip the first-run model setup welcome; it covers the canvas.
    await page.addInitScript(() =>
      localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
    );
    page.setDefaultTimeout(15000);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${base}/ai-tool/ai-canvas/${id}`);
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    await page
      .getByRole("toolbar", { name: "画布创作工具" })
      .getByRole("button", {
        name: { image: "添加图片", video: "添加视频", audio: "添加音频" }[kind],
        exact: true,
      })
      .click();
    await chooseGenerationModel(page, `config:${config.id}`);
    await page
      .getByRole("textbox", {
        name: kind === "audio" ? "朗读文本" : "生成提示词",
        exact: true,
      })
      .fill(`Parameter probe ${kind}`);
    if (kind === "audio") {
      assert.equal(
        await page.getByRole("textbox", { name: "服务音色" }).inputValue(),
        "",
      );
      await page
        .getByRole("textbox", { name: "服务音色" })
        .fill("voice_test-1");
    } else {
      await page.getByRole("button", { name: "生成参数", exact: true }).click();
      const panel = page.getByRole("dialog", { name: "生成参数设置" });
      if (kind === "image") {
        assert.ok(
          await panel
            .getByRole("button", { name: "16:9", exact: true })
            .isDisabled(),
        );
        await panel.getByRole("button", { name: "3:2", exact: true }).click();
        await panel
          .getByRole("button", { name: "分辨率 1536x1024", exact: true })
          .click();
      } else {
        await panel.getByRole("button", { name: "9:16", exact: true }).click();
        await panel
          .getByRole("button", { name: "分辨率 自动", exact: true })
          .click();
      }
      await page.getByRole("button", { name: "关闭参数", exact: true }).click();
      if (kind === "video") {
        await page
          .getByRole("button", { name: "视频生成时长", exact: true })
          .click();
        await page.getByRole("spinbutton", { name: "精确创作时长" }).fill("8");
        await page
          .getByRole("button", { name: "视频生成时长", exact: true })
          .click();
      }
    }
    const expected =
      kind === "image"
        ? { aspectRatio: "3:2", size: "1536x1024" }
        : kind === "video"
          ? { aspectRatio: "9:16", resolution: "auto", durationSeconds: 8 }
          : { voice: "voice_test-1", creationType: "audio", mode: "tts" };
    await until(async () => {
      const spec = (await state()).generationSpecs[0];
      return (
        spec?.modelConfigId === config.id &&
        spec.prompt === `Parameter probe ${kind}` &&
        Object.entries(expected).every(
          ([key, value]) => spec.parameters[key] === value,
        )
      );
    });
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    await page.reload();
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    await page.locator(".react-flow__node").first().click();
    assert.equal(
      await page
        .getByRole("combobox", { name: "生成模型", exact: true })
        .getAttribute("data-value"),
      `config:${config.id}`,
    );
    if (kind === "audio") {
      assert.equal(
        await page.getByRole("textbox", { name: "服务音色" }).inputValue(),
        "voice_test-1",
      );
    } else {
      await page.getByRole("button", { name: "生成参数", exact: true }).click();
      const panel = page.getByRole("dialog", { name: "生成参数设置" });
      assert.equal(
        await panel
          .getByRole("button", { name: expected.aspectRatio, exact: true })
          .getAttribute("aria-pressed"),
        "true",
      );
      assert.equal(
        await panel
          .getByRole("button", {
            name: `分辨率 ${kind === "image" ? "1536x1024" : "自动"}`,
            exact: true,
          })
          .getAttribute("aria-pressed"),
        "true",
      );
      await page.getByRole("button", { name: "关闭参数", exact: true }).click();
      if (kind === "video")
        assert.match(
          await page
            .getByRole("button", { name: "视频生成时长", exact: true })
            .innerText(),
          /8 秒/,
        );
    }
    await page.getByRole("button", { name: "提交生成", exact: true }).click();
    await until(async () => (await state()).jobs[0]?.status === "succeeded");
    const snapshot = await state(),
      job = snapshot.jobs[0];
    assert.equal(job.adopted, true);
    for (const [key, value] of Object.entries(expected))
      assert.equal(job.inputSnapshot.spec.parameters[key], value);
    assert.equal(
      snapshot.generationSpecs[0].currentResultId,
      snapshot.results[0].id,
    );
    const asset = snapshot.assets.find(
      (a) => a.id === snapshot.results[0].asset.assetId,
    );
    assert.equal(asset.kind, kind);
    assert.ok(asset.metadata.size > 0);
    const sent = (await call("/api/creation-test-health")).calls.find(
      (c) => c.id === job.id,
    ).parameters;
    if (kind === "image") {
      assert.equal(sent.size, "1536x1024");
      assert.equal(job.execution.size, sent.size);
      assert.equal(asset.metadata.width, 1536);
      assert.equal(asset.metadata.height, 1024);
    } else if (kind === "video") {
      assert.equal(sent.size, "480x832");
      assert.equal(sent.duration, 8);
      assert.equal(job.execution.size, sent.size);
      assert.equal(job.execution.durationSeconds, 8);
    } else {
      assert.equal(sent.voice, "voice_test-1");
      assert.equal(job.execution.voice, sent.voice);
    }
    await page.reload();
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    assert.equal(
      (await state()).generationSpecs[0].currentResultId,
      snapshot.results[0].id,
    );
    assert.equal((await state()).jobs.length, 1);
    await page.close();
    console.log(
      `PASS ${scenario}: UI settings, persistence, frozen request, real media, adoption and reload`,
    );
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
