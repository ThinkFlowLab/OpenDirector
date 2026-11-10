import assert from "node:assert/strict";
import test from "node:test";
import { needsAgentModel } from "../src/canvas/assistantReadiness.ts";

const ready = { status: "ready", modelSource: "settings" } as const;

test("explains a disabled send only for a ready settings engine without a conversation model", () => {
  assert.equal(needsAgentModel(true, ready, false), true);
  assert.equal(needsAgentModel(true, ready, true), false);
  assert.equal(needsAgentModel(false, ready, false), false);
  assert.equal(needsAgentModel(true, { ...ready, status: "checking" }, false), false);
  assert.equal(needsAgentModel(true, { ...ready, modelSource: "cli" }, false), false);
  assert.equal(needsAgentModel(true, undefined, false), false);
});
