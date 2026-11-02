/** Real MP4 render through the app's own pipeline: WebCodecs, software AAC, muxing.
 * Runs in an isolated browser against the dev server; no model calls.
 * Set PLAYWRIGHT_MODULE, CHROMIUM_PATH and CREATION_WEB_URL when needed.
 */
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);
const web = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";

const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
page.setDefaultTimeout(180000);
try {
  await page.goto(web, { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async () => {
    const paint = (color) => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 36;
      const context = canvas.getContext("2d");
      context.fillStyle = color;
      context.fillRect(0, 0, 64, 36);
      return canvas.toDataURL("image/png");
    };
    // A 2 s mono tone, so the audio track and the software AAC encoder run too.
    const tone = () => {
      const rate = 48000;
      const samples = rate * 2;
      const buffer = new ArrayBuffer(44 + samples * 2);
      const view = new DataView(buffer);
      const write = (offset, text) =>
        [...text].forEach((char, index) =>
          view.setUint8(offset + index, char.charCodeAt(0)),
        );
      write(0, "RIFF");
      view.setUint32(4, 36 + samples * 2, true);
      write(8, "WAVEfmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, rate, true);
      view.setUint32(28, rate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      write(36, "data");
      view.setUint32(40, samples * 2, true);
      for (let i = 0; i < samples; i += 1)
        view.setInt16(
          44 + i * 2,
          Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000),
          true,
        );
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return `data:audio/wav;base64,${btoa(binary)}`;
    };
    const imageClip = (id, src, title) => ({
      id,
      resource: { id: `res-${id}`, kind: "image", title, src },
      inPoint: 0,
      outPoint: 1,
      speed: 1,
      volume: 1,
      muted: false,
    });
    const timeline = {
      fps: 24,
      width: 640,
      height: 360,
      tracks: [
        {
          id: "visual",
          kind: "visual",
          title: "画面轨",
          muted: false,
          clips: [
            imageClip("c1", paint("#c0392b"), "red"),
            imageClip("c2", paint("#2c3e99"), "blue"),
          ],
        },
        {
          id: "audio",
          kind: "audio",
          title: "音频轨",
          muted: false,
          clips: [
            {
              id: "a1",
              resource: {
                id: "res-a1",
                kind: "audio",
                title: "tone",
                src: tone(),
                durationSeconds: 2,
              },
              start: 0,
              inPoint: 0,
              outPoint: 2,
              speed: 1,
              volume: 0.5,
              muted: false,
            },
          ],
        },
      ],
    };
    const { renderTimelineMp4 } = await import("/src/canvas/timelineRender.ts");
    const progress = [];
    const blob = await renderTimelineMp4(timeline, new AbortController().signal, (fraction) =>
      progress.push(fraction),
    );
    const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const ascii = String.fromCharCode(...head);
    let cancelled = "resolved";
    try {
      const controller = new AbortController();
      controller.abort();
      await renderTimelineMp4(timeline, controller.signal, () => {});
    } catch (error) {
      cancelled = error.name;
    }
    return {
      bytes: blob.size,
      type: blob.type,
      ftyp: ascii.includes("ftyp"),
      progressLast: progress.at(-1),
      cancelled,
    };
  });
  assert.equal(result.type, "video/mp4", "render must produce an MP4 blob");
  assert.ok(result.ftyp, "the MP4 must start with an ftyp box");
  assert.ok(result.bytes > 5000, `unexpected size ${result.bytes}`);
  assert.equal(result.progressLast, 1, "progress must reach 1");
  assert.equal(
    result.cancelled,
    "AbortError",
    "an aborted render must reject instead of resolving",
  );
  console.log(JSON.stringify({ passed: true, ...result }));
} catch (error) {
  console.log(JSON.stringify({ passed: false, message: String(error).slice(0, 600) }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
