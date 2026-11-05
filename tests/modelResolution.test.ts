import assert from "node:assert/strict";
import test from "node:test";
import type { ModelConfig } from "../src/backend/rules.ts";
import {
  applyModelResolution,
  newNodeGenerationSettings,
  resolveGenerationModel,
} from "../src/canvas/modelResolution.ts";

const config = (
  kind: ModelConfig["kind"],
  modelId: string,
  overrides: Partial<ModelConfig> = {},
): ModelConfig => ({
  id: `${kind}:${modelId}`,
  kind,
  url: "http://127.0.0.1:8010/v1",
  modelId,
  connectionType: "self_hosted",
  protocol: kind === "video" ? "vllm_omni" : "openai",
  authMode: "none",
  inputRules: {
    profile: "test",
    allowedKinds: ["text", "image", "video", "audio"],
    maxImages: 4,
    maxVideos: 0,
    maxAudios: 0,
    videoModes: kind === "video" ? ["first_frame", "reference"] : [],
  },
  ...overrides,
});

const zeta = config("video", "zeta-video");
const alpha = config("video", "alpha-video");
const image = config("image", "alpha-image");
const vision: ModelConfig = config("vision", "sam", { protocol: "openai" });

test("a configured model that still exists is kept", () => {
  const resolution = resolveGenerationModel(
    { modelConfigId: zeta.id },
    "video",
    [alpha, zeta],
  );
  assert.deepEqual(resolution, {
    status: "current",
    model: "zeta-video",
    modelConfigId: zeta.id,
  });
});

test("a node without a model falls back to the deterministic default", () => {
  const resolution = resolveGenerationModel({}, "video", [zeta, alpha]);
  assert.deepEqual(resolution, {
    status: "default",
    model: "alpha-video",
    modelConfigId: alpha.id,
  });
});

test("the default does not depend on the order the API returns", () => {
  const first = resolveGenerationModel({}, "video", [zeta, alpha]);
  const second = resolveGenerationModel({}, "video", [alpha, zeta]);
  assert.deepEqual(first, second);
});

test("a node without a model follows the assistant picker", () => {
  const resolution = resolveGenerationModel({}, "video", [alpha, zeta], {
    video: zeta.id,
  });
  assert.deepEqual(resolution, {
    status: "default",
    model: "zeta-video",
    modelConfigId: zeta.id,
  });
});

test("the picker preference never overrides an explicit node model", () => {
  const resolution = resolveGenerationModel(
    { modelConfigId: alpha.id },
    "video",
    [alpha, zeta],
    { video: zeta.id },
  );
  assert.equal(resolution.status, "current");
  assert.equal(resolution.modelConfigId, alpha.id);
});

test("a preference for another kind or a stale id falls back to the default", () => {
  const picked = (resolution: ReturnType<typeof resolveGenerationModel>) =>
    resolution.status === "unconfigured" ? null : resolution.modelConfigId;
  const wrongKind = resolveGenerationModel({}, "video", [alpha, zeta], {
    image: zeta.id,
  });
  assert.equal(picked(wrongKind), alpha.id);
  const stale = resolveGenerationModel({}, "video", [alpha, zeta], {
    video: "video:gone",
  });
  assert.equal(picked(stale), alpha.id);
});

test("a deleted configuration is reported instead of silently replaced", () => {
  const resolution = resolveGenerationModel(
    { modelConfigId: "video:gone" },
    "video",
    [alpha],
  );
  assert.deepEqual(resolution, {
    status: "orphaned",
    modelConfigId: "video:gone",
  });
});

test("a configuration of the wrong kind counts as orphaned", () => {
  const resolution = resolveGenerationModel(
    { modelConfigId: image.id },
    "video",
    [image, alpha],
  );
  assert.equal(resolution.status, "orphaned");
});

test("segmentation configurations are never offered for generation", () => {
  const resolution = resolveGenerationModel({}, "image", [vision]);
  assert.equal(resolution.status, "unconfigured");
});

test("no configured model of this kind reports unconfigured", () => {
  assert.equal(
    resolveGenerationModel({}, "audio", [alpha, image]).status,
    "unconfigured",
  );
});

test("applying a resolution writes the model and the configuration id", () => {
  const settings = { model: "本地交互演示", modelConfigId: undefined };
  const next = applyModelResolution(
    settings,
    resolveGenerationModel({}, "video", [alpha]),
  );
  assert.equal(next.model, "alpha-video");
  assert.equal(next.modelConfigId, alpha.id);
});

test("orphaned and unconfigured keep the stored values untouched", () => {
  const orphaned = { model: "旧模型", modelConfigId: "video:gone" };
  assert.deepEqual(
    applyModelResolution(
      orphaned,
      resolveGenerationModel(orphaned, "video", [alpha]),
    ),
    orphaned,
  );
  const unconfigured = { model: "旧模型", modelConfigId: undefined };
  assert.deepEqual(
    applyModelResolution(
      unconfigured,
      resolveGenerationModel(unconfigured, "audio", []),
    ),
    unconfigured,
  );
});

test("a new image node takes the selected adapter's ratio and size instead of the catalog 1:1", () => {
  const seedream = config("image", "doubao-seedream-5.0-flash", {
    protocol: "volcengine",
    inputRules: {
      ...image.inputRules,
      imageOutputs: [{ aspectRatio: "auto", size: "2K" }],
    },
  });
  const settings = newNodeGenerationSettings("image", [seedream]);
  assert.equal(settings.modelConfigId, seedream.id);
  assert.equal(settings.aspectRatio, "auto");
  assert.ok(["auto", "2K"].includes(settings.resolution));
});

test("a new image node keeps a ratio the adapter declares", () => {
  const fixed = config("image", "fixed-sizes", {
    inputRules: {
      ...image.inputRules,
      imageOutputs: [
        { aspectRatio: "1:1", size: "1024x1024" },
        { aspectRatio: "3:2", size: "1536x1024" },
      ],
    },
  });
  const settings = newNodeGenerationSettings("image", [fixed]);
  assert.equal(settings.aspectRatio, "1:1");
  assert.ok(["auto", "1024x1024"].includes(settings.resolution));
});

test("without a configured model a new node keeps the catalog defaults", () => {
  const settings = newNodeGenerationSettings("image", []);
  assert.equal(settings.modelConfigId, undefined);
  assert.equal(settings.aspectRatio, "1:1");
  assert.equal(settings.resolution, "2K");
});
