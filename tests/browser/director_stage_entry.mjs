/** Second-phase Director Stage acceptance: create, import GLB, edit, reopen, undo, and redo.
 * DIRECTOR_STAGE_LOCALE runs the same flow in another UI language (default en-US). */
import assert from "node:assert/strict";
import { makeCorruptGlb, makeGlb, makeUnlitGlb } from "./director_stage_fixture.mjs";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);

const locale = process.env.DIRECTOR_STAGE_LOCALE ?? "en-US";
const L = {
  "en-US": {
    saved: "Saved on this device",
    addStage: "Add Director Stage",
    apply: "Apply edits",
    cameraName: "Camera name",
    playhead: "Stage playhead",
    positionX: "Position X",
    currentTimeAria: "Stage current time",
    addShot: "Add current camera at playhead",
    copyCamera: "Duplicate as new camera",
    editCamera: "Edit camera",
    sourceAria: "Director shot source",
    camera2: "Camera 2",
    shot1Camera: "Shot 1 camera",
    recordKeyframe: "Record a keyframe here",
    closeEditor: "Close editor",
    undo: "Undo",
    redo: "Redo",
    openStage: "Open Director Stage",
    importAsset: "Import GLB / GLTF",
    importJson: "Import stage JSON",
    exportJson: "Export stage JSON",
    noAnimationNote:
      "This character has no animation data; it still follows camera, storyboard, and transform keyframes.",
    corruptAssetNotice:
      "Could not read “broken.glb”: the GLB header is valid but the embedded JSON is missing or corrupt.",
    loadFailedNotice:
      "Could not load “broken.glb”. The file may be corrupt or reference external resources.",
    unsupportedAssetNotice:
      "Only GLB and self-contained GLTF files are supported. FBX and external GLTF resources are not supported yet.",
    compressedAssetNotice:
      "Compressed models (Draco, meshopt, or KTX2) are not supported yet. Export the model uncompressed and import it again.",
    exportUnsavedImportsNotice:
      "The stage file cannot carry imported models that exist only in this browser: acceptance. Apply edits to save them to the project first.",
    importForeignAssetsNotice:
      "The stage file pins imported models that are not registered in this project: Foreign actor. Open the stage in its original project, or import the model files here first.",
    importNotJsonNotice:
      "The selected file is not a stage JSON document. Model files are imported with “Import GLB / GLTF”.",
  },
  "zh-CN": {
    saved: "已保存到本机",
    addStage: "添加导演台",
    apply: "应用编辑",
    cameraName: "机位名称",
    playhead: "舞台播放位置",
    positionX: "位置 X",
    currentTimeAria: "舞台当前时刻",
    addShot: "在播放头添加当前机位",
    copyCamera: "复制为新机位",
    editCamera: "编辑机位",
    sourceAria: "导演镜头来源",
    camera2: "摄像机 2",
    shot1Camera: "镜头 1 机位",
    recordKeyframe: "在此记录关键帧",
    closeEditor: "关闭编辑器",
    undo: "撤销",
    redo: "重做",
    openStage: "打开导演台",
    importAsset: "导入 GLB / GLTF",
    importJson: "导入舞台 JSON",
    exportJson: "导出舞台 JSON",
    noAnimationNote: "此人物没有动画数据，但仍会跟随摄像机、分镜和变换关键帧。",
    corruptAssetNotice:
      "无法读取「broken.glb」：GLB 头有效，但内嵌 JSON 缺失或已损坏。",
    loadFailedNotice:
      "无法加载「broken.glb」。文件可能损坏，或引用了外部资源。",
    unsupportedAssetNotice:
      "目前仅支持 GLB 和自包含 GLTF；FBX 及外部 GLTF 资源暂不支持。",
    compressedAssetNotice:
      "暂不支持压缩模型（Draco、meshopt 或 KTX2）。请先导出未压缩的模型，再重新导入。",
    exportUnsavedImportsNotice:
      "舞台文件无法携带仅存在于当前浏览器的导入模型：acceptance。请先应用编辑，将其保存为工程素材。",
    importForeignAssetsNotice:
      "舞台文件引用了未在本工程登记的导入模型：Foreign actor。请在原工程中打开，或先在此工程导入对应模型文件。",
    importNotJsonNotice:
      "所选文件不是舞台 JSON 文档。模型文件请使用「导入 GLB / GLTF」导入。",
  },
}[locale];
assert.ok(L, `Unsupported DIRECTOR_STAGE_LOCALE: ${locale}`);

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const headers = {
  "X-OpenDirector-Request": "1",
  "Content-Type": "application/json",
};

