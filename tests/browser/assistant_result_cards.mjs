/** Exercise Agent result cards through the real project, assistant and asset APIs. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launchBrowser } from "./engine.mjs";

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

    const page = await browser.newPage({ locale, viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(language => {
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
      assert.equal(located.canvasItems.length, 1);
    } else {
      assert.equal(item.binding.role, "material");
      assert.deepEqual(item.binding.objectRef, result.asset);
      assert.equal(located.canvasItems.length, 2);
    }
    assert.deepEqual(located.assets, generated.assets);
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
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${locale}: persisted result, preview bytes, draft reference and canvas identity (${labels.policy})`);
  }
} finally {
  await api("/creation-test-gate", { body: { open: true } });
  await browser.close();
}
