/** Isolated fixture only: canvas structure first, independent node media, retained content. */
import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const headers = { "X-OpenDirector-Request": "1" };
const health = await fetch(`${base}/api/creation-test-health`, { headers });
assert.ok(health.ok && (await health.json()).isolated, "Requires an isolated creation API");

const copy = {
  "en-US": { loading: "Loading media", failed: "Could not load media", retry: "Retry", picker: "Switch project" },
  "zh-CN": { loading: "素材加载中", failed: "素材加载失败", retry: "重试", picker: "切换项目" },
};
const snapshot = async (id) =>
  (await fetch(`${base}/api/creation/projects/${id}`, { headers })).json();
const assetOf = (project, itemId) =>
  project.canvasItems.find((item) => item.id === itemId).binding.objectRef.assetId;
const itemOf = (project, itemId) =>
  project.canvasItems.find((item) => item.id === itemId);

async function seedProjects(browser) {
  const seed = await browser.newPage({ locale: "en-US" });
  await seed.route((url) => url.pathname === "/", (route) =>
    route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }));
  await seed.goto(`${base}/`);
  const fixture = await seed.evaluate(async () => {
    const { createDocument, createNode } = await import("/src/canvas/model.ts");
    const { importWorkspaceDocument } = await import("/src/backend/workspace.ts");
    const { releaseBackendProject } = await import("/src/backend/projects.ts");
    const picture = (hue) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 96;
      const context = canvas.getContext("2d");
      context.fillStyle = `hsl(${hue},60%,45%)`;
      context.fillRect(0, 0, 96, 96);
      return canvas.toDataURL("image/png");
    };
    const image = (title, x, hue) =>
      createNode("image", { x, y: 80 }, {
        title, mediaRole: "asset", src: picture(hue), mimeType: "image/png", assetState: "ready",
      });
    const suffix = crypto.randomUUID().slice(0, 8);
    const first = createDocument(`Progressive A ${suffix}`);
    const delayed = image("Delayed", 40, 10 + Math.random() * 40);
    const failed = image("Failed", 460, 90 + Math.random() * 40);
    const ready = image("Ready", 880, 170 + Math.random() * 40);
    const hidden = image("Hidden", 40, 250 + Math.random() * 40);
    const text = createNode("text", { x: 40, y: 520 }, { title: "Words", text: "Authoritative text" });
    const far = image("Far", 3000, 45 + Math.random() * 20);
    first.nodes = [delayed, failed, ready, text, far];
    first.hiddenNodes = [hidden];
    const second = createDocument(`Progressive B ${suffix}`);
    const other = image("Other", 40, 320 + Math.random() * 30);
    second.nodes = [other];
    const a = await importWorkspaceDocument(first);
    // A saved viewport keeps the far node off screen when the canvas opens.
    const { creationClient } = await import("/src/backend/creationClient.ts");
    await creationClient(a.id).view({ viewport: { x: 0, y: 0, zoom: 1 } });
    const b = await importWorkspaceDocument(second);
    // Importing leaves this page's lease on B; closing the page must not be the only release.
    await releaseBackendProject();
    return {
      viewClientId: sessionStorage.getItem("opendirector.creation.viewClientId"),
      a: { id: a.id, name: a.title }, b: { id: b.id, name: b.title },
      delayed: delayed.id, failed: failed.id, ready: ready.id, hidden: hidden.id, far: far.id, text: text.id, other: other.id,
    };
  });
  await seed.close();
  return fixture;
}

