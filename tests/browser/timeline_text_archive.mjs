import { spawnOwned as spawn, stopOwned, pythonExecutable, sourcePythonPath, executable } from "./host.mjs";
/** Real isolated UI / editor.save / Agent / reopen acceptance for timed text. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser } from "./engine.mjs";
const root = await mkdtemp(join(tmpdir(), "opendirector-creation-text-edit-"));
const evidence = process.env.TIMELINE_TEXT_EVIDENCE ?? join(process.cwd(), "test-results/issue87/archive");
await mkdir(evidence, { recursive: true });
const report = { date: new Date().toISOString(), root };
const apiPort = process.env.TEXT_ARCHIVE_API_PORT ?? "8048",
  webPort = process.env.TEXT_ARCHIVE_WEB_PORT ?? "5198";
const api = `http://127.0.0.1:${apiPort}`,
  base = `http://127.0.0.1:${webPort}`;
let server,
  web,
  browser,
  logs = "";
function run(command, args, env = {}) {
  const p = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", (d) => (logs += d));
  p.stderr.on("data", (d) => (logs += d));
  return p;
}
async function until(check) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(logs.slice(-1500));
}
async function stop(p) {
  await stopOwned(p);
}
function start() {
  return run(
    pythonExecutable(),
    ["tests/browser/creation_server.py", "--port", apiPort, "--root", root],
    { PYTHONPATH: sourcePythonPath() },
  );
}
try {
  server = start();
  await until(
    async () =>
      (
        await fetch(api + "/api/creation-test-health", {
          headers: { "X-OpenDirector-Request": "1" },
        })
      ).ok,
  );
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
  browser = await launchBrowser();
  const page = await browser.newPage({
    viewport: { width: 1700, height: 1100 },
  });
  page.setDefaultTimeout(30000);
  globalThis.debugPage = page;
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    localStorage.setItem("opendirector.locale.v1", "en-US");
  });
  const bootstrap = (u) =>
    u.origin === new URL(base).origin && u.pathname === "/";
  await page.route(bootstrap, (r) =>
    r.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }),
  );
  await page.goto(base + "/");
  let f = await page.evaluate(async () => {
    const { createDocument, createNode } = await import("/src/canvas/model.ts");
    const { importWorkspaceDocument } =
      await import("/src/backend/workspace.ts");
    const n = createNode(
      "timeline",
      { x: 100, y: 100 },
      { title: "Text acceptance" },
    );
    n.data.timeline.tracks[0].title = "";
    n.data.timeline.width = 640;
    n.data.timeline.height = 360;
    n.data.timeline.fps = 24;
    const source = createNode(
      "text",
      { x: 700, y: 100 },
      { title: "Plain text source", text: "来源正文 Source" },
    );
    const saved = await importWorkspaceDocument({
      ...createDocument("Text UI " + crypto.randomUUID().slice(0, 8)),
      nodes: [n, source],
    });
    (await import("/src/backend/creationClient.ts"))
      .creationClient(saved.id)
      .close();
    await (await import("/src/backend/projects.ts")).releaseBackendProject();
    return { id: saved.id, item: n.id };
  });
  await page.unroute(bootstrap);
  const projectUrl = () => base + `/ai-tool/ai-canvas/${f.id}`;
  const state = async () =>
    await (
      await page.request.get(base + `/api/creation/projects/${f.id}`, {
        headers: { "X-OpenDirector-Request": "1" },
      })
    ).json();
  async function open() {
    await page.locator(".cw-workspace").focus();
    await page.keyboard.press("Shift+1");
    await page.waitForTimeout(250);
    await page
      .locator(`.react-flow__node[data-id="${f.item}"] .cw-node-title`)
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: /Open editor|打开编辑器/, exact: true })
      .click();
    await page.locator(".cw-timeline-dialog").waitFor();
  }
  await page.goto(projectUrl());
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await open();
  await page
    .locator(".cw-timeline-text-actions select")
    .selectOption({ label: "Plain text source" });
  await page
    .getByRole("button", { name: "Create from text resource", exact: true })
    .click();
  const content = page.getByLabel("Text content", { exact: true });
  await content.fill("Editable bundle 可编辑");
  await content.blur();
  assert.equal(
    await page.locator(".cw-timeline-monitor-empty").count(),
    0,
    "renderable text-only preview has no placeholder",
  );
  assert.equal(
    await page
      .locator(".cw-timeline-screen")
      .evaluate((element) => getComputedStyle(element).backgroundColor),
    "rgb(0, 0, 0)",
  );
  console.log("STAGE UI source created");
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export editable package", exact: true })
    .click();
  const archive = join(root, "ui.timeline.zip");
  await (await downloaded).saveAs(archive);
  let snapshot = await state();
  assert.equal(
    snapshot.editorDocuments[0].data.overlays[0].text,
    "Editable bundle 可编辑",
  );
  const editorId = snapshot.editorDocuments[0].id;
  const original = snapshot.editorDocuments[0];
  assert(
    original.data.overlays[0].sourceAsset.assetId,
    "text retains immutable source",
  );
  assert(
    original.data.fonts[0].asset.assetId,
    "font is an actual project asset",
  );
  const uiArchive = archive;
  await content.fill("Unsaved draft remains");
  await content.blur();
  await page
    .getByRole("button", { name: "Import as new timeline", exact: true })
    .click();
  await page
    .getByLabel("Import editable timeline package", { exact: true })
    .setInputFiles(archive);
  await page
    .getByText("Imported as a new timeline. Your current draft is unchanged.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await content.inputValue(), "Unsaved draft remains");
  snapshot = await state();
  assert.equal(snapshot.editorDocuments.length, 2);
  assert.equal(
    snapshot.editorDocuments.find((d) => d.id === editorId).data.overlays[0]
      .text,
    "Editable bundle 可编辑",
  );
  await page
    .getByRole("button", {
      name: "Replace current timeline from package",
      exact: true,
    })
    .click();
  await page
    .getByLabel("Import editable timeline package", { exact: true })
    .setInputFiles(archive);
  await page
    .getByText("Current timeline replaced with the imported package.", {
      exact: true,
    })
    .waitFor();
  await page.locator(".cw-timeline-text-move").first().click();
  assert.equal(await content.inputValue(), "Editable bundle 可编辑");
  await content.fill("Continued editing");
  await content.blur();
  await page.getByRole("button", { name: "Apply edits", exact: true }).click();
  await page.locator(".cw-timeline-dialog").waitFor({ state: "hidden" });
  snapshot = await state();
  assert.equal(
    snapshot.editorDocuments.find((d) => d.id === editorId).data.overlays[0]
      .text,
    "Continued editing",
  );
  console.log("STAGE original archive UI cases passed");
  // Actual UI A -> native CLI B -> native CLI export -> UI C.
  const cliEnv = {
    ...process.env,
    PYTHONPATH: sourcePythonPath(),
  };
  for (const key of Object.keys(cliEnv))
    if (key.startsWith("OPENDIRECTOR_AGENT_")) delete cliEnv[key];
  function cli(project, args) {
    const output = execFileSync(
      pythonExecutable(),
      ["-m", "opendirector.cli", "--url", api, "--project", project, ...args],
      { env: cliEnv, encoding: "utf8", timeout: 120000 },
    );
    return JSON.parse(output);
  }
  const b = randomUUID();
  cli(b, ["project", "create", "--name", "CLI package destination"]);
  const receipt = cli(b, [
    "timeline",
    "import",
    uiArchive,
    "--operation-id",
    randomUUID(),
  ]);
  assert.equal(receipt.status, "applied");
  const bs = cli(b, ["project", "show"]);
  const bd = bs.editorDocuments.find((d) => d.id === receipt.editorId);
  assert.equal(bd.data.overlays[0].text, "Editable bundle 可编辑");
  assert.deepEqual(bd.data.overlays[0].style, original.data.overlays[0].style);
  assert.notEqual(
    bd.data.fonts[0].asset.assetId,
    original.data.fonts[0].asset.assetId,
  );
  assert.equal(
    bd.data.fonts[0].asset.fingerprint,
    original.data.fonts[0].asset.fingerprint,
  );
  assert.equal(
    bd.data.overlays[0].sourceAsset.fingerprint,
    original.data.overlays[0].sourceAsset.fingerprint,
  );
  console.log("STAGE CLI import B passed");
  const cliArchive = join(root, "cli.timeline.zip");
  cli(b, [
    "timeline",
    "export",
    "--editor-id",
    bd.id,
    "--revision",
    String(bd.revision),
    "--output",
    cliArchive,
  ]);
  await page.evaluate(async () => {
    await (await import("/src/backend/projects.ts")).releaseBackendProject();
  });
  await page.route(bootstrap, (r) =>
    r.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }),
  );
  await page.goto(base + "/");
  f = await page.evaluate(async () => {
    const { createDocument, createNode } = await import("/src/canvas/model.ts");
    const node = createNode(
      "timeline",
      { x: 100, y: 100 },
      { title: "UI package destination" },
    );
    const saved = await (
      await import("/src/backend/workspace.ts")
    ).importWorkspaceDocument({
      ...createDocument("UI package C"),
      nodes: [node],
    });
    (await import("/src/backend/creationClient.ts"))
      .creationClient(saved.id)
      .close();
    await (await import("/src/backend/projects.ts")).releaseBackendProject();
    return { id: saved.id, item: node.id };
  });
  await page.unroute(bootstrap);
  await page.goto(projectUrl());
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await open();
  await page
    .getByRole("button", { name: "Import as new timeline", exact: true })
    .click();
  await page
    .getByLabel("Import editable timeline package", { exact: true })
    .setInputFiles(cliArchive);
  await page
    .getByText("Imported as a new timeline. Your current draft is unchanged.", {
      exact: true,
    })
    .waitFor();
  snapshot = await state();
  const cd = snapshot.editorDocuments.find((d) => d.data.overlays?.length);
  assert.equal(cd.data.overlays[0].text, "Editable bundle 可编辑");
  assert.equal(
    cd.data.fonts[0].asset.fingerprint,
    original.data.fonts[0].asset.fingerprint,
  );
  assert.equal(
    cd.data.overlays[0].sourceAsset.fingerprint,
    original.data.overlays[0].sourceAsset.fingerprint,
  );
  f.item = snapshot.canvasItems.find((i) =>
    JSON.stringify(i.binding).includes(cd.id),
  ).id;
  console.log("STAGE UI import C passed");
  // Restart the real fixture and reopen only target C; A/B are never reopened.
  await stop(server);
  server = start();
  await until(
    async () =>
      (
        await fetch(api + "/api/creation-test-health", {
          headers: { "X-OpenDirector-Request": "1" },
        })
      ).ok,
  );
  await page.reload();
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await open();
  await page.locator(".cw-timeline-text-move").first().click();
  assert.equal(await content.inputValue(), "Editable bundle 可编辑");
  // Resize only the client output fixture: the canonical import itself is checked above.
  const width = page.getByLabel("Width", { exact: true }),
    height = page.getByLabel("Height", { exact: true });
  if (await width.count()) {
    await width.fill("640");
    await height.fill("360");
  }
  await content.fill("跨工程续编 A");
  await content.blur();
  const end = page.getByLabel("End (s)", { exact: true });
  await end.fill("1");
  await end.blur();
  const publications = [];
  async function renderAndPublish(name) {
    await page.getByRole("button", { name: "Render MP4", exact: true }).click();
    await page
      .getByRole("button", { name: "Download MP4", exact: true })
      .waitFor({ timeout: 180000 });
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download MP4", exact: true })
      .click();
    const file = join(evidence, name + ".mp4");
    await (await download).saveAs(file);
    const fingerprint =
      "sha256:" +
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
    await page
      .getByRole("button", {
        name: "Add rendered video to canvas",
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Added to canvas", exact: true })
      .waitFor();
    const snap = await state();
    const output = snap.assets.find((a) => a.fingerprint === fingerprint);
    assert(
      output?.provenance?.editorRevision,
      "published real MP4 retains exact document revision",
    );
    const probe = JSON.parse(
      execFileSync(executable("ffprobe"),
        ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
        { encoding: "utf8" },
      ),
    );
    assert.equal(probe.streams[0].codec_name, "h264");
    publications.push({
      file,
      fingerprint,
      assetId: output.id,
      provenance: output.provenance,
      ffprobe: probe,
    });
  }
  console.log("STAGE restart C passed");
  await renderAndPublish("continued-a");
  await content.fill("跨工程续编 B");
  await content.blur();
  await renderAndPublish("continued-b");
  assert.notEqual(publications[0].assetId, publications[1].assetId);
  assert.notEqual(
    publications[0].provenance.editorRevision,
    publications[1].provenance.editorRevision,
  );
  const old = (await state()).assets.find(
    (a) => a.id === publications[0].assetId,
  );
  assert.equal(old.fingerprint, publications[0].fingerprint);
  assert.deepEqual(old.provenance, publications[0].provenance);
  const decoded = publications.map((output) =>
    execFileSync(executable("ffmpeg"),
      [
        "-v",
        "error",
        "-i",
        output.file,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    ),
  );
  assert.notEqual(
    createHash("sha256").update(decoded[0]).digest("hex"),
    createHash("sha256").update(decoded[1]).digest("hex"),
    "new wording changes actual decoded video pixels",
  );
  for (let i = 0; i < publications.length; i++) {
    execFileSync(executable("ffmpeg"), [
      "-v",
      "error",
      "-y",
      "-i",
      publications[i].file,
      "-frames:v",
      "1",
      join(evidence, `continued-${i === 0 ? "a" : "b"}.png`),
    ]);
    const response = await page.request.post(
      api + `/api/creation/projects/${f.id}/queries`,
      {
        headers: { "X-OpenDirector-Request": "1" },
        data: {
          type: "object.get",
          projectId: f.id,
          queryId: randomUUID(),
          objectId: cd.id,
          revision: publications[i].provenance.editorRevision,
        },
      },
    );
    assert(response.ok());
    const savedDocument = await response.json();
    assert.equal(
      savedDocument.data.overlays[0].text,
      `跨工程续编 ${i === 0 ? "A" : "B"}`,
    );
    publications[i].savedText = savedDocument.data.overlays[0].text;
  }
  // Real visible controls and errors in both locales;正文 and business identities stay unchanged.
  await page.screenshot({ path: join(evidence, "text-package-en.png") });
  assert.equal(await page.getByRole("button", { name: "Export FCPXML", exact: true }).isDisabled(), true);
  await page
    .getByText(
      "FCPXML and XML + media ZIP cannot retain text or fonts. Use an editable package to continue editing, or MP4 for the rendered video.",
      { exact: true },
    )
    .waitFor();
  await page.evaluate(() => {
    localStorage.setItem("opendirector.locale.v1", "zh-CN");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "opendirector.locale.v1",
        newValue: "zh-CN",
      }),
    );
  });
  await page
    .getByRole("button", { name: "导出可编辑包", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("文字内容", { exact: true }).inputValue(),
    "跨工程续编 B",
  );
  assert.equal(await page.getByRole("button", { name: "导出 FCPXML", exact: true }).isDisabled(), true);
  await page
    .getByText("FCPXML 和 XML + 素材 ZIP 无法保留文字或字体。请使用可编辑包继续编辑，或使用 MP4 导出渲染视频。", {
      exact: true,
    })
    .waitFor();
  await page.screenshot({ path: join(evidence, "text-package-zh.png") });
  // Unknown capabilities fail through the real package API in both languages.
  const unsupported = join(root, "unsupported.timeline.zip");
  execFileSync(pythonExecutable(), [
    "-c",
    "import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as source, zipfile.ZipFile(sys.argv[2], 'w') as target:\n for item in source.infolist():\n  value=source.read(item.filename)\n  if item.filename == 'manifest.json':\n   manifest=json.loads(value); manifest['requiredCapabilities']=['timeline.future.v99']; value=json.dumps(manifest).encode()\n  target.writestr(item.filename,value)",
    cliArchive,
    unsupported,
  ]);
  for (const locale of ["zh-CN", "en-US"]) {
    await page.evaluate((locale) => {
      localStorage.setItem("opendirector.locale.v1", locale);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "opendirector.locale.v1",
          newValue: locale,
        }),
      );
    }, locale);
    await page
      .getByRole("button", {
        name: locale === "zh-CN" ? "导入为新时间线" : "Import as new timeline",
        exact: true,
      })
      .click();
    await page
      .getByLabel(
        locale === "zh-CN"
          ? "导入可编辑时间线包"
          : "Import editable timeline package",
        { exact: true },
      )
      .setInputFiles(unsupported);
    await page
      .getByText(
        locale === "zh-CN"
          ? "可编辑时间线包无效或格式不受支持。"
          : "Invalid or unsupported editable timeline package.",
        { exact: true },
      )
      .waitFor();
    await page.screenshot({
      path: join(evidence, `unsupported-package-${locale}.png`),
    });
  }
  assert.equal(
    (await state()).editorDocuments.length,
    2,
    "unknown capability must not create a document",
  );
  Object.assign(report, {
    sourceProject: original.projectId,
    cliProject: b,
    targetProject: f.id,
    sourceEditor: editorId,
    targetEditor: cd.id,
    sourceFont: original.data.fonts[0].asset,
    targetFont: cd.data.fonts[0].asset,
    sourceText: original.data.overlays[0].sourceAsset,
    targetText: cd.data.overlays[0].sourceAsset,
    publications,
  });
  // UI scale fixture is a real saved document, not a stand-alone state benchmark.
  await page
    .locator(".cw-timeline-dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page.evaluate(
    async ({ pid, eid }) => {
      const { request, json } = await import("/src/backend/api.ts");
      const snapshot = await request(`/creation/projects/${pid}`);
      const document = structuredClone(
        snapshot.editorDocuments.find((d) => d.id === eid),
      );
      const cue = document.data.overlays[0];
      document.data.overlays = Array.from({ length: 2000 }, (_, i) => ({
        ...cue,
        id: `cue-${i}`,
        start: i * 0.3,
        end: (i + 1) * 0.3,
        text: `字幕 ${i + 1}`,
        style: { ...cue.style, fontSize: 24 },
      }));
      const receipt = await request(
        `/creation/projects/${pid}/commands`,
        json("POST", {
          projectId: pid,
          commandId: crypto.randomUUID(),
          type: "editor.save",
          expectedVersions: [
            {
              objectType: "editor_document",
              id: eid,
              revision: document.revision,
            },
          ],
          payload: { document },
        }),
      );
      if (receipt.status !== "applied") throw Error(JSON.stringify(receipt));
      await (await import("/src/backend/creationClient.ts"))
        .creationClient(pid)
        .refresh();
    },
    { pid: f.id, eid: cd.id },
  );
  const pageCdp = await page.context().newCDPSession(page);
  report.uiScale = {
    cueCount: 2000,
    durationSeconds: 600,
    measure:
      "Playwright fill+blur to two requestAnimationFrame callbacks (includes CDP round trips)",
    samplesMs: [],
    heapBefore: await pageCdp.send("Runtime.getHeapUsage"),
  };
  const openedAt = performance.now();
  await open();
  await page.locator(".cw-timeline-text-move").first().click();
  report.uiScale.openMs = performance.now() - openedAt;
  for (let i = 0; i < 10; i++) {
    const started = performance.now();
    await content.fill(`编辑响应 ${i}`);
    await content.blur();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    report.uiScale.samplesMs.push(performance.now() - started);
  }
  report.uiScale.heapAfter = await pageCdp.send("Runtime.getHeapUsage");
  report.uiScale.browserVersion = await pageCdp.send("Browser.getVersion");
  await page.screenshot({ path: join(evidence, "text-2000-ui-en.png") });
  assert.deepEqual(errors, []);
  console.log(
    "PASS native UI↔CLI cross-project roundtrip/restart/continued MP4/new publication/bilingual refusal",
    evidence,
  );
} catch (error) {
  console.error(
    await globalThis.debugPage
      ?.locator("body")
      .innerText({ timeout: 1000 })
      .catch(() => ""),
  );
  throw error;
} finally {
  await writeFile(
    join(evidence, "report.json"),
    JSON.stringify(report, null, 2),
  );
  await browser?.close();
  await stop(web);
  await stop(server);
}
