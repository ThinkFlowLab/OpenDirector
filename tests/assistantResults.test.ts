import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assistantResultsByTurn, withPublishedAssistantResults } from "../src/canvas/assistantResults.ts";
import { deliveredTimelineState, prepareProjectEditorItem, resolveProjectEditorItem, timelinesForResultAssets } from "../src/canvas/assistantResultEditors.ts";
import { findAssetItem } from "../src/canvas/canvasAssetPlacement.ts";
import type { CreationClient } from "../src/backend/creationClient.ts";
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

test("result editors bind the actual item and immutable media; a changed owner never redirects editing", () => {
  const selected = { kind: "media" as const, asset: output, itemId: owner.id };
  assert.equal(resolveProjectEditorItem(project, selected)?.id, owner.id);
  const rebound = { ...project, canvasItems: project.canvasItems.filter(item => item.id !== owner.id) };
  assert.throws(() => resolveProjectEditorItem(rebound, selected));
  assert.throws(() => resolveProjectEditorItem(project, { ...selected, asset: { ...output, revision: output.revision + 1 } }));
  assert.throws(() => resolveProjectEditorItem(project, { ...selected, asset: { ...output, fingerprint: "replaced" } }));
  assert.throws(() => resolveProjectEditorItem(project, { ...selected, asset: { ...output, projectId: "other" } }));
});

test("result timelines match pinned inputs and render provenance across same-named edits and hidden items", () => {
  const timeline = project.editorDocuments.find(doc => doc.kind === "timeline")!;
  const item = project.canvasItems.find(item => item.kind === "timeline")!;
  const imported = timeline.data.importedAssets[0].asset.assetId;
  const clip = timeline.data.tracks[0].clips[0].resource.asset.assetId;
  const other = { ...timeline, id: "second" };
  const hidden = { ...item, id: "hidden", visible: false,
    binding: { ...item.binding, objectRef: { ...item.binding.objectRef, id: other.id } } };
  const rendered = { ...output, provenance: { ...output.provenance, source: "rendered" as const,
    editorDocumentId: other.id, sourceItemId: hidden.id } };
  const snapshot = { ...project, assets: [...project.assets.filter(asset => asset.id !== output.id), rendered],
    canvasItems: [item, hidden], editorDocuments: [timeline, other] };
  const targets = timelinesForResultAssets(snapshot);
  for (const id of [imported, clip])
    assert.deepEqual(targets.get(id)?.map(target => target.itemId), [item.id, hidden.id]);
  assert.deepEqual(targets.get(rendered.id)?.map(target => target.itemId), [hidden.id]);
  const selected = targets.get(clip)![1];
  assert.equal(resolveProjectEditorItem(snapshot, selected)?.id, hidden.id);
  assert.throws(() => resolveProjectEditorItem(snapshot, { ...selected, editorId: timeline.id }));
  assert.throws(() => resolveProjectEditorItem(snapshot, { ...selected, revision: 99 }));
  const orphan = { ...snapshot, canvasItems: [item] };
  assert.throws(() => resolveProjectEditorItem(orphan, selected));
  assert.equal(resolveProjectEditorItem(orphan, { ...selected, itemId: null }), undefined);
  const replaced = { ...snapshot, assets: snapshot.assets.map(a => a.id === clip ? { ...a, fingerprint: "new" } : a) };
  assert.equal(timelinesForResultAssets(replaced).has(clip), false);
});

test("a delivered timeline waits for its project cursor before reporting deletion or offering a revision", () => {
  const editor = project.editorDocuments.find(doc => doc.kind === "timeline")!;
  const item = project.canvasItems.find(item => item.kind === "timeline")!;
  const receipt = { editorId: editor.id, revision: editor.revision + 1, itemId: item.id, title: "Cut" };
  const projectId = project.project.id, cursor = project.eventCursor + 1;
  const state = (snapshot?: ProjectSnapshot) => deliveredTimelineState(receipt, projectId, cursor, snapshot);
  const delivered = { ...project, eventCursor: cursor,
    editorDocuments: [{ ...editor, revision: receipt.revision }] };
  const pending = { title: receipt.title, status: "pending" };
  assert.deepEqual(state(), pending);
  assert.deepEqual(state(project), pending); // The cached editor still has the earlier revision.
  assert.deepEqual(state({ ...project, editorDocuments: [] }), pending);
  assert.deepEqual(state(delivered), { status: "available", title: receipt.title, revision: receipt.revision });
  assert.deepEqual(state({ ...delivered, editorDocuments: [] }), { status: "missing", title: receipt.title });
  const edited = { ...delivered, eventCursor: cursor + 1,
    editorDocuments: [{ ...editor, revision: receipt.revision + 1 }] };
  assert.equal(state(edited).revision, receipt.revision + 1);
  assert.deepEqual(deliveredTimelineState(receipt, projectId, undefined, edited), state(edited));
});

test("opening a result inside a hidden locked group rejects before changing visibility or history", async () => {
  const group = project.canvasItems.find(item => item.kind === "group")!;
  const timeline = project.editorDocuments.find(doc => doc.kind === "timeline")!;
  const item = project.canvasItems.find(item => item.kind === "timeline")!;
  const snapshot = { ...project, canvasItems: [
    { ...group, parentId: null, locked: true, visible: false },
    { ...item, parentId: group.id, locked: false, visible: true },
    { ...owner, parentId: group.id, locked: false, visible: true },
  ] };
  let writes = 0;
  const client = { snapshot, command: async () => { ++writes; } } as unknown as CreationClient;
  const center = () => ({ x: 0, y: 0 });
  await assert.rejects(prepareProjectEditorItem(client, {
    kind: "timeline", projectId: project.project.id, itemId: item.id, editorId: timeline.id, revision: timeline.revision,
  }, center));
  await assert.rejects(prepareProjectEditorItem(client, { kind: "media", asset: output, itemId: owner.id }, center));
  assert.equal(writes, 0);
});

test("opening existing hidden media or an unplaced candidate prepares an editor without project commands", async () => {
  const hidden = { ...owner, visible: false };
  const snapshot = { ...project, canvasItems: [hidden] };
  const client = { snapshot, command: () => assert.fail("read-only editor open") } as unknown as CreationClient;
  const center = () => ({ x: 250, y: 400 });
  const target = { kind: "media" as const, asset: output, itemId: hidden.id };
  assert.deepEqual(await prepareProjectEditorItem(client, target, center), { itemId: hidden.id });
  client.snapshot = { ...snapshot, canvasItems: [] };
  const candidate = await prepareProjectEditorItem(client, { ...target, itemId: null }, center);
  assert.equal(candidate.unplaced?.id, candidate.itemId);
  assert.deepEqual(candidate.unplaced?.binding, { role: "material", objectRef: result.asset });
  assert.deepEqual(client.snapshot.canvasItems, []);
});
