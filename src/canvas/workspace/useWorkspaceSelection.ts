import { useEffect } from "react";
import { visibleSelectionIds } from "../stackProjection";

import type { WorkspaceRuntime } from "./runtimeTypes.ts";

export function useWorkspaceSelection(rt: WorkspaceRuntime) {
  const {
    composerNode,
    doc,
    interacting,
    setComposerNodeId,
    setExpandedComposerId,
    setMeasurements,
    setSelected,
    setSelectedEdges,
    setTextWindowId,
    single,
    textWindowId,
    textWindowNode,
  } = rt;

  useEffect(() => {
    // Deleting the node elsewhere closes its editor instead of editing a ghost.
    if (textWindowId && !textWindowNode) setTextWindowId(null);
  }, [textWindowId, textWindowNode]);
  // Keep the existing generator mounted while manipulating the canvas. Selection
  // can change on pointerdown; it must not mount a different panel mid-gesture.
  useEffect(() => {
    if (!interacting) setComposerNodeId(single?.id ?? null);
  }, [single?.id, interacting]);
  useEffect(() => {
    setExpandedComposerId(null);
  }, [doc.id, composerNode?.id]);
  useEffect(() => {
    const nodeIds = new Set(doc.nodes.map((node) => node.id));
    const edgeIds = new Set(doc.edges.map((edge) => edge.id));
    setMeasurements((current) => {
      const entries = Object.entries(current).filter(([id]) => nodeIds.has(id));
      return entries.length === Object.keys(current).length
        ? current
        : Object.fromEntries(entries);
    });
    setSelected((ids) => {
      const existing = visibleSelectionIds(doc.nodes, ids);
      return existing.length === ids.length &&
        existing.every((id, index) => id === ids[index])
        ? ids
        : existing;
    });
    setSelectedEdges((ids) => {
      const existing = ids.filter((id) => edgeIds.has(id));
      return existing.length === ids.length ? ids : existing;
    });
  }, [doc.nodes, doc.edges]);

}
