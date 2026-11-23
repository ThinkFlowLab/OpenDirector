import assert from "node:assert/strict";
import test from "node:test";
import {
  createDocument,
  createNode,
  applyCommand,
} from "../src/canvas/model.ts";
import {
  copyTimeline,
  timelineError,
  nodeResources,
} from "../src/canvas/dataBoundary.ts";
import { serializeDocument, parseDocument } from "../src/canvas/storage.ts";
import {
  createHistory,
  recordChange,
  undo,
  redo,
} from "../src/canvas/history.ts";
import {
  addTimelineClip,
  removeTimelineClip,
  removeTimelineAsset,
  retainTimelineAsset,
  snapTimelineTime,
  timelineRulerStep,
  timelineLibraryResources,
} from "../src/canvas/timeline.ts";

const picture = {
  id: "picture",
  kind: "image" as const,
  title: "Picture",
  src: "data:image/png;base64,AA==",
  width: 64,
  height: 64,
};

test("project-only media uses the asset identity before its bytes load", () => {
  const timeline = createNode("timeline").data.timeline!;
  const asset = { ...picture, assetId: "a1", src: undefined };
  const canvas = { ...picture, assetId: "a1", src: "blob:loaded" };
  assert.deepEqual(timelineLibraryResources(timeline, [], "all", "image", [asset]), [asset]);
  assert.deepEqual(timelineLibraryResources(timeline, [canvas], "all", "image", [asset]), [canvas]);
  assert.deepEqual(timelineLibraryResources(timeline, [], "canvas", "image", [asset]), []);
});

test("same bytes on canvas and in imported library remain available after final clip deletion and restore", () => {
  const canvasAsset = {
    ...picture,
    id: "canvas-picture",
    nodeId: "image-node",
  };
  const node = createNode("timeline");
  const populated = addTimelineClip(node.data.timeline!, picture);
  node.data.timeline = removeTimelineClip(
    populated,
    populated.tracks[0]!.clips[0]!.id,
  );
  const saved = serializeDocument({ ...createDocument(), nodes: [node] });
  assert.ok(saved.ok);
  const restored = parseDocument(saved.value);
  assert.ok(restored.ok);
  const timeline = restored.value.nodes[0]!.data.timeline!;
  assert.deepEqual(
    timelineLibraryResources(timeline, [canvasAsset], "imported"),
    [picture],
  );
  assert.deepEqual(
    timelineLibraryResources(timeline, [canvasAsset], "canvas"),
    [canvasAsset],
  );
  assert.deepEqual(timelineLibraryResources(timeline, [canvasAsset], "all"), [
    picture,
  ]);
  assert.deepEqual(
    timelineLibraryResources(timeline, [canvasAsset], "imported", "video"),
    [],
  );
  const removed = removeTimelineAsset(timeline, picture.id);
  assert.deepEqual(
    timelineLibraryResources(removed, [canvasAsset], "imported"),
    [],
  );
  assert.deepEqual(timelineLibraryResources(removed, [canvasAsset], "all"), [
    canvasAsset,
  ]);

  // A snapshot imported from the canvas still belongs to the retained library.
  const referenced = retainTimelineAsset(removed, canvasAsset);
  assert.deepEqual(
    timelineLibraryResources(referenced, [canvasAsset], "imported"),
    [canvasAsset],
  );
});

test("timeline library survives deleting the final clip, serialization, undo and redo", () => {
  const node = createNode("timeline");
  node.data.timeline = addTimelineClip(node.data.timeline!, picture);
  const before = { ...createDocument(), nodes: [node] };
  const timeline = removeTimelineClip(
    node.data.timeline,
    node.data.timeline.tracks[0]!.clips[0]!.id,
  );
  const after = applyCommand(before, {
    type: "update-node",
    id: node.id,
    patch: { data: { timeline } },
  });
  const history = recordChange(createHistory(before), after);
  assert.equal(after.nodes[0]!.data.timeline!.tracks[0]!.clips.length, 0);
  assert.deepEqual(after.nodes[0]!.data.timeline!.importedAssets, [picture]);
  assert.equal(nodeResources(after.nodes[0]!.data)[0]!.src, picture.src);
  assert.equal(
    undo(history).present.nodes[0]!.data.timeline!.tracks[0]!.clips.length,
    1,
  );
  assert.equal(
    redo(undo(history)).present.nodes[0]!.data.timeline!.tracks[0]!.clips
      .length,
    0,
  );
  const serialized = serializeDocument(after);
  assert.ok(serialized.ok);
  const parsed = parseDocument(serialized.value);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.nodes[0]!.data.timeline!.importedAssets, [
    picture,
  ]);
  parsed.value.nodes[0]!.data.timeline!.importedAssets![0]!.title = "Changed";
  assert.equal(
    after.nodes[0]!.data.timeline!.importedAssets![0]!.title,
    "Picture",
  );
});

test("legacy clips migrate once, explicit empty library stays empty and removing asset preserves clip", () => {
  const timeline = addTimelineClip(
    createNode("timeline").data.timeline!,
    picture,
  );
  const legacy = { ...timeline };
  delete legacy.importedAssets;
  const migrated = copyTimeline(legacy);
  assert.deepEqual(migrated.importedAssets, [picture]);
  assert.notEqual(migrated.importedAssets![0], picture);
  const removed = removeTimelineAsset(migrated, picture.id);
  assert.deepEqual(copyTimeline(removed).importedAssets, []);
  assert.equal(removed.tracks[0]!.clips.length, 1);
  assert.deepEqual(
    retainTimelineAsset(migrated, { ...picture, id: "same-bytes" })
      .importedAssets,
    [picture],
  );
  assert.match(
    timelineError({
      ...timeline,
      importedAssets: [{ ...picture, kind: "file" }],
    })!,
    /素材库/,
  );
  assert.match(
    timelineError({ ...timeline, importedAssets: "not-an-array" })!,
    /素材库/,
  );
});

test("library-only edits are recorded by document history equality", () => {
  const node = createNode("timeline"),
    before = { ...createDocument(), nodes: [node] };
  const timeline = retainTimelineAsset(node.data.timeline!, picture);
  const after = applyCommand(before, {
    type: "update-node",
    id: node.id,
    patch: { data: { timeline } },
  });
  assert.notEqual(after, before);
  const changed = recordChange(createHistory(before), after);
  assert.equal(changed.past.length, 1);
  assert.deepEqual(
    undo(changed).present.nodes[0]!.data.timeline!.importedAssets ?? [],
    [],
  );
});

test("magnetic snapping handles clip edges, end alignment, disabled mode and zoom-sized tolerance", () => {
  const timeline = addTimelineClip(
    createNode("timeline").data.timeline!,
    picture,
  );
  const options = { enabled: true, pixelsPerSecond: 100, playhead: 2 };
  assert.equal(snapTimelineTime(timeline, 4.96, options), 5);
  assert.equal(
    snapTimelineTime(timeline, 1.96, { ...options, playhead: 10, duration: 3 }),
    2,
  );
  assert.equal(
    snapTimelineTime(timeline, 4.96, { ...options, enabled: false }),
    149 / 30,
  );
  assert.equal(
    snapTimelineTime(timeline, 4.96, { ...options, pixelsPerSecond: 800 }),
    149 / 30,
  );
  assert.equal(snapTimelineTime(timeline, -1, options), 0);
  assert.ok(timelineRulerStep(800, 30) < timelineRulerStep(5, 30));
  assert.ok(timelineRulerStep(0.01, 30) * 0.01 >= 70);
});
