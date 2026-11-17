import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { TimelineData } from "./model.ts";
import {
  drawTimelineText,
  prepareTimelineFonts,
  type TimelineFontSession,
} from "./timelineTextRenderer.ts";

export interface TimelineTextPreviewProps {
  timeline: TimelineData;
  position: number;
  className?: string;
  style?: CSSProperties;
  onError?: (error: Error) => void;
}

/** Intrinsic output pixels; the editor positions/scales this transparent overlay. */
export function TimelineTextPreview({
  timeline,
  position,
  className,
  style,
  onError,
}: TimelineTextPreviewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const errorCallback = useRef(onError);
  errorCallback.current = onError;
  const [fonts, setFonts] = useState<{
    key: symbol;
    session: TimelineFontSession;
  } | null>(null);
  const usedFontIds = useMemo(
    () =>
      JSON.stringify(
        [
          ...new Set(
            (timeline.overlays ?? []).map((overlay) => overlay.fontId),
          ),
        ].sort(),
      ),
    [timeline.overlays],
  );
  // Immutable resource views keep their array identity during playback. Use a
  // compact token instead of serializing src: archive fonts can be large data URLs.
  const fontKey = useMemo(
    () => Symbol("timelineFonts"),
    [timeline.fonts, usedFontIds],
  );
  useEffect(() => {
    const controller = new AbortController();
    let session: TimelineFontSession | undefined;
    setFonts(null);
    void prepareTimelineFonts(timeline, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) {
          value.dispose();
          return;
        }
        session = value;
        setFonts({ key: fontKey, session: value });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          errorCallback.current?.(
            error instanceof Error ? error : new Error(String(error)),
          );
      });
    return () => {
      controller.abort();
      session?.dispose();
    };
  }, [fontKey]);
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, timeline.width, timeline.height);
    if (!fonts || fonts.key !== fontKey) return;
    try {
      drawTimelineText(
        context,
        timeline,
        Math.floor(position * timeline.fps + 1e-9),
        fonts.session,
      );
    } catch (error) {
      errorCallback.current?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }, [timeline, position, fonts, fontKey]);
  return (
    <canvas
      ref={canvas}
      width={timeline.width}
      height={timeline.height}
      className={className}
      aria-hidden="true"
      style={{ width: "100%", height: "100%", pointerEvents: "none", ...style }}
    />
  );
}
