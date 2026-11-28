import assert from "node:assert/strict";
import test from "node:test";
import {
  canvasReferenceFrameTime,
  canvasReferenceRole,
  keyframeFrame,
  pinnedFrameSeconds,
} from "../src/backend/rules.ts";
import { mapSettingsNodeReferences } from "../src/canvas/model.ts";
import { continuesOwnClip } from "../src/canvas/nodeActionWorkflow.ts";

const follow = (id: string) => ({ binding: "follow_current", role: "reference", source: { id } });

test("a pinned image becomes a keyframe at its time in milliseconds", () => {
  const settings = { videoMode: "reference" as const, pinnedFrames: [{ nodeId: "pose", seconds: 1.25 }] };
  assert.equal(canvasReferenceRole(settings, "image", follow("pose")), "keyframe");
  assert.equal(canvasReferenceFrameTime(settings, "image", follow("pose")), 1250);
  // Other connected images stay ordinary references and carry no time.
  assert.equal(canvasReferenceRole(settings, "image", follow("costume")), "reference");
  assert.equal(canvasReferenceFrameTime(settings, "image", follow("costume")), undefined);
});

test("pins apply to images in reference mode only", () => {
  const pinnedFrames = [{ nodeId: "clip", seconds: 2 }];
  assert.equal(pinnedFrameSeconds({ videoMode: "reference", pinnedFrames }, "video", "clip"), undefined);
  for (const videoMode of ["first-last", "continuation", "control"] as const)
    assert.equal(pinnedFrameSeconds({ videoMode, pinnedFrames }, "image", "clip"), undefined);
  // An unset mode is reference mode, as everywhere else on the canvas.
  assert.equal(pinnedFrameSeconds({ pinnedFrames }, "image", "clip"), 2);
  assert.equal(canvasReferenceRole({ videoMode: "control", pinnedFrames }, "video", follow("clip")), "control");
});

test("a pinned asset version is not tied to a canvas node, so it keeps its stored role", () => {
  const settings = { videoMode: "reference" as const, pinnedFrames: [{ nodeId: "pose", seconds: 1 }] };
  const pinnedAsset = { binding: "pinned", role: "reference", source: { assetId: "pose" } };
  assert.equal(canvasReferenceFrameTime(settings, "image", pinnedAsset), undefined);
  assert.equal(canvasReferenceRole(settings, "image", pinnedAsset), "reference");
});

test("times are compared as the output frames they land on", () => {
  // 24 frames per second: 1.00 s and 1.02 s are the same frame, 1.05 s is the next one.
  assert.equal(keyframeFrame(1), 24);
  assert.equal(keyframeFrame(1.02), 24);
  assert.equal(keyframeFrame(1.05), 25);
  // The same rounding as the backend, which converts whole milliseconds.
  assert.equal(keyframeFrame(4.4583), Math.round((4458 * 24) / 1000));
});

test("a copied node keeps its keyframe times on the copied pictures", () => {
  const settings = {
    videoMode: "reference" as const,
    firstFrameNodeId: "first",
    pinnedFrames: [{ nodeId: "pose", seconds: 1.25 }, { nodeId: "left-behind", seconds: 3 }],
  };
  const copies: Record<string, string> = { first: "first-copy", pose: "pose-copy" };
  const mapped = mapSettingsNodeReferences(settings as never, (id) => copies[id]);
  // A time whose picture is not in the copy has nothing to pin.
  assert.deepEqual(mapped.pinnedFrames, [{ nodeId: "pose-copy", seconds: 1.25 }]);
  assert.equal(mapped.firstFrameNodeId, "first-copy");
  assert.deepEqual(settings.pinnedFrames.map((frame) => frame.nodeId), ["pose", "left-behind"]);
  // Nothing to remap leaves the settings object itself.
  const same = { videoMode: "reference" as const, pinnedFrames: [{ nodeId: "pose", seconds: 1 }] };
  assert.equal(mapSettingsNodeReferences(same as never, (id) => id), same);
  const none = mapSettingsNodeReferences(same as never, () => undefined);
  assert.equal(none.pinnedFrames, undefined);
});

test("extend continues only a clip the same model configuration generated", () => {
  const clip = (source: string, modelConfigId?: string) =>
    ({ data: { generationProvenance: { source }, settings: modelConfigId ? { modelConfigId } : undefined } }) as never;
  assert.equal(continuesOwnClip(clip("generated", "pika"), "pika"), true);
  // An upload, an edited clip and another model's clip have no latents on this service.
  assert.equal(continuesOwnClip(clip("upload"), "pika"), false);
  assert.equal(continuesOwnClip(clip("edited", "pika"), "pika"), false);
  assert.equal(continuesOwnClip(clip("generated", "other"), "pika"), false);
  assert.equal(continuesOwnClip(clip("generated", "pika"), undefined), false);
  assert.equal(continuesOwnClip({ data: {} } as never, "pika"), false);
});