async function verifyLocale(browser, locale) {
  const text = copy[locale];
  const fixture = await seedProjects(browser);
  const before = await snapshot(fixture.a.id);
  const delayedAsset = assetOf(before, fixture.delayed);
  const failedAsset = assetOf(before, fixture.failed);
  const hiddenAsset = assetOf(before, fixture.hidden);
  const farAsset = assetOf(before, fixture.far);
  const context = await browser.newContext({ locale, viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((id) => {
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    sessionStorage.setItem("opendirector.creation.viewClientId", id);
  }, fixture.viewClientId);
  const release = Promise.withResolvers();
  const failing = new Set([failedAsset]);
  const requested = new Set();
  await page.route(/\/api\/creation\/projects\/[^/]+\/assets\/[^/]+\/content$/, async (route) => {
    const assetId = new URL(route.request().url()).pathname.split("/").at(-2);
    requested.add(assetId);
    if (failing.has(assetId))
      return route.fulfill({ status: 409, json: { detail: "unavailable", code: "storage_unavailable" } });
    if (assetId === delayedAsset) await release.promise;
    return route.continue().catch(() => {});
  });
  const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
  const decoded = (id) =>
    page.waitForFunction((nodeId) => {
      const picture = document.querySelector(`.react-flow__node[data-id="${nodeId}"] img`);
      return Boolean(picture?.complete && picture.naturalWidth > 0);
    }, id);
  const open = async (project) => {
    await page.getByRole("button", { name: text.picker, exact: true }).click();
    await page.getByRole("menuitemradio", { name: project.name, exact: true }).click();
    await page.locator(".cw-project-name").getByText(project.name, { exact: true }).waitFor();
  };

  await page.goto(`${base}/ai-tool/ai-canvas/${fixture.a.id}`);
  // One held read must not delay the structure or any other node.
  await page.waitForFunction(() => {
    const element = document.querySelector(".cw-workspace");
    return element?.getAttribute("aria-busy") === "false" && !element.inert;
  });
  await node(fixture.delayed).getByRole("status").getByText(text.loading).waitFor();
  assert.equal(await node(fixture.delayed).locator(".cw-placeholder-upload").count(), 0);
  await decoded(fixture.ready);
  await node(fixture.text).getByText("Authoritative text").waitFor();
  await node(fixture.failed).getByText(text.failed).waitFor();
  assert.equal(await node(fixture.hidden).count(), 0);
  assert.ok(!requested.has(hiddenAsset), "A hidden node must not read its media");
  assert.ok(!requested.has(farAsset), "An off-screen node must wait for the viewport");

  // Editing while media loads saves structure only.
  const box = await node(fixture.delayed).boundingBox();
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 30, start.y + 24, { steps: 5 });
  await page.mouse.up();
  const original = itemOf(before, fixture.delayed).position;
  let moved;
  for (let attempt = 0; attempt < 100; attempt++) {
    moved = await snapshot(fixture.a.id);
    if (itemOf(moved, fixture.delayed).position.x !== original.x) break;
    await page.waitForTimeout(100);
  }
  assert.notEqual(itemOf(moved, fixture.delayed).position.x, original.x, "The move must save");
  assert.equal(assetOf(moved, fixture.delayed), delayedAsset, "Unloaded media must keep its asset");
  assert.equal(moved.assets.length, before.assets.length, "Saving must not create assets");

  // A failed read recovers on its own node.
  failing.delete(failedAsset);
  await node(fixture.failed).getByRole("button", { name: text.retry }).click();
  await decoded(fixture.failed);

  // A late read belongs to its project and cannot appear in another one.
  await open(fixture.b);
  await decoded(fixture.other);
  release.resolve();
  await page.waitForTimeout(250);
  assert.equal(await node(fixture.delayed).count(), 0);
  assert.equal(await node(fixture.other).locator("img").count(), 1);
  await open(fixture.a);
  await decoded(fixture.delayed);
  await decoded(fixture.failed);
  const after = await snapshot(fixture.a.id);
  for (const id of [fixture.delayed, fixture.failed, fixture.ready, fixture.hidden, fixture.far])
    assert.equal(assetOf(after, id), assetOf(before, id), "Reopening must keep every asset binding");
  assert.equal(after.assets.length, before.assets.length);

  // Media loads when its node reaches the viewport.
  assert.ok(!requested.has(farAsset));
  await page.mouse.move(750, 500);
  for (let step = 0; step < 12 && !requested.has(farAsset); step++) {
    await page.mouse.wheel(1200, 0);
    await page.waitForTimeout(120);
  }
  await decoded(fixture.far);
  assert.deepEqual(errors, []);
  await context.close();
}

const browser = await launchBrowser();
try {
  for (const locale of ["en-US", "zh-CN"]) await verifyLocale(browser, locale);
  console.log("canvas progressive load: ok");
} finally {
  await browser.close();
}
