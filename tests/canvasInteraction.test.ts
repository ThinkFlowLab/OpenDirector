import assert from "node:assert/strict";
import test from "node:test";
import { setActiveLocale } from "../src/i18n/messages.ts";
import {
  buildCanvasArchive,
  readCanvasArchive,
} from "../src/canvas/canvasArchive.ts";
import { generationDefaults } from "../src/canvas/generationCatalog.ts";
import {
  beginTransaction,
  commitTransaction,
  createHistory,
  executeCommand,
  undo,
  updateTransaction,
} from "../src/canvas/history.ts";
import {
  applyCommand,
  createDocument,
  createNode,
} from "../src/canvas/model.ts";
import type { ModelConfig } from "../src/backend/rules.ts";
import {
  authorFlowChanges,
  canvasKeyAction,
  canvasSelectAllIds,
  connectionDragReleased,
  droppedConnectionTarget,
  mergeFlowSelection,
  placeCreatedNode,
  serviceGenerationPlan,
  textGenerationPlan,
} from "../src/canvas/workspaceInteraction.ts";

setActiveLocale("zh-CN");

const key = (
  patch: Partial<Parameters<typeof canvasKeyAction>[0]> = {},
) =>
  canvasKeyAction({
    key: "",
    code: "",
    mod: false,
    shift: false,
    hasClipboard: false,
    editText: false,
    hasSingle: false,
    ...patch,
  });

const model = (
  kind: ModelConfig["kind"],
  rules: Partial<ModelConfig["inputRules"]> = {},
): ModelConfig => ({
  id: `${kind}-model`,
  kind,
  url: "http://127.0.0.1:8010/v1",
  modelId: "fixture/model",
  connectionType: "self_hosted",
  protocol: kind === "agent" ? "openai" : "vllm_omni",
  authMode: "none",
  inputRules: {
    profile: "fixture",
    allowedKinds: ["text", "image", "video", "audio"],
    maxImages: 4,
    maxVideos: 1,
    maxAudios: 1,
    videoModes: ["first_frame", "reference", "continuation"],
    ...rules,
  },
});

const ready = (
  kind: "image" | "video" | "audio" | "text",
  data: Record<string, unknown> = {},
) =>
  createNode(kind, { x: 0, y: 0 }, {
    ...(kind === "text"
      ? { text: "旁白" }
      : { src: `data:${kind}/x;base64,AA==`, assetState: "ready" as const }),
    ...data,
  });

test("selection merges flow changes in place and select-all skips folded stack members", () => {
  assert.deepEqual(
    mergeFlowSelection(
      ["a", "b"],
      [
        { id: "c", selected: true },
        { id: "a", selected: false },
        { id: "d", selected: true },
        { id: "d", selected: false },
      ],
    ),
    ["b", "c"],
  );
  const member = createNode("image");
  const loose = createNode("text");
  const stack = createNode("stack", undefined, {
    stack: { nodeIds: [member.id], activeIndex: 0 },
  });
  assert.deepEqual(canvasSelectAllIds([member, loose, stack]), [
    loose.id,
    stack.id,
  ]);
});

test("a drag inside click slop or after cancel authors nothing; a real drag is one undo step", () => {
  const node = createNode("image", { x: 0, y: 0 });
  const move = [
    { type: "position", id: node.id, position: { x: 40, y: 12 } },
  ];
  assert.equal(
    authorFlowChanges(move, { cancelled: false, dragging: true, moved: false }),
    null,
  );
  assert.equal(
    authorFlowChanges(move, { cancelled: true, dragging: true, moved: true }),
    null,
  );
  const authored = authorFlowChanges(move, {
    cancelled: false,
    dragging: true,
    moved: true,
  });
  assert.equal(authored?.type, "batch");
  let history = beginTransaction(
    createHistory({ ...createDocument(), nodes: [node] }),
  );
  history = updateTransaction(
    history,
    applyCommand(history.present, authored!),
  );
  history = commitTransaction(history);
  assert.deepEqual(history.present.nodes[0]!.position, { x: 40, y: 12 });
  assert.equal(history.past.length, 1);
  assert.deepEqual(undo(history).present.nodes[0]!.position, { x: 0, y: 0 });
});

