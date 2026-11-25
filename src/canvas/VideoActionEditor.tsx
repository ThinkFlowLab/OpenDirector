import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/I18nProvider.tsx";
import type { MessageKey } from "../i18n/types.ts";
import { translateTool } from "./toolText.ts";
import { CanvasIcon } from "./CanvasIcon";
import { ControlSlider } from "./ControlSlider";
import { TooltipButton } from "./TooltipButton";
import { SelectionToolbarMenu } from "./SelectionToolbarMenu";
import type { CanvasNode } from "./model";
import type { LinkedMediaResult } from "./linkedResults";
import {
  CANVAS_TOOLS,
  createCanvasToolTask,
  initialToolParameters,
  type CanvasToolId,
  type CanvasToolTask,
  type ToolParameters,
  type ToolValue,
} from "./toolCatalog";
import { centeredVideoCrop, fitVideoCrop, type VideoCrop } from "./videoCrop";
import { withMediaDuration } from "./editorMedia";
import {
  captureVideoFrame,
  exportVideoRange,
  extractVideoAudio,
  fitVideoTimeRange,
  initialVideoActionParameters,
  videoActionInputError,
  type VideoTimeRange,
} from "./videoActionRuntime";
import "./video-action-editor.css";
import { AssetMedia } from "./useAssetMedia.tsx";

export interface VideoActionEditorProps {
  node: CanvasNode;
  tool: CanvasToolId;
  draft?: CanvasToolTask;
  mediaContainer: HTMLElement | null;
  onDraftChange: (task: CanvasToolTask) => void;
  onImportResults: (task: CanvasToolTask) => void;
  onApply: (
    outputs: readonly LinkedMediaResult[],
    task: CanvasToolTask,
  ) => boolean | Promise<boolean>;
  onClose: () => void;
  onGenerate?: (task: CanvasToolTask) => void;
  /** Why the connected services cannot run this tool, from the tool catalog. */
  unavailableReason?: string;
  /** Canvas nodes offered as the second source of two-source tools. */
  nodes?: readonly CanvasNode[];
}

