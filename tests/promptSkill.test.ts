import test from "node:test";
import assert from "node:assert/strict";
import {
  imagePresetsFromFields,
  presetImageTitles,
  presetPart,
  presetSkillText,
  promptWithPreset,
  supportsFaceEmphasis,
  withPresetPart,
  type PromptSkillPreset,
} from "../src/canvas/promptSkill.ts";
import type { ReferenceContent } from "../src/canvas/chatReferenceContent.ts";
import { setActiveLocale } from "../src/i18n/messages.ts";
import { applyCommand, createDocument, createNode, DEFAULT_SETTINGS } from "../src/canvas/model.ts";
import { referenceContentCommand } from "../src/canvas/generationReferenceEdit.ts";
import { presetReferenceSources } from "../src/canvas/workspaceInteraction.ts";

const face: PromptSkillPreset = {
  value: "face-three-view",
  label: "面部三视图",
  prompts: ["以参考图人物的面部为唯一身份依据。"],
};
const four: PromptSkillPreset = {
  value: "four-view",
  label: "人物四视图",
  prompts: ["生成四视图。"],
  textPrompts: ["按文字描述生成四视图。"],
  faceEmphasisPrompt: "四视图并突出脸部。",
  faceEmphasisTextPrompt: "按文字描述生成并突出脸部。",
};
const board: PromptSkillPreset = {
  value: "storyboard",
  label: "连续分镜图",
  prompts: ["远景建立镜头", "中景镜头", "近景镜头", "特写镜头"],
  textPrompts: ["按文字设计远景", "同一场景中景", "同一场景近景", "同一场景特写"],
};

const atom = (value: string, name = "人物四视图", emphasis = false) =>
  ({
    type: "skill" as const,
    name,
    preset: value,
    ...(emphasis ? { faceEmphasis: true } : {}),
  });

test("a preset is an atom at the front of the prompt", () => {
  const content: ReferenceContent = [{ type: "text", text: "一只猫" }];
  const next = withPresetPart(content, atom("four-view"));
  assert.deepEqual(next[0], atom("four-view"));
  assert.equal(presetPart(next)?.preset, "four-view");
  assert.equal(next.at(-1)?.type, "text");
});

test("prompt edits save preset changes with the node and keep the chip out of the stored prompt", () => {
  const node = createNode("image", undefined, { settings: { ...DEFAULT_SETTINGS } });
  let doc = createDocument();
  doc = { ...doc, nodes: [node] };
  const content = [{ type: "text" as const, text: "Same subject." }];
  doc = applyCommand(doc, referenceContentCommand(doc, node.id, withPresetPart(content, atom("four-view", undefined, true)), [], true));
  assert.equal(doc.nodes[0]?.data.settings?.imagePreset, "four-view");
  assert.equal(doc.nodes[0]?.data.settings?.faceEmphasis, true);
  assert.deepEqual(doc.nodes[0]?.data.promptContent, content);
  doc = applyCommand(doc, referenceContentCommand(doc, node.id, [{ type: "text", text: "New subject." }]));
  assert.equal(doc.nodes[0]?.data.settings?.imagePreset, "four-view");
  doc = applyCommand(doc, referenceContentCommand(doc, node.id, content, [], true));
  assert.equal(doc.nodes[0]?.data.settings?.imagePreset, "none");
  assert.equal(doc.nodes[0]?.data.settings?.faceEmphasis, false);
});

test("selecting another preset replaces the first, never stacking", () => {
  const once = withPresetPart([], atom("four-view"));
  const twice = withPresetPart(once, atom("face-three-view", "面部三视图"));
  assert.equal(twice.filter((part) => part.type === "skill").length, 1);
  assert.equal(presetPart(twice)?.preset, "face-three-view");
});

test("removing the chip leaves the user's own text", () => {
  const withUserText = withPresetPart(
    [{ type: "text", text: "一只猫" }],
    atom("four-view"),
  );
  const cleared = withPresetPart(withUserText, null);
  assert.equal(presetPart(cleared), undefined);
  assert.equal(
    cleared.map((part) => (part.type === "text" ? part.text : "")).join(""),
    "一只猫",
  );
});

