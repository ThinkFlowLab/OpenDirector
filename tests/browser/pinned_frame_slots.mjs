/** A video configuration that uses fixed (pinned) assets as its first and last
 * frame shows them in the frame slots, and slot edits and a mode round trip
 * change the stored reference roles (#121). The assets have no canvas node.
 * Uses the isolated creation_server.py; no remote generation.
 */
import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const seedSession = crypto.randomUUID();
const headers = {
  "X-OpenDirector-Request": "1",
  "X-OpenDirector-Session": seedSession,
  "Content-Type": "application/json",
};
async function call(path, body, method = body ? "POST" : "GET") {
  const response = await fetch(api + path, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.status === 204 ? null : response.json();
}
async function until(read, matches, label) {
  const deadline = Date.now() + 15000;
  while (true) {
    const value = await read();
    if (matches(value)) return value;
    assert.ok(Date.now() < deadline, `${label}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

assert.equal((await call("/api/creation-test-health")).isolated, true);
const minimax =
  (await call("/api/model-configs")).find(
    (model) => model.modelId === "MiniMax-H3",
  ) ??
  (await call("/api/model-configs", {
    kind: "video",
    url: "https://fixture.invalid/v2",
    modelId: "MiniMax-H3",
    apiKey: "fixture",
    protocol: "minimax_video_v2",
    connectionType: "api",
    authMode: "bearer",
  }));
assert.deepEqual(minimax.inputRules.frameRoles, ["first_frame", "last_frame"]);
const projectId = crypto.randomUUID();
async function command(type, payload) {
  const result = await call(`/api/creation/projects/${projectId}/commands`, {
    commandId: crypto.randomUUID(),
    projectId,
    type,
    payload,
  });
  assert.equal(result.status, "applied", JSON.stringify(result));
  return result;
}
await command("project.create", {
  name: `Pinned frame slots ${projectId.slice(0, 8)}`,
});
await call(`/api/creation/projects/${projectId}/open`, null, "POST");
const snapshot = () => call(`/api/creation/projects/${projectId}`);

// Two registered images with no canvas node: only fixed references reach them.
/** A 16×16 solid-colour PNG, so each import is a distinct, decodable image. */
function solidPng([r, g, b]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(16, 0);
  header.writeUInt32BE(16, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(16).fill([r, g, b]).flat())]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array(16).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const pngs = [solidPng([221, 51, 51]), solidPng([51, 102, 204])];
for (const [index, png] of pngs.entries()) {
  const handle = crypto.randomUUID();
  const name = `fixed-${index + 1}.png`;
  const upload = await fetch(
    `${api}/api/creation/projects/${projectId}/uploads/${handle}`,
    {
      method: "PUT",
      headers: {
        ...headers,
        "Content-Type": "application/octet-stream",
        "X-Asset-Name": encodeURIComponent(name),
        "X-Asset-Kind": "image",
      },
      body: png,
    },
  );
  assert.ok(upload.ok, await upload.text());
  await command("asset.import", {
    uploadHandle: handle,
    name,
    expectedKind: "image",
  });
}
const assets = (await snapshot()).assets.filter((a) => a.kind === "image");
assert.equal(assets.length, 2);
const specId = crypto.randomUUID(),
  itemId = crypto.randomUUID();
const refs = assets.map(() => crypto.randomUUID());
await command("canvas.createGeneration", {
  spec: {
    id: specId,
    projectId,
    kind: "video",
    purpose: "generation",
    modelConfigId: minimax.id,
    prompt: "Animate between these frames",
    parameters: { videoMode: "first_frame", resolution: "2K", durationSeconds: 5 },
  },
  item: {
    id: itemId,
    projectId,
    kind: "video",
    position: { x: 400, y: 80 },
    binding: { role: "generation", objectRef: { id: specId } },
  },
  references: assets.map((asset, index) => ({
    id: refs[index],
    projectId,
    targetSpecId: specId,
    binding: "pinned",
    source: {
      assetId: asset.id,
      revision: asset.revision,
      fingerprint: asset.fingerprint,
      kind: "image",
    },
    role: index ? "last_frame" : "first_frame",
    order: index,
  })),
});
// Release the seeding session's edit lease so the page can open the project.
await call(`/api/creation/sessions/${seedSession}`, null, "DELETE");
const roles = async () =>
  Object.fromEntries(
    (await snapshot()).references
      .filter((ref) => ref.active)
      .map((ref) => [ref.id, ref.role]),
  );
const expectRoles = (expected, label) =>
  until(roles, (value) => JSON.stringify(value) === JSON.stringify(expected), label);
const ordered = (first, last) => ({ [refs[0]]: first, [refs[1]]: last });

const browser = await launchBrowser();
const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1600, height: 1100 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.addInitScript(() =>
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
  );
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  await page.getByText("已保存到本机", { exact: true }).waitFor({ state: "attached" });
  const node = page.locator(`.react-flow__node[data-id="${itemId}"]`);
  const open = async () => {
    await node.waitFor();
    await node.click();
  };
  await open();
  const first = page.getByLabel("选择首帧", { exact: true });
  const last = page.getByLabel("选择尾帧", { exact: true });
  const slots = async () => [await first.inputValue(), await last.inputValue()];
  const pinned = (index) => `pinned:${refs[index]}`;

  // 1. Both fixed frames reopen in their slots, with a thumbnail each.
  await until(slots, (v) => v[0] === pinned(0) && v[1] === pinned(1), "fixed frames in slots");
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".cw-frame-slot .cw-frame-thumbnail img")]
        .filter((img) => img.complete && img.naturalWidth > 0).length === 2,
  );
  await page.screenshot({ path: ".opendirector/pinned-frame-slots.png" });
  assert.deepEqual(await roles(), ordered("first_frame", "last_frame"));

  // 2. Swap exchanges the stored roles.
  await page.getByRole("button", { name: "互换首尾帧", exact: true }).click();
  await until(slots, (v) => v[0] === pinned(1) && v[1] === pinned(0), "slots swapped");
  await expectRoles(ordered("last_frame", "first_frame"), "roles swapped");

  // 3. Clearing a slot demotes the reference but keeps it attached.
  await last.selectOption("");
  await expectRoles(ordered("reference", "first_frame"), "last slot cleared");
  // ...and choosing it again restores the role.
  await last.selectOption(pinned(0));
  await expectRoles(ordered("last_frame", "first_frame"), "last slot refilled");

  // 4. Reference mode demotes both. Returning to first-last fills the empty
  // slots with the fixed images in prompt order, as connected images are
  // filled, so no image label is left without its frame role.
  const mode = page.getByLabel("视频创作模式", { exact: true });
  await mode.selectOption("reference");
  await expectRoles(ordered("reference", "reference"), "reference mode");
  await until(
    snapshot,
    (v) => v.generationSpecs.find((s) => s.id === specId)?.parameters.videoMode === "reference",
    "reference mode saved",
  );
  await mode.selectOption("first-last");
  await expectRoles(ordered("first_frame", "last_frame"), "first-last restored");
  await until(slots, (v) => v[0] === pinned(0) && v[1] === pinned(1), "slots after round trip");
  assert.equal(
    (await snapshot()).generationSpecs.find((s) => s.id === specId).parameters.videoMode,
    "first_frame",
  );

  // 5. The assignment survives a reload.
  await page.reload();
  await page.getByText("已保存到本机", { exact: true }).waitFor({ state: "attached" });
  await open();
  await until(slots, (v) => v[0] === pinned(0) && v[1] === pinned(1), "slots after reload");
  assert.deepEqual(await roles(), ordered("first_frame", "last_frame"));
  assert.deepEqual(errors, []);
  console.log("pinned frame slots ok");
} catch (error) {
  await page
    .screenshot({ path: ".opendirector/pinned-frame-slots-failure.png" })
    .catch(() => {});
  throw error;
} finally {
  await browser.close();
}