test("a resize authors one command and keeps the compensating position", () => {
  const node = createNode("group", { x: 10, y: 20 });
  const authored = authorFlowChanges(
    [
      {
        type: "dimensions",
        id: node.id,
        dimensions: { width: 800, height: 500 },
        setAttributes: true,
      },
      { type: "position", id: node.id, position: { x: 8, y: 16 } },
      { type: "position", id: "child", position: { x: 1, y: 1 } },
    ],
    { cancelled: false, dragging: false, moved: false },
  );
  assert.deepEqual(authored, {
    type: "resize-node",
    id: node.id,
    width: 800,
    height: 500,
    position: { x: 8, y: 16 },
  });
});

test("connection drops ignore clicks, cancelled drags, and landings on other nodes", () => {
  const start = { x: 10, y: 10 };
  const base = {
    spacePressed: false,
    cancelled: false,
    moved: false,
    start,
    point: { x: 14, y: 10 },
    isValid: false,
    hasEndpoints: true,
  };
  assert.equal(connectionDragReleased(base), false);
  assert.equal(
    connectionDragReleased({ ...base, point: { x: 15, y: 10 } }),
    true,
  );
  assert.equal(
    connectionDragReleased({ ...base, moved: true, point: start }),
    true,
  );
  assert.equal(connectionDragReleased({ ...base, moved: true, spacePressed: true }), false);
  assert.equal(connectionDragReleased({ ...base, moved: true, cancelled: true }), false);
  assert.equal(connectionDragReleased({ ...base, moved: true, isValid: true }), false);
  assert.equal(
    connectionDragReleased({ ...base, moved: true, hasEndpoints: false }),
    false,
  );
  assert.equal(
    droppedConnectionTarget({
      toNodeId: "image",
      groupId: null,
      onPane: false,
      fromNodeId: "source",
      direction: "source",
    }),
    null,
  );
  assert.deepEqual(
    droppedConnectionTarget({
      toNodeId: null,
      groupId: null,
      onPane: true,
      fromNodeId: "source",
      direction: "source",
    }),
    { id: "source", direction: "source" },
  );
  assert.deepEqual(
    droppedConnectionTarget({
      toNodeId: "group",
      groupId: "group",
      onPane: false,
      fromNodeId: "source",
      direction: "target",
    }),
    { id: "source", direction: "target", parentId: "group" },
  );
});

test("a connected node is placed on the dropped port and then inside its group", () => {
  const size = { width: 300, height: 200 };
  const where = { x: 100, y: 80 };
  assert.deepEqual(placeCreatedNode(size, where).position, { x: -50, y: -20 });
  assert.deepEqual(
    placeCreatedNode(size, where, { direction: "source", side: "right" }).position,
    { x: 100, y: -20 },
  );
  assert.deepEqual(
    placeCreatedNode(size, where, { direction: "target", side: "left" }).position,
    { x: -200, y: -20 },
  );
  assert.deepEqual(
    placeCreatedNode(size, where, { direction: "source", side: "top" }).position,
    { x: -50, y: -120 },
  );
  const nested = placeCreatedNode(size, where, { direction: "source", side: "bottom" }, {
    id: "group",
    origin: { x: 30, y: 10 },
  });
  assert.deepEqual(nested, {
    position: { x: -80, y: 70 },
    parentId: "group",
  });
});

