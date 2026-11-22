import { objectVersion } from "../../backend/creationClient.ts";
import type { ModelConfig } from "../../backend/rules.ts";
import type { ProjectSnapshot } from "../../contracts/generated.ts";
import { getNodeGenerationSettings } from "../generationSettings.ts";
import { workflowDependencies } from "../groupWorkflow.ts";
import type { CanvasDocument } from "../model.ts";
import { groupDescendants } from "../operations";

export function workflowSteps(document: CanvasDocument, groupId: string) {
  return groupDescendants(document.nodes, groupId).filter(node => {
    const prompt = Boolean(node.data.prompt?.trim() || node.data.promptContent?.length);
    if (node.type === "text") return Boolean(node.data.agentSettings?.modelConfigId && prompt);
    if (!["image", "video", "audio"].includes(node.type) || !node.data.settings?.modelConfigId) return false;
    return prompt || document.edges.some(edge => edge.target === node.id && edge.intent !== "post_edit_result");
  });
}

/** Preview and submission use the same saved specifications, dependencies and candidate counts. */
export function workflowRequest(document: CanvasDocument, groupId: string, snapshot: ProjectSnapshot, models: readonly ModelConfig[]) {
  const steps = workflowSteps(document, groupId);
  const dependencies = workflowDependencies(steps.map(node => node.id), document.edges);
  const members = [];
  const versions = [];
  for (const node of steps) {
    const item = snapshot.canvasItems.find(i => i.id === node.id);
    const specId = item?.binding.role === "generation" ? item.binding.objectRef.id :
      item && "draftSpec" in item.binding ? item.binding.draftSpec?.id : undefined;
    const spec = snapshot.generationSpecs.find(s => s.id === specId);
    if (!item || !spec) return undefined;
    const count = node.type === "image" || node.type === "video" ? getNodeGenerationSettings(node, models).count ?? 1 : 1;
    members.push({ itemId: item.id, specId: spec.id, count, after: [...dependencies.get(item.id)!] });
    versions.push(objectVersion("canvas_item", item), objectVersion("generation_spec", spec));
  }
  return members.length ? { members, versions } : undefined;
}
