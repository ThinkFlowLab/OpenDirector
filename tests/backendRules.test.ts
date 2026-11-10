import assert from "node:assert/strict";
import test from "node:test";
import {
  createDocument,
  createNode,
  type CanvasNode,
} from "../src/canvas/model.ts";
import { generationDefaults } from "../src/canvas/generationCatalog.ts";
import { appendServiceResults } from "../src/canvas/linkedResults.ts";
import { isGenerationSettings } from "../src/canvas/dataBoundary.ts";
import {
  backendBlocker,
  backendReferenceIssue,
  backendReferences,
  backendVideoMode,
  isGenerationModel,
  serviceGenerationSettings,
  type ModelConfig,
} from "../src/backend/rules.ts";
import { failedAvailability } from "../src/backend/availability.ts";
import { setActiveLocale } from "../src/i18n/messages.ts";

test("fresh service counts validate transmitted images without rewriting saved rules", () => {
  const configured = config("image", {
    profile: "openai-image", allowedKinds: ["text", "image"], maxImages: 4,
    imageOutputs: [{ aspectRatio: "1:1", size: "768x768" }],
  });
  const now = Date.now();
  configured.availability = {
    configId: configured.id, modelId: configured.modelId, identity: "fresh-count",
    autoCheck: false, status: "available", reasonCode: "supported", checkedAt: now,
    expiresAt: now + 30000, revision: "test", operations: [{
      operation: "image_edit", profile: "image_to_image", method: "POST", path: "/v1/images/edits", output: "image",
      status: "available", reasonCode: "supported", checkedAt: now, expiresAt: now + 30000,
      declaration: { status: "available", reasonCode: "supported", checkedAt: now, expiresAt: now + 30000 },
      inputDetails: [{ name: "image", source: "service", support: "supported", minCount: 1, maxCount: 1,
        min: null, max: null, multipleOf: null, values: null }],
    }],
  };
  const settings = serviceGenerationSettings({ ...generationDefaults("image"), modelConfigId: configured.id, prompt: "Keep the draft" }, configured);
  const references = [media("image"), media("image")];
  setActiveLocale("zh-CN");
  assert.equal(backendBlocker(settings, references, [configured]), "最多支持 1 张图片，当前为 2 张。");
  setActiveLocale("en-US");
  assert.equal(backendBlocker(settings, references, [configured]), "Up to 1 images; 2 added.");
  configured.availability = failedAvailability(configured.availability);
  assert.equal(backendBlocker(settings, references, [configured]), null);
  assert.equal(configured.inputRules.maxImages, 4);
  setActiveLocale("zh-CN");
});

const config = (
  kind: ModelConfig["kind"],
  rules: Partial<ModelConfig["inputRules"]>,
): ModelConfig => ({
  id: crypto.randomUUID(),
  kind,
  url: "http://127.0.0.1:8010/v1",
  modelId: "MiniMaxAI/MiniMax-H3",
  connectionType: "self_hosted",
  protocol: "vllm_omni",
  authMode: "none",
  inputRules: {
    profile: "vllm-omni-h3",
    allowedKinds: ["text", "image", "video", "audio"],
    maxImages: 9,
    maxVideos: 0,
    maxAudios: 3,
    videoModes: ["first_frame", "reference", "continuation"],
    ...rules,
  },
});
const h3 = config("video", {});
const zimage = config("image", {
  profile: "vllm-omni-image",
  imageOutputs: [{ aspectRatio: "1:1", size: "768x768" }],
  allowedKinds: ["text"],
  maxImages: 0,
  videoModes: [],
});
const media = (kind: "image" | "video" | "audio"): CanvasNode =>
  createNode(
    kind,
    { x: 0, y: 0 },
    { src: `data:${kind}/x;base64,AA==`, assetState: "ready" },
  );
const video = (patch: object) => ({
  ...generationDefaults("video"),
  modelConfigId: h3.id,
  prompt: "雨夜街头",
  durationSeconds: 5,
  ...patch,
});

test("SAM stays tool-only in both media categories and legacy vision configurations", () => {
  for (const kind of ["image", "video"] as const) {
    const sam = {
      ...config(kind, {}),
      protocol: "vllm_omni_segmentation" as const,
    };
    const settings = {
      ...generationDefaults(kind),
      modelConfigId: sam.id,
      prompt: "test",
    };
    assert.equal(isGenerationModel(sam), false);
    assert.match(backendBlocker(settings, [], [sam])!, /视觉分割模型/);
  }
  assert.equal(
    isGenerationModel({ kind: "vision", protocol: "vllm_omni" }),
    false,
  );
  assert.equal(isGenerationModel({ kind: "image", protocol: "openai" }), true);
  assert.equal(isGenerationModel(h3), true);
});

test("depth models serve depth capture only, never generation", () => {
  const depth = {
    ...config("video", {}),
    protocol: "vllm_omni_depth" as const,
  };
  const settings = {
    ...generationDefaults("video"),
    modelConfigId: depth.id,
    prompt: "test",
  };
  assert.equal(isGenerationModel(depth), false);
  assert.match(backendBlocker(settings, [], [depth])!, /视频深度模型/);
});

test("text-only reference requests become text-to-video", () => {
  const settings = video({ videoMode: "reference" });
  assert.equal(backendVideoMode(settings, []), "first_frame");
  const image = media("image");
  const references = backendReferences(settings, [image], h3);
  assert.equal(backendVideoMode(settings, references), "reference");
  assert.equal(backendBlocker(settings, [image], [h3]), null);
});

