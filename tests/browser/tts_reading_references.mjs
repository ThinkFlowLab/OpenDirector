/** Isolated fixture only: TTS panels keep connected references visible and removable. */
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox"],
});
const page = await browser.newPage({
  locale: "zh-CN",
  viewport: { width: 1600, height: 1000 },
});
// Skip the first-run model setup welcome; it covers the canvas.
await page.addInitScript(() => {
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
  localStorage.setItem("opendirector.locale.v1", "zh-CN");
});
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGNsYGhgIAUwkaR6VMOohiGlAQBCPQEgiSD+iQAAAABJRU5ErkJggg==";

try {
  const health = await (
    await page.request.get(base + "/api/creation-test-health", {
      headers: { "X-OpenDirector-Request": "1" },
    })
  ).json();
  assert.equal(health.isolated, true, "Use the isolated fixture server");
  const bootstrap = (url) =>
    url.origin === new URL(base).origin && url.pathname === "/";
  await page.route(bootstrap, (route) =>
    route.fulfill({ contentType: "text/html", body: "<html></html>" }),
  );
  await page.goto(base + "/");
  const fixture = await page.evaluate(async (png) => {
    const { request } = await import("/src/backend/api.ts");
    const { createDocument, createNode } = await import("/src/canvas/model.ts");
    const { importWorkspaceDocument } =
      await import("/src/backend/workspace.ts");
    const { creationClient } = await import("/src/backend/creationClient.ts");
    const { releaseBackendProject } = await import("/src/backend/projects.ts");
    const models = await request("/model-configs");
    const speech = models.find(
      (model) =>
        model.kind === "audio" && model.protocol !== "vllm_omni_music",
    );
    const source = createNode(
      "image",
      { x: 160, y: 180 },
      {
        title: "朗读参考图",
        src: png,
        mimeType: "image/png",
        mediaRole: "asset",
        assetState: "ready",
      },
    );
    const audio = createNode(
      "audio",
      { x: 720, y: 200 },
      {
        title: "文本朗读节点",
        prompt: "请朗读这段文字",
        settings: speech
          ? {
              mode: "audio",
              model: speech.modelId,
              modelConfigId: speech.id,
              audioMode: "tts",
              audioCreationType: "audio",
              prompt: "请朗读这段文字",
            }
          : {
              mode: "audio",
              model: "SeedAudio 1.0",
              audioMode: "tts",
              audioCreationType: "audio",
              prompt: "请朗读这段文字",
            },
      },
    );
    const saved = await importWorkspaceDocument({
      ...createDocument("TTS reading references"),
      nodes: [source, audio],
      edges: [
        {
          id: crypto.randomUUID(),
          source: source.id,
          target: audio.id,
          sourceHandle: "out",
          targetHandle: "in",
        },
      ],
      viewport: { x: 0, y: 0, zoom: 0.9 },
    });
    const client = creationClient(saved.id);
    await client.refresh();
    const references = client.snapshot.references.filter(
      (reference) => reference.active,
    );
    const jobs = client.snapshot.jobs.length;
    client.close();
    await releaseBackendProject();
    return {
      id: saved.id,
      audioId: audio.id,
      sourceId: source.id,
      sourceTitle: source.data.title,
      usedServiceModel: Boolean(speech),
      savedReferences: references.length,
      jobs,
    };
  }, png);
  assert.equal(fixture.savedReferences, 1);
  assert.equal(fixture.jobs, 0);
  await page.unroute(bootstrap);

  const openAudioComposer = async () => {
    await page
      .locator(".react-flow__node")
      .filter({ hasText: "文本朗读节点" })
      .click();
    await page.getByRole("textbox", { name: "朗读文本", exact: true }).waitFor();
  };
  const expectVisibleReferences = async () => {
    const strip = page.locator(".cw-reference-strip");
    await strip.waitFor({ state: "visible" });
    assert.equal(
      await page.getByRole("button", { name: "引用素材：朗读参考图" }).count(),
      1,
    );
    assert.equal(
      await page.getByRole("button", { name: "移除参考：朗读参考图" }).count(),
      1,
    );
    await page
      .locator('[data-reference-role="reading-context"]')
      .waitFor({ state: "visible" });
    assert.match(
      await page.locator('[data-reference-role="reading-context"]').innerText(),
      /不把这些参考作为模型输入/,
    );
    assert.equal(
      await page.getByRole("button", { name: "引用已连接节点" }).count(),
      0,
    );
  };

  await page.goto(`${base}/ai-tool/ai-canvas/${fixture.id}`);
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  await openAudioComposer();
  await expectVisibleReferences();

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  await openAudioComposer();
  await expectVisibleReferences();

  await page.getByRole("button", { name: "移除参考：朗读参考图" }).click();
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  await page.locator(".cw-reference-strip").waitFor({ state: "hidden" });
  assert.equal(
    await page.locator('[data-reference-role="reading-context"]').count(),
    0,
  );
  await page
    .getByRole("button", { name: "添加参考素材", exact: true })
    .waitFor({ state: "visible" });

  const after = await page.evaluate(async (projectId) => {
    const { creationClient } = await import("/src/backend/creationClient.ts");
    const client = creationClient(projectId);
    await client.refresh();
    const active = client.snapshot.references.filter(
      (reference) => reference.active,
    );
    const jobs = client.snapshot.jobs.length;
    client.close();
    return { active: active.length, jobs };
  }, fixture.id);
  assert.equal(after.active, 0);
  assert.equal(after.jobs, 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      usedServiceModel: fixture.usedServiceModel,
      jobs: after.jobs,
    }),
  );
} finally {
  await browser.close();
}
