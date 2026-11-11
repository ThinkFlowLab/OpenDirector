import { tNow } from "../src/i18n/messages.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  copyTimeline,
  sameNodeData,
  nodeResources,
  timelineError,
  parseNodeData,
} from "../src/canvas/dataBoundary.ts";
import {
  timelineDuration,
  exportTimeline,
  importTimeline,
} from "../src/canvas/timeline.ts";
import * as text from "../src/canvas/timelineText.ts";
import { createNode } from "../src/canvas/model.ts";
import type { TimelineData } from "../src/canvas/model.ts";

export function sample(): TimelineData {
  return {
    fps: 24,
    width: 640,
    height: 360,
    tracks: [
      { id: "visual", kind: "visual", title: "", muted: false, clips: [] },
    ],
    fonts: [
      { id: "font", title: "Fixture", src: "blob:font", mimeType: "font/otf" },
    ],
    overlays: [
      {
        id: "a",
        text: "第一行\n第二行",
        start: 1,
        end: 3,
        x: 0.1,
        y: 0.82,
        maxWidth: 0.8,
        fontId: "font",
        style: {
          fontSize: 18,
          color: "#FFFFFF",
          align: "center",
          lineHeight: 1.2,
          background: { color: "#000000", opacity: 0.5, padding: 4 },
          stroke: { color: "#000000", width: 1 },
        },
        source: { title: "Source", src: "blob:text", mimeType: "text/plain" },
      },
    ],
  };
}

test("active text uses half-open sampled frames and keeps bottom-to-top order", () => {
  const timeline = sample();
  timeline.overlays!.push({
    ...timeline.overlays![0]!,
    id: "b",
    start: 2,
    end: 4,
    text: "Mixed 中英",
  });
  assert.deepEqual(text.timelineTextFrameRange(1, 3, 24), [24, 72]);
  for (const [frame, ids] of [
    [23, []],
    [24, ["a"]],
    [47, ["a"]],
    [48, ["a", "b"]],
    [71, ["a", "b"]],
    [72, ["b"]],
    [95, ["b"]],
    [96, []],
  ] as const)
    assert.deepEqual(
      text.activeTimelineText(timeline, frame).map((o) => o.id),
      ids,
    );
  assert.equal(timelineDuration(timeline), 4);
  const changed = { ...timeline, fps: 30 };
  assert.equal(changed.overlays![0]!.start, 1);
  assert.equal(changed.overlays![0]!.end, 3);
});

test("copy, JSON and node equality retain independent text, font and source values", () => {
  const timeline = sample();
  const copy = copyTimeline(timeline);
  assert.deepEqual(copy.overlays, timeline.overlays);
  assert.deepEqual(copy.fonts, timeline.fonts);
  copy.overlays![0]!.style.background!.padding = 9;
  copy.fonts![0]!.title = "Changed";
  copy.overlays![0]!.source!.title = "Changed";
  assert.equal(timeline.overlays![0]!.style.background!.padding, 4);
  assert.equal(timeline.fonts![0]!.title, "Fixture");
  assert.equal(timeline.overlays![0]!.source!.title, "Source");
  const a = createNode("timeline", { x: 0, y: 0 });
  a.data.timeline = timeline;
  const b = structuredClone(a);
  b.data.timeline!.overlays![0]!.text = "Changed";
  assert.equal(sameNodeData(a.data, b.data), false);
  const c = structuredClone(a);
  c.data.timeline!.fonts![0]!.title = "Changed";
  assert.equal(sameNodeData(a.data, c.data), false);
  assert.deepEqual(
    importTimeline(exportTimeline(timeline, "Text")).overlays,
    timeline.overlays,
  );
  assert.deepEqual(
    nodeResources(a.data).map((r) => [r.kind, r.src]),
    [
      ["file", "blob:font"],
      ["text", "blob:text"],
    ],
  );
});

