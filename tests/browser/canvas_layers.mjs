import { chooseGenerationModel } from "./model_picker.mjs";
/** Real image/layer editing against the isolated creation fixture; no model calls. */
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);
const generated = process.argv.includes("--generated");
const outputAssetId = (snapshot) => {
  const binding = snapshot.canvasItems[0].binding;
  return binding.role === "generation"
    ? (binding.materialOverride?.assetId ??
        snapshot.results.find(
          (r) => r.id === snapshot.generationSpecs[0].currentResultId,
        )?.asset.assetId)
    : binding.objectRef.assetId;
};
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
assert.equal((await call("/api/creation-test-health")).isolated, true);
const projectId = crypto.randomUUID();
await call(`/api/creation/projects/${projectId}/commands`, {
  projectId,
  commandId: crypto.randomUUID(),
  type: "project.create",
  payload: { name: `Layer roundtrip ${projectId.slice(0, 8)}` },
});
const state = () => call(`/api/creation/projects/${projectId}`);
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await state();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Expected persisted layer state not observed");
}
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox"],
});
let page;
try {
  page = await browser.newPage({ locale: "en-US",
    viewport: { width: 1500, height: 1000 },
  });
  // Skip the first-run model setup welcome; it covers the canvas.
  await page.addInitScript(() =>
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
  );
  page.setDefaultTimeout(15000);
  page.on("response", async (response) => {
    if (response.url().endsWith("/commands")) {
      const receipt = await response.json();
      if (receipt.status === "rejected") console.error(receipt);
    }
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}`);
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  if (generated) {
    await page
      .getByRole("toolbar", { name: "Canvas creation tools" })
      .getByRole("button", { name: "Add Image", exact: true })
      .click();
    await chooseGenerationModel(page, { label: "fixture-image" });
    await page
      .getByRole("textbox", { name: "Prompt", exact: true })
      .fill("A purple square");
    await page.getByRole("button", { name: "Generate", exact: true }).click();
  } else
    await page.getByLabel("Choose local asset files", { exact: true }).setInputFiles({
      name: "source.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGNsYGhgIAUwkaR6VMOohiGlAQBCPQEgiSD+iQAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
  let snapshot = await until(
    (value) => value.canvasItems.length === 1 && value.assets.length === 1,
  );
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  const originalJobs = structuredClone(snapshot.jobs);
  const originalResults = structuredClone(snapshot.results);
  const itemId = snapshot.canvasItems[0].id;
  const originalAsset = snapshot.assets[0].id;
  async function openLayers() {
    const node = page.locator(`.react-flow__node[data-id="${itemId}"]`);
    await node.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Edit image", exact: true }).click();
    await page.getByRole("button", { name: "Layer studio", exact: true }).click();
    await page.getByRole("button", { name: "Text", exact: true }).waitFor();
  }
  await openLayers();
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page
    .getByLabel("Layer text content", { exact: true })
    .fill("Editable after reopen");
  await page.getByRole("button", { name: "Apply to canvas", exact: true }).click();
  // The apply control renames itself while the save is in flight, so its
  // absence is not acknowledgement. The studio stays mounted, and its pending
  // delivery stays in session storage, until the save resolves and it closes.
  await page
    .getByRole("button", { name: "Close the layer studio", exact: true })
    .waitFor({ state: "hidden" });
  snapshot = await until((value) =>
    value.editorDocuments.some(
      (doc) => doc.kind === "layers" && doc.data.layers.length === 2,
    ),
  );
  const layers = snapshot.editorDocuments.find((doc) => doc.kind === "layers");
  const output = outputAssetId(snapshot);
  assert.notEqual(output, originalAsset);
  assert.equal(layers.data.layers[0].content.asset.assetId, originalAsset);
  assert.equal(layers.data.layers[1].content.text, "Editable after reopen");
  assert.equal(snapshot.canvasItems[0].editors[0].id, layers.id);
  assert.ok(!JSON.stringify(layers).includes("data:image"));
  assert.ok(!JSON.stringify(layers).includes("blob:"));
  await page.reload();
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await openLayers();
  assert.equal(
    await page.getByLabel("Layer text content", { exact: true }).inputValue(),
    "Editable after reopen",
  );
  await page.getByLabel("Layer text content", { exact: true }).fill("Edited again");
  await page.getByRole("button", { name: "Apply to canvas", exact: true }).click();
  // Same as the first apply: wait until the studio closes, not until the
  // button label changes to the in-progress text.
  await page
    .getByRole("button", { name: "Close the layer studio", exact: true })
    .waitFor({ state: "hidden" });
  snapshot = await until((value) =>
    value.editorDocuments.some(
      (doc) =>
        doc.id === layers.id &&
        doc.data.layers[1].content.text === "Edited again",
    ),
  );
  assert.equal(
    snapshot.editorDocuments.filter((doc) => doc.kind === "layers").length,
    1,
  );
  assert.equal(
    snapshot.editorDocuments.find((doc) => doc.id === layers.id).revision,
    layers.revision + 1,
  );
  assert.equal(
    snapshot.editorDocuments.find((doc) => doc.id === layers.id).data.layers[0]
      .content.asset.assetId,
    originalAsset,
  );
  assert.notEqual(outputAssetId(snapshot), output);
  const dimensions = await page.evaluate(
    async ({ projectId, assetId }) => {
      const response = await fetch(
        `/api/creation/projects/${projectId}/assets/${assetId}/content`,
        { headers: { "X-OpenDirector-Request": "1" } },
      );
      if (!response.ok) throw new Error("Cannot read composed image");
      const image = await createImageBitmap(await response.blob());
      const size = { width: image.width, height: image.height };
      image.close();
      return size;
    },
    { projectId, assetId: outputAssetId(snapshot) },
  );
  assert.deepEqual(
    dimensions,
    generated ? { width: 320, height: 240 } : { width: 16, height: 16 },
  );
  const editedAsset = snapshot.assets.find(
    (a) => a.id === outputAssetId(snapshot),
  );
  assert.equal(editedAsset.provenance.source, "edited");
  assert.equal(editedAsset.provenance.editorDocumentId, layers.id);
  assert.equal(editedAsset.provenance.editorRevision, layers.revision + 1);
  if (generated) {
    assert.equal(snapshot.canvasItems[0].binding.role, "generation");
    assert.deepEqual(snapshot.jobs, originalJobs);
    assert.deepEqual(snapshot.results, originalResults);
    await page.evaluate(async (projectId) => {
      const { creationClient } = await import("/src/backend/creationClient.ts");
      const client = creationClient(projectId);
      await client.refresh();
      await client.selectResult(
        client.snapshot.generationSpecs[0].id,
        client.snapshot.results[0].id,
      );
    }, projectId);
    snapshot = await until(
      (value) => !value.canvasItems[0].binding.materialOverride,
    );
    assert.equal(outputAssetId(snapshot), originalAsset);
    assert.equal(snapshot.canvasItems[0].editors.length, 0);
    await page.reload();
    await page.getByText("Saved on this device", { exact: true }).waitFor();
    assert.equal(outputAssetId(await state()), originalAsset);
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      projectId,
      generated,
      checks: [
        generated ? "fixture generation through UI" : "real PNG upload",
        "image and text layers applied",
        "stable source asset refs",
        "reload and continue editing",
        "same editor identity",
        "persisted composite decodes as image",
      ],
    }),
  );
} catch (error) {
  console.error(await page?.locator("body").innerText());
  throw error;
} finally {
  await browser.close();
}
