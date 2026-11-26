/** RFC #386 mode-switch budgets. Run with CREATION_WEB_URL pointing to
 * a production preview and an isolated creation API. No model calls.
 */
import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const headers = { "X-OpenDirector-Request": "1", "Content-Type": "application/json" };
const viewport = { width: 1700, height: 1100 };
const sampleCount = Number(process.env.WORKSPACE_MODE_SAMPLES ?? 10);
assert.ok(Number.isInteger(sampleCount) && sampleCount > 0);

async function api(path, options) {
  const response = await fetch(base + "/api" + path, { headers, ...options });
  assert.ok(response.ok, await response.clone().text());
  return response;
}

async function createProject() {
  const projectId = crypto.randomUUID();
  await api(`/creation/projects/${projectId}/commands`, {
    method: "POST",
    body: JSON.stringify({ projectId, commandId: crypto.randomUUID(),
      type: "project.create", payload: { name: "Mode budget " + projectId } }),
  });
  return projectId;
}

async function openPage(browser, id, start) {
  const page = await browser.newPage({ viewport, locale: "en-US" });
  await page.addInitScript(mode => {
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    localStorage.setItem("opendirector.workspaceMode.v1", mode);
  }, start);
  await page.goto(`${base}/ai-tool/ai-canvas/${id}`);
  await page.locator(`.cw-workspace[data-workspace-mode="${start}"][aria-busy="false"]`).waitFor();
  return page;
}

async function closePage(page) {
  // Each sample uses an empty browser cache. Release only this sample's lease.
  const session = await page.evaluate(() => sessionStorage.getItem("opendirector.session.v1"));
  assert.ok(session);
  await page.close();
  await api("/creation/sessions/" + session, { method: "DELETE" });
}

async function populateImages(browser, id) {
  const page = await browser.newPage({ locale: "en-US" });
  const session = crypto.randomUUID();
  const root = `/creation/projects/${id}`;
  const setupHeaders = { ...headers, "X-OpenDirector-Session": session };
  async function command(type, payload) {
    const response = await api(root + "/commands", { method: "POST", headers: setupHeaders,
      body: JSON.stringify({ projectId: id, commandId: crypto.randomUUID(), type, payload }) });
    const receipt = await response.json();
    assert.equal(receipt.status, "applied", JSON.stringify(receipt));
  }
  try {
    await api(root + "/open", { method: "POST", headers: setupHeaders, body: "{}" });
    const files = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 512;
      const ctx = canvas.getContext("2d");
      const pixels = ctx.createImageData(512, 512);
      let seed = 77;
      return Array.from({ length: 12 }, () => {
        for (let i = 0; i < pixels.data.length; i += 4) {
          seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
          pixels.data.set([seed & 255, (seed >>> 8) & 255, (seed >>> 16) & 255, 255], i);
        }
        ctx.putImageData(pixels, 0, 0);
        return canvas.toDataURL("image/png").split(",")[1];
      });
    });
    let bytes = 0;
    for (const [index, encoded] of files.entries()) {
      const handle = crypto.randomUUID(), name = `frame-${index}.png`;
      const body = Buffer.from(encoded, "base64");
      bytes += body.length;
      await api(root + "/uploads/" + handle, { method: "PUT", body, headers: {
        ...setupHeaders, "Content-Type": "image/png", "X-Asset-Kind": "image", "X-Asset-Name": name,
      } });
      await command("asset.import", { uploadHandle: handle, name, expectedKind: "image" });
    }
    const { assets } = await (await api(root)).json();
    assert.equal(new Set(assets.map(asset => asset.fingerprint)).size, files.length);
    await command("creation.batch", { operations: assets.map((asset, i) => ({
      type: "canvas.show", payload: { item: {
        id: crypto.randomUUID(), projectId: id, kind: "image", title: asset.name,
        width: 180, height: 180, position: { x: 80 + (i % 4) * 220, y: 100 + Math.floor(i / 4) * 230 },
        binding: { role: "material", objectRef: { assetId: asset.id, revision: asset.revision,
          fingerprint: asset.fingerprint, kind: asset.kind } },
      } },
    })) });
    const { canvasItems } = await (await api(root)).json();
    assert.deepEqual(new Set(canvasItems.map(item => item.binding.objectRef.assetId)),
      new Set(assets.map(asset => asset.id)));
    return { images: files.length, bytes };
  } finally {
    await page.close();
    await api("/creation/sessions/" + session, { method: "DELETE" });
  }
}

