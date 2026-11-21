import { indexNodes, ancestors, isNodeLocked } from "./hierarchy.ts";
import { mapCanvasToolTaskReferences } from "./toolCatalog.ts";
import { mapSettingsNodeReferences } from "./model.ts";
import { generationContentPatch } from "./generationReferenceContent.ts";
import { absolutePosition, boundsOfNodes } from "./geometry.ts";
import { applyCommand, createNode } from "./model.ts";
import { derivedNodeTitle, takenNodeTitles } from "./model.ts";
import { tNow } from "../i18n/messages.ts";
import type {
  CanvasDocument,
  CanvasEdge,
  CanvasNode,
  CanvasNodeData,
  CanvasResource,
  Point,
  StackData,
} from "./model.ts";

export interface CanvasFragment {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** Project hierarchy order independently of painting order stored in zIndex. */
export function orderNodesForCanvas(
  nodes: readonly CanvasNode[],
): CanvasNode[] {
  const byId = indexNodes(nodes);
  const depth = new Map(
    nodes.map((node) => [node.id, ancestors(node, byId).length]),
  );
  return [...nodes].sort((a, b) => depth.get(a.id)! - depth.get(b.id)!);
}

/**
 * Groups independent unlocked selection members under their nearest common
 * ancestor. Selecting both a group and its child does not reparent that child
 * twice. Existing descendants keep their own positions and identities.
 */
export function groupSelection(
  document: CanvasDocument,
  ids: readonly string[],
): CanvasDocument {
  const byId = indexNodes(document.nodes);
  const selected = new Set(ids);
  const stackedIds = new Set(
    document.nodes.flatMap((node) => node.data.stack?.nodeIds ?? []),
  );
  const eligible = document.nodes.filter(
    (node) =>
      selected.has(node.id) &&
      !isNodeLocked(node, byId) &&
      node.type !== "stack" &&
      !stackedIds.has(node.id),
  );
  const eligibleIds = new Set(eligible.map((node) => node.id));
  const roots = eligible.filter(
    (node) =>
      !ancestors(node, byId).some((parent) => eligibleIds.has(parent.id)),
  );
  if (roots.length < 2) return document;

  const parent = ancestors(roots[0]!, byId).find((candidate) =>
    roots.every((node) =>
      ancestors(node, byId).some((ancestor) => ancestor.id === candidate.id),
    ),
  );
  const parentPosition = parent
    ? absolutePosition(parent, document.nodes)
    : { x: 0, y: 0 };
  const bounds = boundsOfNodes(roots, document.nodes)!;
  const groupPosition = { x: bounds.x - 24, y: bounds.y - 40 };
  const group = {
    ...createNode("group", {
      x: groupPosition.x - parentPosition.x,
      y: groupPosition.y - parentPosition.y,
    }),
    width: bounds.width + 48,
    height: bounds.height + 64,
    ...(parent ? { parentId: parent.id } : {}),
  };
  const rootIds = new Set(roots.map((node) => node.id));
  const nodes: CanvasNode[] = [];
  let inserted = false;
  for (const node of document.nodes) {
    if (!rootIds.has(node.id)) {
      nodes.push(node);
      continue;
    }
    if (!inserted) {
      nodes.push(group);
      inserted = true;
    }
    const position = absolutePosition(node, document.nodes);
    nodes.push({
      ...node,
      parentId: group.id,
      position: {
        x: position.x - groupPosition.x,
        y: position.y - groupPosition.y,
      },
    });
  }
  return { ...document, nodes };
}

/**
 * Removes selected group containers and reconnects children to their nearest
 * retained ancestor, preserving absolute positions. A locked child protects its
 * immediate parent from removal. Edges attached to removed containers are
 * removed; references between retained nodes are preserved unchanged.
 */
export function ungroupSelection(
  document: CanvasDocument,
  ids: readonly string[],
): CanvasDocument {
  const byId = indexNodes(document.nodes);
  const selected = new Set(ids);
  const removed = new Set(
    document.nodes
      .filter(
        (node) =>
          selected.has(node.id) &&
          node.type === "group" &&
          !isNodeLocked(node, byId),
      )
      .map((node) => node.id),
  );
  for (const node of document.nodes)
    if (node.locked && node.parentId) removed.delete(node.parentId);
  if (!removed.size) return document;

  const nodes = document.nodes
    .filter((node) => !removed.has(node.id))
    .map((node) => {
      if (!node.parentId || !removed.has(node.parentId)) return node;
      const parent = ancestors(node, byId).find(
        (ancestor) => !removed.has(ancestor.id),
      );
      const position = absolutePosition(node, document.nodes);
      const parentPosition = parent
        ? absolutePosition(parent, document.nodes)
        : { x: 0, y: 0 };
      const { parentId: _parentId, ...rest } = node;
      return {
        ...rest,
        ...(parent ? { parentId: parent.id } : {}),
        position: {
          x: position.x - parentPosition.x,
          y: position.y - parentPosition.y,
        },
      };
    });
  return {
    ...document,
    nodes,
    ...(document.hiddenNodes?.some(
      (node) => node.parentId && removed.has(node.parentId),
    )
      ? {
          hiddenNodes: [
            ...document.hiddenNodes,
            ...document.nodes.filter((node) => removed.has(node.id)),
          ],
        }
      : {}),
    edges: document.edges.filter(
      (edge) => !removed.has(edge.source) && !removed.has(edge.target),
    ),
  };
}

export type GroupLayout = "grid" | "row" | "column";

/** Padding a group keeps around its members; matches {@link groupSelection}. */
const GROUP_PADDING = { left: 24, top: 40, right: 24, bottom: 24 };
const GROUP_LAYOUT_GAP = 40;

/**
 * Arranges a group's direct members in a row, a column or a near-square grid,
 * in their current reading order, and resizes the group to fit them. Member
 * positions are relative to the group, which keeps its top-left corner.
 */
export function layoutGroup(
  document: CanvasDocument,
  groupId: string,
  layout: GroupLayout,
): CanvasDocument {
  const group = document.nodes.find(
    (node) => node.id === groupId && node.type === "group",
  );
  if (!group) return document;
  const members = document.nodes
    .filter((node) => node.parentId === groupId)
    .sort((a, b) =>
      layout === "row"
        ? a.position.x - b.position.x || a.position.y - b.position.y
        : a.position.y - b.position.y || a.position.x - b.position.x,
    );
  if (!members.length) return document;
  const columns =
    layout === "row"
      ? members.length
      : layout === "column"
        ? 1
        : Math.ceil(Math.sqrt(members.length));
  const positions = new Map<string, Point>();
  let x = GROUP_PADDING.left,
    y = GROUP_PADDING.top,
    rowHeight = 0,
    right = 0,
    bottom = 0;
  members.forEach((node, index) => {
    if (index && index % columns === 0) {
      x = GROUP_PADDING.left;
      y += rowHeight + GROUP_LAYOUT_GAP;
      rowHeight = 0;
    }
    positions.set(node.id, { x, y });
    right = Math.max(right, x + node.width);
    bottom = Math.max(bottom, y + node.height);
    x += node.width + GROUP_LAYOUT_GAP;
    rowHeight = Math.max(rowHeight, node.height);
  });
  return {
    ...document,
    nodes: document.nodes.map((node) =>
      node.id === groupId
        ? {
            ...node,
            width: right + GROUP_PADDING.right,
            height: bottom + GROUP_PADDING.bottom,
          }
        : positions.has(node.id)
          ? { ...node, position: positions.get(node.id)! }
          : node,
    ),
  };
}

/** Members of a group at any depth, excluding the group itself. */
export function groupDescendants(
  nodes: readonly CanvasNode[],
  groupId: string,
): CanvasNode[] {
  const inside = new Set([groupId]);
  const result: CanvasNode[] = [];
  for (const node of orderNodesForCanvas(nodes))
    if (node.parentId && inside.has(node.parentId)) {
      inside.add(node.id);
      result.push(node);
    }
  return result;
}

/** Copies selected groups with all descendants and edges internal to the copy. */
export function copySelection(
  document: CanvasDocument,
  ids: readonly string[],
): CanvasFragment {
  const byId = indexNodes(document.nodes);
  const selected = new Set(ids);
  const selectedGroups = new Set(
    document.nodes
      .filter((node) => selected.has(node.id) && node.type === "group")
      .map((node) => node.id),
  );
  const stackMembers = new Set(
    document.nodes
      .filter((node) => selected.has(node.id) && node.type === "stack")
      .flatMap((node) => node.data.stack?.nodeIds ?? []),
  );
  const included = document.nodes.filter(
    (node) =>
      selected.has(node.id) ||
      stackMembers.has(node.id) ||
      ancestors(node, byId).some((parent) => selectedGroups.has(parent.id)),
  );
  const includedIds = new Set(included.map((node) => node.id));
  const nodes = included.map((node) => {
    const copy = structuredClone(node);
    if (copy.parentId && !includedIds.has(copy.parentId)) {
      delete copy.parentId;
      copy.position = absolutePosition(node, document.nodes);
    }
    return copy;
  });
  return {
    nodes,
    edges: structuredClone(
      document.edges.filter(
        (edge) => includedIds.has(edge.source) && includedIds.has(edge.target),
      ),
    ),
  };
}

/** Edges that touch any of the given nodes. */
export function edgesAttachedTo(
  document: Pick<CanvasDocument, "edges">,
  ids: Iterable<string>,
): string[] {
  const removed = new Set(ids);
  return document.edges
    .filter((edge) => removed.has(edge.source) || removed.has(edge.target))
    .map((edge) => edge.id);
}

export function deleteSelection(
  document: CanvasDocument,
  ids: string[],
  selectedEdges: string[],
): CanvasDocument {
  const hidden = applyCommand(document, { type: "hide-nodes", ids });
  const visible = new Set(hidden.nodes.map((node) => node.id));
  const removed = document.nodes
    .filter((node) => !visible.has(node.id))
    .map((node) => node.id);
  const edges = [...new Set([...selectedEdges, ...edgesAttachedTo(document, removed)])];
  // Clear prompt references while all affected nodes are still visible.
  const detached = applyCommand(document, { type: "remove-edges", ids: edges });
  return applyCommand(detached, { type: "hide-nodes", ids: removed });
}

/** Cut the same complete hierarchy/stack that paste owns, or leave everything unchanged. */
export function cutSelection(
  document: CanvasDocument,
  ids: readonly string[],
): { document: CanvasDocument; fragment?: CanvasFragment } {
  const fragment = copySelection(document, ids);
  if (!fragment.nodes.length) return { document };
  const included = new Set(fragment.nodes.map((node) => node.id));
  const hide = { type: "hide-nodes" as const, ids: [...included] };
  // Check the original relationships before detaching anything.
  if (applyCommand(document, hide).nodes.some((node) => included.has(node.id)))
    return { document };
  const detached = applyCommand(document, {
    type: "remove-edges",
    ids: edgesAttachedTo(document, included),
  });
  if (edgesAttachedTo(detached, included).length) return { document };
  const next = applyCommand(detached, hide);
  if (next.nodes.some((node) => included.has(node.id))) return { document };
  return { document: next, fragment: copySelection(detached, ids) };
}

/**
 * Duplicates a self-contained fragment. Offsets apply only to root nodes, so
 * nested children move once. Returned ids include every newly inserted node.
 * Asset identifiers inside data remain resource references, not node identities.
 */
export function pasteFragment(
  document: CanvasDocument,
  fragment: CanvasFragment,
  offset: Point = { x: 40, y: 40 },
): { document: CanvasDocument; ids: string[] } {
  if (!Number.isFinite(offset.x) || !Number.isFinite(offset.y))
    throw new Error(tNow("errors.operations.pasteOffset"));
  const byId = indexNodes(fragment.nodes);
  for (const node of fragment.nodes) ancestors(node, byId);
  for (const node of fragment.nodes)
    if (node.data.stack?.nodeIds.some((id) => !byId.has(id)))
      throw new Error(tNow("errors.operations.stackCopy"));
  const edgeIds = new Set<string>();
  for (const edge of fragment.edges) {
    if (edgeIds.has(edge.id)) throw new Error(tNow("errors.operations.duplicateEdge"));
    edgeIds.add(edge.id);
    if (!byId.has(edge.source) || !byId.has(edge.target))
      throw new Error(tNow("errors.operations.copyEdge"));
  }
  if (!fragment.nodes.length) return { document, ids: [] };

  const used = new Set([
    ...document.nodes.map((node) => node.id),
    ...document.edges.map((edge) => edge.id),
  ]);
  const newId = () => {
    let id: string;
    do id = crypto.randomUUID();
    while (used.has(id));
    used.add(id);
    return id;
  };
  const remapped = new Map(fragment.nodes.map((node) => [node.id, newId()]));
  // A copy is a different item, so it must not answer to the source's exact name.
  const titles = takenNodeTitles(document);
  const nodes = fragment.nodes.map((node) => {
    const copy = structuredClone(node);
    copy.id = remapped.get(node.id)!;
    copy.data.title = derivedNodeTitle(node.data.title, titles);
    if (copy.type === "image") copy.data.copiedSourceId = node.id;
    copy.data = remapDataReferences(copy.data, remapped);
    if (copy.data.promptContent && copy.data.settings && node.data.settings) {
      for (const field of ["firstFrameNodeId", "lastFrameNodeId"] as const) {
        const original = node.data.settings[field];
        if (
          original &&
          !remapped.has(original) &&
          [...document.nodes, ...(document.hiddenNodes ?? [])].some(
            (source) => source.id === original,
          ) &&
          copy.data.promptContent.some(
            (part) => part.type === "reference" && part.nodeId === original,
          )
        )
          copy.data.settings = { ...copy.data.settings, [field]: original };
      }
    }
    if (copy.data.promptMentions)
      copy.data.promptMentions = copy.data.promptMentions.flatMap(
        ({ referenceId: _oldReference, ...mention }) =>
          mention.sourceNodeId
            ? [
                {
                  ...mention,
                  sourceNodeId:
                    remapped.get(mention.sourceNodeId) ?? mention.sourceNodeId,
                },
              ]
            : [],
      );
    // A copied result's historical inputs retain their original identities.
    if (node.parentId) copy.parentId = remapped.get(node.parentId)!;
    else
      copy.position = {
        x: node.position.x + offset.x,
        y: node.position.y + offset.y,
      };
    return copy;
  });
  let ordered = orderNodesForCanvas(nodes);
  const edges = fragment.edges.map((edge) => ({
    ...structuredClone(edge),
    id: newId(),
    source: remapped.get(edge.source)!,
    target: remapped.get(edge.target)!,
  }));
  const knownSources = new Set(
    [...document.nodes, ...(document.hiddenNodes ?? []), ...ordered].map(
      (node) => node.id,
    ),
  );
  ordered = ordered.map((node) => {
    if (!node.data.promptContent) return node;
    const pinned = new Map<string, string>();
    const content = node.data.promptContent.map((part) => {
      if (part.type !== "reference") return part;
      if (part.binding === "asset") {
        const key = part.referenceId ?? `${part.assetId}:${part.fingerprint}`;
        if (!pinned.has(key)) pinned.set(key, newId());
        return { ...part, referenceId: pinned.get(key)! };
      }
      const source = part.nodeId && (remapped.get(part.nodeId) ?? part.nodeId);
      if (!source || !knownSources.has(source))
        return { type: "text" as const, text: `@${part.name}` };
      let edge = edges.find(
        (edge) =>
          edge.intent !== "post_edit_result" &&
          edge.source === source &&
          edge.target === node.id,
      );
      if (!edge) {
        edge = {
          id: newId(),
          source,
          target: node.id,
          intent: "generation_input",
        };
        edges.push(edge);
      }
      return {
        ...part,
        nodeId: source,
        assetId: `node:${source}`,
        referenceId: edge.id,
      };
    });
    return {
      ...node,
      data: { ...node.data, ...generationContentPatch(content) },
    };
  });
  return {
    document: {
      ...document,
      nodes: [...document.nodes, ...ordered],
      edges: [...document.edges, ...edges],
    },
    ids: ordered.map((node) => node.id),
  };
}

/** Rewrites node identities only; retained media resource IDs and sources are not node identities. */
function remapDataReferences(
  data: CanvasNodeData,
  ids: ReadonlyMap<string, string>,
): CanvasNodeData {
  const remapResource = (resource: CanvasResource): CanvasResource =>
    resource.nodeId && ids.has(resource.nodeId)
      ? { ...resource, nodeId: ids.get(resource.nodeId)! }
      : resource;
  return {
    ...data,
    ...(data.taskDraft
      ? {
          taskDraft: mapCanvasToolTaskReferences(data.taskDraft, (id) =>
            ids.get(id),
          ),
        }
      : {}),
    ...(data.settings
      ? {
          settings: mapSettingsNodeReferences(data.settings, (id) =>
            ids.get(id),
          ),
        }
      : {}),
    ...(data.stack
      ? {
          stack: {
            ...data.stack,
            nodeIds: data.stack.nodeIds.map((id) => ids.get(id) ?? id),
          },
        }
      : {}),
    ...(data.timeline
      ? {
          timeline: {
            ...data.timeline,
            ...(data.timeline.importedAssets
              ? {
                  importedAssets:
                    data.timeline.importedAssets.map(remapResource),
                }
              : {}),
            tracks: data.timeline.tracks.map((track) => ({
              ...track,
              clips: track.clips.map((clip) => ({
                ...clip,
                resource: remapResource(clip.resource),
              })),
            })),
          },
        }
      : {}),
    ...(data.subject
      ? {
          subject: {
            ...data.subject,
            auxiliaries: data.subject.auxiliaries.map(remapResource),
            ...(data.subject.main
              ? { main: remapResource(data.subject.main) }
              : {}),
            ...(data.subject.voice
              ? { voice: remapResource(data.subject.voice) }
              : {}),
          },
        }
      : {}),
  };
}

export const STACK_MEMBER_KINDS = [
  "image",
  "video",
  "audio",
  "text",
  "subject",
  "timeline",
  "external",
] as const;

/** Creates an ordered stack without reparenting or discarding its source nodes. */
export function stackSelection(
  document: CanvasDocument,
  ids: readonly string[],
): CanvasDocument {
  const selected = [...new Set(ids)];
  if (selected.length < 2 || selected.length > 50)
    throw new Error(tNow("errors.operations.stackSelection"));
  const existing = new Set(
    document.nodes.flatMap((node) => node.data.stack?.nodeIds ?? []),
  );
  const members = selected.map((id) =>
    document.nodes.find((node) => node.id === id),
  );
  if (
    members.some(
      (node) =>
        !node ||
        node.parentId ||
        node.locked ||
        !STACK_MEMBER_KINDS.includes(
          node.type as (typeof STACK_MEMBER_KINDS)[number],
        ) ||
        existing.has(node.id),
    )
  )
    throw new Error(
      tNow("errors.operations.stackMembers"),
    );
  const first = members[0]!;
  const stack = createNode(
    "stack",
    { x: first.position.x + first.width + 60, y: first.position.y },
    { stack: { nodeIds: selected, activeIndex: 0 } },
  );
  return { ...document, nodes: [...document.nodes, stack] };
}

export function updateStack(
  document: CanvasDocument,
  id: string,
  stack: StackData,
): CanvasDocument {
  const target = document.nodes.find((node) => node.id === id);
  if (
    !target ||
    target.type !== "stack" ||
    isNodeLocked(target, indexNodes(document.nodes))
  )
    return document;
  const existing = new Set(
    document.nodes
      .filter((node) => node.id !== id)
      .flatMap((node) => node.data.stack?.nodeIds ?? []),
  );
  if (
    stack.nodeIds.length > 50 ||
    new Set(stack.nodeIds).size !== stack.nodeIds.length ||
    !Number.isSafeInteger(stack.activeIndex) ||
    stack.activeIndex < 0 ||
    stack.activeIndex >= Math.max(1, stack.nodeIds.length) ||
    stack.nodeIds.some((id) => {
      const node = document.nodes.find((node) => node.id === id);
      return (
        !node ||
        node.parentId ||
        existing.has(id) ||
        !STACK_MEMBER_KINDS.includes(
          node.type as (typeof STACK_MEMBER_KINDS)[number],
        )
      );
    })
  )
    throw new Error(tNow("errors.operations.stackInvalid"));
  const oldIds = target.data.stack?.nodeIds ?? [];
  const index = indexNodes(document.nodes);
  if (
    stack.nodeIds.some(
      (id) => !oldIds.includes(id) && isNodeLocked(index.get(id)!, index),
    )
  )
    throw new Error(tNow("errors.operations.stackLocked"));
  if (stack.nodeIds.length < 2) return unstackSelection(document, [id]);
  const removed = oldIds.filter((id) => !stack.nodeIds.includes(id));
  if (
    removed.some((id) => {
      const node = index.get(id);
      return node && isNodeLocked(node, index);
    })
  )
    throw new Error(tNow("errors.operations.stackUnlock"));
  const released = releaseStackMembers(document.nodes, target, removed);
  return {
    ...document,
    nodes: released.map((node) =>
      node.id === id
        ? {
            ...node,
            data: {
              ...node.data,
              stack: {
                nodeIds: [...stack.nodeIds],
                activeIndex: stack.activeIndex,
              },
            },
          }
        : node,
    ),
  };
}

/** Removing the wrapper leaves node identities/references intact and lays content out at the stack. */
export function unstackSelection(
  document: CanvasDocument,
  ids: readonly string[],
): CanvasDocument {
  const byId = indexNodes(document.nodes);
  const stacks = document.nodes.filter(
    (node) =>
      ids.includes(node.id) &&
      node.type === "stack" &&
      !isNodeLocked(node, byId),
  );
  if (!stacks.length) return document;
  const removed = new Set(stacks.map((node) => node.id));
  let nodes = document.nodes;
  for (const stack of stacks)
    nodes = releaseStackMembers(nodes, stack, stack.data.stack?.nodeIds ?? []);
  return {
    ...document,
    nodes: nodes.filter((node) => !removed.has(node.id)),
    edges: document.edges.filter(
      (edge) => !removed.has(edge.source) && !removed.has(edge.target),
    ),
  };
}

function releaseStackMembers(
  nodes: CanvasNode[],
  stack: CanvasNode,
  ids: readonly string[],
): CanvasNode[] {
  if (!ids.length) return nodes;
  const byId = indexNodes(nodes),
    members = ids
      .map((id) => byId.get(id))
      .filter((node): node is CanvasNode => Boolean(node));
  const columns = Math.max(1, Math.ceil(Math.sqrt(members.length)));
  const cellWidth =
    Math.max(...members.map((node) => node.width), stack.width) + 64;
  const cellHeight =
    Math.max(...members.map((node) => node.height), stack.height) + 64;
  const center = absolutePosition(stack, nodes);
  const positions = new Map(
    members.map((node, index) => [
      node.id,
      {
        x: center.x + (index % columns) * cellWidth,
        y: center.y + Math.floor(index / columns) * cellHeight,
      },
    ]),
  );
  return nodes.map((node) =>
    positions.has(node.id) && !isNodeLocked(node, byId)
      ? { ...node, position: positions.get(node.id)! }
      : node,
  );
}

/** Captures a media snapshot so timeline/subject edits do not lose assets when the source node is removed. */
export function resourceFromNode(node: CanvasNode): CanvasResource | null {
  if (
    !["image", "video", "audio", "file"].includes(node.type) ||
    !node.data.src
  )
    return null;
  return {
    id: `node:${node.id}`,
    ...(node.data.backendAssetId ? { assetId: node.data.backendAssetId } : {}),
    ...(node.data.byteSize !== undefined
      ? { byteSize: node.data.byteSize }
      : {}),
    nodeId: node.id,
    kind: node.type as CanvasResource["kind"],
    title: node.data.title,
    src: node.data.src,
    ...node.data.media,
    ...(node.data.mimeType ? { mimeType: node.data.mimeType } : {}),
  };
}
