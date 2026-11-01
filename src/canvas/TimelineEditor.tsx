import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type CSSProperties,
} from "react";
import { ControlSlider } from "./ControlSlider";
import type {
  CanvasNode,
  CanvasResource,
  TimelineClip,
  TimelineData,
} from "./model";
import { copyTimeline, timelineError } from "./dataBoundary";
import {
  addAudioTrack,
  addTimelineClip,
  clipDuration,
  exportTimeline,
  moveTimelineClip,
  placeTimelineClip,
  removeTimelineClip,
  timelineDuration,
  timelineSegments,
  updateTimelineClip,
  splitTimelineClip,
  trimTimelineClip,
  importTimeline,
  removeTimelineAsset,
  snapTimelineTime,
  timelineRulerStep,
  timelineLibraryResources,
  type TimelineLibraryKind,
  type TimelineLibrarySource,
} from "./timeline";
import { assertUpload } from "./uploadPolicy.ts";
import {
  classifyImportFile,
  readEditorResource,
  withMediaDuration,
} from "./editorMedia";
import { EditorModal } from "./EditorModal";
import { CanvasIcon } from "./CanvasIcon";
import "./timeline-editor.css";
import { downloadFile, downloadFilename } from "./assets";
import { mediaBlobDataUrl } from "./localMediaRuntime";
import { exportTimelineFcpxml, exportTimelinePackage } from "./timelineExport";
import type { LinkedMediaResult } from "./linkedResults";

export interface TimelineEditorProps {
  node: CanvasNode;
  resources?: CanvasResource[];
  /** Returns false when the canvas rejected the edit, so the session stays open. */
  onApply: (data: TimelineData) => boolean | void;
  onRender: (result: LinkedMediaResult) => boolean;
  onClose: () => void;
}
const timeLabel = (time: number) =>
  `${Math.floor(time / 60)
    .toString()
    .padStart(2, "0")}:${(time % 60).toFixed(2).padStart(5, "0")}`;

interface ClipDrag {
  pointerId: number;
  clipId: string;
  origin: TimelineData;
  x: number;
  y: number;
  offset: number;
  duration: number;
  moved: boolean;
  next: TimelineData | null;
  error: string;
}

