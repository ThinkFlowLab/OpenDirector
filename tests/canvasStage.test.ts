import assert from "node:assert/strict";
import test from "node:test";
import {
  createLocalStage,
  defaultStageCamera,
  parseLocalStageDocument,
  parseLocalStageValue,
  sameLocalStage,
  sampleStage,
  sampleStageCamera,
  stageCameraAt,
  editStageObjectAt,
  editStageCameraAt,
  captureStageFrame,
  removeStageFrame,
  stageOutputSize,
  STAGE_RATIOS,
} from "../src/canvas/stageDocument.ts";
import {
  sampleJointPose,
  selectStageAnimation,
  STAGE_ANIMATION_HINTS,
  STAGE_MOTIONS,
} from "../src/canvas/stageMotion.ts";
import {
  createStageHistory,
  commitStageHistory,
  navigateStageHistory,
} from "../src/canvas/stageHistory.ts";

function oldStage() {
  const camera = defaultStageCamera();
  const object = {
    id: "person",
    kind: "person",
    name: "人物",
    color: "#a09af9",
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    motion: { preset: "walk", speed: 1.5, amount: 0.8 },
  };
  return {
    format: "opendirector-local-stage",
    version: 1,
    background: "#151923",
    grid: true,
    duration: 6,
    camera,
    objects: [object],
    keyframes: [
      {
        id: "a",
        time: 0,
        camera,
        objects: [{ id: object.id, transform: object }],
      },
      {
        id: "b",
        time: 6,
        camera: { ...camera, position: { x: 11, y: 3.5, z: 7 } },
        objects: [
          {
            id: object.id,
            transform: { ...object, position: { x: 6, y: 6, z: 0 } },
          },
        ],
      },
    ],
  };
}

test("V1 migrates once to independent tracks without changing camera, object or motion sampling", () => {
  const raw = oldStage(),
    stage = parseLocalStageValue(raw),
    pose = sampleStage(stage, 3);
  assert.equal(stage.version, 2);
  assert.deepEqual(pose.objects[0]!.position, { x: 3, y: 3, z: 0 });
  assert.equal(pose.camera.position.x, 8);
  assert.equal(pose.objects[0]!.motion?.preset, "walk");
  assert.equal(pose.objects[0]!.motionTime, 3);
  assert.equal(sampleStage(stage, 100).objects[0]!.position.x, 6);
  assert.deepEqual(
    parseLocalStageValue(JSON.parse(JSON.stringify(stage))),
    stage,
  );
  stage.objects[0]!.keyframes[0]!.value.position.x = 99;
  assert.equal(raw.objects[0]!.position.x, 0);
  assert.equal(sameLocalStage(stage, parseLocalStageValue(raw)), false);
});

test("legacy malformed references and duplicate frame times remain rejected during migration", () => {
  const raw = oldStage();
  assert.throws(
    () =>
      parseLocalStageValue({
        ...raw,
        keyframes: [
          ...raw.keyframes,
          { ...raw.keyframes[0], id: "duplicate-time" },
        ],
      }),
    /不能重复/,
  );
  assert.throws(
    () =>
      parseLocalStageValue({
        ...raw,
        keyframes: [
          {
            ...raw.keyframes[0],
            objects: [{ id: "missing", transform: raw.objects[0] }],
          },
        ],
      }),
    /缺失/,
  );
  assert.throws(
    () =>
      parseLocalStageValue({
        ...raw,
        objects: [{ ...raw.objects[0], kind: "box" }],
      }),
    /只有人物/,
  );
  assert.throws(
    () =>
      parseLocalStageValue({
        ...raw,
        camera: { ...raw.camera, target: raw.camera.position },
      }),
    /摄像机/,
  );
});

test("stage JSON text imports reject unparsable files with a localized notice", () => {
  const stage = createLocalStage();
  assert.ok(
    sameLocalStage(stage, parseLocalStageDocument(JSON.stringify(stage))),
  );
  // Binary model bytes fed to the JSON importer must not surface an engine
  // SyntaxError quoting the file's contents.
  assert.throws(
    () => parseLocalStageDocument("glTF\u0000\u0000\u0000\u0000"),
    /不是舞台 JSON/,
  );
  assert.throws(() => parseLocalStageDocument("{ broken"), /不是舞台 JSON/);
});

