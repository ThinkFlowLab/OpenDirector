/** Connecting two images to a first-last video node through the canvas fills
 * both frame slots when the model declares a last frame (#83).
 * Uses the isolated creation_server.py; no remote generation.
 */
import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";
import { chooseGenerationModel } from "./model_picker.mjs";

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
async function until(read, matches, label) {
  const deadline = Date.now() + 15000;
  while (true) {
    const value = await read();
    if (matches(value)) return value;
    assert.ok(Date.now() < deadline, `${label}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

assert.equal((await call("/api/creation-test-health")).isolated, true);
const minimax =
  (await call("/api/model-configs")).find(
    (model) => model.modelId === "MiniMax-H3",
  ) ??
  (await call("/api/model-configs", {
    kind: "video",
    url: "https://fixture.invalid/v2",
    modelId: "MiniMax-H3",
    apiKey: "fixture",
    protocol: "minimax_video_v2",
    connectionType: "api",
    authMode: "bearer",
  }));
assert.deepEqual(minimax.inputRules.frameRoles, ["first_frame", "last_frame"]);
const projectId = crypto.randomUUID();
await call(`/api/creation/projects/${projectId}/commands`, {
  commandId: crypto.randomUUID(),
  projectId,
  type: "project.create",
  payload: { name: `First-last connections ${projectId.slice(0, 8)}` },
});
const snapshot = () => call(`/api/creation/projects/${projectId}`);

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.addInitScript(() =>
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
  );
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  await page
    .getByText("已保存到本机", { exact: true })
    .waitFor({ state: "attached" });

  // Two distinct real images, each uploaded as its own canvas node.
  for (const [index, color] of ["#d33", "#36c"].entries()) {
    const png = await page.evaluate((color) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      const context = canvas.getContext("2d");
      context.fillStyle = color;
      context.fillRect(0, 0, 256, 256);
      return canvas.toDataURL("image/png").split(",")[1];
    }, color);
    await page.getByLabel("选择本地素材文件", { exact: true }).setInputFiles({
      name: `frame-${index + 1}.png`,
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
    await until(
      snapshot,
      (value) => value.canvasItems.length === index + 1,
      "image uploaded",
    );
  }
  const images = (await snapshot()).canvasItems.map((item) => item.id);

  // A blank video node on the MiniMax model in first-last mode. The frame
  // pickers are left untouched: the connections alone must fill them.
  await page
    .getByRole("toolbar", { name: "画布创作工具" })
    .getByRole("button", { name: "添加视频", exact: true })
    .click();
  const created = await until(
    snapshot,
    (value) => value.canvasItems.length === 3,
    "video node created",
  );
  const videoId = created.canvasItems.find(
    (item) => !images.includes(item.id),
  ).id;
  // Other checks may register their own MiniMax-H3 configs on the shared
  // fixture, so pick this exact configuration by id rather than by name.
  await chooseGenerationModel(page, `config:${minimax.id}`);
  await page
    .getByLabel("视频创作模式", { exact: true })
    .selectOption("first-last");
  await until(
    snapshot,
    (value) =>
      value.generationSpecs.some(
        (spec) =>
          spec.modelConfigId === minimax.id &&
          spec.parameters?.videoMode === "first_frame",
      ),
    "first-last mode saved",
  );

  // Lay the nodes out, then drag A → video and B → video on the canvas.
  const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
  const place = async (id, x, y) => {
    const box = await node(id).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 10 });
    await page.mouse.up();
  };
  await page.keyboard.press("Escape");
  await place(images[0], 300, 300);
  await place(images[1], 300, 750);
  await place(videoId, 1050, 520);
  for (const source of images) {
    const box = await node(source).boundingBox();
    await page.mouse.move(box.x + box.width + 7, box.y + box.height / 2);
    const port = page.getByRole("button", {
      name: "添加下游参考节点",
      exact: true,
    });
    await port.waitFor();
    const from = await port.boundingBox();
    const to = await node(videoId).boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
      steps: 15,
    });
    await page.mouse.up();
    await page.waitForTimeout(400);
  }
  await page.waitForFunction(
    () => document.querySelectorAll(".react-flow__edge").length === 2,
  );

  // The composer shows A then B, and the project stores the matching roles.
  await node(videoId).click();
  const first = page.getByLabel("选择首帧", { exact: true });
  const last = page.getByLabel("选择尾帧", { exact: true });
  await until(
    () => last.inputValue(),
    (value) => value === images[1],
    "last frame slot holds the second image",
  );
  assert.equal(await first.inputValue(), images[0]);
  const saved = await until(
    snapshot,
    (value) =>
      value.references
        .filter((ref) => ref.active)
        .map((ref) => ref.role)
        .sort()
        .join() === "first_frame,last_frame",
    "references saved as first_frame and last_frame",
  );
  const role = (id) =>
    saved.references.find((ref) => ref.active && ref.source?.id === id)?.role;
  assert.equal(role(images[0]), "first_frame");
  assert.equal(role(images[1]), "last_frame");

  // The assignment survives a reload.
  await page.reload();
  await page
    .getByText("已保存到本机", { exact: true })
    .waitFor({ state: "attached" });
  await node(videoId).click();
  await until(
    () => page.getByLabel("选择尾帧", { exact: true }).inputValue(),
    (value) => value === images[1],
    "last frame after reload",
  );
  assert.deepEqual(errors, []);
  console.log("first/last frame connections ok");
} catch (error) {
  await page
    .screenshot({ path: ".opendirector/first-last-connections-failure.png" })
    .catch(() => {});
  throw error;
} finally {
  await browser.close();
}
