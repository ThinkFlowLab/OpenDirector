import assert from "node:assert/strict";
import test from "node:test";
import { createNode } from "../src/canvas/model.ts";
import {
  h3FrameCount,
  changeGenerationSettings,
  generationActiveReferences,
  generationBlocker,
  generationDefaults,
  generationModelsFor,
  generationReferenceIssue,
  observedGenerationPrice,
} from "../src/canvas/generationCatalog.ts";

const image = () =>
  createNode(
    "image",
    { x: 0, y: 0 },
    { src: "data:image/png;base64,test", assetState: "ready" },
  );

test("switching to 1.0 Fast enforces the observed mode and duration without requiring a frame", () => {
  const original = {
    ...generationDefaults("video"),
    prompt: "云朵移动",
    durationSeconds: 12,
  };
  const next = changeGenerationSettings(original, {
    model: "Seedance 1.0 Fast",
  });
  assert.equal(next.videoMode, "first-last");
  assert.equal(next.durationSeconds, 5);
  assert.equal(generationBlocker(next, []), null);
  assert.equal(original.videoMode, "reference");
  assert.match(
    generationBlocker({ ...next, videoMode: "reference" }, [])!,
    /不支持/,
  );
});

test("first and last frames reject tail-only and broken references, then retain explicit roles", () => {
  const first = image(),
    last = image(),
    unrelated = image();
  const settings = {
    ...generationDefaults("video"),
    videoMode: "first-last" as const,
    prompt: "平稳移动",
  };
  assert.match(
    generationBlocker({ ...settings, lastFrameNodeId: last.id }, [last])!,
    /先选择首帧/,
  );
  assert.match(
    generationBlocker({ ...settings, firstFrameNodeId: first.id }, [])!,
    /未连接或已丢失/,
  );
  const both = {
    ...settings,
    firstFrameNodeId: first.id,
    lastFrameNodeId: last.id,
  };
  assert.equal(generationBlocker(both, [last, first]), null);
  assert.match(
    generationBlocker(both, [unrelated, last, first])!,
    /最多连接 2/,
  );
  assert.deepEqual(
    generationActiveReferences(both, [unrelated, last, first]).map((item) => [
      item.node.id,
      item.role,
    ]),
    [
      [first.id, "firstFrame"],
      [last.id, "lastFrame"],
    ],
  );
  assert.deepEqual(generationActiveReferences(settings, [unrelated]), []);
  assert.match(
    generationBlocker({ ...both, prompt: "" }, [
      { ...first, data: { ...first.data, assetState: "missing" } },
      last,
    ])!,
    /首帧素材/,
  );
});

test("ordinary references use supported, available media and never empty connected nodes", () => {
  const valid = image(),
    empty = createNode("image", { x: 0, y: 0 });
  const video = createNode(
    "video",
    { x: 0, y: 0 },
    { src: "video.webm", assetState: "ready" },
  );
  const settings = generationDefaults("image");
  assert.match(generationBlocker(settings, [empty])!, /可用参考素材/);
  assert.deepEqual(
    generationActiveReferences(settings, [valid, empty, video]).map(
      (item) => item.node.id,
    ),
    [valid.id],
  );
  assert.equal(generationBlocker(settings, [valid]), null);
});

test("tool references retain structured parameters but do not count as a media input", () => {
  const tool = createNode(
    "tool",
    { x: 0, y: 0 },
    {
      tool: {
        kind: "camera_motion",
        fields: [{ name: "movement", values: ["推近"] }],
      },
    },
  );
  const video = generationDefaults("video");
  assert.match(generationBlocker(video, [tool])!, /提示词/);
  const references = generationActiveReferences(
    { ...video, prompt: "雨中街道" },
    [tool],
  );
  assert.equal(references[0]?.role, "tool");
  assert.deepEqual(references[0]?.node.data.tool, tool.data.tool);
  assert.match(
    generationReferenceIssue(tool, generationDefaults("image"))!,
    /运镜工具/,
  );
  assert.equal(
    generationActiveReferences({ ...video, videoMode: "first-last" }, [tool])[0]
      ?.role,
    "tool",
  );
});

