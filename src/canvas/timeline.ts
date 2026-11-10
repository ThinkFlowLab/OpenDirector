import {
  copyResource,
  copyTimeline,
  timelineError,
  timelineImportedAssets,
} from "./dataBoundary.ts";
import { tNow } from "../i18n/messages.ts";
import type {
  CanvasResource,
  TimelineClip,
  TimelineData,
  TimelineTrack,
} from "./model.ts";

export interface TimelineSegment {
  track: TimelineTrack;
  clip: TimelineClip;
  start: number;
  end: number;
}

export function clipDuration(clip: TimelineClip): number {
  return (clip.outPoint - clip.inPoint) / clip.speed;
}

/** Visual clips are consecutive; audio clips retain their explicit timeline positions. */
export function timelineSegments(timeline: TimelineData): TimelineSegment[] {
  return timeline.tracks.flatMap((track) => {
    let cursor = 0;
    return track.clips.map((clip) => {
      const start = track.kind === "visual" ? cursor : clip.start!;
      const end = start + clipDuration(clip);
      cursor = end;
      return { track, clip, start, end };
    });
  });
}

export function timelineDuration(timeline: TimelineData): number {
  return Math.max(
    0,
    ...timelineSegments(timeline).map((segment) => segment.end),
    ...(timeline.overlays ?? []).map((overlay) => overlay.end),
  );
}

function checked(value: TimelineData): TimelineData {
  const error = timelineError(value);
  if (error) throw new Error(error);
  return value;
}

export type TimelineLibrarySource = "all" | "canvas" | "imported";
export type TimelineLibraryKind = "all" | "image" | "video" | "audio";

/** Select by library ownership before deduplicating: a canvas source may also be imported. */
export function timelineLibraryResources(
  timeline: TimelineData,
  canvasResources: readonly CanvasResource[],
  source: TimelineLibrarySource = "all",
  kind: TimelineLibraryKind = "all",
): CanvasResource[] {
  const owned =
    source === "canvas"
      ? canvasResources
      : source === "imported"
        ? timelineImportedAssets(timeline)
        : [...canvasResources, ...timelineImportedAssets(timeline)];
  return [
    ...new Map(
      owned.map((resource) => [
        `${resource.kind}:${resource.src ?? resource.id}`,
        resource,
      ]),
    ).values(),
  ].filter(
    (resource) =>
      ["image", "video", "audio"].includes(resource.kind) &&
      (kind === "all" || resource.kind === kind),
  );
}

export function retainTimelineAsset(
  timeline: TimelineData,
  resource: CanvasResource,
): TimelineData {
  if (!["image", "video", "audio"].includes(resource.kind))
    throw new Error(tNow("errors.timeline.libraryKind"));
  const assets = timelineImportedAssets(timeline);
  const same = (item: CanvasResource) =>
    item.kind === resource.kind &&
    (resource.src ? item.src === resource.src : item.id === resource.id);
  return checked({
    ...timeline,
    importedAssets: assets.some(same)
      ? [...assets]
      : [...assets, copyResource(resource)],
  });
}

/** Removing a library entry never removes clips that already own a source snapshot. */
export function removeTimelineAsset(
  timeline: TimelineData,
  id: string,
): TimelineData {
  return {
    ...timeline,
    importedAssets: timelineImportedAssets(timeline).filter(
      (asset) => asset.id !== id,
    ),
  };
}

export function addTimelineClip(
  timeline: TimelineData,
  resource: CanvasResource,
  trackId?: string,
): TimelineData {
  const kind = resource.kind === "audio" ? "audio" : "visual";
  if (!["image", "video", "audio"].includes(resource.kind))
    throw new Error(tNow("errors.timeline.kind"));
  let next = retainTimelineAsset(timeline, resource);
  let track = trackId
    ? next.tracks.find((track) => track.id === trackId)
    : next.tracks.find((track) => track.kind === kind);
  if (!track && kind === "audio" && !trackId) {
    track = {
      id: crypto.randomUUID(),
      kind: "audio",
      title: "",
      muted: false,
      clips: [],
    };
    next = { ...next, tracks: [...next.tracks, track] };
  }
  if (!track || track.kind !== kind)
    throw new Error(tNow("errors.timeline.trackKind"));
  if (resource.kind !== "image" && resource.durationSeconds === undefined)
    throw new Error(tNow("errors.timeline.duration"));
  const end = Math.max(
    0,
    ...timelineSegments(next)
      .filter((segment) => segment.track.id === track.id)
      .map((segment) => segment.end),
  );
  const clip: TimelineClip = {
    id: crypto.randomUUID(),
    resource: copyResource(resource),
    inPoint: 0,
    outPoint: resource.kind === "image" ? 5 : resource.durationSeconds!,
    speed: 1,
    volume: 1,
    muted: false,
    ...(kind === "audio" ? { start: end } : {}),
  };
  return checked({
    ...next,
    tracks: next.tracks.map((item) =>
      item.id === track.id ? { ...item, clips: [...item.clips, clip] } : item,
    ),
  });
}

