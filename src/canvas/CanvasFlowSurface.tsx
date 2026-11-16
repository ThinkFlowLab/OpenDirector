import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
  type RefObject,
} from "react";
import {
  ReactFlow,
  useReactFlow,
  useStoreApi,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type ReactFlowProps,
} from "@xyflow/react";
import type { CanvasFlowNode } from "./CanvasNodeView";
import type { CanvasNode, Point } from "./model.ts";
import type { CanvasPointerGesture } from "./pointerGesture.ts";
import {
  prepareNodeSnapping,
  type NodePosition,
  type SnapGuide,
} from "./snapping.ts";
import { prepareDragGeometry } from "./dragGeometry.ts";
import { CanvasInteractionOverlay } from "./CanvasConnections";
import {
  edgesInSelectionRect,
  type EdgeSelectionCache,
} from "./edgeSelection.ts";

export interface CanvasFlowSurfaceHandle {
  cancel: () => void;
  clearGuides: () => void;
}
type Props = ReactFlowProps<CanvasFlowNode, Edge> & {
  nodes: CanvasFlowNode[];
  edges: Edge[];
  documentNodes: CanvasNode[];
  gesture: RefObject<CanvasPointerGesture>;
  bypassSnapping: RefObject<boolean>;
  ref: Ref<CanvasFlowSurfaceHandle>;
};
type Preview = { positions: NodePosition[]; guides: SnapGuide[] };
const empty = (): Preview => ({ positions: [], guides: [] });