test("music selection resets incompatible audio parameters and validates 30–120 seconds", () => {
  const original = {
    ...generationDefaults("audio"),
    prompt: "轻快钢琴",
    count: 4,
    durationSeconds: 5,
  };
  const music = changeGenerationSettings(original, {
    audioCreationType: "music",
  });
  assert.equal(music.model, "SeedMusic 1.0 Preview");
  assert.equal(music.durationSeconds, 30);
  assert.equal(music.count, 1);
  assert.equal(generationModelsFor(music).length, 1);
  assert.equal(generationBlocker({ ...music, durationSeconds: 120 }, []), null);
  for (const durationSeconds of [5, 29, 121, NaN])
    assert.match(generationBlocker({ ...music, durationSeconds }, [])!, /时长/);
  const spoken = changeGenerationSettings(music, {
    audioCreationType: "audio",
  });
  assert.equal(spoken.model, "SeedAudio 1.0");
  assert.equal(spoken.durationSeconds, 5);
});

test("reading needs text and voice; audio references cannot silently replace reading text", () => {
  const audio = createNode(
    "audio",
    { x: 0, y: 0 },
    { src: "audio.wav", assetState: "ready" },
  );
  const reading = { ...generationDefaults("audio"), audioMode: "tts" as const };
  assert.match(generationBlocker(reading, [audio])!, /朗读文本/);
  assert.match(generationReferenceIssue(audio, reading)!, /不使用该参考/);
  assert.deepEqual(generationActiveReferences(reading, [audio]), []);
  assert.equal(
    generationBlocker({ ...reading, prompt: "你好" }, [audio]),
    null,
  );
  assert.match(
    generationBlocker({ ...reading, prompt: "你好", voiceName: "" }, [])!,
    /朗读音色/,
  );
});

test("menu-only models remain distinct from verified parameter capabilities", () => {
  const settings = {
    ...generationDefaults("video"),
    model: "Wan 3.0",
    prompt: "山川",
  };
  assert.ok(
    generationModelsFor(settings).some((model) => model.name === "Wan 3.0"),
  );
  assert.match(generationBlocker(settings, [])!, /参数范围待核实/);
  assert.equal(observedGenerationPrice(settings), null);
  assert.match(
    generationBlocker({ ...settings, model: "Unknown future model" }, [])!,
    /不在已观察目录/,
  );
});

test("product view preset is cleared on a model change and guarded for imported settings", () => {
  const settings = {
    ...generationDefaults("image"),
    prompt: "产品三视图",
    imagePreset: "product-views" as const,
  };
  const next = changeGenerationSettings(settings, {
    model: "Seedream 5.0 Lite",
  });
  assert.equal(next.imagePreset, "none");
  assert.match(
    generationBlocker({ ...settings, model: "Seedream 5.0 Lite" }, [])!,
    /仅支持/,
  );
  assert.equal(observedGenerationPrice(settings), null);
});

test("observed prices never extrapolate to different video duration, mode, resolution, or quantity", () => {
  const settings = generationDefaults("video");
  assert.equal(observedGenerationPrice(settings)?.credits, 56);
  assert.deepEqual(
    observedGenerationPrice({ ...settings, model: "Seedance 2.0 mini" }),
    {
      credits: 24,
      beforeDiscount: 36,
      context: "全能参考 · 4 秒 · 720P · 1 条",
    },
  );
  for (const patch of [
    { durationSeconds: 5 },
    { resolution: "1080P" },
    { count: 2 },
    { videoMode: "first-last" as const },
  ])
    assert.equal(observedGenerationPrice({ ...settings, ...patch }), null);
  assert.equal(
    observedGenerationPrice(
      changeGenerationSettings(settings, { model: "Seedance 1.0 Fast" }),
    )?.credits,
    10,
  );
});

test("image discounts and music observations are references, with unknown combinations left unpriced", () => {
  const imageSettings = generationDefaults("image");
  assert.deepEqual(observedGenerationPrice(imageSettings), {
    credits: 8,
    beforeDiscount: 11,
    context: "2K · 1 张",
  });
  assert.equal(
    observedGenerationPrice({ ...imageSettings, model: "Seedream 4.0" })
      ?.credits,
    1,
  );
  assert.equal(
    observedGenerationPrice({ ...imageSettings, resolution: "4K" }),
    null,
  );
  const music = changeGenerationSettings(generationDefaults("audio"), {
    audioCreationType: "music",
  });
  assert.equal(observedGenerationPrice(music)?.credits, 6);
  assert.equal(
    observedGenerationPrice({ ...music, durationSeconds: 60 }),
    null,
  );
  assert.equal(
    observedGenerationPrice({
      ...generationDefaults("audio"),
      audioMode: "unified",
    }),
    null,
  );
});

test("H3 output preview matches upward frame alignment and round-to-even ties", () => {
  for (const [seconds, frames] of [[4, 107], [107 / 24, 107], [4.5, 124], [5, 124], [15, 362], [124.5 / 24, 124]]) {
    assert.equal(h3FrameCount(seconds), frames);
  }
});
