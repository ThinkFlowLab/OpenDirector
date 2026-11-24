import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createCanvasToolTask, type CanvasToolTask } from "./toolCatalog";
import type { CanvasNode, CanvasNodeData } from "./model";
import { EditorModal } from "./EditorModal";
import { ControlSlider } from "./ControlSlider";
import { encodePcmWav } from "./localAudio.ts";
import { withMediaDuration } from "./editorMedia";
import {
  mediaBlobDataUrl,
  recordLocalVideoRange,
} from "./localMediaRuntime.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import "./local-media-tools.css";
import {
  centeredVideoCrop,
  fitVideoCrop,
  type VideoCrop,
} from "./videoCrop.ts";
import { AssetMedia } from "./useAssetMedia.tsx";
import { fetchMediaSource } from "../backend/creationClient.ts";
import { parseAssetSource } from "../backend/assetSource.ts";

export interface LocalMediaOutput {
  src: string;
  mimeType: string;
  title: string;
  kind: "image" | "video" | "audio";
  media?: CanvasNodeData["media"];
}
const localSource = (src: string) => {
  if (parseAssetSource(src)) return true;
  if (/^data:(audio|video|image)\//.test(src)) return true;
  try {
    const url = new URL(src, location.href);
    return (
      ["blob:", "http:", "https:"].includes(url.protocol) &&
      url.origin === location.origin
    );
  } catch {
    return false;
  }
};
const CROP_EDGE_LABEL = {
  x: "tools.localMedia.crop.edge.x",
  y: "tools.localMedia.crop.edge.y",
  width: "tools.localMedia.crop.edge.width",
  height: "tools.localMedia.crop.edge.height",
} as const;
const CROP_EDGE_ARIA = {
  x: "tools.localMedia.crop.edgeAria.x",
  y: "tools.localMedia.crop.edgeAria.y",
  width: "tools.localMedia.crop.edgeAria.width",
  height: "tools.localMedia.crop.edgeAria.height",
} as const;
const CROP_CORNER = {
  nw: "tools.localMedia.corner.nw",
  ne: "tools.localMedia.corner.ne",
  sw: "tools.localMedia.corner.sw",
  se: "tools.localMedia.corner.se",
} as const;

export function LocalMediaEditor({
  node,
  mode,
  onApply,
  onClose,
}: {
  node: CanvasNode;
  mode: "trim" | "frame" | "extract-audio" | "crop";
  onApply: (
    output: LocalMediaOutput,
    task: CanvasToolTask,
  ) => boolean | void | Promise<boolean | void>;
  onClose: () => void;
}) {
  const t = useT();
  const [duration, setDuration] = useState(
      node.data.media?.durationSeconds ?? 0,
    ),
    [start, setStart] = useState(0),
    [end, setEnd] = useState(node.data.media?.durationSeconds ?? 0),
    [position, setPosition] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [crop, setCrop] = useState<VideoCrop | null>(null);
  const [cropRatio, setCropRatio] = useState("free");
  const [probingDuration, setProbingDuration] = useState(false);
  const durationProbe = useRef<AbortController | null>(null);
  const probeAttempted = useRef(false);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const cropStage = useRef<HTMLDivElement>(null);
  const cropDrag = useRef<{
    x: number;
    y: number;
    rect: VideoCrop;
    handle: "move" | "nw" | "ne" | "sw" | "se";
  } | null>(null);
  const media = useRef<HTMLMediaElement | null>(null),
    active = useRef(true),
    abort = useRef<AbortController | null>(null),
    previewing = useRef(false);
  const isAudio = node.type === "audio" || mode === "extract-audio";
  useEffect(() => {
    active.current = true;
    const element = media.current;
    setBusy(false);
    setError("");
    setStart(0);
    setPosition(0);
    setProbingDuration(false);
    probeAttempted.current = false;
    setCrop(null);
    setCropRatio("free");
    setDimensions({ width: 0, height: 0 });
    setDuration(node.data.media?.durationSeconds ?? 0);
    setEnd(node.data.media?.durationSeconds ?? 0);
    return () => {
      active.current = false;
      abort.current?.abort();
      abort.current = null;
      durationProbe.current?.abort();
      durationProbe.current = null;
      previewing.current = false;
      element?.pause();
    };
  }, [node.id, node.data.src, mode]);
  const loaded = (element: HTMLMediaElement) => {
    const video = element as HTMLVideoElement;
    if (video.videoWidth && video.videoHeight) {
      setDimensions({ width: video.videoWidth, height: video.videoHeight });
      setCrop((current) =>
        current
          ? fitVideoCrop(current, video.videoWidth, video.videoHeight)
          : { x: 0, y: 0, width: video.videoWidth, height: video.videoHeight },
      );
    }
    const knownDuration =
      Number.isFinite(element.duration) && element.duration > 0
        ? element.duration
        : node.data.media?.durationSeconds;
    if (
      typeof knownDuration === "number" &&
      Number.isFinite(knownDuration) &&
      knownDuration > 0
    ) {
      setDuration(knownDuration);
      setEnd((previous) =>
        previous > 0 ? Math.min(previous, knownDuration) : knownDuration,
      );
      setError("");
    } else if (node.data.src && !probeAttempted.current) {
      probeAttempted.current = true;
      const controller = new AbortController();
      durationProbe.current = controller;
      setProbingDuration(true);
      setError("");
      void withMediaDuration(
        {
          id: node.id,
          kind: node.type === "audio" ? "audio" : "video",
          title: node.data.title,
          src: node.data.src,
          mimeType: node.data.mimeType,
        },
        controller.signal,
      )
        .then((resource) => {
          if (
            !active.current ||
            controller.signal.aborted ||
            durationProbe.current !== controller
          )
            return;
          const seconds = resource.durationSeconds!;
          setDuration(seconds);
          setEnd((previous) =>
            previous > 0 ? Math.min(previous, seconds) : seconds,
          );
          setError("");
        })
        .catch((error) => {
          if (
            active.current &&
            !controller.signal.aborted &&
            durationProbe.current === controller
          )
            setError(
              error instanceof Error
                ? error.message
                : t("tools.localMedia.error.duration"),
            );
        })
        .finally(() => {
          if (durationProbe.current === controller) {
            durationProbe.current = null;
            if (active.current) setProbingDuration(false);
          }
        });
    }
  };
  const valid = start >= 0 && end > start && end <= duration;
  const pointerPixels = (event: PointerEvent<HTMLElement>) => {
    const bounds = cropStage.current!.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) * dimensions.width) / bounds.width,
      y: ((event.clientY - bounds.top) * dimensions.height) / bounds.height,
    };
  };
  const startCropDrag = (
    event: PointerEvent<HTMLElement>,
    handle: "move" | "nw" | "ne" | "sw" | "se",
  ) => {
    if (busy || !crop || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    cropDrag.current = { ...pointerPixels(event), rect: crop, handle };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveCrop = (event: PointerEvent<HTMLElement>) => {
    const drag = cropDrag.current;
    if (!drag || busy) return;
    const point = pointerPixels(event),
      rect = drag.rect;
    if (drag.handle === "move") {
      setCrop(
        fitVideoCrop(
          {
            ...rect,
            x: rect.x + point.x - drag.x,
            y: rect.y + point.y - drag.y,
          },
          dimensions.width,
          dimensions.height,
        ),
      );
      return;
    }
    const anchorX = drag.handle.endsWith("w") ? rect.x + rect.width : rect.x;
    const anchorY = drag.handle.startsWith("n") ? rect.y + rect.height : rect.y;
    const dx = Math.max(0, Math.min(dimensions.width, point.x)) - anchorX;
    const dy = Math.max(0, Math.min(dimensions.height, point.y)) - anchorY;
    let width = Math.abs(dx),
      height = Math.abs(dy);
    if (cropRatio !== "free") {
      const ratio =
        cropRatio === "original"
          ? dimensions.width / dimensions.height
          : Number(cropRatio);
      width = Math.min(width, height * ratio);
      height = width / ratio;
    }
    setCrop(
      fitVideoCrop(
        {
          x: dx < 0 ? anchorX - width : anchorX,
          y: dy < 0 ? anchorY - height : anchorY,
          width,
          height,
        },
        dimensions.width,
        dimensions.height,
      ),
    );
  };
  const owns = (controller: AbortController) =>
    active.current &&
    abort.current === controller &&
    !controller.signal.aborted;
  const exported = useRef<
    { key: string; output: LocalMediaOutput } | undefined
  >(undefined);
  const apply = async () => {
    const element = media.current;
    if (!node.data.src || !element || busy || abort.current) return;
    if (!localSource(node.data.src)) {
      setError(t("tools.localMedia.error.notLocal"));
      return;
    }
    if (mode !== "frame" && !valid) {
      setError(t("tools.localMedia.error.range"));
      return;
    }
    if (mode === "crop" && !crop) {
      setError(t("tools.localMedia.error.dimensions"));
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError("");
    previewing.current = false;
    element.pause();
    const outputKey = JSON.stringify({
      src: node.data.src,
      mode,
      start,
      end,
      crop,
      position: mode === "frame" ? position : undefined,
    });
    const commit = async (output: LocalMediaOutput) => {
      exported.current = { key: outputKey, output };
      if (owns(controller)) {
        if (
          (await onApply(
            output,
            createCanvasToolTask(
              mode === "frame"
                ? "video-frame-capture"
                : mode === "crop"
                  ? "video-crop"
                  : mode === "extract-audio"
                    ? "extract-audio"
                    : isAudio
                      ? "audio-trim"
                      : "video-trim",
              [node.id],
              { start, end, frameTime: element.currentTime, ...(crop ?? {}) },
            ),
          )) === false
        )
          throw Error(t("tools.localMedia.error.notSaved"));
        onClose();
      }
    };
    try {
      if (exported.current?.key === outputKey) {
        await commit(exported.current.output);
        return;
      }
      if (mode === "frame") {
        const video = element as HTMLVideoElement;
        if (video.seeking || !video.videoWidth || video.readyState < 2)
          throw new Error(t("tools.localMedia.error.frameNotReady"));
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext("2d");
        if (!context) throw new Error(t("tools.localMedia.error.noCanvas"));
        context.drawImage(video, 0, 0);
        await commit({
          src: canvas.toDataURL("image/png"),
          mimeType: "image/png",
          kind: "image",
          title: `${node.data.title} · ${video.currentTime.toFixed(2)}s`,
          media: { width: video.videoWidth, height: video.videoHeight },
        });
        return;
      }
      if (isAudio) {
        const response = await fetchMediaSource(node.data.src, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(t("tools.localMedia.error.audioRead"));
        const source = await response.arrayBuffer();
        if (!owns(controller)) return;
        const context = new AudioContext();
        try {
          const decoded = await context.decodeAudioData(source);
          if (!owns(controller)) return;
          const channels = Array.from(
            { length: decoded.numberOfChannels },
            (_, index) => decoded.getChannelData(index),
          );
          const wav = encodePcmWav(channels, decoded.sampleRate, start, end);
          const src = await mediaBlobDataUrl(
            new Blob([wav], { type: "audio/wav" }),
            controller.signal,
          );
          await commit({
            src,
            mimeType: "audio/wav",
            kind: "audio",
            title: `${node.data.title} · ${start.toFixed(2)}–${end.toFixed(2)}s`,
            media: {
              durationSeconds:
                (wav.byteLength - 44) /
                (decoded.numberOfChannels * 2 * decoded.sampleRate),
            },
          });
        } finally {
          await context.close();
        }
        return;
      }
      const video = element as HTMLVideoElement;
      const blob = await recordLocalVideoRange(
        video,
        start,
        end,
        controller.signal,
        (seconds) => {
          if (owns(controller)) setPosition(seconds);
        },
        mode === "crop" ? { crop: crop! } : undefined,
      );
      const src = await mediaBlobDataUrl(blob, controller.signal);
      const measured = await withMediaDuration(
        {
          id: node.id,
          kind: "video",
          title: node.data.title,
          src,
          mimeType: "video/webm",
        },
        controller.signal,
      );
      await commit({
        src,
        mimeType: "video/webm",
        kind: "video",
        title: `${node.data.title} · ${
          mode === "crop"
            ? t("tools.localMedia.output.crop", {
                width: crop!.width,
                height: crop!.height,
              })
            : t("tools.localMedia.output.trim")
        }`,
        media: {
          width: measured.width,
          height: measured.height,
          durationSeconds: measured.durationSeconds,
        },
      });
    } catch (error) {
      if (owns(controller))
        setError(
          error instanceof Error
            ? error.message
            : t("tools.localMedia.error.process"),
        );
    } finally {
      if (abort.current === controller) {
        abort.current = null;
        element.pause();
        if (active.current) setBusy(false);
      }
    }
  };
  return (
    <EditorModal
      title={`${
        mode === "crop"
          ? t("tools.localMedia.title.crop")
          : mode === "frame"
            ? t("tools.localMedia.title.frame")
            : mode === "extract-audio"
              ? t("tools.localMedia.title.extractAudio")
              : isAudio
                ? t("tools.localMedia.title.audioTrim")
                : t("tools.localMedia.title.videoTrim")
      } · ${node.data.title}`}
      subtitle={
        mode === "crop"
          ? t("tools.localMedia.subtitle.crop")
          : mode === "frame"
            ? t("tools.localMedia.subtitle.frame")
            : isAudio
              ? t("tools.localMedia.subtitle.audio")
              : t("tools.localMedia.subtitle.video")
      }
      onClose={onClose}
      onApply={() => void apply()}
      applyLabel={
        busy
          ? t("tools.localMedia.apply.busy")
          : mode === "frame"
            ? t("tools.localMedia.apply.frame")
            : t("tools.localMedia.apply.default")
      }
      disabled={
        busy || probingDuration || !duration || (mode === "crop" && !crop)
      }
      error={error}
    >
      <div className="cw-local-video-preview">
        {node.type === "audio" ? (
          <AssetMedia
            as="audio"
            ref={(element: HTMLAudioElement | null) => {
              media.current = element;
            }}
            src={node.data.src}
            controls={!busy}
            onLoadedMetadata={(event) => loaded(event.currentTarget)}
            onDurationChange={(event) => loaded(event.currentTarget)}
            onError={() => setError(t("tools.localMedia.error.audioPlay"))}
            onTimeUpdate={(event) => {
              setPosition(event.currentTarget.currentTime);
              if (
                previewing.current &&
                event.currentTarget.currentTime >= end
              ) {
                event.currentTarget.pause();
                previewing.current = false;
              }
            }}
          />
        ) : (
          <div
            ref={cropStage}
            className={
              mode === "crop" ? "cw-video-crop-stage" : "cw-local-video-stage"
            }
            style={
              mode === "crop" && dimensions.width
                ? {
                    width: `min(100%, ${(54 * dimensions.width) / dimensions.height}vh)`,
                    aspectRatio: `${dimensions.width}/${dimensions.height}`,
                  }
                : undefined
            }
          >
            <AssetMedia
              as="video"
              ref={(element: HTMLVideoElement | null) => {
                media.current = element;
              }}
              src={node.data.src}
              controls={!busy && mode !== "crop"}
              playsInline
              onLoadedMetadata={(event) => loaded(event.currentTarget)}
              onDurationChange={(event) => loaded(event.currentTarget)}
              onError={() => setError(t("tools.localMedia.error.videoPlay"))}
              onTimeUpdate={(event) => {
                setPosition(event.currentTarget.currentTime);
                if (
                  previewing.current &&
                  event.currentTarget.currentTime >= end
                ) {
                  event.currentTarget.pause();
                  previewing.current = false;
                }
              }}
            />
            {mode === "crop" && crop && dimensions.width > 0 && (
              <div
                className={`cw-video-crop-box${busy ? " is-busy" : ""}`}
                style={{
                  left: `${(crop.x / dimensions.width) * 100}%`,
                  top: `${(crop.y / dimensions.height) * 100}%`,
                  width: `${(crop.width / dimensions.width) * 100}%`,
                  height: `${(crop.height / dimensions.height) * 100}%`,
                }}
                onPointerDown={(event) => startCropDrag(event, "move")}
                onPointerMove={moveCrop}
                onPointerUp={() => {
                  cropDrag.current = null;
                }}
                onPointerCancel={() => {
                  cropDrag.current = null;
                }}
              >
                <span>
                  {crop.width} × {crop.height}
                </span>
                {(["nw", "ne", "sw", "se"] as const).map((handle) => (
                  <button
                    key={handle}
                    className={`cw-crop-corner is-${handle}`}
                    aria-label={t("tools.localMedia.crop.cornerAria", {
                      corner: t(CROP_CORNER[handle]),
                    })}
                    disabled={busy}
                    onPointerDown={(event) => startCropDrag(event, handle)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {mode === "crop" && crop && (
        <div className="cw-local-media-controls cw-video-crop-controls">
          <label>
            {t("tools.localMedia.crop.aspect")}
            <select
              aria-label={t("tools.localMedia.crop.aspectAria")}
              value={cropRatio}
              disabled={busy}
              onChange={(event) => {
                const ratio = event.target.value;
                setCropRatio(ratio);
                if (ratio !== "free")
                  setCrop(
                    centeredVideoCrop(
                      dimensions.width,
                      dimensions.height,
                      ratio === "original"
                        ? dimensions.width / dimensions.height
                        : Number(ratio),
                    ),
                  );
              }}
            >
              <option value="free">{t("tools.localMedia.crop.free")}</option>
              <option value="original">
                {t("tools.localMedia.crop.original")}
              </option>
              <option value={String(16 / 9)}>16:9</option>
              <option value="1">1:1</option>
              <option value={String(9 / 16)}>9:16</option>
              <option value={String(4 / 3)}>4:3</option>
            </select>
          </label>
          {(["x", "y", "width", "height"] as const).map((key) => (
            <label key={key}>
              {t(CROP_EDGE_LABEL[key])}
              <input
                aria-label={t(CROP_EDGE_ARIA[key])}
                type="number"
                step="1"
                min={key === "x" || key === "y" ? 0 : 1}
                max={
                  key === "x" || key === "width"
                    ? dimensions.width
                    : dimensions.height
                }
                value={crop[key]}
                disabled={busy}
                onChange={(event) => {
                  const value = event.target.valueAsNumber;
                  if (!Number.isFinite(value)) return;
                  setCropRatio("free");
                  setCrop(
                    fitVideoCrop(
                      { ...crop, [key]: value },
                      dimensions.width,
                      dimensions.height,
                    ),
                  );
                }}
              />
            </label>
          ))}
          <button
            disabled={busy}
            onClick={() => {
              setCropRatio("free");
              setCrop({
                x: 0,
                y: 0,
                width: dimensions.width,
                height: dimensions.height,
              });
            }}
          >
            {t("tools.localMedia.crop.restore")}
          </button>
          <span>
            {t("tools.localMedia.crop.sourceSize", {
              width: dimensions.width,
              height: dimensions.height,
            })}
          </span>
        </div>
      )}
      <div className="cw-local-media-controls">
        {probingDuration && (
          <span role="status">{t("tools.localMedia.probe")}</span>
        )}
        <span>
          {t("tools.localMedia.position", {
            position: position.toFixed(2),
            duration: duration.toFixed(2),
          })}
        </span>
        {mode === "frame" ? (
          <>
            <ControlSlider
              aria-label={t("tools.localMedia.frame.positionAria")}
              min={0}
              max={Math.max(0, duration - 0.001)}
              step="0.01"
              value={position}
              disabled={busy || !duration}
              onChange={(event) => {
                const value = Number(event.target.value);
                setPosition(value);
                if (media.current) {
                  media.current.pause();
                  media.current.currentTime = value;
                }
              }}
            />
            <button
              disabled={!duration || busy}
              onClick={() => {
                if (media.current) {
                  media.current.pause();
                  media.current.currentTime = 0;
                  setPosition(0);
                }
              }}
            >
              {t("tools.localMedia.frame.first")}
            </button>
            <button
              disabled={!duration || busy}
              onClick={() => {
                if (media.current) {
                  const end = Math.max(0, duration - 1 / 30);
                  media.current.pause();
                  media.current.currentTime = end;
                  setPosition(end);
                }
              }}
            >
              {t("tools.localMedia.frame.last")}
            </button>
          </>
        ) : (
          <>
            <label>
              {t("tools.localMedia.range.start")}
              <input
                aria-label={t("tools.localMedia.range.startAria")}
                type="number"
                min="0"
                max={duration}
                step=".01"
                value={start}
                disabled={busy}
                onChange={(event) => {
                  const value = event.target.valueAsNumber;
                  if (Number.isFinite(value)) setStart(value);
                }}
              />
            </label>
            <label>
              {t("tools.localMedia.range.end")}
              <input
                aria-label={t("tools.localMedia.range.endAria")}
                type="number"
                min="0"
                max={duration}
                step=".01"
                value={end}
                disabled={busy}
                onChange={(event) => {
                  const value = event.target.valueAsNumber;
                  if (Number.isFinite(value)) setEnd(value);
                }}
              />
            </label>
            <button
              disabled={!valid || busy}
              onClick={() => {
                if (media.current) {
                  media.current.currentTime = start;
                  previewing.current = true;
                  void media.current
                    .play()
                    .catch((error) => setError(error.message));
                }
              }}
            >
              {t("tools.localMedia.range.preview")}
            </button>
            {busy && (
              <button onClick={() => abort.current?.abort()}>
                {t("tools.localMedia.cancelProcessing")}
              </button>
            )}
          </>
        )}
      </div>
    </EditorModal>
  );
}
