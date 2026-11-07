/** Pre-switch gate: real local video frames retain provenance and wait for saving.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const page = await browser.newPage({ locale: "en-US", viewport: { width: 1700, height: 1100 } });
await page.addInitScript(() => {
  try { localStorage.setItem("opendirector.modelSetup.v1", "dismissed"); } catch {}
});
page.setDefaultTimeout(15000);
const failures = [];
try {
  const headers = { "X-OpenDirector-Request": "1" };
  assert.equal(
    (
      await (
        await page.request.get(base + "/api/creation-test-health", { headers })
      ).json()
    ).isolated,
    true,
  );
  const pid = crypto.randomUUID();
  await page.request.post(base + `/api/creation/projects/${pid}/commands`, {
    headers,
    data: {
      projectId: pid,
      commandId: crypto.randomUUID(),
      type: "project.create",
      payload: { name: "Local output gate " + pid.slice(0, 8) },
    },
  });
  await page.goto(base + `/ai-tool/ai-canvas/${pid}`);
  const saved = () => page.getByText("Saved on this device", { exact: true }).waitFor();
  const state = async () =>
    await (
      await page.request.get(base + `/api/creation/projects/${pid}`, {
        headers,
      })
    ).json();
  await saved();
  const bytes = execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=96x64:r=10",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-c:a",
    "aac",
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
  await page.getByLabel("Choose local asset files", { exact: true }).setInputFiles({
    name: "source.mp4",
    mimeType: "video/mp4",
    buffer: bytes,
  });
  await page.locator(".react-flow__node").waitFor();
  await saved();
  const source = (await state()).canvasItems[0];
  async function open() {
    await page.locator(".cw-workspace").focus();
    await page.keyboard.press("Shift+1");
    await page.waitForTimeout(400);
    await page
      .locator(`.react-flow__node[data-id="${source.id}"]`)
      .click({ position: { x: 40, y: 60 } });
    await page.getByRole("button", { name: "Capture frame", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "Capture custom frame", exact: true })
      .click();
    await page.getByRole("button", { name: "Capture current frame", exact: true }).click();
    await page
      .getByRole("button", { name: "Add 1 frame to the canvas", exact: true })
      .waitFor();
  }
  await open();
  await page
    .getByRole("button", { name: "Add 1 frame to the canvas", exact: true })
    .click();
  await saved();
  await page.waitForFunction(
    () => document.querySelectorAll(".react-flow__node").length === 2,
  );
  const snapshot = await state();
  const output = snapshot.canvasItems.find((i) => i.id !== source.id);
  assert.ok(output, "normal local output is persisted");
  const asset = snapshot.assets.find(
    (a) => a.id === output.binding.objectRef.assetId,
  );
  const content = await page.request.get(
    base + `/api/creation/projects/${pid}/assets/${asset.id}/content`,
    { headers },
  );
  assert.equal(content.status(), 200);
  assert.ok((await content.body()).length > 50);
  await page.reload();
  await saved();
  const projected = await page.evaluate(async (pid) => {
    const { creationClient } = await import("/src/backend/creationClient.ts");
    const { CreationProjection } =
      await import("/src/backend/creationProjection.ts");
    const c = creationClient(pid);
    await c.refresh();
    return new CreationProjection(c).read();
  }, pid);
  const relation = projected.edges.find(
    (e) =>
      e.source === source.id &&
      e.target === output.id &&
      e.intent === "post_edit_result",
  );
  if (!relation)
    failures.push("Local frame output loses its source relation after reload");
  if (
    !asset.provenance.sources?.some(
      (r) => r.assetId === source.binding.objectRef.assetId,
    )
  )
    failures.push("Local frame output has no durable source asset provenance");
  await open();
  let refused = 0;
  await page.route("**/commands", async (route) => {
    const body = route.request().postDataJSON();
    if (body.type === "canvas.publishMedia") {
      refused++;
      return route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({
          detail: "fixture: local output publication refused",
        }),
      });
    }
    return route.continue();
  });
  await page
    .getByRole("button", { name: "Add 1 frame to the canvas", exact: true })
    .click();
  for (let i = 0; i < 100 && !refused; i++) await page.waitForTimeout(100);
  assert.ok(refused, "test must reach publication refusal");
  if (!(await page.locator(".cw-video-action-editor").count()))
    failures.push(
      "Video frame editor closes before rejected publication is confirmed, losing the captured-frame tray",
    );
  assert.equal(
    (await state()).canvasItems.length,
    2,
    "rejected node is not persisted",
  );
  await page.unroute("**/commands");
  await page
    .getByRole("button", { name: "Add 1 frame to the canvas", exact: true })
    .click();
  await page.locator(".cw-video-action-editor").waitFor({ state: "detached" });
  await saved();
  assert.equal(
    (await state()).canvasItems.length,
    3,
    "retry publishes exactly one result",
  );
  await page.reload();
  await saved();
  assert.equal((await state()).canvasItems.length, 3);
  await page.locator(".cw-workspace").focus();
  await page.keyboard.press("Shift+1");
  await page.waitForTimeout(400);
  await page
    .locator(`.react-flow__node[data-id="${output.id}"]`)
    .click({ position: { x: 40, y: 60 } });
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("menuitem", { name: "Grid split", exact: true }).click();
  await page.getByRole("button", { name: "2 × 2", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".react-flow__node").length === 7,
  );
  await saved();
  const grid = await state();
  const tiles = grid.assets.filter(
    (a) => a.provenance.sourceItemId === output.id,
  );
  assert.equal(tiles.length, 4);
  assert.ok(
    tiles.every((a) => a.metadata.width === 48 && a.metadata.height === 32),
  );
  const edit = grid.editorDocuments.find(
    (d) => d.id === tiles[0].provenance.editorDocumentId,
  );
  assert.equal(edit.data.tool, "grid-split");
  assert.deepEqual(edit.data.parameters, { rows: 2, columns: 2 });
  await page.reload();
  await saved();
  assert.equal((await state()).canvasItems.length, 7);
  await page.locator(".cw-workspace").focus();
  await page.keyboard.press("Shift+1");
  await page.waitForTimeout(400);
  await page
    .locator(`.react-flow__node[data-id="${source.id}"]`)
    .click({ position: { x: 40, y: 60 } });
  await page.getByRole("button", { name: "Separate audio", exact: true }).click();
  await page.getByRole("menuitem", { name: "Extract audio", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll(".react-flow__node").length === 8,
  );
  await saved();
  const audioState = await state();
  const audio = audioState.assets.find(
    (a) => a.kind === "audio" && a.provenance.sourceItemId === source.id,
  );
  assert.ok(audio);
  assert.ok(audio.metadata.durationSeconds > 0.9);
  assert.equal(
    audioState.editorDocuments.find(
      (d) => d.id === audio.provenance.editorDocumentId,
    ).data.tool,
    "extract-audio",
  );
  console.log(
    JSON.stringify(
      {
        projectId: pid,
        sourceId: source.id,
        outputId: output.id,
        assetId: asset.id,
        provenance: asset.provenance,
        refused,
        failures,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(failures, [], "pre-switch local-output publication gate");
} catch (error) {
  console.error((await page.locator("body").innerText()).slice(-3000));
  throw error;
} finally {
  await browser.close();
}
