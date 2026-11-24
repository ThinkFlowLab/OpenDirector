import assert from "node:assert/strict";
import test from "node:test";
import {
  CANVAS_TOOLS,
  createCanvasToolTask,
  initialToolParameters,
  toolFields,
  validateToolTask,
  type ToolSource,
  type ToolParameters,
} from "../src/canvas/toolCatalog.ts";
import { setActiveLocale } from "../src/i18n/messages.ts";
const source: ToolSource = {
  nodeId: "image-1",
  kind: "image",
  title: "Scene",
  src: "data:image/png;base64,a",
  mimeType: "image/png",
  width: 1024,
  height: 1024,
};
test("outpaint derives fixed output count, resolution and maximum dimension, rejects empty expansion", () => {
  const params = initialToolParameters(
    CANVAS_TOOLS.find((tool) => tool.id === "outpaint")!,
  );
  const task = createCanvasToolTask("outpaint", [source.nodeId], {
    ...params,
    outputWidth: 2048,
    outputHeight: 1536,
  });
  assert.equal(task.parameters.maxSize, 2048);
  assert.equal(task.parameters.candidateCount, 1);
  assert.equal(task.parameters.resolution, "2K");
  assert.deepEqual(validateToolTask(task, [source]), []);
  assert.ok(
    validateToolTask(
      {
        ...task,
        parameters: {
          ...task.parameters,
          top: 0,
          bottom: 0,
          left: 0,
          right: 0,
        },
      },
      [source],
    ).some((error) => error.includes("至少扩展")),
  );
  assert.ok(
    validateToolTask(
      { ...task, parameters: { ...task.parameters, maxSize: 1024 } },
      [source],
    ).some((error) => error.includes("长边")),
  );
});
test("normal upscaling excludes Pro fields and duplicate sources do not pass batch validation", () => {
  const task = createCanvasToolTask("image-hd", [source.nodeId], {
    kind: "normal",
    resolution: "4K",
    detailStrength: 0.5,
  });
  assert.deepEqual(task.parameters, { kind: "normal" });
  assert.deepEqual(validateToolTask(task, [source]), []);
  assert.ok(
    validateToolTask(
      { ...task, sourceNodeIds: [source.nodeId, source.nodeId] },
      [source],
    ).some((error) => error.includes("不能重复")),
  );
});
test("manual masks are bound to the exact source and original pixel dimensions", () => {
  const task = createCanvasToolTask(
    "cutout",
    [source.nodeId],
    { selectionMode: "manual" },
    {
      sourceNodeId: source.nodeId,
      width: 1024,
      height: 1024,
      maskDataUrl: "data:image/png;base64,mask",
    },
  );
  assert.deepEqual(validateToolTask(task, [source]), []);
  assert.ok(
    validateToolTask(
      { ...task, selection: { ...task.selection!, sourceNodeId: "another" } },
      [source],
    ).some((error) => error.includes("不属于")),
  );
  assert.ok(
    validateToolTask(
      { ...task, selection: { ...task.selection!, width: 320, height: 320 } },
      [source],
    ).some((error) => error.includes("原图尺寸")),
  );
});
test("layer decomposition distinguishes unknown format metadata from a known incompatible input", () => {
  const task = createCanvasToolTask("layer-decompose", [source.nodeId], {
    mode: "smart",
    resolution: "auto",
    prompt: "",
  });
  assert.deepEqual(
    validateToolTask(task, [{ ...source, mimeType: undefined }], {
      available: true,
      parametersConfirmed: true,
    }),
    [],
  );
  assert.ok(
    validateToolTask(task, [{ ...source, mimeType: "image/webp" }]).some(
      (error) => error.includes("PNG / JPEG"),
    ),
  );
  assert.ok(
    validateToolTask(task, [{ ...source, width: 256, height: 256 }]).some(
      (error) => error.includes("262,144"),
    ),
  );
});
test("dynamic options and unknown task protocols cannot be guessed into a valid request", () => {
  const task = createCanvasToolTask("view-control", [source.nodeId], {
    yaw: -10.2,
    pitch: 11.6,
    distance: "close",
  });
  assert.equal(task.parameters.yaw, 350);
  assert.equal(task.parameters.pitch, 12);
  assert.ok(
    validateToolTask(task, [source]).some((error) =>
      error.includes("可用选项"),
    ),
  );
  assert.deepEqual(
    validateToolTask(task, [source], {
      available: true,
      fields: [
        {
          key: "distance",
          label: "距离",
          type: "select",
          required: true,
          options: [{ value: "close", label: "近景" }],
        },
      ],
    }),
    [],
  );
  assert.ok(
    validateToolTask(createCanvasToolTask("multi-size", [source.nodeId], {}), [
      source,
    ]).some((error) => error.includes("尚未接入")),
  );
});