test("the skill text carries no preset heading", () => {
  setActiveLocale("zh-CN");
  const skill = presetSkillText(face, []);
  assert.doesNotMatch(skill, /预设[:：]/);
  assert.match(skill, /以参考图人物的面部/);
  assert.equal(promptWithPreset("一只猫", skill), `${skill}\n\n一只猫`);
  assert.equal(promptWithPreset("一只猫", undefined), "一只猫");
});

test("multiple reference images are numbered in the skill", () => {
  setActiveLocale("zh-CN");
  const text = presetSkillText(face, ["徐骁", "王府门口"]);
  assert.match(text, /参考1（徐骁）/);
  assert.match(text, /参考2（王府门口）/);
  assert.match(text, /2 张参考图/);
  assert.doesNotMatch(presetSkillText(face, ["徐骁"]), /张参考图/);
});

test("multi-step instructions keep the provider's wording and order in English UI", () => {
  setActiveLocale("en-US");
  const text = presetSkillText(board, []);
  assert.match(text, /按以下顺序逐张生成/);
  assert.match(text, /1\. 按文字设计远景[\s\S]*2\. 同一场景中景[\s\S]*4\. 同一场景特写/);
  const withImage = presetSkillText(board, ["场景图.png"]);
  assert.match(withImage, /1\. 远景建立镜头[\s\S]*2\. 中景镜头[\s\S]*4\. 特写镜头/);
});

test("face emphasis swaps in the alternate framing", () => {
  setActiveLocale("zh-CN");
  assert.equal(supportsFaceEmphasis(four), true);
  assert.equal(supportsFaceEmphasis(face), false);
  assert.equal(presetSkillText(four, ["人物.png"], true), four.faceEmphasisPrompt);
  assert.equal(presetSkillText(four, [], true), four.faceEmphasisTextPrompt);
  assert.equal(presetSkillText(four, ["人物.png"]), four.prompts[0]);
  assert.equal(presetSkillText(four, []), four.textPrompts?.[0]);
});

test("the preset preview counts each image asset once and keeps its first title", () => {
  const images = [
    createNode("image", undefined, { title: "First", backendAssetId: "shared", src: "first.png" }),
    createNode("image", undefined, { title: "Second", backendAssetId: "other", src: "second.png" }),
    createNode("image", undefined, { title: "Duplicate", backendAssetId: "shared", src: "copy.png" }),
  ];
  assert.deepEqual(presetImageTitles(DEFAULT_SETTINGS, images), ["First", "Second"]);
});

test("the preset preview numbers pinned and followed images in prompt order", () => {
  const followed = createNode("image", undefined, {
    title: "Canvas title", backendAssetId: "followed", src: "followed.png",
  });
  const node = createNode("image", undefined, { promptContent: [
    { type: "reference", binding: "asset", assetId: "fixed", name: "Chip label" },
    { type: "reference", assetId: "followed", name: "Canvas title", nodeId: followed.id },
  ] });
  const sources = presetReferenceSources({
    node,
    incoming: [followed],
    assets: [{ id: "fixed", kind: "image", name: "Original filename.png" }],
  });
  assert.deepEqual(presetImageTitles(DEFAULT_SETTINGS, sources), ["Original filename.png", "Canvas title"]);
});

test("presets are read from the catalog and only with instructions", () => {
  assert.deepEqual(
    imagePresetsFromFields([
      { key: "preset", options: [{ value: "none", label: "自由创作" }] },
    ]),
    [],
  );
  const found = imagePresetsFromFields([
    {
      key: "preset",
      options: [
        {
          value: "four-view",
          label: "人物四视图",
          prompts: ["生成四视图"],
          textPrompts: ["按文字生成"],
          textPrompt: "旧版单条提示词",
          faceEmphasisPrompt: "突出脸部",
          faceEmphasisTextPrompt: "按文字突出脸部",
        },
        { value: 7, label: "数字", prompts: ["x"] },
      ],
    },
  ]);
  assert.equal(found[0]?.value, "four-view");
  assert.equal(found[0]?.faceEmphasisPrompt, "突出脸部");
  assert.deepEqual(found[0]?.textPrompts, ["按文字生成"]);
  assert.equal(found[0]?.faceEmphasisTextPrompt, "按文字突出脸部");
  assert.equal(found[1]?.value, "7");
  assert.deepEqual(imagePresetsFromFields(undefined), []);
});