async function call(path, body) {
  const response = await fetch(api + path, {
    headers,
    ...(body
      ? { method: "POST", body: JSON.stringify(body) }
      : {}),
  });
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json();
}

assert.equal((await call("/api/creation-test-health")).isolated, true);

const projectId = crypto.randomUUID();
await call(`/api/creation/projects/${projectId}/commands`, {
  commandId: crypto.randomUUID(),
  projectId,
  type: "project.create",
  payload: { name: `Director Stage entry ${projectId.slice(0, 8)}` },
});

const state = () => call(`/api/creation/projects/${projectId}`);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({
  locale,
  viewport: { width: 1700, height: 1100 },
});
await page.addInitScript((value) => {
  localStorage.setItem("opendirector.locale.v1", value);
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
}, locale);
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

const until = async (predicate, label) => {
  const deadline = Date.now() + 20000;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await state();
    if (predicate(snapshot)) return snapshot;
    await page.waitForTimeout(100);
  }
  throw new Error(`Timeout: ${label}; snapshot: ${JSON.stringify(snapshot)}`);
};

const director = (snapshot, itemId) => {
  const item = snapshot.canvasItems.find(
    (candidate) =>
      candidate.id === itemId ||
      (itemId === undefined &&
        candidate.visible &&
        candidate.kind === "external"),
  );
  const document = item
    ? snapshot.editorDocuments.find(
        (candidate) => candidate.id === item.binding?.objectRef?.id,
      )
    : undefined;
  return { item, document };
};

const keyframeCount = (document) =>
  document.data.objects.reduce(
    (count, object) => count + object.keyframes.length,
    0,
  ) +
  document.data.cameras.reduce(
    (count, camera) => count + camera.keyframes.length,
    0,
  );

// A well-formed stage document pinning a model asset this project never
// registered; import must refuse it by naming the object.
const foreignStage = {
  format: "opendirector-local-stage",
  version: 2,
  background: "#151923",
  grid: true,
  duration: 6,
  aspectRatio: "16:9",
  activeCameraId: "camera-1",
  cameraSource: "camera",
  shots: [],
  cameras: [
    {
      id: "camera-1",
      name: "Camera",
      pose: {
        position: { x: 5, y: 3.5, z: 7 },
        target: { x: 0, y: 1, z: 0 },
        fov: 45,
      },
      keyframes: [],
    },
  ],
  objects: [
    {
      id: "foreign-actor",
      kind: "gltf",
      name: "Foreign actor",
      color: "#b8c5ff",
      role: "character",
      format: "glb",
      asset: {
        assetId: crypto.randomUUID(),
        revision: 1,
        fingerprint: `sha256:${"c".repeat(64)}`,
        kind: "file",
      },
      animationNames: ["Walk"],
      hasAnimation: true,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      keyframes: [],
      motionClips: [],
    },
  ],
};