test("editing one axis at the playhead preserves the other sampled axes and untouched tracks", () => {
  const stage = parseLocalStageValue(oldStage());
  const at = sampleStage(stage, 3);
  const edited = editStageObjectAt(stage, "person", 3, {
    position: { ...at.objects[0]!.position, y: 4 },
  });
  assert.deepEqual(sampleStage(edited, 3).objects[0]!.position, {
    x: 3,
    y: 4,
    z: 0,
  });
  assert.deepEqual(sampleStage(edited, 0).objects[0]!.position, {
    x: 0,
    y: 0,
    z: 0,
  });
  assert.deepEqual(sampleStage(edited, 6).objects[0]!.position, {
    x: 6,
    y: 6,
    z: 0,
  });
  assert.deepEqual(edited.cameras, stage.cameras);
  const camera = sampleStageCamera(edited, "camera-1", 3);
  const cameraEdit = editStageCameraAt(edited, "camera-1", 3, {
    position: { ...camera.position, y: 5 },
  });
  assert.deepEqual(sampleStage(cameraEdit, 3).camera.position, {
    x: 8,
    y: 5,
    z: 7,
  });
  assert.deepEqual(cameraEdit.objects, edited.objects);
});

test("the first edit away from zero anchors the opening pose; unchanged orbit commits create no undo step", () => {
  const stage = createLocalStage(),
    id = stage.objects[0]!.id;
  const moved = editStageObjectAt(stage, id, 4, {
    position: { x: 4, y: 2, z: 0 },
  });
  assert.deepEqual(sampleStage(moved, 0).objects[0]!.position, {
    x: 0,
    y: 0,
    z: 0,
  });
  assert.deepEqual(sampleStage(moved, 2).objects[0]!.position, {
    x: 2,
    y: 1,
    z: 0,
  });
  const camera = sampleStage(stage, 0).camera;
  assert.equal(
    editStageCameraAt(stage, stage.activeCameraId, 3, camera),
    stage,
  );
  const history = createStageHistory(stage);
  assert.equal(
    commitStageHistory(
      history,
      editStageCameraAt(stage, stage.activeCameraId, 3, camera),
    ),
    history,
  );
  const renamed = editStageObjectAt(moved, id, 2, { name: "改名" });
  assert.deepEqual(renamed.objects[0]!.position, moved.objects[0]!.position);
  assert.deepEqual(renamed.objects[0]!.keyframes, moved.objects[0]!.keyframes);
});

test("current-frame capture and removal affect every sampled track, while history restores deleted objects and clips", () => {
  const stage = parseLocalStageValue(oldStage());
  let history = createStageHistory(stage);
  history = commitStageHistory(history, captureStageFrame(stage, 3));
  assert.equal(history.present.objects[0]!.keyframes.length, 3);
  history = commitStageHistory(history, { ...history.present, objects: [] });
  const restored = navigateStageHistory(history, "undo");
  assert.equal(restored.present.objects[0]!.motionClips.length, 1);
  assert.equal(restored.present.objects[0]!.keyframes.length, 3);
  assert.equal(
    navigateStageHistory(restored, "redo").present.objects.length,
    0,
  );
  const branched = commitStageHistory(
    restored,
    removeStageFrame(restored.present, 3),
  );
  assert.equal(branched.future.length, 0);
  assert.equal(branched.present.objects[0]!.keyframes.length, 2);
  assert.equal(branched.present.cameras[0]!.keyframes.length, 2);
  assert.equal(
    commitStageHistory(branched, structuredClone(branched.present)),
    branched,
  );
});

test("consecutive action clips switch exactly at boundaries, restart phase and leave gaps idle", () => {
  const stage = createLocalStage();
  stage.objects[0]!.motionClips = [
    {
      id: "walk",
      start: 0,
      duration: 2,
      motion: { preset: "walk", speed: 1, amount: 1 },
    },
    {
      id: "wave",
      start: 2,
      duration: 2,
      motion: { preset: "wave", speed: 2, amount: 0.5 },
    },
  ];
  const parsed = parseLocalStageValue(stage);
  assert.equal(sampleStage(parsed, 1.999).objects[0]!.motion?.preset, "walk");
  assert.equal(sampleStage(parsed, 2).objects[0]!.motion?.preset, "wave");
  assert.equal(sampleStage(parsed, 2).objects[0]!.motionTime, 0);
  const sample = sampleStage(parsed, 2.125).objects[0]!;
  assert.deepEqual(
    sampleJointPose(sample.motion, sample.motionTime),
    sampleJointPose({ preset: "wave", speed: 2, amount: 0.5 }, 0.125),
  );
  assert.equal(sampleStage(parsed, 4).objects[0]!.motion, undefined);
  assert.ok(Object.values(sampleJointPose(undefined, 0)).every((v) => v === 0));
  const changed = structuredClone(parsed);
  changed.objects[0]!.motionClips[1]!.motion.speed = 3;
  assert.equal(sameLocalStage(parsed, changed), false);
});

