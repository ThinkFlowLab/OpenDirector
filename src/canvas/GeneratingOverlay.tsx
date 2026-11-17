import { useEffect, useRef, useState } from "react";
import { estimatedProgress } from "./generationDurations";
import {
  GENERATION_LABELS,
  type NodeGenerationActivity,
} from "./generationActivity";
import { useT } from "../i18n/I18nProvider.tsx";
import "./generating.css";

const RADIUS = 11;

/** The node outline from its top-left corner, clockwise, as one path of length 100. */
function outline(width: number, height: number, inset: number) {
  const r = Math.max(0, Math.min(RADIUS - inset, width / 2, height / 2));
  const x0 = inset,
    y0 = inset,
    x1 = width - inset,
    y1 = height - inset;
  // Start at the middle of the top-left arc so the ring begins at the corner itself.
  const k = r * (1 - Math.SQRT1_2);
  return [
    `M${x0 + k},${y0 + k}`,
    `A${r},${r} 0 0 1 ${x0 + r},${y0}`,
    `H${x1 - r}`,
    `A${r},${r} 0 0 1 ${x1},${y0 + r}`,
    `V${y1 - r}`,
    `A${r},${r} 0 0 1 ${x1 - r},${y1}`,
    `H${x0 + r}`,
    `A${r},${r} 0 0 1 ${x0},${y1 - r}`,
    `V${y0 + r}`,
    `A${r},${r} 0 0 1 ${x0 + k},${y0 + k}`,
  ].join(" ");
}

function useProgress(activity: NodeGenerationActivity) {
  const { startedAt, expectedMs, phase } = activity;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (startedAt === undefined || expectedMs === undefined) return null;
  const estimate = estimatedProgress(now - startedAt, expectedMs);
  // Reading and saving the result is the last step of the work.
  return phase === "finishing" ? Math.max(estimate, 0.98) : estimate;
}

function ProgressRing({ progress }: { progress: number }) {
  const svg = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      setSize({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const path =
    size.width && size.height ? outline(size.width, size.height, 1) : "";
  return (
    <svg ref={svg} className="cw-generating-ring" aria-hidden="true">
      {path && (
        <>
          <path
            className="cw-generating-ring-track"
            d={path}
            pathLength={100}
          />
          <path
            className="cw-generating-ring-progress"
            d={path}
            pathLength={100}
            strokeDasharray="100 100"
            strokeDashoffset={100 - progress * 100}
          />
        </>
      )}
    </svg>
  );
}

export function GeneratingOverlay({
  activity,
  hasAsset,
  progress: actualProgress,
  label,
}: {
  activity: NodeGenerationActivity;
  hasAsset: boolean;
  progress?: number;
  label?: string;
}) {
  const t = useT();
  const estimate = useProgress(activity);
  const progress = actualProgress ?? estimate;
  return (
    <div
      className={`cw-generating${hasAsset ? " cw-generating-with-asset" : ""}`}
      data-phase={activity.phase}
      data-started-at={activity.startedAt}
      data-expected-ms={activity.expectedMs}
    >
      <div className="cw-generating-field" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="cw-generating-stars" aria-hidden="true" />
      <div className="cw-generating-sheen" aria-hidden="true" />
      {progress !== null && <ProgressRing progress={progress} />}
      <div className="cw-generating-caption" role="status" aria-atomic="true">
        <span className="cw-generating-indicator" aria-hidden="true" />
        <span>{label ?? t(GENERATION_LABELS[activity.phase])}</span>
        {activity.count > 1 && (
          <span className="cw-generating-count">
            {t("generation.overlay.tasks", { count: activity.count })}
          </span>
        )}
      </div>
    </div>
  );
}
