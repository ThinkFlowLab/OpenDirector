/** Direct canvas timeline output uses real browser MP4 rendering and versioned publication. */
import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? base;
const headers = { "X-OpenDirector-Request": "1" };
const health = await fetch(api + "/api/creation-test-health", { headers }).then((r) => r.json());
assert.equal(health.isolated, true);
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
  await page.addInitScript(() => {
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    localStorage.setItem("opendirector.locale.v1", "en-US");
  });
  const bootstrap = (url) => url.origin === new URL(base).origin && url.pathname === "/";
  await page.route(bootstrap, (route) => route.fulfill({ contentType: "text/html", body: "<html></html>" }));
  await page.goto(base + "/");
  const fixture = await page.evaluate(async () => {
    const { createDocument, createNode } = await import("/src/canvas/model.ts");
    const { addTimelineClip } = await import("/src/canvas/timeline.ts");
    const { importWorkspaceDocument } = await import("/src/backend/workspace.ts");
    const canvas = document.createElement("canvas");
    canvas.width = 160; canvas.height = 96;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#318175"; ctx.fillRect(0, 0, 160, 96);
    const node = createNode("timeline", { x: 150, y: 150 }, { title: "Direct timeline output" });
    node.data.timeline.width = 160; node.data.timeline.height = 96; node.data.timeline.fps = 24;
    node.data.timeline = addTimelineClip(node.data.timeline, {
      id: crypto.randomUUID(), kind: "image", title: "Green frame", src: canvas.toDataURL(), width: 160, height: 96,
    });
    node.data.timeline.tracks[0].clips[0].outPoint = 0.5;
    const saved = await importWorkspaceDocument({ ...createDocument("Timeline output " + crypto.randomUUID().slice(0, 8)), nodes: [node] });
    (await import("/src/backend/creationClient.ts")).creationClient(saved.id).close();
    await (await import("/src/backend/projects.ts")).releaseBackendProject();
    return { id: saved.id, item: node.id };
  });
  await page.unroute(bootstrap);
  const snapshot = () => fetch(`${api}/api/creation/projects/${fixture.id}`, { headers }).then((r) => r.json());
  await page.goto(`${base}/ai-tool/ai-canvas/${fixture.id}`);
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  const select = async () => {
    await page.locator(".cw-workspace").focus();
    await page.keyboard.press("Shift+1");
    await page.locator(`.react-flow__node[data-id="${fixture.item}"]`).click();
  };
  await select();
  const panel = page.locator(".cw-selection-toolbar");
  await panel.waitFor();
  assert.equal(await page.locator(".cw-composer-dock").count(), 0);
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let firstPublish = true;
  await page.route("**/commands", async (route) => {
    if (route.request().postDataJSON().type === "timeline.publishRender" && firstPublish) {
      firstPublish = false;
      await firstGate;
    }
    return route.continue();
  });
  await panel.getByRole("button", { name: "Output video", exact: true }).dblclick();
  const pending = page.locator('.react-flow__node-video').filter({ has: page.locator('.cw-node-generating') });
  await pending.waitFor();
  const pendingId = await pending.getAttribute("data-id");
  assert.equal(await pending.locator('.cw-generating').count(), 1);
  await page.locator(`.react-flow__edge[data-id="timeline-pending:${pendingId}"]`).waitFor();
  assert.equal(await panel.locator('progress').count(), 0);
  await page.waitForTimeout(400);
  // The injected pending node keeps its measured size, so the reference edge survives
  // later canvas renders instead of vanishing once its first frame is painted.
  await page.locator(`.react-flow__edge[data-id="timeline-pending:${pendingId}"]`).waitFor({ state: "visible", timeout: 5000 });
  await page.screenshot({ path: "/tmp/opendirector-timeline-pending.png" });
  releaseFirst();
  await page.unrouteAll({ behavior: "wait" });
  await page.locator(`.react-flow__node[data-id="${pendingId}"] video`).waitFor();
  let saved = await snapshot();
  const videos = saved.canvasItems.filter((item) => item.kind === "video");
  await page.locator(`.react-flow__edge[data-id^="publication:${pendingId}:"]`).waitFor();
  assert.equal(videos[0].id, pendingId, "pending identity is published in place");
  assert.equal(videos.length, 1, "double-click submits one output");
  const asset = saved.assets.find((asset) => asset.id === videos[0].binding.objectRef.assetId);
  assert.equal(asset.provenance.source, "rendered");
  assert.equal(asset.metadata.width, 160);
  assert.equal(asset.metadata.height, 96);
  assert.ok(Math.abs(asset.metadata.durationSeconds - 0.5) < 0.1);
  assert.ok(videos[0].position.y > saved.canvasItems.find((item) => item.id === fixture.item).position.y);
  assert.equal(await page.locator(".cw-timeline-dialog").count(), 0);
  await page.getByRole("button", { name: "中文", exact: true }).click();
  await select();
  const chinese = page.locator(".cw-selection-toolbar");
  await chinese.waitFor();
  // Cancel before rendering completes; no output should be published.
  await chinese.getByRole("button", { name: "输出视频", exact: true }).click();
  await page.locator(".cw-timeline-pending").getByRole("button", { name: "取消合成", exact: true }).click();
  await page.locator(".cw-timeline-pending").waitFor({ state: "hidden" });
  assert.equal((await snapshot()).canvasItems.filter((item) => item.kind === "video").length, 1);
  const publicationIds = [];
  let loseReply = true;
  await page.route("**/commands", async (route) => {
    const value = route.request().postDataJSON();
    if (value.type !== "timeline.publishRender") return route.continue();
    publicationIds.push(value.commandId);
    if (loseReply) {
      loseReply = false;
      return route.abort();
    }
    return route.continue();
  });
  await page.locator(`.react-flow__node[data-id="${fixture.item}"]`).focus();
  await page.keyboard.press("Meta+Enter");
  await page.locator(".cw-timeline-pending").getByRole("alert").waitFor().catch(async (error) => { console.error(await page.locator("body").innerText()); throw error; });
  const assetsBeforeRetry = (await snapshot()).assets.length;
  const retryId = await page.locator('.react-flow__node-video').filter({ has: page.locator('.cw-timeline-pending') }).getAttribute('data-id');
  await page.getByRole("button", { name: "重试输出", exact: true }).click();
  await page.locator(`.react-flow__node[data-id="${retryId}"] video`).waitFor();
  saved = await snapshot();
  assert.equal(saved.canvasItems.filter((item) => item.kind === "video").length, 1);
  assert.equal(saved.editorDocuments.length, 1);
  assert.equal(saved.assets.length, assetsBeforeRetry, "retry reuses the rendered asset");
  assert.ok(publicationIds.length >= 2);
  assert.equal(new Set(publicationIds).size, 1, "retry replays the same publication");
  assert.equal(await page.locator(".cw-timeline-dialog").count(), 0);
  await select();
  // The focused output control must support the Windows/Linux modifier too.
  await chinese.getByRole("button", { name: "输出视频", exact: true }).focus();
  const published = page.waitForResponse((response) => response.request().method() === "POST" && response.request().url().endsWith("/commands") && response.request().postDataJSON().type === "timeline.publishRender");
  await page.keyboard.press("Control+Enter");
  const publishedReceipt = await (await published).json();
  assert.equal(publishedReceipt.status, "applied", JSON.stringify(publishedReceipt));
  await page.locator(".cw-timeline-pending").waitFor({ state: "hidden" });
  await page.locator(".cw-workspace").focus();
  await page.keyboard.press("Shift+1");
  assert.equal((await snapshot()).canvasItems.filter((item) => item.kind === "video").length, 1);
  await page.locator(`.react-flow__node[data-id="${pendingId}"] video`).waitFor();
  await page.locator(`.react-flow__node[data-id="${pendingId}"] .cw-node-version-button`).click();
  await page.getByRole("radio").nth(2).waitFor();
  assert.equal(await page.getByRole("radio").count(), 3);
  await page.locator(`[data-version-asset-id="${asset.id}"]`).click();
  const applied = page.waitForResponse((response) => response.request().method() === "POST" && response.request().url().endsWith("/commands") && response.request().postDataJSON().type === "canvas.applyVersion");
  await page.getByRole("button", { name: "应用到画布", exact: true }).click();
  assert.equal((await applied).status(), 200);
  const restored = (await snapshot()).canvasItems.find((item) => item.id === pendingId);
  assert.equal(restored.binding.objectRef.assetId, asset.id);
  assert.deepEqual(errors, []);
  await page.evaluate(async (id) => {
    (await import("/src/backend/creationClient.ts")).creationClient(id).close();
    await (await import("/src/backend/projects.ts")).releaseBackendProject();
  }, fixture.id);
  await page.reload();
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await page.locator(`.react-flow__edge[data-id^="publication:${pendingId}:"]`).waitFor();
  assert.equal((await snapshot()).canvasItems.filter((item) => item.kind === "video").length, 1);
  await page.screenshot({ path: process.env.TIMELINE_OUTPUT_SCREENSHOT ?? "/tmp/opendirector-timeline-output.png" });
  // Removing a source during publication must clear its transient output.
  const disappearingSource = await page.evaluate(async ({ id, item }) => {
    const { creationClient } = await import("/src/backend/creationClient.ts");
    const client = creationClient(id);
    const source = client.snapshot.canvasItems.find((entry) => entry.id === item);
    const copy = { ...source, id: crypto.randomUUID(), position: { x: 700, y: 150 } };
    await client.command("canvas.show", { item: copy }, []);
    return copy.id;
  }, fixture);
  await page.locator(".cw-workspace").focus();
  await page.keyboard.press("Shift+1");
  await page.locator(`.react-flow__node[data-id="${disappearingSource}"]`).click();
  let releaseRemoved;
  const removedGate = new Promise((resolve) => { releaseRemoved = resolve; });
  const removedSubmitted = page.waitForRequest((request) => request.method() === "POST" &&
    request.url().endsWith("/commands") && request.postDataJSON().type === "timeline.publishRender" &&
    request.postDataJSON().payload.itemId === disappearingSource);
  await page.unrouteAll({ behavior: "wait" });
  await page.route("**/commands", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type === "timeline.publishRender" && command.payload.itemId === disappearingSource) {
      await removedGate;
    }
    return route.continue();
  });
  await page.locator(".cw-selection-toolbar").getByRole("button", { name: "Output video", exact: true }).click();
  await removedSubmitted;
  await page.locator(".cw-timeline-pending").waitFor();
  const hideSource = async (visible) => page.evaluate(async ({ id, itemId, visible }) => {
    const { creationClient, objectVersion } = await import("/src/backend/creationClient.ts");
    const client = creationClient(id);
    const source = client.snapshot.canvasItems.find((entry) => entry.id === itemId);
    // Simulate another writer while this browser waits for publication.
    const { storageRequest, json } = await import("/src/backend/api.ts");
    const receipt = await storageRequest(`/creation/projects/${id}/commands`, json("POST", {
      commandId: crypto.randomUUID(), projectId: id,
      type: visible ? "canvas.show" : "canvas.hide",
      payload: visible ? { item: source } : { itemId },
      expectedVersions: [objectVersion("canvas_item", source)],
    }));
    if (receipt.status !== "applied") throw new Error(JSON.stringify(receipt));
    await client.refresh();
  }, { id: fixture.id, itemId: disappearingSource, visible });
  await hideSource(false);
  await page.locator(".cw-timeline-pending").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".cw-workspace").count(), 1);
  assert.equal(await page.locator('.react-flow__edge[data-id^="timeline-pending:"]').count(), 0);
  const removedReply = page.waitForResponse((response) => response.request().method() === "POST" &&
    response.request().url().endsWith("/commands") &&
    response.request().postDataJSON().type === "timeline.publishRender");
  releaseRemoved();
  assert.equal((await (await removedReply).json()).status, "rejected");
  assert.equal((await snapshot()).canvasItems.filter((item) => item.kind === "video").length, 1);
  await page.unrouteAll({ behavior: "wait" });
  await hideSource(true);
  await page.locator(".cw-workspace").focus();
  await page.keyboard.press("Shift+1");
  await page.locator(`.react-flow__node[data-id="${disappearingSource}"]`).click();
  const recoveredOutput = page.waitForResponse((response) => response.request().method() === "POST" &&
    response.request().url().endsWith("/commands") && response.request().postDataJSON().type === "timeline.publishRender");
  await page.locator(".cw-selection-toolbar").getByRole("button", { name: "Output video", exact: true }).click();
  const recoveredReply = await recoveredOutput;
  assert.equal((await recoveredReply.json()).status, "applied");
  await page.locator(".cw-timeline-pending").waitFor({ state: "hidden" });
  assert.equal((await snapshot()).canvasItems.filter((item) => item.kind === "video").length, 2);
  assert.deepEqual(errors, []);
  const identicalOutputs = await page.evaluate(async ({ id, item }) => {
    const { creationClient } = await import("/src/backend/creationClient.ts");
    const { timelinePublication, timelineOutputItem } = await import("/src/backend/timelinePublication.ts");
    const { mediaBlobDataUrl } = await import("/src/canvas/localMediaRuntime.ts");
    const client = creationClient(id);
    const output = timelineOutputItem(client.snapshot, item);
    const originalId = output.binding.objectRef.assetId;
    const src = await mediaBlobDataUrl(await client.blob(originalId), new AbortController().signal);
    client.rememberSource(src, originalId);
    const result = { kind: "video", src, title: "Identical render", mimeType: "video/mp4" };
    const assets = [];
    for (let index = 0; index < 2; index++) {
      await timelinePublication(client, client.snapshot, item)(result);
      const current = timelineOutputItem(client.snapshot, item);
      assets.push(client.snapshot.assets.find((asset) => asset.id === current.binding.objectRef.assetId));
    }
    return assets.map(({ id, fingerprint }) => ({ id, fingerprint }));
  }, fixture);
  assert.notEqual(identicalOutputs[0].id, identicalOutputs[1].id);
  assert.equal(identicalOutputs[0].fingerprint, identicalOutputs[1].fingerprint);
  assert.equal((await snapshot()).canvasItems.filter((item) => item.kind === "video").length, 2);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ isolated: true, realMp4: true, button: true, shortcut: true, bilingual: true, oneOutputThreeVersions: true, provenanceEdge: true, versionRestored: true, removedSourceCleared: true, identicalRenderVersions: true, editorOpened: false }));
} finally {
  await browser.close();
}
