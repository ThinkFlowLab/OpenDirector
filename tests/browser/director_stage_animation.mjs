/** Third-phase Director Stage acceptance: an animated GLB follows the stage
 * timeline into the same sampled MP4. Runs against the isolated fixture. */
import assert from "node:assert/strict";
import { makeAnimatedGlb, makeUnnamedClipGlb } from "./director_stage_fixture.mjs";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const headers = {
  "X-OpenDirector-Request": "1",
  "Content-Type": "application/json",
};

async function call(path, body) {
  const response = await fetch(api + path, {
    headers,
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
  payload: { name: `Director animation ${projectId.slice(0, 8)}` },
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
});
await page.addInitScript(() =>
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
);
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

const until = async (predicate, label) => {
  const deadline = Date.now() + 20000;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await state();
    if (predicate(snapshot)) return snapshot;
    await page.waitForTimeout(100);
  }
  throw new Error(`Timeout: ${label}; snapshot: ${JSON.stringify(snapshot)}`);
};

const directorDocument = (snapshot) =>
  snapshot.editorDocuments.find(
    (candidate) => candidate.kind === "director",
  );

try {
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Add Director Stage", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Apply edits", exact: true })
    .waitFor();
  await until(
    (snapshot) => directorDocument(snapshot)?.kind === "director",
    "created director document",
  );
  const itemId = (await state()).canvasItems.find(
    (item) => item.kind === "external",
  ).id;

  await page.getByLabel("Stage duration", { exact: true }).fill("2");
  await page
    .locator('input[type="file"][accept*=".glb"]')
    .setInputFiles({
      name: "walker.glb",
      mimeType: "model/gltf-binary",
      buffer: makeAnimatedGlb(),
    });
  await page
    .getByText("Imported walker · 1 animation clips", { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "walker", exact: true })
    .waitFor();

  const playhead = page.getByRole("slider", { name: "Stage playhead", exact: true });
  await page
    .getByRole("button", { name: "Add motion at playhead", exact: true })
    .click();
  await page.getByLabel("Motion 1", { exact: true }).waitFor();

  const viewport = page.getByRole("img", {
    name: "Interactive 3D director stage",
    exact: true,
  });
  await viewport.waitFor();
  await playhead.fill("1");
  await page.waitForTimeout(200);
  const late = await viewport.screenshot();
  await playhead.fill("0.1");
  await page.waitForTimeout(200);
  const early = await viewport.screenshot();
  assert.ok(Buffer.compare(early, late) !== 0, "playhead scrub animates the imported model");

  // An unnamed clip pins the animation_{index} fallback shared with the
  // backend probe; the committed metadata must round-trip that exact name.
  await page
    .locator('input[type="file"][accept*=".glb"]')
    .setInputFiles({
      name: "unnamed.glb",
      mimeType: "model/gltf-binary",
      buffer: makeUnnamedClipGlb(),
    });
  await page
    .getByText("Imported unnamed · 1 animation clips", { exact: true })
    .waitFor();

  await page
    .getByRole("button", { name: "Render preview MP4", exact: true })
    .click();
  await page
    .getByText("Preview MP4 complete · 1280×720 · 30 fps", { exact: true })
    .waitFor({ timeout: 240000 });
  // Applying saves and closes the stage editor in one step.
  await page
    .getByRole("button", { name: "Apply edits", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Apply edits", exact: true })
    .waitFor({ state: "detached" });

  const committed = await until((snapshot) => {
    const document = directorDocument(snapshot);
    const imported = document?.data.objects.find(
      (object) => object.kind === "gltf",
    );
    return (
      imported?.animationNames?.length === 1 &&
      imported?.motionClips?.length === 1
    );
  }, "committed animated stage document");
  const document = directorDocument(committed);
  const imported = document.data.objects.find((object) => object.kind === "gltf");
  assert.deepEqual(imported.animationNames, ["Walk"]);
  assert.equal(imported.hasAnimation, true);
  assert.deepEqual(
    { start: imported.motionClips[0].start, duration: imported.motionClips[0].duration },
    { start: 0, duration: 2 },
  );
  assert.equal(imported.motionClips[0].motion.preset, "walk");
  assert.ok(
    committed.assets.some((asset) => asset.id === imported.asset.assetId),
    "the animated model registers as a project asset",
  );
  const unnamed = document.data.objects.find(
    (object) => object.name === "unnamed",
  );
  assert.deepEqual(unnamed.animationNames, ["animation_0"]);
  assert.equal(unnamed.hasAnimation, true);

  await page
    .getByRole("button", { name: "Apply edits", exact: true })
    .waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      projectId,
      itemId,
      documentId: document.id,
      checks: [
        "animated GLB import discovers clips",
        "unnamed clips keep the loader's animation_0 fallback",
        "motion clip binds the imported model",
        "playhead scrub animates the preview",
        "MP4 renders through the same sampling",
        "animation metadata and motion clip persist",
        "no page errors",
      ],
    }),
  );
} catch (error) {
  console.error((await page.locator("body").innerText()).slice(-2500));
  throw error;
} finally {
  await browser.close();
}
