import type { VideoAdapter, VideoCapabilities } from "./rules.ts";
import { tNow } from "../i18n/messages.ts";

export interface VideoOutputDraft {
  resolution: string;
  seconds: string;
  width: string;
  height: string;
}

export function parseVideoSeconds(value: string): number[] {
  const result = new Set<number>();
  for (const token of value.trim().split(/[,，\s]+/)) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(token);
    if (!match)
      throw new Error(tNow("errors.videoCapabilities.durationFormat"));
    const start = Number(match[1]),
      end = Number(match[2] ?? match[1]);
    if (start < 1 || end > 60 || end < start)
      throw new Error(tNow("errors.videoCapabilities.durationRange"));
    for (let second = start; second <= end; second++) result.add(second);
  }
  return [...result].sort((a, b) => a - b);
}

export function videoOutputDrafts(
  caps: VideoCapabilities | null | undefined,
): VideoOutputDraft[] {
  return (
    caps?.outputs.map((item) => ({
      resolution: item.resolution,
      seconds: item.durations.join(","),
      width: String(item.width ?? ""),
      height: String(item.height ?? ""),
    })) ?? [{ resolution: "", seconds: "", width: "", height: "" }]
  );
}

export function createVideoCapabilities(
  rows: VideoOutputDraft[],
  defaultResolution: string,
  defaultDuration: number,
  dimensionStep: VideoCapabilities["dimensionStep"],
  adapter: VideoAdapter = "auto",
): VideoCapabilities {
  if (!rows.length || rows.length > 20)
    throw new Error(tNow("errors.videoCapabilities.outputCount"));
  const outputs = rows.map((row) => {
    const resolution = row.resolution.trim().toUpperCase();
    if (
      !/^[A-Z0-9][A-Z0-9_.-]{0,23}$/.test(resolution) ||
      resolution === "AUTO"
    )
      throw new Error(tNow("errors.videoCapabilities.resolutionName"));
    const durations = parseVideoSeconds(row.seconds);
    if (Boolean(row.width.trim()) !== Boolean(row.height.trim()))
      throw new Error(tNow("errors.videoCapabilities.pixelPair"));
    if (!row.width.trim()) {
      // The /videos resolver needs pixels except for the two H3 buckets it
      // derives itself; saving anything else would only fail at generation.
      const derived =
        (adapter === "fasth3" || adapter === "fasth3_dual" || adapter === "minimax_h3") &&
        (resolution === "480P" || resolution === "768P");
      if (!derived)
        throw new Error(
          tNow("errors.videoCapabilities.pixelRequired"),
        );
      return { resolution, durations };
    }
    const width = Number(row.width),
      height = Number(row.height);
    if (
      ![width, height].every(
        (edge) =>
          Number.isInteger(edge) &&
          edge >= 64 &&
          edge <= 8192 &&
          edge % dimensionStep === 0,
      ) ||
      width < height
    )
      throw new Error(
        tNow("errors.videoCapabilities.pixelBounds"),
      );
    return { resolution, durations, width, height };
  });
  if (new Set(outputs.map((item) => item.resolution)).size !== outputs.length)
    throw new Error(tNow("errors.videoCapabilities.duplicateResolution"));
  if (
    !outputs.some(
      (item) =>
        (defaultResolution === "auto" ||
          item.resolution === defaultResolution) &&
        item.durations.includes(defaultDuration),
    )
  )
    throw new Error(tNow("errors.videoCapabilities.defaultOutput"));
  return { outputs, defaultResolution, defaultDuration, dimensionStep };
}
