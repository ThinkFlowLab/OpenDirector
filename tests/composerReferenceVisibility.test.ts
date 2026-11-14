import assert from "node:assert/strict";
import test from "node:test";
import { composerReferenceVisibility } from "../src/canvas/composerReferenceVisibility.ts";

test("reading mode still shows connected references and does not hide the add control", () => {
  const withRef = composerReferenceVisibility({
    firstLast: false,
    reading: true,
    music: false,
    musicReferences: false,
    incomingCount: 1,
    mode: "audio",
  });
  assert.deepEqual(withRef, {
    showStrip: true,
    showEmptyAdd: false,
    showMention: false,
    showReadingContextNote: true,
  });

  const empty = composerReferenceVisibility({
    firstLast: false,
    reading: true,
    music: false,
    musicReferences: false,
    incomingCount: 0,
    mode: "audio",
  });
  assert.deepEqual(empty, {
    showStrip: false,
    showEmptyAdd: true,
    showMention: false,
    showReadingContextNote: false,
  });
});

test("music and first-last visibility stay unchanged, and mentions stay off in reading and music", () => {
  assert.deepEqual(
    composerReferenceVisibility({
      firstLast: false,
      reading: false,
      music: true,
      musicReferences: false,
      incomingCount: 1,
      mode: "audio",
    }),
    {
      showStrip: false,
      showEmptyAdd: false,
      showMention: false,
      showReadingContextNote: false,
    },
  );
  const music = composerReferenceVisibility({
    firstLast: false,
    reading: false,
    music: true,
    musicReferences: true,
    incomingCount: 1,
    mode: "audio",
  });
  assert.equal(music.showStrip, true);
  assert.equal(music.showEmptyAdd, false);
  assert.equal(music.showMention, false);
  assert.equal(music.showReadingContextNote, false);

  const frames = composerReferenceVisibility({
    firstLast: true,
    reading: false,
    music: false,
    musicReferences: false,
    incomingCount: 2,
    mode: "video",
  });
  assert.equal(frames.showStrip, false);
  assert.equal(frames.showEmptyAdd, false);
  assert.equal(frames.showMention, true);
  assert.equal(frames.showReadingContextNote, false);
});

test("image and video panels still show the manager and mention control", () => {
  const image = composerReferenceVisibility({
    firstLast: false,
    reading: false,
    music: false,
    musicReferences: false,
    incomingCount: 1,
    mode: "image",
  });
  assert.deepEqual(image, {
    showStrip: true,
    showEmptyAdd: false,
    showMention: true,
    showReadingContextNote: false,
  });
  const video = composerReferenceVisibility({
    firstLast: false,
    reading: false,
    music: false,
    musicReferences: false,
    incomingCount: 0,
    mode: "video",
  });
  assert.equal(video.showStrip, true);
  assert.equal(video.showEmptyAdd, true);
  assert.equal(video.showMention, true);
});