export function updateTimelineClip(
  timeline: TimelineData,
  clipId: string,
  patch: Partial<
    Pick<
      TimelineClip,
      "inPoint" | "outPoint" | "speed" | "start" | "volume" | "muted"
    >
  >,
): TimelineData {
  return checked({
    ...timeline,
    tracks: timeline.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) =>
        clip.id === clipId ? { ...clip, ...patch } : clip,
      ),
    })),
  });
}

export function removeTimelineClip(
  timeline: TimelineData,
  clipId: string,
): TimelineData {
  return {
    ...timeline,
    importedAssets: [...timelineImportedAssets(timeline)],
    tracks: timeline.tracks.map((track) => ({
      ...track,
      clips: track.clips.filter((clip) => clip.id !== clipId),
    })),
  };
}

/** Magnetic snapping is separate from frame alignment and can be disabled by the editor. */
export function snapTimelineTime(
  timeline: TimelineData,
  time: number,
  options: {
    enabled: boolean;
    pixelsPerSecond: number;
    playhead: number;
    clipId?: string;
    duration?: number;
  },
): number {
  if (!Number.isFinite(time)) throw new Error(tNow("errors.timeline.finite"));
  const rounded = Math.max(0, Math.round(time * timeline.fps) / timeline.fps);
  if (!options.enabled) return rounded;
  const threshold = 8 / Math.max(0.01, options.pixelsPerSecond);
  const anchors = [
    0,
    options.playhead,
    ...timelineSegments(timeline)
      .filter((item) => item.clip.id !== options.clipId)
      .flatMap((item) => [item.start, item.end]),
  ];
  let best = rounded,
    distance = threshold;
  for (const anchor of anchors) {
    for (const candidate of [anchor, anchor - (options.duration ?? 0)]) {
      if (candidate < 0) continue;
      const difference = Math.abs(candidate - time);
      if (difference <= distance) {
        best = candidate;
        distance = difference;
      }
    }
  }
  return Math.max(0, Math.round(best * timeline.fps) / timeline.fps);
}

export function timelineRulerStep(
  pixelsPerSecond: number,
  fps: number,
): number {
  const minimum = 70 / Math.max(0.01, pixelsPerSecond);
  return (
    [
      1 / fps,
      5 / fps,
      10 / fps,
      0.5,
      1,
      2,
      5,
      10,
      15,
      30,
      60,
      120,
      300,
      600,
      1800,
      3600,
    ].find((step) => step >= minimum) ?? Math.ceil(minimum / 3600) * 3600
  );
}

/** Ordering changes visual placement; audio ordering keeps explicit placement untouched. */
export function moveTimelineClip(
  timeline: TimelineData,
  clipId: string,
  direction: -1 | 1,
): TimelineData {
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) => {
      const index = track.clips.findIndex((clip) => clip.id === clipId),
        target = index + direction;
      if (index < 0 || target < 0 || target >= track.clips.length) return track;
      const clips = [...track.clips];
      [clips[index], clips[target]] = [clips[target]!, clips[index]!];
      return { ...track, clips };
    }),
  };
}

/** Drop placement is owned here: visual order versus frame-aligned audio time. */
export function placeTimelineClip(
  timeline: TimelineData,
  clipId: string,
  trackId: string,
  time: number,
): TimelineData {
  if (!Number.isFinite(time))
    throw new Error(tNow("errors.timeline.dropFinite"));
  const segments = timelineSegments(timeline);
  const source = segments.find((segment) => segment.clip.id === clipId);
  const target = timeline.tracks.find((track) => track.id === trackId);
  if (!source || !target) throw new Error(tNow("errors.timeline.dropTarget"));
  if (source.track.kind !== target.kind)
    throw new Error(tNow("errors.timeline.sameKind"));
  const remaining = target.clips.filter((clip) => clip.id !== clipId);
  let placed = source.clip;
  let index: number;
  if (target.kind === "audio") {
    const start = Math.max(0, Math.round(time * timeline.fps) / timeline.fps);
    if (target.id === source.track.id && start === source.start)
      return timeline;
    placed = { ...source.clip, start };
    index = remaining.findIndex((clip) => clip.start! > start);
  } else {
    // Use the original target midpoints, so dragging a clip does not move its drop targets.
    const next = segments.find(
      (segment) =>
        segment.track.id === target.id &&
        segment.clip.id !== clipId &&
        time < (segment.start + segment.end) / 2,
    );
    index = next ? remaining.findIndex((clip) => clip.id === next.clip.id) : -1;
  }
  remaining.splice(index < 0 ? remaining.length : index, 0, placed);
  if (
    target.id === source.track.id &&
    remaining.every((clip, i) => clip === target.clips[i])
  )
    return timeline;
  return checked({
    ...timeline,
    tracks: timeline.tracks.map((track) =>
      track.id === trackId
        ? { ...track, clips: remaining }
        : track.id === source.track.id
          ? {
              ...track,
              clips: track.clips.filter((clip) => clip.id !== clipId),
            }
          : track,
    ),
  });
}

