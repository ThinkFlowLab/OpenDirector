import { RULE_FACTS } from "../contracts/ruleFacts.generated.ts";
import { tNow } from "../i18n/messages.ts";
import type { TimelineData, TimelineTextOverlayView } from "./model.ts";

/** Half-open sampled output frames; FPS changes never rewrite stored seconds. */
export function timelineTextFrameRange(
  start: number,
  end: number,
  fps: number,
): readonly [number, number] {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    !Number.isSafeInteger(fps) ||
    fps <= 0 ||
    !Number.isFinite(start * fps) ||
    !Number.isFinite(end * fps)
  )
    throw new RangeError(tNow("errors.data.timelineShape"));
  const first = Math.ceil(start * fps - 1e-9),
    last = Math.ceil(end * fps - 1e-9);
  if (first >= last) throw new RangeError(tNow("errors.data.timelineShape"));
  return [first, last];
}

export function activeTimelineText(
  timeline: TimelineData,
  frame: number,
): readonly TimelineTextOverlayView[] {
  if (!Number.isSafeInteger(frame) || frame < 0) return [];
  return (timeline.overlays ?? []).filter((overlay) => {
    const [first, end] = timelineTextFrameRange(
      overlay.start,
      overlay.end,
      timeline.fps,
    );
    return first <= frame && frame < end;
  });
}

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const range = (v: unknown, low: number, high: number) =>
  typeof v === "number" && Number.isFinite(v) && v >= low && v <= high;
const identifier = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 100 && /\S/u.test(v);
const color = (v: unknown) => typeof v === "string" && /^#[a-f\d]{6}$/i.test(v);
const asset = (v: unknown, kind: string) =>
  record(v) &&
  v.kind === kind &&
  typeof v.assetId === "string" &&
  /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(v.assetId) &&
  Number.isSafeInteger(v.revision) &&
  Number(v.revision) > 0 &&
  typeof v.fingerprint === "string" &&
  /^sha256:[a-f\d]{64}$/.test(v.fingerprint);
const source = (v: unknown, kind: string) =>
  record(v) &&
  typeof v.title === "string" &&
  v.title.length <= 255 &&
  typeof v.mimeType === "string" &&
  v.mimeType.length > 0 &&
  (v.src === undefined || typeof v.src === "string") &&
  (v.importIdentity === undefined ||
    (typeof v.importIdentity === "string" &&
      v.importIdentity.length <= 512 &&
      /\S/u.test(v.importIdentity))) &&
  (v.asset === undefined || asset(v.asset, kind)) &&
  ((typeof v.src === "string" && v.src.length > 0) || v.asset !== undefined);

