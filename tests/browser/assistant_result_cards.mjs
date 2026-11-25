/** Exercise Agent result cards through the real project, assistant and asset APIs. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launchBrowser } from "./engine.mjs";
import { playDownloadedMp4 } from "./play_downloaded_mp4.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5180";
const setupSession = crypto.randomUUID();
async function api(path, { body, method = body ? "POST" : "GET", session = setupSession } = {}) {
  const response = await fetch(base + "/api" + path, {
    method,
    headers: {
      "X-OpenDirector-Request": "1", "X-OpenDirector-Session": session,
      "Content-Type": "application/json",
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.status === 204 ? null : response.json();
}
async function until(read, matches, label) {
  const deadline = Date.now() + 20000;
  for (;;) {
    const value = await read();
    if (matches(value)) return value;
    assert.ok(Date.now() < deadline, label);
    await new Promise(resolve => setTimeout(resolve, 80));
  }
}

async function verifyPreviewWindow({ page, locale, labels, result, root, visibleItemId, timelineId }) {
  const preview = await page.context().newPage();
  try {
    await preview.goto(page.url());
    const workspace = preview.locator('[data-testid="canvas-workspace"][data-edit-mode="preview"][aria-busy="false"]');
    await workspace.waitFor();
    await preview.getByTestId("workspace-mode-agent").click();
    const card = workspace.locator(`.cw-chat-result[data-asset-id="${result.asset.assetId}"]`);
    const button = name => card.getByRole("button", { name, exact: true });
    await card.waitFor();
    assert.ok(await workspace.locator(".cw-edit-request").isVisible());
    assert.ok(await button(labels.reference).isDisabled());
    assert.ok(await button(locale === "zh-CN" ? "编辑媒体" : "Edit media").isDisabled());

    const writes = [];
    preview.on("request", req => {
      const path = new URL(req.url()).pathname;
      if (req.method() !== "GET" && path.startsWith("/api" + root + "/") &&
          /\/(commands|uploads|assistant)(\/|$)/.test(path)) writes.push(`${req.method()} ${path}`);
    });
    const before = await api(root);
    const chat = await api(root + "/assistant");
    const media = preview.locator("dialog.cw-preview");
    await button(labels.preview).click();
    await media.locator("img").evaluate(element => element.decode());
    await preview.keyboard.press("Escape");
    await media.waitFor({ state: "hidden" });

    await workspace.locator("[data-chat-project-assets]").click();
    const list = workspace.locator('.cw-creation-assets[data-actions="preview"]');
    await list.waitFor();
    assert.equal(await list.locator("[data-project-import], [data-reference-asset], [data-create-timeline], [data-open-timeline]").count(), 0);
    const name = before.assets.find(asset => asset.id === result.asset.assetId).name;
    const search = preview.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname.endsWith("/asset-list") && url.searchParams.get("text") === name;
    });
    await list.getByRole("textbox").fill(name);
    const response = await search;
    assert.ok(response.ok(), await response.text());
    const items = (await response.json()).items;
    const row = list.getByTitle(name, { exact: true });
    if (labels.policy === "candidate_only" && !visibleItemId) {
      // Unadopted generation candidates live in the results inventory until placed.
      assert.ok(!items.some(entry => entry.asset.id === result.asset.assetId));
      assert.equal(await row.count(), 0);
      await preview.keyboard.press("Escape");
      await list.waitFor({ state: "hidden" });
    } else {
      const matches = items.filter(entry => entry.asset.name === name);
      const index = matches.findIndex(entry => entry.asset.id === result.asset.assetId);
      assert.ok(index >= 0);
      await until(() => row.count(), count => count === matches.length, "all matching asset rows must render");
      await row.nth(index).click();
      const hash = await media.locator("img").evaluate(async element => {
        await element.decode();
        const bytes = await (await fetch(element.currentSrc)).arrayBuffer();
        return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          value => value.toString(16).padStart(2, "0")).join("");
      });
      assert.equal("sha256:" + hash, result.asset.fingerprint);
      await preview.keyboard.press("Escape");
      await media.waitFor({ state: "hidden" });
    }

    await workspace.locator("#canvas-assistant").evaluate(panel => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(["preview"], "preview-drop.txt", { type: "text/plain" }));
      panel.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    });
    if (timelineId) {
      const timelineAction = workspace.locator(`.cw-chat-result[data-editor-id="${timelineId}"] button`);
      assert.ok(await timelineAction.isDisabled());
    }
    if (visibleItemId) {
      await button(labels.locate).click();
      await workspace.locator(`.react-flow__node.selected[data-id="${visibleItemId}"]`).waitFor();
    } else {
      assert.ok(await button(labels.locate).isDisabled(), "a preview cannot show a hidden or unplaced result");
      await preview.getByTestId("workspace-mode-canvas").click();
    }
    await until(() => preview.getByTestId("workspace-mode-canvas").getAttribute("aria-pressed"),
      value => value === "true", "the preview must remain navigable");
    assert.equal((await api(root)).eventCursor, before.eventCursor);
    assert.deepEqual((await api(root + "/assistant")).draftContent, chat.draftContent);
    assert.deepEqual(writes, [], "viewing results and dropping a file in preview must not send business writes");
  } finally {
    await preview.close();
  }
}

async function openResultImage(page, card, locale) {
  await card.getByRole("button", { name: locale === "zh-CN" ? "编辑媒体" : "Edit media", exact: true }).click();
  const media = page.locator(".cw-image-editor");
  try {
    await media.waitFor();
  } catch (error) {
    console.error("Result editor did not open", {
      locale, card: await card.innerText(), workspace: await page.locator(".cw-workspace").getAttribute("data-workspace-mode"),
      dialogs: await page.getByRole("dialog").allTextContents(),
      alerts: await page.getByRole("alert").allTextContents(),
    });
    throw error;
  }
  const image = media.locator("canvas").first();
  await until(() => image.evaluate(canvas => {
    const pixel = canvas.getContext("2d").getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data;
    return pixel[0] > 64 && pixel[1] < 32 && pixel[2] > 64;
  }), Boolean, "the existing image editor must decode the pinned purple result");
  return media;
}

async function verifyReadOnlyImage({ page, card, locale, root, conversation }) {
  const original = await conversation();
  const before = await api(root);
  const history = await api(root + "/history");
  const assertReadOnly = async () => {
    const snapshot = await api(root);
    assert.deepEqual(snapshot.canvasItems, before.canvasItems,
      "opening or canceling Edit media must preserve every item, including visibility and revision");
    assert.deepEqual(await api(root + "/history"), history, "opening or canceling must preserve undo history");
    assert.equal(snapshot.project.revision, before.project.revision, "opening or canceling must preserve the project revision");
    assert.equal(snapshot.eventCursor, before.eventCursor, "the editor must open without committing a command");
  };
  const media = await openResultImage(page, card, locale);
  await assertReadOnly();
  await media.locator(".cw-editor-close").click();
  await media.waitFor({ state: "hidden" });
  await assertReadOnly();
  assert.equal(await page.getByTestId("workspace-mode-agent").getAttribute("aria-pressed"), "true");
  const returned = await conversation();
  assert.equal(returned.conversationId, original.conversationId);
  assert.deepEqual(returned.draftContent, original.draftContent);
  assert.deepEqual(returned.messages, original.messages);
}

async function verifyImageSaveAndUndo({ page, card, locale, root, result, itemId, adopted }) {
  const zh = locale === "zh-CN";
  const before = await api(root);
  const history = await api(root + "/history");
  const media = await openResultImage(page, card, locale);
  await media.getByRole("button", { name: zh ? "旋转 90°" : "Rotate 90°", exact: true }).click();
  await media.locator(".cw-editor-apply").click();
  await until(async () => {
    if (!(await media.isVisible())) return true;
    const error = media.getByRole("alert");
    if (await error.isVisible()) assert.fail(await error.innerText());
    return false;
  }, Boolean, "the rotated image must be saved and the modal closed");
  assert.equal(await page.getByTestId("workspace-mode-agent").getAttribute("aria-pressed"), "true");

  const saved = await api(root);
  const crop = saved.editorDocuments.find(doc => doc.kind === "image_crop");
  assert.ok(crop);
  assert.equal(crop.data.options.rotation, 90);
  assert.deepEqual(crop.data.source, result.asset);
  const output = saved.assets.find(asset => asset.provenance.editorDocumentId === crop.id);
  assert.ok(output);
  assert.deepEqual([output.metadata.width, output.metadata.height], [240, 320]);
  assert.equal(output.provenance.source, "edited");
  assert.ok(output.provenance.sources.some(ref => ref.assetId === result.asset.assetId && ref.fingerprint === result.asset.fingerprint));
  assert.equal(output.provenance.editorRevision, crop.revision);
  assert.notEqual(output.fingerprint, result.asset.fingerprint);
  assert.deepEqual(saved.assets.find(asset => asset.id === result.asset.assetId), before.assets.find(asset => asset.id === result.asset.assetId));
  assert.deepEqual(saved.results, before.results);
  assert.deepEqual(saved.generationSpecs, before.generationSpecs);
  const editedItem = saved.canvasItems.find(item => item.editors?.some(editor => editor.id === crop.id));
  assert.ok(editedItem);
  if (adopted) {
    assert.equal(editedItem.id, itemId);
    assert.equal(editedItem.visible, false);
    assert.equal(editedItem.binding.materialOverride.assetId, output.id);
    assert.equal(editedItem.revision, before.canvasItems.find(item => item.id === itemId).revision + 1);
    assert.equal(saved.canvasItems.length, before.canvasItems.length);
  } else {
    assert.equal(editedItem.binding.objectRef.assetId, output.id);
    assert.equal(editedItem.visible, true);
    assert.deepEqual(saved.canvasItems.filter(item => item.id !== editedItem.id), before.canvasItems);
  }
  const afterSave = await api(root + "/history");
  assert.equal(afterSave.length, history.length + 1, "the explicit save must be one reversible edit");
  const [edit] = afterSave;
  assert.equal(edit.state, "applied");
  await page.getByTestId("workspace-mode-canvas").click();
  const showCanvas = page.getByRole("button", { name: zh ? "查看画布" : "Show canvas", exact: true });
  if (await showCanvas.isVisible()) await showCanvas.click();
  await page.getByRole("button", { name: zh ? "撤销" : "Undo", exact: true }).click();
  await until(() => api(root + "/history"), entries => entries.some(entry =>
    entry.commandId === edit.commandId && entry.state === "undone"), "the single save must be undoable");
  const undone = await api(root);
  if (adopted) {
    const original = before.canvasItems.find(item => item.id === itemId);
    const restored = undone.canvasItems.find(item => item.id === itemId);
    assert.equal(restored.revision, editedItem.revision + 1);
    assert.deepEqual({ ...restored, revision: original.revision }, original);
    console.log("Hidden result item revisions", { afterCancel: original.revision, saved: editedItem.revision, undone: restored.revision });
  } else {
    assert.equal(undone.canvasItems.find(item => item.id === editedItem.id).visible, false);
    assert.deepEqual(undone.canvasItems.filter(item => item.id !== editedItem.id), before.canvasItems);
  }
  await page.getByTestId("workspace-mode-agent").click();
  return undone;
}

async function verifyResultEditors({ page, card, result, projectId, command, state, conversation, locale }) {
  const zh = locale === "zh-CN";
  const button = (container, name) => container.getByRole("button", { name, exact: true });
  const original = await conversation();
  const chatMode = page.getByTestId("workspace-mode-agent");
  const media = await openResultImage(page, card, locale);
  await media.locator(".cw-editor-close").click();
  await media.waitFor({ state: "hidden" });
  assert.equal(await chatMode.getAttribute("aria-pressed"), "true");
  assert.equal((await conversation()).conversationId, original.conversationId);

  // Same title and source in two timelines; only their stable identities and edits differ.
  const targets = [0.5, 1].map(duration => ({
    itemId: crypto.randomUUID(), editorId: crypto.randomUUID(), duration,
  }));
  const session = await page.evaluate(() => sessionStorage.getItem("opendirector.session.v1"));
  for (const { itemId, editorId, duration } of targets) {
    const document = { id: editorId, projectId, kind: "timeline", data: {
      fps: 12, width: 128, height: 96,
      tracks: [{ id: "visual", kind: "visual", title: "Cut", clips: [{
        id: "result-shot", inPoint: 0, outPoint: duration,
        resource: { asset: result.asset, title: "Result shot" },
      }] }],
    } };
    const item = { id: itemId, projectId, kind: "timeline", title: "Result cut",
      binding: { role: "editor", objectRef: { id: editorId, kind: "timeline" } } };
    assert.equal((await command("creation.batch", { operations: [
      { type: "editor.create", payload: { document } }, { type: "canvas.show", payload: { item } },
    ] }, [], session)).status, "applied");
  }
  await page.reload();
  const choice = card.getByRole("combobox", { name: zh ? "时间线" : "Timeline", exact: true });
  await choice.waitFor();
  assert.equal(await choice.inputValue(), "", "multiple timelines require an explicit choice");
  assert.ok(await button(card, zh ? "打开时间线" : "Open timeline").isDisabled());
  const options = await choice.locator("option").evaluateAll(items => items.filter(item => item.value)
    .map(item => ({ value: item.value, label: item.textContent })));
  assert.deepEqual(new Set(options.map(option => option.value)), new Set(targets.map(item => item.itemId)));
  assert.equal(new Set(options.map(option => option.label)).size, targets.length, "identically named targets must be distinguishable");
  const target = targets[1];
  await choice.selectOption(target.itemId);
  await button(card, zh ? "打开时间线" : "Open timeline").click();
  const timeline = page.locator(".cw-timeline-dialog");
  const clip = timeline.locator(".cw-timeline-clip");
  await clip.waitFor();
  assert.ok((await clip.textContent()).includes("Result shot"));
  const download = button(timeline, zh ? "下载 MP4" : "Download MP4");
  const publish = button(timeline, zh ? "将合成视频加入画布" : "Add rendered video to canvas");
  await button(timeline, zh ? "合成 MP4" : "Render MP4").click();
  await download.waitFor({ timeout: 90000 });
  assert.ok(!(await state()).assets.some(asset => asset.provenance.source === "rendered"));
  const decoded = await playDownloadedMp4(page, download);
  assert.equal(decoded.width, 128);
  assert.equal(decoded.height, 96);
  assert.ok(Math.abs(decoded.duration - target.duration) < 0.12);
  assert.ok(decoded.pixel[0] > 64 && decoded.pixel[1] < 32 && decoded.pixel[2] > 64);

  let rejected;
  const refuse = async route => {
    const body = route.request().postDataJSON();
    if (body?.type !== "timeline.publishRender" || rejected) return route.continue();
    rejected = body;
    await route.fulfill({ status: 503, json: { detail: "fixture: retry publication" } });
  };
  await page.route("**/commands", refuse);
  try {
    await publish.click();
    await timeline.getByRole("alert").filter({ hasText: "fixture: retry publication" }).waitFor();
    assert.ok(await download.isEnabled());
    assert.ok(!(await state()).assets.some(asset => asset.provenance.source === "rendered"));
    const retry = page.waitForRequest(request => request.url().endsWith("/commands") &&
      request.postDataJSON()?.type === "timeline.publishRender");
    await publish.click();
    assert.deepEqual((await retry).postDataJSON(), rejected);
    await button(timeline, zh ? "已加入画布" : "Added to canvas").waitFor();
  } finally {
    await page.unroute("**/commands", refuse);
  }
  const snapshot = await state();
  const output = snapshot.assets.filter(asset => asset.provenance.source === "rendered");
  assert.equal(output.length, 1);
  assert.equal(output[0].provenance.editorDocumentId, target.editorId);
  assert.equal(output[0].provenance.sourceItemId, target.itemId);
  assert.equal(output[0].fingerprint, decoded.fingerprint);
  await button(timeline, zh ? "关闭编辑器" : "Close editor").click();
  await timeline.waitFor({ state: "hidden" });
  assert.equal(await chatMode.getAttribute("aria-pressed"), "true");
  const returned = await conversation();
  assert.equal(returned.conversationId, original.conversationId);
  assert.deepEqual(returned.messages, original.messages);
}