test("canvas shortcuts map to history, selection, import, and nudges", () => {
  assert.deepEqual(key({ key: "z", mod: true }), { type: "history", forward: false });
  assert.deepEqual(key({ key: "z", mod: true, shift: true }), {
    type: "history",
    forward: true,
  });
  assert.deepEqual(key({ key: "y", mod: true }), { type: "history", forward: true });
  assert.equal(key({ key: "a", mod: true })?.type, "select-all");
  assert.equal(key({ key: "o", mod: true })?.type, "import");
  assert.equal(key({ key: "s", mod: true })?.type, "save");
  assert.equal(key({ key: "v", mod: true })?.type, undefined);
  assert.deepEqual(key({ key: "v", mod: true, hasClipboard: true }), {
    type: "paste",
    duplicate: false,
  });
  assert.deepEqual(key({ key: "d", mod: true }), { type: "paste", duplicate: true });
  assert.deepEqual(key({ key: "g", code: "KeyG", mod: true, shift: true }), {
    type: "group",
    ungroup: true,
  });
  assert.deepEqual(key({ code: "BracketLeft", mod: true }), {
    type: "reorder",
    direction: "backward",
  });
  assert.deepEqual(key({ code: "BracketRight", mod: true, shift: true }), {
    type: "reorder",
    direction: "front",
  });
  assert.deepEqual(key({ key: "ArrowLeft", shift: true }), {
    type: "nudge",
    delta: { x: -10, y: 0 },
  });
  assert.deepEqual(key({ key: "ArrowDown" }), {
    type: "nudge",
    delta: { x: 0, y: 1 },
  });
  assert.equal(key({ key: "Enter", editText: true })?.type, "edit-text");
  assert.equal(key({ key: "Enter" }), null);
  assert.equal(key({ key: "f", hasSingle: true })?.type, "preview");
  assert.equal(key({ key: "t" })?.type, "add-text");
  assert.equal(key({ key: "Delete" })?.type, "delete");

  const node = createNode("image", { x: 5, y: 6 });
  const nudge = key({ key: "ArrowRight" });
  assert.equal(nudge?.type, "nudge");
  const history = executeCommand(
    createHistory({ ...createDocument(), nodes: [node] }),
    { type: "move-nodes", ids: [node.id], delta: nudge!.type === "nudge" ? nudge.delta : { x: 0, y: 0 } },
  );
  assert.deepEqual(history.present.nodes[0]!.position, { x: 6, y: 6 });
  assert.deepEqual(undo(history).present.nodes[0]!.position, { x: 5, y: 6 });
});

test("generation submission marks unused inputs context-only and keeps one audio run", () => {
  const video = model("video");
  const first = ready("image");
  const extra = ready("image");
  const caption = ready("text");
  const node = createNode("video", { x: 20, y: 30 }, {
    title: "镜头",
    prompt: "推进",
    promptContent: [
      { type: "text", text: "推进" },
      {
        type: "reference",
        binding: "asset",
        assetId: "pin",
        name: "定妆",
        fingerprint: "abc",
      },
    ],
    settings: {
      ...generationDefaults("video"),
      modelConfigId: video.id,
      prompt: "推进",
      videoMode: "first-last",
      firstFrameNodeId: first.id,
      resolution: "auto",
      aspectRatio: "auto",
      count: 2,
      voiceName: "voice_1",
    },
  });
  const document = {
    ...createDocument("短片"),
    nodes: [first, extra, caption, node],
  };
  const plan = serviceGenerationPlan({
    document,
    node,
    incoming: [first, extra, caption],
    models: [video],
    assets: [{ id: "pin", kind: "image" }],
  });
  assert.equal(plan.status, "ready");
  if (plan.status !== "ready") return;
  assert.equal(plan.count, 2);
  assert.equal(plan.request.videoMode, "first_frame");
  assert.equal(plan.request.voice, "voice_1");
  assert.equal(plan.request.durationSeconds, undefined);
  assert.equal(plan.label, "推进");
  assert.deepEqual(
    plan.request.references.map((item) => [item.title, item.contextOnly]),
    [
      [first.data.title, false],
      [extra.data.title, true],
      [caption.data.title, false],
      ["定妆", true],
    ],
  );
  assert.deepEqual(Object.keys(plan.origin.referenceInputs ?? {}).sort(), [
    caption.id,
    first.id,
  ].sort());

  const speech = model("audio", { allowedKinds: ["text"], videoModes: [] });
  const voice = createNode("audio", undefined, {
    title: "旁白",
    prompt: "你好",
    settings: {
      ...generationDefaults("audio"),
      modelConfigId: speech.id,
      prompt: "你好",
      count: 4,
      audioMode: "tts",
      voiceName: "voice_1",
    },
  });
  const audioPlan = serviceGenerationPlan({
    document,
    node: voice,
    incoming: [],
    models: [speech],
    assets: [],
  });
  assert.equal(audioPlan.status, "ready");
  if (audioPlan.status !== "ready") return;
  assert.equal(audioPlan.count, 1);
  assert.equal(audioPlan.request.voice, "voice_1");
  assert.equal(audioPlan.request.kind, "audio");

  const blocked = serviceGenerationPlan({
    document,
    node: createNode("image", undefined, {
      settings: {
        ...generationDefaults("image"),
        modelConfigId: model("image").id,
        resolution: "auto",
      },
    }),
    incoming: [],
    models: [model("image")],
    assets: [],
  });
  assert.equal(blocked.status, "blocked");
  if (blocked.status === "blocked") assert.match(blocked.message ?? "", /生成要求/);

  assert.throws(
    () =>
      serviceGenerationPlan({
        document,
        node,
        incoming: [first],
        models: [video],
        assets: [],
      }),
    /固定参考元数据/,
  );
});

