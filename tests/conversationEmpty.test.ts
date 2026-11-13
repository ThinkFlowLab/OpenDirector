import assert from "node:assert/strict";
import test from "node:test";
import {conversationIsEmpty, draftContentIsEmpty, type Conversation} from "../src/backend/chat.ts";

function empty(): Conversation {
  return {conversationId: "one", messages: [], draft: "", assets: [], thinking: "auto",
    modelSelections: {agent: null, image: null, video: null, audio: null}};
}

test("empty conversations ignore runtime and thinking settings", () => {
  assert.equal(conversationIsEmpty({...empty(), thinking: "high", runtime: "codex",
    runtimeModel: "gpt-model"}), true);
  assert.equal(conversationIsEmpty({...empty(), draft: "  \n\t"}), true);
});

test("messages, drafts, assets, skills, or draft content make a session reusable-ineligible", () => {
  assert.equal(conversationIsEmpty({...empty(), messages: [{id: "m", role: "user", text: "hi",
    status: "complete"}]}), false);
  assert.equal(conversationIsEmpty({...empty(), draft: "还没发送"}), false);
  assert.equal(conversationIsEmpty({...empty(), assets: [{id: "a", name: "clip", type: "video/mp4",
    size: 1, fingerprint: "f"}]}), false);
  assert.equal(conversationIsEmpty({...empty(), skills: ["lookup"]}), false);
  assert.equal(conversationIsEmpty({...empty(), draftContent: [{type: "text", text: "引用"}]}),
    false);
  assert.equal(conversationIsEmpty({...empty(), draftContent: [{type: "text", text: "  \n"}]}),
    true);
  assert.equal(conversationIsEmpty({...empty(), draftContent: [
    {type: "text", text: "  "}, {type: "skill", name: "lookup"}]}), false);
  assert.equal(conversationIsEmpty({...empty(), draftContent: [
    {type: "text", text: "  "}, {type: "reference", assetId: "a", name: "clip"}]}), false);
});

test("non-string draft text is not treated as empty and does not throw", () => {
  const numeric = [{type: "text", text: 123}] as unknown as Conversation["draftContent"];
  const flag = [{type: "text", text: true}] as unknown as Conversation["draftContent"];
  const object = [{type: "text", text: {x: 1}}] as unknown as Conversation["draftContent"];
  assert.equal(draftContentIsEmpty(numeric), false);
  assert.equal(draftContentIsEmpty(flag), false);
  assert.equal(draftContentIsEmpty(object), false);
  assert.equal(conversationIsEmpty({...empty(), draftContent: numeric}), false);
  assert.equal(conversationIsEmpty({...empty(), draftContent: flag}), false);
  assert.equal(conversationIsEmpty({...empty(), draftContent: object}), false);
});
