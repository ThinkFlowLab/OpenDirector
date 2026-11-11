import { spawnOwned as spawn, stopOwned, pythonExecutable, sourcePythonPath, executable, sampleProcessRss, rssDefinition } from "./host.mjs";
/** Headed, isolated desktop H.264 acceptance and reproducible 2,000-cue measurements.
 * Test inputs are generated locally. HTTP stays in the loopback Vite/API
 * fixtures; no user profile, project, model, or credentials are accessed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = await mkdtemp(
  join(tmpdir(), "opendirector-creation-text-desktop-"),
);
const evidence = resolve(
  process.env.TIMELINE_TEXT_EVIDENCE ?? "test-results/issue87/desktop",
);
await mkdir(evidence, { recursive: true });
const port = process.env.TEXT_DESKTOP_WEB_PORT ?? "5205";
const apiPort = process.env.TEXT_DESKTOP_API_PORT ?? "8055";
const api = `http://127.0.0.1:${apiPort}`;
assert.match(port, /^\d{4,5}$/);
const base = `http://127.0.0.1:${port}`;
let web,
  server,
  browser,
  logs = "";
let rssTimer;
const report = {
  date: new Date().toISOString(),
  headed: true,
  root,
  outputs: [],
  measurements: {},
};
async function stop(child) {
  await stopOwned(child);
}
try {
  server = spawn(
    pythonExecutable(),
    ["tests/browser/creation_server.py", "--port", apiPort, "--root", root],
    {
      env: { ...process.env, PYTHONPATH: sourcePythonPath() },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout.on("data", (d) => (logs += d));
  server.stderr.on("data", (d) => (logs += d));
  let apiReady = false;
  for (let i = 0; i < 300; i++) {
    try {
      apiReady = (
        await fetch(api + "/api/creation-test-health", {
          headers: { "X-OpenDirector-Request": "1" },
        })
      ).ok;
    } catch {}
    if (apiReady) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(apiReady, logs.slice(-1000));
  web = spawn(
    "node",
    [
      "node_modules/vite/bin/vite.js",
      "--host",
      "127.0.0.1",
      "--port",
      port,
      "--strictPort",
    ],
    {
      env: { ...process.env, OPENDIRECTOR_API_URL: api },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  web.stdout.on("data", (d) => (logs += d));
  web.stderr.on("data", (d) => (logs += d));
  let ready = false;
  for (let i = 0; i < 300; i++) {
    try {
      ready = (await fetch(base)).ok;
    } catch {}
    if (ready) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(ready, logs.slice(-1000));
  const { chromium } = await import(
    process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
  );
  browser = await chromium.launchPersistentContext(
    join(root, "chrome-profile"),
    {
      headless: false,
      executablePath: process.env.CHROMIUM_PATH,
      viewport: { width: 1500, height: 1000 },
      args: ["--enable-precise-memory-info"],
    },
  );
  const page = browser.pages()[0];
  page.setDefaultTimeout(180000);
  await page.route(base + "/desktop-text-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>OpenDirector isolated desktop text validation</title><body>Desktop acceptance running</body>",
    }),
  );
  await page.goto(base + "/desktop-text-fixture");
  const cdp = await browser.newCDPSession(page);
  report.browser = await cdp.send("Browser.getVersion");
  const processCdp = await browser.browser().newBrowserCDPSession();
  report.processRss = {
    intervalMs: 500,
    unit: "KiB",
    definition:
      rssDefinition,
    phases: {},
    errors: [],
  };
  let rssPhase,
    sampling = false;
  async function sampleRss() {
    if (!rssPhase || sampling) return;
    sampling = true;
    const phase = rssPhase;
    try {
      const info = await processCdp.send("SystemInfo.getProcessInfo");
      const ids = info.processInfo
        .map((p) => Number(p.id))
        .filter((id) => Number.isSafeInteger(id) && id > 0);
      assert(
        ids.length > 0 && ids.length <= 128,
        "Bounded owned Chrome process list",
      );
      const rows = sampleProcessRss(ids);
      assert(
        rows.every(
          (row) =>
            ids.includes(row.pid) &&
            Number.isFinite(row.rssKiB) &&
            row.rssKiB >= 0,
        ),
      );
      const totalRssKiB = rows.reduce((sum, row) => sum + row.rssKiB, 0);
      const target = report.processRss.phases[phase];
      target.samples.push({
        at: new Date().toISOString(),
        totalRssKiB,
        processes: rows,
      });
      target.peakSumRssKiB = Math.max(target.peakSumRssKiB, totalRssKiB);
    } catch (error) {
      report.processRss.errors.push({ phase, error: error.message });
    } finally {
      sampling = false;
    }
  }
  await page.exposeFunction("benchmarkPhase", async (name, action) => {
    assert(["baseline", "text-2000"].includes(name));
    assert(["start", "end"].includes(action));
    if (action === "start") {
      report.processRss.phases[name] = { peakSumRssKiB: 0, samples: [] };
      rssPhase = name;
      await sampleRss();
    } else if (rssPhase === name) {
      await sampleRss();
      rssPhase = undefined;
    }
  });
  rssTimer = setInterval(() => void sampleRss(), 500);
  report.platform = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  };
  await page.exposeFunction("saveEvidence", async (name, encoded) => {
    assert.match(name, /^[a-z0-9-]+\.(mp4|png)$/);
    await writeFile(join(evidence, name), Buffer.from(encoded, "base64"));
  });
  const results = await page.evaluate(async () => {
    const { renderTimelineMp4 } = await import("/src/canvas/timelineRender.ts");
    const { prepareTimelineFonts, drawTimelineText } =
      await import("/src/canvas/timelineTextRenderer.ts");
    const font = {
      id: "noto",
      title: "Noto Sans CJK SC",
      src: "/fonts/NotoSansCJKsc-Regular.otf",
      mimeType: "font/otf",
    };
    const cue = (id, start, end, text, color, y = 0.15) => ({
      id,
      start,
      end,
      text,
      x: 0.1,
      y,
      maxWidth: 0.8,
      fontId: "noto",
      style: {
        fontSize: 64,
        color: "#ffffff",
        align: "left",
        lineHeight: 1.2,
        background: { color, opacity: 1, padding: 8 },
      },
    });
    const save = async (name, blob) => {
      const b64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(",")[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      await window.saveEvidence(name, b64);
    };
    const image = document.createElement("canvas");
    image.width = 4;
    image.height = 4;
    image.getContext("2d").fillRect(0, 0, 4, 4);
    const track = (duration) => ({
      id: "visual",
      kind: "visual",
      title: "Baseline black image",
      muted: false,
      clips: [
        {
          id: "black",
          resource: {
            id: "image",
            kind: "image",
            title: "black",
            src: image.toDataURL(),
          },
          inPoint: 0,
          outPoint: duration,
          speed: 1,
          volume: 1,
          muted: false,
        },
      ],
    });
    const outputs = [];
    for (const [name, width, height] of [
      ["landscape", 1920, 1080],
      ["portrait", 1080, 1920],
    ]) {
      const capability = await VideoEncoder.isConfigSupported({
        codec: "avc1.640033",
        width,
        height,
        bitrate: 8000000,
        framerate: 24,
      });
      const timeline = {
        width,
        height,
        fps: 24,
        fonts: [font],
        tracks: [track(2.5)],
        overlays: [
          cue("main", 0.5, 1.5, "中文标题\nDesktop text", "#c03030"),
          cue("overlap", 1, 2, "上层文字", "#208040"),
          cue("tail", 2, 2.5, "片尾文字", "#303090", 0.6),
        ],
      };
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      document.body.append(canvas);
      canvas.style.width = "540px";
      const ctx = canvas.getContext("2d");
      const fonts = await prepareTimelineFonts(
        timeline,
        new AbortController().signal,
      );
      for (const frame of [11, 12, 23, 24, 35, 36, 47, 48, 59, 60]) {
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, width, height);
        drawTimelineText(ctx, timeline, frame, fonts);
        await save(
          `${name}-preview-${frame}.png`,
          await new Promise((resolve) => canvas.toBlob(resolve)),
        );
      }
      fonts.dispose();
      try {
        const started = performance.now();
        const blob = await renderTimelineMp4(
          timeline,
          new AbortController().signal,
          () => {},
        );
        await save(name + ".mp4", blob);
        outputs.push({
          name,
          width,
          height,
          duration: 2.5,
          milliseconds: performance.now() - started,
          bytes: blob.size,
          queriedCapability: capability.supported,
        });
      } catch (e) {
        outputs.push({
          name,
          width,
          height,
          queriedCapability: capability.supported,
          runtimeError: e.message,
        });
      }
      canvas.remove();
    }
    const measurements = {
      resolution: "640x360",
      fps: 24,
      durationSeconds: 600,
      cueCount: 2000,
      samples: [],
    };
    const benchmark = {
      width: 640,
      height: 360,
      fps: 24,
      fonts: [font],
      tracks: [track(600)],
      overlays: Array.from({ length: 2000 }, (_, i) => ({
        ...cue(
          `cue-${i}`,
          i * 0.3,
          (i + 1) * 0.3,
          `字幕 ${i + 1}`,
          "#202020",
          0.75,
        ),
        style: {
          fontSize: 24,
          color: "#ffffff",
          align: "center",
          lineHeight: 1.2,
        },
      })),
    };
    // The 600-second baseline contains the exact same black image and frame count.
    for (const [name, timeline] of [
      ["baseline", { ...benchmark, overlays: [], fonts: [] }],
      ["text-2000", benchmark],
    ]) {
      await window.benchmarkPhase(name, "start");
      let peakJsHeapBytes = performance.memory?.usedJSHeapSize ?? null;
      const before = performance.memory?.usedJSHeapSize ?? null;
      const started = performance.now();
      const abort = new AbortController();
      const limit = setTimeout(
        () =>
          abort.abort(new Error("600-second benchmark exceeded 180 seconds")),
        180000,
      );
      try {
        const blob = await renderTimelineMp4(timeline, abort.signal, () => {
          if (performance.memory)
            peakJsHeapBytes = Math.max(
              peakJsHeapBytes,
              performance.memory.usedJSHeapSize,
            );
        });
        const milliseconds = performance.now() - started;
        await window.benchmarkPhase(name, "end");
        await save(name + ".mp4", blob);
        measurements.samples.push({
          name,
          milliseconds,
          bytes: blob.size,
          jsHeapBefore: before,
          peakSampledJsHeapBytes: peakJsHeapBytes,
          jsHeapAfter: performance.memory?.usedJSHeapSize ?? null,
        });
      } catch (e) {
        measurements.samples.push({
          name,
          error: e.message,
          milliseconds: performance.now() - started,
          peakSampledJsHeapBytes: peakJsHeapBytes,
        });
      } finally {
        await window.benchmarkPhase(name, "end");
        clearTimeout(limit);
      }
    }
    return { outputs, measurements, userAgent: navigator.userAgent };
  });
  Object.assign(report, results);
  assert.deepEqual(
    report.processRss.errors,
    [],
    "RSS process sampling must succeed",
  );
  for (const name of ["baseline", "text-2000"])
    assert(
      report.processRss.phases[name]?.samples.length >= 2,
      "Both phases need real external RSS samples",
    );
  report.browserHeapAfter = await cdp.send("Runtime.getHeapUsage");
  for (const output of report.outputs.filter((o) => !o.runtimeError)) {
    const file = join(evidence, output.name + ".mp4");
    output.ffprobe = JSON.parse(
      execFileSync(executable("ffprobe"),
        ["-v", "error", "-show_streams", "-show_format", "-of", "json", file],
        { encoding: "utf8" },
      ),
    );
    const stream = output.ffprobe.streams.find((s) => s.codec_type === "video");
    assert.equal(stream.codec_name, "h264");
    assert.equal(stream.width, output.width);
    assert.equal(stream.height, output.height);
    assert(Math.abs(Number(output.ffprobe.format.duration) - 2.5) <= 1 / 24);
    for (const frame of [11, 12, 24, 36, 48, 59]) {
      const decoded = execFileSync(executable("ffmpeg"),
        [
          "-v",
          "error",
          "-i",
          file,
          "-vf",
          `select=eq(n\\,${frame})`,
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "-",
        ],
        { maxBuffer: 20 * 1024 * 1024 },
      );
      const sample = (x, y) => [
        ...decoded.subarray(
          (y * output.width + x) * 3,
          (y * output.width + x) * 3 + 3,
        ),
      ];
      const got = sample(
        Math.round(0.1 * output.width) + 2,
        Math.round((frame < 48 ? 0.15 : 0.6) * output.height) + 2,
      );
      const expected =
        frame < 12
          ? [0, 0, 0]
          : frame < 24
            ? [192, 48, 48]
            : frame < 48
              ? [32, 128, 64]
              : [48, 48, 144];
      assert(
        got.every((v, i) => Math.abs(v - expected[i]) < 12),
        `${output.name} frame ${frame}: ${got} versus ${expected}`,
      );
      execFileSync(executable("ffmpeg"), [
        "-v",
        "error",
        "-y",
        "-i",
        file,
        "-vf",
        `select=eq(n\\,${frame})`,
        "-frames:v",
        "1",
        join(evidence, `${output.name}-decoded-${frame}.png`),
      ]);
    }
  }
  for (const sample of report.measurements.samples.filter((s) => !s.error)) {
    sample.ffprobe = JSON.parse(
      execFileSync(executable("ffprobe"),
        [
          "-v",
          "error",
          "-show_streams",
          "-show_format",
          "-of",
          "json",
          join(evidence, sample.name + ".mp4"),
        ],
        { encoding: "utf8" },
      ),
    );
    const stream = sample.ffprobe.streams.find((s) => s.codec_type === "video");
    assert.equal(stream.width, 640);
    assert.equal(stream.height, 360);
    assert.equal(stream.codec_name, "h264");
    assert.equal(Number(stream.nb_frames), 14400);
    assert.equal(Number(sample.ffprobe.format.duration), 600);
  }
  await page.screenshot({ path: join(evidence, "headed-desktop.png") });
  await writeFile(
    join(evidence, "report.json"),
    JSON.stringify(report, null, 2),
  );
  assert.equal(
    report.outputs.filter((o) => o.runtimeError).length,
    0,
    JSON.stringify(report.outputs),
  );
  assert(
    report.measurements.samples.every((s) => !s.error),
    JSON.stringify(report.measurements.samples),
  );
  console.log(
    "PASS headed desktop outputs and 2000-cue render measurements",
    evidence,
    JSON.stringify(report.measurements),
  );
} finally {
  clearInterval(rssTimer);
  await writeFile(
    join(evidence, "report.json"),
    JSON.stringify(report, null, 2),
  );
  await browser?.close();
  await stop(web);
  await stop(server);
}
