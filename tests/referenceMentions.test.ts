import assert from "node:assert/strict";
import test from "node:test";
import { fileName } from "../src/backend/generation.ts";
import { assetDisplayName } from "../src/canvas/assetNames.ts";
import { createNode } from "../src/canvas/model.ts";
import { referenceCandidates } from "../src/canvas/referenceCandidates.ts";
import {
  insertMention,
  isCaretNavigationKey,
  mentionCategories,
  mentionDismissAfterEvent,
  mentionRange,
  slashRange,
  nodeMentionOptions,
} from "../src/canvas/referenceMentions.ts";

test("asset labels collapse repeated media extensions but retain independent identities", () => {
  for (const [name, expected] of [
    ["原版.mp4.mp4", "原版.mp4"],
    ["女王.jpg.jpg.jpg", "女王.jpg"],
    ["女王.JPG.jpg", "女王.JPG"],
    ["notes.v1.md", "notes.v1.md"],
    ["archive.tar.gz", "archive.tar.gz"],
  ])
    assert.equal(assetDisplayName(name!), expected);
  const assets = ["first", "second"].map((id) => ({
    id,
    name: "女王.jpg.jpg",
    kind: "image",
    type: "image/jpeg",
    size: 1,
    fingerprint: id,
  }));
  const choices = referenceCandidates([], assets);
  assert.deepEqual(
    choices.map((choice) => choice.title),
    ["女王.jpg", "女王.jpg"],
  );
  assert.equal(new Set(choices.map((choice) => choice.id)).size, 2);
  assert.equal(assets[0]!.name, "女王.jpg.jpg");
});

test("reference uploads add an extension once even when the node title includes it", () => {
  assert.equal(fileName("原版.mp4", "mp4"), "原版.mp4");
  assert.equal(fileName("女王.jpg.jpg", "jpg"), "女王.jpg");
  assert.equal(fileName("女王.JPG", "jpg"), "女王.jpg");
  assert.equal(fileName("原版", "mp4"), "原版.mp4");
});

test("a bare @ opens references; typing after it closes, and backspacing reopens", () => {
  const text = "参考 @";
  assert.deepEqual(mentionRange(text, text.length), { start: 3, end: 4 });
  for (const suffix of ["x", "主", " ", "\n"]) {
    const edited = text + suffix;
    assert.equal(mentionRange(edited, edited.length), null);
    const backspaced = edited.slice(0, -suffix.length);
    assert.deepEqual(mentionRange(backspaced, backspaced.length), {
      start: 3,
      end: 4,
    });
  }
  // A second @ moves the mention to the newer one instead of closing it.
  assert.deepEqual(mentionRange(`${text}@`, text.length + 1), {
    start: 4,
    end: 5,
  });
  // Typing an @ straight after letters, digits or symbols must open references
  // too: no separating space is required.
  for (const value of ["name@", "a.b@", "user+tag@", "50%@", "@@", "asd@"])
    assert.deepEqual(mentionRange(value, value.length), {
      start: value.length - 1,
      end: value.length,
    });
  assert.equal(mentionRange("@", 0, 1), null);
  assert.deepEqual(mentionRange("@后文", 1), { start: 0, end: 1 });
  assert.deepEqual(mentionRange("中文@", 3), { start: 2, end: 3 });
});

test("reference insertion replaces only the caret range and keeps surrounding text", () => {
  const next = insertMention("前 @ 后", { start: 2, end: 3 }, "主角");
  assert.equal(next.value, "前 @主角  后");
  assert.equal(next.caret, 6);
  assert.equal(
    insertMention("前后", { start: 1, end: 1 }, "图片").value,
    "前@图片 后",
  );
  assert.equal(
    insertMention("替换我", { start: 0, end: 3 }, "视频").value,
    "@视频 ",
  );
});

test("upstream references exclude blank/missing/timeline nodes and include subjects", () => {
  const image = createNode("image", undefined, {
    title: "图片一",
    src: "data:image/png;base64,AA==",
  });
  const subject = createNode("subject", undefined, {
    title: "主角",
    subject: {
      description: "",
      category: "person",
      auxiliaries: [],
      main: { id: "main", title: "肖像", kind: "image", src: image.data.src },
    },
  });
  const text = createNode("text", undefined, { text: "参考正文" });
  const missing = createNode("audio", undefined, {
    src: "missing",
    assetState: "missing",
  });
  const options = nodeMentionOptions(
    [
      image,
      subject,
      text,
      missing,
      createNode("video"),
      createNode("timeline"),
    ],
    (node) => (node.type === "text" ? "模型不支持" : null),
  );
  assert.deepEqual(
    options.map((option) => option.kind),
    ["image", "subject", "text"],
  );
  assert.equal(options[1]!.thumbnail, image.data.src);
  assert.deepEqual(mentionCategories(options), ["all", "image", "subject"]);
  assert.deepEqual(mentionCategories([]), ["all"]);
});


test("skill slash commands follow the caret after text and atomic references", () => {
  assert.deepEqual(slashRange("\ufffc\ufffc /character", 13), {start: 3, end: 13, query: "character"});
  assert.deepEqual(slashRange("\ufffc/", 2), {start: 1, end: 2, query: ""});
  assert.deepEqual(slashRange("先规划\n/换人 后文", 7), {start: 4, end: 7, query: "换人"});
  assert.equal(slashRange("https://example.com", 19), null);
  assert.equal(slashRange("/tmp/file", 9), null);
  assert.equal(slashRange("文字/skill", 8), null);
  assert.equal(slashRange("/skill", 1, 6), null);
  assert.equal(slashRange("/skill", 0), null);
});


test("choosing a skill from the middle of a slash token replaces the complete token", () => {
  assert.deepEqual(slashRange("\ufffc /character 后文", 7), {start: 2, end: 12, query: "char"});
});

test("a dismissed mention stays closed until the caret leaves and returns", () => {
  const mention = 1;
  assert.equal(isCaretNavigationKey("ArrowRight"), true);
  assert.equal(isCaretNavigationKey("ArrowRight", true), false);
  assert.equal(isCaretNavigationKey("a"), false);

  const stayed = mentionDismissAfterEvent(mention, false, mention);
  assert.deepEqual(stayed, {
    dismissedStart: mention,
    leftSinceDismiss: false,
    open: false,
  });

  const left = mentionDismissAfterEvent(mention, false, null);
  assert.deepEqual(left, {
    dismissedStart: null,
    leftSinceDismiss: false,
    open: false,
  });
  const returned = mentionDismissAfterEvent(
    left.dismissedStart,
    left.leftSinceDismiss,
    mention,
  );
  assert.deepEqual(returned, {
    dismissedStart: null,
    leftSinceDismiss: false,
    open: true,
  });

  // Coalesced 2 → 3 → 2: the outside caret is never reported, but a
  // navigation key has already marked the leave.
  const coalesced = mentionDismissAfterEvent(mention, true, mention);
  assert.deepEqual(coalesced, {
    dismissedStart: null,
    leftSinceDismiss: false,
    open: true,
  });
});
