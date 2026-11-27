import {
  applyCommand,
  type CanvasCommand,
  type CanvasDocument,
  type CanvasNode,
} from "./model.ts";
import { referenceIssue, referenceIssueText } from "./connectionPolicy.ts";
import { generationEditorPatch } from "./generationReferenceContent.ts";
import type { ReferenceContent } from "./chatReferenceContent.ts";
import { tNow } from "../i18n/messages.ts";

/** Prepare a complete relationship + document edit before publishing any part. */
export function referenceContentCommand(
  document: CanvasDocument,
  targetId: string,
  content: ReferenceContent,
  added: CanvasNode[] = [],
  presetEdited = false,
): CanvasCommand {
  const target = document.nodes.find((node) => node.id === targetId);
  if (!target) throw new Error(tNow("errors.generation.targetMissing"));
  const desired = new Set(
    content.flatMap((part) =>
      part.type === "reference" && part.binding !== "asset" && part.nodeId
        ? [part.nodeId]
        : [],
    ),
  );
  const commands: CanvasCommand[] = [
    {
      type: "reference-sources",
      nodes: added.filter((node) => desired.has(node.id)),
    },
  ];
  let working = applyCommand(document, commands[0]!);
  // References in the text add relationships; they never drop one. Removing a
  // mention is a text edit, while a connection is removed by the reference
  // strip, which deletes the edge and its mentions together.
  const next = content.map((part) => {
    if (part.type !== "reference" || part.binding === "asset" || !part.nodeId)
      return part;
    const existing = working.edges.find(
      (edge) =>
        edge.intent !== "post_edit_result" &&
        edge.referenceBinding !== "pinned" &&
        edge.target === targetId &&
        edge.source === part.nodeId,
    );
    if (existing) return { ...part, referenceId: existing.id };
    const issue = referenceIssue(working, part.nodeId, targetId);
    if (issue) throw new Error(referenceIssueText(issue));
    const add: CanvasCommand = {
      type: "add-edge",
      edge: {
        id: part.referenceId ?? crypto.randomUUID(),
        source: part.nodeId,
        target: targetId,
        intent: "generation_input",
      },
    };
    commands.push(add);
    working = applyCommand(working, add);
    return { ...part, referenceId: add.edge.id };
  });
  const edited = working.nodes.find((node) => node.id === targetId) ?? target;
  commands.push({
    type: "update-node",
    id: targetId,
    patch: { data: generationEditorPatch(edited, next, presetEdited) },
  });
  return { type: "batch", commands };
}
