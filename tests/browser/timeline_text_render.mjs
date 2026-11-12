import { spawnOwned as spawn, stopOwned, pythonExecutable, sourcePythonPath, executable } from "./host.mjs";
/** Real isolated Chrome/MP4/font lifecycle and native output-pixel comparisons. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowser } from "./engine.mjs";
const root = await mkdtemp(
  join(tmpdir(), "opendirector-creation-text-render-"),
);
const evidence =
  process.env.TIMELINE_TEXT_EVIDENCE ??
  (await mkdtemp(join(tmpdir(), "opendirector-text-render-evidence-")));
await mkdir(evidence, { recursive: true });
const apiPort = process.env.TEXT_RENDER_API_PORT ?? "8044",
  webPort = process.env.TEXT_RENDER_WEB_PORT ?? "5194";
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
function ffmpeg(args) {
  return execFileSync(executable("ffmpeg"), ["-v", "error", "-y", ...args], {
    maxBuffer: 30 * 1024 * 1024,
  });
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
  const page = await browser.newPage({ locale: "en-US" });
  // Extended lane: dismiss the welcome even though this page stays on a fixture document.
  await page.addInitScript(() => localStorage.setItem("opendirector.modelSetup.v1", "dismissed"));
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
  const result = await page.evaluate(async () => {
    const { prepareTimelineFonts, drawTimelineText } =
      await import("/src/canvas/timelineTextRenderer.ts");
    const { renderTimelineMp4 } = await import("/src/canvas/timelineRender.ts");
    const { layoutTimelineText } =
      await import("/src/canvas/timelineTextLayout.ts");
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext("2d");
    const image = document.createElement("canvas");
    image.width = 64;
    image.height = 36;
    const imageCtx = image.getContext("2d");
    imageCtx.fillStyle = "#142850";
    imageCtx.fillRect(0, 0, 64, 36);
    const wav = new ArrayBuffer(44 + 48000 * 5 * 2),
      v = new DataView(wav);
    const str = (offset, text) =>
      [...text].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
    str(0, "RIFF");
    v.setUint32(4, wav.byteLength - 8, true);
    str(8, "WAVEfmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 48000, true);
    v.setUint32(28, 96000, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, "data");
    v.setUint32(40, wav.byteLength - 44, true);
    for (let i = 0; i < 48000 * 5; i++)
      v.setInt16(
        44 + i * 2,
        Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * 10000),
        true,
      );
    const audioUrl = URL.createObjectURL(
      new Blob([wav], { type: "audio/wav" }),
    );
    const font = {
      id: "noto",
      title: "Noto",
      src: "/fonts/NotoSansCJKsc-Regular.otf",
      mimeType: "font/otf",
    };
    const text = (id, start, end, content, color, y = 0.2) => ({
      id,
      start,
      end,
      text: content,
      x: 0.1,
      y,
      maxWidth: 0.6,
      fontId: "noto",
      style: {
        fontSize: 32,
        color: "#ffffff",
        align: "left",
        lineHeight: 1.2,
        background: { color, opacity: 1, padding: 4 },
        stroke: { color: "#000000", width: 1 },
      },
    });
    const timeline = {
      width: 640,
      height: 360,
      fps: 24,
      fonts: [font],
      overlays: [
        text(
          "base",
          1,
          3,
          "中文标题中文标题中文标题中文标题\nHello world",
          "#c03030",
        ),
        text("top", 2, 3, "上层", "#208040"),
        text("tail", 3, 4, "片尾文字", "#303090", 0.6),
      ],
      tracks: [
        {
          id: "v",
          kind: "visual",
          title: "visual",
          muted: false,
          clips: [
            {
              id: "i",
              resource: {
                id: "r",
                kind: "image",
                title: "image",
                src: image.toDataURL(),
              },
              inPoint: 0,
              outPoint: 1,
              speed: 1,
              volume: 1,
              muted: false,
            },
          ],
        },
        {
          id: "a",
          kind: "audio",
          title: "audio",
          muted: false,
          clips: [
            {
              id: "s",
              resource: {
                id: "s",
                kind: "audio",
                title: "tone",
                src: audioUrl,
                durationSeconds: 5,
              },
              start: 0,
              inPoint: 0,
              outPoint: 4.125,
              speed: 1,
              volume: 0.5,
              muted: false,
            },
          ],
        },
      ],
    };
    const before = document.fonts.size;
    const fonts = await prepareTimelineFonts(
      timeline,
      new AbortController().signal,
    );
    const other = await prepareTimelineFonts(
      timeline,
      new AbortController().signal,
    );
    const firstFamily = fonts.family("noto");
    other.dispose();
    if (!document.fonts.check(`32px "${firstFamily}"`))
      throw Error("Disposing another consumer removed active font");
    const frames = [23, 24, 47, 48, 71, 72, 95, 96],
      expected = {};
    for (const frame of frames) {
      ctx.fillStyle = frame < 24 ? "#142850" : "#000000";
      ctx.fillRect(0, 0, 640, 360);
      drawTimelineText(ctx, timeline, frame, fonts);
      expected[frame] = canvas.toDataURL("image/png").split(",")[1];
    }
    const originalMeasure = ctx.measureText.bind(ctx);
    let measurements = 0;
    ctx.measureText = (value) => {
      measurements++;
      return originalMeasure(value);
    };
    drawTimelineText(
      ctx,
      {
        ...timeline,
        overlays: timeline.overlays.map((o) => ({ ...o, end: o.end + 0.01 })),
      },
      47,
      fonts,
    );
    if (measurements !== 0)
      throw Error("Playhead/time-only changes repeated unchanged text layout");
    ctx.measureText = originalMeasure;

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
    const host = document.createElement("div");
    document.body.append(host);
    const reactRoot = createRoot(host),
      previewErrors = [];
    const waitFor = async (predicate) => {
      for (let i = 0; i < 300; i++) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw Error("Preview did not settle");
    };
    const mount = (value, position) =>
      reactRoot.render(
        React.createElement(TimelineTextPreview, {
          timeline: value,
          position,
          onError: (error) => previewErrors.push(error.message),
        }),
      );
    // Archive/clipboard fonts are supported inline resources. Reading/serializing
    // their large src again on each playhead render is an observable hot-path bug.
    const inlineBlob = await (await fetch(font.src)).blob();
    const inlineSource = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(inlineBlob);
    });
    if (inlineSource.length < 16000000)
      throw Error("Expected a representative large inline CJK font");
    let inlineSourceReads = 0;
    const inlineFont = { ...font };
    Object.defineProperty(inlineFont, "src", {
      enumerable: true,
      get() {
        inlineSourceReads++;
        return inlineSource;
      },
    });
    const inlineTimeline = { ...timeline, fonts: [inlineFont] };
    mount(inlineTimeline, 1);
    await waitFor(
      () =>
        host
          .querySelector("canvas")
          ?.getContext("2d")
          .getImageData(65, 73, 1, 1).data[3] > 0,
    );
    inlineSourceReads = 0;
    for (const position of [4, 1, 4, 1]) {
      mount(inlineTimeline, position);
      await waitFor(() => {
        const alpha = host
          .querySelector("canvas")
          .getContext("2d")
          .getImageData(65, 73, 1, 1).data[3];
        return position === 4 ? alpha === 0 : alpha > 0;
      });
    }
    if (inlineSourceReads !== 0)
      throw Error(
        `Position-only React preview updates reread/serialized large inline font src ${inlineSourceReads} times`,
      );
    const positionOnlyFontSourceReads = inlineSourceReads;
    const previewCanvas = host.querySelector("canvas");
    if (previewCanvas.width !== 640 || previewCanvas.height !== 360)
      throw Error("Preview did not use native output resolution");
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, 640, 360);
    ctx.drawImage(previewCanvas, 0, 0);
    const reference = new Image();
    reference.src = "data:image/png;base64," + expected[24];
    await reference.decode();
    const previewPixels = ctx.getImageData(0, 0, 640, 360).data;
    ctx.drawImage(reference, 0, 0);
    const exportPixels = ctx.getImageData(0, 0, 640, 360).data;
    let previewDifference = 0;
    for (let i = 0; i < previewPixels.length; i++)
      previewDifference += Math.abs(previewPixels[i] - exportPixels[i]);
    if (previewDifference / previewPixels.length > 0.1)
      throw Error(
        "React preview differs from export drawing path: " +
          previewDifference / previewPixels.length,
      );
    mount(inlineTimeline, 4);
    await waitFor(
      () =>
        host.querySelector("canvas").getContext("2d").getImageData(65, 73, 1, 1)
          .data[3] === 0,
    );
    // A same-ID resource replacement must invalidate the compact token too.
    mount(timeline, 1);
    await waitFor(
      () =>
        host.querySelector("canvas").getContext("2d").getImageData(65, 73, 1, 1)
          .data[3] > 0,
    );
    mount(timeline, 4);
    await waitFor(
      () =>
        host.querySelector("canvas").getContext("2d").getImageData(65, 73, 1, 1)
          .data[3] === 0,
    );
    mount(
      {
        ...timeline,
        fonts: [{ ...font, id: "noto2" }],
        overlays: timeline.overlays.map((o) => ({ ...o, fontId: "noto2" })),
      },
      1,
    );
    await waitFor(
      () =>
        host.querySelector("canvas").getContext("2d").getImageData(65, 73, 1, 1)
          .data[3] > 0,
    );
    reactRoot.unmount();
    host.remove();
    if (previewErrors.length)
      throw Error(
        "Preview font replacement raised stale-session error: " +
          previewErrors.join(";"),
      );
    ctx.font = `32px "${firstFamily}"`;
    const layout = layoutTimelineText(
      timeline.overlays[0],
      timeline,
      (s) => ctx.measureText(s).width,
    );
    if (
      layout.lines.map((l) => l.text).join("|") !==
      "中文标题中文标题中文标题|中文标题|Hello world"
    )
      throw Error("Unexpected real font line layout");
    const blob = await renderTimelineMp4(
      timeline,
      new AbortController().signal,
      () => {},
    );
    const pure = await renderTimelineMp4(
      { ...timeline, tracks: [{ ...timeline.tracks[0], clips: [] }] },
      new AbortController().signal,
      () => {},
    );
    let failed = false;
    try {
      await prepareTimelineFonts(
        { ...timeline, fonts: [{ ...font, src: "data:font/otf;base64,YmFk" }] },
        new AbortController().signal,
      );
    } catch {
      failed = true;
    }
    if (!failed) throw Error("Invalid font silently fell back");
    const loadingController = new AbortController();
    const loading = prepareTimelineFonts(timeline, loadingController.signal);
    loadingController.abort();
    let loadCancelled = false;
    try {
      await loading;
    } catch (error) {
      loadCancelled = error.name === "AbortError";
    }
    if (!loadCancelled)
      throw Error("In-flight font load did not honor cancellation");
    let missingRejected = false;
    try {
      await prepareTimelineFonts(
        { ...timeline, fonts: [{ ...font, src: undefined }] },
        new AbortController().signal,
      );
    } catch {
      missingRejected = true;
    }
    if (!missingRejected) throw Error("Missing font source silently fell back");
    const controller = new AbortController();
    controller.abort();
    let cancelled = false;
    try {
      await renderTimelineMp4(timeline, controller.signal, () => {});
    } catch (e) {
      cancelled = e.name === "AbortError";
    }
    const exportController = new AbortController();
    let interrupted = false;
    try {
      await renderTimelineMp4(timeline, exportController.signal, (fraction) => {
        if (fraction > 0) exportController.abort();
      });
    } catch (error) {
      interrupted = error.name === "AbortError";
    }
    if (!interrupted) throw Error("Mid-encode cancellation did not reject");
    fonts.dispose();
    if (document.fonts.size !== before)
      throw Error("FontFace leak after repeated render/dispose");
    URL.revokeObjectURL(audioUrl);
    const bytes = async (b) => {
      let s = "";
      for (const x of new Uint8Array(await b.arrayBuffer()))
        s += String.fromCharCode(x);
      return btoa(s);
    };
    return {
      mp4: await bytes(blob),
      pure: await bytes(pure),
      expected,
      failed,
      cancelled,
      inlineFontBytes: inlineBlob.size,
      inlineSourceChars: inlineSource.length,
      positionOnlyFontSourceReads,
      browser: navigator.userAgent,
    };
  });
  assert.equal(result.failed, true);
  assert.equal(result.cancelled, true);
  const mp4 = join(evidence, "text.mp4"),
    pure = join(evidence, "pure-text.mp4");
  await writeFile(mp4, Buffer.from(result.mp4, "base64"));
  await writeFile(pure, Buffer.from(result.pure, "base64"));
  const probe = JSON.parse(
    execFileSync(executable("ffprobe"), [
      "-v",
      "error",
      "-show_streams",
      "-of",
      "json",
      mp4,
    ]),
  );
  assert.ok(
    probe.streams.some((s) => s.codec_type === "audio"),
    "Audio must survive text rendering",
  );
  const audioPcm = ffmpeg([
    "-i",
    mp4,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-f",
    "s16le",
    "pipe:1",
  ]);
  let audioPower = 0;
  for (let i = 0; i < audioPcm.length; i += 2)
    audioPower += audioPcm.readInt16LE(i) ** 2;
  const audioRms = Math.sqrt(audioPower / (audioPcm.length / 2));
  assert.ok(
    audioRms > 2000 && audioRms < 4500,
    `Mixed audio unexpectedly silent or wrong volume: ${audioRms}`,
  );
  const comparisons = [];
  for (const frame of [23, 24, 47, 48, 71, 72, 95, 96]) {
    const png = join(evidence, `preview-${frame}.png`);
    await writeFile(png, Buffer.from(result.expected[frame], "base64"));
    const actual = ffmpeg([
      "-i",
      mp4,
      "-vf",
      `select=eq(n\\,${frame})`,
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ]);
    const expected = ffmpeg([
      "-i",
      png,
      "-frames:v",
      "1",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ]);
    assert.equal(actual.length, 640 * 360 * 3);
    ffmpeg([
      "-i",
      mp4,
      "-vf",
      `select=eq(n\\,${frame})`,
      "-frames:v",
      "1",
      join(evidence, `decoded-${frame}.png`),
    ]);
    // Compare full-resolution title ROI. A single average pixel cannot pass this.
    let difference = 0,
      count = 0,
      whiteActual = [],
      whiteExpected = [];
    for (let y = 60; y < 300; y++)
      for (let x = 50; x < 470; x++) {
        const i = (y * 640 + x) * 3;
        for (let c = 0; c < 3; c++) {
          difference += Math.abs(actual[i + c] - expected[i + c]);
          count++;
        }
        if (actual[i] > 210 && actual[i + 1] > 210 && actual[i + 2] > 210)
          whiteActual.push([x, y]);
        if (expected[i] > 210 && expected[i + 1] > 210 && expected[i + 2] > 210)
          whiteExpected.push([x, y]);
      }
    const layerSample =
      frame === 23
        ? [64, 70, [20, 40, 80]]
        : [24, 47].includes(frame)
          ? [64, 70, [192, 48, 48]]
          : [48, 71].includes(frame)
            ? [64, 70, [32, 128, 64]]
            : [72, 95].includes(frame)
              ? [64, 214, [48, 48, 144]]
              : [64, 70, [0, 0, 0]];
    const pixelOffset = (layerSample[1] * 640 + layerSample[0]) * 3;
    assert.ok(
      layerSample[2].every(
        (value, channel) => Math.abs(actual[pixelOffset + channel] - value) < 8,
      ),
      `frame ${frame} wrong absolute background/layer color`,
    );
    const mae = difference / count;
    assert.ok(mae < 5, `frame ${frame} ROI error ${mae}`);
    const bounds = (points) => [
      Math.min(...points.map((p) => p[0])),
      Math.min(...points.map((p) => p[1])),
      Math.max(...points.map((p) => p[0])),
      Math.max(...points.map((p) => p[1])),
    ];
    if ([24, 47, 48, 71, 72, 95].includes(frame)) {
      assert.ok(whiteActual.length > 150, `Missing glyphs on frame ${frame}`);
      const a = bounds(whiteActual),
        e = bounds(whiteExpected);
      assert.ok(
        a.every((v, i) => Math.abs(v - e[i]) <= 1),
        `frame ${frame} glyph position ${a} vs ${e}`,
      );
    } else
      assert.equal(
        whiteActual.length,
        0,
        `Unexpected text at exclusive boundary ${frame}`,
      );
    comparisons.push({ frame, mae, glyphPixels: whiteActual.length });
  }
  const tail = ffmpeg([
    "-i",
    pure,
    "-vf",
    "select=eq(n\\,72)",
    "-frames:v",
    "1",
    "-pix_fmt",
    "rgb24",
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
  assert.ok(
    [...tail].filter((v) => v > 200).length > 300,
    "Pure text MP4 must contain actual glyphs",
  );
  const regression = run(process.execPath, ["tests/browser/mp4_export.mjs"], {
    CREATION_WEB_URL: base,
  });
  const [regressionExit] = await once(regression, "exit");
  assert.equal(
    regressionExit,
    0,
    "Existing native MP4/audio regression failed: " + logs.slice(-2000),
  );
  const report = {
    passed: true,
    evidence,
    browser: result.browser,
    comparisons,
    audio: true,
    audioRms,
    preview: true,
    inlineFontBytes: result.inlineFontBytes,
    inlineSourceChars: result.inlineSourceChars,
    positionOnlyFontSourceReads: result.positionOnlyFontSourceReads,
    layoutCache: true,
    pureText: true,
  };
  await writeFile(
    join(evidence, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(String(error));
  console.error(logs.slice(-2000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stop(web);
  await stop(server);
}
