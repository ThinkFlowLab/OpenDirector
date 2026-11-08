import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleStarterTimeline,
  GUIDE_IDS,
  GUIDE_CLIPS,
  starterDocument,
  isStarterProject,
} from "../src/canvas/starterGuide.ts";
import { createDocument, createNode } from "../src/canvas/model.ts";

test("starter timeline uses real clips and retry preserves edits", () => {
  const doc = createDocument("exercise");
  const story = createNode("text");
  story.id = GUIDE_IDS.story;
  const timeline = createNode("timeline");
  timeline.id = GUIDE_IDS.timeline;
  const videos = [1, 2, 3].map((i) =>
    createNode("video", undefined, {
      title: `shot-${i}`,
      src: `blob:clip${i}`,
      generationProvenance: { source: "imported" },
    }),
  );
  videos.forEach((video, index) => {
    video.id = GUIDE_CLIPS[index]!;
  });
  doc.nodes = [story, timeline, ...videos];
  assert.equal(isStarterProject(doc), true);
  const assembled = assembleStarterTimeline(doc);
  const clips = assembled.nodes.find((n) => n.id === GUIDE_IDS.timeline)!.data
    .timeline!.tracks[0]!.clips;
  assert.equal(clips.length, 3);
  assert.equal(assembled.edges.length, 3);
  assert.deepEqual(
    clips.map((c) => c.resource.src),
    videos.map((v) => v.data.src),
  );
  assert.ok(clips.every((c) => c.outPoint === 4 && c.muted));
  clips[0]!.outPoint = 2;
  assert.equal(assembleStarterTimeline(assembled), assembled);
  assert.equal(clips[0]!.outPoint, 2);
  assert.equal(
    doc.nodes.find((n) => n.id === GUIDE_IDS.timeline)!.data.timeline!
      .tracks[0]!.clips.length,
    0,
  );
});
test("unrelated projects are not modified or recognized as guide projects", () => {
  const doc = createDocument();
  doc.nodes = [createNode("text")];
  assert.equal(isStarterProject(doc), false);
  assert.equal(assembleStarterTimeline(doc), doc);
});

test("sample import keeps real MIME types and never claims model generation", async () => {
  const originalFetch = globalThis.fetch;
  const originalReader = globalThis.FileReader;
  const types: string[] = [];
  globalThis.fetch = async () => new Response(new Blob(["test bytes"]));
  globalThis.FileReader = class {
    result = "";
    onload?: () => void;
    readAsDataURL(file: File) {
      types.push(file.type);
      this.result = `data:${file.type};base64,dGVzdA==`;
      this.onload?.();
    }
  } as unknown as typeof FileReader;
  try {
    const document = await starterDocument(((key: string) => key) as any);
    assert.deepEqual(
      types.sort(),
      [
        "image/png",
        "image/png",
        "image/png",
        "video/mp4",
        "video/mp4",
        "video/mp4",
      ].sort(),
    );
    const clips = document.nodes.filter((n) => n.type === "video");
    assert.deepEqual(
      clips.map((n) => n.id),
      GUIDE_CLIPS,
    );
    assert.ok(
      clips.every(
        (n) =>
          n.data.src!.startsWith("data:video/mp4;") &&
          n.data.generationProvenance?.source === "imported",
      ),
    );
    assert.equal(
      document.nodes.find((n) => n.id === GUIDE_IDS.generation)!.data.src,
      undefined,
    );
    assert.ok(
      document.nodes
        .filter((n) => n.data.src)
        .every((n) => !n.data.generationProvenance?.jobId),
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.FileReader = originalReader;
  }
});

test("bundled media matches its provenance manifest", async () => {
  const { readFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const root = new URL("../public/starter-guide/", import.meta.url);
  const manifest = JSON.parse(
    await readFile(new URL("manifest.json", root), "utf8"),
  );
  assert.equal(manifest.thirdPartyMedia, false);
  assert.equal(manifest.audio, false);
  for (const [name, entry] of Object.entries(manifest.assets) as [
    string,
    { sha256: string; bytes: number; license: string },
  ][]) {
    const bytes = await readFile(new URL(name, root));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      entry.sha256,
      name,
    );
    assert.equal(bytes.length, entry.bytes, name);
    assert.equal(entry.license, "Apache-2.0", name);
  }
});
