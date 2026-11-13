/** Real adapters, loopback HTTP and bilingual UI. Start creation_server.py with
 * --http-generation-fixture. Only the model response bytes are substituted. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
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
async function until(read, accepts, label) {
  const deadline = Date.now() + 20000;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (accepts(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error(`${label}: ${JSON.stringify(value)}`);
}
assert.equal(
  (await call("/api/creation-test-health")).httpGenerationFixture,
  true,
);
const media = spawnSync("ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=blue:s=64x48:r=24",
  "-t",
  "1",
  "-c:v",
  "libx264",
  "-threads",
  "1",
  "-pix_fmt",
  "yuv420p",
  "-movflags",
  "frag_keyframe+empty_moov",
  "-f",
  "mp4",
  "pipe:1",
]);
assert.equal(media.status, 0, media.stderr.toString());
const modelId = "MiniMaxAI/MiniMax-H3",
  posts = [];
let mode = "open",
  pauseTime;
function declaration() {
  const route = {
    transport: "http",
    method: "POST",
    path: "/v1/videos",
    exposure: mode === "closed" ? "disabled" : "enabled",
  };
  const profile = (id, support, inputs = {}, parameters = {}) => ({
    id,
    support,
    required_inputs: ["text"],
    outputs: ["video"],
    routes: [{ ...route, request: { inputs, parameters } }],
  });
  return {
    object: "omni.capabilities",
    schema_version: 1,
    observed_at: new Date().toISOString(),
    routes: [route],
    models: [
      {
        id: modelId,
        operations: {
          video_generation: {
            support: "supported",
            exposure: "enabled",
            ...(mode === "paused"
              ? {
                  execution: {
                    state: "paused",
                    scope: "deployment",
                    observed_at: pauseTime,
                  },
                }
              : {}),
            profiles: [
              profile("text_to_video", "supported"),
              profile("video_to_video", "unsupported"),
              profile("video_continuation", "supported", {
                video: { support: "supported", min_count: 0, max_count: 0 },
              }),
              profile(
                "image_to_video",
                "supported",
                {
                  image: { support: "supported", min_count: 1, max_count: 1 },
                  first_frame: { support: "supported", max_count: 1 },
                },
                {
                  num_frames: {
                    type: "integer",
                    maximum: mode === "poster10" ? 10 : 124,
                  },
                },
              ),
            ],
          },
        },
      },
    ],
  };
}
const service = createServer(async (request, response) => {
  try {
    let result;
    if (request.url === "/v1/omni/capabilities") result = declaration();
    else if (request.method === "POST" && request.url === "/v1/videos") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const form = await new Request("http://fixture/v1/videos", {
        method: "POST",
        headers: request.headers,
        body: Buffer.concat(chunks),
      }).formData();
      const fields = {},
        files = [];
      for (const [key, value] of form) {
        if (typeof value === "string") fields[key] = value;
        else files.push({ key, name: value.name, size: value.size });
      }
      posts.push({ fields, files });
      result = { id: `video_gen_${posts.length}`, status: "queued" };
    } else if (/^\/v1\/videos\/video_gen_\d+\/content$/.test(request.url)) {
      response
        .writeHead(200, { "Content-Type": "video/mp4" })
        .end(media.stdout);
      return;
    } else if (/^\/v1\/videos\/video_gen_\d+$/.test(request.url))
      result = { id: request.url.split("/").at(-1), status: "completed" };
    else
      throw Error(`Unexpected model request: ${request.method} ${request.url}`);
    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});
service.listen(0, "127.0.0.1");
await once(service, "listening");
const browser = await launchBrowser();
let config, page;
const evidence = [];
try {
  config = await call("/api/model-configs", {
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
    mode = "open";
    page = await browser.newPage({
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
    delete headers["X-OpenDirector-Session"];
    const projectId = crypto.randomUUID(),
      path = `/api/creation/projects/${projectId}`;
    await call(path + "/commands", {
      projectId,
      commandId: crypto.randomUUID(),
      type: "project.create",
      payload: { name: `Video review ${locale}` },
    });
    await page.goto(`${base}/ai-tool/ai-canvas/${projectId}`);
    await page
      .getByText(en ? "Saved on this device" : "已保存到本机", { exact: true })
      .waitFor();
    const createNode = async (sourceId) =>
      page.evaluate(
        async ({ projectId, configId, sourceId }) => {
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
              modelConfigId: configId,
              prompt: sourceId
                ? "Continue the lighthouse scene"
                : "A lighthouse at sunset",
              parameters: {
                videoMode: sourceId ? "continuation" : "first_frame",
                durationSeconds: 5,
              },
            },
            item: {
              id: itemId,
              projectId,
              kind: "video",
              position: { x: sourceId ? 500 : 0, y: 100 },
              binding: { role: "generation", objectRef: { id: specId } },
            },
            references: sourceId
              ? [
                  {
                    id: crypto.randomUUID(),
                    projectId,
                    targetSpecId: specId,
                    binding: "follow_current",
                    source: { id: sourceId },
                    role: "continuation",
                    order: 0,
                  },
                ]
              : [],
          });
          if (result.status !== "applied") throw Error(JSON.stringify(result));
          return { specId, itemId };
        },
        { projectId, configId: config.id, sourceId },
      );
    const composer = page.locator(".cw-generation-composer");
    const select = async (itemId) => {
      await page.locator(".cw-workspace").focus();
      await page.keyboard.press("Shift+1");
      await page.locator(`.react-flow__node[data-id="${itemId}"]`).click();
      await composer.waitFor();
    };
    const refresh = async () =>
      call("/api/model-configs/availability", {
        configIds: [config.id],
        manual: true,
      });
    const first = await createNode();
    await refresh();
    await select(first.itemId);
    await composer.locator("button.cw-run-button").click();
    const firstSnapshot = await until(
      () => call(path),
      (s) => s.jobs.some((j) => j.status === "succeeded"),
      "first video",
    );
    const remoteId = firstSnapshot.jobs[0].externalTaskId;
    assert.ok(remoteId?.startsWith("video_gen_"));
    const continuation = await createNode(first.itemId);
    await select(continuation.itemId);
    const original = await call(path),
      count = posts.length;
    for (const blocked of ["closed", "paused"]) {
      mode = blocked;
      pauseTime = new Date().toISOString();
      await refresh();
      await page.reload();
      await select(continuation.itemId);
      assert.match(await composer.innerText(), /Continue the lighthouse scene/);
      const button = composer.locator("button.cw-run-button");
      assert.equal(await button.isDisabled(), true, await composer.innerText());
      assert.equal(posts.length, count);
      const after = await call(path);
      assert.deepEqual(after.jobs, original.jobs);
      assert.deepEqual(after.references, original.references);
      assert.deepEqual(after.generationSpecs, original.generationSpecs);
    }
    // Keep this page mounted. The pause expires independently of the declaration.
    await until(
      () => composer.locator("button.cw-run-button").isEnabled(),
      Boolean,
      "expired pause in composer",
    );
    await composer.locator("button.cw-run-button").click();
    const completed = await until(
      () => call(path),
      (s) =>
        s.jobs.length === 2 && s.jobs.every((j) => j.status === "succeeded"),
      "continuation",
    );
    assert.equal(posts.length, count + 1);
    assert.equal(
      JSON.parse(posts.at(-1).fields.extra_params).continue_from,
      remoteId,
    );
    assert.deepEqual(posts.at(-1).files, []);
    const job = completed.jobs.find(
      (j) => j.inputSnapshot.spec.id === continuation.specId,
    );
    assert.equal(job.inputSnapshot.references[0].transmission, "latent");
    assert.equal(
      job.inputSnapshot.spec.prompt,
      "Continue the lighthouse scene",
    );
    assert.equal(job.technicalCheck.status, "passed");
    // Reopen the project; saved selection, source relationship and output survive.
    await page.reload();
    await select(continuation.itemId);
    assert.match(await composer.innerText(), /Continue the lighthouse scene/);
    mode = "poster10";
    await refresh();
    await page
      .getByLabel(en ? "Choose local asset files" : "选择本地素材文件", {
        exact: true,
      })
      .setInputFiles({
        name: "poster.png",
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGNsYGhgIAUwkaR6VMOohiGlAQBCPQEgiSD+iQAAAABJRU5ErkJggg==",
          "base64",
        ),
      });
    const uploaded = await until(
      () => call(path),
      (s) =>
        s.assets.some((a) => a.kind === "image") &&
        s.canvasItems.some((i) => i.kind === "image"),
      "poster source",
    );
    const source = uploaded.canvasItems.find((i) => i.kind === "image");
    await page
      .getByText(en ? "Saved on this device" : "已保存到本机", { exact: true })
      .waitFor();
    await page.reload();
    const openPoster = async () => {
      await page.locator(`.react-flow__node[data-id="${source.id}"]`).click();
      await page
        .getByRole("button", {
          name: en ? "Marketing tools" : "营销工具",
          exact: true,
        })
        .click();
      await page
        .getByRole("menuitem", {
          name: en ? "Motion poster" : "动态海报",
          exact: true,
        })
        .click();
    };
    await openPoster();
    const panel = page.locator(".cw-node-task-panel");
    await panel.locator("textarea").fill("Animate the light");
    const submit = panel.locator("button.cw-node-task-primary");
    const taskCount = (await call(path + "/tool-tasks")).tasks.length,
      posterPosts = posts.length;
    const denial = page.waitForResponse(
      (r) => r.url().endsWith("/tool-tasks") && r.request().method() === "POST",
    );
    await submit.click();
    const denied = await denial;
    assert.equal(denied.status(), 409);
    assert.match((await denied.json()).detail, en ? /Frame count/ : /帧数/);
    assert.equal((await call(path + "/tool-tasks")).tasks.length, taskCount);
    assert.equal(posts.length, posterPosts);
    // Submission closes the editor. Reopening must restore the saved draft.
    await openPoster();
    assert.equal(
      await panel.locator("textarea").inputValue(),
      "Animate the light",
    );
    mode = "open";
    await refresh();
    await submit.click();
    const tasks = await until(
      () => call(path + "/tool-tasks"),
      (s) => s.tasks.some((t) => t.status === "succeeded"),
      "dynamic poster",
    );
    const task = tasks.tasks.find((t) => t.status === "succeeded");
    assert.equal(task.videoExecution.requests[0].num_frames, 124);
    assert.equal(task.videoExecution.requests[0].fps, 24);
    assert.equal(posts.at(-1).fields.num_frames, "124");
    assert.equal(posts.at(-1).fields.fps, "24");
    assert.deepEqual(
      posts.at(-1).files.map((f) => f.key),
      ["input_reference"],
    );
    assert.ok(task.outputs[0].durationMs > 0);
    assert.equal(task.modelConfigIds["video.first_frame"], config.id);
    await page.waitForFunction((id) => {
      const video = document.querySelector(
        `.react-flow__node[data-id="${id}"] video.cw-video-preview`,
      );
      return (
        video?.videoWidth === 64 &&
        video.videoHeight === 48 &&
        video.duration > 0
      );
    }, task.canvas.targetNodeId);
    await page.locator(".cw-workspace").focus();
    await page.keyboard.press("Shift+1");
    assert.deepEqual(errors, []);
    if (process.env.CREATION_SCREENSHOTS) {
      await mkdir(process.env.CREATION_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: join(process.env.CREATION_SCREENSHOTS, `review-${locale}.png`),
        fullPage: true,
      });
    }
    evidence.push({
      locale,
      continuationRemoteId: remoteId,
      continuationUploads: 0,
      posterFrames: 124,
      posterFps: 24,
      jobs: completed.jobs.length,
      toolTasks: tasks.tasks.length,
    });
    await page.close();
  }
  console.log(JSON.stringify({ passed: true, evidence, posts }));
} catch (error) {
  if (page && process.env.CREATION_SCREENSHOTS) {
    await writeFile(
      join(process.env.CREATION_SCREENSHOTS, "review-failure.txt"),
      await page.locator("body").innerText(),
    );
    await page.screenshot({
      path: join(process.env.CREATION_SCREENSHOTS, "review-failure.png"),
      fullPage: true,
    });
  }
  throw error;
} finally {
  if (config)
    await call(`/api/model-configs/${config.id}`, undefined, "DELETE");
  await browser.close();
  service.closeAllConnections();
  await new Promise((resolve) => service.close(resolve));
}
