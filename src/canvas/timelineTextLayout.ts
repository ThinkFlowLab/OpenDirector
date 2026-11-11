import type { TimelineTextOverlayView } from "./model.ts";
export interface TimelineTextLayout {
  lines: { text: string; x: number; baseline: number; width: number }[];
  background?: {
    x: number;
    y: number;
    width: number;
    height: number;
    color: string;
    opacity: number;
  };
  stroke?: { color: string; width: number };
  overflow: boolean;
}
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Output pixel geometry only; callers measure with the explicitly loaded font. */
export function layoutTimelineText(
  overlay: TimelineTextOverlayView,
  size: { width: number; height: number },
  measure: (text: string) => number,
): TimelineTextLayout {
  const { style } = overlay;
  const width = overlay.maxWidth * size.width;
  const x = overlay.x * size.width,
    y = overlay.y * size.height;
  const lineHeight = style.fontSize * style.lineHeight;
  const texts: string[] = [];
  for (const paragraph of overlay.text.replace(/\r\n?/g, "\n").split("\n")) {
    // Keep Latin words together. Other scripts wrap at grapheme boundaries.
    const tokens: string[] = [];
    for (const { segment } of graphemes.segment(paragraph)) {
      const previous = tokens.at(-1);
      if (
        previous &&
        ((/^[\p{Script=Latin}\p{Number}\p{Mark}]+$/u.test(previous) &&
          /^[\p{Script=Latin}\p{Number}\p{Mark}]+$/u.test(segment)) ||
          (/^\s+$/u.test(previous) && /^\s+$/u.test(segment)))
      )
        tokens[tokens.length - 1] += segment;
      else tokens.push(segment);
    }
    let line = "",
      spaces = "";
    const flush = () => {
      texts.push(line);
      line = "";
      spaces = "";
    };
    for (const token of tokens) {
      if (/^\s+$/u.test(token)) {
        spaces += token;
        continue;
      }
      const candidate = line + spaces + token;
      if (measure(candidate) <= width) {
        line = candidate;
        spaces = "";
        continue;
      }
      if (line) flush();
      spaces = "";
      if (measure(token) <= width) {
        line = token;
        continue;
      }
      for (const { segment } of graphemes.segment(token)) {
        if (line && measure(line + segment) > width) flush();
        line += segment;
      }
    }
    texts.push(line);
  }
  const lines = texts.map((text, index) => {
    const measured = measure(text);
    const offset =
      style.align === "right"
        ? width - measured
        : style.align === "center"
          ? (width - measured) / 2
          : 0;
    return {
      text,
      width: measured,
      x: x + offset,
      baseline:
        y +
        (lineHeight - style.fontSize) / 2 +
        style.fontSize +
        index * lineHeight,
    };
  });
  const height = lines.length * lineHeight;
  const padding = style.background?.padding ?? 0;
  const stroke = style.stroke ? { ...style.stroke } : undefined;
  const extent = Math.max(padding, (stroke?.width ?? 0) / 2);
  return {
    lines,
    ...(style.background
      ? {
          background: {
            x: x - padding,
            y: y - padding,
            width: width + padding * 2,
            height: height + padding * 2,
            color: style.background.color,
            opacity: style.background.opacity,
          },
        }
      : {}),
    ...(stroke ? { stroke } : {}),
    overflow:
      x - extent < 0 ||
      y - extent < 0 ||
      x + width + extent > size.width ||
      y + height + extent > size.height ||
      lines.some((line) => line.width > width),
  };
}
