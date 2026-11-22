import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assistantResultsByTurn, withPublishedAssistantResults } from "../src/canvas/assistantResults.ts";
import { findAssetItem } from "../src/canvas/canvasAssetPlacement.ts";
import type { ChatMessage } from "../src/backend/chat.ts";
import type { ProjectSnapshot } from "../src/contracts/generated.ts";

const project = JSON.parse(readFileSync(
  new URL("./fixtures/creation-project.json", import.meta.url), "utf8",
)) as ProjectSnapshot;
const result = project.results[0]!;
const output = project.assets.find((asset) => asset.id === result.asset.assetId)!;
const owner = project.canvasItems.find((item) => item.binding.role === "generation"
  && item.binding.objectRef.id === result.specId)!;
const job = { ...project.jobs[0]!, agentRunId: "turn-one", agentCallId: "call", originItemId: owner.id };

test("only the submitting turn gets its registered result, including after asynchronous completion", () => {
  assert.equal(assistantResultsByTurn(project).size, 0); // Ordinary canvas job.
  assert.equal(assistantResultsByTurn({ ...project, jobs: [job], results: [] }).size, 0);
  const cards = assistantResultsByTurn({ ...project, jobs: [job] });
  assert.deepEqual([...cards.keys()], [job.agentRunId]);
  assert.deepEqual(cards.get(job.agentRunId), [{
    assetId: output.id, asset: output, resultId: result.id, status: "current", itemId: owner.id,
  }]);
});

test("candidate and historical cards keep their produced asset when the owner shows another version", () => {
  const changed = {
    ...project,
    generationSpecs: project.generationSpecs.map((spec) => ({ ...spec, currentResultId: null })),
  };
  const [candidate] = assistantResultsByTurn({ ...changed, jobs: [job] }).get(job.agentRunId)!;
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.asset?.id, output.id);
  assert.equal(candidate.itemId, null);

  const placement = project.canvasItems.find((item) => item.kind === "image")!;
  const hidden = { ...placement, id: "hidden-copy", visible: false, binding: { role: "material" as const, objectRef: result.asset } };
  const visible = { ...hidden, id: "visible-copy", visible: true };
  const historical = (canvasItems: ProjectSnapshot["canvasItems"]) => assistantResultsByTurn({
    ...changed, canvasItems, jobs: [{ ...job, adopted: true }],
  }).get(job.agentRunId)![0];
  assert.equal(historical([hidden]).itemId, hidden.id);
  assert.equal(historical([hidden, visible]).itemId, visible.id);
  assert.equal(historical([hidden, visible]).status, "historical");
});

test("written assets use trusted turn provenance and a missing or replaced result cannot redirect its actions", () => {
  const written = {
    ...project.assets[0], provenance: {
      ...project.assets[0].provenance, source: "agent_written" as const, agentRunId: "another-turn",
    },
  };
  const cards = assistantResultsByTurn({
    ...project, jobs: [job], assets: [written, { ...output, fingerprint: "different-bytes" }],
  });
  const [text] = cards.get("another-turn")!;
  assert.equal(text.asset, written);
  assert.equal(text.status, "asset");
  const [unavailable] = cards.get(job.agentRunId)!;
  assert.equal(unavailable.resultId, result.id);
  assert.equal(unavailable.asset, null);
  assert.equal(unavailable.itemId, null);
});

test("locating a card after its original node changed reuses another item showing the same version", () => {
  assert.equal(owner.kind, "image");
  const lastOwner = { ...owner, id: "previous", binding: { role: "empty" as const, draftSpec: null, manualText: null } };
  const hidden = { ...owner, visible: false };
  const visible = { ...owner, id: "other", visible: true };
  const snapshot = { ...project, canvasItems: [lastOwner, hidden, visible] };
  assert.equal(findAssetItem(snapshot, output.id, lastOwner.id)?.id, visible.id);
  assert.equal(findAssetItem(snapshot, output.id, hidden.id)?.id, hidden.id);
  assert.equal(findAssetItem(snapshot, "no-longer-displayed", lastOwner.id), undefined);
});

test("direct publication receipts preserve deleted identities only in their project and after their cursor", () => {
  const asset = {
    ...project.assets[0], provenance: {
      ...project.assets[0].provenance, source: "agent_written" as const, agentRunId: "turn",
    },
  };
  const snapshot = { ...project, assets: [asset] };
  const live = assistantResultsByTurn(snapshot);
  const { id, name, fingerprint } = asset;
  const messages: ChatMessage[] = [
    { id: "turn", role: "user", status: "complete", text: "" },
    { id: "reply", role: "assistant", status: "interrupted", text: "", publishedAssets: {
      projectId: project.project.id, eventCursor: project.eventCursor, assets: [{ id, name, fingerprint }],
    } },
  ];
  assert.equal(withPublishedAssistantResults(live, messages, snapshot), live);
  const deleted = { ...snapshot, assets: [] };
  const empty = assistantResultsByTurn(deleted);
  const missing = { assetId: id, name, asset: null, resultId: null, itemId: null, status: "asset" };
  assert.deepEqual(withPublishedAssistantResults(empty, messages, deleted).get("turn"), [missing]);
  const replaced = { ...snapshot, assets: [{ ...asset, fingerprint: "other-content" }] };
  assert.deepEqual(withPublishedAssistantResults(assistantResultsByTurn(replaced), messages, replaced).get("turn"), [missing]);
  assert.equal(withPublishedAssistantResults(empty, messages, { ...deleted, eventCursor: project.eventCursor - 1 }), empty);
  assert.equal(withPublishedAssistantResults(empty, messages, {
    ...deleted, project: { ...project.project, id: "different-project" },
  }), empty);
  assert.equal(withPublishedAssistantResults(empty, messages.slice(1), snapshot), empty);
});
