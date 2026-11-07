/** Real image-to-video canvas references using shared query/command contracts. No generation calls. */
import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const headers = { "X-OpenDirector-Request": "1", "Content-Type": "application/json" };
async function call(path, body) {
  const response = await fetch(api + path, { headers,
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
assert.equal((await call("/api/creation-test-health")).isolated, true);
const browser = await launchBrowser();
const page = await browser.newPage({ locale: "en-US", viewport: { width: 1600, height: 1000 } });
await page.addInitScript(() => {
  try { localStorage.setItem("opendirector.modelSetup.v1", "dismissed"); } catch {}
});
page.setDefaultTimeout(15000);
try {
  for (const binding of ["follow_current", "pinned"]) {
    const projectId = crypto.randomUUID();
    await call(`/api/creation/projects/${projectId}/commands`, { commandId: crypto.randomUUID(), projectId,
      type: "project.create", payload: { name: `Connected generation ${binding} ${projectId.slice(0, 8)}` } });
    await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
    await page.getByText("Saved on this device", { exact: true }).waitFor();
    await page.getByLabel("Choose local asset files", { exact: true }).setInputFiles({
      name: "reference.png", mimeType: "image/png",
      buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGNsYGhgIAUwkaR6VMOohiGlAQBCPQEgiSD+iQAAAABJRU5ErkJggg==", "base64"),
    });
    let source;
    for (let attempt = 0; attempt < 150; attempt++) {
      const snapshot = await call(`/api/creation/projects/${projectId}`);
      source = snapshot.canvasItems[0];
      if (source && snapshot.assets.length) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(source);
    const created = await page.evaluate(async ({ projectId, binding, source }) => {
      const { request } = await import("/src/backend/api.ts");
      const { creationClient } = await import("/src/backend/creationClient.ts");
      const client = creationClient(projectId);
      await client.refresh();
      const status = await request(`/creation/projects/${projectId}/canvas/${source.id}/status`);
      const fields = status.referenceSources[binding === "pinned" ? "pinned" : "followCurrent"];
      const specId = crypto.randomUUID(), itemId = crypto.randomUUID(), referenceId = crypto.randomUUID();
      const receipt = await client.command("canvas.createGeneration", {
        spec: { id: specId, projectId, kind: "video", purpose: "generation", prompt: "Animate the reference",
          parameters: { durationSeconds: 5, videoMode: "reference" } },
        item: { id: itemId, projectId, kind: "video", title: `Connected ${binding}`,
          position: { x: source.position.x + 500, y: source.position.y },
          binding: { role: "generation", objectRef: { id: specId } } },
        references: [{ id: referenceId, projectId, targetSpecId: specId, ...fields }],
      });
      if (receipt.status !== "applied") throw Error(JSON.stringify(receipt));
      return { sourceId: source.id, itemId, referenceId };
    }, { projectId, binding, source });
    await page.locator(`.react-flow__node[data-id="${created.itemId}"]`).waitFor();
    await page.locator(`.react-flow__edge[data-id="${created.referenceId}"]`).waitFor();
    const snapshot = await call(`/api/creation/projects/${projectId}`);
    assert.equal(snapshot.jobs.length, 0);
    assert.equal(snapshot.references[0].binding, binding);
    assert.equal(snapshot.canvasItems.find((item) => item.id === created.itemId).visible, true);
    if (binding === "pinned") assert.equal(snapshot.references[0].sourceVersion.id, created.sourceId);
  }
  console.log(JSON.stringify({ passed: true, checks: ["reusable source fields", "visible video before submission", "follow_current connection", "pinned connection"] }));
} finally {
  await browser.close();
}
