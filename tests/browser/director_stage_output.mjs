/** Fourth-phase Director Stage acceptance: captured stills and preview MP4s
 * become tracked project assets that the timeline can reference. */
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const headers = {
  "X-OpenDirector-Request": "1",
  "Content-Type": "application/json",
};

async function call(path, body, extra = {}) {
  const response = await fetch(api + path, {
    headers: { ...headers, ...extra },
    ...(body
      ? { method: "POST", body: JSON.stringify(body) }
      : {}),
  });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json();
}

assert.equal((await call("/api/creation-test-health")).isolated, true);

const projectId = crypto.randomUUID();
await call(`/api/creation/projects/${projectId}/commands`, {
  commandId: crypto.randomUUID(),
  projectId,
  type: "project.create",
  payload: { name: `Director output ${projectId.slice(0, 8)}` },
});

const state = () => call(`/api/creation/projects/${projectId}`);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({
  locale: "en-US",
  viewport: { width: 1700, height: 1100 },
  // Still capture must stay at encoder resolution on high-DPI displays;
  // run once with CREATION_DEVICE_SCALE_FACTOR=2 to verify.
  ...(process.env.CREATION_DEVICE_SCALE_FACTOR
    ? {
        deviceScaleFactor: Number(process.env.CREATION_DEVICE_SCALE_FACTOR),
      }
    : {}),
});
await page.addInitScript(() =>
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
);
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (predicate, label) => {
  const deadline = Date.now() + 20000;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await state();
    if (predicate(snapshot)) return snapshot;
    await sleep(100);
  }
  throw new Error(`Timeout: ${label}; snapshot: ${JSON.stringify(snapshot)}`);
};

const stageDoc = (snapshot) =>
  snapshot.editorDocuments.find((candidate) => candidate.kind === "director");
const imageAssets = (snapshot) =>
  snapshot.assets.filter((asset) => asset.kind === "image");
