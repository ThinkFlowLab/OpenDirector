/** Actual UI, capability HTTP discovery and saved substitute video; no model inference. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const headers = {
  "X-OpenDirector-Request": "1",
  "Content-Type": "application/json",
};
async function call(path, body, method = body ? "POST" : "GET") {
  const response = await fetch(api + path, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.status === 204 ? null : response.json();
}
async function until(read, accepts) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await read();
    if (accepts(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw Error("Video capability workflow did not reach the expected state");
}
assert.equal((await call("/api/creation-test-health")).isolated, true);
let mode = "denied",
  queries = 0;
const modelId = "MiniMaxAI/MiniMax-H3";
function declaration() {
  const route = {
    transport: "http",
    method: "POST",
    path: "/v1/videos",
    exposure: "enabled",
  };
  const imageRoles = {
    reference_image: { support: "supported" },
    ...(mode === "denied" ? { first_frame: { support: "unsupported" } } : {}),
  };
  const editRoles = {
    source_video: { support: "supported" },
    video_noise_mask: { support: "supported" },
    ...(mode === "denied"
      ? { audio_noise_mask: { support: "unsupported" } }
      : {}),
  };
  return {
    object: "omni.capabilities",
    schema_version: 1,
    observed_at: new Date().toISOString(),
    models: [
      {
        id: modelId,
        operations: {
          video_generation: {
            support: "supported",
            exposure: "enabled",
            profiles: [
              {
                id: "image_to_video",
                support: "supported",
                required_inputs: ["text", "image"],
                outputs: ["video"],
                routes: [{ ...route, request: { inputs: imageRoles } }],
              },
              {
                id: "video_to_video",
                support: "supported",
                required_inputs: ["text", "video"],
                outputs: ["video"],
                routes: [{ ...route, request: { inputs: editRoles } }],
              },
            ],
          },
        },
      },
    ],
    routes: [route],
  };
}
const service = createServer((request, response) => {
  assert.equal(request.url, "/v1/omni/capabilities");
  queries += 1;
  response
    .writeHead(200, { "Content-Type": "application/json" })
    .end(JSON.stringify(declaration()));
});
service.listen(0, "127.0.0.1");
await once(service, "listening");
const browser = await launchBrowser();
let saved;
const evidence = [];
try {
  saved = await call("/api/model-configs", {
    kind: "video",
    url: `http://127.0.0.1:${service.address().port}/v1`,
    modelId,
    apiKey: "",
    protocol: "vllm_omni",
    connectionType: "self_hosted",
    authMode: "none",
  });
  for (const locale of ["en-US", "zh-CN"]) {
    const en = locale === "en-US";
    const page = await browser.newPage({
      locale,
      viewport: { width: 1600, height: 1100 },
    });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      const session = request.headers()["x-opendirector-session"];
      if (session) headers["X-OpenDirector-Session"] = session;
    });
    await page.addInitScript((locale) => {
      localStorage.setItem("opendirector.locale.v1", locale);
      localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    }, locale);
    const projectId = crypto.randomUUID(),
      projectPath = `/api/creation/projects/${projectId}`;
    delete headers["X-OpenDirector-Session"];
    await call(`${projectPath}/commands`, {
      projectId,
      commandId: crypto.randomUUID(),
      type: "project.create",
      payload: { name: `Video roles ${locale}` },
    });
    await page.goto(`${base}/ai-tool/ai-canvas/${projectId}`);
    await page
      .getByText(en ? "Saved on this device" : "已保存到本机", { exact: true })
      .waitFor();
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      canvas.getContext("2d").fillRect(0, 0, 256, 256);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page
      .getByLabel(en ? "Choose local asset files" : "选择本地素材文件", {
        exact: true,
      })
      .setInputFiles({
        name: "first-frame.png",
        mimeType: "image/png",
        buffer: Buffer.from(png, "base64"),
      });
    const uploaded = await until(
      () => call(projectPath),
      (value) => value.canvasItems.length === 1,
    );
    const source = uploaded.canvasItems[0];
    const created = await page.evaluate(
      async ({ projectId, modelConfigId, sourceId }) => {
        const { creationClient } =
          await import("/src/backend/creationClient.ts");
        const client = creationClient(projectId);
        await client.refresh();
        const specId = crypto.randomUUID(),
          itemId = crypto.randomUUID();
        const result = await client.command("canvas.createGeneration", {
          spec: {
            id: specId,
            projectId,
            kind: "video",
            purpose: "generation",
            modelConfigId,
            prompt: "Preserve video draft",
            parameters: { videoMode: "first_frame", durationSeconds: 5 },
          },
          item: {
            id: itemId,
            projectId,
            kind: "video",
            position: { x: 500, y: 150 },
            binding: { role: "generation", objectRef: { id: specId } },
          },
          references: [
            {
              id: crypto.randomUUID(),
              projectId,
              targetSpecId: specId,
              binding: "follow_current",
              source: { id: sourceId },
              role: "first_frame",
              order: 0,
            },
          ],
        });
        if (result.status !== "applied") throw Error(JSON.stringify(result));
        return { specId, itemId };
      },
      { projectId, modelConfigId: saved.id, sourceId: source.id },
    );
    mode = "denied";
    await call("/api/model-configs/availability", {
      configIds: [saved.id],
      manual: true,
    });
    const blocked = (await call("/api/tools")).tools;
    for (const id of ["dynamic-poster", "video-edit"]) {
      const tool = blocked.find((tool) => tool.id === id);
      const capability =
        id === "dynamic-poster" ? "video.first_frame" : "video.edit";
      assert.equal(
        tool.models[capability].find((model) => model.id === saved.id)
          .availability.status,
        "unavailable",
      );
    }
    await page.reload();
    await page
      .getByRole("button", { name: en ? "Settings" : "设置", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: en ? "Model connections" : "模型接入",
        exact: true,
      })
      .click();
    await page
      .locator(".cw-model-setup-row")
      .filter({ hasText: en ? "Video model" : "视频模型" })
      .getByRole("button")
      .click();
    const card = page.locator(".cw-model-service").filter({ hasText: modelId });
    await card.locator("summary").first().click();
    await card
      .getByRole("button", {
        name: /^(Check|Refresh|Retry|检查|刷新|重试)$/,
        exact: true,
      })
      .click();
    await card
      .getByText(en ? "Input requirements" : "输入要求", { exact: true })
      .click();
    await card
      .getByText(en ? "First-frame image" : "首帧图片", { exact: true })
      .waitFor();
    await card
      .getByText(en ? "Audio editing mask" : "音频编辑蒙版", { exact: true })
      .waitFor();
    await until(
      () =>
        card
          .getByRole("button", {
            name: /^(Check|Refresh|Retry|检查|刷新|重试)$/,
            exact: true,
          })
          .isEnabled(),
      Boolean,
    );
    if (en) assert.doesNotMatch(await card.innerText(), /[\u3400-\u9fff]/);
    if (process.env.CREATION_SCREENSHOTS) {
      await mkdir(process.env.CREATION_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: join(
          process.env.CREATION_SCREENSHOTS,
          `video-roles-${locale}.png`,
        ),
        fullPage: true,
      });
    }
    await page
      .getByRole("button", {
        name: en ? "Close settings" : "关闭设置",
        exact: true,
      })
      .click();
    await page
      .locator(`.react-flow__node[data-id="${created.itemId}"]`)
      .click();
    const composer = page.locator(".cw-generation-composer");
    assert.match(await composer.innerText(), /Preserve video draft/);
    const before = await call(projectPath);
    const callsBefore = (await call("/api/creation-test-health")).calls.length;
    const receiptPromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/commands") &&
        response.request().postDataJSON()?.type === "generation.submit",
    );
    await composer.locator("button.cw-run-button").click();
    const receipt = await (await receiptPromise).json();
    assert.equal(receipt.status, "rejected");
    assert.equal((await call(projectPath)).jobs.length, 0);
    assert.equal(
      (await call("/api/creation-test-health")).calls.length,
      callsBefore,
    );
    assert.deepEqual((await call(projectPath)).references, before.references);
    assert.match(await composer.innerText(), /Preserve video draft/);
    mode = "unknown";
    await call("/api/model-configs/availability", {
      configIds: [saved.id],
      manual: true,
    });
    const unknown = (await call("/api/tools")).tools.find(
      (tool) => tool.id === "dynamic-poster",
    );
    assert.equal(
      unknown.models["video.first_frame"].find((model) => model.id === saved.id)
        .availability.status,
      "unknown",
    );
    assert.equal(unknown.available, true);
    await page.reload();
    await page
      .locator(`.react-flow__node[data-id="${created.itemId}"]`)
      .click();
    assert.match(await composer.innerText(), /Preserve video draft/);
    await composer.locator("button.cw-run-button").click();
    const finished = await until(
      () => call(projectPath),
      (value) => value.jobs[0]?.status === "succeeded",
    );
    assert.equal(finished.jobs[0].inputSnapshot.model.modelId, modelId);
    assert.equal(
      finished.jobs[0].inputSnapshot.spec.prompt,
      "Preserve video draft",
    );
    assert.equal(finished.jobs[0].inputSnapshot.references.length, 1);
    assert.equal(finished.jobs[0].technicalCheck.status, "passed");
    const output = finished.assets.find((asset) => asset.kind === "video");
    const media = await fetch(
      `${api}${projectPath}/assets/${output.id}/content`,
      { headers },
    );
    assert.equal(media.status, 200);
    assert.ok((await media.arrayBuffer()).byteLength > 0);
    assert.deepEqual(errors, []);
    evidence.push({
      locale,
      jobs: finished.jobs.length,
      output: output.metadata,
      preservedReferences: true,
    });
    await page.close();
  }
  console.log(JSON.stringify({ passed: true, queries, evidence }));
} finally {
  if (saved) await call(`/api/model-configs/${saved.id}`, undefined, "DELETE");
  await browser.close();
  service.closeAllConnections();
  await new Promise((resolve) => service.close(resolve));
}
