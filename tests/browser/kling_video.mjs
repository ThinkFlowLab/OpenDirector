import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const output =
  process.env.CREATION_SCREENSHOTS ?? "/tmp/opendirector-kling-evidence";
const headers = {
  "X-OpenDirector-Request": "1",
  "Content-Type": "application/json",
};
async function call(path, body, method = body ? "POST" : "GET") {
  const response = await fetch(api + path, {
    headers,
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
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
const health = await call("/api/creation-test-health");
assert.equal(health.isolated, true);
assert.equal(health.provider, "fixture");
for (const model of await call("/api/model-configs")) {
  if (
    model.protocol === "kling_video" &&
    model.url === "https://api-beijing.klingai.com"
  )
    await call(`/api/model-configs/${model.id}`, undefined, "DELETE");
}
await mkdir(output, { recursive: true });
const browser = await launchBrowser();
const copy = {
  "en-US": {
    settings: "Settings",
    models: "Model connections",
    overview: "Video model",
    video: "Video",
    add: "Add service",
    provider: "Provider",
    defaultProvider: "vLLM-Omni video API",
    kling: "Kling official video",
    url: "Service URL (Base URL)",
    save: "Save service",
    close: "Close settings",
    summary: "Text-to-video / first-last frame / image references",
    flashSummary: "Text-to-video / first frame / image references",
    addVideo: "Add Video",
    saved: "Saved on this device",
    first: "Choose First frame",
    last: "Choose Last frame",
    submit: "Submit generation",
  },
  "zh-CN": {
    settings: "设置",
    models: "模型接入",
    overview: "视频模型",
    video: "视频",
    add: "添加服务",
    provider: "提供商",
    defaultProvider: "vLLM-Omni 视频接口",
    kling: "可灵官方视频",
    url: "服务地址（Base URL）",
    save: "保存服务",
    close: "关闭设置",
    summary: "文生视频 / 首尾帧 / 图片参考",
    flashSummary: "文生视频 / 首帧 / 图片参考",
    addVideo: "添加视频",
    saved: "已保存到本机",
    first: "选择首帧",
    last: "选择尾帧",
    submit: "提交生成",
  },
};
try {
  for (const locale of ["en-US", "zh-CN"]) {
    const text = copy[locale];
    const defaultURL = `https://kling-default-${locale.toLowerCase()}.fixture.invalid/v2`;
    const existing =
      (await call("/api/model-configs")).find(
        (model) => model.url === defaultURL && model.modelId === "MiniMax-H3",
      ) ??
      (await call("/api/model-configs", {
        kind: "video",
        url: defaultURL,
        modelId: "MiniMax-H3",
        apiKey: "fixture",
        protocol: "minimax_video_v2",
        connectionType: "api",
        authMode: "bearer",
      }));
    const projectId = crypto.randomUUID();
    const projectName = `Kling ${locale} ${projectId.slice(0, 8)}`;
    await call(`/api/creation/projects/${projectId}/commands`, {
      commandId: crypto.randomUUID(),
      projectId,
      type: "project.create",
      payload: { name: projectName },
    });
    const snapshot = () => call(`/api/creation/projects/${projectId}`);
    const page = await browser.newPage({
      locale: locale === "en-US" ? "en-US" : "zh-CN",
      viewport: { width: 1600, height: 1100 },
    });
    page.setDefaultTimeout(20000);
    await page.addInitScript((locale) => {
      localStorage.setItem("opendirector.locale.v1", locale);
      localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    }, locale);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", async (response) => {
      if (response.status() >= 400 && response.url().endsWith("/commands"))
        console.error(await response.text());
    });
    await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
    await page.getByText(text.saved, { exact: true }).waitFor();
    assert.equal(
      await page.locator(".cw-chat-button").getAttribute("aria-expanded"),
      "false",
    );
    await page
      .getByRole("button", { name: text.addVideo, exact: true })
      .click();
    const initial = await until(
      snapshot,
      (value) => value.generationSpecs.length === 1,
      "default before adding Kling",
    );
    const initialSpec = initial.generationSpecs[0];
    await page.locator(".cw-chat-button[aria-expanded='false']").click();
    const picker = page.locator(".model-picker > .chat-picker-trigger");
    await picker.click();
    await page.getByRole("tab", { name: new RegExp(text.video) }).click();
    await page
      .getByRole("option")
      .filter({ hasText: "MiniMax-H3" })
      .filter({ hasText: new URL(existing.url).host })
      .first()
      .click();
    await page
      .getByRole("button", { name: text.settings, exact: true })
      .click();
    await page.getByRole("button", { name: text.models, exact: true }).click();
    await page
      .locator(".cw-model-setup-row")
      .filter({ hasText: text.overview })
      .getByRole("button")
      .click();
    await page.getByRole("button", { name: text.add, exact: true }).click();
    assert.equal(
      await page
        .getByRole("combobox", { name: text.provider, exact: true })
        .innerText(),
      text.defaultProvider,
    );
    await page
      .getByRole("combobox", { name: text.provider, exact: true })
      .click();
    await page.getByRole("option", { name: text.kling, exact: true }).click();
    assert.equal(
      await page.getByLabel(text.url, { exact: true }).inputValue(),
      "https://api-beijing.klingai.com",
    );
    await page
      .getByLabel("API Key", { exact: true })
      .fill("kling-browser-fixture-only");
    await page.getByText(text.summary, { exact: true }).waitFor();
    await page.getByText("720P / 1080P", { exact: true }).waitFor();
    await page
      .getByRole("checkbox", { name: "kling-4.0", exact: true })
      .check();
    await page
      .getByRole("checkbox", { name: "kling-4.0-flash", exact: true })
      .check();
    await page.getByText(text.flashSummary, { exact: true }).waitFor();
    await page.getByText("720P", { exact: true }).waitFor();
    await page
      .getByText("720P / 1080P", { exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(output, `provider-${locale}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: text.save, exact: true }).click();
    await page.getByRole("button", { name: text.add, exact: true }).waitFor();
    await page.getByRole("button", { name: text.close, exact: true }).click();
    await page.reload();
    await page.getByText(text.saved, { exact: true }).waitFor();
    await page
      .getByRole("button", { name: text.addVideo, exact: true })
      .click();
    const defaults = await until(
      snapshot,
      (value) => value.generationSpecs.length === 2,
      "new default node",
    );
    assert.equal(
      defaults.generationSpecs.find((spec) => spec.id !== initialSpec.id)
        .modelConfigId,
      existing.id,
    );
    assert.equal(
      defaults.generationSpecs.find((spec) => spec.id === initialSpec.id)
        .modelConfigId,
      initialSpec.modelConfigId,
    );
    const configs = await call("/api/model-configs");
    const kling = configs.findLast(
      (model) =>
        model.protocol === "kling_video" &&
        model.modelId === "kling-4.0" &&
        model.url === "https://api-beijing.klingai.com",
    );
    assert.ok(kling);
    assert.deepEqual(kling.inputRules.frameRoles, [
      "first_frame",
      "last_frame",
    ]);
    const flash = configs.find((model) => model.modelId === "kling-4.0-flash");
    assert.ok(flash);
    assert.deepEqual(flash.inputRules.frameRoles, ["first_frame"]);
    assert.deepEqual(flash.inputRules.outputResolutions, ["720P"]);
    assert.deepEqual(flash.inputRules.videoCapabilities.outputs[0].durations,
      Array.from({ length: 18 }, (_, index) => index + 3));
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 400;
      canvas.getContext("2d").fillRect(0, 0, 400, 400);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    for (const name of ["first.png", "last.png"]) {
      await page
        .getByLabel(
          locale === "en-US" ? "Choose local asset files" : "选择本地素材文件",
          { exact: true },
        )
        .setInputFiles({
          name,
          mimeType: "image/png",
          buffer: Buffer.from(png, "base64"),
        });
      await until(
        snapshot,
        (value) =>
          value.canvasItems.filter((item) => item.kind === "image").length ===
          (name === "first.png" ? 1 : 2),
        "image upload",
      );
    }
    const sources = (await snapshot()).canvasItems.filter(
      (item) => item.kind === "image",
    );
    for (const [name, mode, roles] of [
      ["text", "reference", []],
      ["first", "first_frame", ["first_frame"]],
      ["frames", "first_frame", ["first_frame", "last_frame"]],
      ["references", "reference", ["reference", "reference"]],
    ]) {
      const created = await page.evaluate(
        async ({ projectId, modelId, sources, mode, roles, name }) => {
          const { creationClient } =
            await import("/src/backend/creationClient.ts");
          const client = creationClient(projectId);
          await client.refresh();
          const specId = crypto.randomUUID(),
            itemId = crypto.randomUUID();
          const receipt = await client.command("canvas.createGeneration", {
            spec: {
              id: specId,
              projectId,
              kind: "video",
              purpose: "generation",
              modelConfigId: modelId,
              prompt: "Create a short video",
              parameters: {
                videoMode: name === "first" ? "reference" : mode,
                resolution: "1080P",
                durationSeconds: 5,
                aspectRatio:
                  name === "first"
                    ? "16:9"
                    : mode === "first_frame"
                      ? null
                      : "16:9",
              },
            },
            item: {
              id: itemId,
              projectId,
              kind: "video",
              position: { x: 400, y: 50 },
              binding: { role: "generation", objectRef: { id: specId } },
            },
            references: (name === "first" ? ["reference"] : roles).map(
              (role, index) => ({
                id: crypto.randomUUID(),
                projectId,
                targetSpecId: specId,
                binding: "follow_current",
                source: { id: sources[index].id },
                role,
                order: index,
              }),
            ),
          });
          assertReceipt(receipt);
          function assertReceipt(value) {
            if (value.status !== "applied") throw Error(JSON.stringify(value));
          }
          return { specId, itemId };
        },
        { projectId, modelId: kling.id, sources, mode, roles, name },
      );
      await page.reload();
      await page
        .locator(`.react-flow__node[data-id="${created.itemId}"]`)
        .click();
      let firstSourceId = sources[0].id;
      if (name === "first") {
        await page
          .getByRole("button", {
            name: locale === "en-US" ? "Generation settings" : "生成参数",
            exact: true,
          })
          .click();
        await page
          .getByLabel(locale === "en-US" ? "Video mode" : "视频创作模式", {
            exact: true,
          })
          .selectOption("first-last");
        await page
          .getByRole("button", {
            name: locale === "en-US" ? "Close settings" : "关闭参数",
            exact: true,
          })
          .click();
        const selected = await until(
          snapshot,
          (value) =>
            value.references.some(
              (reference) =>
                reference.active &&
                reference.targetSpecId === created.specId &&
                reference.role === "first_frame",
            ),
          "first frame chosen through UI",
        );
        firstSourceId = selected.references.find(
          (reference) =>
            reference.active &&
            reference.targetSpecId === created.specId &&
            reference.role === "first_frame",
        ).source.id;
        assert.equal(
          (await snapshot()).generationSpecs.find(
            (spec) => spec.id === created.specId,
          ).parameters.aspectRatio ?? "adaptive",
          "adaptive",
        );
        await page
          .locator(`.react-flow__node[data-id="${created.itemId}"]`)
          .click();
      }
      if (mode === "first_frame") {
        assert.equal(
          await page.getByLabel(text.first, { exact: true }).inputValue(),
          firstSourceId,
        );
        assert.equal(
          await page.getByLabel(text.last, { exact: true }).inputValue(),
          roles.length === 2 ? sources[1].id : "",
        );
      }
      if (name === "frames") {
        const swap = page.getByRole("button", {
          name:
            locale === "en-US" ? "Swap first and last frames" : "互换首尾帧",
          exact: true,
        });
        await swap.click();
        await until(
          snapshot,
          (value) =>
            value.references.some(
              (reference) =>
                reference.active &&
                reference.targetSpecId === created.specId &&
                reference.role === "first_frame" &&
                reference.source.id === sources[1].id,
            ),
          "frame swap saved",
        );
        assert.equal(
          await page.getByLabel(text.first, { exact: true }).inputValue(),
          sources[1].id,
        );
        await swap.click();
        await until(
          snapshot,
          (value) =>
            value.references.some(
              (reference) =>
                reference.active &&
                reference.targetSpecId === created.specId &&
                reference.role === "first_frame" &&
                reference.source.id === sources[0].id,
            ),
          "frame swap restored",
        );
      }
      await page
        .getByRole("button", {
          name: locale === "en-US" ? "Generate" : text.submit,
          exact: true,
        })
        .click();
      const result = await until(
        snapshot,
        (value) =>
          value.jobs.some(
            (job) =>
              job.inputSnapshot.spec.id === created.specId &&
              job.status === "succeeded",
          ),
        name,
      );
      const job = result.jobs.find(
        (job) => job.inputSnapshot.spec.id === created.specId,
      );
      assert.ok(job.asset);
      assert.equal(job.adopted, true);
      assert.equal(
        result.generationSpecs.find((spec) => spec.id === created.specId)
          .currentResultId,
        result.results.find((result) => result.jobId === job.id).id,
      );
      await page.screenshot({
        path: join(output, `${name}-${locale}.png`),
        fullPage: true,
      });
    }
    const unopenedId = crypto.randomUUID();
    await call(`/api/creation/projects/${unopenedId}/commands`, {
      commandId: crypto.randomUUID(),
      projectId: unopenedId,
      type: "project.create",
      payload: { name: `Kling unopened ${unopenedId.slice(0, 8)}` },
    });
    const unopened = await browser.newPage({
      locale: locale === "en-US" ? "en-US" : "zh-CN",
      viewport: { width: 1600, height: 1100 },
    });
    await unopened.addInitScript((locale) => {
      localStorage.setItem("opendirector.locale.v1", locale);
      localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    }, locale);
    await unopened.goto(
      `${base}/ai-tool/ai-canvas/${unopenedId}?creation=unified`,
    );
    await unopened.getByText(text.saved, { exact: true }).waitFor();
    assert.equal(
      await unopened.locator(".cw-chat-button").getAttribute("aria-expanded"),
      "false",
    );
    await unopened
      .getByRole("button", { name: text.addVideo, exact: true })
      .click();
    const defaultAfterAdding = await until(
      () => call(`/api/creation/projects/${unopenedId}`),
      (value) => value.generationSpecs.length === 1,
      "unopened assistant default after adding Kling",
    );
    assert.equal(
      defaultAfterAdding.generationSpecs[0].modelConfigId,
      initialSpec.modelConfigId,
    );
    await unopened.close();
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    JSON.stringify({
      passed: true,
      locales: ["en-US", "zh-CN"],
      checks: [
        "optional provider",
        "default preserved",
        "unopened assistant default preserved",
        "native capability facts",
        "text",
        "first frame",
        "first and last frames",
        "image references",
        "real fixture media and adoption",
      ],
    }),
  );
} finally {
  await browser.close();
}
