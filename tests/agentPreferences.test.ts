import assert from "node:assert/strict";
import test from "node:test";
import {rememberAgentSelection, restoreAgentSelection, builtinThinking, preferredMediaModel, rememberMediaSelection} from "../src/canvas/agentPreferences.ts";
import type {Conversation} from "../src/backend/chat.ts";

function storage() {
  const values = new Map<string, string>();
  return {getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {values.set(key, value);}};
}
function draft(conversationId = "one"): Conversation {
  return {conversationId, messages: [], draft: "保留输入", assets: [], thinking: "auto",
    modelSelections: {agent: null, image: "image-model", video: null, audio: null}};
}

test("refresh restores the selected harness and each harness's model before server autosave", () => {
  const saved = draft();
  const local = storage();
  rememberAgentSelection("project", {...saved, runtime: "codex", runtimeModel: "gpt-model",
    harnessModels: {codex: "gpt-model", claude: "sonnet"}}, local);
  const restored = restoreAgentSelection("project", saved, local);
  assert.equal(restored.runtime, "codex");
  assert.equal(restored.runtimeModel, "gpt-model");
  assert.deepEqual(restored.harnessModels, {codex: "gpt-model", claude: "sonnet"});
  assert.equal(restored.draft, saved.draft);
  assert.equal(restored.modelSelections.image, "image-model");
});

test("new projects inherit the last choice while configured conversations retain theirs", () => {
  const local = storage();
  rememberAgentSelection("old", {...draft(), runtime: "claude", runtimeModel: "sonnet"}, local);
  assert.equal(restoreAgentSelection("new", draft(), local).runtime, "claude");
  const configured = {...draft(), runtime: "codex" as const, runtimeModel: "gpt-model"};
  assert.deepEqual(restoreAgentSelection("configured", configured, local), configured);
});

test("conversation-specific choices and default service model are preserved", () => {
  const local = storage();
  rememberAgentSelection("project", {...draft("one"), runtime: "default",
    modelSelections: {...draft().modelSelections, agent: "minimax"}}, local);
  rememberAgentSelection("project", {...draft("two"), runtime: "codex", runtimeModel: "gpt-model"}, local);
  const restored = restoreAgentSelection("project", draft("one"), local);
  assert.equal(restored.runtime, "default");
  assert.equal(restored.modelSelections.agent, "minimax");
  assert.equal(restoreAgentSelection("project", draft("two"), local).runtimeModel, "gpt-model");
});

test("invalid or unavailable preference storage leaves the server conversation intact", () => {
  const saved = draft();
  assert.equal(restoreAgentSelection("project", saved, {getItem: () => "broken", setItem() {}}), saved);
  const blocked = {getItem(): string | null {throw new Error("blocked");}, setItem() {throw new Error("blocked");}};
  assert.equal(restoreAgentSelection("project", saved, blocked), saved);
  assert.doesNotThrow(() => rememberAgentSelection("project", saved, blocked));
});

test("the last explicit media defaults travel by kind while a conversation keeps its own choice", () => {
  const local = storage();
  const videos = [{ id: "video-a" }, { id: "video-b" }];
  rememberMediaSelection("first", "thread-a", "video", "video-a", local);
  rememberMediaSelection("first", "thread-a", "image", "picture-a", local);
  rememberMediaSelection("second", "thread-b", "video", "video-b", local);
  rememberAgentSelection("second", draft(), local);

  assert.equal(preferredMediaModel("first", "thread-a", "video", videos, local), "video-a");
  assert.equal(preferredMediaModel("first", "thread-c", "video", videos, local), "video-b");
  assert.equal(preferredMediaModel("new", undefined, "video", videos, local), "video-b");
  assert.equal(preferredMediaModel("new", undefined, "image", [{ id: "picture-a" }], local), "picture-a");
  assert.equal(preferredMediaModel("new", undefined, "audio", [{ id: "sound-a" }], local), undefined);
});

test("missing media configurations reveal the next valid preference without forgetting a choice", () => {
  const local = storage();
  rememberMediaSelection("project", "thread", "video", "original", local);
  rememberMediaSelection("other", "other-thread", "video", "replacement", local);
  assert.equal(preferredMediaModel("project", "thread", "video", [{ id: "replacement" }], local), "replacement");
  assert.equal(preferredMediaModel("project", "thread", "video", [{ id: "fallback" }], local), undefined);
  assert.equal(preferredMediaModel("project", "thread", "video", [{ id: "original" }], local), "original");
});

test("JiuwenSwarm model selection survives refresh without changing other harness choices", () => {
  const local = storage();
  const value: Conversation = {...draft(), runtime: "jiuwenswarm", runtimeModel: "local-model#0",
    harnessModels: {jiuwenswarm: "local-model#0", codex: "gpt-model"}};
  rememberAgentSelection("project", value, local);
  const restored = restoreAgentSelection("project", draft(), local);
  assert.equal(restored.runtime, "jiuwenswarm");
  assert.equal(restored.runtimeModel, "local-model#0");
  assert.deepEqual(restored.harnessModels, value.harnessModels);
});


test("DeepSeek Harness selection and native model survive refresh", () => {
  const local = storage();
  const value: Conversation = {...draft(), runtime: "deepseek", runtimeModel: "route/model",
    harnessModels: {deepseek: "route/model", codex: "gpt-model"}};
  rememberAgentSelection("project", value, local);
  assert.deepEqual(restoreAgentSelection("project", draft(), local).harnessModels, value.harnessModels);
  assert.equal(restoreAgentSelection("project", draft(), local).runtime, "deepseek");
});


test("bundled model effort stays per model across refresh and preserves external harness settings", () => {
  const local = storage();
  const value: Conversation = { ...draft(), runtime: "default", thinking: "high",
    builtinModelThinking: { first: "low", second: "high" } };
  rememberAgentSelection("project", value, local);
  const restored = restoreAgentSelection("project", draft(), local);
  assert.equal(builtinThinking(restored, "first"), "low");
  assert.equal(builtinThinking(restored, "second"), "high");
  assert.equal(builtinThinking(restored, "new"), "auto");
  for (const runtime of ["opencode", "deepseek", "claude", "codex", "jiuwenswarm"] as const)
    assert.equal(builtinThinking({ ...restored, runtime, thinking: "medium" }, "second"), "medium");
});
