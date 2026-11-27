import assert from "node:assert/strict";
import test from "node:test";
import {
  canvasReferenceFrameTime,
  canvasReferenceRole,
  pinnedFrameSeconds,
} from "../src/backend/rules.ts";

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
