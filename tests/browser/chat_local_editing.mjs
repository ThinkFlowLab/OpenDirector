/** A new chat project can import, reference, and edit local media without sending a turn. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { launchBrowser } from "./engine.mjs";
import { playDownloadedMp4 } from "./play_downloaded_mp4.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const headers = { "X-OpenDirector-Request": "1", "Content-Type": "application/json" };
async function api(path, body) {
  const response = await fetch(base + "/api" + path, {
    headers, ...(body && { method: "POST", body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}
assert.ok((await api("/creation-test-health")).isolated);
const models = await api("/model-configs");
const projectId = crypto.randomUUID();
const root = "/creation/projects/" + projectId;
const state = () => api(root);
const conversation = () => api(root + "/assistant");
assert.equal((await api(root + "/commands", {
  projectId, commandId: crypto.randomUUID(), type: "project.create",
  payload: { name: "Local editing " + projectId.slice(0, 8) },
})).status, "applied");
const name = "Local shot.mp4";
const buffer = await readFile(new URL("../fixtures/timeline-text/visual-a.mp4", import.meta.url));
const fingerprint = "sha256:" + createHash("sha256").update(buffer).digest("hex");
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(20000);
  const errors = [], mutations = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (request.method() === "POST" && /\/assistant\/turns$|\/model-configs(?:\/batch)?$/.test(request.url())) {
      mutations.push(request.url());
    }
  });
  // Run creation_server.py --empty-models for a genuinely empty model database.
  // Shared CI services seed fixture models for other journeys. A fresh service with
  // an empty catalog exercises the same path without any network substitution.
  if (models.length) {
    await page.route("**/api/model-configs", route => route.request().method() === "GET"
      ? route.fulfill({ json: [] }) : route.continue());
  }
  await page.goto(base + "/ai-tool/ai-canvas/" + projectId);
  const welcome = page.locator("dialog.cw-welcome");
  await welcome.getByRole("radio", { name: "Create with chat", exact: true }).check();
  await welcome.getByRole("button", { name: "Enter workspace", exact: true }).click();
  await welcome.waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => localStorage.getItem("opendirector.modelSetup.v1")), "dismissed");
  const mode = page.getByTestId("workspace-mode-agent");
  const assets = page.locator(".cw-creation-assets");
  const openAssets = () => page.locator("button[data-chat-project-assets]").click();
  const draft = page.locator("#canvas-assistant").getByRole("textbox", { name: "Message content", exact: true });
  await draft.fill("Use this clip");
  await openAssets();
  const imported = page.waitForResponse(response => response.url().endsWith("/commands") &&
    response.request().postDataJSON()?.type === "asset.import");
  const uploadPath = "**/api" + root + "/uploads/*";
  const firstUpload = page.waitForRequest(request =>
    request.method() === "PUT" && request.url().includes(root + "/uploads/"));
  let release;
  const holdFirstUpload = new Promise(resolve => { release = resolve; });
  let uploadCount = 0;
  await page.route(uploadPath, async route => {
    if (route.request().method() !== "PUT") return route.continue();
    if (++uploadCount === 1) {
      await holdFirstUpload;
      return route.continue();
    }
    await route.fulfill({ status: 422, json: { detail: "Controlled upload refusal" } });
  });
  try {
    await assets.locator("input[data-project-import]").setInputFiles(
      [name, "Rejected shot.mp4"].map(name => ({ name, mimeType: "video/mp4", buffer })),
    );
    await firstUpload;
    await page.getByTestId("workspace-mode-canvas").click();
    await assets.waitFor({ state: "hidden" });
    await mode.click();
    await assets.getByRole("button", { name: "Importing media…", exact: true }).waitFor();
    assert.equal(uploadCount, 1);
    release();
    await assets.getByRole("alert").filter({ hasText: "Rejected shot.mp4" }).waitFor();
    assert.equal(uploadCount, 2);
  } finally {
    release();
    await page.unroute(uploadPath);
  }
  const receipt = await (await imported).json();
  assert.equal(receipt.status, "applied");
  const initial = await state();
  assert.deepEqual(initial.assets.map(asset => asset.name), [name]);
  const [asset] = initial.assets;
  assert.equal(asset.fingerprint, fingerprint);
  assert.deepEqual(initial.canvasItems, []);
  assert.deepEqual(initial.jobs, []);
  const reference = assets.locator('[data-reference-asset="' + asset.id + '"]');
  await reference.waitFor();
  assert.match(await assets.getByRole("alert").innerText(), /Rejected shot\.mp4/);
  const search = assets.getByRole("textbox", { name: "Find assets" });
  await search.fill("no such video");
  await reference.waitFor({ state: "hidden" });
  await search.fill("Local shot");
  await reference.click();
  await assets.waitFor({ state: "hidden" });
  const deadline = Date.now() + 10000;
  let chat;
  do {
    chat = await conversation();
    if (chat.assets?.some(record => record.id === asset.id)) break;
    assert.ok(Date.now() < deadline, "the referenced asset must be persisted to the unsent draft");
    await new Promise(resolve => setTimeout(resolve, 80));
  } while (true);
  assert.deepEqual(chat.messages, []);
  const part = chat.draftContent.find(part => part.type === "reference");
  assert.equal(part.assetId, asset.id);
  assert.equal(part.fingerprint, fingerprint);
  assert.equal(part.binding, "asset");
  assert.equal((await state()).canvasItems.length, 0);

  await page.setViewportSize({ width: 1540, height: 960 });
  await openAssets();
  const retryOpen = assets.getByRole("button", { name: "Retry opening the new timeline" });
  const projection = new URL("/api" + root + "/canvas", base).href;
  const rejectOpening = async route => {
    if (await retryOpen.isVisible()) {
      await route.fulfill({ status: 503, json: { detail: "Opening interrupted" } });
    } else {
      await route.continue();
    }
  };
  await page.route(projection, rejectOpening);
  await assets.locator("button[data-create-timeline]").click();
  await assets.getByRole("alert").filter({ hasText: "Opening interrupted" }).waitFor();
  const created = await state();
  assert.equal(created.editorDocuments.length, 1);
  assert.equal(created.canvasItems.length, 1);
  await page.unroute(projection, rejectOpening);
  await retryOpen.click();
  const timeline = page.locator(".cw-timeline-dialog");
  const add = timeline.locator(".cw-timeline-library-item").getByRole("button", { name, exact: true });
  await add.click();
  const clip = timeline.locator(".cw-timeline-clip");
  await clip.click();
  await timeline.getByLabel("Playback speed").selectOption("2");
  await timeline.getByRole("button", { name: "Apply edits", exact: true }).click();
  await timeline.waitFor({ state: "hidden" });
  assert.equal(await mode.getAttribute("aria-pressed"), "true");
  const saved = await state();
  const [item] = saved.canvasItems;
  const [document] = saved.editorDocuments;
  assert.deepEqual(saved.editorDocuments.map(editor => editor.id), [created.editorDocuments[0].id]);
  assert.deepEqual(saved.canvasItems.map(node => node.id), [created.canvasItems[0].id]);
  assert.equal(item.kind, "timeline");
  assert.equal(item.binding.objectRef.id, document.id);
  const [savedClip] = document.data.tracks[0].clips;
  assert.equal(savedClip.resource.asset.assetId, asset.id);
  assert.equal(savedClip.resource.asset.fingerprint, fingerprint);
  assert.equal(savedClip.speed, 2);
  await page.reload();
  await openAssets();
  await assets.getByRole("tab", { name: /^Timelines/ }).click();
  await assets.locator('[data-open-timeline="' + item.id + '"]').click();
  await clip.click();
  assert.equal(await timeline.getByLabel("Playback speed").inputValue(), "2");
  assert.deepEqual((await state()).editorDocuments, [document]);
  await timeline.getByRole("button", { name: "Render MP4", exact: true }).click();
  const download = timeline.getByRole("button", { name: "Download MP4", exact: true });
  await download.waitFor({ timeout: 120000 });
  const decoded = await playDownloadedMp4(page, download);
  assert.equal(decoded.width, document.data.width);
  assert.equal(decoded.height, document.data.height);
  assert.ok(Math.abs(decoded.duration - (savedClip.outPoint - savedClip.inPoint) / savedClip.speed) < 0.12);
  const [r, g, b] = decoded.pixel;
  assert.ok(Math.max(r, b) > 100 && Math.min(r, b) < 32 && g < 32, "the solid-color imported video must play");
  await timeline.getByRole("button", { name: "Add rendered video to canvas", exact: true }).click();
  await timeline.getByRole("button", { name: "Added to canvas", exact: true }).waitFor();
  const [output] = (await state()).assets.filter(a => a.provenance.source === "rendered");
  assert.equal(output.provenance.editorDocumentId, document.id);
  assert.equal(output.fingerprint, decoded.fingerprint);
  await timeline.getByRole("button", { name: "Close editor", exact: true }).click();
  await timeline.waitFor({ state: "hidden" });
  const returned = await conversation();
  assert.equal(returned.conversationId, chat.conversationId);
  assert.deepEqual(returned.draftContent, chat.draftContent);
  assert.deepEqual(returned.messages, []);
  assert.deepEqual((await state()).jobs, []);
  assert.deepEqual(mutations, []);
  assert.deepEqual(errors, []);
  console.log(`PASS local chat editing: ${projectId}, imported asset ${asset.id}, reopened timeline ${document.id}; ${models.length ? "empty catalog simulated" : "empty catalog on server"}`);
} finally {
  await browser.close();
}
