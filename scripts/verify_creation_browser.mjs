/** Real UI/API loop using tests/browser/creation_server.py. No paid models.
 * Set PLAYWRIGHT_MODULE and CHROMIUM_PATH when using an existing installation.
 */
import assert from "node:assert/strict";
import { launchBrowser } from "../tests/browser/engine.mjs";
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const headers = {
  "X-OpenDirector-Request": "1",
  "Content-Type": "application/json",
};
const call = async (path, body) => {
  const response = await fetch(api + path, {
    headers,
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  assert.ok(
    response.ok,
    `${response.status}: ${await response.clone().text()}`,
  );
  return response.json();
};
assert.equal(
  (await call("/api/creation-test-health")).isolated,
  true,
  "Use the isolated fixture server",
);
const browser = await launchBrowser();
const page = await browser.newPage({ locale: "en-US", viewport: { width: 1500, height: 1000 } });
// Skip the first-run model setup welcome; it covers the canvas.
await page.addInitScript(() =>
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
);
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("response", (response) => {
  if (response.status() >= 400 && response.url().includes("/api/"))
    console.error("API response", response.status(), response.url());
});
const reopen = process.env.CREATION_REOPEN_PROJECT;
const projectId = reopen ?? crypto.randomUUID();
if (!reopen)
  await call(`/api/creation/projects/${projectId}/commands`, {
    commandId: crypto.randomUUID(),
    projectId,
    type: "project.create",
    payload: { name: `Browser closure ${projectId.slice(0, 8)}` },
  });
const state = () => call(`/api/creation/projects/${projectId}`);
const until = async (predicate, label) => {
  const deadline = Date.now() + 15000;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await state();
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout: ${label}; jobs: ${JSON.stringify(snapshot?.jobs)}`);
};
const rail = (label) =>
  page
    .getByRole("toolbar", { name: "Canvas creation tools" })
    .getByRole("button", { name: `Add ${label}`, exact: true });
try {
  if (reopen) {
    const before = await state();
    const calls = (await call("/api/creation-test-health")).calls.length;
    await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
    await page.getByText("Saved on this device", { exact: true }).waitFor();
    assert.equal(
      await page.locator(".react-flow__node").count(),
      before.canvasItems.filter((item) => item.visible).length,
    );
    assert.deepEqual(await state(), before);
    assert.equal((await call("/api/creation-test-health")).calls.length, calls);
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        passed: true,
        reopenedProject: projectId,
        eventCursor: before.eventCursor,
        checks: [
          "service restart",
          "same business snapshot",
          "no provider resubmit",
        ],
      }),
    );
  } else {
    await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
    await page.getByText("Saved on this device", { exact: true }).waitFor();
    await rail("Text").click();
    let snapshot = await until(
      (value) => value.canvasItems.length === 1,
      "source created",
    );
    const sourceId = snapshot.canvasItems[0].id;
    const source = page.locator(`.react-flow__node[data-id="${sourceId}"]`);
    await source.locator(".cw-text-display").dblclick();
    await source.getByRole("textbox").fill("Source version one");
    await rail("Text").click();
    snapshot = await until(
      (value) => value.canvasItems.length === 2 && value.assets.length === 1,
      "material and target saved",
    );
    const sourceAsset = snapshot.assets[0],
      targetId = snapshot.canvasItems[1].id;
    // Arrange through the public semantic API so both real drag targets are visible.
    await page.evaluate(
      async ({ projectId, sourceId, targetId }) => {
        const { creationClient, objectVersion } =
          await import("/src/backend/creationClient.ts");
        const client = creationClient(projectId);
        await client.refresh();
        await client.command(
          "canvas.move",
          {
            items: [
              { itemId: sourceId, position: { x: 150, y: 150 } },
              { itemId: targetId, position: { x: 700, y: 150 } },
            ],
          },
          client.snapshot.canvasItems.map((item) =>
            objectVersion("canvas_item", item),
          ),
        );
      },
      { projectId, sourceId, targetId },
    );
    await page.waitForTimeout(600);
    const target = page.locator(`.react-flow__node[data-id="${targetId}"]`);
    const bounds = await source.boundingBox(),
      targetBounds = await target.boundingBox();
    assert.ok(bounds && targetBounds);
    await page.mouse.move(
      bounds.x + bounds.width + 22,
      bounds.y + bounds.height / 2,
    );
    const outputPort = page.locator(
      `.cw-reference-port[data-reference-source="${sourceId}"][data-side="right"]`,
    );
    await outputPort.waitFor();
    const port = await outputPort.boundingBox();
    assert.ok(port);
    await page.mouse.move(port.x + port.width / 2, port.y + port.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBounds.x + 30, targetBounds.y + 40, {
      steps: 12,
    });
    await page.mouse.up();
    snapshot = await until(
      (value) => value.references.some((ref) => ref.active),
      "dragged reference committed",
    );
    const targetSpecId = snapshot.references.find(
      (ref) => ref.active,
    ).targetSpecId;
    await target.locator(".cw-node-title").click();
    const prompt = page.getByRole("textbox", {
      name: "Text prompt",
      exact: true,
    });
    await prompt.fill("Based on @");
    await prompt.press("Enter");
    await prompt.locator("[data-reference]").waitFor();
    await source.locator(".cw-node-title").dblclick();
    await page
      .getByRole("textbox", { name: "Node name", exact: true })
      .fill("Source A");
    await page
      .getByRole("textbox", { name: "Node name", exact: true })
      .press("Enter");
    snapshot = await until((value) => {
      const spec = value.generationSpecs.find(
        (entry) => entry.id === targetSpecId,
      );
      const ref = value.references.find(
        (entry) =>
          entry.active &&
          entry.targetSpecId === targetSpecId &&
          entry.binding === "follow_current" &&
          entry.source.id === sourceId,
      );
      return (
        value.canvasItems.find((item) => item.id === sourceId)?.title ===
          "Source A" &&
        spec?.prompt === "Based on @Source A" &&
        spec.promptContent?.some(
          (part) => part.type === "text" && part.text === "Based on ",
        ) &&
        spec.promptContent?.some(
          (part) => part.type === "reference" && part.referenceId === ref?.id,
        )
      );
    }, "rename and structured mention saved");
    const referenceId = snapshot.references.find(
      (ref) =>
        ref.active &&
        ref.targetSpecId === targetSpecId &&
        ref.binding === "follow_current" &&
        ref.source.id === sourceId,
    ).id;
    await target.locator(".cw-node-title").click();
    await prompt
      .locator("[data-reference]")
      .filter({ hasText: "Source A" })
      .waitFor();
    await call("/api/creation-test-gate", { open: false });
    await page
      .getByRole("textbox", { name: "Text prompt", exact: true })
      .press("Control+Enter");
    snapshot = await until((value) => value.jobs.length === 1, "job accepted");
    const jobId = snapshot.jobs[0].id;
    // Hide the display without changing the target's reference intent.
    await page.evaluate(async ({ projectId, sourceId }) => {
      const { creationClient, objectVersion } =
        await import("/src/backend/creationClient.ts");
      const client = creationClient(projectId);
      const item = client.snapshot.canvasItems.find((item) => item.id === sourceId);
      await client.command("canvas.hide", { itemId: sourceId }, [
        objectVersion("canvas_item", item),
      ]);
    }, { projectId, sourceId });
    await until(
      (value) =>
        !value.canvasItems.find((item) => item.id === sourceId).visible,
      "source hidden while generating",
    );
    await call("/api/creation-test-gate", { open: true });
    snapshot = await until(
      (value) => value.jobs[0].status === "succeeded",
      "background completion",
    );
    assert.equal(snapshot.jobs[0].adopted, true);
    assert.equal(snapshot.generationSpecs.find((spec) => spec.id === targetSpecId).currentResultId, snapshot.results[0].id);
    assert.equal(
      snapshot.jobs[0].inputSnapshot.references[0].asset.assetId,
      sourceAsset.id,
    );
    assert.equal(
      snapshot.jobs[0].inputSnapshot.references[0].referenceId,
      referenceId,
    );
    assert.equal(
      snapshot.jobs[0].inputSnapshot.spec.prompt,
      "Based on @Source A",
    );
    assert.equal(snapshot.canvasItems.length, 2);
    assert.equal(snapshot.generationSpecs.length, 2);
    // Hiding a source changes its display, not the accepted creative intent.
    // Normal if_current adoption remains valid and needs no extra selection.
    await page
      .getByText(/Fixture generated:/)
      .first()
      .waitFor();
    await page.getByRole("button", { name: "Asset list", exact: true }).click();
    const list = page.getByRole("dialog", { name: "Asset list", exact: true });
    await list.waitFor();
    const sourceRow = list
      .locator(".cw-creation-asset-row")
      .filter({ has: page.getByText("Source A", { exact: true }) });
    await sourceRow.waitFor();
    assert.equal(
      await page.getByRole("dialog", { name: "Asset list", exact: true }).count(),
      1,
    );
    assert.equal(await list.getByRole("button", { name: /Preview/ }).count(), 0);
    await sourceRow.locator(".cw-creation-asset-open").click();
    await until(
      (value) => value.canvasItems.find((item) => item.id === sourceId).visible,
      "same logical source restored",
    );
    snapshot = await state();
    assert.equal(snapshot.canvasItems.length, 2);
    assert.equal(snapshot.assets.length, 2);
    await page.evaluate(async (projectId) => {
      const { creationClient } = await import("/src/backend/creationClient.ts");
      await creationClient(projectId).writeText(
        "Disposable",
        "Unused local bytes",
      );
    }, projectId);
    await page.getByRole("button", { name: "Asset list", exact: true }).click();
    await list.waitFor();
    const disposable = list
      .locator(".cw-creation-asset-row")
      .filter({ hasText: "Disposable.md" });
    await disposable.waitFor();
    await disposable.getByRole("checkbox").check();
    await list
      .getByRole("button", { name: "Delete selected (1)", exact: true })
      .click();
    await list
      .getByRole("button", { name: "Confirm permanent deletion", exact: true })
      .click();
    await until(
      (value) => !value.assets.some((asset) => asset.name === "Disposable.md"),
      "permanent deletion",
    );
    await list
      .getByRole("button", { name: "Close asset list", exact: true })
      .click();
    for (const kind of ["Image", "Video", "Audio", "Subject", "Timeline"])
      await rail(kind).click();
    snapshot = await until(
      (value) => value.canvasItems.length === 7,
      "all six node kinds persisted",
    );
    assert.deepEqual(
      [...new Set(snapshot.canvasItems.map((item) => item.kind))].sort(),
      ["audio", "image", "subject", "text", "timeline", "video"],
    );
    await page.getByRole("button", { name: "Generation history", exact: true }).click();
    await page
      .getByRole("button", { name: "Restore generation settings", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Restore generation settings", exact: true })
      .click();
    await page
      .getByText("Generation configuration restored. The current result is kept and no new generation task was started.", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      (await state()).jobs.length,
      1,
      "Restoring config does not start a job",
    );
    await page.getByRole("button", { name: "Close sidebar", exact: true }).click();
    await page.reload();
    await page.getByText("Saved on this device", { exact: true }).waitFor();
    assert.equal(await page.locator(".react-flow__node").count(), 7);
    snapshot = await state();
    assert.equal(snapshot.jobs[0].id, jobId);
    assert.equal(snapshot.results.length, 1);
    assert.equal(
      (await call("/api/creation-test-health")).calls.filter(
        (call) => call.id === jobId,
      ).length,
      1,
    );
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        passed: true,
        projectId,
        visibleNodes: 7,
        referenceId,
        jobId,
        results: 1,
        checks: [
          "UI create/edit",
          "drag reference",
          "structured @",
          "rename",
          "hidden source generation",
          "same-ID restore",
          "asset list without preview",
          "permanent deletion",
          "six kinds",
          "config history",
          "reload",
        ],
      }),
    );
  }
} catch (error) {
  console.error(
    "Browser state:",
    (await page.locator("body").innerText()).slice(-2500),
  );
  console.error("Page errors:", errors);
  throw error;
} finally {
  await call("/api/creation-test-gate", { open: true }).catch(() => {});
  // Closing Chromium can end the renderer before pagehide's keepalive finishes.
  // Await the normal public release endpoint so restart checks model a clean
  // window close without bypassing the application's other-window protection.
  await page
    .evaluate(async () => {
      const { releaseBackendProject } =
        await import("/src/backend/projects.ts");
      await releaseBackendProject();
    })
    .catch(() => {});
  await browser.close();
}