const LOCAL = new Set<CanvasToolId>([
  "video-trim",
  "video-crop",
  "video-frame-capture",
  "extract-audio",
]);
const CORNER_KEYS = {
  nw: "tools.videoEditor.corner.nw",
  ne: "tools.videoEditor.corner.ne",
  sw: "tools.videoEditor.corner.sw",
  se: "tools.videoEditor.corner.se",
} as const;
const timeLabel = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toFixed(2).padStart(5, "0")}`;
const finite = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const ratioNumber = (ratio: string, width: number, height: number) =>
  ratio === "original"
    ? width / height
    : ratio
        .split(":")
        .map(Number)
        .reduce((a, b) => a / b);

/** A source change creates a new editing session; draft updates never remount an active gesture. */
export function VideoActionEditor(props: VideoActionEditorProps) {
  const session = useMemo(
    () => crypto.randomUUID(),
    [props.node.id, props.node.data.src, props.tool],
  );
  return <VideoActionSession key={session} {...props} />;
}

function VideoActionSession({
  node,
  tool,
  draft,
  mediaContainer,
  onDraftChange,
  onImportResults,
  onApply,
  onClose,
  onGenerate,
  unavailableReason,
  nodes = [],
}: VideoActionEditorProps) {
  const { t, locale } = useI18n();
  const definition = translateTool(
    locale,
    CANVAS_TOOLS.find((item) => item.id === tool)!,
  );
  const saved =
    draft?.tool === tool &&
    draft.sourceNodeIds.length <= definition.maxSources &&
    draft.sourceNodeIds[0] === node.id
      ? draft
      : undefined;
  // Mask composite takes this video as content and a second video node as its mask.
  const needsMask = tool === "video-mask-composite";
  const maskCandidates = nodes.filter(
    (item) => item.id !== node.id && item.type === "video" && item.data.src,
  );
  const [maskSource, setMaskSource] = useState(
    needsMask &&
      maskCandidates.some((item) => item.id === saved?.sourceNodeIds[1])
      ? saved!.sourceNodeIds[1]!
      : "",
  );
  const maskSourceRef = useRef(maskSource);
  const initialParameters = {
    ...initialToolParameters(definition),
    ...initialVideoActionParameters(tool),
    ...saved?.parameters,
  };
  const [parameters, setParameters] =
    useState<ToolParameters>(initialParameters);
  const parametersRef = useRef(parameters);
  const promptDebounce = useRef(0);
  const [duration, setDuration] = useState(
    node.data.media?.durationSeconds ?? 0,
  );
  const [range, setRange] = useState<VideoTimeRange>(() => ({
    start: finite(
      tool === "video-partial-reshoot"
        ? Number(saved?.parameters.startMs) / 1000
        : saved?.parameters.startSeconds,
      0,
    ),
    end: finite(
      tool === "video-partial-reshoot"
        ? Number(saved?.parameters.endMs) / 1000
        : saved?.parameters.endSeconds,
      node.data.media?.durationSeconds ?? 0,
    ),
  }));
  const rangeRef = useRef(range);
  const [position, setPosition] = useState(
    finite(saved?.parameters.positionSeconds, 0),
  );
  const positionRef = useRef(position);
  const [dimensions, setDimensions] = useState({
    width: node.data.media?.width ?? 0,
    height: node.data.media?.height ?? 0,
  });
  const [crop, setCrop] = useState<VideoCrop | null>(
    saved?.selection?.boxes?.[0] ?? null,
  );
  const cropRef = useRef(crop);
  // Region tools reuse the crop box: it marks what the service redraws.
  const regionTool =
    tool === "video-crop" ||
    tool === "video-edit" ||
    tool === "video-subtitle-erasure";
  const [cropRatio, setCropRatio] = useState(
    String(saved?.parameters.aspectRatio ?? "free"),
  );
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [moreAnchor, setMoreAnchor] = useState<HTMLButtonElement | null>(null);
  const moreId = useId();
  const [frames, setFrames] = useState<
    { id: string; seconds: number; output: LinkedMediaResult }[]
  >([]);
  const framesRef = useRef(frames);
  const [displayRect, setDisplayRect] = useState({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });
  const video = useRef<HTMLVideoElement | null>(null);
  const bindVideo = useCallback((element: HTMLVideoElement | null) => {
    if (!element) video.current?.pause();
    video.current = element;
  }, []);
  const cropSurface = useRef<HTMLDivElement | null>(null);
  const track = useRef<HTMLDivElement | null>(null);
  const controller = useRef<AbortController | null>(null);
  const probe = useRef<AbortController | null>(null);
  const probed = useRef(false);
  const active = useRef(true);
  const previewRange = useRef(false);
  const timelineDrag = useRef<{
    kind: "start" | "end" | "move" | "playhead";
    x: number;
    initial: VideoTimeRange;
    position: number;
  } | null>(null);
  const cropDrag = useRef<{
    kind: "move" | "nw" | "ne" | "sw" | "se";
    x: number;
    y: number;
    initial: VideoCrop;
  } | null>(null);
  const local = LOCAL.has(tool);
  const selectingRange = [
    "video-trim",
    "video-partial-reshoot",
    "extract-audio",
  ].includes(tool);
  const selectedDuration = Math.max(0, range.end - range.start);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
      probe.current?.abort();
      video.current?.pause();
    };
  }, []);

  useEffect(() => {
    for (const other of mediaContainer?.querySelectorAll("video") ?? [])
      if (other !== video.current) other.pause();
  }, [mediaContainer]);

  useEffect(() => {
    if (!mediaContainer) return;
    const measure = () => {
      const w = mediaContainer.clientWidth,
        h = mediaContainer.clientHeight;
      if (w <= 0 || h <= 0) {
        setDisplayRect({ x: 0, y: 0, width: 0, height: 0 });
        return;
      }
      const aspect =
        dimensions.width && dimensions.height
          ? dimensions.width / dimensions.height
          : w / Math.max(h, 1);
      const width = Math.min(w, h * aspect),
        height = width / aspect;
      setDisplayRect({
        x: (w - width) / 2,
        y: (h - height) / 2,
        width,
        height,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(mediaContainer);
    return () => observer.disconnect();
  }, [mediaContainer, dimensions.width, dimensions.height]);

  const setCurrentPosition = (value: number) => {
    positionRef.current = value;
    setPosition(value);
  };
  const setCurrentRange = (value: VideoTimeRange) => {
    rangeRef.current = value;
    setRange(value);
  };
  const setCurrentCrop = (value: VideoCrop) => {
    cropRef.current = value;
    setCrop(value);
  };
  const task = (updates: ToolParameters = {}) => {
    const values: ToolParameters = { ...parametersRef.current, ...updates };
    if (selectingRange) {
      if (tool === "video-partial-reshoot")
        Object.assign(values, {
          startMs: Math.round(rangeRef.current.start * 1000),
          endMs: Math.round(rangeRef.current.end * 1000),
        });
      else
        Object.assign(values, {
          startSeconds: rangeRef.current.start,
          endSeconds: rangeRef.current.end,
        });
    }
    if (tool === "video-frame-capture")
      values.positionSeconds = positionRef.current;
    if (tool === "video-crop") values.aspectRatio = cropRatio;
    return createCanvasToolTask(
      tool,
      needsMask && maskSourceRef.current
        ? [node.id, maskSourceRef.current]
        : [node.id],
      values,
      regionTool &&
        cropRef.current &&
        dimensions.width > 0 &&
        dimensions.height > 0
        ? {
            sourceNodeId: node.id,
            width: dimensions.width,
            height: dimensions.height,
            boxes: [{ ...cropRef.current }],
          }
        : undefined,
    );
  };
  const changeParameter = (key: string, value: ToolValue) => {
    parametersRef.current = { ...parametersRef.current, [key]: value };
    setParameters(parametersRef.current);
    setNotice("");
    // Text parameters debounce like ImageActionEditor so typing does not
    // create one undo entry per keystroke.
    if (key === "prompt") {
      window.clearTimeout(promptDebounce.current);
      promptDebounce.current = window.setTimeout(() => {
        try {
          onDraftChange(task());
        } catch {
          // Ignore transient draft errors while typing; submit re-validates.
        }
      }, 250);
    } else onDraftChange(task());
  };
  const seek = (value: number) => {
    if (!video.current || busy || !duration) return;
    previewRange.current = false;
    video.current.pause();
    const next = Math.max(0, Math.min(Math.max(0, duration - 0.001), value));
    setCurrentPosition(next);
    video.current.currentTime = next;
  };
  const applyDuration = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    setDuration(seconds);
    setCurrentRange(
      fitVideoTimeRange(
        {
          ...rangeRef.current,
          end: rangeRef.current.end > 0 ? rangeRef.current.end : seconds,
        },
        seconds,
      ),
    );
    if (positionRef.current > 0 && video.current) {
      const next = Math.min(positionRef.current, Math.max(0, seconds - 0.001));
      if (Math.abs(video.current.currentTime - next) > 0.01)
        video.current.currentTime = next;
      setCurrentPosition(next);
    }
  };
  const loaded = (element: HTMLVideoElement) => {
    if (element.videoWidth && element.videoHeight) {
      setDimensions({ width: element.videoWidth, height: element.videoHeight });
      setCurrentCrop(
        cropRef.current
          ? fitVideoCrop(
              cropRef.current,
              element.videoWidth,
              element.videoHeight,
            )
          : defaultRegion(tool, element.videoWidth, element.videoHeight),
      );
    }
    if (Number.isFinite(element.duration) && element.duration > 0)
      applyDuration(element.duration);
    else if (duration > 0) applyDuration(duration);
    else if (!probed.current && node.data.src) {
      probed.current = true;
      const pending = new AbortController();
      probe.current = pending;
      setProbing(true);
      void withMediaDuration(
        {
          id: node.id,
          kind: "video",
          title: node.data.title,
          src: node.data.src,
          mimeType: node.data.mimeType,
        },
        pending.signal,
      )
        .then((resource) => {
          if (active.current && !pending.signal.aborted)
            applyDuration(resource.durationSeconds!);
        })
        .catch((reason) => {
          if (active.current && !pending.signal.aborted)
            setError(
              reason instanceof Error
                ? reason.message
                : t("tools.videoEditor.error.duration"),
            );
        })
        .finally(() => {
          if (active.current && probe.current === pending) {
            probe.current = null;
            setProbing(false);
          }
        });
    }
  };
  const togglePlayback = async () => {
    const element = video.current;
    if (!element || busy) return;
    try {
      if (!element.paused) {
        element.pause();
        previewRange.current = false;
        return;
      }
      if (
        selectingRange &&
        (element.currentTime < range.start ||
          element.currentTime >= range.end - 0.01)
      )
        element.currentTime = range.start;
      else if (element.currentTime >= duration - 0.01) element.currentTime = 0;
      previewRange.current = selectingRange;
      await element.play();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t("tools.videoEditor.error.play"),
      );
    }
  };

  const beginTimeline = (
    event: PointerEvent<HTMLElement>,
    kind: "start" | "end" | "move" | "playhead",
  ) => {
    if (busy || !duration || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    timelineDrag.current = {
      kind,
      x: event.clientX,
      initial: { ...rangeRef.current },
      position: positionRef.current,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (kind === "playhead" && track.current) {
      const bounds = track.current.getBoundingClientRect();
      seek(((event.clientX - bounds.left) / bounds.width) * duration);
    }
  };
  const moveTimeline = (event: PointerEvent<HTMLDivElement>) => {
    const drag = timelineDrag.current;
    if (!drag || !track.current || busy) return;
    const bounds = track.current.getBoundingClientRect();
    const delta =
      ((event.clientX - drag.x) / Math.max(1, bounds.width)) * duration;
    const gap = Math.min(0.01, duration);
    if (drag.kind === "playhead") {
      seek(((event.clientX - bounds.left) / bounds.width) * duration);
      return;
    }
    let next = { ...drag.initial };
    if (drag.kind === "start")
      next.start = Math.max(0, Math.min(next.end - gap, next.start + delta));
    else if (drag.kind === "end")
      next.end = Math.min(
        duration,
        Math.max(next.start + gap, next.end + delta),
      );
    else {
      const shift = Math.max(-next.start, Math.min(duration - next.end, delta));
      next = { start: next.start + shift, end: next.end + shift };
    }
    setCurrentRange(next);
    seek(drag.kind === "end" ? next.end : next.start);
  };
  const endTimeline = (cancelled = false) => {
    const drag = timelineDrag.current;
    timelineDrag.current = null;
    if (!drag) return;
    if (cancelled) {
      setCurrentRange(drag.initial);
      seek(drag.position);
    } else onDraftChange(task());
  };
  const nudgeRange = (kind: "start" | "end", direction: number) => {
    const current = rangeRef.current;
    const value = current[kind] + direction * 0.1;
    const next = fitVideoTimeRange(
      {
        ...current,
        [kind]: kind === "start" ? Math.min(current.end - 0.01, value) : value,
      },
      duration,
    );
    setCurrentRange(next);
    seek(next[kind]);
    onDraftChange(task());
  };

  const cropPoint = (event: PointerEvent<HTMLElement>) => {
    const bounds = cropSurface.current!.getBoundingClientRect();
    return {
      x:
        ((event.clientX - bounds.left) / Math.max(1, bounds.width)) *
        dimensions.width,
      y:
        ((event.clientY - bounds.top) / Math.max(1, bounds.height)) *
        dimensions.height,
    };
  };
  const beginCrop = (
    event: PointerEvent<HTMLElement>,
    kind: "move" | "nw" | "ne" | "sw" | "se",
  ) => {
    if (!cropRef.current || !cropSurface.current || busy || event.button !== 0)
      return;
    event.preventDefault();
    event.stopPropagation();
    cropDrag.current = {
      ...cropPoint(event),
      initial: { ...cropRef.current },
      kind,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveCrop = (event: PointerEvent<HTMLElement>) => {
    const drag = cropDrag.current;
    if (!drag || !cropSurface.current || busy) return;
    const point = cropPoint(event),
      rect = drag.initial;
    if (drag.kind === "move") {
      setCurrentCrop(
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
    const anchorX = drag.kind.endsWith("w") ? rect.x + rect.width : rect.x;
    const anchorY = drag.kind.startsWith("n") ? rect.y + rect.height : rect.y;
    const dx = Math.max(0, Math.min(dimensions.width, point.x)) - anchorX;
    const dy = Math.max(0, Math.min(dimensions.height, point.y)) - anchorY;
    let width = Math.abs(dx),
      height = Math.abs(dy);
    if (cropRatio !== "free") {
      const ratio = ratioNumber(cropRatio, dimensions.width, dimensions.height);
      width = Math.min(width, height * ratio);
      height = width / ratio;
    }
    setCurrentCrop(
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
  const endCrop = (cancelled = false) => {
    const drag = cropDrag.current;
    cropDrag.current = null;
    if (!drag) return;
    if (cancelled) setCurrentCrop(drag.initial);
    else onDraftChange(task());
  };
  const changeCropRatio = (value: string) => {
    setCropRatio(value);
    parametersRef.current = { ...parametersRef.current, aspectRatio: value };
    setParameters(parametersRef.current);
    if (value !== "free" && dimensions.width && dimensions.height)
      setCurrentCrop(
        centeredVideoCrop(
          dimensions.width,
          dimensions.height,
          ratioNumber(value, dimensions.width, dimensions.height),
        ),
      );
    const next = task({ aspectRatio: value });
    next.parameters.aspectRatio = value;
    onDraftChange(next);
  };
  const capture = () => {
    if (!video.current || busy || framesRef.current.length >= 20) return;
    try {
      video.current.pause();
      const output = captureVideoFrame(video.current, node.data.title);
      const next = [
        ...framesRef.current,
        { id: crypto.randomUUID(), seconds: video.current.currentTime, output },
      ];
      framesRef.current = next;
      setFrames(next);
      setError("");
      onDraftChange(task());
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t("tools.videoEditor.error.capture"),
      );
    }
  };
  const exported = useRef<
    { key: string; output: LinkedMediaResult } | undefined
  >(undefined);
  const localApply = async () => {
    if (busy || controller.current || !node.data.src || !video.current) return;
    if (tool === "video-frame-capture") {
      setBusy(true);
      try {
        if (
          framesRef.current.length &&
          (await onApply(
            framesRef.current.map((frame) => frame.output),
            task({
              capturedFrames: JSON.stringify(
                framesRef.current.map((frame) => frame.seconds),
              ),
            }),
          ))
        )
          onClose();
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : t("tools.videoEditor.error.framesNotSaved"),
        );
      } finally {
        setBusy(false);
      }
      return;
    }
    const invalid = videoActionInputError(
      tool,
      parametersRef.current,
      duration,
      rangeRef.current,
    );
    if (invalid) {
      setError(invalid);
      return;
    }
    if (tool === "video-crop" && !cropRef.current) {
      setError(t("tools.videoEditor.error.dimensions"));
      return;
    }
    const operation = new AbortController();
    controller.current = operation;
    setBusy(true);
    setError("");
    previewRange.current = false;
    video.current.pause();
    onDraftChange(task());
    try {
      const frozenTask = task();
      const outputKey = JSON.stringify({
        tool,
        parameters: frozenTask.parameters,
        selection: frozenTask.selection,
      });
      const output =
        exported.current?.key === outputKey
          ? exported.current.output
          : tool === "extract-audio"
            ? await extractVideoAudio(
                node.data.src,
                node.data.title,
                rangeRef.current,
                operation.signal,
              )
            : await exportVideoRange(
                video.current,
                node.data.title,
                tool === "video-crop"
                  ? { start: 0, end: duration }
                  : rangeRef.current,
                operation.signal,
                (seconds) => {
                  if (active.current && !operation.signal.aborted)
                    setCurrentPosition(seconds);
                },
                tool === "video-crop" ? cropRef.current! : undefined,
              );
      exported.current = { key: outputKey, output };
      if (
        active.current &&
        !operation.signal.aborted &&
        (await onApply([output], frozenTask))
      )
        onClose();
    } catch (reason) {
      if (active.current && !operation.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : t("tools.videoEditor.error.process"),
        );
    } finally {
      if (controller.current === operation) {
        controller.current = null;
        video.current?.pause();
        if (active.current) setBusy(false);
      }
    }
  };
  const close = () => {
    controller.current?.abort();
    probe.current?.abort();
    video.current?.pause();
    onClose();
  };
  const inputError =
    videoActionInputError(tool, parameters, duration, range) ??
    (needsMask && !maskSource ? t("errors.videoAction.maskSource") : undefined);
  const choices = (
    label: string,
    field: string,
    values: readonly [ToolValue, string][],
  ) => (
    <label className="cw-va-setting">
      <span>{label}</span>
      <select
        aria-label={label}
        value={String(parameters[field] ?? "")}
        onChange={(event) => {
          const selected = values.find(
            ([value]) => String(value) === event.target.value,
          );
          if (selected) changeParameter(field, selected[0]);
        }}
      >
        {values.map(([value, label]) => (
          <option key={String(value)} value={String(value)}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
  const promptField: {
    key: string;
    label: MessageKey;
    placeholder: MessageKey;
  } | null =
    tool === "video-edit"
      ? {
          key: "prompt",
          label: "tools.videoEditor.prompt.editLabel",
          placeholder: "tools.videoEditor.prompt.editPlaceholder",
        }
      : tool === "video-partial-reshoot"
        ? {
            key: "prompt",
            label: "tools.videoEditor.prompt.reshootLabel",
            placeholder: "tools.videoEditor.prompt.reshootPlaceholder",
          }
        : tool === "video-matting"
          ? {
              key: "prompt",
              label: "tools.videoEditor.prompt.mattingLabel",
              placeholder: "tools.videoEditor.prompt.mattingPlaceholder",
            }
          : tool === "audio-separation" && parameters.mode === "description"
            ? {
                key: "description",
                label: "tools.videoEditor.prompt.soundLabel",
                placeholder: "tools.videoEditor.prompt.soundPlaceholder",
              }
            : null;
  const playback = (
    <AssetMedia
      as="video"
      ref={bindVideo}
      src={node.data.src}
      crossOrigin="anonymous"
      playsInline
      preload="auto"
      onLoadedMetadata={(event) => loaded(event.currentTarget)}
      onDurationChange={(event) => loaded(event.currentTarget)}
      onLoadedData={() => setReady(true)}
      onSeeking={() => setReady(false)}
      onSeeked={(event) => {
        setReady(true);
        setCurrentPosition(event.currentTarget.currentTime);
      }}
      onPlay={() => setPlaying(true)}
      onPause={() => setPlaying(false)}
      onEnded={() => setPlaying(false)}
      onTimeUpdate={(event) => {
        const element = event.currentTarget;
        setCurrentPosition(element.currentTime);
        if (
          previewRange.current &&
          element.currentTime >= rangeRef.current.end
        ) {
          element.pause();
          previewRange.current = false;
        }
      }}
      onError={() => setError(t("tools.videoEditor.error.read"))}
    />
  );
  const overlay = (
    <div
      className="cw-video-action-overlay nodrag nopan nowheel"
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {playback}
      {regionTool && crop && displayRect.width > 0 && dimensions.width > 0 && (
        <div
          ref={cropSurface}
          className="cw-va-crop-surface"
          style={{
            left: displayRect.x,
            top: displayRect.y,
            width: displayRect.width,
            height: displayRect.height,
          }}
        >
          <div
            className="cw-va-crop-box"
            style={{
              left: `${(crop.x / dimensions.width) * 100}%`,
              top: `${(crop.y / dimensions.height) * 100}%`,
              width: `${(crop.width / dimensions.width) * 100}%`,
              height: `${(crop.height / dimensions.height) * 100}%`,
            }}
            onPointerDown={(event) => beginCrop(event, "move")}
            onPointerMove={moveCrop}
            onPointerUp={() => endCrop()}
            onPointerCancel={() => endCrop(true)}
          >
            <span>
              {crop.width} × {crop.height}
            </span>
            {(["nw", "ne", "sw", "se"] as const).map((corner) => (
              <button
                key={corner}
                type="button"
                aria-label={t("tools.videoEditor.crop.cornerAria", {
                  corner: t(CORNER_KEYS[corner]),
                })}
                className={`cw-va-crop-corner is-${corner}`}
                disabled={busy}
                onPointerDown={(event) => beginCrop(event, corner)}
              />
            ))}
          </div>
        </div>
      )}
      {!regionTool && (
        <button
          className="cw-va-source-play"
          aria-label={
            playing
              ? t("tools.videoEditor.sourcePause")
              : t("tools.videoEditor.sourcePlay")
          }
          disabled={busy || !duration}
          onClick={() => void togglePlayback()}
        >
          {playing ? "Ⅱ" : "▶"}
        </button>
      )}
      <span className="cw-va-source-time">
        {timeLabel(position)} / {timeLabel(duration)}
      </span>
    </div>
  );

  return (
    <section
      className="cw-video-action-editor nodrag nopan nowheel"
      aria-label={t("tools.videoEditor.panelAria", {
        title: definition.title,
      })}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
    >
      {mediaContainer ? (
        createPortal(overlay, mediaContainer)
      ) : (
        <div className="cw-va-detached-video" aria-hidden="true">
          {playback}
        </div>
      )}
      <header>
        <div>
          <strong>{definition.title}</strong>
          <span>{node.data.title}</span>
        </div>
        <TooltipButton
          className="cw-va-icon-button"
          label={t("tools.videoEditor.close", { title: definition.title })}
          onClick={close}
        >
          <CanvasIcon name="close" size={16} />
        </TooltipButton>
      </header>
      <div className="cw-va-body">
        {promptField && (
          <label className="cw-va-prompt">
            <span>{t(promptField.label)}</span>
            <textarea
              rows={4}
              value={String(parameters[promptField.key] ?? "")}
              placeholder={t(promptField.placeholder)}
              onChange={(event) =>
                changeParameter(promptField.key, event.target.value)
              }
            />
          </label>
        )}
        <div className="cw-va-transport">
          <TooltipButton
            className="cw-va-icon-button"
            label={
              playing
                ? t("tools.videoEditor.transport.pause")
                : selectingRange
                  ? t("tools.videoEditor.transport.previewRange")
                  : t("tools.videoEditor.transport.play")
            }
            disabled={busy || !duration}
            onClick={() => void togglePlayback()}
          >
            {playing ? "Ⅱ" : "▶"}
          </TooltipButton>
          <span>{timeLabel(position)}</span>
          <ControlSlider
            aria-label={t("tools.videoEditor.transport.positionAria")}
            min={0}
            max={Math.max(0, duration - 0.001)}
            step="0.01"
            value={position}
            disabled={busy || !duration}
            onChange={(event) => seek(Number(event.target.value))}
            onPointerUp={() => onDraftChange(task())}
            onKeyUp={() => onDraftChange(task())}
          />
          <span>{timeLabel(duration)}</span>
        </div>
        {selectingRange && (
          <>
            <div
              ref={track}
              className="cw-va-time-range"
              aria-label={t("tools.videoEditor.range.trackAria")}
              onPointerDown={(event) => beginTimeline(event, "playhead")}
              onPointerMove={moveTimeline}
              onPointerUp={() => endTimeline()}
              onPointerCancel={() => endTimeline(true)}
            >
              <div
                className="cw-va-range-fill"
                style={{
                  left: `${duration ? (range.start / duration) * 100 : 0}%`,
                  width: `${duration ? (selectedDuration / duration) * 100 : 100}%`,
                }}
                onPointerDown={(event) => beginTimeline(event, "move")}
              >
                <span>
                  {t("tools.videoEditor.range.duration", {
                    seconds: selectedDuration.toFixed(2),
                  })}
                </span>
                {(["start", "end"] as const).map((edge) => (
                  <button
                    key={edge}
                    type="button"
                    role="slider"
                    aria-label={
                      edge === "start"
                        ? t("tools.videoEditor.range.startAria")
                        : t("tools.videoEditor.range.endAria")
                    }
                    aria-valuemin={0}
                    aria-valuemax={duration}
                    aria-valuenow={range[edge]}
                    aria-valuetext={timeLabel(range[edge])}
                    disabled={busy || !duration}
                    className={`cw-va-range-handle is-${edge}`}
                    onPointerDown={(event) => beginTimeline(event, edge)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "ArrowLeft" ||
                        event.key === "ArrowRight"
                      ) {
                        event.preventDefault();
                        event.stopPropagation();
                        nudgeRange(edge, event.key === "ArrowLeft" ? -1 : 1);
                      }
                    }}
                  />
                ))}
              </div>
              <i
                className="cw-va-range-playhead"
                style={{
                  left: `${duration ? (position / duration) * 100 : 0}%`,
                }}
              />
            </div>
            <div className="cw-va-range-values">
              {(["start", "end"] as const).map((edge) => (
                <label key={edge}>
                  {edge === "start"
                    ? t("tools.videoEditor.range.start")
                    : t("tools.videoEditor.range.end")}
                  <input
                    aria-label={
                      edge === "start"
                        ? t("tools.videoEditor.range.startInputAria")
                        : t("tools.videoEditor.range.endInputAria")
                    }
                    type="number"
                    min="0"
                    max={duration}
                    step="0.01"
                    value={Number(range[edge].toFixed(2))}
                    disabled={busy || !duration}
                    onChange={(event) => {
                      const value = event.target.valueAsNumber;
                      if (!Number.isFinite(value)) return;
                      setCurrentRange(
                        fitVideoTimeRange(
                          {
                            ...rangeRef.current,
                            [edge]:
                              edge === "start"
                                ? Math.min(rangeRef.current.end - 0.01, value)
                                : value,
                          },
                          duration,
                        ),
                      );
                      seek(rangeRef.current[edge]);
                      onDraftChange(task());
                    }}
                  />
                  <span>s</span>
                </label>
              ))}
              <button
                type="button"
                disabled={busy || !duration}
                onClick={() => {
                  setCurrentRange({ start: 0, end: duration });
                  onDraftChange(task());
                }}
              >
                {t("tools.videoEditor.range.selectAll")}
              </button>
            </div>
          </>
        )}
        {tool === "video-frame-capture" && (
          <>
            <div className="cw-va-frame-actions">
              <button
                type="button"
                disabled={busy || !duration}
                onClick={() => {
                  seek(0);
                  onDraftChange(task());
                }}
              >
                {t("tools.videoEditor.frame.first")}
              </button>
              <button
                type="button"
                disabled={busy || !duration}
                onClick={() => {
                  seek(duration - 0.001);
                  onDraftChange(task());
                }}
              >
                {t("tools.videoEditor.frame.last")}
              </button>
              <button
                type="button"
                className="cw-va-primary"
                disabled={busy || !ready || frames.length >= 20}
                onClick={capture}
              >
                {t("tools.videoEditor.frame.capture")}
              </button>
              <span>{frames.length} / 20</span>
            </div>
            {frames.length ? (
              <div
                className="cw-va-frame-tray"
                aria-label={t("tools.videoEditor.frame.trayAria")}
              >
                {frames.map((frame) => (
                  <div key={frame.id}>
                    <button
                      type="button"
                      className="cw-va-frame-preview"
                      aria-label={t("tools.videoEditor.frame.seekAria", {
                        seconds: frame.seconds.toFixed(2),
                      })}
                      onClick={() => seek(frame.seconds)}
                    >
                      <img
                        src={frame.output.src}
                        alt={t("tools.videoEditor.frame.alt", {
                          seconds: frame.seconds.toFixed(2),
                        })}
                      />
                      <span>{frame.seconds.toFixed(2)}s</span>
                    </button>
                    <button
                      type="button"
                      className="cw-va-frame-remove"
                      aria-label={t("tools.videoEditor.frame.removeAria", {
                        seconds: frame.seconds.toFixed(2),
                      })}
                      onClick={() => {
                        const next = framesRef.current.filter(
                          (item) => item.id !== frame.id,
                        );
                        framesRef.current = next;
                        setFrames(next);
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="cw-va-hint">{t("tools.videoEditor.frame.hint")}</p>
            )}
          </>
        )}
        {tool === "video-crop" && (
          <>
            <div className="cw-va-crop-settings">
              <label>
                {t("tools.videoEditor.crop.aspect")}
                <select
                  aria-label={t("tools.videoEditor.crop.aspectAria")}
                  value={cropRatio}
                  disabled={busy}
                  onChange={(event) => changeCropRatio(event.target.value)}
                >
                  {[
                    "free",
                    "original",
                    "16:9",
                    "9:16",
                    "1:1",
                    "4:3",
                    "3:4",
                    "21:9",
                  ].map((ratio) => (
                    <option key={ratio} value={ratio}>
                      {ratio === "free"
                        ? t("tools.videoEditor.crop.free")
                        : ratio === "original"
                          ? t("tools.videoEditor.crop.original")
                          : ratio}
                    </option>
                  ))}
                </select>
              </label>
              <span>
                {crop
                  ? `${crop.width} × ${crop.height} px`
                  : t("tools.videoEditor.crop.reading")}
              </span>
              <button
                type="button"
                disabled={busy || !dimensions.width}
                onClick={() => {
                  setCurrentCrop({
                    x: 0,
                    y: 0,
                    width: dimensions.width,
                    height: dimensions.height,
                  });
                  changeCropRatio("free");
                }}
              >
                {t("tools.videoEditor.crop.reset")}
              </button>
            </div>
            <p className="cw-va-hint">{t("tools.videoEditor.crop.hint")}</p>
          </>
        )}
        {(tool === "video-edit" || tool === "video-subtitle-erasure") && (
          <p className="cw-va-hint">
            {tool === "video-edit"
              ? t("tools.videoEditor.edit.hint")
              : t("tools.videoEditor.subtitle.hint")}
          </p>
        )}
        {tool === "video-upscale" &&
          choices(t("tools.videoEditor.upscale.resolution"), "resolution", [
            ["2K", "2K"],
            ["4K", "4K"],
          ])}
        {tool === "video-depth-capture" &&
          choices(t("tools.videoEditor.depth.resolution"), "resolution", [
            ["480P", "480P"],
            ["720P", "720P"],
          ])}
        {tool === "video-frame-interpolation" &&
          choices(t("tools.videoEditor.interpolation.fps"), "fps", [
            [30, "30 FPS"],
            [60, "60 FPS"],
          ])}
        {tool === "video-matting" &&
          choices(t("tools.videoEditor.matting.background"), "background", [
            ["black", t("tools.videoEditor.matting.black")],
            ["green", t("tools.videoEditor.matting.green")],
            ["transparent", t("tools.videoEditor.matting.transparent")],
            ["mask", t("tools.videoEditor.matting.mask")],
          ])}
        {needsMask && (
          <label className="cw-va-setting">
            <span>{t("tools.videoEditor.composite.mask")}</span>
            <select
              aria-label={t("tools.videoEditor.composite.mask")}
              value={maskSource}
              onChange={(event) => {
                maskSourceRef.current = event.target.value;
                setMaskSource(event.target.value);
                setNotice("");
                onDraftChange(task());
              }}
            >
              <option value="">
                {t("tools.videoEditor.composite.chooseMask")}
              </option>
              {maskCandidates.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.data.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {needsMask &&
          choices(t("tools.videoEditor.composite.stretch"), "stretch", [
            [true, t("tools.videoEditor.composite.stretchOn")],
            [false, t("tools.videoEditor.composite.stretchOff")],
          ])}
        {needsMask && (
          <p className="cw-va-hint">{t("tools.videoEditor.composite.hint")}</p>
        )}
        {tool === "video-subtitle-erasure" && (
          <label className="cw-va-confirm">
            <input
              type="checkbox"
              checked={parameters.confirmed === true}
              onChange={(event) =>
                changeParameter("confirmed", event.target.checked)
              }
            />
            <span>{t("tools.videoEditor.subtitle.confirm")}</span>
          </label>
        )}
        {tool === "audio-separation" &&
          choices(t("tools.videoEditor.separation.mode"), "mode", [
            ["voice", t("tools.videoEditor.separation.voice")],
            ["backgroundSound", t("tools.videoEditor.separation.background")],
            ["soundEffects", t("tools.videoEditor.separation.effects")],
            ["all", t("tools.videoEditor.separation.all")],
            ["description", t("tools.videoEditor.separation.description")],
          ])}
        {tool === "extract-audio" && (
          <p className="cw-va-hint">{t("tools.videoEditor.extract.hint")}</p>
        )}
        {(tool === "video-trim" || tool === "video-crop") && (
          <p className="cw-va-hint">{t("tools.videoEditor.local.hint")}</p>
        )}
        {probing && (
          <p className="cw-va-hint" role="status">
            {t("tools.videoEditor.probing")}
          </p>
        )}
        {!local && !onGenerate && (
          <p className="cw-va-unavailable">
            {unavailableReason ?? t("tools.videoEditor.unavailableFallback")}
            {t("tools.videoEditor.unavailableHint")}
          </p>
        )}
        {inputError && !local && <p className="cw-va-hint">{inputError}</p>}
        {error && (
          <p className="cw-va-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="cw-va-hint" role="status">
            {notice}
          </p>
        )}
      </div>
      <footer>
        {busy ? (
          <>
            <span role="status">
              {t("tools.videoEditor.processing", {
                time: timeLabel(position),
              })}
            </span>
            <button type="button" onClick={() => controller.current?.abort()}>
              {t("tools.videoEditor.cancelProcessing")}
            </button>
          </>
        ) : local ? (
          <>
            <button type="button" onClick={close}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="cw-va-primary"
              disabled={
                !node.data.src ||
                probing ||
                (tool === "video-frame-capture"
                  ? !frames.length
                  : !duration ||
                    !!inputError ||
                    (tool === "video-crop" && !crop))
              }
              onClick={() => void localApply()}
            >
              {tool === "video-frame-capture"
                ? t("tools.videoEditor.addFrames", { count: frames.length })
                : tool === "extract-audio"
                  ? t("tools.videoEditor.extractToCanvas")
                  : t("tools.videoEditor.confirmToCanvas")}
            </button>
          </>
        ) : (
          <>
            <TooltipButton
              className="cw-va-icon-button cw-va-more"
              label={t("tools.videoEditor.more", {
                title: definition.title,
              })}
              aria-haspopup="menu"
              aria-expanded={Boolean(moreAnchor)}
              aria-controls={moreAnchor ? moreId : undefined}
              onClick={(event) =>
                setMoreAnchor(moreAnchor ? null : event.currentTarget)
              }
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  event.stopPropagation();
                  setMoreAnchor(event.currentTarget);
                }
              }}
            >
              <CanvasIcon name="more" size={16} />
            </TooltipButton>
            <button
              type="button"
              className="cw-va-primary"
              disabled={!onGenerate || !node.data.src || !!inputError}
              title={
                !onGenerate
                  ? t("tools.videoEditor.notConnectedTitle")
                  : inputError
              }
              onClick={() => {
                if (onGenerate && !inputError) {
                  const value = task();
                  onDraftChange(value);
                  onGenerate(value);
                }
              }}
            >
              {t("tools.videoEditor.generate")}
            </button>
          </>
        )}
      </footer>
      {moreAnchor && (
        <SelectionToolbarMenu
          anchor={moreAnchor}
          id={moreId}
          label={t("tools.videoEditor.more", {
            title: definition.title,
          })}
          onClose={() => setMoreAnchor(null)}
        >
          <button
            type="button"
            role="menuitem"
            className="cw-selection-menu-item"
            onClick={() => {
              onDraftChange(task());
              setNotice(t("tools.videoEditor.saved"));
              moreAnchor.focus({ preventScroll: true });
              setMoreAnchor(null);
            }}
          >
            {t("tools.videoEditor.save")}
          </button>
          <button
            type="button"
            role="menuitem"
            className="cw-selection-menu-item"
            onClick={() => {
              const value = task();
              onDraftChange(value);
              moreAnchor.focus({ preventScroll: true });
              setMoreAnchor(null);
              onImportResults(value);
            }}
          >
            {t("tools.videoEditor.import")}
          </button>
        </SelectionToolbarMenu>
      )}
    </section>
  );
}

/** Starting box per tool: the whole frame to crop, the centre to edit, the subtitle band to erase. */
function defaultRegion(tool: CanvasToolId, width: number, height: number) {
  if (tool === "video-edit")
    return {
      x: Math.round(width / 4),
      y: Math.round(height / 4),
      width: Math.round(width / 2),
      height: Math.round(height / 2),
    };
  if (tool === "video-subtitle-erasure") {
    const top = Math.round(height * 0.78);
    return { x: 0, y: top, width, height: height - top };
  }
  return { x: 0, y: 0, width, height };
}
