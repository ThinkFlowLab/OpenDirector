import type { CanvasToolId, ToolParameters } from "./toolCatalog.ts";
import type { LinkedMediaResult } from "./linkedResults.ts";
import { encodePcmWav } from "./localAudio.ts";
import {
  mediaBlobDataUrl,
  recordLocalVideoRange,
} from "./localMediaRuntime.ts";
import { withMediaDuration } from "./editorMedia.ts";
import { tNow } from "../i18n/messages.ts";
import type { VideoCrop } from "./videoCrop.ts";

export interface VideoTimeRange {
  start: number;
  end: number;
}

export function fitVideoTimeRange(
  range: VideoTimeRange,
  duration: number,
): VideoTimeRange {
  if (!Number.isFinite(duration) || duration <= 0) return { start: 0, end: 0 };
  const gap = Math.min(0.01, duration);
  const start = Math.max(
    0,
    Math.min(duration - gap, Number.isFinite(range.start) ? range.start : 0),
  );
  const end = Math.max(
    start + gap,
    Math.min(duration, Number.isFinite(range.end) ? range.end : duration),
  );
  return { start, end };
}

export function initialVideoActionParameters(
  tool: CanvasToolId,
): ToolParameters {
  switch (tool) {
    case "video-upscale":
      return { resolution: "4K" };
    case "video-depth-capture":
      return { resolution: "480P" };
    case "video-frame-interpolation":
      return { fps: 30 };
    case "video-matting":
      return { background: "black" };
    case "video-mask-composite":
      return { stretch: true };
    case "audio-separation":
      return { mode: "voice", description: "" };
    case "video-subtitle-erasure":
      return { confirmed: false };
    case "video-edit":
    case "video-partial-reshoot":
      return { prompt: "" };
    default:
      return {};
  }
}

/** Validates the dedicated panel's inputs; the connected adapter still owns its capability limits. */
export function videoActionInputError(
  tool: CanvasToolId,
  parameters: ToolParameters,
  duration: number,
  range: VideoTimeRange,
) {
  const options: Partial<
    Record<CanvasToolId, { key: string; values: readonly (string | number)[] }>
  > = {
    "video-upscale": { key: "resolution", values: ["2K", "4K"] },
    "video-depth-capture": { key: "resolution", values: ["480P", "720P"] },
    "video-frame-interpolation": { key: "fps", values: [30, 60] },
    "video-matting": {
      key: "background",
      values: ["black", "green", "transparent", "mask"],
    },
    "audio-separation": {
      key: "mode",
      values: [
        "voice",
        "backgroundSound",
        "soundEffects",
        "all",
        "description",
      ],
    },
  };
  const field = options[tool];
  if (field && !field.values.includes(parameters[field.key] as string | number))
    return tNow("errors.videoAction.options");
  if (
    ["video-trim", "video-partial-reshoot", "extract-audio"].includes(tool) &&
    (!Number.isFinite(duration) ||
      duration <= 0 ||
      !Number.isFinite(range.start) ||
      !Number.isFinite(range.end) ||
      range.start < 0 ||
      range.end <= range.start ||
      range.end > duration)
  )
    return tNow("errors.videoAction.duration");
  if (
    (tool === "video-edit" || tool === "video-partial-reshoot") &&
    (typeof parameters.prompt !== "string" || !parameters.prompt.trim())
  )
    return tNow("errors.videoAction.prompt");
  if (
    tool === "video-edit" &&
    (!Number.isFinite(duration) || duration < 4 || duration > 30)
  )
    return tNow("errors.videoAction.minDuration");
  if (
    tool === "video-depth-capture" &&
    (!Number.isFinite(duration) || duration <= 0 || duration > 30)
  )
    return tNow("errors.videoAction.depthDuration");
  if (
    tool === "audio-separation" &&
    parameters.mode === "description" &&
    (typeof parameters.description !== "string" ||
      !parameters.description.trim())
  )
    return tNow("errors.videoAction.audioDescription");
  if (tool === "video-subtitle-erasure" && parameters.confirmed !== true)
    return tNow("errors.videoAction.confirmSubtitles");
  return undefined;
}

export function captureVideoFrame(
  video: HTMLVideoElement,
  title: string,
): LinkedMediaResult {
  if (
    video.seeking ||
    !video.videoWidth ||
    !video.videoHeight ||
    video.readyState < 2
  )
    throw new Error(tNow("errors.videoAction.frameNotReady"));
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error(tNow("errors.videoAction.canvas"));
  context.drawImage(video, 0, 0);
  return {
    kind: "image",
    src: canvas.toDataURL("image/png"),
    mimeType: "image/png",
    title: `${title} · ${video.currentTime.toFixed(2)}s`,
    media: { width: video.videoWidth, height: video.videoHeight },
  };
}