/** Drag frames stay in the flow view. The document receives one final edit. */
export function CanvasFlowSurface({
  documentNodes,
  gesture,
  bypassSnapping,
  ref,
  ...props
}: Props) {
  const flow = useReactFlow();
  const store = useStoreApi();
  const cancellingNativeSelection = useRef(false);
  const latest = useRef({ documentNodes, gesture, bypassSnapping, props });
  latest.current = { documentNodes, gesture, bypassSnapping, props };
  const marquee = useRef<{
    ids: Set<string>;
    cache: EdgeSelectionCache;
  } | null>(null);
  useEffect(
    () =>
      store.subscribe((state, previous) => {
        const active = marquee.current;
        if (
          !active ||
          !state.userSelectionActive ||
          !state.userSelectionRect ||
          (state.userSelectionRect === previous.userSelectionRect &&
            state.transform === previous.transform) ||
          !state.domNode
        )
          return;
        const selectable = new Set(
          latest.current.props.edges
            .filter((edge) => edge.selectable !== false && !edge.hidden)
            .map((edge) => edge.id),
        );
        const ids = edgesInSelectionRect(
          state.domNode,
          state.userSelectionRect,
          selectable,
          active.cache,
        );
        const changes: EdgeChange[] = [];
        for (const id of active.ids)
          if (!ids.has(id))
            changes.push({ type: "select", id, selected: false });
        for (const id of ids)
          if (!active.ids.has(id))
            changes.push({ type: "select", id, selected: true });
        active.ids = ids;
        if (changes.length) latest.current.props.onEdgesChange?.(changes);
      }),
    [store],
  );
  const [resizing, setResizing] = useState<{ id: string; width: number; height: number } | null>(null);
  const [preview, setPreview] = useState<Preview>(empty);
  const frame = useRef<number | null>(null);
  const session = useRef<{
    raw: Map<string, Point>;
    basis: CanvasNode[] | null;
    snap: ReturnType<typeof prepareNodeSnapping> | null;
    size: number;
    guides: SnapGuide[];
  } | null>(null);
  const stopFrame = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };
  function cancel() {
    if (cancellingNativeSelection.current) return;
    marquee.current = null;
    stopFrame();
    session.current = null;
    setResizing(null);
    setPreview(empty());
    const state = store.getState();
    if (state.userSelectionRect || state.userSelectionActive) {
      const pane =
        state.domNode?.querySelector<HTMLElement>(".react-flow__pane");
      const pointerId = latest.current.gesture.current.pointerId;
      cancellingNativeSelection.current = true;
      try {
        // Stop the pane's native marquee/autopan lifecycle before clearing its UI.
        if (pointerId !== null && pane?.hasPointerCapture(pointerId))
          pane.dispatchEvent(
            new PointerEvent("pointercancel", {
              bubbles: true,
              pointerId,
              button: 0,
            }),
          );
        store.setState({
          userSelectionActive: false,
          userSelectionRect: null,
          nodesSelectionActive: false,
        });
      } finally {
        cancellingNativeSelection.current = false;
      }
    }
  }
  function sample(): Preview | null {
    const active = session.current,
      current = latest.current;
    if (
      !active ||
      current.gesture.current.cancelled ||
      !current.gesture.current.moved
    )
      return null;
    if (
      !active.snap ||
      active.basis !== current.documentNodes ||
      active.size !== active.raw.size
    ) {
      active.snap = prepareNodeSnapping(current.documentNodes, [
        ...active.raw.keys(),
      ]);
      active.basis = current.documentNodes;
      active.size = active.raw.size;
    }
    const result = active.snap(
      [...active.raw].map(([id, position]) => ({ id, position })),
      {
        zoom: flow.getZoom(),
        objects: true,
        grid: false,
        bypass: current.bypassSnapping.current,
        previous: active.guides,
      },
    );
    active.guides = result.guides;
    return result;
  }
  function start() {
    if (!session.current)
      session.current = {
        raw: new Map(),
        basis: null,
        snap: null,
        size: 0,
        guides: [],
      };
  }
  function finish() {
    stopFrame();
    const result = sample();
    session.current = null;
    if (result?.positions.length)
      latest.current.props.onNodesChange?.(
        result.positions.map(({ id, position }) => ({
          id,
          type: "position",
          position,
          dragging: false,
        })),
      );
    setPreview(empty());
  }
  useImperativeHandle(ref, () => ({
    cancel,
    clearGuides: () => {
      if (session.current) session.current.guides = [];
      setPreview((previous) =>
        previous.guides.length ? { ...previous, guides: [] } : previous,
      );
    },
  }));
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  function changes(changes: NodeChange<CanvasFlowNode>[]) {
    const current = latest.current;
    const resize = changes.find((change) => change.type === "dimensions" && change.resizing !== undefined);
    if (resize?.type === "dimensions" && resize.dimensions &&
      store.getState().nodeLookup.get(resize.id)?.type === "text") {
      if (current.gesture.current.cancelled) return;
      if (resize.resizing) {
        setResizing({ id: resize.id, ...resize.dimensions });
      } else {
        setResizing(null);
        current.props.onNodesChange?.([{ ...resize, setAttributes: true }]);
      }
      return;
    }
    const ordinary: NodeChange<CanvasFlowNode>[] = [];
    let moved = false;
    for (const change of changes) {
      if (change.type === "position" && session.current) {
        if (change.position && !current.gesture.current.cancelled) {
          session.current.raw.set(change.id, change.position);
          moved = true;
        }
      } else ordinary.push(change);
    }
    if (ordinary.length) current.props.onNodesChange?.(ordinary);
    if (moved && frame.current === null)
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        const result = sample();
        if (result) setPreview(result);
      });
  }
  const boundsForDrag = useMemo(
    () => prepareDragGeometry(documentNodes),
    [documentNodes],
  );
  const projected = useMemo(() => {
    if (!preview.positions.length)
      return { nodes: props.nodes, edges: props.edges };
    const moved = new Map(
      preview.positions.map((item) => [item.id, item.position]),
    );
    const bounds = boundsForDrag(preview.positions);
    return {
      nodes: props.nodes.map((node) =>
        moved.has(node.id)
          ? { ...node, position: moved.get(node.id)!, dragging: true }
          : node,
      ),
      edges: props.edges.map((edge) => {
        const sourceBounds = bounds.get(edge.source),
          targetBounds = bounds.get(edge.target);
        return sourceBounds || targetBounds
          ? {
              ...edge,
              data: {
                ...edge.data,
                ...(sourceBounds && { sourceBounds }),
                ...(targetBounds && { targetBounds }),
              },
            }
          : edge;
      }),
    };
  }, [props.nodes, props.edges, boundsForDrag, preview.positions]);
  return (
    <ReactFlow<CanvasFlowNode, Edge>
      {...props}
      nodes={resizing ? projected.nodes.map((node) => node.id === resizing.id ? {
        ...node, width: resizing.width, height: resizing.height,
        style: { ...node.style, width: resizing.width, height: resizing.height },
      } : node) : projected.nodes}
      edges={projected.edges}
      onNodesChange={changes}
      onEdgesChange={(changes) => {
        // ReactFlow's marquee selects edges by their nodes; use curve hits instead.
        const forwarded = marquee.current
          ? changes.filter((change) => change.type !== "select")
          : changes;
        if (forwarded.length) latest.current.props.onEdgesChange?.(forwarded);
      }}
      onSelectionStart={(event) => {
        marquee.current = { ids: new Set(), cache: new WeakMap() };
        latest.current.props.onSelectionStart?.(event);
      }}
      onSelectionEnd={(event) => {
        marquee.current = null;
        latest.current.props.onSelectionEnd?.(event);
      }}
      onNodeDragStart={(...args) => {
        start();
        latest.current.props.onNodeDragStart?.(...args);
      }}
      onSelectionDragStart={(...args) => {
        start();
        latest.current.props.onSelectionDragStart?.(...args);
      }}
      onNodeDragStop={(...args) => {
        finish();
        latest.current.props.onNodeDragStop?.(...args);
      }}
      onSelectionDragStop={(...args) => {
        finish();
        latest.current.props.onSelectionDragStop?.(...args);
      }}
    >
      {props.children}
      {!!preview.guides.length && (
        <CanvasInteractionOverlay guides={preview.guides} />
      )}
    </ReactFlow>
  );
}
