import { displayedAssetId, visibleItems } from "../backend/creationClient.ts";
import type { ChatMessage } from "../backend/chat.ts";
import type { Asset, ProjectSnapshot } from "../contracts/generated.ts";

export interface AssistantResult {
  assetId: string;
  asset: Asset | null;
  name?: string;
  resultId: string | null;
  status: "current" | "candidate" | "historical" | "asset";
  /** A canvas item displaying this exact asset, including a hidden item. */
  itemId: string | null;
}

/** The persisted user message ID is the agent's turn ID. Read only committed
 * outputs with that provenance, including jobs which finish after the reply. */
export function assistantResultsByTurn(snapshot: ProjectSnapshot | undefined) {
  const turns = new Map<string, AssistantResult[]>();
  if (!snapshot) return turns;
  const add = (turnId: string, card: AssistantResult) => {
    const cards = turns.get(turnId);
    if (cards) cards.push(card);
    else turns.set(turnId, [card]);
  };
  const assets = new Map(snapshot.assets.map((asset) => [asset.id, asset]));
  const results = new Map(snapshot.results.map((result) => [result.id, result]));
  const adopted = new Map(snapshot.generationSpecs.map((spec) => [spec.id, spec.currentResultId]));
  const adoptedAsset = (specId: string) => {
    const resultId = adopted.get(specId);
    return resultId ? results.get(resultId)?.asset.assetId : undefined;
  };
  const visible = visibleItems(snapshot);
  const displayedByItem = new Map<string, string>();
  const itemForAsset = new Map<string, string>();
  for (const item of snapshot.canvasItems) {
    const assetId = displayedAssetId(item, adoptedAsset);
    if (!assetId) continue;
    displayedByItem.set(item.id, assetId);
    const existing = itemForAsset.get(assetId);
    if (!existing || (!visible.has(existing) && visible.has(item.id)))
      itemForAsset.set(assetId, item.id);
  }

  const jobs = new Map(snapshot.jobs.map((job) => [job.id, job]));
  for (const result of snapshot.results) {
    const job = jobs.get(result.jobId);
    if (!job?.agentRunId || job.status !== "succeeded") continue;
    const { assetId, fingerprint } = result.asset;
    const asset = assets.get(assetId);
    const available = asset?.fingerprint === fingerprint;
    const origin = job.originItemId;
    const itemId = origin && displayedByItem.get(origin) === assetId
      ? origin : itemForAsset.get(assetId);
    const current = adopted.get(result.specId) === result.id;
    add(job.agentRunId, {
      assetId,
      resultId: result.id,
      asset: available ? asset : null,
      status: current ? "current" : job.adopted ? "historical" : "candidate",
      itemId: available ? itemId ?? null : null,
    });
  }
  for (const asset of snapshot.assets) {
    const { source, agentRunId } = asset.provenance;
    if (source !== "agent_written" || !agentRunId) continue;
    add(agentRunId, {
      assetId: asset.id, resultId: null, asset, status: "asset",
      itemId: itemForAsset.get(asset.id) ?? null,
    });
  }
  return turns;
}

/** Restore the identity of a deleted direct publication once project changes
 * through its delivery are visible. A lagging snapshot does not prove deletion. */
export function withPublishedAssistantResults(
  live: Map<string, AssistantResult[]>, messages: readonly ChatMessage[], snapshot?: ProjectSnapshot,
) {
  let turns = live;
  if (!snapshot) return turns;
  for (const [index, message] of messages.entries()) {
    const receipt = message.publishedAssets;
    const turn = messages[index - 1];
    if (message.role !== "assistant" || turn?.role !== "user" || !receipt
      || receipt.projectId !== snapshot.project.id || receipt.eventCursor > snapshot.eventCursor) continue;
    const cards = live.get(turn.id) ?? [];
    const byId = new Map(cards.map((card, i) => [card.assetId, i]));
    let merged = cards;
    for (const { id, name, fingerprint } of receipt.assets) {
      const at = byId.get(id);
      if (at !== undefined && cards[at].asset?.fingerprint === fingerprint) continue;
      if (merged === cards) merged = [...cards];
      const missing: AssistantResult = { assetId: id, name, asset: null, resultId: null, itemId: null, status: "asset" };
      if (at === undefined) merged.push(missing);
      else merged[at] = missing;
    }
    if (merged !== cards) {
      if (turns === live) turns = new Map(live);
      turns.set(turn.id, merged);
    }
  }
  return turns;
}