async function sample(page, destination, imageCount) {
  const button = page.getByTestId(`workspace-mode-${destination}`);
  await button.evaluate((button, { destination, imageCount }) => {
    // Start at the trusted click timestamp, including any dispatch delay. Stop
    // one frame after each observed DOM state to give it a rendering opportunity.
    window.modeTiming = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`No usable ${destination} layout`)), 10_000);
      function hit(element) {
        if (!element || element.closest("[inert]") || element.matches(":disabled")) return false;
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      }
      button.addEventListener("click", event => {
        if (!event.isTrusted) throw new Error("Expected a browser pointer click");
        let feedback, ready, feedbackSeen = false, readySeen = false;
        function frame() {
          const elapsed = performance.now() - event.timeStamp;
          if (feedbackSeen) feedback ??= elapsed;
          if (readySeen) ready ??= elapsed;
          if (ready !== undefined) {
            clearTimeout(timeout);
            resolve({ feedback, ready });
            return;
          }
          feedbackSeen = button.getAttribute("aria-pressed") === "true" && hit(button);
          if (feedbackSeen && document.querySelector(`.cw-workspace[aria-busy="false"][data-workspace-mode="${destination}"]`)) {
            if (destination === "agent") {
              readySeen = hit(document.querySelector('#canvas-assistant [contenteditable="true"]'));
            } else {
              const images = [...document.querySelectorAll(".cw-node-media .cw-image-preview")];
              readySeen = hit(document.querySelector(".cw-rail-add")) && images.length === imageCount
                && images.every(image => image.complete && image.naturalWidth > 0);
            }
          }
          requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
      }, { capture: true, once: true });
    });
  }, { destination, imageCount });
  await button.click();
  return page.evaluate(() => window.modeTiming);
}

const health = await (await api("/creation-test-health")).json();
assert.equal(health.isolated, true);
const browser = await launchBrowser();
try {
  const report = { browser: browser.version(), viewport, fixtures: [], cases: [] };
  for (const fixture of ["empty", "images"]) {
    const id = await createProject();
    const media = fixture === "images" ? await populateImages(browser, id) : { images: 0, bytes: 0 };
    report.fixtures.push({ fixture, project: id, ...media });
    for (const from of ["canvas", "agent"]) {
      const to = from === "agent" ? "canvas" : "agent";
      const rows = { first: [], warm: [] };
      for (let n = 0; n < sampleCount; n++) {
        const page = await openPage(browser, id, from);
        try {
          await page.locator('#canvas-assistant [contenteditable="true"]').waitFor();
          if (from === "canvas" && media.images) {
            await page.waitForFunction(count => {
              const images = [...document.querySelectorAll(".cw-node-media .cw-image-preview")];
              return images.length === count && images.every(image => image.complete && image.naturalWidth > 0);
            }, media.images);
          }
          rows.first.push(await sample(page, to, media.images));
          await sample(page, from, media.images);
          rows.warm.push(await sample(page, to, media.images));
        } finally {
          await closePage(page);
        }
      }
      for (const [phase, samples] of Object.entries(rows)) {
        const ordered = metric => samples.map(row => row[metric]).sort((a, b) => a - b);
        const p90 = values => values[Math.ceil(values.length * 0.9) - 1];
        const ready = ordered("ready");
        const middle = Math.floor(ready.length / 2);
        const median = ready.length % 2 ? ready[middle] : (ready[middle - 1] + ready[middle]) / 2;
        const feedbackP90 = p90(ordered("feedback")), readyP90 = p90(ready);
        report.cases.push({ fixture, from, to, phase, feedbackP90, readyMedian: median, readyP90,
          withinBudget: feedbackP90 <= 100 && median <= 500 && readyP90 <= 1000, samples });
      }
    }
  }
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
