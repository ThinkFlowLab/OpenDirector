import { nodeByteSize } from "./uploadPolicy.ts";
import type { CanvasDocument, CanvasNode, CanvasNodeData } from "./model.ts";
import { referenceMaterial } from "./connectionPolicy.ts";
import {
  normalizeContent,
  contentText,
  referencePart,
  type ReferenceAsset,
  type ReferenceContent,
} from "./chatReferenceContent.ts";
import { tNow } from "../i18n/messages.ts";

export function generationPrompt(node: CanvasNode) {
  return node.type === "audio" && node.data.promptContent !== undefined
    ? contentText(node.data.promptContent, true)
    : node.data.prompt;
}

/** Match provider numbering to first inline occurrence, then relationship order. */
export function incomingReferenceNodes(
  document: CanvasDocument,
  targetId: string | null | undefined,
) {
  const visible = new Map(document.nodes.map((node) => [node.id, node]));
  const target = targetId && visible.get(targetId);
  const edges = document.edges.filter(
    (edge) =>
      edge.intent !== "post_edit_result" &&
      edge.referenceBinding !== "pinned" &&
      edge.target === targetId,
  );
  const connected = new Set(edges.map((edge) => edge.source));
  const mentioned = target
    ? (target.data.promptContent?.flatMap((part) =>
        part.type === "reference" && part.nodeId ? [part.nodeId] : [],
      ) ??
      target.data.promptMentions?.flatMap((part) =>
        part.sourceNodeId ? [part.sourceNodeId] : [],
      ) ??
      [])
    : [];
  return [...new Set([...mentioned, ...edges.map((edge) => edge.source)])]
    .filter((id) => connected.has(id))
    .flatMap((id) => visible.get(id) ?? []);
}

/** Editor identities follow logical sources, independent of a file's current URL. */
const sourceFingerprints = new WeakMap<
  CanvasNodeData,
  { facts: unknown[]; digest: string; size: number }
>();

export function nodeReferenceAsset(
  node: CanvasNode,
  referenceId?: string,
): ReferenceAsset {
  // Dragging and viewport changes recreate node wrappers, but keep their data.
  // Compare content facts before reading/serializing potentially large media.
  // Retain primitive facts too so in-place source edits cannot leave a stale digest.
  const data = node.data;
  const facts: unknown[] = [node.type, data.assetState, data.byteSize];
  if (node.type === "subject")
    facts.push(
      data.subject?.main?.src,
      ...(data.subject?.auxiliaries.map((resource) => resource.src) ?? []),
      data.subject?.voice?.src,
    );
  else facts.push(node.type === "text" ? data.text : data.src);
  let cached = sourceFingerprints.get(data);
  if (
    !cached ||
    cached.facts.length !== facts.length ||
    facts.some((fact, index) => fact !== cached!.facts[index])
  ) {
    const material = referenceMaterial(node) ?? "";
    let hash = 2166136261;
    for (let i = 0; i < material.length; i++)
      hash = Math.imul(hash ^ material.charCodeAt(i), 16777619);
    cached = {
      facts,
      digest: `${material.length}:${hash >>> 0}`,
      size: nodeByteSize(node),
    };
    sourceFingerprints.set(data, cached);
  }
  return {
    id: `node:${node.id}`,
    nodeId: node.id,
    referenceId,
    name: (node.data.title || tNow("errors.refs.fallbackTitle")).slice(0, 255),
    nodeTitle: (node.data.title || tNow("errors.refs.fallbackTitle")).slice(0, 255),
    kind: node.type,
    type: `${node.type}/reference`,
    size: cached.size,
    fingerprint: `source:${node.id}:${cached.digest}`,
  };
}

export function generationContentPatch(
  content: ReferenceContent,
): Pick<CanvasNodeData, "prompt" | "promptContent" | "promptMentions"> {
  let prompt = "";
  const mentions: NonNullable<CanvasNodeData["promptMentions"]> = [];
  for (const part of content) {
    if (part.type === "text") prompt += part.text;
    else if (part.type === "skill") prompt += `/${part.name}`;
    else {
      const label = `@${part.name}`;
      mentions.push({
        ...(part.nodeId ? { sourceNodeId: part.nodeId } : {}),
        ...(part.referenceId ? { referenceId: part.referenceId } : {}),
        start: prompt.length,
        end: prompt.length + label.length,
      });
      prompt += label;
    }
  }
  return {
    prompt,
    promptContent: normalizeContent(content),
    promptMentions: mentions,
  };
}

/** Upgrade old ranged mentions once and surface references created by drag/API. */
export function generationContent(
  node: CanvasNode,
  incoming: readonly CanvasNode[],
  referenceId: (nodeId: string) => string | undefined = () => undefined,
): ReferenceContent {
  let body: ReferenceContent;
  if (node.data.promptContent !== undefined) body = node.data.promptContent;
  else {
    body = [];
    let cursor = 0;
    for (const mention of node.data.promptMentions ?? []) {
      const source = incoming.find(
        (source) => source.id === mention.sourceNodeId,
      );
      if (
        !source ||
        mention.start < cursor ||
        mention.end > node.data.prompt.length
      )
        continue;
      if (mention.start > cursor)
        body.push({
          type: "text",
          text: node.data.prompt.slice(cursor, mention.start),
        });
      body.push(
        referencePart(
          nodeReferenceAsset(
            source,
            mention.referenceId ?? referenceId(source.id),
          ),
        ),
      );
      cursor = mention.end;
    }
    if (cursor < node.data.prompt.length)
      body.push({ type: "text", text: node.data.prompt.slice(cursor) });
  }
  body = body.map((part) => {
    if (part.type !== "reference" || part.binding === "asset" || !part.nodeId)
      return part;
    const source = incoming.find((source) => source.id === part.nodeId);
    return source
      ? referencePart(
          nodeReferenceAsset(
            source,
            part.referenceId ?? referenceId(source.id),
          ),
        )
      : part;
  });
  // Canvas connections stay in the reference strip. Only what the prompt itself
  // mentions belongs in the text, so connecting a source never edits the draft.
  return normalizeContent(body);
}
