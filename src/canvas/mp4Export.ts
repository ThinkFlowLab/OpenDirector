/** A bounded frame/audio-chunk encoder shared by local composition tools. */
import { prepareSoftwareAac } from "./softwareAac.ts";
import { tNow } from "../i18n/messages.ts";

// Summed times can sit just to either side of an exact frame boundary.
export const frameAtOrAfter = (time: number, fps: number) =>
  Math.ceil(time * fps - 1e-8);

export interface Mp4Options {
  canvas: HTMLCanvasElement;
  duration: number;
  fps: number;
  signal: AbortSignal;
  draw: (time: number, frame: number) => Promise<void> | void;
  audio?: (start: number, end: number) => Promise<AudioBuffer>;
  progress: (fraction: number) => void;
}
export async function encodeMp4(options: Mp4Options): Promise<Blob> {
  const { canvas, duration, fps, signal, draw, audio, progress } = options;
  signal.throwIfAborted();
  if (!(duration > 0) || !Number.isFinite(duration) || !(fps > 0))
    throw new Error(tNow("errors.render.mp4Invalid"));
  if (canvas.width % 2 || canvas.height % 2)
    throw new Error(tNow("errors.render.mp4Even"));
  const {
    Output,
    Mp4OutputFormat,
    BufferTarget,
    CanvasSource,
    AudioBufferSource,
    Quality,
    canEncodeVideo,
    canEncodeAudio,
  } = await import("mediabunny");
  const quality = new Quality("high");
  if (
    !(await canEncodeVideo("avc", {
      width: canvas.width,
      height: canvas.height,
      frameRate: fps,
      quality,
    }))
  )
    throw new Error(
      tNow("errors.render.mp4H264"),
    );
  if (audio) await prepareSoftwareAac();
  if (
    audio &&
    !(await canEncodeAudio("aac", { sampleRate: 48000, numberOfChannels: 2 }))
  )
    throw new Error(tNow("errors.render.aac"));
  signal.throwIfAborted();
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    target,
  });
  const video = new CanvasSource(canvas, {
    codec: "avc",
    quality,
    keyFrameInterval: 2,
  });
  const sound = audio
    ? new AudioBufferSource({
        codec: "aac",
        quality: new Quality({ bitrate: 128000 }),
      })
    : null;
  output.addVideoTrack(video, { frameRate: fps });
  if (sound) output.addAudioTrack(sound);
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= output.cancel();
    void cancellation.catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await output.start();
    const frames = Math.max(1, frameAtOrAfter(duration, fps));
    let audioEnd = 0;
    for (let frame = 0; frame < frames; frame++) {
      signal.throwIfAborted();
      const time = frame / fps;
      await draw(time, frame);
      signal.throwIfAborted();
      await video.add(time, Math.min(1 / fps, duration - time));
      // Feed tracks together: the muxer never has to buffer an entire unmatched track.
      if (
        sound &&
        audio &&
        (time + 1 / fps >= audioEnd || frame === frames - 1)
      ) {
        const end = Math.min(duration, audioEnd + 1);
        if (end > audioEnd) await sound.add(await audio(audioEnd, end));
        audioEnd = end;
      }
      progress(((frame + 1) / frames) * 0.98);
      if (frame % 8 === 0)
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    signal.throwIfAborted();
    video.close();
    sound?.close();
    await output.finalize();
    signal.throwIfAborted();
    if (!target.buffer) throw new Error(tNow("errors.render.noFile"));
    progress(1);
    return new Blob([target.buffer], { type: "video/mp4" });
  } finally {
    signal.removeEventListener("abort", cancel);
    if (output.state !== "finalized" && !cancellation) cancel();
    await cancellation;
    canvas.width = canvas.height = 0;
  }
}