try {
  await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
  await page.getByText(L.saved, { exact: true }).waitFor();

  const addStage = page.getByRole("button", {
    name: L.addStage,
    exact: true,
  });
  await addStage.waitFor();
  assert.equal(await addStage.isEnabled(), true);
  await addStage.click();

  await page
    .getByRole("button", { name: L.apply, exact: true })
    .waitFor();
  const created = await until((snapshot) => {
    const result = director(snapshot);
    return result.item?.kind === "external" && result.document?.kind === "director";
  }, "created external item and director document");
  const createdRefs = director(created);
  assert.ok(createdRefs.item);
  assert.ok(createdRefs.document);
  assert.equal(createdRefs.item.binding.objectRef.kind, "director");
  assert.equal(createdRefs.document.kind, "director");
  const itemId = createdRefs.item.id;
  const documentId = createdRefs.document.id;
  const objectId = createdRefs.document.data.objects[0].id;
  assert.equal(keyframeCount(createdRefs.document), 0);

  // Corrupt GLB JSON, plain non-GLB bytes, external GLTF, and GLB with
  // external references are rejected with localized notices before anything
  // reaches the project.
  await page
    .locator('input[type="file"][accept*=".glb"]')
    .setInputFiles({
      name: "broken.glb",
      mimeType: "model/gltf-binary",
      buffer: makeCorruptGlb(),
    });
  await page.getByText(L.corruptAssetNotice, { exact: true }).waitFor();
  await page
    .locator('input[type="file"][accept*=".glb"]')
    .setInputFiles({
      name: "broken.glb",
      mimeType: "model/gltf-binary",
      buffer: Buffer.from("not a glb at all"),
    });
  await page.getByText(L.loadFailedNotice, { exact: true }).waitFor();
  await page
    .locator('input[type="file"][accept*=".glb"]')
    .setInputFiles({
      name: "external.gltf",
      mimeType: "model/gltf+json",
      buffer: Buffer.from(
        JSON.stringify({
          asset: { version: "2.0" },
          buffers: [{ uri: "scene.bin", byteLength: 4 }],
        }),
      ),
    });
  await page.getByText(L.unsupportedAssetNotice, { exact: true }).waitFor();
  await page
    .locator('input[type="file"][accept*=".glb"]')
    .setInputFiles({
      name: "external.glb",
      mimeType: "model/gltf-binary",
      buffer: makeGlb({ images: [{ uri: "texture.png" }] }),
    });
  await page.getByText(L.unsupportedAssetNotice, { exact: true }).waitFor();
  // Self-contained but Draco-compressed: rejected for needing unavailable
  // decoders, not mislabeled as corrupt.
  await page
    .locator('input[type="file"][accept*=".glb"]')
    .setInputFiles({
      name: "draco.glb",
      mimeType: "model/gltf-binary",
      buffer: makeGlb({
        extensionsUsed: ["KHR_draco_mesh_compression"],
        extensionsRequired: ["KHR_draco_mesh_compression"],
      }),
    });
  await page.getByText(L.compressedAssetNotice, { exact: true }).waitFor();
  await page
    .locator('input[type="file"][accept*=".glb"]')
    .setInputFiles({
      name: "acceptance.glb",
      mimeType: "model/gltf-binary",
      buffer: makeGlb(),
    });
  await page
    .getByRole("button", { name: "acceptance", exact: true })
    .waitFor();
  await page.getByText(L.noAnimationNote, { exact: true }).waitFor();

  // The export carries no model bytes, so it must name imports that exist
  // only as browser URLs instead of writing unopenable objects.
  await page
    .getByRole("button", { name: L.exportJson, exact: true })
    .click();
  await page
    .getByText(L.exportUnsavedImportsNotice, { exact: true })
    .waitFor();
  // Stage JSON imports reject objects pinning assets this project never
  // registered, keeping the in-progress stage untouched.
  await page
    .locator('input[type="file"][accept^="application/json"]')
    .setInputFiles({
      name: "foreign.stage.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(foreignStage)),
    });
  await page
    .getByText(L.importForeignAssetsNotice, { exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "acceptance", exact: true })
    .waitFor();
  // Binary model bytes picked through the JSON importer surface the
  // localized notice, never an engine SyntaxError quoting the file.
  await page
    .locator('input[type="file"][accept^="application/json"]')
    .setInputFiles({
      name: "acceptance.glb",
      mimeType: "application/json",
      buffer: makeGlb(),
    });
  await page.getByText(L.importNotJsonNotice, { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "acceptance", exact: true })
    .waitFor();

  await page.getByLabel(L.cameraName, { exact: true }).fill("Acceptance camera");
  await page
    .getByRole("slider", { name: L.playhead, exact: true })
    .press("End");
  await page.getByLabel(L.positionX, { exact: true }).fill("2");
  await page
    .getByRole("button", { name: L.recordKeyframe, exact: true })
    .click();
  await page.getByRole("button", { name: "6.00s", exact: true }).waitFor();
  // Numeric fields share one text→value contract: leading-zero and empty
  // text never become values, and the current time is directly addressable,
  // clamped to the stage duration at hundredth precision.
  const positionX = page.getByLabel(L.positionX, { exact: true });
  await positionX.fill("03");
  await positionX.blur();
  assert.equal(await positionX.inputValue(), "2");
  await positionX.fill("");
  await positionX.blur();
  assert.equal(await positionX.inputValue(), "2");
  const currentTime = page.getByLabel(L.currentTimeAria, { exact: true });
  await currentTime.fill("999");
  await currentTime.blur();
  assert.equal(await currentTime.inputValue(), "6");
  await currentTime.fill("1.234");
  await currentTime.blur();
  assert.equal(await currentTime.inputValue(), "1.23");
  // Choosing or creating an edit-target camera must not flip storyboard-cut
  // evaluation: the source stays on cuts, and the playhead shot is retargeted.
  await page.getByRole("button", { name: L.addShot, exact: true }).click();
  const source = page.getByLabel(L.sourceAria, { exact: true });
  assert.equal(await source.inputValue(), "storyboard");
  await page.getByRole("button", { name: L.copyCamera, exact: true }).click();
  assert.equal(await source.inputValue(), "storyboard");
  const editCamera = page.getByLabel(L.editCamera, { exact: true });
  await editCamera.selectOption({ label: L.camera2 });
  assert.equal(await source.inputValue(), "storyboard");
  // The shot covering the playhead now evaluates through the chosen camera.
  const shotCamera = page.getByLabel(L.shot1Camera, { exact: true });
  assert.equal(
    await shotCamera.inputValue(),
    await editCamera.inputValue(),
  );
  // Switching the evaluation strategy stays an explicit choice, and the
  // edit target follows it back to the renamed camera.
  await source.selectOption("camera");
  await editCamera.selectOption({ label: "Acceptance camera" });
  assert.equal(await source.inputValue(), "camera");
  // An unlit import loads as materials without emissive; selecting across it
  // must not take down the editor. The tiny fixture parses in milliseconds,
  // so a short settle ensures the clone has landed before the selection runs.
  await page
    .locator('input[type="file"][accept*=".glb"]')
    .setInputFiles({
      name: "unlit.glb",
      mimeType: "model/gltf-binary",
      buffer: makeUnlitGlb(),
    });
  await page
    .getByRole("button", { name: "unlit", exact: true })
    .waitFor();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "acceptance", exact: true }).click();
  await page.getByRole("button", { name: "unlit", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "unlit", exact: true }).isVisible(),
    true,
  );
  await page.getByRole("button", { name: L.apply, exact: true }).click();

  const committed = await until((snapshot) => {
    const result = director(snapshot, itemId);
    return (
      result.item?.id === itemId &&
      result.document?.id === documentId &&
      result.document.data.cameras[0].name === "Acceptance camera" &&
      keyframeCount(result.document) >= 2
    );
  }, "edited director document with keyframes");
  const committedRefs = director(committed, itemId);
  assert.equal(committedRefs.document.data.objects[0].id, objectId);
  const imported = committedRefs.document.data.objects.find(
    (object) => object.kind === "gltf",
  );
  assert.ok(imported);
  assert.equal(imported.role, "character");
  assert.equal(imported.format, "glb");
  assert.equal(imported.asset.kind, "file");
  assert.ok(
    committed.assets.some((asset) => asset.id === imported.asset.assetId),
  );
  const importedObjectId = imported.id;
  const importedAssetId = imported.asset.assetId;
  assert.ok(
    committedRefs.document.data.objects[0].keyframes.some(
      (frame) => frame.time === 6,
    ),
  );
  assert.ok(
    committedRefs.document.data.cameras[0].keyframes.some(
      (frame) => frame.time === 6,
    ),
  );

  // Applying saves and closes the stage editor in one step.
  // The toolbar undo carries an aria-label; the stage modal's undo is plain text.
  const undo = page.getByLabel(L.undo, { exact: true });
  await undo.waitFor();
  assert.equal(await undo.isEnabled(), true);
  await undo.click();
  const undone = await until((snapshot) => {
    const result = director(snapshot, itemId);
    return (
      result.item?.id === itemId &&
      result.document?.id === documentId &&
      result.document.data.cameras[0].name !== "Acceptance camera" &&
      keyframeCount(result.document) === 0
    );
  }, "undo restores the original director document without changing identity");
  assert.equal(director(undone, itemId).document.data.objects[0].id, objectId);
  assert.equal(
    director(undone, itemId).document.data.objects.some(
      (object) => object.id === importedObjectId,
    ),
    false,
  );

  const redo = page.getByLabel(L.redo, { exact: true });
  const redoDeadline = Date.now() + 20000;
  while (!(await redo.isEnabled())) {
    if (Date.now() > redoDeadline) throw new Error("redo never became enabled");
    await page.waitForTimeout(100);
  }
  await redo.click();
  const redone = await until((snapshot) => {
    const result = director(snapshot, itemId);
    return (
      result.item?.id === itemId &&
      result.document?.id === documentId &&
      result.document.data.cameras[0].name === "Acceptance camera" &&
      keyframeCount(result.document) >= 2
    );
  }, "redo restores the edited director document without changing identity");
  assert.equal(director(redone, itemId).document.data.objects[0].id, objectId);
  const redoneImported = director(redone, itemId).document.data.objects.find(
    (object) => object.id === importedObjectId,
  );
  assert.equal(redoneImported.asset.assetId, importedAssetId);

  await page.locator(`.react-flow__node[data-id="${itemId}"]`).click();
  await page
    .getByRole("button", { name: L.openStage, exact: true })
    .click();
  await page
    .getByRole("button", { name: L.apply, exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel(L.cameraName, { exact: true }).inputValue(),
    "Acceptance camera",
  );
  await page
    .getByRole("button", { name: "acceptance", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "6.00s", exact: true }).waitFor();
  assert.deepEqual(director(await state(), itemId).document, director(redone, itemId).document);
  await page
    .getByRole("button", { name: L.closeEditor, exact: true })
    .click();
  await page
    .getByRole("button", { name: L.apply, exact: true })
    .waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      projectId,
      itemId,
      documentId,
      objectId,
      checks: [
        "shared creation toolbar entry",
        "automatic editor opening",
        "external node projects to director document",
        "corrupt GLB JSON is reported as corruption, not a load failure",
        "compressed models are rejected for needing unavailable decoders",
        "GLB import previews before save and registers a file asset",
        "unlit imports survive selection without crashing",
        "stage JSON export names imports that are not saved yet",
        "stage JSON import rejects foreign pinned assets",
        "binary model bytes through the JSON importer report a localized notice",
        "numeric text never commits leading zeros or empty values",
        "current time is directly addressable, clamped and quantized",
        "camera selection keeps storyboard-cut evaluation and retargets the playhead shot",
        "imported asset identity survives undo, redo, and reopen",
        "keyframes persist and reopen",
        "undo preserves node and document identities",
        "redo restores the edited document and keyframes",
        "no page errors",
      ],
    }),
  );
} catch (error) {
  console.error((await page.locator("body").innerText()).slice(-2500));
  throw error;
} finally {
  await browser.close();
}
