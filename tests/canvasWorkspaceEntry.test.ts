import assert from "node:assert/strict";
import test from "node:test";
import { setActiveLocale } from "../src/i18n/messages.ts";
import {
  beginTransaction,
  commitTransaction,
  executeCommand,
  undo,
} from "../src/canvas/history.ts";
import { createNode } from "../src/canvas/model.ts";
import { generationDefaults } from "../src/canvas/generationCatalog.ts";
import { generationEditIdentity } from "../src/canvas/generationSettings.ts";
import {
  generationPrepareBlock,
  importedNodeIds,
  uploadPickerPlan,
  uploadTargetUnchanged,
} from "../src/canvas/workspace/entryPoints.ts";
import {
  createWorkspaceState,
  workspaceReducer,
} from "../src/canvas/workspace/state.ts";

setActiveLocale("zh-CN");

test("upload guards accept saved defaults but reject edits to content and settings", () => {
  const draft = createNode("image", undefined, {
    settings: { ...generationDefaults("image"), model: "Configured image model", modelConfigId: "image-model", resolution: "auto", voiceName: undefined },
  });
  const saved = {
    ...draft,
    data: { ...draft.data, promptContent: [], promptMentions: [], settings: {
      mode: "image" as const, model: "本地交互演示", modelConfigId: "image-model",
      aspectRatio: "1:1", durationSeconds: 5, resolution: "auto", prompt: "", count: 1, imagePreset: "none" as const,
    } },
  };
  assert.equal(uploadTargetUnchanged(saved, draft), true);
  assert.equal(generationEditIdentity(saved, []), generationEditIdentity(draft, []));
  for (const patch of [
    { title: "Renamed" }, { src: "blob:other" }, { prompt: "Changed prompt" },
    { settings: { ...saved.data.settings, modelConfigId: "other-model" } },
    { settings: { ...saved.data.settings, resolution: "2K" } },
    { settings: { ...saved.data.settings, aspectRatio: "16:9" } },
  ]) {
    const edited = { ...saved, data: { ...saved.data, ...patch } };
    assert.equal(uploadTargetUnchanged(edited, draft), false, JSON.stringify(patch));
  }
  for (const patch of [
    { modelConfigId: "other-model" }, { resolution: "2K" }, { aspectRatio: "16:9" },
  ]) assert.notEqual(generationEditIdentity({ ...saved, data: { ...saved.data,
    settings: { ...saved.data.settings, ...patch } } }, []), generationEditIdentity(draft, []));
});

test("video references ignore irrelevant slot initialization but retain explicit frame choices", () => {
  const draft = createNode("video", undefined, { settings: generationDefaults("video") });
  const saved = { ...draft, data: { ...draft.data,
    settings: { ...draft.data.settings!, frameSlotsInitialized: true } } };
  assert.equal(uploadTargetUnchanged(saved, draft), true);
  assert.equal(generationEditIdentity(saved, []), generationEditIdentity(draft, []));
  const changed = { ...saved, data: { ...saved.data,
    settings: { ...saved.data.settings, firstFrameNodeId: "source" } } };
  assert.equal(uploadTargetUnchanged(changed, draft), false);
  const firstLast = { ...draft, data: { ...draft.data,
    settings: { ...draft.data.settings!, videoMode: "first-last" as const } } };
  assert.equal(uploadTargetUnchanged({ ...firstLast, data: { ...firstLast.data,
    settings: { ...firstLast.data.settings, frameSlotsInitialized: true } } }, firstLast), false);
});

test("upload picker blocks locked, generation output, and running nodes", () => {
  assert.deepEqual(
    uploadPickerPlan({
      hasTarget: true,
      locked: true,
      generating: true,
      nodeType: "image",
      hasSrc: true,
      mediaRole: "generation",
    }),
    { blocked: "locked" },
  );
  assert.deepEqual(
    uploadPickerPlan({
      hasTarget: true,
      locked: false,
      generating: false,
      nodeType: "image",
      hasSrc: true,
      mediaRole: "generation",
    }),
    { blocked: "generation-output" },
  );
  assert.deepEqual(
    uploadPickerPlan({
      hasTarget: true,
      locked: false,
      generating: false,
      nodeType: "text",
      hasSrc: true,
      mediaRole: "generation",
    }).blocked,
    null,
  );
  assert.deepEqual(
    uploadPickerPlan({
      hasTarget: true,
      locked: false,
      generating: true,
      nodeType: "video",
    }),
    { blocked: "generating" },
  );
});

