import assert from "node:assert/strict";
import test from "node:test";
import { createNode, type TimelineData } from "../src/canvas/model.ts";
import { exportTimeline, importTimeline } from "../src/canvas/timeline.ts";
import {
  exportTimelineFcpxml,
  exportTimelinePackage,
} from "../src/canvas/timelineExport.ts";
import { setActiveLocale } from "../src/i18n/messages.ts";

function textTimeline(): TimelineData {
  const data = createNode("timeline").data.timeline!;
  data.importedAssets = [];
  data.fonts = [
    { id: "font", title: "Font", src: "blob:font", mimeType: "font/otf" },
  ];
  data.overlays = [
    {
      id: "caption",
      text: "中 English",
      start: 0,
      end: 1,
      x: 0,
      y: 0,
      maxWidth: 1,
      fontId: "font",
      style: { fontSize: 24, color: "#FFFFFF", align: "left", lineHeight: 1 },
    },
  ];
  return data;
}

test("timeline JSON preserves v1 media and marks text/font structure as same-project v2", () => {
  const legacy = createNode("timeline").data.timeline!;
  legacy.importedAssets = [];
  const oldJson = exportTimeline(legacy, "Legacy");
  assert.equal(JSON.parse(oldJson).version, 1);
  assert.deepEqual(importTimeline(oldJson), legacy);
  for (const data of [
    textTimeline(),
    { ...legacy, fonts: textTimeline().fonts },
  ]) {
    const json = exportTimeline(data, "Text");
    const envelope = JSON.parse(json);
    assert.equal(envelope.version, 2);
    assert.deepEqual(envelope.requiredCapabilities, ["timeline.text.v1"]);
    assert.equal(envelope.resourceScope, "same-project");
    assert.equal(envelope.resourcesEmbedded, false);
    assert.deepEqual(importTimeline(json), data);
  }
});

test("timeline JSON rejects unknown versions/capabilities and downgraded text before losing fields", () => {
  const envelope = JSON.parse(exportTimeline(textTimeline(), "Text"));
  for (const patch of [
    { version: 3 },
    { version: 0 },
    { requiredCapabilities: ["future.text.v9"] },
    { requiredCapabilities: "timeline.text.v1" },
    { requiredCapabilities: [] },
    { version: 1, requiredCapabilities: undefined },
  ])
    assert.throws(() =>
      importTimeline(JSON.stringify({ ...envelope, ...patch })),
    );
  const old = JSON.parse(
    exportTimeline(createNode("timeline").data.timeline!, "Old"),
  );
  assert.throws(() =>
    importTimeline(
      JSON.stringify({ ...old, requiredCapabilities: ["future.v1"] }),
    ),
  );
});

test("text cannot disappear through FCPXML or its ZIP and rejection follows selected language", async () => {
  try {
    for (const [locale, pattern] of [
      ["zh-CN", /原生可编辑包.*MP4/],
      ["en-US", /native editable package.*MP4/],
    ] as const) {
      setActiveLocale(locale);
      assert.throws(
        () => exportTimelineFcpxml(textTimeline(), "Text"),
        pattern,
      );
      await assert.rejects(
        exportTimelinePackage(
          textTimeline(),
          "Text",
          new AbortController().signal,
        ),
        pattern,
      );
    }
  } finally {
    setActiveLocale("zh-CN");
  }
});

test("untrusted View registration identities are bounded text before import", () => {
  for (const importIdentity of [null, {}, "", "x".repeat(513)]) {
    const envelope = JSON.parse(exportTimeline(textTimeline(), "Text"));
    envelope.timeline.fonts[0].importIdentity = importIdentity;
    assert.throws(() => importTimeline(JSON.stringify(envelope)));
  }
});

test("legacy ZIP reports its text limitation before inspecting unrelated missing media", async () => {
  const data = textTimeline();
  data.importedAssets = [
    { id: "missing", title: "Unavailable", kind: "image" },
  ];
  await assert.rejects(
    exportTimelinePackage(data, "Text", new AbortController().signal),
    /原生可编辑包.*MP4/,
  );
});
