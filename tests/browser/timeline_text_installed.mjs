import { spawnOwned as spawn, stopOwned, installedServerEnv } from "./host.mjs";
/** Actual installed-wheel UI; no Vite, repository imports, models, or user projects. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { createServer } from "node:net";
import { launchBrowser } from "./engine.mjs";
const python = process.env.OPENDIRECTOR_INSTALLED_PYTHON ?? process.env.PYTHON;
assert(
  python && isAbsolute(python),
  "Set PYTHON or OPENDIRECTOR_INSTALLED_PYTHON to an isolated wheel venv Python",
);
const root = await mkdtemp(
  join(tmpdir(), "opendirector-creation-installed-text-"),
);
const evidence = resolve(
  process.env.TIMELINE_TEXT_EVIDENCE ?? "test-results/issue87/wheel/browser",
);
await mkdir(evidence, { recursive: true });
const port = process.env.TEXT_INSTALLED_API_PORT ?? "8072";
assert.match(port, /^\d{4,5}$/);
const base = `http://127.0.0.1:${port}`,
  pid = randomUUID();
const env = installedServerEnv(python, root);
let server,
  browser,
  logs = "";
const report = {
  date: new Date().toISOString(),
  root,
  python,
  projectId: pid,
  noVite: true,
  noNodeOnServerPath: true,
};
function start() {
  const child = spawn(
    python,
    ["-m", "opendirector.cli", "serve", "--port", port],
    { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  return child;
}
async function stop(child) {
  await stopOwned(child);
}
async function healthy() {
  for (let i = 0; i < 300; i++) {
    try {
      if (
        (
          await fetch(base + "/api/health", {
            headers: { "X-OpenDirector-Request": "1" },
          })
        ).ok
      )
        return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(logs.slice(-2000));
}
try {
  execFileSync(python, ["-c", "from opendirector import installation; assert installation.SOURCE_ROOT is None"], { cwd: root, env });
  execFileSync(
    python,
    ["-c", "import shutil; assert shutil.which('node') is None"],
    { cwd: root, env },
  );
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(Number(port), "127.0.0.1", () => probe.close(resolve));
  });
  server = start();
  await healthy();
  execFileSync(
    python,
    [
      "-m",
      "opendirector.cli",
      "--url",
      base,
      "--project",
      pid,
      "project",
      "create",
      "--name",
      "Installed text acceptance",
    ],
    { cwd: root, env, timeout: 120000 },
  );
  browser = await launchBrowser();
  const page = await browser.newPage({
    viewport: { width: 1700, height: 1100 },
  });
  page.setDefaultTimeout(45000);
  const errors = [],
    requests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    if (r.url().includes("/fonts/") || r.url().includes("/fonts/inspect"))
      requests.push({ url: new URL(r.url()).pathname, status: r.status() });
  });
  await page.addInitScript(() => {
    if (location.protocol !== "http:") return;
    localStorage.setItem("opendirector.locale.v1", "en-US");
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
  });
  await page.goto(base + `/ai-tool/ai-canvas/${pid}`);
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await page
    .getByRole("toolbar", { name: "Canvas creation tools", exact: true })
    .getByRole("button", { name: "Add Timeline", exact: true })
    .click();
  const state = async () =>
    await (
      await page.request.get(base + `/api/creation/projects/${pid}`, {
        headers: { "X-OpenDirector-Request": "1" },
      })
    ).json();
  let snapshot;
  for (let i = 0; i < 100; i++) {
    snapshot = await state();
    if (snapshot.canvasItems.some((item) => item.kind === "timeline")) break;
    await page.waitForTimeout(100);
  }
  const item = snapshot.canvasItems.find((i) => i.kind === "timeline");
  assert(item);
  async function open() {
    await page.locator(".cw-workspace").focus();
    await page.keyboard.press("Shift+1");
    await page.waitForTimeout(250);
    await page
      .locator(`.react-flow__node[data-id="${item.id}"] .cw-node-title`)
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Open editor", exact: true })
      .click();
    await page.locator(".cw-timeline-dialog").waitFor();
  }
  await open();
  await page.getByRole("button", { name: "Add text", exact: true }).click();
  const content = page.getByLabel("Text content", { exact: true });
  await content.waitFor();
  await content.fill("安装验证 中文");
  await content.blur();
  await page.waitForFunction(() => {
    const c = document.querySelector(
      ".cw-timeline-text-preview canvas,canvas.cw-timeline-text-preview",
    );
    return (
      c &&
      [...c.getContext("2d").getImageData(0, 0, c.width, c.height).data].some(
        (v, i) => i % 4 === 3 && v > 0,
      )
    );
  });
  await page.screenshot({ path: join(evidence, "installed-valid-en.png") });
  await content.fill("😀");
  await page
    .getByText("The selected font does not cover all text characters.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await content.inputValue(), "😀");
  assert(
    await page
      .getByRole("button", { name: "Apply edits", exact: true })
      .isDisabled(),
  );
  await page.screenshot({
    path: join(evidence, "installed-missing-glyph-en.png"),
  });
  await content.fill("离线字体 恢复");
  await content.blur();
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('[role="alert"]')].some((e) =>
        e.textContent.includes("does not cover"),
      ),
  );
  await page.getByRole("button", { name: "Apply edits", exact: true }).click();
  await page.locator(".cw-timeline-dialog").waitFor({ state: "hidden" });
  snapshot = await state();
  const editor = snapshot.editorDocuments.find((d) => d.kind === "timeline");
  assert.equal(editor.data.overlays[0].text, "离线字体 恢复");
  assert(editor.data.fonts[0].asset.assetId);
  await stop(server);
  let stopped = false;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(base + "/api/health", {
        headers: { "X-OpenDirector-Request": "1" },
      });
    } catch {
      stopped = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert(stopped, "Actual installed API listener must stop before restart");
  server = start();
  await healthy();
  await page.reload();
  await page.getByText("Saved on this device", { exact: true }).waitFor();
  await open();
  await page.locator(".cw-timeline-text-move").first().click();
  assert.equal(await content.inputValue(), "离线字体 恢复");
  await page.screenshot({ path: join(evidence, "installed-reopened-en.png") });
  const serverPids = [
    ...logs.matchAll(/Started server process \[(\d+)\]/g),
  ].map((match) => Number(match[1]));
  Object.assign(report, {
    serverPids,
    editorId: editor.id,
    editorRevision: editor.revision,
    font: editor.data.fonts[0],
    savedText: editor.data.overlays[0].text,
    requests,
    errors,
    missingGlyphDiagnostic: true,
    unsupportedDraftRetained: true,
    validRecovery: true,
    previewVisible: true,
    serviceRestart: true,
  });
  // The UI fetches the font directly; the independent installed checker verifies manifest/license HTTP bytes.
  assert(
    requests.some(
      (r) => r.url.endsWith("NotoSansCJKsc-Regular.otf") && r.status === 200,
    ),
  );
  assert(
    requests.some(
      (r) => r.url === "/api/creation/fonts/inspect" && r.status === 200,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS actual installed server Add text/preview/missing-glyph/draft recovery/save/restart/reopen",
    evidence,
  );
} finally {
  await writeFile(
    join(evidence, "report.json"),
    JSON.stringify(report, null, 2),
  );
  await writeFile(join(evidence, "server.log"), logs);
  await browser?.close();
  await stop(server);
}
