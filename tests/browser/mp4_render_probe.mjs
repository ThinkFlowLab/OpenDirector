/** Real MP4 render plus container verification: WebCodecs, software AAC, muxing, ffprobe.
 * Like mp4_export.mjs it renders through the app's own pipeline, but the bytes are
 * handed to Node, written to disk and probed with ffprobe so duration, streams and
 * frame count are checked on the actual file, not only on the in-memory blob.
 * Set PLAYWRIGHT_MODULE, CHROMIUM_PATH and CREATION_WEB_URL when needed.
 * Requires ffmpeg/ffprobe on PATH.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { launchBrowser } from "./engine.mjs";

const execFileAsync = promisify(execFile);
const web = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const output = process.env.RENDER_PROBE_OUTPUT ?? "/tmp/opendirector-render-probe.mp4";

const browser = await launchBrowser();
const page = await browser.newPage({ locale: "en-US" });
await page.addInitScript(() => {
  try { localStorage.setItem("opendirector.modelSetup.v1", "dismissed"); } catch {}
});
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
      for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
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
          title: "Video track",
          muted: false,
          clips: [
            imageClip("c1", paint("#c0392b"), "red"),
            imageClip("c2", paint("#2c3e99"), "blue"),
          ],
        },
        {
          id: "audio",
          kind: "audio",
          title: "Audio track",
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
    const started = performance.now();
    const blob = await renderTimelineMp4(timeline, new AbortController().signal, (fraction) =>
      progress.push(fraction),
    );
    const renderMs = Math.round(performance.now() - started);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return {
      base64: btoa(binary),
      renderMs,
      progressLast: progress.at(-1),
    };
  });

  assert.equal(result.progressLast, 1, "progress must reach 1");
  await fs.writeFile(output, Buffer.from(result.base64, "base64"));
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format", "-show_streams",
    output,
  ]);
  const probe = JSON.parse(stdout);
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  assert.ok(video, "file must contain a video stream");
  assert.ok(audio, "file must contain an audio stream");
  const duration = Number(probe.format.duration);
  const frames = Number(video.nb_frames);
  assert.ok(
    Math.abs(duration - 2) <= 0.3,
    `duration must be ~2 s, got ${duration}`,
  );
  assert.equal(video.codec_name, "h264", "video codec must be h264");
  assert.equal(video.width, 640, "render width must be 640");
  assert.equal(video.height, 360, "render height must be 360");
  assert.ok(
    Math.abs(frames - 48) <= 2,
    `frame count must be ~48 at 24 fps / 2 s, got ${frames}`,
  );
  assert.equal(audio.codec_name, "aac", "audio codec must be aac");
  assert.equal(Number(audio.sample_rate), 48000, "audio sample rate must be 48000");
  const stat = await fs.stat(output);
  assert.ok(stat.size > 5000, `unexpected file size ${stat.size}`);
  console.log(
    JSON.stringify({
      passed: true,
      output,
      bytes: stat.size,
      renderMs: result.renderMs,
      duration,
      frames,
      video: { codec: video.codec_name, width: video.width, height: video.height },
      audio: { codec: audio.codec_name, sampleRate: Number(audio.sample_rate) },
    }),
  );
} catch (error) {
  console.log(JSON.stringify({ passed: false, message: String(error).slice(0, 600) }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