test("upload picker accept follows node kind and subject slot", () => {
  assert.deepEqual(
    uploadPickerPlan({ hasTarget: false, locked: false, generating: false }),
    { blocked: null, multiple: true, accept: "" },
  );
  const image = uploadPickerPlan({
    hasTarget: true,
    locked: false,
    generating: false,
    nodeType: "image",
  });
  assert.deepEqual(image, { blocked: null, multiple: false, accept: "image/*,.heic,.heif" });
  assert.equal(
    uploadPickerPlan({
      hasTarget: true,
      locked: false,
      generating: false,
      nodeType: "text",
    }).blocked,
    null,
  );
  assert.equal(
    (
      uploadPickerPlan({
        hasTarget: true,
        locked: false,
        generating: false,
        nodeType: "text",
      }) as { accept: string }
    ).accept,
    ".txt,.md,.markdown",
  );
  assert.equal(
    (
      uploadPickerPlan({
        hasTarget: true,
        locked: false,
        generating: false,
        nodeType: "subject",
        subjectSlot: "voice",
      }) as { accept: string }
    ).accept,
    "audio/*",
  );
  assert.equal(
    (
      uploadPickerPlan({
        hasTarget: true,
        locked: false,
        generating: false,
        nodeType: "subject",
        subjectSlot: "auxiliary",
      }) as { accept: string }
    ).accept,
    "image/*,.heic,.heif",
  );
  assert.equal(
    (
      uploadPickerPlan({
        hasTarget: true,
        locked: false,
        generating: false,
        nodeType: "subject",
        subjectSlot: "main",
      }) as { accept: string }
    ).accept,
    "image/*,.heic,.heif,video/*",
  );
});

test("import selection prefers the replace target, then the reference target, then created nodes", () => {
  assert.deepEqual(
    importedNodeIds({
      targetId: "replaced",
      referenceTargetId: "ref",
      createdIds: ["a", "b"],
    }),
    ["replaced"],
  );
  assert.deepEqual(
    importedNodeIds({
      targetId: null,
      referenceTargetId: "ref",
      createdIds: ["a"],
    }),
    ["ref"],
  );
  assert.deepEqual(
    importedNodeIds({
      targetId: null,
      referenceTargetId: null,
      createdIds: ["a", "b"],
    }),
    ["a", "b"],
  );
});

test("generation prepare stops on a missing, locked, or already running node", () => {
  assert.equal(
    generationPrepareBlock({
      nodeFound: false,
      locked: false,
      alreadyRunning: false,
    }),
    "missing",
  );
  assert.equal(
    generationPrepareBlock({
      nodeFound: true,
      locked: true,
      alreadyRunning: true,
    }),
    "locked",
  );
  assert.equal(
    generationPrepareBlock({
      nodeFound: true,
      locked: false,
      alreadyRunning: true,
    }),
    "running",
  );
  assert.equal(
    generationPrepareBlock({
      nodeFound: true,
      locked: false,
      alreadyRunning: false,
    }),
    null,
  );
});

test("workspace reducer keeps selection independent of history undo", () => {
  const initial = createWorkspaceState();
  const node = createNode("image", { x: 3, y: 4 });
  let state = workspaceReducer(initial, {
    type: "set",
    key: "history",
    value: (history) =>
      executeCommand(history, { type: "add-nodes", nodes: [node] }),
  });
  state = workspaceReducer(state, {
    type: "set",
    key: "selected",
    value: [node.id],
  });
  state = workspaceReducer(state, {
    type: "set",
    key: "menu",
    value: null,
  });
  assert.equal(state.history.present.nodes.length, 1);
  assert.equal(state.history.present.nodes[0]!.position.x, 3);
  assert.deepEqual(state.selected, [node.id]);
  const same = workspaceReducer(state, {
    type: "set",
    key: "selected",
    value: state.selected,
  });
  assert.equal(same, state);

  state = workspaceReducer(state, {
    type: "set",
    key: "history",
    value: beginTransaction,
  });
  assert.equal(state.history.transaction, state.history.present);
  state = workspaceReducer(state, {
    type: "set",
    key: "history",
    value: commitTransaction,
  });
  assert.equal(state.history.transaction, null);
  assert.deepEqual(state.selected, [node.id]);

  state = workspaceReducer(state, {
    type: "set",
    key: "selected",
    value: (ids) => ids.filter((id) => id !== "gone"),
  });
  assert.deepEqual(state.selected, [node.id]);
  const undone = workspaceReducer(state, {
    type: "set",
    key: "history",
    value: (history) => undo(history),
  });
  assert.equal(undone.history.present.nodes.length, 0);
  assert.deepEqual(undone.selected, [node.id]);
  assert.equal(undone.ready, false);
});