test("face emphasis only accompanies the four-view preset", () => {
  assert.deepEqual(
    createCanvasToolTask("image-presets", [source.nodeId], {
      preset: "four-view",
      faceEmphasis: true,
    }).parameters,
    { preset: "four-view", faceEmphasis: true },
  );
  assert.deepEqual(
    createCanvasToolTask("image-presets", [source.nodeId], {
      preset: "three-view",
      faceEmphasis: true,
    }).parameters,
    { preset: "three-view" },
  );
});

test("observed marketing presets derive exact pixels while custom dimensions remain explicit", () => {
  const confirmed = { available: true, parametersConfirmed: true };
  for (const [aspectRatio, outputWidth, outputHeight] of [
    ["1:1", 1200, 1200],
    ["3:4", 1200, 1600],
    ["9:16", 1080, 1920],
    ["16:9", 1920, 1080],
    ["4:3", 1600, 1200],
    ["21:9", 2520, 1080],
    ["2:3", 1200, 1800],
    ["3:2", 1800, 1200],
  ] as const) {
    const task = createCanvasToolTask("multi-size", [source.nodeId], {
      aspectRatio,
      outputWidth: 42,
      outputHeight: 17,
    });
    assert.equal(task.parameters.outputWidth, outputWidth);
    assert.equal(task.parameters.outputHeight, outputHeight);
    assert.deepEqual(validateToolTask(task, [source], confirmed), []);
    assert.ok(
      validateToolTask(
        { ...task, parameters: { ...task.parameters, outputHeight: 17 } },
        [source],
        confirmed,
      ).some((error) => error.includes("实测尺寸")),
    );
    assert.ok(
      validateToolTask(task, [source]).some((error) =>
        error.includes("尚未接入"),
      ),
    );
  }
  const custom = createCanvasToolTask("multi-size", [source.nodeId], {
    aspectRatio: "custom",
    outputWidth: 1000,
    outputHeight: 800,
  });
  assert.deepEqual(validateToolTask(custom, [source], confirmed), []);
  const incompleteCustom: ToolParameters[] = [
    { aspectRatio: "custom" },
    { aspectRatio: "custom", outputWidth: 0, outputHeight: 800 },
    { aspectRatio: "custom", outputWidth: 1000, outputHeight: 1.5 },
  ];
  for (const parameters of incompleteCustom)
    assert.ok(
      validateToolTask(
        createCanvasToolTask("multi-size", [source.nodeId], parameters),
        [source],
        confirmed,
      ).some((error) => error.includes("自定义尺寸")),
    );
});

test("layer split modes require their own input without treating observed UI as a connected protocol", () => {
  const confirmed = { available: true, parametersConfirmed: true };
  const make = (mode: string, prompt = "") =>
    createCanvasToolTask("layer-decompose", [source.nodeId], {
      mode,
      prompt,
      resolution: "auto",
    });
  assert.deepEqual(validateToolTask(make("smart"), [source], confirmed), []);
  assert.ok(
    validateToolTask(make("description", "  "), [source], confirmed).some(
      (error) => error.includes("拆分描述"),
    ),
  );
  assert.deepEqual(
    validateToolTask(
      make("description", "背景与主体分别成层"),
      [source],
      confirmed,
    ),
    [],
  );
  assert.ok(
    validateToolTask(make("boxes"), [source], confirmed).some((error) =>
      error.includes("矩形选区"),
    ),
  );
  const boxed = {
    ...make("boxes"),
    selection: {
      sourceNodeId: source.nodeId,
      width: 1024,
      height: 1024,
      boxes: [{ x: 10, y: 20, width: 200, height: 300 }],
    },
  };
  assert.deepEqual(validateToolTask(boxed, [source], confirmed), []);
  assert.ok(
    validateToolTask(
      {
        ...boxed,
        selection: {
          ...boxed.selection,
          boxes: [{ x: 1000, y: 0, width: 200, height: 100 }],
        },
      },
      [source],
      confirmed,
    ).some((error) => error.includes("拆分区域")),
  );
  assert.ok(
    validateToolTask(boxed, [source]).some((error) =>
      error.includes("尚未接入"),
    ),
  );
});