/** Client preflight; Python remains the final authority for saved documents. */
export function validTimelineText(value: {
  fps: number;
  fonts?: unknown;
  overlays?: unknown;
  tracks?: unknown;
}): boolean {
  const fonts = value.fonts === undefined ? [] : value.fonts,
    overlays = value.overlays === undefined ? [] : value.overlays;
  if (
    !Array.isArray(fonts) ||
    fonts.length > RULE_FACTS.timelineFontLimit ||
    !Array.isArray(overlays) ||
    overlays.length > RULE_FACTS.timelineOverlayLimit
  )
    return false;
  const ids = new Set<string>(),
    fontIds = new Set<string>();
  if (Array.isArray(value.tracks))
    for (const track of value.tracks) {
      if (record(track) && typeof track.id === "string") ids.add(track.id);
      if (record(track) && Array.isArray(track.clips))
        for (const clip of track.clips)
          if (record(clip) && typeof clip.id === "string") ids.add(clip.id);
    }
  for (const font of fonts) {
    if (
      !record(font) ||
      !identifier(font.id) ||
      ids.has(font.id) ||
      !source(font, "file")
    )
      return false;
    ids.add(font.id);
    fontIds.add(font.id);
  }
  let count = 0;
  for (const overlay of overlays) {
    if (
      !record(overlay) ||
      !identifier(overlay.id) ||
      ids.has(overlay.id) ||
      !identifier(overlay.fontId) ||
      !fontIds.has(overlay.fontId) ||
      typeof overlay.text !== "string" ||
      !overlay.text.trim() ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(overlay.text)
    )
      return false;
    ids.add(overlay.id);
    const normalized = overlay.text.replace(/\r\n?/g, "\n");
    const length = Array.from(normalized).length;
    count += length;
    if (
      length > RULE_FACTS.timelineTextMaxLength ||
      count > RULE_FACTS.timelineTextTotalLength ||
      !range(overlay.x, 0, 1) ||
      !range(overlay.y, 0, 1) ||
      !range(overlay.maxWidth, Number.MIN_VALUE, 1) ||
      Number(overlay.x) + Number(overlay.maxWidth) > 1 + 1e-9
    )
      return false;
    try {
      timelineTextFrameRange(
        overlay.start as number,
        overlay.end as number,
        value.fps,
      );
    } catch {
      return false;
    }
    const style = overlay.style;
    if (
      !record(style) ||
      !range(style.fontSize, 1, 512) ||
      !color(style.color) ||
      typeof style.align !== "string" ||
      !["left", "center", "right"].includes(style.align) ||
      !range(style.lineHeight, 0.8, 3)
    )
      return false;
    if (
      style.background != null &&
      (!record(style.background) ||
        !color(style.background.color) ||
        !range(style.background.opacity, 0, 1) ||
        !range(style.background.padding, 0, 128))
    )
      return false;
    if (
      style.stroke != null &&
      (!record(style.stroke) ||
        !color(style.stroke.color) ||
        !range(style.stroke.width, 0, 32))
    )
      return false;
    if (overlay.source !== undefined && !source(overlay.source, "text"))
      return false;
  }
  return true;
}

export type TimelineTextPatch = Partial<
  Pick<
    TimelineTextOverlayView,
    "text" | "start" | "end" | "x" | "y" | "maxWidth" | "fontId" | "style"
  >
>;
const invalidText = () => new RangeError(tNow("errors.data.timelineShape"));
function checkedText(timeline: TimelineData): TimelineData {
  if (!validTimelineText(timeline)) throw invalidText();
  return timeline;
}
export function addTimelineText(
  timeline: TimelineData,
  overlay: TimelineTextOverlayView,
): TimelineData {
  return checkedText({
    ...timeline,
    overlays: [...(timeline.overlays ?? []), structuredClone(overlay)],
  });
}
export function updateTimelineText(
  timeline: TimelineData,
  id: string,
  patch: TimelineTextPatch,
): TimelineData {
  const allowed = new Set([
    "text",
    "start",
    "end",
    "x",
    "y",
    "maxWidth",
    "fontId",
    "style",
  ]);
  if (
    Object.keys(patch).some((key) => !allowed.has(key)) ||
    !timeline.overlays?.some((o) => o.id === id)
  )
    throw invalidText();
  const original = timeline.overlays!.find((o) => o.id === id)!;
  const next = { ...original, ...structuredClone(patch) };
  if (JSON.stringify(original) === JSON.stringify(next)) return timeline;
  return checkedText({
    ...timeline,
    overlays: timeline.overlays!.map((o) => (o.id === id ? next : o)),
  });
}
export function removeTimelineText(
  timeline: TimelineData,
  id: string,
): TimelineData {
  if (!timeline.overlays?.some((o) => o.id === id)) return timeline;
  return checkedText({
    ...timeline,
    overlays: timeline.overlays.filter((o) => o.id !== id),
  });
}
export function reorderTimelineText(
  timeline: TimelineData,
  orderedIds: readonly string[],
): TimelineData {
  const byId = new Map((timeline.overlays ?? []).map((o) => [o.id, o]));
  if (
    byId.size !== orderedIds.length ||
    new Set(orderedIds).size !== orderedIds.length ||
    orderedIds.some((id) => !byId.has(id))
  )
    throw invalidText();
  if (orderedIds.every((id, index) => timeline.overlays?.[index]?.id === id))
    return timeline;
  return checkedText({
    ...timeline,
    overlays: orderedIds.map((id) => byId.get(id)!),
  });
}