test("client boundary rejects unknown fonts, non-sampled intervals and malformed styles", () => {
  for (const patch of [
    { fontId: "missing" },
    { end: 1 },
    { start: 0.001, end: 0.002 },
    { x: 0.5, maxWidth: 0.8 },
    { text: "\u0000" },
    { text: " " },
    { text: "字".repeat(4097) },
    { style: { fontSize: 513, color: "red", align: "left", lineHeight: 1.2 } },
  ]) {
    const value = sample();
    Object.assign(value.overlays![0]!, patch);
    assert.ok(timelineError(value));
  }
  const unicode = sample();
  unicode.overlays![0]!.text = "😀".repeat(4096);
  assert.equal(timelineError(unicode), null);
});

test("cross-project copying registers font and original text bytes and discards foreign immutable IDs", async () => {
  const { captureClipboardMedia, transferClipboardMedia } =
    await import("../src/canvas/clipboardMedia.ts");
  const fontSrc = URL.createObjectURL(
    new Blob(["font bytes"], { type: "font/otf" }),
  );
  const textSrc = URL.createObjectURL(
    new Blob(["原始正文"], { type: "text/plain" }),
  );
  try {
    const timeline = sample();
    const font = {
      assetId: "00000000-0000-0000-0000-000000087101",
      revision: 1,
      fingerprint: "sha256:" + "a".repeat(64),
      kind: "file" as const,
    };
    timeline.fonts![0]!.src = fontSrc;
    timeline.fonts![0]!.asset = font;
    timeline.overlays![0]!.source = {
      title: "Original",
      src: textSrc,
      mimeType: "text/plain",
      asset: {
        ...font,
        assetId: "00000000-0000-0000-0000-000000087102",
        kind: "text",
      },
    };
    const node = createNode("timeline", { x: 0, y: 0 });
    node.data.timeline = timeline;
    const fragment = { nodes: [node], edges: [] };
    const media = captureClipboardMedia("source", fragment, {
      resolve: (_src, id) =>
        id ? { assetId: id, fingerprint: font.fingerprint } : undefined,
    });
    const calls: { kind: string; body: string; source: string | undefined }[] =
      [];
    const copied = await transferClipboardMedia(
      fragment,
      media,
      "target",
      async (blob, _title, kind, source) => {
        calls.push({ kind, body: await blob.text(), source: source?.assetId });
        return { assetId: `target-${kind}`, src: `blob:target-${kind}` };
      },
    );
    assert.deepEqual(
      calls.map((c) => [c.kind, c.body, c.source]),
      [
        ["file", "font bytes", font.assetId],
        ["text", "原始正文", "00000000-0000-0000-0000-000000087102"],
      ],
    );
    const result = copied.nodes[0]!.data.timeline!;
    assert.equal(result.fonts![0]!.asset, undefined);
    assert.equal(result.overlays![0]!.source!.asset, undefined);
    assert.equal(result.overlays![0]!.source!.src, "blob:target-text");
    assert.equal(result.overlays![0]!.text, timeline.overlays![0]!.text);
  } finally {
    URL.revokeObjectURL(fontSrc);
    URL.revokeObjectURL(textSrc);
  }
});

test("node duplication retains text and detaches editable nested values", async () => {
  const { createDocument } = await import("../src/canvas/model.ts");
  const { copySelection, pasteFragment } =
    await import("../src/canvas/operations.ts");
  const document = createDocument();
  const node = createNode("timeline", { x: 0, y: 0 });
  node.data.timeline = sample();
  document.nodes = [node];
  const pasted = pasteFragment(document, copySelection(document, [node.id]));
  const copy = pasted.document.nodes.find((n) => n.id !== node.id)!;
  assert.deepEqual(copy.data.timeline!.overlays, node.data.timeline!.overlays);
  copy.data.timeline!.overlays![0]!.style.fontSize = 40;
  assert.equal(node.data.timeline!.overlays![0]!.style.fontSize, 18);
});

