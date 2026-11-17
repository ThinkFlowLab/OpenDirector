import assert from "node:assert/strict";
import test from "node:test";
import { layoutTimelineText } from "../src/canvas/timelineTextLayout.ts";
import type { TimelineTextOverlayView } from "../src/canvas/model.ts";

const overlay = (
  patch: Partial<TimelineTextOverlayView> = {},
): TimelineTextOverlayView => ({
  id: "text",
  start: 1,
  end: 2,
  text: "Hello",
  x: 0.1,
  y: 0.2,
  maxWidth: 0.5,
  fontId: "font",
  style: {
    fontSize: 10,
    color: "#ffffff",
    align: "left",
    lineHeight: 1.2,
  },
  ...patch,
});
const size = { width: 200, height: 100 };
const measure = (text: string) =>
  [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)]
    .length * 10;

test("keeps explicit blank lines and wraps Chinese at glyph boundaries", () => {
  const result = layoutTimelineText(
    overlay({ text: "中文标题\n\n尾声", maxWidth: 0.15 }),
    size,
    measure,
  );
  assert.deepEqual(
    result.lines.map((l) => l.text),
    ["中文标", "题", "", "尾声"],
  );
  assert.deepEqual(
    result.lines.map((l) => l.baseline),
    [31, 43, 55, 67],
  );
});

test("wraps whole English words before splitting an overwide word", () => {
  const result = layoutTimelineText(
    overlay({ text: "Hello world abcdefgh", maxWidth: 0.3 }),
    size,
    measure,
  );
  assert.deepEqual(
    result.lines.map((l) => l.text),
    ["Hello", "world", "abcdef", "gh"],
  );
});

test("mixed text never splits combining characters or emoji graphemes", () => {
  const result = layoutTimelineText(
    overlay({ text: "中e\u0301👩‍👩‍👧‍👦文", maxWidth: 0.1 }),
    size,
    measure,
  );
  assert.deepEqual(
    result.lines.map((l) => l.text),
    ["中e\u0301", "👩‍👩‍👧‍👦文"],
  );
});

test("aligns within output-coordinate width and pads backgrounds", () => {
  const result = layoutTimelineText(
    overlay({
      text: "ab\nc",
      style: {
        fontSize: 10,
        color: "#ffffff",
        align: "right",
        lineHeight: 1.2,
        background: { color: "#123456", opacity: 0.5, padding: 4 },
        stroke: { color: "#000000", width: 2 },
      },
    }),
    size,
    measure,
  );
  assert.deepEqual(
    result.lines.map((l) => [l.x, l.width]),
    [
      [100, 20],
      [110, 10],
    ],
  );
  assert.deepEqual(result.background, {
    x: 16,
    y: 16,
    width: 108,
    height: 32,
    color: "#123456",
    opacity: 0.5,
  });
  assert.deepEqual(result.stroke, { color: "#000000", width: 2 });
  const centered = layoutTimelineText(
    overlay({ text: "ab", style: { ...overlay().style, align: "center" } }),
    size,
    measure,
  );
  assert.equal(centered.lines[0].x, 60);
});

test("reports overflow without shrinking or dropping text", () => {
  const result = layoutTimelineText(
    overlay({ text: "a\nb\nc", y: 0.9 }),
    size,
    measure,
  );
  assert.equal(result.overflow, true);
  assert.equal(result.lines.length, 3);
  assert.equal(result.lines[2].baseline, 125);
});
