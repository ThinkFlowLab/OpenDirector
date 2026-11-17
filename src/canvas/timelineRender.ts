import {
  AudioBufferSink,
  BlobSource,
  CanvasSink,
  Input,
  ALL_FORMATS,
} from "mediabunny";
import type { WrappedCanvas } from "mediabunny";
import { tNow } from "../i18n/messages.ts";
import { copyTimeline, timelineError } from "./dataBoundary";
import type { TimelineData } from "./model";
import {
  timelineDuration,
  timelineSegments,
  type TimelineSegment,
} from "./timeline";
import { encodeMp4 } from "./mp4Export";
import {
  prepareTimelineFonts,
  drawTimelineText,
  type TimelineFontSession,
} from "./timelineTextRenderer.ts";

/** Source trims, speed, offset, mute and volume share the editor's timeline semantics. */
export async function renderTimelineMp4(
  value: TimelineData,
  signal: AbortSignal,
  progress: (fraction: number) => void,
): Promise<Blob> {
  const error = timelineError(value);
  if (error) throw new Error(error);
  const timeline = copyTimeline(value),
    segments = timelineSegments(timeline);
  const duration = timelineDuration(timeline);
  if (!duration) throw new Error(tNow("errors.render.timelineEmpty"));
  const canvas = document.createElement("canvas");
  canvas.width = timeline.width;
  canvas.height = timeline.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error(tNow("errors.render.canvas"));
  const inputs = new Map<string, Input>(),
    images = new Map<string, HTMLImageElement>();
  const imageUrls: string[] = [];
  const videos = new Map<
    string,
    AsyncGenerator<WrappedCanvas | null, void, unknown>
  >();
  const sounds: { segment: TimelineSegment; sink: AudioBufferSink }[] = [];
  const disposeInputs = () => inputs.forEach((input) => input.dispose());
  signal.addEventListener("abort", disposeInputs, { once: true });
  let fonts: TimelineFontSession | undefined;
  try {
    fonts = await prepareTimelineFonts(timeline, signal);
    for (const segment of segments) {
      signal.throwIfAborted();
      const { clip, track } = segment,
        resource = clip.resource;
      if (!resource.src)
        throw new Error(
          tNow("errors.render.missingMedia", { title: resource.title }),
        );
      if (resource.kind === "image") {
        if (!images.has(resource.src)) {
          const response = await fetch(resource.src, { signal });
          if (!response.ok)
            throw new Error(
              tNow("errors.render.readFailed", {
                title: resource.title,
                status: response.status,
              }),
            );
          const url = URL.createObjectURL(await response.blob());
          imageUrls.push(url);
          const image = await new Promise<HTMLImageElement>(
            (resolve, reject) => {
              const image = new Image();
              const cleanup = () => {
                image.onload = image.onerror = null;
                signal.removeEventListener("abort", abort);
              };
              const abort = () => {
                cleanup();
                image.removeAttribute("src");
                reject(signal.reason);
              };
              image.onload = () => {
                cleanup();
                resolve(image);
              };
              image.onerror = () => {
                cleanup();
                reject(
                  new Error(
                    tNow("errors.render.imageDecode", {
                      title: resource.title,
                    }),
                  ),
                );
              };
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
              else image.src = url;
            },
          );
          images.set(resource.src, image);
        }
        continue;
      }
      let input = inputs.get(resource.src);
      if (!input) {
        const response = await fetch(resource.src, { signal });
        if (!response.ok)
          throw new Error(
            tNow("errors.render.readFailed", {
              title: resource.title,
              status: response.status,
            }),
          );
        input = new Input({
          source: new BlobSource(await response.blob()),
          formats: ALL_FORMATS,
        });
        inputs.set(resource.src, input);
      }
      if (resource.kind === "video") {
        const video = await input.getPrimaryVideoTrack();
        if (!video || !(await video.canDecode()))
          throw new Error(
            tNow("errors.render.videoDecode", { title: resource.title }),
          );
        const sink = new CanvasSink(video, {
          width: timeline.width,
          height: timeline.height,
          fit: "contain",
          poolSize: 2,
        });
        function* times() {
          for (
            let frame = Math.ceil(segment.start * timeline.fps);
            frame / timeline.fps < segment.end;
            frame++
          )
            yield clip.inPoint +
              (frame / timeline.fps - segment.start) * clip.speed;
        }
        videos.set(clip.id, sink.canvasesAtTimestamps(times()));
      }
      if (!track.muted && !clip.muted && clip.volume > 0) {
        const audio = await input.getPrimaryAudioTrack();
        if (audio) {
          if (!(await audio.canDecode()))
            throw new Error(
              tNow("errors.render.audioDecode", { title: resource.title }),
            );
          sounds.push({ segment, sink: new AudioBufferSink(audio) });
        } else if (resource.kind === "audio")
          throw new Error(
            tNow("errors.render.noAudio", { title: resource.title }),
          );
      }
    }
    return await encodeMp4({
      canvas,
      duration,
      fps: timeline.fps,
      signal,
      progress,
      draw: async (time, frameIndex) => {
        context.fillStyle = "#000000";
        context.fillRect(0, 0, canvas.width, canvas.height);
        const segment = segments.find(
          (item) =>
            item.track.kind === "visual" &&
            time >= item.start &&
            time < item.end,
        );
        if (segment) {
          const resource = segment.clip.resource;
          if (resource.kind === "image") {
            const image = images.get(resource.src!)!;
            const ratio = Math.min(
              canvas.width / image.naturalWidth,
              canvas.height / image.naturalHeight,
            );
            const width = image.naturalWidth * ratio,
              height = image.naturalHeight * ratio;
            context.drawImage(
              image,
              (canvas.width - width) / 2,
              (canvas.height - height) / 2,
              width,
              height,
            );
          } else {
            const frame = await videos.get(segment.clip.id)!.next();
            if (!frame.value)
              throw new Error(
                tNow("errors.render.noFrame", {
                  title: resource.title,
                  time: time.toFixed(2),
                }),
              );
            context.drawImage(frame.value.canvas, 0, 0);
          }
        }
        drawTimelineText(context, timeline, frameIndex, fonts!);
      },
      ...(sounds.length
        ? {
            audio: async (start: number, end: number) => {
              signal.throwIfAborted();
              // Render only one second at a time, irrespective of the whole composition length.
              const mixer = new OfflineAudioContext(
                2,
                Math.round((end - start) * 48000),
                48000,
              );
              for (const { segment, sink } of sounds) {
                const { clip } = segment;
                const left = Math.max(start, segment.start),
                  right = Math.min(end, segment.end);
                if (left >= right) continue;
                const sourceLeft =
                  clip.inPoint + (left - segment.start) * clip.speed;
                const sourceRight =
                  clip.inPoint + (right - segment.start) * clip.speed;
                for await (const wrapped of sink.buffers(
                  sourceLeft,
                  sourceRight,
                )) {
                  signal.throwIfAborted();
                  const from = Math.max(sourceLeft, wrapped.timestamp);
                  const to = Math.min(
                    sourceRight,
                    wrapped.timestamp + wrapped.buffer.duration,
                  );
                  if (to <= from) continue;
                  const source = mixer.createBufferSource(),
                    gain = mixer.createGain();
                  source.buffer = wrapped.buffer;
                  source.playbackRate.value = clip.speed;
                  gain.gain.value = clip.volume;
                  source.connect(gain).connect(mixer.destination);
                  source.start(
                    Math.max(
                      0,
                      segment.start +
                        (from - clip.inPoint) / clip.speed -
                        start,
                    ),
                    from - wrapped.timestamp,
                    to - from,
                  );
                }
              }
              const mixed = await mixer.startRendering();
              signal.throwIfAborted();
              return mixed;
            },
          }
        : {}),
    });
  } finally {
    fonts?.dispose();
    signal.removeEventListener("abort", disposeInputs);
    disposeInputs();
    images.forEach((image) => image.removeAttribute("src"));
    imageUrls.forEach((url) => URL.revokeObjectURL(url));
    canvas.width = canvas.height = 0;
  }
}
