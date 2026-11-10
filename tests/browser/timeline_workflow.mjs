import { spawnOwned as spawn, stopOwned, pythonExecutable, sourcePythonPath, executable } from "./host.mjs";
/** Owns isolated API/Vite processes; restarts the API over the SAME project root. */
import assert from "node:assert/strict";
import { creationJourney } from "./creation_journey.mjs";
const full = process.argv.includes("--full-creation");
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);
const root = await mkdtemp(join(tmpdir(), "opendirector-creation-timeline-"));
const evidence = process.env.TIMELINE_TEXT_EVIDENCE ?? await mkdtemp(
  join(tmpdir(), "opendirector-timeline-evidence-"),
);
await mkdir(evidence, { recursive: true });
const apiPort = process.env.TIMELINE_API_PORT ?? "8031",
  webPort = process.env.TIMELINE_WEB_PORT ?? "5191";
const api = `http://127.0.0.1:${apiPort}`,
  base = `http://127.0.0.1:${webPort}`;
const seedSession = crypto.randomUUID();
let server, web, browser;
let logs = "";
function run(command, args, env = {}) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  return child;
}
async function stop(child) {
  await stopOwned(child);
}
async function until(check) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Timed out: " + check.toString());
}
async function startApi() {
  server = run(
    pythonExecutable(),
    ["tests/browser/creation_server.py", "--port", apiPort, "--root", root],
    { PYTHONPATH: sourcePythonPath() },
  );
  await until(
    async () =>
      (
        await fetch(api + "/api/creation-test-health", {
          headers: { "X-OpenDirector-Request": "1" },
        })
      ).ok,
  );
}
async function call(path, body) {
  const r = await fetch(api + path, {
    headers: {
      "X-OpenDirector-Request": "1",
      "Content-Type": "application/json",
      "X-OpenDirector-Session": seedSession,
    },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  assert.ok(r.ok, await r.clone().text());
  return r.json();
}
const command = (pid, type, payload) =>
  call(`/api/creation/projects/${pid}/commands`, {
    commandId: crypto.randomUUID(),
    projectId: pid,
    type,
    payload,
  });
function ffmpeg(args) {
  return execFileSync(executable("ffmpeg"), ["-v", "error", "-y", ...args], {
    maxBuffer: 20 * 1024 * 1024,
  });
}
function probe(path) {
  return JSON.parse(
    execFileSync(executable("ffprobe"), [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      path,
    ]),
  );
}
function pixel(path, time) {
  return [
    ...ffmpeg([
      "-ss",
      String(time),
      "-i",
      path,
      "-frames:v",
      "1",
      "-vf",
      "scale=1:1",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ]),
  ];
}
try {
  await startApi();
  web = run(
    "node",
    [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      webPort,
      "--strictPort",
    ],
    { OPENDIRECTOR_API_URL: api },
  );
  await until(async () => (await fetch(base)).ok);
  let pid = crypto.randomUUID(),
    itemId = crypto.randomUUID(),
    editorId = crypto.randomUUID();
  assert.equal(
    (
      await command(pid, "project.create", {
        name: "Timeline " + pid.slice(0, 8),
      })
    ).status,
    "applied",
  );
  await call(`/api/creation/projects/${pid}/open`, {});
  assert.equal(
    (
      await command(pid, "creation.batch", {
        operations: [
          {
            type: "editor.create",
            payload: {
              document: {
                id: editorId,
                projectId: pid,
                kind: "timeline",
                data: {
                  fps: 20,
                  width: 128,
                  height: 96,
                  tracks: [
                    {
                      id: "visual",
                      kind: "visual",
                      title: "Visual",
                      clips: [],
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
                id: itemId,
                projectId: pid,
                kind: "timeline",
                title: "Timeline acceptance",
                position: { x: 150, y: 150 },
                binding: {
                  role: "editor",
                  objectRef: { id: editorId, kind: "timeline" },
                },
              },
            },
          },
        ],
      })
    ).status,
    "applied",
  );
  const released = await fetch(api + `/api/creation/sessions/${seedSession}`, {
    method: "DELETE",
    headers: { "X-OpenDirector-Request": "1" },
  });
  assert.ok(released.ok, await released.text());
  const media = [];
  for (const color of ["red", "blue"]) {
    const path = join(evidence, color + ".mp4");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      `color=${color}:s=128x96:r=20`,
      "-t",
      "2",
      "-threads",
      "1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      path,
    ]);
    media.push({
      id: color,
      kind: "video",
      title: color,
      src: "data:video/mp4;base64," + (await readFile(path)).toString("base64"),
      mimeType: "video/mp4",
      durationSeconds: 2,
      width: 128,
      height: 96,
    });
  }
  const audioPath = join(evidence, "tone.wav");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-t",
    "2",
    "-threads",
    "1",
    audioPath,
  ]);
  const audio = {
    id: "tone",
    kind: "audio",
    title: "tone",
    src:
      "data:audio/wav;base64," + (await readFile(audioPath)).toString("base64"),
    mimeType: "audio/wav",
    durationSeconds: 2,
  };
  const timeline = {
    fps: 20,
    width: 128,
    height: 96,
    importedAssets: [],
    tracks: [
      {
        id: "visual",
        kind: "visual",
        title: "Visual",
        muted: false,
        clips: [
          {
            id: "red-clip",
            resource: media[0],
            inPoint: 0.5,
            outPoint: 1.5,
            speed: 2,
            volume: 1,
            muted: false,
          },
          {
            id: "blue-clip",
            resource: media[1],
            inPoint: 0,
            outPoint: 1,
            speed: 1,
            volume: 1,
            muted: false,
          },
        ],
      },
      {
        id: "audio",
        kind: "audio",
        title: "Audio",
        muted: false,
        clips: [
          {
            id: "tone-clip",
            resource: audio,
            inPoint: 0.2,
            outPoint: 1.7,
            start: 0,
            speed: 1,
            volume: 0.3,
            muted: false,
          },
        ],
      },
    ],
  };
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {}),
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ locale: "en-US",
    viewport: { width: 1700, height: 1100 },
  });
  await page.addInitScript(() => {
    try { localStorage.setItem("opendirector.modelSetup.v1", "dismissed"); } catch {}
  });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let url = base + `/ai-tool/ai-canvas/${pid}`;
  const saved = () => page.getByText("Saved on this device", { exact: true }).waitFor();
  async function releaseEditSession() {
    // Drain queued renewals and prevent any renewal after release.
    await page.evaluate(async () => {
      await (await import("/src/backend/projects.ts")).releaseBackendProject();
    });
  }

  const state = () => call(`/api/creation/projects/${pid}`);
  const doc = (s) => s.editorDocuments.find((d) => d.id === editorId);
  async function open() {
    await page
      .locator(`.react-flow__node[data-id="${itemId}"] .cw-node-title`)
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Open editor", exact: true })
      .click();
    await page.getByRole("button", { name: "Render MP4", exact: true }).waitFor();
  }
  await page.goto(full ? base + "/" : url);
  await saved();
  if (full) {
    await page.getByRole("button", { name: "Switch project", exact: true }).click();
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/commands") &&
        r.request().postDataJSON()?.type === "project.create"),
      page.getByRole("menuitem", { name: "New canvas project", exact: true }).click(),
    ]);
    assert.equal((await response.json()).status, "applied");
    pid = response.request().postDataJSON().projectId;
    url = base + `/ai-tool/ai-canvas/${pid}`;
    const projectName = page.getByRole("textbox", { name: "Project name", exact: true });
    const name = "Full creation " + crypto.randomUUID().slice(0, 8);
    await projectName.fill(name);
    await projectName.press("Enter");
    await page.getByRole("button", { name, exact: true }).waitFor();
    await saved();
    await page
      .getByRole("toolbar", { name: "Canvas creation tools" })
      .getByRole("button", { name: "Add Timeline", exact: true })
      .click();
    const timelineItem = await until(async () =>
      (await state()).canvasItems.find((i) => i.kind === "timeline"),
    );
    itemId = timelineItem.id;
    editorId = timelineItem.binding.objectRef.id;
    await saved();
  }
  const journey = full
    ? await creationJourney(page, { pid, state, call, until, saved })
    : null;
  if (journey)
    timeline.tracks[0].clips.push({
      id: "generated-clip",
      resource: journey.resource,
      inPoint: 0,
      outPoint: 0.5,
      speed: 1,
      volume: 1,
      muted: false,
    });
  await page.locator(".cw-workspace").focus();
  await page.keyboard.press("Shift+1");
  await page.waitForTimeout(300);
  await open();
  await page.getByLabel("Import timeline JSON", { exact: true }).setInputFiles({
    name: "edit.timeline.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        format: "opendirector-editable-timeline",
        version: 1,
        timeUnit: "seconds",
        timeline,
      }),
    ),
  });
  await page.locator(".cw-timeline-clip").first().waitFor();
  // Exercise a genuine HTTP refusal, retaining the draft instead of closing.
  let reject = true;
  await page.route("**/commands", async (route) => {
    const body = route.request().postDataJSON();
    if (
      reject &&
      body.payload?.operations?.some((op) => op.type === "editor.save")
    )
      return route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ detail: "fixture: editor save refused" }),
      });
    return route.continue();
  });
  await page.getByRole("button", { name: "Apply edits", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "fixture: editor save refused" })
    .waitFor();
  assert.equal(await page.locator(".cw-timeline-clip").count(), full ? 4 : 3);
  assert.equal(doc(await state()).data.tracks[0].clips.length, 0);
  reject = false;
  await page.getByRole("button", { name: "Apply edits", exact: true }).click();
  await page.locator(".cw-timeline-dialog").waitFor({ state: "hidden" });
  await saved();
  const first = doc(await state());
  assert.equal(first.data.tracks[0].clips[0].speed, 2);
  assert.equal(first.data.tracks[1].clips[0].volume, 0.3);
  assert.ok(!JSON.stringify(first).includes("data:"));
  console.log(
    "PASS timeline save refusal retains draft; retry persists stable tracks, clips and asset references",
  );
  await releaseEditSession();
  await page.reload();
  await saved();
  await open();
  const reopened = doc(await state());
  assert.deepEqual(reopened, first);
  async function renderAndDownload(name) {
    await page.getByRole("button", { name: "Render MP4", exact: true }).click();
    await page
      .getByRole("button", { name: "Download MP4", exact: true })
      .waitFor({ timeout: 60000 });
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download MP4", exact: true }).click();
    const path = join(evidence, name);
    await (await download).saveAs(path);
    return path;
  }
  const one = await renderAndDownload("first.mp4");
  const info = probe(one);
  assert.ok(Math.abs(Number(info.format.duration) - (full ? 2 : 1.5)) < 0.12);
  assert.ok(info.streams.some((s) => s.codec_type === "audio"));
  assert.equal(info.streams.find((s) => s.codec_type === "video").width, 128);
  const red = pixel(one, 0.2),
    blue = pixel(one, 0.9);
  assert.ok(red[0] > red[2] * 2);
  assert.ok(blue[2] > blue[0] * 2);
  if (full) {
    const purple = pixel(one, 1.8);
    assert.ok(
      purple[0] > purple[1] * 1.5 && purple[2] > purple[1] * 1.5,
      "edited generated image appears in exported frames",
    );
  }
  const samples = ffmpeg([
    "-i",
    one,
    "-vn",
    "-f",
    "f32le",
    "-ac",
    "1",
    "-ar",
    "48000",
    "pipe:1",
  ]);
  let energy = 0;
  for (let i = 0; i < samples.length; i += 4)
    energy += samples.readFloatLE(i) ** 2;
  const rms = Math.sqrt(energy / (samples.length / 4));
  assert.ok(rms > 0.015 && rms < 0.04, rms);
  await page
    .getByRole("button", { name: "Add rendered video to canvas", exact: true })
    .click();
  await page.getByRole("button", { name: "Added to canvas", exact: true }).waitFor();
  const published = await state(),
    output = published.assets.find((a) => a.provenance.source === "rendered");
  assert.ok(output);
  assert.equal(output.provenance.editorDocumentId, editorId);
  assert.equal(output.provenance.editorRevision, first.revision);
  assert.equal(output.provenance.sources.length, full ? 4 : 3);
  console.log(
    `PASS real MP4 dimensions, ${full ? 2 : 1.5}s duration, visual order, mixed audio level, and acknowledged publication`,
  );
  // Shut down the actual API process and reopen the same root, not just a page refresh.
  await page.getByRole("button", { name: "Close editor" }).click();
  // Confirm the edit lease is released before stopping the API.
  await releaseEditSession();
  await page.goto("about:blank");
  await stop(server);
  await startApi();
  await page.goto(url);
  await saved();
  if (journey) {
    const reopened = await state();
    assert.deepEqual(reopened.jobs, journey.snapshot.jobs);
    assert.deepEqual(reopened.results, journey.snapshot.results);
    assert.deepEqual(reopened.references, journey.snapshot.references);
    assert.deepEqual(
      reopened.editorDocuments.find((d) => d.kind === "layers"),
      journey.snapshot.editorDocuments.find((d) => d.kind === "layers"),
    );
    assert.equal(
      (await call("/api/creation-test-health")).calls.length,
      0,
      "restart cannot resubmit generation",
    );
  }
  await open();
  assert.deepEqual(doc(await state()), first);
  await page.locator(".cw-timeline-clip.visual").first().click();
  await page.getByLabel(/Playback speed/).selectOption("1");
  await page.getByRole("button", { name: "Move clip forward", exact: true }).click();
  let releaseSave;
  const heldSave = new Promise((resolve) => (releaseSave = resolve));
  let saveStarted = false;
  const hold = async (route) => {
    const body = route.request().postDataJSON();
    if (body.payload?.operations?.some((op) => op.type === "editor.save")) {
      saveStarted = true;
      await heldSave;
    }
    await route.continue();
  };
  await page.route("**/commands", hold);
  await page.getByRole("button", { name: "Render MP4", exact: true }).click();
  await until(() => saveStarted);
  await page.getByRole("button", { name: "Cancel rendering", exact: true }).click();
  releaseSave();
  await page
    .getByRole("button", { name: "Cancel rendering", exact: true })
    .waitFor({ state: "hidden" });
  await page.unroute("**/commands", hold);
  assert.equal(
    await page.getByRole("button", { name: "Download MP4", exact: true }).count(),
    0,
  );
  const two = await renderAndDownload("second.mp4");
  const updated = doc(await state());
  assert.deepEqual(
    updated.data.tracks[0].clips.map((c) => c.id),
    full
      ? ["blue-clip", "red-clip", "generated-clip"]
      : ["blue-clip", "red-clip"],
  );
  assert.equal(updated.data.tracks[0].clips[1].speed, 1);
  assert.deepEqual(
    new Set(
      updated.data.tracks.flatMap((t) =>
        t.clips.map((c) => c.resource.asset.assetId),
      ),
    ),
    new Set(
      first.data.tracks.flatMap((t) =>
        t.clips.map((c) => c.resource.asset.assetId),
      ),
    ),
  );
  assert.ok(
    Math.abs(Number(probe(two).format.duration) - (full ? 2.5 : 2)) < 0.12,
  );
  assert.ok(pixel(two, 0.2)[2] > pixel(two, 0.2)[0] * 2);
  assert.ok(pixel(two, 1.5)[0] > pixel(two, 1.5)[2] * 2);
  assert.equal(
    (await state()).assets.find((a) => a.id === output.id).provenance
      .editorRevision,
    first.revision,
  );
  // An unavailable source must refuse rendering while retaining the timeline.
  const sourceState = await state();
  const sourceAsset = sourceState.assets.find(
    (a) => a.id === updated.data.tracks[0].clips[0].resource.asset.assetId,
  );
  const sourcePath = join(
    root,
    "projects",
    sourceState.project.name,
    sourceAsset.path,
  );
  await rename(sourcePath, sourcePath + ".held");
  try {
    await page.getByRole("button", { name: "Render MP4", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert.equal(await page.locator(".cw-timeline-clip").count(), full ? 4 : 3);
    assert.equal(
      await page.getByRole("button", { name: "Download MP4", exact: true }).count(),
      0,
    );
  } finally {
    await rename(sourcePath + ".held", sourcePath);
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS cancelled render produces no result; missing source refuses rendering and preserves the editor",
  );
  console.log(
    "PASS actual service restart, stable source identities, UI speed/order edits and second playable export",
  );
  console.log(
    JSON.stringify({
      passed: true,
      projectId: pid,
      root,
      evidence,
      fullCreation: full,
    }),
  );
} catch (error) {
  await writeFile(join(evidence, "services.log"), logs);
  console.error("Evidence:", evidence);
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) console.error("Browser state:", page.url(), await page.locator("body").innerText().catch(() => "unavailable"));
  }
  console.error("Service logs:", logs.slice(-24000));
  throw error;
} finally {
  await browser?.close();
  await stop(web);
  await stop(server);
}