export function TimelineEditor({
  node,
  resources = [],
  onApply,
  onRender,
  onClose,
}: TimelineEditorProps) {
  const [timeline, setTimeline] = useState(() =>
    copyTimeline(
      node.data.timeline ?? {
        fps: 30,
        width: 1920,
        height: 1080,
        tracks: [
          {
            id: "visual",
            kind: "visual",
            title: "画面轨",
            muted: false,
            clips: [],
          },
        ],
      },
    ),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null),
    [position, setPosition] = useState(0),
    [playing, setPlaying] = useState(false);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [audioTrack, setAudioTrack] = useState("");
  const [inserted, setInserted] = useState(false);
  const [renderProgress, setRenderProgress] = useState<number | null>(null);
  const [rendered, setRendered] = useState<Blob | null>(null);
  const jsonInput = useRef<HTMLInputElement>(null),
    history = useRef<{ past: TimelineData[]; future: TimelineData[] }>({
      past: [],
      future: [],
    });
  const coalesce = useRef<string | null>(null);
  const [, refreshHistory] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null),
    media = useRef(new Map<string, HTMLMediaElement>()),
    active = useRef(true);
  const timelineRef = useRef(timeline),
    positionRef = useRef(position),
    clipDrag = useRef<ClipDrag | null>(null);
  const tracksRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(40);
  const [scrollLeft, setScrollLeft] = useState(0),
    [viewportWidth, setViewportWidth] = useState(900);
  const [snapping, setSnapping] = useState(true);
  const [libraryShown, setLibraryShown] = useState(true),
    [libraryWidth, setLibraryWidth] = useState(210),
    [trackHeight, setTrackHeight] = useState(260);
  const [packageProgress, setPackageProgress] = useState<number | null>(null);
  const panelDrag = useRef<{
    pointerId: number;
    axis: "library" | "tracks";
    origin: number;
    size: number;
    element: HTMLElement;
  } | null>(null);
  const resizePanel = (event: PointerEvent<HTMLElement>) => {
    const drag = panelDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta =
      (drag.axis === "library" ? event.clientX : event.clientY) - drag.origin;
    if (drag.axis === "library")
      setLibraryWidth(Math.max(150, Math.min(420, drag.size + delta)));
    else setTrackHeight(Math.max(140, Math.min(650, drag.size - delta)));
  };
  const finishPanel = (event: PointerEvent<HTMLElement>, cancel = false) => {
    const drag = panelDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    panelDrag.current = null;
    if (cancel) {
      if (drag.axis === "library") setLibraryWidth(drag.size);
      else setTrackHeight(drag.size);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const cancelPanel = () => {
    const drag = panelDrag.current;
    if (!drag) return;
    panelDrag.current = null;
    if (drag.axis === "library") setLibraryWidth(drag.size);
    else setTrackHeight(drag.size);
    if (drag.element.hasPointerCapture(drag.pointerId))
      drag.element.releasePointerCapture(drag.pointerId);
  };
  useEffect(() => {
    window.addEventListener("blur", cancelPanel);
    return () => window.removeEventListener("blur", cancelPanel);
  }, []);
  const beginPanel = (
    event: PointerEvent<HTMLElement>,
    axis: "library" | "tracks",
  ) => {
    if (event.button !== 0 || panelDrag.current || busy) return;
    event.preventDefault();
    panelDrag.current = {
      pointerId: event.pointerId,
      axis,
      origin: axis === "library" ? event.clientX : event.clientY,
      size: axis === "library" ? libraryWidth : trackHeight,
      element: event.currentTarget,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const [dragPreview, setDragPreview] = useState<TimelineData | null>(null);
  const [dragMessage, setDragMessage] = useState("");
  const callbacks = useRef(
      new Map<string, (element: HTMLMediaElement | null) => void>(),
    ),
    pendingPlay = useRef(new Set<HTMLMediaElement>()),
    loading = useRef<AbortController | null>(null),
    playingRef = useRef(playing);
  timelineRef.current = timeline;
  positionRef.current = position;
  playingRef.current = playing;
  const [libraryKind, setLibraryKind] = useState<TimelineLibraryKind>("all"),
    [librarySource, setLibrarySource] = useState<TimelineLibrarySource>("all");
  const libraryResources = useMemo(
    () =>
      timelineLibraryResources(timeline, resources, librarySource, libraryKind),
    [resources, timeline, libraryKind, librarySource],
  );
  const segments = useMemo(
    () => timelineSegments(dragPreview ?? timeline),
    [timeline, dragPreview],
  );
  const duration = timelineDuration(timeline);
  const trackWidth = Math.max(
    viewportWidth,
    191 + (duration + 2) * pixelsPerSecond,
  );
  const visibleDuration = (trackWidth - 191) / pixelsPerSecond;
  const rulerStep = timelineRulerStep(pixelsPerSecond, timeline.fps);
  const rulerStart = Math.max(
    0,
    Math.floor((scrollLeft - 147) / pixelsPerSecond / rulerStep) * rulerStep,
  );
  const rulerTicks = Array.from(
    { length: Math.ceil(viewportWidth / pixelsPerSecond / rulerStep) + 4 },
    (_, i) => rulerStart + i * rulerStep,
  ).filter((time) => time <= visibleDuration);
  const zoomTo = (next: number, anchor?: number) => {
    const element = scrollRef.current;
    if (!element) return;
    const value = Math.max(0.01, Math.min(800, next));
    const x = anchor ?? Math.max(0, (element.clientWidth - 191) / 2);
    const time = Math.max(0, (element.scrollLeft + x) / pixelsPerSecond);
    setPixelsPerSecond(value);
    requestAnimationFrame(() => {
      if (scrollRef.current === element)
        element.scrollLeft = Math.max(0, time * value - x);
    });
  };
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setViewportWidth(element.clientWidth),
    );
    observer.observe(element);
    setViewportWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      if (busy || clipDrag.current) return;
      zoomTo(
        pixelsPerSecond * Math.exp(-event.deltaY * 0.01),
        event.clientX - element.getBoundingClientRect().left - 169,
      );
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [pixelsPerSecond, busy]);
  const selected = segments.find((segment) => segment.clip.id === selectedId);
  const currentVisual = segments.find(
    (segment) =>
      segment.track.kind === "visual" &&
      position >= segment.start &&
      position < segment.end,
  );
  const currentAudio = segments.filter(
    (segment) =>
      segment.track.kind === "audio" &&
      position >= segment.start &&
      position < segment.end,
  );
  const currentMedia = [
    ...(currentVisual?.clip.resource.kind === "video" ? [currentVisual] : []),
    ...currentAudio,
  ];
  useEffect(() => {
    active.current = true;
    const registry = media.current;
    return () => {
      active.current = false;
      loading.current?.abort();
      registry.forEach((element) => element.pause());
      registry.clear();
    };
  }, []);
  useEffect(() => {
    setPosition((current) => Math.min(current, duration));
  }, [duration]);
  useEffect(() => {
    if (!playing) return;
    const origin = performance.now(),
      initial = positionRef.current;
    let frame = 0;
    const tick = (now: number) => {
      const next = initial + (now - origin) / 1000;
      if (next >= duration) {
        setPosition(duration);
        setPlaying(false);
        return;
      }
      setPosition(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, duration]);
  useEffect(() => {
    for (const segment of currentMedia) {
      const element = media.current.get(segment.clip.id);
      if (!element) continue;
      const desired =
        segment.clip.inPoint + (position - segment.start) * segment.clip.speed;
      if (
        element.readyState >= 1 &&
        Math.abs(element.currentTime - desired) > 0.15
      )
        element.currentTime = desired;
      element.playbackRate = segment.clip.speed;
      element.preservesPitch = false;
      element.volume = segment.clip.volume;
      element.muted = segment.clip.muted || segment.track.muted;
      if (playing && element.paused && !pendingPlay.current.has(element)) {
        pendingPlay.current.add(element);
        void element
          .play()
          .catch((reason) => {
            if (
              active.current &&
              playingRef.current &&
              media.current.get(segment.clip.id) === element &&
              !(reason instanceof DOMException && reason.name === "AbortError")
            ) {
              setPlaying(false);
              setError(
                `播放未启动：${reason instanceof Error ? reason.message : String(reason)}`,
              );
            }
          })
          .finally(() => pendingPlay.current.delete(element));
      } else if (!playing) element.pause();
    }
    // Segments the playhead already passed must stop too, or their audio
    // keeps playing underneath the current segment.
    const current = new Set(currentMedia.map((segment) => segment.clip.id));
    for (const [clipId, element] of media.current) {
      if (!current.has(clipId) && !element.paused) element.pause();
    }
  }, [position, playing, timeline]);

  /** Continuous edits name themselves so one gesture stays a single undo step. */
  const change = (
    operation: (current: TimelineData) => TimelineData,
    gesture?: string,
  ) => {
    try {
      const next = operation(timelineRef.current);
      const invalid = timelineError(next);
      if (invalid) throw new Error(invalid);
      if (next !== timelineRef.current) {
        if (!gesture || gesture !== coalesce.current) {
          history.current.past = [
            ...history.current.past.slice(-49),
            timelineRef.current,
          ];
          history.current.future = [];
        }
        coalesce.current = gesture ?? null;
      }
      timelineRef.current = next;
      setTimeline(next);
      setPlaying(false);
      setError("");
      refreshHistory((value) => value + 1);
    } catch (error) {
      setError(error instanceof Error ? error.message : "时间线编辑失败。");
    }
  };
  const cancelDrag = () => {
    const drag = clipDrag.current;
    clipDrag.current = null;
    setDragPreview(null);
    setDragMessage("");
    if (drag && tracksRef.current?.hasPointerCapture(drag.pointerId))
      tracksRef.current.releasePointerCapture(drag.pointerId);
  };
  useEffect(() => {
    window.addEventListener("blur", cancelDrag);
    return () => window.removeEventListener("blur", cancelDrag);
  }, []);
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = clipDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (
      !drag.moved &&
      Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4
    )
      return;
    drag.moved = true;
    const lane = [
      ...event.currentTarget.querySelectorAll<HTMLElement>("[data-track-id]"),
    ].find((element) => {
      const rect = element.getBoundingClientRect();
      return (
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom &&
        event.clientX >= rect.left &&
        event.clientX <= rect.right
      );
    });
    drag.next = null;
    setDragPreview(null);
    if (!lane) {
      drag.error = "拖放已取消：请将片段放在目标轨道内。";
      setDragMessage("拖到目标轨道后松开；按 Esc 取消拖动。");
      return;
    }
    const viewport = scrollRef.current;
    if (viewport) {
      const bounds = viewport.getBoundingClientRect();
      if (event.clientX > bounds.right - 28) viewport.scrollLeft += 20;
      else if (event.clientX < bounds.left + 28) viewport.scrollLeft -= 20;
    }
    const rect = lane.getBoundingClientRect();
    const time = ((event.clientX - rect.left) / rect.width) * drag.duration;
    const source = timelineSegments(drag.origin).find(
      (segment) => segment.clip.id === drag.clipId,
    )!;
    try {
      drag.next = placeTimelineClip(
        drag.origin,
        drag.clipId,
        lane.dataset.trackId!,
        source.track.kind === "audio"
          ? snapTimelineTime(drag.origin, time - drag.offset, {
              enabled: snapping,
              pixelsPerSecond,
              playhead: positionRef.current,
              clipId: drag.clipId,
              duration: clipDuration(source.clip),
            })
          : time,
      );
      setDragPreview(drag.next);
      drag.error = "";
      setDragMessage("松开应用位置；按 Esc 取消拖动。");
    } catch (error) {
      drag.error = error instanceof Error ? error.message : "无法放置片段。";
      setDragMessage(drag.error);
    }
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = clipDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    moveDrag(event);
    cancelDrag();
    if (drag.moved) {
      if (drag.next) change(() => drag.next!);
      else setError(drag.error);
    } else {
      const segment = timelineSegments(drag.origin).find(
        (item) => item.clip.id === drag.clipId,
      );
      if (segment) seek(segment.start);
    }
  };
  const beginLoad = () => {
    loading.current?.abort();
    const controller = new AbortController();
    loading.current = controller;
    setBusy(true);
    setError("");
    return controller;
  };
  const ownsLoad = (controller: AbortController) =>
    active.current &&
    loading.current === controller &&
    !controller.signal.aborted;
  const addResource = async (resource: CanvasResource) => {
    const controller = beginLoad();
    try {
      const resolved = await withMediaDuration(resource, controller.signal);
      if (ownsLoad(controller))
        change((current) =>
          addTimelineClip(
            current,
            resolved,
            resource.kind === "audio" ? audioTrack || undefined : undefined,
          ),
        );
    } catch (error) {
      if (ownsLoad(controller))
        setError(error instanceof Error ? error.message : "素材读取失败。");
    } finally {
      if (ownsLoad(controller)) setBusy(false);
    }
  };
  const importFiles = async (files: FileList) => {
    const controller = beginLoad();
    const imported: CanvasResource[] = [],
      failures: string[] = [];
    try {
      for (const file of [...files]) {
        try {
          assertUpload(classifyImportFile(file).kind, "timeline");
          const resource = await readEditorResource(file, controller.signal);
          assertUpload(resource.kind, "timeline");
          imported.push(resource);
        } catch (error) {
          if (!ownsLoad(controller)) return;
          failures.push(
            `${file.name}：${error instanceof Error ? error.message : "读取失败"}`,
          );
        }
        if (!ownsLoad(controller)) return;
      }
      change((current) => {
        let next = current;
        for (const resource of imported) {
          try {
            next = addTimelineClip(
              next,
              resource,
              resource.kind === "audio" ? audioTrack || undefined : undefined,
            );
          } catch (error) {
            failures.push(
              `${resource.title}：${error instanceof Error ? error.message : "无法添加片段"}`,
            );
          }
        }
        return next;
      });
      if (failures.length)
        setError(
          `部分素材未导入（${failures.length}）：${failures.join("；")}`,
        );
    } finally {
      if (ownsLoad(controller)) setBusy(false);
    }
  };
  const seek = (time: number) => {
    setPlaying(false);
    setPosition(Math.max(0, Math.min(duration, time)));
  };
  const exportXml = () => {
    try {
      const text = exportTimelineFcpxml(timelineRef.current, node.data.title);
      downloadFile(
        new Blob([text], { type: "application/xml" }),
        `${node.data.title || "timeline"}.fcpxml`,
      );
      setError("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "XML 导出失败。");
    }
  };
  const exportPackage = async () => {
    const controller = beginLoad(),
      snapshot = copyTimeline(timelineRef.current);
    setPlaying(false);
    setPackageProgress(0);
    try {
      const blob = await exportTimelinePackage(
        snapshot,
        node.data.title,
        controller.signal,
        (value) => {
          if (ownsLoad(controller)) setPackageProgress(value);
        },
      );
      if (ownsLoad(controller))
        downloadFile(blob, `${node.data.title || "timeline"}.fcpxml.zip`);
    } catch (error) {
      if (ownsLoad(controller))
        setError(error instanceof Error ? error.message : "素材打包失败。");
    } finally {
      if (active.current && loading.current === controller) {
        setBusy(false);
        setPackageProgress(null);
      }
    }
  };
  const exportJson = () => {
    try {
      const json = exportTimeline(timeline, node.data.title);
      const url = URL.createObjectURL(
        new Blob([json], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${node.data.title || "timeline"}.timeline.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setError(error instanceof Error ? error.message : "时间线导出失败。");
    }
  };
  const bindMedia = (clip: TimelineClip) => {
    let callback = callbacks.current.get(clip.id);
    if (!callback) {
      callback = (element) => {
        const previous = media.current.get(clip.id);
        if (!element) {
          previous?.pause();
          media.current.delete(clip.id);
        } else media.current.set(clip.id, element);
      };
      callbacks.current.set(clip.id, callback);
    }
    return callback;
  };
  const historyStep = (direction: "undo" | "redo") => {
    const source =
        direction === "undo" ? history.current.past : history.current.future,
      next = source.pop();
    if (!next) return;
    (direction === "undo" ? history.current.future : history.current.past).push(
      timelineRef.current,
    );
    timelineRef.current = next;
    setTimeline(next);
    setPlaying(false);
    // A new gesture after undo or redo must not merge into the popped entry.
    coalesce.current = null;
    setSelectedId(null);
    refreshHistory((value) => value + 1);
  };
  const importJson = async (file: File) => {
    const controller = beginLoad();
    try {
      const text = await file.text();
      if (!ownsLoad(controller)) return;
      const parsed = importTimeline(text);
      change(() => parsed);
      setSelectedId(null);
      setAudioTrack("");
      setPosition(0);
    } catch (reason) {
      if (ownsLoad(controller))
        setError(reason instanceof Error ? reason.message : "导入时间线失败。");
    } finally {
      if (ownsLoad(controller)) setBusy(false);
    }
  };
  const renderVideo = async () => {
    const controller = beginLoad(),
      snapshot = copyTimeline(timelineRef.current);
    setPlaying(false);
    setRendered(null);
    setInserted(false);
    setRenderProgress(0);
    try {
      const { renderTimelineMp4 } = await import("./timelineRender");
      const blob = await renderTimelineMp4(
        snapshot,
        controller.signal,
        (value) => {
          if (ownsLoad(controller)) setRenderProgress(value);
        },
      );
      if (ownsLoad(controller)) setRendered(blob);
    } catch (reason) {
      if (ownsLoad(controller))
        setError(reason instanceof Error ? reason.message : "视频导出失败。");
    } finally {
      if (active.current && loading.current === controller) {
        setBusy(false);
        setRenderProgress(null);
      }
    }
  };
  const insertRender = async () => {
    if (!rendered) return;
    const controller = beginLoad();
    try {
      const src = await mediaBlobDataUrl(rendered, controller.signal);
      const media = await withMediaDuration(
        { id: "rendered", kind: "video", title: node.data.title, src },
        controller.signal,
      );
      if (ownsLoad(controller)) {
        setInserted(
          onRender({
            kind: "video",
            src,
            mimeType: "video/mp4",
            title: `${node.data.title} · 合成`,
            media: {
              width: media.width,
              height: media.height,
              durationSeconds: media.durationSeconds,
            },
          }),
        );
      }
    } catch (reason) {
      if (ownsLoad(controller))
        setError(reason instanceof Error ? reason.message : "加入画布失败。");
    } finally {
      if (ownsLoad(controller)) setBusy(false);
    }
  };
  const editableAtPlayhead =
    !!selected && position > selected.start && position < selected.end;
  const mediaReady = (
    element: HTMLMediaElement,
    clip: TimelineClip,
    start: number,
  ) => {
    element.currentTime = Math.min(
      clip.outPoint,
      clip.inPoint + Math.max(0, positionRef.current - start) * clip.speed,
    );
  };
  const patchSelected = (
    patch: Parameters<typeof updateTimelineClip>[2],
    gesture?: string,
  ) => {
    if (selected)
      change(
        (current) => updateTimelineClip(current, selected.clip.id, patch),
        gesture && `${gesture}:${selected.clip.id}`,
      );
  };
  /** A cleared field means "no change"; Number("") would silently move the clip to 0. */
  const patchNumber = (
    field: "inPoint" | "outPoint" | "start",
    text: string,
  ) => {
    const value = Number(text);
    if (!text.trim() || !Number.isFinite(value)) return;
    patchSelected({ [field]: value } as Parameters<
      typeof updateTimelineClip
    >[2], field);
  };

  return (
    <EditorModal
      title={`时间线 · ${node.data.title}`}
      subtitle="本地视觉轨顺序编排、多音轨播放与源片段入出点编辑"
      className="cw-timeline-dialog"
      onClose={onClose}
      onApply={() => {
        // Keep the session when the canvas rejected the edit; closing would drop
        // the whole timeline behind a transient notice.
        if (onApply(copyTimeline(timelineRef.current)) === false) return;
        onClose();
      }}
      disabled={busy || node.locked}
      error={error}
      actions={
        <>
          <button disabled={busy} onClick={() => jsonInput.current?.click()}>
            导入 JSON
          </button>
          <button disabled={busy} onClick={exportJson}>
            <CanvasIcon name="download" size={16} />
            导出可编辑 JSON
          </button>
          <button disabled={busy || !duration} onClick={exportXml}>
            导出 FCPXML
          </button>
          <button
            disabled={busy || !duration}
            onClick={() => void exportPackage()}
          >
            XML + 素材 ZIP
          </button>
          <button
            disabled={busy || !duration}
            onClick={() => void renderVideo()}
          >
            合成 MP4
          </button>
        </>
      }
    >
      {packageProgress !== null && (
        <div className="cw-render-status" role="status">
          <progress value={packageProgress} max={1} />
          <span>素材打包 {Math.round(packageProgress * 100)}%</span>
          <button onClick={() => loading.current?.abort()}>取消打包</button>
        </div>
      )}
      {renderProgress !== null && (
        <div className="cw-render-status" role="status">
          <progress value={renderProgress} max={1} />
          <span>正在合成 {Math.round(renderProgress * 100)}%</span>
          <button onClick={() => loading.current?.abort()}>取消合成</button>
        </div>
      )}
      {rendered && (
        <div className="cw-render-status" role="status">
          <span>
            MP4 已完成 · {(rendered.size / 1024 / 1024).toFixed(2)}{" "}
            MB（合成时的时间线）
          </span>
          <button
            disabled={busy}
            onClick={() =>
              downloadFile(
                rendered,
                downloadFilename(node.data.title, "video/mp4"),
              )
            }
          >
            下载 MP4
          </button>
          <button
            disabled={busy || node.locked || inserted}
            onClick={() => void insertRender()}
          >
            {inserted ? "已加入画布" : "将合成视频加入画布"}
          </button>
        </div>
      )}
      <fieldset
        className="cw-editor-work"
        disabled={busy}
        onKeyDown={(event) => {
          if (event.key === "Escape" && panelDrag.current) {
            event.preventDefault();
            event.stopPropagation();
            cancelPanel();
            return;
          }
          if (
            busy ||
            (event.target as HTMLElement).closest(
              "input,textarea,select,[contenteditable=true]",
            )
          )
            return;
          if (
            (event.metaKey || event.ctrlKey) &&
            ["z", "y"].includes(event.key.toLowerCase())
          ) {
            event.preventDefault();
            if (clipDrag.current) cancelDrag();
            else
              historyStep(
                event.shiftKey || event.key.toLowerCase() === "y"
                  ? "redo"
                  : "undo",
              );
          }
        }}
      >
        <div
          className={`cw-timeline-top${libraryShown ? "" : " is-library-hidden"}`}
          style={
            {
              "--cw-library-width": `${libraryWidth}px`,
              "--cw-track-height": `${trackHeight}px`,
            } as CSSProperties
          }
        >
          {libraryShown && (
            <aside className="cw-timeline-library">
              <div className="cw-domain-section-heading">
                <h3>素材库</h3>
                <button
                  disabled={busy}
                  onClick={() => fileInput.current?.click()}
                >
                  <CanvasIcon name="upload" size={14} />
                  导入
                </button>
              </div>
              <p className="cw-domain-note">
                图片、视频与音频。视频和音频会先读取实际时长。
              </p>
              <div className="cw-domain-row">
                <select
                  aria-label="素材类型筛选"
                  value={libraryKind}
                  onChange={(event) =>
                    setLibraryKind(event.target.value as TimelineLibraryKind)
                  }
                >
                  <option value="all">全部类型</option>
                  <option value="image">图片</option>
                  <option value="video">视频</option>
                  <option value="audio">音频</option>
                </select>
                <select
                  aria-label="素材来源筛选"
                  value={librarySource}
                  onChange={(event) =>
                    setLibrarySource(
                      event.target.value as TimelineLibrarySource,
                    )
                  }
                >
                  <option value="all">全部来源</option>
                  <option value="canvas">画布素材</option>
                  <option value="imported">已导入</option>
                </select>
              </div>
              <div className="cw-domain-resource-list">
                {libraryResources.map((resource, index) => (
                  <div
                    className="cw-timeline-library-item"
                    key={`${resource.id}-${index}`}
                  >
                    <button
                      disabled={busy}
                      onClick={() => {
                        void addResource(resource);
                      }}
                    >
                      <CanvasIcon name={resource.kind} size={16} />
                      <span>{resource.title}</span>
                      <CanvasIcon name="plus" size={14} />
                    </button>
                    {librarySource === "imported" && (
                      <button
                        aria-label={`从素材库移除 ${resource.title}`}
                        title="仅移出素材库，保留已有片段"
                        onClick={() =>
                          change((current) =>
                            removeTimelineAsset(current, resource.id),
                          )
                        }
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
                {!libraryResources.length && (
                  <p>可从本地导入，也可引用画布上的媒体节点。</p>
                )}
              </div>
              <label className="cw-domain-field">
                音频加入轨道
                <select
                  value={audioTrack}
                  onChange={(event) => setAudioTrack(event.target.value)}
                >
                  <option value="">首条音轨 / 自动新建</option>
                  {timeline.tracks
                    .filter((track) => track.kind === "audio")
                    .map((track) => (
                      <option key={track.id} value={track.id}>
                        {track.title}
                      </option>
                    ))}
                </select>
              </label>
              <button onClick={() => change(addAudioTrack)}>
                <CanvasIcon name="plus" size={14} />
                添加音轨
              </button>
              <p className="cw-domain-status" role="status">
                {busy ? "正在读取素材…" : ""}
              </p>
            </aside>
          )}
          {libraryShown && (
            <div
              className="cw-timeline-library-resizer"
              role="separator"
              aria-label="调整素材库宽度"
              aria-orientation="vertical"
              aria-valuenow={libraryWidth}
              aria-valuemin={150}
              aria-valuemax={420}
              tabIndex={0}
              onPointerDown={(event) => beginPanel(event, "library")}
              onPointerMove={resizePanel}
              onPointerUp={(event) => finishPanel(event)}
              onPointerCancel={(event) => finishPanel(event, true)}
              onLostPointerCapture={(event) => finishPanel(event, true)}
              onKeyDown={(event) => {
                if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
                  event.preventDefault();
                  setLibraryWidth((width) =>
                    Math.max(
                      150,
                      Math.min(
                        420,
                        width + (event.key === "ArrowRight" ? 20 : -20),
                      ),
                    ),
                  );
                }
              }}
            />
          )}
          <div className="cw-timeline-monitor">
            <div
              className="cw-timeline-screen"
              style={{ aspectRatio: `${timeline.width}/${timeline.height}` }}
            >
              {currentVisual?.clip.resource.src ? (
                currentVisual.clip.resource.kind === "image" ? (
                  <img
                    src={currentVisual.clip.resource.src}
                    alt={currentVisual.clip.resource.title}
                  />
                ) : (
                  <video
                    key={currentVisual.clip.id}
                    ref={bindMedia(currentVisual.clip)}
                    src={currentVisual.clip.resource.src}
                    playsInline
                    preload="auto"
                    onLoadedMetadata={(event) =>
                      mediaReady(
                        event.currentTarget,
                        currentVisual.clip,
                        currentVisual.start,
                      )
                    }
                    onError={() => {
                      setPlaying(false);
                      setError("当前视频无法播放，请检查素材或重新导入。");
                    }}
                  />
                )
              ) : (
                <div className="cw-timeline-monitor-empty">
                  <CanvasIcon name="video" size={38} />
                  <span>
                    {duration ? "当前时间没有画面" : "添加素材开始编排"}
                  </span>
                </div>
              )}
              {currentAudio.map((segment) => (
                <audio
                  key={segment.clip.id}
                  ref={bindMedia(segment.clip)}
                  src={segment.clip.resource.src}
                  preload="auto"
                  onLoadedMetadata={(event) =>
                    mediaReady(event.currentTarget, segment.clip, segment.start)
                  }
                  onError={() => {
                    setPlaying(false);
                    setError("音频素材无法播放，请重新导入。");
                  }}
                />
              ))}
            </div>
            <div className="cw-timeline-transport">
              <button
                aria-label="回到时间线开始"
                onClick={() => seek(0)}
                disabled={!duration}
              >
                ↤
              </button>
              <button
                className="cw-timeline-play"
                aria-label={playing ? "暂停时间线" : "播放时间线"}
                disabled={!duration || busy}
                onClick={() => {
                  if (position >= duration) setPosition(0);
                  setPlaying((current) => !current);
                }}
              >
                <CanvasIcon name={playing ? "stop" : "play"} size={18} />
              </button>
              <output>
                {timeLabel(position)} <span>/ {timeLabel(duration)}</span>
              </output>
              <label>
                帧率
                <select
                  value={timeline.fps}
                  onChange={(event) =>
                    change((current) => ({
                      ...current,
                      fps: Number(event.target.value),
                    }))
                  }
                >
                  {[24, 25, 30, 50, 60].map((fps) => (
                    <option key={fps} value={fps}>
                      {fps} fps
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <ControlSlider
              className="cw-timeline-seek"
              aria-label="时间线播放位置"
              min={0}
              max={Math.max(0.01, duration)}
              step={1 / timeline.fps}
              value={position}
              onChange={(event) => seek(Number(event.target.value))}
              disabled={!duration}
            />
          </div>
          <aside className="cw-timeline-inspector">
            <div className="cw-domain-section-heading">
              <h3>{selected ? "片段属性" : "项目设置"}</h3>
            </div>
            {selected ? (
              <>
                <strong>{selected.clip.resource.title}</strong>
                <p className="cw-domain-note">
                  {selected.track.title} · 播放{" "}
                  {clipDuration(selected.clip).toFixed(2)} 秒
                </p>
                {selected.clip.resource.kind !== "image" && (
                  <label className="cw-domain-field">
                    源入点（秒）
                    <input
                      type="number"
                      min={0}
                      step={1 / timeline.fps}
                      value={selected.clip.inPoint}
                      onChange={(event) =>
                        patchNumber("inPoint", event.target.value)
                      }
                    />
                  </label>
                )}
                <label className="cw-domain-field">
                  {selected.clip.resource.kind === "image"
                    ? "展示时长（秒）"
                    : "源出点（秒）"}
                  <input
                    type="number"
                    min={0.01}
                    step={1 / timeline.fps}
                    value={selected.clip.outPoint}
                    onChange={(event) =>
                      patchNumber("outPoint", event.target.value)
                    }
                  />
                </label>
                {selected.clip.resource.kind !== "image" && (
                  <label className="cw-domain-field">
                    播放速度
                    <select
                      value={selected.clip.speed}
                      onChange={(event) =>
                        patchSelected({ speed: Number(event.target.value) })
                      }
                    >
                      {[0.25, 0.5, 1, 1.5, 2, 4].map((speed) => (
                        <option key={speed} value={speed}>
                          {speed}×
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {selected.track.kind === "audio" && (
                  <label className="cw-domain-field">
                    时间线起点（秒）
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={selected.clip.start}
                      onChange={(event) =>
                        patchNumber("start", event.target.value)
                      }
                    />
                  </label>
                )}
                {selected.clip.resource.kind !== "image" && (
                  <>
                    <label className="cw-domain-field">
                      片段音量 {Math.round(selected.clip.volume * 100)}%
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={selected.clip.volume}
                        onChange={(event) =>
                          patchSelected(
                            { volume: Number(event.target.value) },
                            "volume",
                          )
                        }
                      />
                    </label>
                    <label className="cw-domain-checkbox">
                      <input
                        type="checkbox"
                        checked={selected.clip.muted}
                        onChange={(event) =>
                          patchSelected({ muted: event.target.checked })
                        }
                      />
                      片段静音
                    </label>
                  </>
                )}
                <div className="cw-domain-row">
                  <button
                    onClick={() =>
                      change((current) =>
                        selected.track.kind === "audio"
                          ? placeTimelineClip(
                              current,
                              selected.clip.id,
                              selected.track.id,
                              selected.start - 1 / current.fps,
                            )
                          : moveTimelineClip(current, selected.clip.id, -1),
                      )
                    }
                    aria-label={
                      selected.track.kind === "audio"
                        ? "音频前移一帧"
                        : "片段前移"
                    }
                  >
                    ←
                  </button>
                  <button
                    onClick={() =>
                      change((current) =>
                        selected.track.kind === "audio"
                          ? placeTimelineClip(
                              current,
                              selected.clip.id,
                              selected.track.id,
                              selected.start + 1 / current.fps,
                            )
                          : moveTimelineClip(current, selected.clip.id, 1),
                      )
                    }
                    aria-label={
                      selected.track.kind === "audio"
                        ? "音频后移一帧"
                        : "片段后移"
                    }
                  >
                    →
                  </button>
                  <button
                    onClick={() => {
                      change((current) =>
                        removeTimelineClip(current, selected.clip.id),
                      );
                      setSelectedId(null);
                    }}
                  >
                    删除片段
                  </button>
                </div>
              </>
            ) : (
              <>
                <label className="cw-domain-field">
                  画面比例
                  <select
                    value={`${timeline.width}:${timeline.height}`}
                    onChange={(event) => {
                      const [width, height] = event.target.value
                        .split(":")
                        .map(Number);
                      change((current) => ({
                        ...current,
                        width: width!,
                        height: height!,
                      }));
                    }}
                  >
                    {![
                      "1280:720",
                      "1920:1080",
                      "720:1280",
                      "1080:1920",
                      "1080:1080",
                    ].includes(`${timeline.width}:${timeline.height}`) && (
                      <option value={`${timeline.width}:${timeline.height}`}>
                        导入尺寸 · {timeline.width}×{timeline.height}
                      </option>
                    )}
                    <option value="1280:720">16:9 · 1280×720</option>
                    <option value="1920:1080">16:9 · 1920×1080</option>
                    <option value="720:1280">9:16 · 720×1280</option>
                    <option value="1080:1920">9:16 · 1080×1920</option>
                    <option value="1080:1080">1:1 · 1080×1080</option>
                  </select>
                </label>
                <p className="cw-domain-note">
                  点击轨道片段编辑源入点、出点、播放速度与音量。视觉片段自动顺序衔接；音轨保留显式起点，同轨不能重叠。
                </p>
              </>
            )}
          </aside>
        </div>
        <div className="cw-domain-row cw-timeline-edit-toolbar">
          <button
            aria-pressed={libraryShown}
            onClick={() => setLibraryShown((shown) => !shown)}
          >
            {libraryShown ? "隐藏素材库" : "显示素材库"}
          </button>
          <button
            disabled={!history.current.past.length || busy}
            onClick={() => historyStep("undo")}
          >
            撤销
          </button>
          <button
            disabled={!history.current.future.length || busy}
            onClick={() => historyStep("redo")}
          >
            重做
          </button>
          <button
            disabled={!editableAtPlayhead}
            onClick={() => {
              if (selected)
                change((current) =>
                  splitTimelineClip(current, selected.clip.id, position),
                );
            }}
          >
            在播放头分割
          </button>
          <button
            disabled={!editableAtPlayhead}
            onClick={() => {
              if (selected)
                change((current) =>
                  trimTimelineClip(current, selected.clip.id, position, "left"),
                );
            }}
          >
            剪掉播放头左侧
          </button>
          <button
            disabled={!editableAtPlayhead}
            onClick={() => {
              if (selected)
                change((current) =>
                  trimTimelineClip(
                    current,
                    selected.clip.id,
                    position,
                    "right",
                  ),
                );
            }}
          >
            剪掉播放头右侧
          </button>
          <label className="cw-timeline-snap">
            <input
              type="checkbox"
              checked={snapping}
              onChange={(event) => setSnapping(event.target.checked)}
            />
            自动吸附
          </label>
          <label className="cw-timeline-zoom">
            时间轴缩放
            <input
              aria-label="时间轴缩放"
              type="range"
              min={Math.log2(0.01)}
              max={Math.log2(800)}
              step={0.1}
              value={Math.log2(pixelsPerSecond)}
              onChange={(event) => zoomTo(2 ** Number(event.target.value))}
            />
            <output>
              {pixelsPerSecond < 1
                ? pixelsPerSecond.toFixed(2)
                : Math.round(pixelsPerSecond)}{" "}
              px/s
            </output>
          </label>
          <button
            onClick={() =>
              zoomTo((viewportWidth - 191) / Math.max(1, duration + 2))
            }
          >
            适应全部
          </button>
        </div>
        <div className="cw-timeline-drag-status" role="status">
          {dragMessage}
        </div>
        <div
          className="cw-timeline-height-resizer"
          role="separator"
          aria-label="调整轨道区高度"
          aria-orientation="horizontal"
          aria-valuenow={trackHeight}
          aria-valuemin={140}
          aria-valuemax={650}
          tabIndex={0}
          onPointerDown={(event) => beginPanel(event, "tracks")}
          onPointerMove={resizePanel}
          onPointerUp={(event) => finishPanel(event)}
          onPointerCancel={(event) => finishPanel(event, true)}
          onLostPointerCapture={(event) => finishPanel(event, true)}
          onKeyDown={(event) => {
            if (["ArrowUp", "ArrowDown"].includes(event.key)) {
              event.preventDefault();
              setTrackHeight((height) =>
                Math.max(
                  140,
                  Math.min(650, height + (event.key === "ArrowUp" ? 20 : -20)),
                ),
              );
            }
          }}
        />
        <div
          className="cw-timeline-scroll"
          ref={scrollRef}
          style={{ height: trackHeight }}
          onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
        >
          <div
            className="cw-timeline-tracks"
            style={
              {
                width: trackWidth,
                "--cw-ruler-step": `${rulerStep * pixelsPerSecond}px`,
              } as CSSProperties
            }
            ref={tracksRef}
            tabIndex={0}
            aria-label="时间线轨道"
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={cancelDrag}
            onLostPointerCapture={cancelDrag}
            onKeyDownCapture={(event) => {
              if (event.key === "Escape" && clipDrag.current) {
                event.preventDefault();
                event.stopPropagation();
                cancelDrag();
                setError("");
              }
            }}
          >
            <div className="cw-timeline-ruler">
              <span>轨道 / 秒</span>
              <div
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  seek(
                    snapTimelineTime(
                      timeline,
                      ((event.clientX - rect.left) / rect.width) *
                        visibleDuration,
                      {
                        enabled: snapping,
                        pixelsPerSecond,
                        playhead: position,
                      },
                    ),
                  );
                }}
              >
                {rulerTicks.map((time) => (
                  <span
                    key={time}
                    data-origin={time === 0 || undefined}
                    style={{ left: `${(time / visibleDuration) * 100}%` }}
                  >
                    {timeLabel(time)}
                  </span>
                ))}
              </div>
            </div>
            {timeline.tracks.map((track) => (
              <div className="cw-timeline-track" key={track.id}>
                <div className="cw-timeline-track-label">
                  <span>{track.title}</span>
                  <button
                    onClick={() =>
                      change((current) => ({
                        ...current,
                        tracks: current.tracks.map((item) =>
                          item.id === track.id
                            ? { ...item, muted: !item.muted }
                            : item,
                        ),
                      }))
                    }
                    aria-label={`${track.muted ? "取消静音" : "静音"}${track.title}`}
                  >
                    {track.muted ? "静音" : "有声"}
                  </button>
                  {track.kind === "audio" && (
                    <button
                      aria-label={`删除${track.title}`}
                      onClick={() => {
                        setPlaying(false);
                        if (audioTrack === track.id) setAudioTrack("");
                        change((current) => ({
                          ...current,
                          tracks: current.tracks.filter(
                            (item) => item.id !== track.id,
                          ),
                        }));
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
                <div
                  className="cw-timeline-track-lane"
                  data-track-id={track.id}
                  onClick={(event) => {
                    if (event.target === event.currentTarget) {
                      const rect = event.currentTarget.getBoundingClientRect();
                      seek(
                        snapTimelineTime(
                          timeline,
                          ((event.clientX - rect.left) / rect.width) *
                            visibleDuration,
                          {
                            enabled: snapping,
                            pixelsPerSecond,
                            playhead: position,
                          },
                        ),
                      );
                    }
                  }}
                >
                  <div
                    className="cw-timeline-playhead"
                    style={{
                      left: `${(position / visibleDuration) * 100}%`,
                    }}
                  />
                  {segments
                    .filter((segment) => segment.track.id === track.id)
                    .map((segment) => (
                      <button
                        key={segment.clip.id}
                        className={`cw-timeline-clip ${selectedId === segment.clip.id ? "selected" : ""} ${track.kind}${dragPreview && clipDrag.current?.clipId === segment.clip.id ? " dragging" : ""}`}
                        style={{
                          left: `${(segment.start / visibleDuration) * 100}%`,
                          width: `${(clipDuration(segment.clip) / visibleDuration) * 100}%`,
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (event.detail === 0) {
                            setSelectedId(segment.clip.id);
                            seek(segment.start);
                          }
                        }}
                        onPointerDown={(event) => {
                          if (busy || event.button !== 0 || clipDrag.current)
                            return;
                          event.preventDefault();
                          tracksRef.current?.focus({ preventScroll: true });
                          const rect =
                            event.currentTarget.parentElement!.getBoundingClientRect();
                          clipDrag.current = {
                            pointerId: event.pointerId,
                            clipId: segment.clip.id,
                            origin: timelineRef.current,
                            x: event.clientX,
                            y: event.clientY,
                            offset:
                              ((event.clientX - rect.left) / rect.width) *
                                visibleDuration -
                              segment.start,
                            duration: visibleDuration,
                            moved: false,
                            next: null,
                            error: "",
                          };
                          setSelectedId(segment.clip.id);
                          setPlaying(false);
                          tracksRef.current?.setPointerCapture(event.pointerId);
                        }}
                      >
                        <CanvasIcon
                          name={segment.clip.resource.kind}
                          size={14}
                        />
                        <span>{segment.clip.resource.title}</span>
                        <small>{clipDuration(segment.clip).toFixed(1)}s</small>
                      </button>
                    ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        <p className="cw-domain-note cw-timeline-footnote">
          拖动画面片段调整顺序；拖动音频调整起点或移至其他音轨。按 Esc
          取消，⌘/Ctrl + Z 撤销。 MP4
          在浏览器内合成，保留顺序、裁剪、倍速、音量和多轨混音；画面等比适配并补黑边。
          倍速会同时改变音调。⌘/Ctrl +
          滚轮以指针位置缩放时间轴；自动吸附对齐片段边缘与播放头。 FCPXML
          为标准剪辑交换格式，ZIP 含原媒体；解压后保持 media
          目录相对位置。并非原生剪映工程，也不承诺所有剪辑软件版本兼容。JSON
          可在本工程继续编辑。
        </p>
        <input
          className="cw-domain-file-input"
          ref={jsonInput}
          type="file"
          accept="application/json,.json"
          aria-label="导入时间线 JSON"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importJson(file);
            event.target.value = "";
          }}
        />
        <input
          className="cw-domain-file-input"
          ref={fileInput}
          type="file"
          accept="image/*,video/*,audio/*"
          multiple
          aria-label="导入时间线素材"
          onChange={(event) => {
            if (event.target.files) void importFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </fieldset>
    </EditorModal>
  );
}

export default TimelineEditor;