/** Selects the actual endpoint packet in presentation order, including variable-rate media. */
export async function captureVideoEndpoint(
  src: string,
  title: string,
  endpoint: "first" | "last",
  signal: AbortSignal,
): Promise<LinkedMediaResult> {
  signal.throwIfAborted();
  const { Input, BlobSource, ALL_FORMATS, EncodedPacketSink, CanvasSink } =
    await import("mediabunny");
  signal.throwIfAborted();
  const response = await fetch(src, { signal });
  if (!response.ok) throw new Error(tNow("errors.videoAction.videoRead"));
  const blob = await response.blob();
  signal.throwIfAborted();
  const input = new Input({
    source: new BlobSource(blob),
    formats: ALL_FORMATS,
  });
  const dispose = () => input.dispose();
  signal.addEventListener("abort", dispose, { once: true });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode()))
      throw new Error(tNow("errors.videoAction.preciseDecode"));
    signal.throwIfAborted();
    // EncodedPacketSink documents Infinity as the last presentation packet;
    // CanvasSink then decodes that packet timestamp with display rotation applied.
    const sink = new CanvasSink(track, { poolSize: 1, alpha: true });
    let frame: Awaited<ReturnType<typeof sink.getCanvas>> = null;
    if (endpoint === "last") {
      const packet = await new EncodedPacketSink(track).getPacket(Infinity);
      if (packet && packet.timestamp >= 0)
        frame = await sink.getCanvas(packet.timestamp);
    } else {
      // Offset files can begin with negative preroll timestamps. Those samples
      // are decode dependencies, not the first visible picture.
      for await (const candidate of sink.canvases(
        Math.max(0, await track.getFirstTimestamp()),
      )) {
        signal.throwIfAborted();
        if (candidate.timestamp >= 0) {
          frame = candidate;
          break;
        }
      }
    }
    signal.throwIfAborted();
    if (!frame) throw new Error(tNow("errors.videoAction.frameDecode"));
    const canvas = frame.canvas;
    const image =
      "convertToBlob" in canvas
        ? await canvas.convertToBlob({ type: "image/png" })
        : await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
              (blob) =>
                blob ? resolve(blob) : reject(new Error(tNow("errors.videoAction.frameExport"))),
              "image/png",
            ),
          );
    signal.throwIfAborted();
    return {
      kind: "image",
      src: await mediaBlobDataUrl(image, signal),
      mimeType: "image/png",
      title: `${title} · ${endpoint === "first" ? tNow("errors.videoAction.firstFrame") : tNow("errors.videoAction.lastFrame")}`,
      media: { width: canvas.width, height: canvas.height },
    };
  } finally {
    signal.removeEventListener("abort", dispose);
    input.dispose();
  }
}

export async function extractVideoAudio(
  src: string,
  title: string,
  range: VideoTimeRange | undefined,
  signal: AbortSignal,
): Promise<LinkedMediaResult> {
  signal.throwIfAborted();
  const response = await fetch(src, { signal });
  if (!response.ok) throw new Error(tNow("errors.videoAction.audioRead"));
  const source = await response.arrayBuffer();
  signal.throwIfAborted();
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(source);
    signal.throwIfAborted();
    const channels = Array.from(
      { length: decoded.numberOfChannels },
      (_, index) => decoded.getChannelData(index),
    );
    const wav = encodePcmWav(
      channels,
      decoded.sampleRate,
      range?.start ?? 0,
      range?.end ?? decoded.length / decoded.sampleRate,
    );
    return {
      kind: "audio",
      src: await mediaBlobDataUrl(
        new Blob([wav], { type: "audio/wav" }),
        signal,
      ),
      mimeType: "audio/wav",
      title: `${title} · ${tNow("errors.videoAction.audioTrack")}`,
      media: {
        durationSeconds:
          (wav.byteLength - 44) /
          (decoded.numberOfChannels * 2 * decoded.sampleRate),
      },
    };
  } finally {
    await context.close();
  }
}

export async function exportVideoRange(
  video: HTMLVideoElement,
  title: string,
  range: VideoTimeRange,
  signal: AbortSignal,
  onPosition: (seconds: number) => void,
  crop?: VideoCrop,
): Promise<LinkedMediaResult> {
  const blob = await recordLocalVideoRange(
    video,
    range.start,
    range.end,
    signal,
    onPosition,
    { crop },
  );
  const mimeType = blob.type;
  const src = await mediaBlobDataUrl(blob, signal);
  const measured = await withMediaDuration(
    { id: "video-action-output", kind: "video", title, src, mimeType },
    signal,
  );
  signal.throwIfAborted();
  return {
    kind: "video",
    src,
    mimeType,
    title: `${title} · ${crop ? tNow("errors.videoAction.cropTitle") : tNow("errors.videoAction.trimTitle")}`,
    media: {
      width: measured.width,
      height: measured.height,
      durationSeconds: measured.durationSeconds,
    },
  };
}