test("video edit uses actual 4–30 second source metadata and rejects invented resolution/background options", () => {
  const confirmed = { available: true, parametersConfirmed: true };
  const video: ToolSource = {
    nodeId: "video-1",
    kind: "video",
    title: "Scene",
    src: "data:video/mp4;base64,a",
    durationSeconds: 4,
  };
  const edit = createCanvasToolTask("video-edit", [video.nodeId], {
    prompt: "更换背景",
    annotationTool: "rectangle",
  });
  for (const durationSeconds of [4, 30])
    assert.deepEqual(
      validateToolTask(edit, [{ ...video, durationSeconds }], confirmed),
      [],
    );
  for (const durationSeconds of [3.99, 30.01])
    assert.ok(
      validateToolTask(edit, [{ ...video, durationSeconds }], confirmed).some(
        (error) => error.includes("4–30"),
      ),
    );
  assert.ok(
    validateToolTask(
      edit,
      [{ ...video, durationSeconds: undefined }],
      confirmed,
    ).some((error) => error.includes("无法确认视频时长")),
  );
  for (const background of ["black", "green", "transparent"])
    assert.deepEqual(
      validateToolTask(
        createCanvasToolTask("video-matting", [video.nodeId], { background }),
        [video],
        confirmed,
      ),
      [],
    );
  assert.ok(
    validateToolTask(
      createCanvasToolTask("video-matting", [video.nodeId], {
        background: "white",
      }),
      [video],
      confirmed,
    ).some((error) => error.includes("可用选项")),
  );
  for (const resolution of ["480P", "720P"])
    assert.deepEqual(
      validateToolTask(
        createCanvasToolTask("video-depth-capture", [video.nodeId], {
          resolution,
        }),
        [video],
        confirmed,
      ),
      [],
    );
  assert.ok(
    validateToolTask(
      createCanvasToolTask("video-depth-capture", [video.nodeId], {
        resolution: "1080P",
      }),
      [video],
      confirmed,
    ).some((error) => error.includes("可用选项")),
  );
  const noExtra = CANVAS_TOOLS.find(
    (tool) => tool.id === "video-subtitle-erasure",
  )!;
  assert.deepEqual(initialToolParameters(noExtra), {});
  assert.equal(noExtra.execution, "remote");
  assert.ok(
    validateToolTask(
      createCanvasToolTask("video-subtitle-erasure", [video.nodeId], {}),
      [video],
    ).some((error) => error.includes("尚未接入")),
  );
});

test("panorama uses connected editing models and rejects a removed selection", () => {
  const definition = CANVAS_TOOLS.find((tool) => tool.id === "panorama")!;
  const capability = {
    available: true,
    parametersConfirmed: true,
    models: { "image.edit": [{ id: "editor-1", label: "Image editor" }] },
    fields: [
      {
        key: "resolution",
        label: "清晰度",
        type: "select" as const,
        default: "2K",
        options: [{ value: "2K", label: "2K" }],
      },
    ],
  };
  const parameters = initialToolParameters(definition, capability);
  assert.equal(parameters.imageModelConfigId, "editor-1");
  const task = createCanvasToolTask("panorama", [source.nodeId], parameters);
  assert.deepEqual(validateToolTask(task, [source], capability), []);
  assert.ok(
    validateToolTask(task, [source], {
      ...capability,
      models: { "image.edit": [] },
    }).some((error) => error.includes("可用选项")),
  );
});

test("adapter-supplied field labels and options are translated for display", () => {
  const tool = CANVAS_TOOLS.find((item) => item.id === "audio-separation")!;
  setActiveLocale("en-US");
  const fields = toolFields(tool, {
    available: true,
    fields: [
      {
        key: "mode",
        label: "分离方式",
        type: "select",
        options: [{ value: "all", label: "完整音轨" }],
      },
    ],
  });
  const field = fields.find((item) => item.key === "mode")!;
  assert.equal(field.label, "Separation mode");
  assert.equal(field.options?.[0]?.label, "Full soundtrack");
  assert.equal(field.options?.[0]?.value, "all");
  setActiveLocale("zh-CN");
  assert.equal(
    toolFields(tool, {
      available: true,
      fields: [{ key: "mode", label: "分离方式", type: "select" }],
    }).find((item) => item.key === "mode")!.label,
    "分离方式",
  );
});

test("mask composite takes two video sources: the content, then its mask", () => {
  const confirmed = { available: true, parametersConfirmed: true };
  const clip = (nodeId: string): ToolSource => ({
    nodeId,
    kind: "video",
    title: nodeId,
    src: "data:video/mp4;base64,a",
    mimeType: "video/mp4",
    width: 64,
    height: 36,
    durationSeconds: 5,
  });
  const task = createCanvasToolTask("video-mask-composite", ["depth", "mask"], {
    stretch: true,
  });
  assert.deepEqual(
    validateToolTask(task, [clip("depth"), clip("mask")], confirmed),
    [],
  );
  assert.ok(
    validateToolTask(
      createCanvasToolTask("video-mask-composite", ["depth"], {
        stretch: true,
      }),
      [clip("depth")],
      confirmed,
    ).length > 0,
  );
  assert.ok(
    validateToolTask(
      createCanvasToolTask("video-mask-composite", ["depth", source.nodeId], {
        stretch: true,
      }),
      [clip("depth"), source],
      confirmed,
    ).length > 0,
  );
  assert.deepEqual(
    initialToolParameters(
      CANVAS_TOOLS.find((tool) => tool.id === "video-matting")!,
    ).background !== undefined,
    true,
  );
});