test("clips reject overlaps, invalid rates, out-of-bounds times and non-character owners", () => {
  const stage = createLocalStage();
  const clip = {
    id: "a",
    start: 0,
    duration: 2,
    motion: { preset: "walk", speed: 1, amount: 1 },
  };
  for (const clips of [
    [clip, { ...clip, id: "b", start: 1 }],
    [{ ...clip, start: 5 }],
    [{ ...clip, start: -1 }],
    [{ ...clip, duration: 0 }],
    [{ ...clip, motion: { ...clip.motion, speed: 0 } }],
    [{ ...clip, motion: { ...clip.motion, preset: "missing" } }],
  ])
    assert.throws(() =>
      parseLocalStageValue({
        ...stage,
        objects: [{ ...stage.objects[0], motionClips: clips }],
      }),
    );
  assert.throws(
    () =>
      parseLocalStageValue({
        ...stage,
        objects: [{ ...stage.objects[0], kind: "box", motionClips: [clip] }],
      }),
    /只有人物/,
  );
});

test("storyboard hard cuts use independent camera animation, hold the last frame, and share JSON/MP4 sample semantics", () => {
  let stage = createLocalStage();
  stage.cameras.push({
    id: "b",
    name: "反打",
    pose: { ...defaultStageCamera(), position: { x: -5, y: 3.5, z: 7 } },
    keyframes: [],
  });
  stage = editStageCameraAt(stage, "camera-1", 0, {
    position: { x: 1, y: 3.5, z: 7 },
  });
  stage = editStageCameraAt(stage, "camera-1", 6, {
    position: { x: 7, y: 3.5, z: 7 },
  });
  stage = editStageCameraAt(stage, "b", 0, {
    position: { x: -1, y: 3.5, z: 7 },
  });
  stage = editStageCameraAt(stage, "b", 6, {
    position: { x: -7, y: 3.5, z: 7 },
  });
  stage.cameraSource = "storyboard";
  stage.shots = [
    { id: "first", cameraId: "camera-1", start: 0, duration: 2 },
    { id: "reverse", cameraId: "b", start: 2, duration: 4 },
  ];
  const reloaded = parseLocalStageValue(JSON.parse(JSON.stringify(stage)));
  assert.equal(sampleStage(reloaded, 2 - 1 / 30).cameraId, "camera-1");
  assert.equal(sampleStage(reloaded, 2).cameraId, "b");
  assert.equal(sampleStage(reloaded, 2).camera.position.x, -3);
  assert.equal(sampleStage(reloaded, 6).camera.position.x, -7);
  assert.equal(
    sampleStage({ ...reloaded, cameraSource: "camera" }, 3).cameraId,
    "camera-1",
  );
  assert.equal(
    sampleStage({ ...reloaded, shots: [reloaded.shots[1]!] }, 1).cameraId,
    "camera-1",
  );
  for (const at of [0, 1 / 30, 1.99, 2, 3, 5.99])
    assert.deepEqual(sampleStage(reloaded, at), sampleStage(stage, at));
  assert.equal(sameLocalStage(stage, reloaded), true);
  assert.equal(
    sameLocalStage(stage, { ...reloaded, cameraSource: "camera" }),
    false,
  );
});

test("stageCameraAt resolves the evaluating shot for retargeting without flipping the source", () => {
  const stage = createLocalStage();
  stage.cameras.push({
    id: "b",
    name: "反打",
    pose: { ...defaultStageCamera(), position: { x: -5, y: 3.5, z: 7 } },
    keyframes: [],
  });
  stage.cameraSource = "storyboard";
  stage.shots = [{ id: "first", cameraId: "b", start: 2, duration: 4 }];
  const inside = stageCameraAt(stage, 3.5);
  assert.equal(inside.cameraId, "b");
  assert.equal(inside.shot?.id, "first");
  // Half-open boundaries: the start belongs to the shot, and the last
  // instant of the timeline closes a shot ending exactly at the duration.
  assert.equal(stageCameraAt(stage, 2).shot?.id, "first");
  assert.equal(stageCameraAt(stage, 6).shot?.id, "first");
  assert.equal(stageCameraAt(stage, 6).cameraId, "b");
  // Gaps fall back to the active camera with no shot to retarget.
  const gap = stageCameraAt(stage, 0);
  assert.equal(gap.cameraId, "camera-1");
  assert.equal(gap.shot, undefined);
  // Single-camera mode ignores shots entirely.
  const single = stageCameraAt({ ...stage, cameraSource: "camera" }, 3.5);
  assert.equal(single.cameraId, "camera-1");
  assert.equal(single.shot, undefined);
  // Clamping mirrors the sampler for out-of-range queries.
  assert.equal(stageCameraAt(stage, -1).cameraId, "camera-1");
  assert.equal(stageCameraAt(stage, 99).shot?.id, "first");
});