const health = await api("/creation-test-health");
assert.ok(health.isolated && health.assistantFixture);
const model = (await api("/model-configs")).find(item => item.modelId === "fixture-image");
assert.ok(model);
const locales = {
  "en-US": { policy: "candidate_only", status: "Candidate", send: "Send message", preview: "Preview", reference: "Reference in chat", locate: "View on canvas", download: "Download preview asset" },
  "zh-CN": { policy: "if_current", status: "当前采用", send: "发送消息", preview: "预览", reference: "继续引用", locate: "在画布中查看", download: "下载预览素材" },
};
const browser = await launchBrowser();
try {
  for (const [locale, labels] of Object.entries(locales)) {
    const projectId = crypto.randomUUID(), specId = crypto.randomUUID(), itemId = crypto.randomUUID();
    const root = `/creation/projects/${projectId}`;
    const command = (type, payload, expectedVersions = [], session = setupSession) => api(root + "/commands", {
      body: { commandId: crypto.randomUUID(), projectId, type, payload, expectedVersions }, session,
    });
    await command("project.create", { name: `Result cards ${projectId.slice(0, 8)}` });
    await api(root + "/open", { body: {} });
    assert.equal((await command("creation.batch", { operations: [
      { type: "generationSpec.create", payload: { spec: {
        id: specId, projectId, kind: "image", purpose: "generation", modelConfigId: model.id, prompt: "A purple frame",
      } } },
      { type: "canvas.show", payload: { item: {
        id: itemId, projectId, kind: "image", title: "Result source",
        position: { x: 2100, y: 500 }, binding: { role: "generation", objectRef: { id: specId } },
      } } },
    ] })).status, "applied");
    await api(`/creation/sessions/${setupSession}`, { method: "DELETE" });

    const context = await browser.newContext({ locale, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(language => {
      if (!localStorage.getItem("opendirector.modelSetup.v1"))
        localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
      localStorage.setItem("opendirector.locale.v1", language);
    }, locale);
    await page.goto(`${base}/ai-tool/ai-canvas/${projectId}`);
    const mode = key => page.getByTestId(`workspace-mode-${key}`);
    await mode("agent").click();
    const assistant = page.locator("#canvas-assistant");
    const editor = assistant.getByRole("textbox", { name: locale === "zh-CN" ? "消息内容" : "Message content", exact: true });
    const conversation = () => api(root + "/assistant");
    await until(conversation, c => !!c.modelSelections.agent, "The Agent model must be ready");
    // The provider gate lets the turn finish before its job has produced any asset.
    await api("/creation-test-gate", { body: { open: false } });
    await editor.fill("Result card: " + labels.policy);
    await assistant.getByRole("button", { name: labels.send, exact: true }).click();
    const turn = await until(conversation, c => c.messages.at(-1)?.status === "complete", "The Agent reply must finish");
    const turnId = turn.messages[0].id;
    const running = await api(root);
    assert.equal(running.jobs[0].agentRunId, turnId);
    assert.equal(running.results.length, 0);
    const cards = assistant.locator(".cw-chat-result");
    assert.equal(await cards.count(), 0);
    await api("/creation-test-gate", { body: { open: true } });
    const generated = await until(() => api(root), s => s.results.length === 1, "The image result must commit");
    const [result] = generated.results;
    assert.equal(result.jobId, running.jobs[0].id);
    const card = assistant.locator(`.cw-chat-result[data-asset-id="${result.asset.assetId}"]`);
    await card.waitFor();
    assert.equal(await cards.count(), 1);
    assert.ok((await card.textContent()).includes(labels.status));
    if (process.env.CREATION_SCREENSHOTS) {
      await mkdir(process.env.CREATION_SCREENSHOTS, { recursive: true });
      await card.locator("img").evaluate(image => image.decode());
      await page.screenshot({ path: join(process.env.CREATION_SCREENSHOTS, `chat-result-${locale}.png`) });
    }
    const action = name => card.getByRole("button", { name, exact: true });
    await action(labels.preview).click();
    const preview = page.locator("dialog.cw-preview");
    await preview.locator("img").evaluate(image => image.decode());
    assert.equal(await preview.locator("img").evaluate(image => image.naturalWidth), 320);
    const downloaded = page.waitForEvent("download");
    await preview.getByRole("button", { name: labels.download }).click();
    const bytes = await (await downloaded).createReadStream();
    const hash = createHash("sha256");
    for await (const chunk of bytes) hash.update(chunk);
    assert.equal("sha256:" + hash.digest("hex"), result.asset.fingerprint);
    await page.keyboard.press("Escape");
    await preview.waitFor({ state: "hidden" });
    await editor.fill("Keep my draft");
    await action(labels.reference).click();
    const draft = await until(conversation, c => c.assets.some(a => a.id === result.asset.assetId), "Reference must persist in the draft");
    assert.ok(draft.draft.includes("Keep my draft"));
    assert.equal(draft.assets[0].fingerprint, result.asset.fingerprint);
    const reference = draft.draftContent.find(part => part.type === "reference");
    assert.equal(reference.assetId, result.asset.assetId);
    assert.equal(reference.fingerprint, result.asset.fingerprint);
    assert.equal(reference.binding, "asset");
    assert.deepEqual(draft.messages, turn.messages);
    assert.deepEqual((await api(root)).canvasItems, generated.canvasItems);

    await page.reload();
    await card.waitFor();
    const adopted = labels.policy === "if_current";
    // Locate historical results with their original binding, even after hiding the origin.
    if (adopted) {
      assert.equal(generated.generationSpecs[0].currentResultId, result.id);
      const session = await page.evaluate(() => sessionStorage.getItem("opendirector.session.v1"));
      const version = generated.canvasItems[0].revision;
      assert.equal((await command("canvas.hide", { itemId }, [{ objectType: "canvas_item", id: itemId, revision: version }], session)).status, "applied");
      await page.reload();
      await card.waitFor();
      await page.setViewportSize({ width: 600, height: 850 });
    }
    await verifyPreviewWindow({ page, locale, labels, result, root });
    await verifyReadOnlyImage({ page, card, locale, root, conversation });
    if (!adopted) {
      const configs = "**/api/model-configs";
      await page.route(configs, async route => {
        const response = await route.fetch();
        await route.fulfill({ response, json: (await response.json()).filter(model => model.kind === "agent") });
      });
      await page.evaluate(() => localStorage.setItem("opendirector.modelSetup.v1", "chat-ready"));
      await page.reload();
      await action(labels.locate).click();
      const settings = page.locator("#settings-dialog");
      await settings.waitFor();
      assert.ok(await settings.getByRole("button", { name: "Enter canvas" }).isDisabled());
      await page.keyboard.press("Escape");
      await settings.waitFor({ state: "hidden" });
      assert.equal(await mode("agent").getAttribute("aria-pressed"), "true");
      assert.deepEqual((await api(root)).canvasItems, generated.canvasItems);
      assert.deepEqual((await conversation()).draftContent, draft.draftContent);
      await page.unroute(configs);
      await page.reload();
    }
    const afterUndo = await verifyImageSaveAndUndo({ page, card, locale, root, result, itemId, adopted });
    await action(labels.locate).click();
    const selected = page.locator(".react-flow__node.selected");
    await selected.waitFor();
    const selectedId = await selected.getAttribute("data-id");
    assert.equal(await mode("canvas").getAttribute("aria-pressed"), "true");
    assert.equal(await page.getByTestId("canvas-region").isVisible(), true);
    const located = await api(root);
    const item = located.canvasItems.find(i => i.id === selectedId);
    assert.ok(item?.visible);
    if (adopted) {
      assert.equal(selectedId, itemId);
      const undoneRevision = afterUndo.canvasItems.find(source => source.id === itemId).revision;
      assert.equal(item.revision, undoneRevision + 1);
      assert.equal(located.canvasItems.length, 1);
      console.log("Located result item revision", item.revision);
    } else {
      assert.equal(item.binding.role, "material");
      assert.deepEqual(item.binding.objectRef, result.asset);
      assert.equal(located.canvasItems.length, afterUndo.canvasItems.length + 1);
    }
    assert.deepEqual(located.assets, afterUndo.assets);
    assert.deepEqual(located.generationSpecs, generated.generationSpecs);
    assert.deepEqual(located.results, generated.results);
    // Move the existing item outside the actual viewport before locating it again.
    const pane = page.locator(".react-flow__pane");
    const hitSelected = () => selected.evaluate(node => {
      const box = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    });
    await until(hitSelected, Boolean, "locating a result must reveal an actionable node");
    const point = await pane.evaluate(element => {
      const box = element.getBoundingClientRect();
      for (let y = box.bottom - 90; y > box.top + box.height / 2; y -= 60)
        for (let x = box.left + 90; x < box.right - 40; x += 60)
          if (document.elementFromPoint(x, y) === element) return { x, y, endY: box.top + 90 };
    });
    assert.ok(point, "a blank canvas area is available for panning");
    await page.mouse.move(point.x, point.y);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(point.x, point.endY, { steps: 12 });
    await page.mouse.up({ button: "middle" });
    await until(hitSelected, hit => !hit, "manual pan must move the result offscreen");
    await mode("agent").click();
    if (adopted) {
      const pending = assistant.locator("[data-pending-references]");
      await pending.waitFor();
      await action(labels.preview).click();
      await preview.waitFor();
      await page.keyboard.press("Escape");
      await preview.waitFor({ state: "hidden" });
      assert.equal(await pending.isVisible(), true, "closing a result preview must preserve pending canvas references");
    }
    await action(labels.locate).click();
    await until(() => mode("canvas").getAttribute("aria-pressed"), pressed => pressed === "true",
      "clicking a result with a pending selection must switch to Canvas");
    assert.equal(await selected.getAttribute("data-id"), selectedId);
    await until(hitSelected, Boolean, "View on canvas must bring the existing offscreen item back");
    assert.deepEqual((await api(root)).canvasItems, located.canvasItems);
    await mode("agent").click();
    const submitted = page.waitForRequest(request =>
      request.method() === "POST" && request.url().endsWith("/assistant/turns"));
    await assistant.getByRole("button", { name: labels.send, exact: true }).click();
    const turnRequest = (await submitted).postDataJSON();
    assert.deepEqual(turnRequest.assets, [result.asset.assetId]);
    assert.deepEqual(turnRequest.content.find(part => part.type === "reference"), reference);
    const continued = await until(conversation, c => c.messages.length === 4 && c.messages.at(-1)?.status === "complete",
      "the next turn must complete with the result reference");
    assert.equal(continued.messages[2].assets[0].id, result.asset.assetId);
    assert.equal(await cards.count(), 1, "reusing an asset as input must not make it an output of the new reply");
    await verifyResultEditors({ page, card, result, projectId, command, state: () => api(root), conversation, locale });
    await editor.fill("Result card: timeline");
    await assistant.getByRole("button", { name: labels.send, exact: true }).click();
    const delivered = await until(conversation, c => c.messages.length === 6 && c.messages.at(-1)?.status === "complete",
      "the timeline-only Agent turn must finish");
    const reply = delivered.messages.at(-1);
    assert.equal(reply.publishedTimelines?.projectId, projectId);
    const [target] = reply.publishedTimelines.timelines;
    const project = await api(root);
    assert.ok(project.editorDocuments.some(doc => doc.id === target.editorId && doc.revision === target.revision));
    assert.ok(project.canvasItems.some(item => item.id === target.itemId && item.binding.objectRef.id === target.editorId));
    const timelineCard = assistant.locator('[data-editor-id="' + target.editorId + '"]');
    await page.reload();
    await timelineCard.getByRole("button", { name: locale === "zh-CN" ? "打开时间线" : "Open timeline", exact: true }).click();
    const timeline = page.locator(".cw-timeline-dialog");
    await timeline.getByText("Agent cut track", { exact: true }).waitFor();
    await timeline.getByRole("button", { name: locale === "zh-CN" ? "关闭编辑器" : "Close editor", exact: true }).click();
    await timeline.waitFor({ state: "hidden" });
    await verifyPreviewWindow({ page, locale, labels, result, root, visibleItemId: selectedId, timelineId: target.editorId });
    const returned = await conversation();
    assert.equal(returned.conversationId, delivered.conversationId);
    assert.deepEqual(returned.messages, delivered.messages);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${locale}: read-only open and cancel, rotated image save and undo, canvas identity, chosen timeline, playable MP4, publication retry, and timeline-only reply (${labels.policy})`);
  }
} finally {
  await api("/creation-test-gate", { body: { open: true } });
  await browser.close();
}
