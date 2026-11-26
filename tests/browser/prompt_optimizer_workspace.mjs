/** Chat's selected Agent model handles canvas prompt rewrites. Every provider is loopback-only. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const setupSession = crypto.randomUUID();
const headers = { "X-OpenDirector-Request": "1", "X-OpenDirector-Session": setupSession };
async function api(path, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(base + "/api" + path, {
    method, headers: { ...headers, "Content-Type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.status === 204 ? null : response.json();
}

async function until(check, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(label);
}

async function provider(name, inputModalities) {
  const calls = [];
  let hold;
  const modelId = name + "-" + setupSession.slice(0, 8);
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    let text = "";
    for await (const chunk of req) text += chunk;
    const payload = JSON.parse(text);
    calls.push(payload);
    const parts = payload.messages.find(message => message.role === "user").content;
    const draft = typeof parts === "string" ? parts : parts.find(part => part.type === "text" && part.text.includes("Draft:")).text;
    const markers = draft.match(/\[\[OD_REF_\d+\]\]/g) ?? [];
    const gate = hold;
    if (gate) {
      await gate.release.promise;
    }
    if (res.destroyed) return;
    const content = gate ? "A late rewrite that must never reach another draft." : "A steady tracking shot from " + name + ".";
    const delta = { choices: [{ delta: { content: [content, ...markers].join(" ") }, finish_reason: "stop" }] };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end("data: " + JSON.stringify(delta) + "\n\ndata: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    modelId, calls, inputModalities, url: "http://127.0.0.1:" + server.address().port + "/v1",
    holdNext() {
      const gate = { release: Promise.withResolvers() };
      hold = gate;
      return { release() { hold = undefined; gate.release.resolve(); } };
    },
    async close() {
      hold?.release.resolve();
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

const clip = await readFile(new URL("../fixtures/timeline-text/visual-a.mp4", import.meta.url));
const sound = await readFile(new URL("../fixtures/timeline-text/audio-a.wav", import.meta.url));
const original = "Track the harbor at sunrise.";
const otherDraft = "Leave this other shot alone.";
async function project(withMedia) {
  const id = crypto.randomUUID();
  const root = "/creation/projects/" + id;
  const name = "Prompt routing " + id.slice(0, 8);
  const command = async (type, payload) => {
    const receipt = await api(root + "/commands", { type, payload, projectId: id, commandId: crypto.randomUUID() });
    assert.equal(receipt.status, "applied", JSON.stringify(receipt));
  };
  const state = () => api(root);
  await command("project.create", { name });
  await api(root + "/open", {});
  if (withMedia) {
    for (const [label, kind, bytes] of [["harbor.mp4", "video", clip], ["harbor.wav", "audio", sound]]) {
      const handle = crypto.randomUUID();
      const upload = await fetch(base + "/api" + root + "/uploads/" + handle, {
        method: "PUT", headers: { ...headers, "X-Asset-Name": label, "X-Asset-Kind": kind }, body: bytes,
      });
      assert.ok(upload.ok, await upload.text());
      await command("asset.import", { uploadHandle: handle, name: label, expectedKind: kind });
    }
  }
  const nodes = (withMedia ? [original, otherDraft] : [otherDraft]).map(prompt => ({
    prompt, itemId: crypto.randomUUID(), specId: crypto.randomUUID(),
  }));
  const operations = nodes.flatMap(({ prompt, itemId, specId }, index) => [
    { type: "generationSpec.create", payload: { spec: {
      id: specId, projectId: id, kind: "video", purpose: "generation", prompt,
    } } },
    { type: "canvas.show", payload: { item: {
      id: itemId, projectId: id, kind: "video", title: "Shot " + (index + 1),
      position: { x: 60 + index * 380, y: 80 }, binding: { role: "generation", objectRef: { id: specId } },
    } } },
  ]);
  (await state()).assets.forEach((asset, order) => operations.push({
    type: "reference.add", payload: { reference: {
      id: crypto.randomUUID(), projectId: id, targetSpecId: nodes[0].specId, binding: "pinned", order,
      source: { assetId: asset.id, revision: asset.revision, kind: asset.kind, fingerprint: asset.fingerprint },
    } },
  }));
  await command("creation.batch", { operations });
  await api("/creation/sessions/" + setupSession, undefined, "DELETE");
  return { id, name, root, nodes, state };
}

assert.ok((await api("/creation-test-health")).isolated);
const providers = [], configs = [];
let browser;
try {
  for (const [name, modalities] of [["native-media", ["text", "video", "audio"]], ["frames-only", ["text", "image"]]]) {
    const fixture = await provider(name, modalities);
    providers.push(fixture);
    const config = await api("/model-configs", {
      kind: "agent", modelId: fixture.modelId, url: fixture.url, inputModalities: fixture.inputModalities,
      connectionType: "self_hosted", protocol: "openai", authMode: "none", capabilityAutoCheck: false,
    });
    configs.push(config);
  }
  const [native, frames] = providers;
  const [first, second] = configs;
  const source = await project(true), destination = await project(false);
  const [target, bystander] = source.nodes;
  const originalState = await source.state();
  const destinationState = await destination.state();
  browser = await launchBrowser();
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1720, height: 1080 } });
  page.setDefaultTimeout(20000);
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    localStorage.setItem("opendirector.locale.v1", "en-US");
  });
  await page.goto(base + "/ai-tool/ai-canvas/" + source.id);
  const mode = name => page.getByTestId("workspace-mode-" + name);
  const selectModel = async config => {
    await mode("agent").click();
    const picker = page.locator("#canvas-assistant .cw-agent-picker .chat-picker-trigger");
    await picker.click();
    await page.getByRole("menuitemradio", { name: config.modelId, exact: true }).click();
    await until(async () => (await api(source.root + "/assistant")).modelSelections.agent === config.id,
      "Chat must persist the explicit choice " + config.modelId);
    assert.ok((await picker.innerText()).includes(config.modelId));
    await mode("canvas").click();
  };
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
  const selectNode = async node => {
    await page.locator('.react-flow__node[data-id="' + node.itemId + '"] .cw-placeholder-symbol').click();
    await prompt.waitFor();
  };
  const visiblePrompt = () => prompt.evaluate(el => el.textContent.replaceAll("\u200b", ""));
  const savedSpec = async () => (await source.state()).generationSpecs.find(spec => spec.id === target.specId);
  const optimize = page.getByRole("button", { name: "Optimize prompt", exact: true });
  const rewriteUrl = "/api" + source.root + "/items/" + target.itemId + "/optimize-prompt";
  async function optimizeAndUndo(config, audioOmitted) {
    const before = await visiblePrompt();
    const savedBefore = await savedSpec();
    const response = page.waitForResponse(r => r.url().endsWith(rewriteUrl));
    await optimize.click();
    const rewritten = await response;
    assert.equal(rewritten.request().postDataJSON().assistantModel.modelId, config.id);
    assert.ok(rewritten.ok(), await rewritten.text());
    const result = await rewritten.json();
    assert.equal(result.audioOmitted, audioOmitted);
    const rewrittenText = result.prompt.split(" [[OD_REF_")[0];
    assert.ok(rewrittenText.startsWith("A steady tracking shot from "));
    await until(async () => (await visiblePrompt()).includes(rewrittenText) && (await savedSpec()).prompt.includes(rewrittenText),
      "The rewrite must appear in the original editor and persist to its spec");
    await prompt.press("ControlOrMeta+z");
    await until(async () => await visiblePrompt() === before && (await savedSpec()).prompt === savedBefore.prompt,
      "Undo must restore the original prompt in the editor and saved project");
    assert.deepEqual((await savedSpec()).promptContent, savedBefore.promptContent);
  }

  await selectModel(second);
  await selectNode(target);
  // Author the draft in the real editor so both inline references and prose have a saved baseline.
  await prompt.press("ControlOrMeta+End");
  await page.keyboard.insertText(" Hold the frame.");
  await until(async () => (await savedSpec()).prompt.endsWith("Hold the frame."), "the edited draft must persist");
  const authored = await savedSpec();
  assert.equal(authored.promptContent.filter(part => part.type === "reference").length, 2);
  await optimizeAndUndo(second, true);
  assert.equal(native.calls.length, 0, "the more capable first provider cannot replace Chat's chosen model");
  assert.equal(frames.calls.length, 1);
  const framePayload = frames.calls[0];
  assert.equal(framePayload.model, frames.modelId);
  const parts = framePayload.messages.find(message => message.role === "user").content;
  const media = parts.filter(part => part.type !== "text");
  assert.deepEqual(media.map(part => part.type), ["image_url", "image_url", "image_url"]);
  for (const frame of media) {
    assert.match(frame.image_url.url, /^data:image\/jpeg;base64,/);
    const jpg = Buffer.from(frame.image_url.url.split(",")[1], "base64");
    assert.equal(jpg.readUInt16BE(), 0xffd8);
    assert.equal(jpg.readUInt16BE(jpg.length - 2), 0xffd9);
  }
  assert.ok(!JSON.stringify(parts).includes("harbor.wav"));

  await selectModel(first);
  await selectNode(target);
  await optimizeAndUndo(first, false);
  assert.equal(frames.calls.length, 1);
  assert.equal(native.calls.length, 1);
  const nativePayload = native.calls[0];
  assert.equal(nativePayload.model, native.modelId);
  const content = nativePayload.messages.find(message => message.role === "user").content;
  assert.deepEqual(Buffer.from(content.find(part => part.type === "video_url").video_url.url.split(",")[1], "base64"), clip);
  const audio = content.find(part => part.type === "input_audio").input_audio;
  assert.equal(audio.format, "wav");
  assert.deepEqual(Buffer.from(audio.data, "base64"), sound);

  const switchProject = async project => {
    await page.getByRole("button", { name: "Switch project", exact: true }).click();
    await page.getByRole("menuitemradio", { name: project.name, exact: true }).click();
    await page.locator(".cw-project-name").getByText(project.name, { exact: true }).waitFor();
  };
  // Deliver the old provider reply only after the new node/project has its own editor.
  for (const change of ["node", "project"]) {
    await selectNode(target);
    const beforeCalls = native.calls.length;
    const gate = native.holdNext();
    const request = page.waitForRequest(r => r.url().endsWith(rewriteUrl));
    try {
      await optimize.click();
      const sent = await request;
      await until(() => native.calls.length === beforeCalls + 1, "the provider must receive the held request");
      if (change === "project") await switchProject(destination);
      await selectNode(change === "node" ? bystander : destination.nodes[0]);
      assert.equal(await visiblePrompt(), otherDraft);
      gate.release();
      const reply = await sent.response();
      if (reply) await reply.finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await visiblePrompt(), otherDraft);
      assert.deepEqual((await savedSpec()).promptContent, authored.promptContent);
    } finally {
      gate.release();
    }
  }
  // Leaving the destination flushes pending document saves before checking the project snapshot.
  await switchProject(source);
  await selectNode(target);
  assert.ok((await visiblePrompt()).includes("Track the harbor at sunrise."));
  const final = await source.state();
  assert.equal(final.generationSpecs.find(spec => spec.id === bystander.specId).prompt, otherDraft);
  assert.deepEqual(final.references, originalState.references);
  assert.deepEqual(final.jobs, []);
  const targetState = await destination.state();
  assert.deepEqual(targetState.generationSpecs, destinationState.generationSpecs);
  assert.deepEqual(targetState.jobs, []);
  assert.deepEqual((await api(source.root + "/assistant")).messages, []);
  assert.deepEqual(pageErrors, []);
  console.log("PASS Chat provider choice -> Canvas: three JPEG frames vs original MP4/WAV bytes, Ctrl+Z persisted twice, late node/project replies isolated",
    { source: source.id, destination: destination.id, framesModel: frames.modelId, nativeModel: native.modelId });
} finally {
  await browser?.close();
  try {
    for (const config of configs) await api("/model-configs/" + config.id, undefined, "DELETE");
  } finally {
    await Promise.all(providers.map(item => item.close()));
  }
}
