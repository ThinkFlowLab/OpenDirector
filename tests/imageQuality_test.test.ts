import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CreationClient, type CreationOperation } from "../src/backend/creationClient.ts";
import { CreationProjection } from "../src/backend/creationProjection.ts";
import { serviceGenerationSettings, type ModelConfig } from "../src/backend/rules.ts";
import { copyGenerationSettings, isGenerationSettings, sameGenerationSettings } from "../src/canvas/dataBoundary.ts";
import { generationDefaults } from "../src/canvas/generationCatalog.ts";
import { getNodeGenerationSettings } from "../src/canvas/generationSettings.ts";
import { createNode } from "../src/canvas/model.ts";
import { assistantToolText } from "../src/canvas/assistantToolText.ts";
import { getActiveLocale, setActiveLocale } from "../src/i18n/messages.ts";
import type { ProjectSnapshot } from "../src/contracts/generated.ts";

const gpt: ModelConfig = {
  id: crypto.randomUUID(),
  kind: "image",
  modelId: "gpt-image-2",
  url: "http://fixture.invalid/v1",
  protocol: "openai",
  connectionType: "api",
  authMode: "none",
  inputRules: {
    profile: "openai-gpt-image",
    allowedKinds: ["text", "image"],
    maxImages: 16,
    maxVideos: 0,
    maxAudios: 0,
    videoModes: [],
    imageQualities: ["auto", "low", "medium", "high"],
  },
};
const compatible: ModelConfig = {
  ...gpt,
  modelId: "compatible-image",
  inputRules: { ...gpt.inputRules, profile: "compatible", imageQualities: undefined },
};

test("quality-only changes survive copying and are detected for saving", () => {
  const settings = { ...generationDefaults("image"), imageQuality: "high" as const };
  const copy = copyGenerationSettings(settings);
  assert.equal(copy.imageQuality, "high");
  assert.equal(isGenerationSettings(copy), true);
  assert.equal(sameGenerationSettings(copy, { ...copy, imageQuality: "low" }), false);
  assert.equal(isGenerationSettings({ ...copy, imageQuality: "ultra" }), false);
  assert.equal(isGenerationSettings(generationDefaults("image")), true);
});

test("quality rejection explains the next action in both languages", () => {
  const previous = getActiveLocale();
  const message = "当前模型不支持所选图片质量，请选择自动或切换模型。";
  try {
    setActiveLocale("en-US");
    assert.equal(assistantToolText(message), "The selected model does not support this image quality. Choose Auto or another model.");
    setActiveLocale("zh-CN");
    assert.equal(assistantToolText(message), message);
  } finally {
    setActiveLocale(previous);
  }
});

test("model changes keep supported quality and clear unsupported quality", () => {
  const settings = {
    ...generationDefaults("image"),
    modelConfigId: gpt.id,
    imageQuality: "high" as const,
  };
  assert.equal(serviceGenerationSettings(settings, gpt, [], true).imageQuality, "high");
  const switched = serviceGenerationSettings(settings, compatible, [], true);
  assert.equal(switched.mode, "image");
  assert.equal(switched.imageQuality, undefined);
});

test("reopening the same edited model configuration drops a hidden unsupported quality", () => {
  const node = createNode("image");
  node.data.settings = {
    ...generationDefaults("image"),
    modelConfigId: gpt.id,
    imageQuality: "high",
  };
  assert.equal(getNodeGenerationSettings(node, [gpt]).imageQuality, "high");
  const reopened = getNodeGenerationSettings(node, [compatible]);
  assert.equal(reopened.modelConfigId, gpt.id);
  assert.equal(reopened.model, "compatible-image");
  assert.equal(reopened.imageQuality, undefined);
});

for (const quality of ["auto", "low", "medium", "high"] as const)
  test(`saved ${quality} quality reopens and can be changed through the same spec`, async () => {
    const snapshot: ProjectSnapshot = JSON.parse(readFileSync(
      new URL("./fixtures/creation-project.json", import.meta.url), "utf8",
    ));
    const original = snapshot.generationSpecs.find((spec) => spec.kind === "image");
    assert.ok(original?.kind === "image");
    const spec = {
      ...original,
      currentResultId: null,
      parameters: { ...original.parameters, ...(quality === "auto" ? {} : { quality }) },
    };
    const client = new CreationClient(snapshot.project.id);
    client.install({
      ...snapshot,
      generationSpecs: [spec],
      assets: [], references: [], editorDocuments: [], jobs: [], results: [],
      canvasItems: snapshot.canvasItems.filter((item) =>
        item.binding.role === "generation" && item.binding.objectRef.id === spec.id),
    });
    client.view = async () => ({
      projectId: client.id, clientId: crypto.randomUUID(),
      viewport: { x: 0, y: 0, zoom: 1 }, selectedItemIds: [],
      activeEditorId: null, playheads: [], generationCounts: {},
    });
    const operations: CreationOperation[] = [];
    client.batch = async (batch) => { operations.push(...batch); return undefined; };
    const projection = new CreationProjection(client);
    const document = await projection.read();
    assert.equal(document.nodes[0]!.data.settings!.imageQuality, quality);
    projection.baseline = document;
    projection.basis = client.snapshot;
    const changed = structuredClone(document);
    changed.nodes[0]!.data.settings!.imageQuality = quality === "high" ? "auto" : "high";
    await projection.save(changed);
    const update = operations.find((operation) => operation.type === "generationSpec.update");
    assert.ok(update?.type === "generationSpec.update");
    assert.equal(update.payload.spec.kind, "image");
    if (update.payload.spec.kind !== "image") throw new Error("Expected an image spec");
    assert.equal(update.payload.spec.parameters?.quality, quality === "high" ? undefined : "high");
    assert.equal(update.payload.spec.id, original.id);
  });