test("subjects supply compatible real resources and retain source identity for evidence", () => {
  const subject = createNode("subject", undefined, {
    title: "角色",
    subject: {
      description: "人物描述",
      category: "person",
      auxiliaries: [],
      main: {
        id: "portrait",
        kind: "image",
        title: "肖像",
        src: "data:image/png;base64,AA==",
      },
      voice: {
        id: "voice",
        kind: "audio",
        title: "声音",
        src: "data:audio/wav;base64,AA==",
      },
    },
  });
  const settings = video({ videoMode: "reference" });
  assert.equal(backendReferenceIssue(subject, settings, h3), null);
  const references = backendReferences(settings, [subject], h3);
  assert.deepEqual(
    references.map((item) => item.node.type),
    ["image", "audio"],
  );
  assert.ok(references.every((item) => item.node.id === subject.id));
  assert.deepEqual(
    references.map((item) => item.node.data.src),
    [subject.data.subject!.main!.src, subject.data.subject!.voice!.src],
  );
  assert.match(backendReferenceIssue(subject, settings, zimage)!, /不接收主体/);
  assert.match(
    backendReferenceIssue(subject, video({ videoMode: "first-last" }), h3)!,
    /图片节点/,
  );
  assert.equal(
    backendReferences(
      settings,
      [{ ...subject, data: { ...subject.data, assetState: "missing" } }],
      h3,
    ).length,
    0,
  );
  const onlyImages = {
    ...h3,
    inputRules: { ...h3.inputRules, allowedKinds: ["image"], maxImages: 1 },
  };
  assert.deepEqual(
    backendReferences(settings, [subject], onlyImages).map(
      (item) => item.node.type,
    ),
    ["image"],
  );
  assert.match(
    backendBlocker(settings, [subject, media("image")], [onlyImages])!,
    /上限/,
  );
  assert.equal(subject.type, "subject");
});

test("continuation needs exactly one previous clip and keeps it out of video references", () => {
  const settings = video({ videoMode: "continuation" });
  assert.match(backendBlocker(settings, [], [h3])!, /接续需要/);
  const clip = media("video");
  assert.equal(backendBlocker(settings, [clip], [h3]), null);
  assert.deepEqual(
    backendReferences(settings, [clip], h3).map((item) => item.role),
    ["continuation"],
  );
  assert.match(
    backendBlocker(settings, [clip, media("video")], [h3])!,
    /接续需要/,
  );
  // Outside continuation H3 receives no video references.
  assert.match(
    backendReferenceIssue(clip, video({ videoMode: "reference" }), h3)!,
    /接续/,
  );
});

test("first-frame mode submits only the chosen frame and rejects a last frame", () => {
  const first = media("image");
  const other = media("image");
  const settings = video({
    videoMode: "first-last",
    firstFrameNodeId: first.id,
  });
  assert.match(
    backendBlocker(settings, [first, other, media("image")], [h3])!,
    /最多连接 2/,
  );
  assert.deepEqual(
    backendReferences(settings, [first, other], h3).map((item) => item.node),
    [first],
  );
  assert.equal(backendVideoMode(settings, []), "first_frame");
  assert.match(
    backendBlocker(
      { ...settings, lastFrameNodeId: other.id },
      [first, other],
      [h3],
    )!,
    /尾帧/,
  );
});

test("input rules bound references, duration and model availability", () => {
  const image = {
    ...generationDefaults("image"),
    modelConfigId: zimage.id,
    resolution: "auto",
    prompt: "灯塔",
  };
  assert.match(
    backendReferenceIssue(media("image"), image, zimage)!,
    /不接收图片/,
  );
  assert.equal(backendBlocker(image, [media("image")], [zimage]), null);
  assert.match(backendBlocker(image, [], [])!, /配置已删除/);
  assert.match(
    backendBlocker({ ...image, prompt: " " }, [], [zimage])!,
    /生成要求/,
  );
  const declared = {
    ...h3,
    inputRules: {
      ...h3.inputRules,
      videoCapabilities: {
        outputs: [
          {
            resolution: "480P",
            durations: Array.from({ length: 12 }, (_, index) => index + 4),
          },
        ],
        defaultResolution: "auto",
        defaultDuration: 5,
        dimensionStep: 32 as const,
      },
    },
  };
  assert.match(
    backendBlocker(video({ durationSeconds: 20 }), [], [declared])!,
    /时长/,
  );
  const images = Array.from({ length: 10 }, () => media("image"));
  assert.match(
    backendBlocker(video({ videoMode: "reference" }), images, [h3])!,
    /上限（9/,
  );
});

test("service settings survive the persistence boundary", () => {
  assert.equal(
    isGenerationSettings(video({ videoMode: "continuation" })),
    true,
  );
  assert.equal(isGenerationSettings(video({ modelConfigId: "" })), false);
});

test("service results without a canvas source are placed right of the content", () => {
  const document = createDocument();
  const existing = createNode("image", { x: 100, y: 50 });
  const result = appendServiceResults({ ...document, nodes: [existing] }, [
    { kind: "text", title: "剧本", text: "第一幕" },
    {
      kind: "image",
      title: "关键帧",
      src: "data:image/png;base64,AA==",
      mimeType: "image/png",
    },
  ]);
  const added = result.document.nodes.filter((node) =>
    result.ids.includes(node.id),
  );
  assert.equal(added.length, 2);
  assert.equal(added[0]!.data.text, "第一幕");
  assert.ok(added.every((node) => node.position.x >= 100 + existing.width));
  assert.equal(result.document.edges.length, 0);
});

test("FastH3 preserves supported reference mode for text-only generation", () => {
  const fast = {
    ...h3,
    inputRules: { ...h3.inputRules, videoModes: ["reference" as const] },
  };
  const settings = video({ videoMode: "reference" });
  assert.equal(backendVideoMode(settings, [], fast), "reference");
  assert.equal(backendBlocker(settings, [], [fast]), null);
});