test("camera and storyboard persistence rejects dangling IDs, duplicate camera IDs and overlapping cuts", () => {
  const stage = createLocalStage();
  const shot = {
    id: "a",
    cameraId: stage.activeCameraId,
    start: 0,
    duration: 2,
  };
  assert.throws(
    () => parseLocalStageValue({ ...stage, cameras: [] }),
    /摄像机/,
  );
  assert.throws(
    () =>
      parseLocalStageValue({
        ...stage,
        cameras: [stage.cameras[0], stage.cameras[0]],
      }),
    /摄像机/,
  );
  assert.throws(
    () => parseLocalStageValue({ ...stage, activeCameraId: "missing" }),
    /摄像机/,
  );
  assert.throws(
    () =>
      parseLocalStageValue({
        ...stage,
        shots: [{ ...shot, cameraId: "missing" }],
      }),
    /分镜/,
  );
  assert.throws(
    () =>
      parseLocalStageValue({
        ...stage,
        shots: [shot, { ...shot, id: "b", start: 1 }],
      }),
    /重叠/,
  );
  assert.throws(
    () => parseLocalStageValue({ ...stage, shots: [{ ...shot, start: 5 }] }),
    /时长/,
  );
});

test("supported preview and output frames have one exact aspect with even encoder dimensions", () => {
  for (const ratio of STAGE_RATIOS) {
    const { width, height } = stageOutputSize(ratio),
      [w, h] = ratio.split(":").map(Number);
    assert.equal(width / height, w! / h!);
    assert.equal(width % 2, 0);
    assert.equal(height % 2, 0);
    assert.equal(Math.max(width, height), 1280);
    const narrowWidth = 270;
    assert.equal(
      narrowWidth / ((narrowWidth * height) / width),
      width / height,
    );
  }
  assert.throws(() =>
    parseLocalStageValue({ ...createLocalStage(), aspectRatio: "0:1" }),
  );
});

test("motion presets pick imported clips by contained name hints, clip order first", () => {
  assert.deepEqual(
    Object.keys(STAGE_ANIMATION_HINTS).sort(),
    Object.keys(STAGE_MOTIONS).sort(),
  );
  const clips = [
    { name: "mixamo.com" },
    { name: "Standing_Idle" },
    { name: "Walk Forward" },
  ];
  assert.equal(selectStageAnimation(clips, "walk")!.name, "Walk Forward");
  assert.equal(selectStageAnimation(clips, "idle")!.name, "Standing_Idle");
  assert.equal(selectStageAnimation([{ name: "WALK" }], "walk")!.name, "WALK");
  assert.equal(selectStageAnimation(clips, "run")!.name, "mixamo.com");
  assert.equal(selectStageAnimation([], "walk"), undefined);
  const ordered = [{ name: "Walking_slow" }, { name: "Walk_fast" }];
  assert.equal(
    selectStageAnimation(ordered, "walk")!.name,
    "Walking_slow",
  );
});

test("the production canvas boundary persists the full edited stage and its changes participate in canvas undo", async () => {
  const { createDocument, createNode } = await import("../src/canvas/model.ts");
  const { serializeDocument, parseDocument } =
    await import("../src/canvas/storage.ts");
  const { createHistory, recordChange, undo, redo } =
    await import("../src/canvas/history.ts");
  const node = createNode("external");
  const stage = parseLocalStageValue(oldStage());
  stage.cameras.push({
    id: "second",
    name: "侧面",
    pose: { ...defaultStageCamera(), position: { x: -5, y: 4, z: 0 } },
    keyframes: [],
  });
  stage.cameraSource = "storyboard";
  stage.aspectRatio = "9:16";
  stage.shots = [{ id: "cut", cameraId: "second", start: 2, duration: 4 }];
  const document = { ...createDocument(), nodes: [node] };
  const edited = {
    ...document,
    nodes: [{ ...node, data: { ...node.data, localStage: stage } }],
  };
  const encoded = serializeDocument(edited);
  assert.ok(encoded.ok);
  if (!encoded.ok) return;
  const decoded = parseDocument(encoded.value);
  assert.ok(decoded.ok);
  if (!decoded.ok) return;
  assert.deepEqual(decoded.value.nodes[0]!.data.localStage, stage);
  const history = recordChange(createHistory(document), decoded.value);
  assert.equal(history.past.length, 1);
  assert.deepEqual(undo(history).present, document);
  assert.deepEqual(redo(undo(history)).present, decoded.value);
  const legacy = parseDocument({
    ...document,
    nodes: [{ ...node, data: { ...node.data, localStage: oldStage() } }],
  });
  assert.ok(legacy.ok);
  if (legacy.ok)
    assert.equal(legacy.value.nodes[0]!.data.localStage!.version, 2);
});
