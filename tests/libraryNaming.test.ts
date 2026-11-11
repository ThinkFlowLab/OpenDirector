import assert from "node:assert/strict";
import test from "node:test";
import { withMediaSuffix } from "../src/canvas/library/libraryClient.ts";
import { EXTENSIONS, fileName } from "../src/backend/generation.ts";

/*
 * Regression: canvas node titles ("图片 1") have no extension, and the backend
 * identifies uploads by suffix. Re-inserting such a library item onto a canvas
 * failed with 文件格式不受支持 even though the bytes were a valid PNG.
 */
test("a bare canvas title gains the suffix implied by its media type", () => {
  assert.equal(withMediaSuffix("图片 1", "image/png"), "图片 1.png");
  assert.equal(withMediaSuffix("视频 2", "video/mp4"), "视频 2.mp4");
  assert.equal(withMediaSuffix("旁白", "audio/mpeg"), "旁白.mp3");
  for (const suffix of ["heic", "heif"]) {
    assert.equal(withMediaSuffix("Photo", `image/${suffix}`), `Photo.${suffix}`);
    assert.equal(fileName("Photo", EXTENSIONS[`image/${suffix}`]!), `Photo.${suffix}`);
  }
});

test("an existing suffix is never duplicated", () => {
  assert.equal(withMediaSuffix("图片 1.png", "image/png"), "图片 1.png");
  assert.equal(withMediaSuffix("clip.mp4", "video/mp4"), "clip.mp4");
  assert.equal(withMediaSuffix("note.md", "text/markdown"), "note.md");
});

test("an unknown media type leaves the name untouched", () => {
  assert.equal(withMediaSuffix("素材", undefined), "素材");
  assert.equal(withMediaSuffix("素材", "application/octet-stream"), "素材");
});