for (const scenario of [
  "font array",
  "font object",
  "align array",
  "align object",
  "null fonts",
  "null overlays",
]) {
  test(`malformed JSON ${scenario} returns a localized validation result without coercing or throwing`, () => {
    const value = JSON.parse(JSON.stringify(sample()));
    const uncoercible = JSON.parse('{"toString":null,"valueOf":null}');
    if (scenario === "font array") value.overlays[0].fontId = ["font"];
    if (scenario === "font object") value.overlays[0].fontId = uncoercible;
    if (scenario === "align array") value.overlays[0].style.align = ["center"];
    if (scenario === "align object")
      value.overlays[0].style.align = uncoercible;
    if (scenario === "null fonts") {
      value.fonts = null;
      value.overlays = [];
    }
    if (scenario === "null overlays") value.overlays = null;
    let error: string | null = null;
    assert.doesNotThrow(() => {
      error = timelineError(value);
    });
    assert.equal(error, tNow("errors.data.timelineShape"));
    const node = createNode("timeline", { x: 0, y: 0 });
    node.data.timeline = value;
    let parsed: ReturnType<typeof parseNodeData> | undefined;
    assert.doesNotThrow(() => {
      parsed = parseNodeData("timeline", node.data);
    });
    assert.deepEqual(parsed, {
      ok: false,
      error: tNow("errors.data.timelineShape"),
    });
  });
}

test("text CRUD is immutable, validates changes, preserves tracks and source identity", () => {
  const original = sample(),
    second = {
      ...structuredClone(original.overlays![0]!),
      id: "b",
      text: "标题",
    };
  const added = text.addTimelineText(original, second);
  assert.deepEqual(
    original.overlays!.map((o) => o.id),
    ["a"],
  );
  assert.deepEqual(
    added.overlays!.map((o) => o.id),
    ["a", "b"],
  );
  assert.deepEqual(added.tracks, original.tracks);
  const changed = text.updateTimelineText(added, "b", {
    text: "编辑",
    start: 2,
    end: 5,
    style: { ...second.style, color: "#FF0000" },
  });
  assert.equal(changed.overlays![1]!.text, "编辑");
  assert.deepEqual(changed.overlays![1]!.source, second.source);
  assert.equal(added.overlays![1]!.start, 1);
  assert.deepEqual(
    text.reorderTimelineText(changed, ["b", "a"]).overlays!.map((o) => o.id),
    ["b", "a"],
  );
  assert.deepEqual(
    text.removeTimelineText(changed, "b").overlays!.map((o) => o.id),
    ["a"],
  );
  for (const patch of [
    { text: " " },
    { fontId: "absent" },
    { end: 0 },
    { x: 0.9 },
  ])
    assert.throws(() => text.updateTimelineText(changed, "b", patch));
  assert.throws(() => text.addTimelineText(added, second));
  assert.throws(() => text.reorderTimelineText(changed, ["a", "a"]));
  assert.throws(() => text.reorderTimelineText(changed, ["b"]));
  assert.throws(() =>
    text.updateTimelineText(changed, "absent", { text: "x" }),
  );
  assert.throws(() =>
    text.updateTimelineText(changed, "b", { source: undefined } as never),
  );
});

test("confirming unchanged text does not create an extra undo entry", () => {
  const timeline = sample();
  assert.equal(
    text.updateTimelineText(timeline, "a", { text: "第一行\n第二行" }),
    timeline,
  );
  assert.equal(
    text.updateTimelineText(timeline, "a", {
      style: structuredClone(timeline.overlays![0]!.style),
    }),
    timeline,
  );
  assert.equal(text.reorderTimelineText(timeline, ["a"]), timeline);
});

test("media trimming and playback speed do not move absolute text intervals", async () => {
  const { addTimelineClip, updateTimelineClip } =
    await import("../src/canvas/timeline.ts");
  const initial = sample();
  const added = addTimelineClip(initial, {
    id: "video",
    kind: "video",
    title: "Video",
    src: "blob:video",
    durationSeconds: 10,
  });
  const clip = added.tracks[0]!.clips[0]!;
  const changed = updateTimelineClip(added, clip.id, {
    inPoint: 2,
    outPoint: 8,
    speed: 2,
  });
  assert.deepEqual(changed.overlays, initial.overlays);
  assert.equal(changed.overlays![0]!.start, 1);
  assert.equal(changed.overlays![0]!.end, 3);
});