const browserSessions = new Set();
page.on("request", (request) => {
  const value = request.headers()["x-opendirector-session"];
  if (value) browserSessions.add(value);
});
const apply = async () => {
  await page
    .getByRole("button", { name: "Apply edits", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Apply edits", exact: true })
    .waitFor({ state: "detached" });
};
const openStage = async (itemId) => {
  await page.locator(`.react-flow__node[data-id="${itemId}"]`).click();
  await page
    .getByRole("button", { name: "Open Director Stage", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Apply edits", exact: true })
    .waitFor();
};

const timelineId = crypto.randomUUID();
const clipId = crypto.randomUUID();
let firstStill, secondStill, videoRef, videoAsset, itemId;
try {
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Add Director Stage", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Apply edits", exact: true })
    .waitFor();
  const created = await until(
    (snapshot) => stageDoc(snapshot)?.kind === "director",
    "created director document",
  );
  itemId = created.canvasItems.find((item) => item.kind === "external").id;
  await page.getByLabel("Stage duration", { exact: true }).fill("1");

  const capture = page.getByRole("button", {
    name: "Capture camera still",
    exact: true,
  });
  const readyDeadline = Date.now() + 20000;
  while (!(await capture.isEnabled())) {
    if (Date.now() > readyDeadline) throw new Error("stage renderer not ready");
    await page.waitForTimeout(100);
  }
  await apply();

  const captured = await until(
    (snapshot) => !!stageDoc(snapshot)?.data.still,
    "first apply registers a captured still",
  );
  firstStill = stageDoc(captured).data.still;
  assert.equal(firstStill.kind, "image");
  const firstImage = captured.assets.find(
    (asset) => asset.id === firstStill.assetId,
  );
  assert.ok(firstImage, "the still is a real project asset");
  assert.equal(firstImage.metadata.mimeType, "image/png");
  assert.equal(firstImage.metadata.width, 1280);
  assert.equal(firstImage.metadata.height, 720);

  await openStage(itemId);
  await apply();
  const unchanged = await until(
    (snapshot) => imageAssets(snapshot).length === imageAssets(captured).length,
    "apply without capture keeps the pinned still",
  );
  assert.equal(stageDoc(unchanged).data.still.assetId, firstStill.assetId);

  await openStage(itemId);
  await page.getByLabel("Position X", { exact: true }).fill("2");
  await capture.click();
  await page
    .getByText(
      "Still captured. Applying registers it as a project image asset.",
      { exact: true },
    )
    .waitFor();
  await apply();
  const recaptured = await until(
    (snapshot) =>
      imageAssets(snapshot).length === imageAssets(unchanged).length + 1,
    "an explicit capture registers a second still",
  );
  secondStill = stageDoc(recaptured).data.still;
  assert.notEqual(secondStill.assetId, firstStill.assetId);
  assert.ok(
    recaptured.assets.some((asset) => asset.id === firstStill.assetId),
    "the earlier still stays registered instead of being overwritten",
  );

  await openStage(itemId);
  await page
    .getByRole("button", { name: "Render preview MP4", exact: true })
    .click();
  await page
    .getByText("Preview MP4 complete · 1280×720 · 30 fps", { exact: true })
    .waitFor({ timeout: 240000 });
  await page
    .getByRole("button", { name: "Add preview video to canvas", exact: true })
    .click();
  const published = await until(
    (snapshot) =>
      snapshot.canvasItems.some(
        (item) =>
          item.kind === "video" && item.binding.role === "material",
      ),
    "the preview MP4 publishes an output node",
  );
  const outputItem = published.canvasItems.find(
    (item) => item.kind === "video" && item.binding.role === "material",
  );
  videoRef = outputItem.binding.objectRef;
  videoAsset = published.assets.find(
    (asset) => asset.id === videoRef.assetId,
  );
  assert.ok(videoAsset, "the MP4 output pins a real project asset");
  assert.equal(videoAsset.kind, "video");
  assert.equal(videoAsset.metadata.mimeType, "video/mp4");
  assert.ok(videoAsset.metadata.durationSeconds >= 0.9);


  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  const reopened = await state();
  assert.equal(stageDoc(reopened).data.still.assetId, secondStill.assetId);
  assert.ok(
    reopened.canvasItems.some((item) => item.id === outputItem.id),
    "the published output node survives reload",
  );
  await openStage(itemId);
  await apply();
  assert.deepEqual(errors, []);
} catch (error) {
  console.error((await page.locator("body").innerText()).slice(-2500));
  throw error;
} finally {
  await browser.close();
}

// The browser lease outlives page close; release it before opening a
// session of our own to reference the published output from a timeline.
for (const id of browserSessions) {
  const response = await fetch(`${api}/api/creation/sessions/${id}`, {
    method: "DELETE",
    headers,
  });
  assert.ok(
    response.ok,
    `release ${id}: ${response.status} ${await response.text()}`,
  );
}
const sessionId = crypto.randomUUID();
const session = { "X-OpenDirector-Session": sessionId };
await call(`/api/creation/projects/${projectId}/open`, {}, session);
const resource = {
  asset: videoRef,
  title: "Director shot",
  durationSeconds: videoAsset.metadata.durationSeconds,
};
await call(
  `/api/creation/projects/${projectId}/commands`,
  {
    commandId: crypto.randomUUID(),
    projectId,
    type: "creation.batch",
    payload: {
    operations: [
      {
        type: "editor.create",
        payload: {
          document: {
            id: timelineId,
            projectId,
            revision: 1,
            kind: "timeline",
            inputConnections: [],
            data: {
              fps: 30,
              width: 1280,
              height: 720,
              importedAssets: [resource],
              tracks: [
                {
                  id: "visual",
                  kind: "visual",
                  title: "Visual",
                  clips: [
                    {
                      id: clipId,
                      resource,
                      inPoint: 0,
                      outPoint: videoAsset.metadata.durationSeconds,
                    },
                  ],
                },
              ],
            },
          },
        },
      },
      {
        type: "canvas.show",
        payload: {
          item: {
            id: crypto.randomUUID(),
            projectId,
            kind: "timeline",
            title: "Director timeline",
            binding: {
              role: "editor",
              objectRef: { id: timelineId, kind: "timeline" },
            },
          },
        },
      },
    ],
    },
  },
  session,
);
await fetch(`${api}/api/creation/sessions/${sessionId}`, { method: "DELETE" });
const final = await until(
  (snapshot) => snapshot.editorDocuments.some((doc) => doc.id === timelineId),
  "timeline referencing the director output",
);
const timeline = final.editorDocuments.find((doc) => doc.id === timelineId);
assert.equal(
  timeline.data.tracks[0].clips[0].resource.asset.assetId,
  videoAsset.id,
);
console.log(
  JSON.stringify({
    passed: true,
    projectId,
    itemId,
    stillAssetIds: [firstStill.assetId, secondStill.assetId],
    videoAssetId: videoAsset.id,
    timelineId,
    checks: [
      "first apply auto-captures a 1280x720 still asset",
      "uncaptured applies keep the pinned still without new assets",
      "explicit capture registers a distinct still and keeps the old one",
      "preview MP4 publishes an output node with a real video asset",
      "timeline clip references the published assetId",
      "stage, still, output and timeline survive reload",
      "no page errors",
    ],
  }),
);