export function addAudioTrack(timeline: TimelineData): TimelineData {
  return {
    ...timeline,
    tracks: [
      ...timeline.tracks,
      {
        id: crypto.randomUUID(),
        kind: "audio",
        title: "",
        muted: false,
        clips: [],
      },
    ],
  };
}

export const TIMELINE_TEXT_CAPABILITY = "timeline.text.v1";

export function timelineHasTextResources(timeline: TimelineData): boolean {
  return Boolean(timeline.fonts?.length || timeline.overlays?.length);
}

export function exportTimeline(timeline: TimelineData, title: string): string {
  checked(timeline);
  return JSON.stringify(
    {
      format: "opendirector-editable-timeline",
      version: timelineHasTextResources(timeline) ? 2 : 1,
      ...(timelineHasTextResources(timeline)
        ? { requiredCapabilities: [TIMELINE_TEXT_CAPABILITY] }
        : {}),
      resourceScope: "same-project",
      resourcesEmbedded: false,
      title,
      timeUnit: "seconds",
      description:
        "Local editable composition, not a rendered video or original Jianying draft.",
      timeline: copyTimeline(timeline),
    },
    null,
    2,
  );
}

/** Split at the timeline playhead, converting timeline time back into source trim time. */
export function splitTimelineClip(
  timeline: TimelineData,
  clipId: string,
  playhead: number,
): TimelineData {
  const segment = timelineSegments(timeline).find(
    (item) => item.clip.id === clipId,
  );
  if (
    !segment ||
    !Number.isFinite(playhead) ||
    playhead <= segment.start ||
    playhead >= segment.end
  )
    throw new Error(tNow("errors.timeline.playheadInside"));
  const { clip } = segment,
    offset = playhead - segment.start;
  const image = clip.resource.kind === "image";
  const sourceCut = clip.inPoint + offset * clip.speed;
  const first = { ...clip, outPoint: image ? offset : sourceCut };
  const second = {
    ...clip,
    id: crypto.randomUUID(),
    resource: copyResource(clip.resource),
    inPoint: image ? 0 : sourceCut,
    outPoint: image ? clipDuration(clip) - offset : clip.outPoint,
    ...(segment.track.kind === "audio" ? { start: playhead } : {}),
  };
  return checked({
    ...timeline,
    tracks: timeline.tracks.map((track) =>
      track.id !== segment.track.id
        ? track
        : {
            ...track,
            clips: track.clips.flatMap((item) =>
              item.id === clipId ? [first, second] : [item],
            ),
          },
    ),
  });
}

/** Trim discards the part on the named side. Visual tracks ripple; audio keeps its explicit placement. */
export function trimTimelineClip(
  timeline: TimelineData,
  clipId: string,
  playhead: number,
  side: "left" | "right",
): TimelineData {
  const segment = timelineSegments(timeline).find(
    (item) => item.clip.id === clipId,
  );
  if (
    !segment ||
    !Number.isFinite(playhead) ||
    playhead <= segment.start ||
    playhead >= segment.end
  )
    throw new Error(tNow("errors.timeline.playheadInside"));
  const { clip } = segment,
    offset = playhead - segment.start;
  if (clip.resource.kind === "image")
    return updateTimelineClip(timeline, clipId, {
      outPoint: side === "left" ? clipDuration(clip) - offset : offset,
    });
  const sourceCut = clip.inPoint + offset * clip.speed;
  return updateTimelineClip(
    timeline,
    clipId,
    side === "right"
      ? { outPoint: sourceCut }
      : {
          inPoint: sourceCut,
          ...(segment.track.kind === "audio" ? { start: playhead } : {}),
        },
  );
}

export function importTimeline(text: string): TimelineData {
  const value: unknown = JSON.parse(text);
  if (
    !value ||
    typeof value !== "object" ||
    !("format" in value) ||
    value.format !== "opendirector-editable-timeline" ||
    !("version" in value) ||
    (value.version !== 1 && value.version !== 2) ||
    !("timeUnit" in value) ||
    value.timeUnit !== "seconds" ||
    !("timeline" in value)
  )
    throw new Error(tNow("errors.timeline.importJson"));
  const capabilities =
    "requiredCapabilities" in value ? value.requiredCapabilities : [];
  if (
    !Array.isArray(capabilities) ||
    capabilities.some(
      (capability) => capability !== TIMELINE_TEXT_CAPABILITY,
    ) ||
    (value.version === 2 && !capabilities.includes(TIMELINE_TEXT_CAPABILITY))
  )
    throw new Error(tNow("errors.timeline.capabilityUnsupported"));
  const error = timelineError(value.timeline);
  if (error) throw new Error(error);
  const timeline = value.timeline as TimelineData;
  if (value.version === 1 && timelineHasTextResources(timeline))
    throw new Error(tNow("errors.timeline.importJson"));
  return copyTimeline(timeline);
}
