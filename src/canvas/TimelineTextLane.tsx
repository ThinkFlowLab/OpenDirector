import { useEffect, useRef, type PointerEvent } from "react";
import { useI18n } from "../i18n/I18nProvider.tsx";
import type { TimelineData } from "./model.ts";
import {
  activeTimelineText,
  updateTimelineText,
  type TimelineTextPatch,
} from "./timelineText.ts";
interface Props {
  timeline: TimelineData;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPreview: (timeline: TimelineData | null) => void;
  onCommit: (id: string, patch: TimelineTextPatch) => void;
  onGestureChange: (pending: boolean) => void;
}
/** Pointer samples remain transient. Only pointer-up submits a single draft edit. */
function useTextDrag({
  timeline,
  onPreview,
  onCommit,
  onGestureChange,
}: Props) {
  const drag = useRef<{
    pointer: number;
    element: HTMLElement;
    id: string;
    origin: TimelineData;
    x: number;
    y: number;
    patch: TimelineTextPatch | null;
    update: (dx: number, dy: number) => TimelineTextPatch;
  } | null>(null);
  const cancel = () => {
    const d = drag.current;
    drag.current = null;
    onPreview(null);
    if (d) onGestureChange(false);
    if (d?.element.hasPointerCapture(d.pointer))
      d.element.releasePointerCapture(d.pointer);
  };
  useEffect(() => {
    window.addEventListener("blur", cancel);
    return () => window.removeEventListener("blur", cancel);
  }, []);
  const begin = (
    e: PointerEvent<HTMLElement>,
    id: string,
    update: (dx: number, dy: number) => TimelineTextPatch,
  ) => {
    if (e.button !== 0 || drag.current) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = {
      pointer: e.pointerId,
      element: e.currentTarget,
      id,
      origin: timeline,
      x: e.clientX,
      y: e.clientY,
      patch: null,
      update,
    };
    onGestureChange(true);
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    e.stopPropagation();
    if (!d.patch && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 2) return;
    try {
      const patch = d.update(e.clientX - d.x, e.clientY - d.y);
      const next = updateTimelineText(d.origin, d.id, patch);
      d.patch = patch;
      onPreview(next);
    } catch {
      /* Invalid time or bounds retain the last valid sample. */
    }
  };
  const finish = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    move(e);
    e.stopPropagation();
    // Commit before releasing the gesture guard, so a remote refresh observes
    // the completed local draft rather than rebasing its original intent.
    if (d.patch) onCommit(d.id, d.patch);
    cancel();
  };
  return {
    begin,
    handlers: {
      onPointerMove: move,
      onPointerUp: finish,
      onPointerCancel: cancel,
      onLostPointerCapture: cancel,
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === "Escape" && drag.current) {
          e.preventDefault();
          e.stopPropagation();
          cancel();
        }
      },
    },
  };
}
export function TimelineTextLane(
  props: Props & {
    pixelsPerSecond: number;
    visibleDuration: number;
    position: number;
  },
) {
  const { t } = useI18n(),
    {
      timeline,
      selectedId,
      onSelect,
      pixelsPerSecond,
      visibleDuration,
      position,
    } = props;
  const { begin, handlers } = useTextDrag(props);
  return (
    <section
      className="cw-timeline-text-lanes"
      aria-label={t("timeline.text.lane")}
    >
      {(timeline.overlays ?? []).map((o, index) => (
        <div className="cw-timeline-track" key={o.id}>
          <div className="cw-timeline-track-label">
            <span>
              {t("timeline.text.lane")} {index + 1}
            </span>
          </div>
          <div className="cw-timeline-track-lane cw-timeline-text-row">
            <div
              className="cw-timeline-playhead"
              style={{ left: `${(position / visibleDuration) * 100}%` }}
            />
            <div
              className={`cw-timeline-text-item${selectedId === o.id ? " selected" : ""}`}
              data-text-id={o.id}
              style={{
                left: `${(o.start / visibleDuration) * 100}%`,
                width: `${((o.end - o.start) / visibleDuration) * 100}%`,
              }}
            >
              <button
                className="cw-timeline-text-trim"
                aria-label={t("timeline.text.resizeStart")}
                onPointerDown={(e) => {
                  onSelect(o.id);
                  begin(e, o.id, (dx) => ({
                    start: Math.max(
                      0,
                      Math.min(
                        o.end - 1 / timeline.fps,
                        Math.round(
                          (o.start + dx / pixelsPerSecond) * timeline.fps,
                        ) / timeline.fps,
                      ),
                    ),
                  }));
                }}
                {...handlers}
              >
                ↤
              </button>
              <button
                className="cw-timeline-text-move"
                title={t("timeline.text.move")}
                onClick={() => onSelect(o.id)}
                onPointerDown={(e) => {
                  onSelect(o.id);
                  begin(e, o.id, (dx) => {
                    const start = Math.max(
                      0,
                      Math.round(
                        (o.start + dx / pixelsPerSecond) * timeline.fps,
                      ) / timeline.fps,
                    );
                    return { start, end: start + o.end - o.start };
                  });
                }}
                {...handlers}
              >
                {o.text}
              </button>
              <button
                className="cw-timeline-text-trim"
                aria-label={t("timeline.text.resizeEnd")}
                onPointerDown={(e) => {
                  onSelect(o.id);
                  begin(e, o.id, (dx) => ({
                    end: Math.max(
                      o.start + 1 / timeline.fps,
                      Math.round(
                        (o.end + dx / pixelsPerSecond) * timeline.fps,
                      ) / timeline.fps,
                    ),
                  }));
                }}
                {...handlers}
              >
                ↦
              </button>
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}
export function TimelineTextPosition(props: Props & { position: number }) {
  const { t } = useI18n(),
    { timeline, position, selectedId, onSelect } = props,
    { begin, handlers } = useTextDrag(props);
  return (
    <div className="cw-timeline-text-position">
      {activeTimelineText(
        timeline,
        Math.floor(position * timeline.fps + 1e-9),
      ).map((o) => (
        <button
          key={o.id}
          aria-label={`${t("timeline.text.position")}: ${o.text}`}
          className={selectedId === o.id ? "selected" : ""}
          style={{
            left: `${o.x * 100}%`,
            top: `${o.y * 100}%`,
            width: `${o.maxWidth * 100}%`,
            height: `${Math.max(((o.style.fontSize * o.style.lineHeight) / timeline.height) * 100, 8)}%`,
          }}
          onClick={() => onSelect(o.id)}
          onPointerDown={(e) => {
            const rect = e.currentTarget.parentElement!.getBoundingClientRect();
            onSelect(o.id);
            begin(e, o.id, (dx, dy) => ({
              x: Math.max(0, Math.min(1 - o.maxWidth, o.x + dx / rect.width)),
              y: Math.max(0, Math.min(1, o.y + dy / rect.height)),
            }));
          }}
          {...handlers}
        />
      ))}
    </div>
  );
}
