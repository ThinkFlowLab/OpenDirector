import { RULE_FACTS } from "../contracts/ruleFacts.generated.ts";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type CSSProperties,
} from "react";
import { TimelineTextInspector } from "./TimelineTextInspector";
import { TimelineTextLane, TimelineTextPosition } from "./TimelineTextLane";
import { TimelineTextPreview } from "./TimelineTextPreview";
import {
  addTimelineText,
  updateTimelineText,
  removeTimelineText,
  reorderTimelineText,
} from "./timelineText";
import { ControlSlider } from "./ControlSlider";
import type {
  CanvasNode,
  CanvasResource,
  TimelineClip,
  TimelineData,
  TimelineTextSourceView,
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
  timelineHasTextResources,
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
import { useI18n } from "../i18n/I18nProvider.tsx";
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
  onApply: (data: TimelineData) => boolean | void | Promise<boolean | void>;
  onRender: (result: LinkedMediaResult) => boolean | Promise<boolean>;
  onPrepareRender?: (
    timeline: TimelineData,
  ) => Promise<(result: LinkedMediaResult) => Promise<boolean>>;
  onExportEditablePackage?: (timeline: TimelineData) => Promise<Blob>;
  onPreparePackageImport?: (
    file: File,
    replace: boolean,
  ) => () => Promise<TimelineData | void>;
  latestNode?: CanvasNode;
  onRefreshFromProject?: () => void;
  onReadTextResource?: (
    resource: CanvasResource,
  ) => Promise<TimelineTextSourceView>;
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
  onPrepareRender,
  onClose,
  onReadTextResource,
  onExportEditablePackage,
  onPreparePackageImport,
  latestNode,
  onRefreshFromProject,
}: TimelineEditorProps) {
  const { t } = useI18n();
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
            title: "",
            muted: false,
            clips: [],
          },
        ],
      },
    ),
  );
  const [selection, setSelection] = useState<{
      kind: "clip" | "text";
      id: string;
    } | null>(null),
    [position, setPosition] = useState(0),
    [playing, setPlaying] = useState(false);
  const [externalChanged, setExternalChanged] = useState(false);
  const [textInputDirty, setTextInputDirty] = useState(false);
  const [textInputValid, setTextInputValid] = useState(true);
  const [gesturePending, setGesturePending] = useState(false);
  const gestureActive = useRef(false);
  const setGestureActivity = (pending: boolean) => {
    gestureActive.current = pending;
    setGesturePending(pending);
  };
  const baselineTimeline = useRef(timeline);
  const initialSignature = useMemo(
    () => JSON.stringify(node.data.timeline),
    [node.data.timeline],
  );
  const latestSignature = useMemo(
    () => JSON.stringify(latestNode?.data.timeline),
    [latestNode?.data.timeline],
  );
  const currentSignature = useMemo(() => JSON.stringify(timeline), [timeline]);
  const sourceTimeline = useRef(initialSignature);
  const baselineSignature = useRef(currentSignature);
  const nativePackageInput = useRef<HTMLInputElement>(null);
  const nativeReplace = useRef(false);
  const nativePending = useRef<{
    replace: boolean;
    run: () => Promise<TimelineData | void>;
  } | null>(null);
  const [nativeMessage, setNativeMessage] = useState("");
  const [nativeRetry, setNativeRetry] = useState(false);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [audioTrack, setAudioTrack] = useState("");
  const [inserted, setInserted] = useState(false);
  const [renderProgress, setRenderProgress] = useState<number | null>(null);
  const [rendered, setRendered] = useState<Blob | null>(null);
  const [textSourceId, setTextSourceId] = useState("");
  const fontInput = useRef<HTMLInputElement>(null);
  const textResources = resources.filter(
    (r) => r.kind === "text" && !/\.(srt|ass|vtt)$/i.test(r.title),
  );
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
  useEffect(() => {
    if (!latestNode || latestSignature === sourceTimeline.current || busy)
      return;
    if (
      !textInputDirty &&
      !gestureActive.current &&
      !clipDrag.current &&
      currentSignature === baselineSignature.current &&
      latestNode.data.timeline
    ) {
      const next = copyTimeline(latestNode.data.timeline);
      baselineTimeline.current = next;
      sourceTimeline.current = latestSignature;
      baselineSignature.current = JSON.stringify(next);
      timelineRef.current = next;
      history.current = { past: [], future: [] };
      coalesce.current = null;
      setTimeline(next);
      setExternalChanged(false);
      onRefreshFromProject?.();
    } else setExternalChanged(true);
  }, [
    latestNode,
    latestSignature,
    currentSignature,
    busy,
    textInputDirty,
    gesturePending,
    onRefreshFromProject,
  ]);
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
  const hasTextResources = timelineHasTextResources(timeline);
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
  const selectedId = selection?.kind === "clip" ? selection.id : null;
  const selectedText =
    selection?.kind === "text"
      ? timeline.overlays?.find((o) => o.id === selection.id)
      : undefined;
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
                t("timeline.error.playFailed", {
                  reason:
                    reason instanceof Error ? reason.message : String(reason),
                }),
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
      setError(
        error instanceof Error ? error.message : t("timeline.error.editFailed"),
      );
    }
  };
  const cancelDrag = () => {
    const drag = clipDrag.current;
    clipDrag.current = null;
    if (drag) setGestureActivity(false);
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
      drag.error = t("timeline.error.dragCancelled");
      setDragMessage(t("timeline.error.dragHint"));
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
      setDragMessage(t("timeline.error.dropHint"));
    } catch (error) {
      drag.error =
        error instanceof Error
          ? error.message
          : t("timeline.error.placeFailed");
      setDragMessage(drag.error);
    }
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = clipDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    moveDrag(event);
    if (drag.moved) {
      if (drag.next) change(() => drag.next!);
      else setError(drag.error);
    } else {
      const segment = timelineSegments(drag.origin).find(
        (item) => item.clip.id === drag.clipId,
      );
      if (segment) seek(segment.start);
    }
    cancelDrag();
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
        setError(
          error instanceof Error
            ? error.message
            : t("timeline.error.assetReadFailed"),
        );
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
            t("timeline.error.fileReadFailed", {
              name: file.name,
              error:
                error instanceof Error
                  ? error.message
                  : t("timeline.error.readFailed"),
            }),
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
              t("timeline.error.addClipFailed", {
                title: resource.title,
                error:
                  error instanceof Error
                    ? error.message
                    : t("timeline.error.cannotAddClip"),
              }),
            );
          }
        }
        return next;
      });
      if (failures.length)
        setError(
          t("timeline.error.partialImport", {
            count: failures.length,
            items: failures.join(t("canvas.workspace.list.separator")),
          }),
        );
    } finally {
      if (ownsLoad(controller)) setBusy(false);
    }
  };
  const createText = async (resource?: CanvasResource) => {
    const controller = beginLoad();
    try {
      let text = t("timeline.text.defaultText"),
        source: TimelineTextSourceView | undefined;
      if (resource) {
        if (!textResources.includes(resource))
          throw new Error(t("timeline.text.sourceError"));
        source = onReadTextResource
          ? await onReadTextResource(resource)
          : {
              title: resource.title,
              src:
                resource.src ??
                `data:text/plain;charset=utf-8,${encodeURIComponent(resource.text ?? "")}`,
              mimeType: "text/plain",
            };
        if (resource.text !== undefined) text = resource.text;
        else {
          const response = await fetch(source.src!, {
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(t("timeline.text.sourceError"));
          text = await response.text();
        }
      }
      if (!ownsLoad(controller)) return;
      const id = crypto.randomUUID();
      const start =
        Math.floor(positionRef.current * timelineRef.current.fps + 1e-9) /
        timelineRef.current.fps;
      change((current) => {
        const defaultFont = {
          id: "noto-sans-cjk-sc-regular",
          title: t("timeline.text.defaultFont"),
          src: "/fonts/NotoSansCJKsc-Regular.otf",
          mimeType: "font/otf",
        };
        const font = current.fonts?.[0] ?? defaultFont;
        return addTimelineText(
          { ...current, fonts: current.fonts?.length ? current.fonts : [font] },
          {
            id,
            text,
            start,
            end: start + 3,
            x: 0.1,
            y: 0.82,
            maxWidth: 0.8,
            fontId: font.id,
            style: {
              fontSize: Math.max(
                1,
                Math.min(512, Math.round(current.height * 0.05)),
              ),
              color: "#FFFFFF",
              align: "center",
              lineHeight: 1.2,
              background: { color: "#000000", opacity: 0.5, padding: 4 },
            },
            ...(source ? { source } : {}),
          },
        );
      });
      setSelection({ kind: "text", id });
    } catch (reason) {
      if (ownsLoad(controller))
        setError(
          reason instanceof Error
            ? reason.message
            : t("timeline.error.editFailed"),
        );
    } finally {
      if (ownsLoad(controller)) setBusy(false);
    }
  };
  const importFont = async (file: File) => {
    const controller = beginLoad();
    try {
      const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      if (
        file.size > RULE_FACTS.timelineFontBytes ||
        file.size < 12 ||
        !/\.(otf|ttf)$/i.test(file.name) ||
        !(
          (signature[0] === 0 &&
            signature[1] === 1 &&
            signature[2] === 0 &&
            signature[3] === 0) ||
          String.fromCharCode(...signature) === "OTTO"
        )
      )
        throw new Error(t("timeline.text.fontError"));
      const src = await mediaBlobDataUrl(
        new Blob([file], {
          type: /\.otf$/i.test(file.name) ? "font/otf" : "font/ttf",
        }),
        controller.signal,
      );
      if (!ownsLoad(controller)) return;
      const font = {
        id: crypto.randomUUID(),
        title: file.name,
        src,
        mimeType: /\.otf$/i.test(file.name) ? "font/otf" : "font/ttf",
      };
      change((current) => {
        const next = { ...current, fonts: [...(current.fonts ?? []), font] };
        return selectedText
          ? updateTimelineText(next, selectedText.id, { fontId: font.id })
          : next;
      });
    } catch (reason) {
      if (ownsLoad(controller))
        setError(
          reason instanceof Error
            ? reason.message
            : t("timeline.text.fontError"),
        );
    } finally {
      if (ownsLoad(controller)) setBusy(false);
    }
  };
  const textCallbacks = {
    timeline,
    selectedId: selection?.kind === "text" ? selection.id : null,
    onSelect: (id: string) => setSelection({ kind: "text" as const, id }),
    onPreview: setDragPreview,
    onGestureChange: setGestureActivity,
    onCommit: (id: string, patch: Parameters<typeof updateTimelineText>[2]) =>
      change((current) => updateTimelineText(current, id, patch)),
  };
  const seek = (time: number) => {
    setPlaying(false);
    setPosition(Math.max(0, Math.min(duration, time)));
  };
  const exportXml = () => {
    if (!textInputValid || gestureActive.current) return;
    try {
      const text = exportTimelineFcpxml(timelineRef.current, node.data.title);
      downloadFile(
        new Blob([text], { type: "application/xml" }),
        `${node.data.title || "timeline"}.fcpxml`,
      );
      setError("");
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : t("timeline.error.xmlExportFailed"),
      );
    }
  };
  const exportPackage = async () => {
    if (!textInputValid || gestureActive.current) return;
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
        setError(
          error instanceof Error
            ? error.message
            : t("timeline.error.packFailed"),
        );
    } finally {
      if (active.current && loading.current === controller) {
        setBusy(false);
        setPackageProgress(null);
      }
    }
  };
  const exportEditablePackage = async () => {
    if (
      !onExportEditablePackage ||
      busy ||
      !textInputValid ||
      gestureActive.current
    )
      return;
    setBusy(true);
    setError("");
    setPlaying(false);
    try {
      const snapshot = copyTimeline(timelineRef.current);
      const blob = await onExportEditablePackage(snapshot);
      baselineTimeline.current = timelineRef.current;
      baselineSignature.current = JSON.stringify(timelineRef.current);
      downloadFile(blob, `${node.data.title || "timeline"}.timeline.zip`);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t("timeline.package.failed"),
      );
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const runNativeImport = async () => {
    const pending = nativePending.current;
    if (!pending || busy) return;
    setBusy(true);
    setError("");
    setNativeMessage("");
    setNativeRetry(false);
    setPlaying(false);
    try {
      const restored = await pending.run();
      if (!active.current) return;
      if (pending.replace && restored) {
        const next = copyTimeline(restored);
        timelineRef.current = next;
        baselineTimeline.current = next;
        baselineSignature.current = JSON.stringify(next);
        sourceTimeline.current = JSON.stringify(restored);
        history.current = { past: [], future: [] };
        coalesce.current = null;
        setTimeline(next);
        setSelection(null);
        setAudioTrack("");
        setPosition(0);
        setTextInputDirty(false);
        setTextInputValid(true);
        setExternalChanged(false);
      }
      nativePending.current = null;
      setNativeMessage(
        t(
          pending.replace
            ? "timeline.package.replaced"
            : "timeline.package.created",
        ),
      );
    } catch (reason) {
      if (active.current) {
        setError(
          reason instanceof Error
            ? reason.message
            : t("timeline.package.failed"),
        );
        setNativeRetry(true);
      }
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const importEditablePackage = (file: File) => {
    if (!onPreparePackageImport) return;
    try {
      nativePending.current = {
        replace: nativeReplace.current,
        run: onPreparePackageImport(file, nativeReplace.current),
      };
      void runNativeImport();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t("timeline.package.failed"),
      );
    }
  };
  const exportJson = () => {
    if (!textInputValid || gestureActive.current) return;
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
      setError(
        error instanceof Error
          ? error.message
          : t("timeline.error.exportFailed"),
      );
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
    setSelection((current) =>
      current &&
      (current.kind === "text"
        ? next.overlays?.some((o) => o.id === current.id)
        : next.tracks.some((t) => t.clips.some((c) => c.id === current.id)))
        ? current
        : null,
    );
    refreshHistory((value) => value + 1);
  };
  const importJson = async (file: File) => {
    const controller = beginLoad();
    try {
      const text = await file.text();
      if (!ownsLoad(controller)) return;
      const parsed = importTimeline(text);
      change(() => parsed);
      setSelection(null);
      setAudioTrack("");
      setPosition(0);
    } catch (reason) {
      if (ownsLoad(controller))
        setError(
          reason instanceof Error
            ? reason.message
            : t("timeline.error.importFailed"),
        );
    } finally {
      if (ownsLoad(controller)) setBusy(false);
    }
  };
  const saveTimeline = async (snapshot: TimelineData) => {
    if ((await onApply(snapshot)) === false)
      throw new Error(t("timeline.error.notApplied"));
  };
  const applyTimeline = async () => {
    if (busy || !textInputValid || gestureActive.current) return;
    setBusy(true);
    setError("");
    try {
      await saveTimeline(copyTimeline(timelineRef.current));
      onClose();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t("timeline.error.saveFailed"),
      );
    } finally {
      setBusy(false);
    }
  };
  const renderedPublisher = useRef<
    ((result: LinkedMediaResult) => Promise<boolean>) | null
  >(null);
  const renderVideo = async () => {
    if (!textInputValid || gestureActive.current) return;
    const controller = beginLoad(),
      snapshot = copyTimeline(timelineRef.current);
    setPlaying(false);
    setRendered(null);
    setInserted(false);
    setRenderProgress(0);
    try {
      const publish = onPrepareRender
        ? await onPrepareRender(snapshot)
        : (await saveTimeline(snapshot),
          async (result: LinkedMediaResult) => onRender(result));
      controller.signal.throwIfAborted();
      const { renderTimelineMp4 } = await import("./timelineRender");
      const blob = await renderTimelineMp4(
        snapshot,
        controller.signal,
        (value) => {
          if (ownsLoad(controller)) setRenderProgress(value);
        },
      );
      if (ownsLoad(controller)) {
        renderedPublisher.current = publish;
        setRendered(blob);
      }
    } catch (reason) {
      if (ownsLoad(controller))
        setError(
          reason instanceof Error
            ? reason.message
            : t("timeline.error.videoExportFailed"),
        );
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
          await renderedPublisher.current!({
            kind: "video",
            src,
            mimeType: "video/mp4",
            title: t("timeline.action.renderTitle", {
              title: node.data.title,
            }),
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
        setError(
          reason instanceof Error
            ? reason.message
            : t("timeline.error.addCanvasFailed"),
        );
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
    patchSelected(
      { [field]: value } as Parameters<typeof updateTimelineClip>[2],
      field,
    );
  };

  const trackTitle = (track: (typeof timeline.tracks)[number]) =>
    track.title ||
    t(track.kind === "audio" ? "timeline.track.audio" : "timeline.track.video");

  return (
    <EditorModal
      title={t("timeline.header.title", { title: node.data.title })}
      subtitle={t("timeline.header.subtitle")}
      className="cw-timeline-dialog"
      onClose={onClose}
      onApply={() => void applyTimeline()}
      disabled={busy || node.locked || !textInputValid || gesturePending}
      error={error}
      actions={
        <>
          {onPreparePackageImport && (
            <>
              <button
                disabled={busy}
                onClick={() => {
                  nativeReplace.current = false;
                  nativePackageInput.current?.click();
                }}
              >
                {t("timeline.package.importNew")}
              </button>
              <button
                disabled={busy || node.locked}
                onClick={() => {
                  nativeReplace.current = true;
                  nativePackageInput.current?.click();
                }}
              >
                {t("timeline.package.replace")}
              </button>
            </>
          )}
          {onExportEditablePackage && (
            <button
              disabled={busy || !textInputValid || gesturePending}
              onClick={() => void exportEditablePackage()}
            >
              {t("timeline.package.export")}
            </button>
          )}
          <button disabled={busy} onClick={() => jsonInput.current?.click()}>
            {t("timeline.action.importJson")}
          </button>
          <button
            disabled={busy || !textInputValid || gesturePending}
            onClick={exportJson}
          >
            <CanvasIcon name="download" size={16} />
            {t("timeline.action.exportJson")}
          </button>
          <button
            disabled={busy || !duration || !textInputValid || gesturePending || hasTextResources}
            title={hasTextResources ? t("timeline.text.unsupportedExchange") : undefined}
            onClick={exportXml}
          >
            {t("timeline.action.exportFcpXml")}
          </button>
          <button
            disabled={busy || !duration || !textInputValid || gesturePending || hasTextResources}
            title={hasTextResources ? t("timeline.text.unsupportedExchange") : undefined}
            onClick={() => void exportPackage()}
          >
            {t("timeline.action.exportZip")}
          </button>
          <button
            disabled={busy || !duration || !textInputValid || gesturePending}
            onClick={() => void renderVideo()}
          >
            {t("timeline.action.renderMp4")}
          </button>
        </>
      }
    >
      {hasTextResources && (
        <p className="cw-domain-note">
          {t("timeline.text.unsupportedExchange")}
        </p>
      )}
      {nativeMessage && (
        <p className="cw-domain-note" role="status">
          {nativeMessage}
        </p>
      )}
      {nativeRetry && (
        <button disabled={busy} onClick={() => void runNativeImport()}>
          {t("timeline.package.retry")}
        </button>
      )}
      {externalChanged && (
        <p className="cw-domain-note" role="status">
          {t("timeline.text.changed")}
        </p>
      )}
      {packageProgress !== null && (
        <div className="cw-render-status" role="status">
          <progress value={packageProgress} max={1} />
          <span>
            {t("timeline.pack.progress", {
              percent: Math.round(packageProgress * 100),
            })}
          </span>
          <button onClick={() => loading.current?.abort()}>
            {t("timeline.action.cancelPack")}
          </button>
        </div>
      )}
      {renderProgress !== null && (
        <div className="cw-render-status" role="status">
          <progress value={renderProgress} max={1} />
          <span>
            {t("timeline.render.progress", {
              percent: Math.round(renderProgress * 100),
            })}
          </span>
          <button onClick={() => loading.current?.abort()}>
            {t("timeline.action.cancelRender")}
          </button>
        </div>
      )}
      {rendered && (
        <div className="cw-render-status" role="status">
          <span>
            {t("timeline.render.done", {
              size: (rendered.size / 1024 / 1024).toFixed(2),
            })}
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
            {t("timeline.action.downloadMp4")}
          </button>
          <button
            disabled={busy || node.locked || inserted}
            onClick={() => void insertRender()}
          >
            {inserted
              ? t("timeline.action.addedToCanvas")
              : t("timeline.action.addToCanvas")}
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
              <div className="cw-timeline-text-actions">
                <button onClick={() => void createText()}>
                  {t("timeline.text.add")}
                </button>
                <label className="cw-domain-field">
                  {t("timeline.text.source")}
                  <select
                    value={textSourceId}
                    onChange={(e) => setTextSourceId(e.target.value)}
                  >
                    <option value="">—</option>
                    {textResources.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.title}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  disabled={!textSourceId}
                  onClick={() =>
                    void createText(
                      textResources.find((r) => r.id === textSourceId),
                    )
                  }
                >
                  {t("timeline.text.fromSource")}
                </button>
                <button onClick={() => fontInput.current?.click()}>
                  {t("timeline.text.importFont")}
                </button>
                <input
                  type="file"
                  hidden
                  accept=".otf,.ttf"
                  ref={fontInput}
                  aria-label={t("timeline.text.fontFile")}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void importFont(f);
                    e.target.value = "";
                  }}
                />
              </div>
              <div className="cw-domain-section-heading">
                <h3>{t("timeline.library.title")}</h3>
                <button
                  disabled={busy}
                  onClick={() => fileInput.current?.click()}
                >
                  <CanvasIcon name="upload" size={14} />
                  {t("timeline.library.import")}
                </button>
              </div>
              <p className="cw-domain-note">{t("timeline.library.hint")}</p>
              <div className="cw-domain-row">
                <select
                  aria-label={t("timeline.library.typeFilter")}
                  value={libraryKind}
                  onChange={(event) =>
                    setLibraryKind(event.target.value as TimelineLibraryKind)
                  }
                >
                  <option value="all">{t("timeline.library.allTypes")}</option>
                  <option value="image">{t("timeline.library.image")}</option>
                  <option value="video">{t("timeline.library.video")}</option>
                  <option value="audio">{t("timeline.library.audio")}</option>
                </select>
                <select
                  aria-label={t("timeline.library.sourceFilter")}
                  value={librarySource}
                  onChange={(event) =>
                    setLibrarySource(
                      event.target.value as TimelineLibrarySource,
                    )
                  }
                >
                  <option value="all">
                    {t("timeline.library.allSources")}
                  </option>
                  <option value="canvas">
                    {t("timeline.library.canvasAssets")}
                  </option>
                  <option value="imported">
                    {t("timeline.library.imported")}
                  </option>
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
                        aria-label={t("timeline.library.remove", {
                          title: resource.title,
                        })}
                        title={t("timeline.library.removeHint")}
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
                  <p>{t("timeline.library.empty")}</p>
                )}
              </div>
              <label className="cw-domain-field">
                {t("timeline.library.addAudio")}
                <select
                  value={audioTrack}
                  onChange={(event) => setAudioTrack(event.target.value)}
                >
                  <option value="">
                    {t("timeline.library.firstAudioTrack")}
                  </option>
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
                {t("timeline.library.addTrack")}
              </button>
              <p className="cw-domain-status" role="status">
                {busy ? t("timeline.library.reading") : ""}
              </p>
            </aside>
          )}
          {libraryShown && (
            <div
              className="cw-timeline-library-resizer"
              role="separator"
              aria-label={t("timeline.library.resize")}
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
            <div className="cw-timeline-picture-area">
              <div
                className={`cw-timeline-screen${duration ? "" : " is-empty"}`}
                style={{
                  aspectRatio: `${timeline.width}/${timeline.height}`,
                  width: `min(100cqw, calc(100cqh * ${timeline.width / timeline.height}))`,
                }}
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
                        setError(t("timeline.player.videoError"));
                      }}
                    />
                  )
                ) : !duration ? (
                  <div className="cw-timeline-monitor-empty">
                    <CanvasIcon name="video" size={38} />
                    <span>
                      {duration
                        ? t("timeline.player.noVideo")
                        : t("timeline.player.empty")}
                    </span>
                  </div>
                ) : null}
                <TimelineTextPreview
                  timeline={dragPreview ?? timeline}
                  position={position}
                  className="cw-timeline-text-preview"
                  onError={(reason) => setError(reason.message)}
                />
                <TimelineTextPosition
                  {...textCallbacks}
                  timeline={dragPreview ?? timeline}
                  position={position}
                />
                {currentAudio.map((segment) => (
                  <audio
                    key={segment.clip.id}
                    ref={bindMedia(segment.clip)}
                    src={segment.clip.resource.src}
                    preload="auto"
                    onLoadedMetadata={(event) =>
                      mediaReady(
                        event.currentTarget,
                        segment.clip,
                        segment.start,
                      )
                    }
                    onError={() => {
                      setPlaying(false);
                      setError(t("timeline.player.audioError"));
                    }}
                  />
                ))}
              </div>
            </div>
            {currentVisual && !currentVisual.clip.resource.src && (
              <p role="alert" className="cw-domain-note">
                {t("timeline.player.sourceUnavailable")}
              </p>
            )}
            <div className="cw-timeline-transport">
              <button
                aria-label={t("timeline.player.start")}
                onClick={() => seek(0)}
                disabled={!duration}
              >
                ↤
              </button>
              <button
                className="cw-timeline-play"
                aria-label={
                  playing
                    ? t("timeline.player.pause")
                    : t("timeline.player.play")
                }
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
                {t("timeline.player.fps")}
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
              aria-label={t("timeline.player.seek")}
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
              <h3>
                {selected
                  ? t("timeline.properties.title")
                  : t("timeline.properties.project")}
              </h3>
            </div>
            {selectedText ? (
              <TimelineTextInspector
                onValidityChange={setTextInputValid}
                onError={(reason) => setError(reason.message)}
                onDraftChange={setTextInputDirty}
                timeline={timeline}
                overlay={selectedText}
                onChange={(patch, gesture) => {
                  if (!Object.keys(patch).length) {
                    coalesce.current = null;
                    return;
                  }
                  change(
                    (current) =>
                      updateTimelineText(current, selectedText.id, patch),
                    gesture && `${gesture}:${selectedText.id}`,
                  );
                }}
                onDelete={() => {
                  change((current) =>
                    removeTimelineText(current, selectedText.id),
                  );
                  setSelection(null);
                }}
                onReorder={(delta) =>
                  change((current) => {
                    const ids = current.overlays!.map((o) => o.id),
                      index = ids.indexOf(selectedText.id),
                      target = index + delta;
                    if (target < 0 || target >= ids.length) return current;
                    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
                    return reorderTimelineText(current, ids);
                  })
                }
              />
            ) : selected ? (
              <>
                <strong>{selected.clip.resource.title}</strong>
                <p className="cw-domain-note">
                  {t("timeline.properties.playback", {
                    track: trackTitle(selected.track),
                    seconds: clipDuration(selected.clip).toFixed(2),
                  })}
                </p>
                {selected.clip.resource.kind !== "image" && (
                  <label className="cw-domain-field">
                    {t("timeline.properties.inPoint")}
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
                    ? t("timeline.properties.duration")
                    : t("timeline.properties.outPoint")}
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
                    {t("timeline.properties.speed")}
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
                    {t("timeline.properties.start")}
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
                      {t("timeline.properties.volume", {
                        percent: Math.round(selected.clip.volume * 100),
                      })}
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
                      {t("timeline.properties.mute")}
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
                        ? t("timeline.properties.nudgeAudioBack")
                        : t("timeline.properties.nudgeClipBack")
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
                        ? t("timeline.properties.nudgeAudioForward")
                        : t("timeline.properties.nudgeClipForward")
                    }
                  >
                    →
                  </button>
                  <button
                    onClick={() => {
                      change((current) =>
                        removeTimelineClip(current, selected.clip.id),
                      );
                      setSelection(null);
                    }}
                  >
                    {t("timeline.properties.delete")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <label className="cw-domain-field">
                  {t("timeline.properties.aspect")}
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
                        {t("timeline.properties.importSize", {
                          width: timeline.width,
                          height: timeline.height,
                        })}
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
                  {t("timeline.properties.hint")}
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
            {libraryShown
              ? t("timeline.toolbar.hideLibrary")
              : t("timeline.toolbar.showLibrary")}
          </button>
          <button
            disabled={!history.current.past.length || busy}
            onClick={() => historyStep("undo")}
          >
            {t("timeline.toolbar.undo")}
          </button>
          <button
            disabled={!history.current.future.length || busy}
            onClick={() => historyStep("redo")}
          >
            {t("timeline.toolbar.redo")}
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
            {t("timeline.toolbar.split")}
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
            {t("timeline.toolbar.trimLeft")}
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
            {t("timeline.toolbar.trimRight")}
          </button>
          <label className="cw-timeline-snap">
            <input
              type="checkbox"
              checked={snapping}
              onChange={(event) => setSnapping(event.target.checked)}
            />
            {t("timeline.toolbar.snap")}
          </label>
          <label className="cw-timeline-zoom">
            {t("timeline.toolbar.zoom")}
            <input
              aria-label={t("timeline.toolbar.zoom")}
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
            {t("timeline.toolbar.fit")}
          </button>
        </div>
        <div className="cw-timeline-drag-status" role="status">
          {dragMessage}
        </div>
        <div
          className="cw-timeline-height-resizer"
          role="separator"
          aria-label={t("timeline.toolbar.resize")}
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
            aria-label={t("timeline.track.region")}
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
              <span>{t("timeline.track.header")}</span>
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
            <TimelineTextLane
              {...textCallbacks}
              timeline={dragPreview ?? timeline}
              pixelsPerSecond={pixelsPerSecond}
              visibleDuration={visibleDuration}
              position={position}
            />
            {timeline.tracks.map((track) => (
              <div className="cw-timeline-track" key={track.id}>
                <div className="cw-timeline-track-label">
                  <span>{trackTitle(track)}</span>
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
                    aria-label={t(
                      track.muted
                        ? "timeline.track.unmute"
                        : "timeline.track.mute",
                      { title: trackTitle(track) },
                    )}
                  >
                    {track.muted
                      ? t("timeline.track.muted")
                      : t("timeline.track.audible")}
                  </button>
                  {track.kind === "audio" && (
                    <button
                      aria-label={t("timeline.track.delete", {
                        title: trackTitle(track),
                      })}
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
                            setSelection({ kind: "clip", id: segment.clip.id });
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
                          setGestureActivity(true);
                          setSelection({ kind: "clip", id: segment.clip.id });
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
          {t("timeline.track.dragHint")}
        </p>
        <input
          className="cw-domain-file-input"
          ref={nativePackageInput}
          type="file"
          accept="application/zip,.zip"
          aria-label={t("timeline.package.importAria")}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) importEditablePackage(file);
            event.target.value = "";
          }}
        />
        <input
          className="cw-domain-file-input"
          ref={jsonInput}
          type="file"
          accept="application/json,.json"
          aria-label={t("timeline.action.importJsonAria")}
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
          aria-label={t("timeline.action.importMediaAria")}
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
