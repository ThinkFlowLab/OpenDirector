import { chooseGenerationModel } from "./model_picker.mjs";
/** Official provider configuration and first/last frame edits; no remote generation. */
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
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
// Skip the first-run model setup welcome; it covers the canvas.
await page.addInitScript(() =>
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
);
page.setDefaultTimeout(15000);
try {
  // One official connection with both models, as the provider settings save
  // them; the picker step below switches between the two.
  const saved = await call("/api/model-configs/batch", {
    kind: "video",
    url: "https://fixture.invalid/v2",
    modelIds: ["MiniMax-H3", "MiniMax-H3-Lite"],
    apiKey: "fixture",
    protocol: "minimax_video_v2",
    connectionType: "api",
    authMode: "bearer",
  });
  const model = saved.find((item) => item.modelId === "MiniMax-H3");
  assert.deepEqual(model.inputRules.frameRoles, ["first_frame", "last_frame"]);
  const projectId = crypto.randomUUID();
  await call(`/api/creation/projects/${projectId}/commands`, {
    commandId: crypto.randomUUID(),
    projectId,
    type: "project.create",
    payload: { name: `Official H3 ${projectId}` },
  });
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    canvas.getContext("2d").fillRect(0, 0, 256, 256);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  for (const name of ["first.png", "last.png"]) {
    await page
      .getByLabel("选择本地素材文件", { exact: true })
      .setInputFiles({
        name,
        mimeType: "image/png",
        buffer: Buffer.from(png, "base64"),
      });
    const count = name === "first.png" ? 1 : 2;
    for (let attempt = 0; attempt < 150; attempt++) {
      const current = await call(`/api/creation/projects/${projectId}`);
      if (current.canvasItems.length === count) break;
      if (attempt === 149) throw Error(await page.locator("body").innerText());
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const snapshot = await call(`/api/creation/projects/${projectId}`);
  assert.equal(snapshot.canvasItems.length, 2);
  const created = await page.evaluate(
    async ({ projectId, modelId, sources }) => {
      const { creationClient } = await import("/src/backend/creationClient.ts");
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
          prompt: "Animate between these frames",
          parameters: {
            videoMode: "first_frame",
            resolution: "2K",
            durationSeconds: 5,
          },
        },
        item: {
          id: itemId,
          projectId,
          kind: "video",
          position: { x: 400, y: 50 },
          binding: { role: "generation", objectRef: { id: specId } },
        },
        references: sources.map((source, index) => ({
          id: crypto.randomUUID(),
          projectId,
          targetSpecId: specId,
          binding: "follow_current",
          source: { id: source.id },
          role: index ? "last_frame" : "first_frame",
          order: index,
        })),
      });
      if (receipt.status !== "applied") throw Error(JSON.stringify(receipt));
      return { itemId, specId };
    },
    { projectId, modelId: model.id, sources: snapshot.canvasItems },
  );
  await page.reload();
  const node = page.locator(`.react-flow__node[data-id="${created.itemId}"]`);
  await node.waitFor();
  await node.click();
  const first = page.getByLabel("选择首帧", { exact: true });
  const last = page.getByLabel("选择尾帧", { exact: true });
  await last.waitFor();
  await page.getByRole("combobox", { name: "生成模型", exact: true }).click();
  const models = page.getByRole("listbox", { name: "生成模型", exact: true });
  await models.getByRole("group", { name: "MiniMax 官方视频", exact: true }).waitFor();
  assert.equal(await models.getByText("本地服务", { exact: true }).count(), 0);
  await page.screenshot({ path: "/tmp/node-model-picker.png" });
  await page.keyboard.press("Escape");
  const lite = (await call("/api/model-configs")).find((item) => item.modelId === "MiniMax-H3-Lite");
  assert.ok(lite);
  await chooseGenerationModel(page, `config:${lite.id}`);
  await page.waitForFunction(async ({ projectId, specId, modelId }) => {
    const response = await fetch(`/api/creation/projects/${projectId}`, { headers: { "X-OpenDirector-Request": "1" } });
    const snapshot = await response.json();
    return snapshot.generationSpecs.find((spec) => spec.id === specId)?.modelConfigId === modelId;
  }, { projectId, specId: created.specId, modelId: lite.id });
  await chooseGenerationModel(page, `config:${model.id}`);

  assert.equal(await last.isEnabled(), true);
  assert.equal(await first.inputValue(), snapshot.canvasItems[0].id);
  assert.equal(await last.inputValue(), snapshot.canvasItems[1].id);
  await last.selectOption("");
  for (let attempt = 0; attempt < 150; attempt++) {
    const current = await call(`/api/creation/projects/${projectId}`);
    if (!current.references.some((ref) => ref.active && ref.targetSpecId === created.specId && ref.role === "last_frame")) break;
    if (attempt === 149) throw Error("tail frame edit was not committed");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await page.reload();
  await page.locator(`.react-flow__node[data-id="${created.itemId}"]`).click();
  assert.equal(
    await page.getByLabel("选择尾帧", { exact: true }).inputValue(),
    "",
  );
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "official provider config",
        "explicit frame roles",
        "frame projection after reload",
        "editable tail slot",
        "tail clearing persists",
      ],
    }),
  );
} finally {
  await browser.close();
}
