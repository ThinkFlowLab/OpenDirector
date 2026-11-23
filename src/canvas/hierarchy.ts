import { tNow } from "../i18n/messages.ts";

interface HierarchyNode {
  id: string;
  parentId?: string | null;
  locked?: boolean;
}

export function indexNodes<T extends HierarchyNode>(nodes: readonly T[]): Map<string, T> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) throw new Error(tNow("errors.hierarchy.duplicate"));
  return byId;
}

/** Nearest parent first. Invalid hierarchies fail before any document changes. */
export function ancestors<T extends HierarchyNode>(
  node: T,
  byId: ReadonlyMap<string, T>,
): T[] {
  const result: T[] = [];
  const visited = new Set([node.id]);
  let parentId = node.parentId;
  while (parentId) {
    if (visited.has(parentId)) throw new Error(tNow("errors.hierarchy.cycle"));
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) throw new Error(tNow("errors.hierarchy.parentMissing", { id: parentId }));
    result.push(parent);
    parentId = parent.parentId;
  }
  return result;
}

/** Locking a container protects its descendants without changing their own lock flags. */
export function isNodeLocked(
  node: HierarchyNode,
  byId: ReadonlyMap<string, HierarchyNode>,
): boolean {
  return (
    Boolean(node.locked) ||
    ancestors(node, byId).some((parent) => parent.locked)
  );
}

export function lockedNodeIds(nodes: readonly HierarchyNode[]): Set<string> {
  const byId = indexNodes(nodes);
  return new Set(
    nodes.filter((node) => isNodeLocked(node, byId)).map((node) => node.id),
  );
}
