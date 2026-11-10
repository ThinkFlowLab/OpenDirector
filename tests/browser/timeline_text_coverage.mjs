import { spawnOwned as spawn, stopOwned, pythonExecutable, sourcePythonPath } from "./host.mjs";
/** Actual draft coverage, Inspector measurement, and independent font consumers. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser } from "./engine.mjs";
const root = await mkdtemp(
  join(tmpdir(), "opendirector-creation-text-coverage-"),
);
const evidence =
  process.env.TIMELINE_TEXT_EVIDENCE ??
  (await mkdtemp(join(tmpdir(), "opendirector-text-coverage-evidence-")));
await mkdir(evidence, { recursive: true });
const apiPort = process.env.TEXT_COVERAGE_API_PORT ?? "8060",
  webPort = process.env.TEXT_COVERAGE_WEB_PORT ?? "5210";
const api = `http://127.0.0.1:${apiPort}`,
  base = `http://127.0.0.1:${webPort}`;
let server,
  web,
  browser,
  logs = "";
function run(command, args, env = {}) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  return child;
}
async function until(check) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Isolated server did not start: " + logs.slice(-1500));
}
async function stop(child) {
  await stopOwned(child);
}
try {
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
  const page = await browser.newPage();
  page.setDefaultTimeout(180000);
  await page.route(base + "/text-render-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Text rendering fixture</title>",
    }),
  );
  await page.goto(base + "/text-render-fixture", {
    waitUntil: "domcontentloaded",
  });
  const latin = execFileSync(
    pythonExecutable(),
    [
      "-c",
      `
import base64, runpy, tempfile
from pathlib import Path
m = runpy.run_path('tests/test_timeline_fonts.py')
with tempfile.TemporaryDirectory() as d:
 print(base64.b64encode(m['tiny_font'](Path(d) / 'latin.ttf', characters='A ').read_bytes()).decode())
`,
    ],
    {
      env: {
        ...process.env,
        PYTHONPATH: sourcePythonPath("tests"),
      },
    },
  )
    .toString()
    .trim();
  const result = await page.evaluate(async (latin) => {
    const RefreshRuntime = (await import("/@react-refresh")).default;
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    const React = (await import("/node_modules/.vite/deps/react.js")).default;
    const { createRoot } = (
      await import("/node_modules/.vite/deps/react-dom_client.js")
    ).default;
    const { TimelineTextPreview } =
      await import("/src/canvas/TimelineTextPreview.tsx");
    const { TimelineTextInspector } =
      await import("/src/canvas/TimelineTextInspector.tsx");
    const { I18nProvider } = await import("/src/i18n/I18nProvider.tsx");
    const { setActiveLocale } = await import("/src/i18n/messages.ts");
    const { updateTimelineText } = await import("/src/canvas/timelineText.ts");
    const delay = () => new Promise((r) => setTimeout(r, 30));
    const settle = async (predicate) => {
      for (let n = 0; n < 200; n++) {
        if (predicate()) return;
        await delay();
      }
    };
    const findings = [];
    const fonts = [
      {
        id: "noto",
        title: "Noto",
        src: "/fonts/NotoSansCJKsc-Regular.otf",
        mimeType: "font/otf",
        missing: "😀",
        language: "en-US",
      },
      {
        id: "latin",
        title: "New custom font",
        src: "data:font/ttf;base64," + latin,
        mimeType: "font/ttf",
        missing: "中文",
        language: "zh-CN",
      },
    ];
    for (const font of fonts) {
      localStorage.setItem("opendirector.locale.v1", font.language);
      setActiveLocale(font.language);
      const host = document.createElement("div");
      document.body.append(host);
      const reactRoot = createRoot(host),
        errors = [];
      const timeline = {
        width: 640,
        height: 360,
        fps: 24,
        tracks: [
          { id: "v", kind: "visual", title: "", muted: false, clips: [] },
        ],
        fonts: [font],
        overlays: [
          {
            id: "cue",
            text: "A",
            start: 0,
            end: 3,
            x: 0.1,
            y: 0.2,
            maxWidth: 0.8,
            fontId: font.id,
            style: {
              fontSize: 64,
              color: "#ffffff",
              align: "left",
              lineHeight: 1.2,
            },
          },
        ],
      };
      const render = (value) =>
        reactRoot.render(
          React.createElement(TimelineTextPreview, {
            timeline: value,
            position: 1,
            onError: (e) => errors.push(e.message),
          }),
        );
      const pixels = () => {
        const c = host.querySelector("canvas");
        if (!c) return 0;
        const p = c.getContext("2d").getImageData(0, 0, 640, 360).data;
        let count = 0;
        for (let i = 3; i < p.length; i += 4) if (p[i]) count++;
        return count;
      };
      render(timeline);
      await settle(() => pixels() > 0);
      const loaded = pixels() > 0,
        faces = document.fonts.size;
      const edited = updateTimelineText(timeline, "cue", {
        text: font.missing,
      });
      render(edited);
      await settle(() => errors.length > 0);
      await delay();
      const missingPixels = pixels(),
        diagnostic = errors.at(-1) ?? "";
      const retained = edited.overlays[0].text === font.missing;
      const sameSession = document.fonts.size === faces;
      render(timeline);
      await settle(() => pixels() > 0);
      const recovered = pixels() > 0;
      findings.push({
        font: font.id,
        loaded,
        missingPixels,
        diagnostic,
        retained,
        sameSession,
        recovered,
      });
      reactRoot.unmount();
      host.remove();
      // Inspector measures drafts independently of the preview; no Canvas fallback
      // is allowed even when the user has not blurred the textarea yet.
      const inspector = document.createElement("div");
      document.body.append(inspector);
      const inspectorRoot = createRoot(inspector),
        inspectorErrors = [];
      let badMeasurements = 0;
      const measure = CanvasRenderingContext2D.prototype.measureText;
      CanvasRenderingContext2D.prototype.measureText = function (text) {
        if ([...font.missing].some((char) => text.includes(char)))
          badMeasurements++;
        return measure.call(this, text);
      };
      const validity = [];
      const props = {
        timeline,
        overlay: timeline.overlays[0],
        onChange: () => {},
        onDelete: () => {},
        onReorder: () => {},
        onDraftChange: () => {},
        onValidityChange: (valid) => validity.push(valid),
        onError: (e) => inspectorErrors.push(e.message),
      };
      inspectorRoot.render(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(TimelineTextInspector, props),
        ),
      );
      await settle(
        () => inspector.querySelector("textarea") && document.fonts.size > 0,
      );
      await new Promise((r) => setTimeout(r, 300));
      // Replacing an overlay with the same font session must revalidate too.
      inspectorRoot.render(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(TimelineTextInspector, {
            ...props,
            timeline: edited,
            overlay: edited.overlays[0],
          }),
        ),
      );
      await settle(() => inspectorErrors.length > 0);
      await delay();
      findings.at(-1).inspector = {
        badMeasurements,
        diagnostic: inspectorErrors.at(-1) ?? "",
        retained: inspector.querySelector("textarea")?.value === font.missing,
      };
      // Recover, then type an invalid uncommitted body without onChange/blur.
      inspectorRoot.render(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(TimelineTextInspector, {
            ...props,
            timeline: {
              ...timeline,
              fonts: timeline.fonts.map((f) => ({ ...f })),
            },
          }),
        ),
      );
      await settle(
        () =>
          inspector.querySelector("textarea")?.value === "A" &&
          validity.at(-1) === true,
      );
      const textarea = inspector.querySelector("textarea");
      const editBody = (value) => {
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        ).set.call(textarea, value);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const errorCount = inspectorErrors.length;
      editBody(font.missing);
      await settle(
        () => inspectorErrors.length > errorCount && validity.at(-1) === false,
      );
      findings.at(-1).inspector.uncommittedRejected =
        inspectorErrors.length > errorCount &&
        validity.at(-1) === false &&
        textarea.value === font.missing;
      editBody("A");
      await settle(() => validity.at(-1) === true);
      findings.at(-1).inspector.recovered = validity.at(-1) === true;
      findings.at(-1).inspector.badMeasurements = badMeasurements;
      inspectorRoot.unmount();
      inspector.remove();
      CanvasRenderingContext2D.prototype.measureText = measure;
    }
    return findings;
  }, latin);
  // A fresh page has a fresh immutable coverage cache. Keep the real endpoint,
  // delay only delivery to exercise two overlapping consumers and cancellation.
  const consumers = await browser.newPage();
  await consumers.route(base + "/coverage-consumers", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await consumers.goto(base + "/coverage-consumers");
  let inspections = 0;
  await consumers.route("**/api/creation/fonts/inspect", async (route) => {
    inspections++;
    const response = await route.fetch();
    await new Promise((r) => setTimeout(r, 400));
    await route.fulfill({ response });
  });
  const cancellation = await consumers.evaluate(async (latin) => {
    const { prepareTimelineFonts } =
      await import("/src/canvas/timelineTextRenderer.ts");
    const t = {
      fonts: [
        {
          id: "f",
          title: "Fixture",
          mimeType: "font/ttf",
          src: "data:font/ttf;base64," + latin,
        },
      ],
      overlays: [{ fontId: "f" }],
    };
    const first = new AbortController(),
      second = new AbortController();
    const a = prepareTimelineFonts(t, first.signal),
      b = prepareTimelineFonts(t, second.signal);
    setTimeout(() => first.abort(), 150);
    const values = await Promise.allSettled([a, b]);
    let valid = false;
    if (values[1].status === "fulfilled") {
      values[1].value.assertText("f", "A\n\t");
      valid = true;
      values[1].value.dispose();
    }
    if (values[0].status === "fulfilled") values[0].value.dispose();
    return {
      first: values[0].status,
      second: values[1].status,
      valid,
      faces: document.fonts.size,
    };
  }, latin);
  assert.deepEqual(cancellation, {
    first: "rejected",
    second: "fulfilled",
    valid: true,
    faces: 0,
  });
  assert.equal(
    inspections,
    1,
    "Consumers must share coverage without sharing cancellation",
  );
  await consumers.close();
  const retry = await browser.newPage();
  await retry.route(base + "/coverage-retry", (r) =>
    r.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await retry.goto(base + "/coverage-retry");
  let attempts = 0;
  await retry.route("**/api/creation/fonts/inspect", async (route) => {
    attempts++;
    const response = await route.fetch();
    if (attempts === 1) {
      const data = await response.json();
      data.fingerprint = "sha256:" + "0".repeat(64);
      await route.fulfill({ json: data });
    } else await route.fulfill({ response });
  });
  const retried = await retry.evaluate(async (latin) => {
    const { prepareTimelineFonts } =
      await import("/src/canvas/timelineTextRenderer.ts");
    const t = {
      fonts: [
        {
          id: "f",
          title: "Fixture",
          mimeType: "font/ttf",
          src: "data:font/ttf;base64," + latin,
          coverage: "all characters",
        },
      ],
      overlays: [{ fontId: "f" }],
    };
    let rejected = false;
    try {
      const s = await prepareTimelineFonts(t, new AbortController().signal);
      s.dispose();
    } catch {
      rejected = true;
    }
    const s = await prepareTimelineFonts(t, new AbortController().signal);
    s.assertText("f", "A");
    let missingRejected = false;
    try {
      s.assertText("f", "中");
    } catch {
      missingRejected = true;
    }
    s.dispose();
    return { rejected, missingRejected, faces: document.fonts.size };
  }, latin);
  assert.deepEqual(retried, {
    rejected: true,
    missingRejected: true,
    faces: 0,
  });
  assert.equal(attempts, 2, "Failed/mismatched inspection must be retryable");
  await retry.close();
  console.log(JSON.stringify({ cancellation, inspections, retried, attempts }));
  console.log(JSON.stringify(result, null, 2));
  await writeFile(
    join(evidence, "coverage.json"),
    JSON.stringify(result, null, 2),
  );
  for (const item of result) {
    assert.equal(item.loaded, true);
    assert.equal(
      item.missingPixels,
      0,
      item.font + " silently drew fallback glyphs",
    );
    assert.match(
      item.diagnostic,
      item.font === "noto" ? /cover all text characters/ : /未覆盖全部文字字符/,
    );
    assert.equal(item.retained, true);
    assert.equal(item.sameSession, true);
    assert.equal(item.recovered, true);
    assert.equal(item.inspector.badMeasurements, 0);
    assert.match(
      item.inspector.diagnostic,
      item.font === "noto" ? /cover all text characters/ : /未覆盖全部文字字符/,
    );
    assert.equal(item.inspector.retained, true);
    assert.equal(item.inspector.uncommittedRejected, true);
    assert.equal(item.inspector.recovered, true);
  }
} finally {
  await browser?.close();
  await stop(web);
  await stop(server);
}