test("a text node submits its agent settings and refuses to run without one", () => {
  const agent = model("agent", { allowedKinds: ["text"], maxImages: 0, videoModes: [] });
  const node = createNode("text", undefined, {
    title: "大纲",
    prompt: "写一幕",
    text: "旧稿",
    agentSettings: { modelConfigId: agent.id, thinking: "low", maxTokens: 1000 },
  });
  const document = { ...createDocument("短片"), nodes: [node] };
  const plan = textGenerationPlan({
    document,
    node,
    incoming: [],
    models: [agent],
    assets: [],
  });
  assert.equal(plan.status, "ready");
  if (plan.status !== "ready") return;
  assert.equal(plan.request.kind, "text");
  assert.equal(plan.request.videoMode, "first_frame");
  assert.equal(plan.request.thinking, "low");
  assert.equal(plan.request.maxTokens, 1000);
  assert.equal(plan.request.prompt, "写一幕");
  assert.equal(plan.origin.text, "旧稿");
  assert.equal(plan.label, "大纲");

  const missing = textGenerationPlan({
    document,
    node,
    incoming: [],
    models: [],
    assets: [],
  });
  assert.equal(missing.status, "blocked");
  if (missing.status === "blocked") assert.match(missing.message ?? "", /Agent/);
});

test("placed nodes, connections, and history survive a canvas archive round trip", async () => {
  const source = createNode("text", { x: 0, y: 0 }, { text: "第一场", title: "场次" });
  const target = createNode("image", { x: 0, y: 0 }, {
    title: "画面",
    prompt: "雨",
    settings: { ...generationDefaults("image"), prompt: "雨" },
  });
  const placed = placeCreatedNode(target, { x: 480, y: 200 }, {
    direction: "source",
    side: "right",
  });
  target.position = placed.position;
  assert.deepEqual(target.position, { x: 480, y: 50 });
  let document = {
    ...createDocument("导出"),
    nodes: [source, target],
  };
  document = applyCommand(document, {
    type: "add-edge",
    edge: {
      id: "edge-1",
      source: source.id,
      target: target.id,
    },
  });
  const nudge = key({ key: "ArrowUp", shift: true });
  assert.equal(nudge?.type, "nudge");
  document = applyCommand(document, {
    type: "move-nodes",
    ids: [target.id],
    delta: nudge!.type === "nudge" ? nudge.delta : { x: 0, y: 0 },
  });
  const moved = document.nodes.find((node) => node.id === target.id);
  assert.deepEqual(moved?.position, { x: 480, y: 40 });
  const archive = await buildCanvasArchive(document, {
    now: new Date("2026-11-06T00:00:00.000Z"),
  });
  const imported = await readCanvasArchive(archive.blob);
  const image = imported.document.nodes.find((node) => node.id === target.id);
  assert.equal(imported.document.title, "导出");
  assert.deepEqual(image?.position, { x: 480, y: 40 });
  assert.equal(image?.data.prompt, "雨");
  assert.equal(image?.data.settings?.prompt, "雨");
  assert.deepEqual(
    imported.document.edges.map((edge) => [edge.source, edge.target]),
    [[source.id, target.id]],
  );
});
