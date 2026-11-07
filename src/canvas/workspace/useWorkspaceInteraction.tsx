import { type Connection, type Edge, type NodeChange, type OnConnectEnd } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { errorMessage } from "../../backend/api.ts";

import { CanvasContextMenu } from "../CanvasContextMenu";
import { CanvasIcon } from "../CanvasIcon";
import { canStartReference, connectedCreationKinds, referenceIssueText, referenceMaterial } from "../connectionPolicy";
import { referencePortMetrics } from "../connectionPorts";
import { batchCreationKinds, multiSelectionGeometry, planReferenceBatch, sourceReferencePreviews } from "../selectionReferences";
import { toolProvenanceEdges } from "../generationHistory";
import { absolutePosition, boundsOfNodes } from "../geometry";
import { executeCommand } from "../history";
import { createNode, nextNodeTitle, type CanvasCommand, type CanvasNode, type CanvasNodeData, type CanvasNodeKind, type Point } from "../model";
import { orderNodesForCanvas, stackSelection, updateStack } from "../operations";

import { persistCurrentDocument } from "../projectManagement";
import { referencePresentation } from "../referenceEvidence";
import { projectCanvasStacks } from "../stackProjection";

import { subjectDescriptionLayout } from "../subjectLayout.ts";
import { subjectImportSelection, subjectTargetIdentity } from "../subjectLibraryImport.ts";
import { type SubjectMediaSlot } from "../subjectMedia.ts";
import { authorFlowChanges, canvasKeyAction, canvasSelectAllIds, connectionDragReleased, droppedConnectionTarget, mergeFlowSelection, placeCreatedNode } from "../workspaceInteraction.ts";
import { portPoint, useCanvasReferences } from "../useCanvasReferences";

import { useCanvasWheelBoundary } from "../useCanvasWheelBoundary";
import { useSelectionPresentation } from "../useSelectionPresentation";
import type { WorkspaceRuntime } from "./runtimeTypes.ts";
import { nodeKindKeys } from "./workspaceChrome.tsx";
import type { FlowNode } from "./workspaceChrome.tsx";


export function useWorkspaceInteraction(rt: WorkspaceRuntime) {
  const {
    actionNode,
    activeAction,
    arrivingNodes,
    assistantLayout,
    assistantOpen,
    begin,
    bypassSnapping,
    cancelResultImport,
    center,
    change,
    clipboard,
    closeAction,
    command,
    composerElement,
    composerNode,
    connectionStarted,
    copy,
    cut,
    dismissedComposer,
    doc,
    dragging,
    editing,
    end,
    expandedComposerId,
    flow,
    flowSurface,
    focusSelection,
    generationByNode,
    group,
    hand,
    help,
    historyRef,
    hoveredNode,
    interacting,
    jobs,
    lockedIds,
    measurements,
    menu,
    notify,
    openEditor,
    openFilePicker,
    panel,
    panning,
    paste,
    persist,
    pointerGesture,
    presentationFocus,
    preview,
    ready,
    referenceTarget,
    removeSelected,
    rename,
    replayHistory,
    revealCreatedNodes,
    root,
    saveError,
    selected,
    selectedEdges,
    selectedRef,
    selectionAtPointerDown,
    setAssistantSelectionRequest,
    setDismissedComposer,
    setEditing,
    setHand,
    setHelp,
    setHistory,
    setInteracting,
    setMeasurements,
    setMenu,
    setPanel,
    setPreview,
    setRename,
    setSelected,
    setSelectedEdges,
    setSubjectImport,
    setTextEditingId,
    setToolRevision,
    setVersionHistory,
    setZoomMenu,
    settingsOpen,
    showEdges,
    single,
    snapshotModel,
    spacePressed,
    switchPending,
    switching,
    t,
    textEditingId,
    toolbarElement,
    ungroup,
    versionCounts,
    versionHistory,
    viewportMoving,
    zoom,
  } = rt;

  const clearGuides = useCallback(() => {
    flowSurface.current?.clearGuides();
  }, []);
  const beginDrag = () => {
    selectionPresentation.userNavigation();
    dragging.current = true;
    setInteracting(true);
    setMenu(null);
  };
  const endDrag = useCallback(() => {
    dragging.current = false;
    setInteracting(false);
    clearGuides();
  }, [clearGuides]);
  const cancelDrag = useCallback(() => {
    if (pointerGesture.current.active)
      setSelected(selectionAtPointerDown.current);
    pointerGesture.current.cancel();
    flowSurface.current?.cancel();
    connectionStarted.current = null;
    dragging.current = false;
    setInteracting(false);
    clearGuides();
  }, [clearGuides]);
  useEffect(() => {
    const move = (event: PointerEvent) =>
      pointerGesture.current.move(
        event.pointerId,
        event.clientX,
        event.clientY,
      );
    const up = (event: PointerEvent) => {
      pointerGesture.current.end(event.pointerId, event.clientX, event.clientY);
      setInteracting(false);
    };
    const blur = () => {
      bypassSnapping.current = false;
      cancelDrag();
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", blur);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", blur);
      window.removeEventListener("blur", blur);
    };
  }, [cancelDrag]);
  const addNode = (
    kind: CanvasNodeKind,
    position?: Point,
    extra: Partial<CanvasNodeData> = {},
  ) => {
    const connected = position ? menu?.connected : undefined;
    const sourceIds =
      connected?.direction === "source"
        ? (connected.ids ?? [connected.id])
        : [];
    const current = historyRef.current.present;
    if (
      sourceIds.some((id) => {
        const source = current.nodes.find((node) => node.id === id);
        return (
          source && canStartReference(source) && !referenceMaterial(source)
        );
      })
    ) {
      setMenu(null);
      notify(referenceIssueText("source_empty"));
      return;
    }
    if (
      connected &&
      !(
        sourceIds.length > 1
          ? batchCreationKinds(current, sourceIds, [kind])
          : connectedCreationKinds(current, connected.id, connected.direction, [
              kind,
            ])
      ).length
    ) {
      setMenu(null);
      notify(t("canvas.workspace.error.referenceKindUnsupported"));
      return;
    }
    const where = position ?? center();
    const node = createNode(kind, where, {
      ...snapshotModel(kind),
      title: nextNodeTitle(current, kind, t(nodeKindKeys[kind])),
      ...(sourceIds.length > 1 && kind === "video"
        ? { settings: { videoMode: "reference" as const } }
        : {}),
      ...extra,
    });
    if (kind === "timeline") node.width = 720;
    const parent = menu?.parentId
      ? current.nodes.find((candidate) => candidate.id === menu.parentId)
      : undefined;
    // The dropped endpoint becomes the new node's input/output port.
    const placed = placeCreatedNode(
      node,
      where,
      connected,
      parent
        ? { id: parent.id, origin: absolutePosition(parent, current.nodes) }
        : undefined,
    );
    node.position = placed.position;
    if (placed.parentId) node.parentId = placed.parentId;
    const commands: CanvasCommand[] = [
      {
        type: "add-nodes",
        nodes: [node],
        ...(extra.title === undefined
          ? { titlePrefix: t(nodeKindKeys[kind]) }
          : {}),
      },
    ];
    if (sourceIds.length > 1) {
      const plan = planReferenceBatch(
        { ...current, nodes: [...current.nodes, node] },
        sourceIds,
        node.id,
      );
      if (plan.issue) {
        notify(referenceIssueText(plan.issue.code));
        setMenu(null);
        return;
      }
      commands.push(
        ...plan.edges.map(
          (edge): CanvasCommand => ({ type: "add-edge", edge }),
        ),
      );
    } else if (connected)
      commands.push({
        type: "add-edge",
        edge: {
          id: crypto.randomUUID(),
          source: connected.direction === "source" ? connected.id : node.id,
          target: connected.direction === "source" ? node.id : connected.id,
          sourceHandle: "out",
          targetHandle: "in",
        },
      });
    command({ type: "batch", commands });
    setSelected([node.id]);
    root.current?.focus({ preventScroll: true });
    focusSelection(node.id);
    setDismissedComposer(null);
    referenceTarget.current = null;
    setMenu(null);
    setPanel(null);
    return node;
  };
  const fit = (selection = false) => {
    if (selection && selected.length === 1) {
      selectionPresentation.fitSelection();
      return;
    }
    selectionPresentation.userNavigation();
    const ids = selection ? selected : doc.nodes.map((n) => n.id);
    void flow.fitView({
      nodes: ids.map((id) => ({ id })),
      padding: 0.28,
      maxZoom: 1.5,
      duration: 250,
    });
  };
  const selectAndFocus = (requested: CanvasNode) => {
    if (doc.hiddenNodes?.some((node) => node.id === requested.id)) {
      const restored = [requested];
      let parentId = requested.parentId;
      const visited = new Set([requested.id]);
      while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = doc.hiddenNodes.find((node) => node.id === parentId);
        if (!parent) break;
        restored.unshift(parent);
        parentId = parent.parentId;
      }
      command({ type: "add-nodes", nodes: restored });
    }
    const owner = doc.nodes.find(
      (n) => n.type === "stack" && n.data.stack?.nodeIds.includes(requested.id),
    );
    const node = owner ?? requested;
    if (owner) {
      command({
        type: "update-node",
        id: owner.id,
        patch: {
          data: {
            stack: {
              ...owner.data.stack!,
              activeIndex: owner.data.stack!.nodeIds.indexOf(requested.id),
            },
          },
        },
      });
    }
    setSelected([node.id]);
    setDismissedComposer(null);
    focusSelection(node.id);
  };
  const connect = useCallback(
    (connection: Connection) => {
      setMenu(null);
      if (!connection.source || !connection.target) return;
      command({
        type: "add-edge",
        edge: { ...connection, id: crypto.randomUUID() },
      });
    },
    [command],
  );
  const onConnectEnd: OnConnectEnd = (event, state) => {
    const start = connectionStarted.current;
    connectionStarted.current = null;
    const raw = "changedTouches" in event ? event.changedTouches[0] : event;
    const point = raw ? { x: raw.clientX, y: raw.clientY } : null;
    if (
      !connectionDragReleased({
        spacePressed,
        cancelled: pointerGesture.current.cancelled,
        moved: pointerGesture.current.moved,
        start,
        point,
        isValid: Boolean(state.isValid),
        hasEndpoints: Boolean(state.fromNode && state.fromHandle),
      }) ||
      !point ||
      !state.fromNode ||
      !state.fromHandle
    )
      return;
    const target = document.elementFromPoint(point.x, point.y);
    const targetId = target
      ?.closest(".react-flow__node")
      ?.getAttribute("data-id");
    const group = doc.nodes.find(
      (node) =>
        node.id === targetId &&
        node.type === "group" &&
        !lockedIds.has(node.id),
    );
    const drop = droppedConnectionTarget({
      toNodeId: state.toNode?.id,
      groupId: group?.id,
      onPane: Boolean(target?.classList.contains("react-flow__pane")),
      fromNodeId: state.fromNode.id,
      direction: state.fromHandle.type,
    });
    if (!drop) return;
    setMenu({
      x: point.x,
      y: point.y,
      world: flow.screenToFlowPosition(point),
      connected: { id: drop.id, direction: drop.direction },
      parentId: drop.parentId,
    });
  };
  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      const dimensionChanges = changes.flatMap((c) =>
        c.type === "dimensions" && c.dimensions
          ? [{ id: c.id, dimensions: c.dimensions }]
          : [],
      );
      if (dimensionChanges.length)
        setMeasurements((current) => {
          const next = { ...current };
          let changed = false;
          for (const { id, dimensions } of dimensionChanges) {
            if (
              next[id]?.width === dimensions.width &&
              next[id]?.height === dimensions.height
            )
              continue;
            next[id] = dimensions;
            changed = true;
          }
          return changed ? next : current;
        });
      const selections = changes.flatMap((change) =>
        change.type === "select"
          ? [{ id: change.id, selected: change.selected }]
          : [],
      );
      if (selections.length)
        setSelected((ids) => mergeFlowSelection(ids, selections));
      // XYFlow may still deliver a final move/resize after cancellation.
      // Capture the grab offset immediately, but do not author a move inside
      // click tolerance (or let that jitter snap a node to a nearby guide).
      // A resize owns child-coordinate compensation, including locked children.
      const authored = authorFlowChanges(changes, {
        cancelled: pointerGesture.current.cancelled,
        dragging: dragging.current,
        moved: pointerGesture.current.moved,
      });
      if (authored) command(authored);
    },
    [command, flow],
  );
  const selectionNodes = doc.nodes.filter((node) => selected.includes(node.id));
  const selectionGeometry = multiSelectionGeometry(
    selectionNodes,
    doc.nodes,
    zoom,
  );
  const selectionReferenceReason = selectionNodes.some((node) =>
    lockedIds.has(node.id),
  )
    ? referenceIssueText("locked")
    : selectionNodes.some((node) => !canStartReference(node))
      ? t("canvas.workspace.error.selectionReferenceUnsupported")
      : selectionNodes.some((node) => !referenceMaterial(node))
        ? referenceIssueText("source_empty")
        : "";
  const references = useCanvasReferences({
    nodes: doc.nodes.filter(
      (n) =>
        !doc.nodes.some(
          (s) => s.type === "stack" && s.data.stack?.nodeIds.includes(n.id),
        ),
    ),
    zoom,
    selectionPort:
      selectionGeometry && !selectionReferenceReason
        ? selectionGeometry.port
        : undefined,
    locked: lockedIds,
    disabled:
      spacePressed ||
      switching ||
      !ready ||
      Boolean(editing || preview || activeAction || textEditingId) ||
      dragging.current,
    world: (point) => flow.screenToFlowPosition(point),
    connect: (sources, target) => {
      const current = historyRef.current.present;
      const plan = planReferenceBatch(current, sources, target);
      if (plan.issue) {
        notify(referenceIssueText(plan.issue.code));
        return;
      }
      if (!plan.edges.length) {
        notify(referenceIssueText("duplicate_relation"));
        return;
      }
      command({
        type: "batch",
        commands: plan.edges.map((edge) => ({ type: "add-edge", edge })),
      });
      setSelected([target]);
      setSelectedEdges([]);
      setDismissedComposer(null);
    },
    create: (sources, side, client, world, anchor) => {
      const id = document
        .elementFromPoint(client.x, client.y)
        ?.closest(".react-flow__node")
        ?.getAttribute("data-id");
      const parent = doc.nodes.find(
        (n) => n.id === id && n.type === "group" && !lockedIds.has(n.id),
      );
      setMenu({
        x: client.x + 12,
        y: client.y + 12,
        world,
        connected: {
          id: sources[0],
          ids: sources,
          direction: "source",
          side,
          anchor,
        },
        parentId: parent?.id,
      });
    },
  });
  const clearToolInteraction = useCallback(() => {
    cancelDrag();
    references.cancel();
    setMenu(null);
    setZoomMenu(false);
    end();
    setTextEditingId(null);
    setToolRevision((value) => value + 1);
  }, [cancelDrag, references.cancel, end]);
  const previousTool = useRef({ hand, spacePressed });
  const changeTool = (nextHand: boolean) => {
    clearToolInteraction();
    previousTool.current = { hand: nextHand, spacePressed };
    setHand(nextHand);
    root.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (
      previousTool.current.hand === hand &&
      previousTool.current.spacePressed === spacePressed
    )
      return;
    previousTool.current = { hand, spacePressed };
    clearToolInteraction();
  }, [hand, spacePressed, clearToolInteraction]);
  const selectionControls = Boolean(single && !editing && !preview);
  const hasComposer = Boolean(
    selectionControls &&
    !activeAction &&
    composerNode &&
    single?.id === composerNode.id &&
    ["text", "image", "video", "audio"].includes(composerNode.type) &&
    (composerNode.type === "text" || composerNode.data.mediaRole !== "asset") &&
    composerNode.id !== dismissedComposer &&
    !lockedIds.has(composerNode.id),
  );
  const composerExpanded =
    hasComposer && expandedComposerId === composerNode?.id;
  useEffect(() => {
    if (!composerExpanded) return;
    // Only an explicit expansion moves keyboard focus into the generator.
    const frame = requestAnimationFrame(() =>
      composerElement.current
        ?.querySelector<HTMLElement>('[contenteditable="true"],textarea')
        ?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [composerExpanded, composerNode?.id]);
  const composerRunning = Boolean(
    composerNode && generationByNode.has(composerNode.id),
  );
  const hasToolbar = Boolean(
    selectionControls &&
    !activeAction &&
    single &&
    (!["image", "video", "audio", "file"].includes(single.type) ||
      (single.data.src && single.data.assetState !== "missing")),
  );
  const mediaBounds = single
    ? {
        ...absolutePosition(single, doc.nodes),
        width: single.width,
        height: single.height,
      }
    : null;
  const actionParameters =
    actionNode?.data.taskDraft?.tool === activeAction?.tool
      ? actionNode?.data.taskDraft?.parameters
      : undefined;
  const expansion = (key: string) =>
    typeof actionParameters?.[key] === "number"
      ? Math.max(0, Math.min(4, actionParameters[key] as number))
      : 0.25;
  const presentationBounds =
    activeAction?.tool === "outpaint" && mediaBounds
      ? {
          x: mediaBounds.x - mediaBounds.width * expansion("left"),
          y: mediaBounds.y - mediaBounds.height * expansion("top"),
          width:
            mediaBounds.width * (1 + expansion("left") + expansion("right")),
          height:
            mediaBounds.height * (1 + expansion("top") + expansion("bottom")),
        }
      : mediaBounds;
  const selectionPresentation = useSelectionPresentation({
    root,
    toolbar: toolbarElement,
    composer: composerElement,
    // Generators are screen-space UI, like the toolbar and sidebar. Only their
    // anchor follows the selected node when the canvas zooms.
    scaleComposer: false,
    bounds: presentationBounds,
    mediaBounds,
    preferredZoom: activeAction ? 1.5 : undefined,
    nodeId: single?.id,
    panel,
    focusRequest: presentationFocus,
    blocked:
      composerExpanded ||
      interacting ||
      references.connecting ||
      spacePressed ||
      pointerGesture.current.moved ||
      !selectionControls,
    controlsKey: `${assistantOpen}:${assistantLayout.width}:${hasComposer}:${hasToolbar}:${composerExpanded}:${activeAction?.token ?? ""}:${activeAction?.tool === "outpaint" ? JSON.stringify(presentationBounds) : ""}`,
  });
  revealCreatedNodes.current = (nodes, allNodes) => {
    if (switchPending.current || viewportMoving.current || interacting || pointerGesture.current.active ||
        references.connecting || spacePressed || selectedRef.current.length > 1 ||
        editing || preview || activeAction || textEditingId || composerExpanded) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && root.current?.contains(focused) &&
        focused.matches("input,textarea,[contenteditable=true]") && !focused.closest(".cw-assistant-panel")) return;
    const bounds = boundsOfNodes(nodes, allNodes);
    if (bounds) selectionPresentation.reveal(bounds);
  };
  useCanvasWheelBoundary(root, selectionPresentation.userNavigation);
  const flowNodes: FlowNode[] = useMemo(
    () =>
      orderNodesForCanvas(doc.nodes).map((n) => ({
        ...n,
        measured: measurements[n.id],
        selected: selected.includes(n.id),
        draggable:
          !lockedIds.has(n.id) &&
          !spacePressed &&
          activeAction?.nodeId !== n.id,
        connectable:
          !lockedIds.has(n.id) &&
          !spacePressed &&
          activeAction?.nodeId !== n.id,
        style: { width: n.width, height: n.height },
        zIndex: n.type === "group" ? -1 : n.zIndex,
        ariaLabel: t("canvas.workspace.aria.nodeLabel", {
          kind: t(nodeKindKeys[n.type]),
          title: n.data.title,
        }),
      })),
    [
      doc.nodes,
      selected,
      spacePressed,
      measurements,
      lockedIds,
      activeAction?.nodeId,
    ],
  );
  const flowEdges: Edge[] = useMemo(
    () =>
      [...doc.edges, ...toolProvenanceEdges(jobs, doc)]
        .filter(
          (edge) =>
            doc.nodes.some((node) => node.id === edge.source) &&
            doc.nodes.some((node) => node.id === edge.target),
        )
        .map((e) => ({
          ...e,
          type: "reference",
          selected: selectedEdges.includes(e.id),
          hidden: !showEdges,
          selectable: !e.id.startsWith("tool-"),
          data: {
            ...referencePresentation(doc, e),
            sourceBounds: (() => {
              const n = doc.nodes.find((n) => n.id === e.source)!;
              return {
                ...absolutePosition(n, doc.nodes),
                width: n.width,
                height: n.height,
              };
            })(),
            targetBounds: (() => {
              const n = doc.nodes.find((n) => n.id === e.target)!;
              return {
                ...absolutePosition(n, doc.nodes),
                width: n.width,
                height: n.height,
              };
            })(),
            bidirectional:
              e.source !== e.target &&
              doc.edges.some(
                (other) =>
                  other.source === e.target && other.target === e.source,
              ),
          },
          ariaLabel: t("canvas.workspace.aria.referenceEdge"),
        })),
    [doc.edges, doc.nodes, jobs, selectedEdges, showEdges],
  );

  const projected = useMemo(() => {
    const projection = projectCanvasStacks(flowNodes, flowEdges);
    return {
      ...projection,
      edges: projection.edges.map((edge) => {
        const bounds = (id: string) => {
          const node = doc.nodes.find((n) => n.id === id)!;
          return {
            ...absolutePosition(node, doc.nodes),
            width: node.width,
            height: node.height,
          };
        };
        return {
          ...edge,
          data: {
            ...edge.data,
            sourceBounds: bounds(edge.source),
            targetBounds: bounds(edge.target),
            emphasized:
              selectedEdges.includes(edge.id) ||
              (hoveredNode !== null
                ? hoveredNode === edge.source || hoveredNode === edge.target
                : selected.includes(edge.source) ||
                  selected.includes(edge.target)),
          },
        };
      }),
    };
  }, [flowNodes, flowEdges, doc.nodes, selected, selectedEdges, hoveredNode]);
  const stack = () => {
    try {
      const next = stackSelection(
        historyRef.current.present,
        selectedRef.current,
      );
      change(() => next);
      const created = next.nodes.at(-1)!;
      setSelected([created.id]);
      setMenu(null);
    } catch (error) {
      notify(error instanceof Error ? error.message : t("canvas.workspace.toast.stackCreateFailed"));
    }
  };

  const onWorkspaceKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    bypassSnapping.current = event.metaKey || event.ctrlKey;
    if (bypassSnapping.current) clearGuides();
    if (!ready || switchPending.current) return;
    const el = event.target as HTMLElement;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    // Tool shortcuts also work when a canvas menu owns focus, while editors
    // and dialogs keep their text/keyboard input.
    if (
      !mod &&
      !activeAction &&
      !preview &&
      !editing &&
      !settingsOpen &&
      !help &&
      !event.altKey &&
      !event.repeat &&
      (key === "h" || key === "v") &&
      (el === root.current ||
        el.closest(
          ".react-flow,.cw-context-menu,.cw-bottom-controls,.cw-zoom-menu,.cw-selection-bar",
        )) &&
      !el.closest("input,textarea,select,[contenteditable=true],[role=dialog]")
    ) {
      event.preventDefault();
      event.stopPropagation();
      changeTool(key === "h");
      return;
    }
    // These components own their keyboard shortcuts and cancellation lifecycle.
    if (
      el.closest(
        ".cw-composer-dock,.cw-composer-popover,.cw-text-window-backdrop,.cw-node-toolbar-anchor,.cw-domain-dialog,.cw-selection-menu,.cw-action-media-host,.cw-project-selector,.cw-project-dialog,.cw-settings-dialog,.cw-assistant-panel,.cw-context-menu,.cw-node-title-input,.cw-subject-description",
      )
    )
      return;
    if (event.key === "Escape" && el.closest(".cw-rail")) return;
    const editingText = el.closest(
      "input,textarea,select,[contenteditable=true]",
    );
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (activeAction) {
        closeAction();
        return;
      }
      if (textEditingId) {
        end();
        setTextEditingId(null);
        root.current?.focus({ preventScroll: true });
        return;
      }
      const cancellingGesture = pointerGesture.current.active;
      clearGuides();
      cancelDrag();
      references.cancel();
      setSelectedEdges([]);
      setMenu(null);
      setPreview(null);
      setEditing(null);
      cancelResultImport();
      setRename(null);
      setHelp(false);
      setZoomMenu(false);
      if (!editingText && !cancellingGesture) setSelected([]);
      return;
    }
    if (
      editingText ||
      activeAction ||
      rename ||
      preview ||
      editing ||
      help ||
      settingsOpen ||
      el.closest("button,a,video,audio,[role=dialog]") ||
      (el !== root.current && !el.closest(".react-flow"))
    )
      return;
    // Clicking a panel leaves focus on the workspace root, so the target above
    // says nothing about where the text selection lives. A selection outside
    // the flow belongs to the browser: copy, cut, select-all, delete and caret
    // keys must reach it instead of acting on canvas nodes.
    const selected = document.getSelection();
    const anchor = selected?.anchorNode;
    const anchorElement =
      anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
    if (
      selected &&
      !selected.isCollapsed &&
      !anchorElement?.closest(".react-flow")
    )
      return;
    const action = canvasKeyAction({
      key: event.key,
      code: event.code,
      mod,
      shift: event.shiftKey,
      hasClipboard: Boolean(clipboard.current),
      editText: Boolean(
        single?.type === "text" &&
          !lockedIds.has(single.id) &&
          (el === root.current ||
            el.closest(".react-flow__node")?.getAttribute("data-id") ===
              single.id),
      ),
      hasSingle: Boolean(single),
    });
    if (!action) return;
    if (
      action.type !== "add-text" &&
      action.type !== "preview" &&
      action.type !== "help"
    )
      event.preventDefault();
    if (action.type === "edit-text" || action.type === "nudge")
      event.stopPropagation();
    if (action.type === "edit-text") {
      if (single?.type === "text") setTextEditingId(single.id);
    } else if (action.type === "history") replayHistory(action.forward);
    else if (action.type === "select-all")
      setSelected(canvasSelectAllIds(doc.nodes));
    else if (action.type === "copy") copy();
    else if (action.type === "cut") cut();
    else if (action.type === "reorder")
      command({
        type: "reorder-nodes",
        ids: selectedRef.current,
        direction: action.direction,
      });
    else if (action.type === "paste") paste(action.duplicate);
    else if (action.type === "group") {
      if (action.ungroup) ungroup();
      else group();
    } else if (action.type === "save") void persist(doc);
    else if (action.type === "import") openFilePicker();
    else if (action.type === "delete") removeSelected();
    else if (action.type === "fit") fit(action.selection);
    else if (action.type === "add-text") addNode("text");
    else if (action.type === "preview" && single) setPreview(single);
    else if (action.type === "help") setHelp(true);
    else if (action.type === "nudge")
      command({
        type: "move-nodes",
        ids: selectedRef.current,
        delta: action.delta,
      });
  };

  const resizeSubjectDescription = useCallback(
    (id: string, contentHeight: number) => {
      if (!Number.isFinite(contentHeight)) return;
      setHistory((current) => {
        const node = current.present.nodes.find((node) => node.id === id);
        if (node?.type !== "subject") return current;
        const { nodeHeight } = subjectDescriptionLayout(
          contentHeight,
          node.data.subject?.main,
          node.width,
        );
        if (node.height === nodeHeight) return current;
        const present = executeCommand(current, {
          type: "update-node",
          id,
          patch: { height: nodeHeight },
        }).present;
        return present === current.present ? current : { ...current, present };
      });
    },
    [],
  );

  const actions = {
    resizeSubjectDescription,
    removeReference: (id: string) => {
      if (id.startsWith("tool-")) return;
      root.current?.focus({ preventScroll: true });
      command({ type: "remove-edges", ids: [id] });
      setSelectedEdges((ids) => ids.filter((selected) => selected !== id));
    },
    referenceTargetState: (id: string): "valid" | "invalid" | null => {
      if (
        !references.connecting ||
        references.targetId !== id ||
        !references.sourceIds.length
      )
        return null;
      return planReferenceBatch(doc, references.sourceIds, id).issue
        ? "invalid"
        : "valid";
    },
    pickSubject: (
      id: string,
      source: "file" | "canvas" | "assets" | "import",
      slot?: SubjectMediaSlot,
    ) => {
      if (lockedIds.has(id)) return;
      if (source === "file") {
        openFilePicker(id, slot ?? "main");
        return;
      }
      referenceTarget.current = null;

      void (async () => {
        if (
          !(await persistCurrentDocument(
            () => historyRef.current.present,
            persist,
          ))
        )
          throw new Error(t("canvas.workspace.error.saveFirst"));
        const current = historyRef.current.present;
        const { node, issue } = subjectImportSelection(current, [id]);
        if (issue || !node) throw new Error(issue || t("canvas.workspace.error.subjectRemoved"));
        setSelected([id]);
        setSubjectImport({
          projectId: current.id,
          nodeId: id,
          slot: slot ?? "main",
          tab:
            source === "import"
              ? "subjects"
              : source === "canvas"
                ? "canvas"
                : "assets",
          identity: subjectTargetIdentity(node),
        });
      })().catch((error) => notify(errorMessage(error)));
    },
    reopenComposer: (id: string, event: React.MouseEvent) => {
      if (
        dismissedComposer !== id ||
        panning ||
        pointerGesture.current.blocksClick(event.detail) ||
        event.shiftKey ||
        event.metaKey ||
        event.ctrlKey
      )
        return;
      setDismissedComposer(null);
    },
    select: (id: string, event: React.MouseEvent) => {
      if (pointerGesture.current.blocksClick(event.detail)) return;
      if (assistantOpen) setAssistantSelectionRequest((n) => n + 1);
      setMenu(null);
      setDismissedComposer(null);
      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        const ids = new Set(selectionAtPointerDown.current);
        if (ids.has(id)) ids.delete(id);
        else ids.add(id);
        setSelected([...ids]);
      } else {
        setSelected([id]);
        focusSelection(id);
      }
    },
    update: (id: string, data: Partial<CanvasNodeData>) =>
      command({ type: "update-node", id, patch: { data } }),
    nameEdit: rename,
    changeNameDraft: (value: string) =>
      setRename((current) => (current ? { ...current, value } : null)),
    finishNameEdit: (save: boolean) => {
      if (!rename) return;
      const node = historyRef.current.present.nodes.find(
        (n) => n.id === rename.id,
      );
      const title = rename.value.trim();
      if (
        save &&
        node &&
        title &&
        title !== node.data.title &&
        !lockedIds.has(node.id)
      )
        command({
          type: "update-node",
          id: node.id,
          patch: { data: { title } },
        });
      setRename(null);
    },
    rename: (id: string) => {
      const n = doc.nodes.find((n) => n.id === id);
      if (lockedIds.has(id)) notify(t("canvas.workspace.toast.unlockFirst"));
      else if (n) setRename({ id, value: n.data.title });
    },
    versionCount: (id: string) => versionCounts[id] ?? 0,
    versionsOpen: (id: string) => versionHistory?.itemId === id,
    showVersions: (id: string, anchor: DOMRect) => {
      const preparation = (async () => {
        // Let focused text fields commit their blur before flushing the canvas.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        if (
          !(await persistCurrentDocument(
            () => historyRef.current.present,
            (snapshot) => persist(snapshot, false),
          ))
        )
          throw new Error(
            saveError.current || t("canvas.workspace.error.versionSaveFailed"),
          );
        if (historyRef.current.present.id !== doc.id)
          throw new Error(t("canvas.workspace.error.projectSwitchedCurrent"));
      })();
      // The dialog owns the error state. Also handle dismissal before it mounts.
      void preparation.catch(() => {});
      setVersionHistory({ projectId: doc.id, itemId: id, anchor, preparation });
    },
    upload: (id: string) => openFilePicker(id),
    preview: (id: string) => {
      const node = doc.nodes.find((node) => node.id === id);
      if (node) setPreview(node);
    },
    newConnected: (id: string, direction: "source" | "target") => {
      const n = doc.nodes.find((n) => n.id === id);
      if (
        !n ||
        lockedIds.has(id) ||
        (direction === "source" && !canStartReference(n))
      )
        return;
      const p = absolutePosition(n, doc.nodes);
      const world = {
        x: p.x + (direction === "source" ? n.width + 140 : -140),
        y: p.y + n.height / 2,
      };
      const screen = flow.flowToScreenPosition(world);
      setMenu({
        x: Math.min(screen.x, window.innerWidth - 232),
        y: Math.min(screen.y, window.innerHeight - 330),
        world,
        connected: { id, direction },
      });
    },
    contextMenu: (id: string, event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (
        spacePressed ||
        pointerGesture.current.moved ||
        pointerGesture.current.cancelled
      ) {
        setMenu(null);
        return;
      }
      if (!selected.includes(id)) setSelected([id]);
      setMenu({
        x: event.clientX,
        y: event.clientY,
        world: flow.screenToFlowPosition({
          x: event.clientX,
          y: event.clientY,
        }),
        nodeId: id,
      });
    },
    edit: (id: string) => {
      const node = doc.nodes.find((node) => node.id === id);
      if (node) openEditor(node);
    },
    isLocked: (id: string) => lockedIds.has(id),
    getNode: (id: string) => doc.nodes.find((node) => node.id === id),
    generationActivity: (id: string) => generationByNode.get(id),
    isArriving: (id: string) => arrivingNodes.has(id),
    cycleStack: (id: string, delta: number) => {
      const node = doc.nodes.find((node) => node.id === id),
        stack = node?.data.stack;
      if (!node || !stack?.nodeIds.length) return;
      try {
        const next = updateStack(historyRef.current.present, id, {
          ...stack,
          activeIndex:
            (stack.activeIndex + delta + stack.nodeIds.length) %
            stack.nodeIds.length,
        });
        change(() => next);
      } catch (error) {
        notify(error instanceof Error ? error.message : t("canvas.workspace.toast.stackSwitchFailed"));
      }
    },
    metadata: (id: string, media: NonNullable<CanvasNodeData["media"]>) => {
      const node = historyRef.current.present.nodes.find(
        (node) => node.id === id,
      );
      if (!node) return;
      const actual = Object.fromEntries(
        Object.entries(media).filter(
          ([key, value]) =>
            typeof value === "number" &&
            Number.isFinite(value) &&
            value > 0 &&
            // Container duration can differ between browser and server probes.
            // Registered media uses the server's time bounds for retained clips.
            !(
              key === "durationSeconds" &&
              node.data.backendAssetId &&
              node.data.media?.durationSeconds !== undefined
            ),
        ),
      );
      const nextMedia = { ...node.data.media, ...actual };
      if (
        Object.entries(actual).every(
          ([key, value]) =>
            node.data.media?.[
              key as keyof NonNullable<CanvasNodeData["media"]>
            ] === value,
        )
      )
        return;
      // Decoded dimensions are derived facts; filling them must not consume the user's undo step.
      setHistory((current) => ({
        ...current,
        present: executeCommand(current, {
          type: "update-node",
          id,
          patch: {
            data: { media: nextMedia },
            ...(node.data.media?.width && node.data.media.height
              ? { width: node.width, height: node.height }
              : {}),
          },
        }).present,
      }));
    },
    beginEdit: begin,
    endEdit: end,
    isTextEditing: (id: string) => textEditingId === id,
    finishTextEdit: () => {
      // Autosave is suspended while the transaction is open, so the finished
      // edit is written here instead of on a timer.
      end();
      setTextEditingId(null);
      void persist(historyRef.current.present);
    },
  };
  const contextItems = (children: ReactNode) => (
    <CanvasContextMenu
      x={menu!.x}
      y={menu!.y}
      className={menu?.connected ? "cw-canvas-menu" : undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setMenu(null);
          return;
        }
        if (!menu?.connected) return;
        if (["ArrowDown", "ArrowUp"].includes(event.key)) {
          event.preventDefault();
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              'button:not(:disabled):not([aria-disabled="true"])',
            ),
          ];
          const index = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          buttons[
            (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
              buttons.length
          ]?.focus();
        }
      }}
    >
      {children}
    </CanvasContextMenu>
  );
  const menuButton = (
    text: string,
    icon: string,
    action: () => void,
    shortcut?: string,
  ) => (
    <button
      role="menuitem"
      onClick={() => {
        action();
        setMenu(null);
      }}
    >
      <CanvasIcon name={icon} size={16} />
      <span>{text}</span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );
  const portMetrics = referencePortMetrics(zoom);
  const pendingSource =
    menu?.connected && doc.nodes.find((node) => node.id === menu.connected!.id);
  const pendingConnection =
    pendingSource && menu?.connected
      ? {
          from:
            menu.connected.anchor ??
            portPoint(
              {
                ...absolutePosition(pendingSource, doc.nodes),
                width: pendingSource.width,
                height: pendingSource.height,
              },
              menu.connected.side ??
                (menu.connected.direction === "source" ? "right" : "left"),
            ),
          to: menu.world,
          direction: menu.connected.direction,
          side: menu.connected.side,
        }
      : undefined;
  const pendingBatchPreviews =
    menu?.connected?.ids && menu.connected.ids.length > 1
      ? sourceReferencePreviews(
          doc.nodes,
          menu.connected.ids,
          menu.world,
          menu.connected.side,
        )
      : [];
  const referencePreviews = references.previews.length
    ? references.previews
    : pendingBatchPreviews;
  rt.clearGuides = clearGuides;
  rt.beginDrag = beginDrag;
  rt.endDrag = endDrag;
  rt.cancelDrag = cancelDrag;
  rt.addNode = addNode;
  rt.fit = fit;
  rt.selectAndFocus = selectAndFocus;
  rt.connect = connect;
  rt.onConnectEnd = onConnectEnd;
  rt.onNodesChange = onNodesChange;
  rt.selectionNodes = selectionNodes;
  rt.selectionGeometry = selectionGeometry;
  rt.selectionReferenceReason = selectionReferenceReason;
  rt.references = references;
  rt.clearToolInteraction = clearToolInteraction;
  rt.previousTool = previousTool;
  rt.changeTool = changeTool;
  rt.selectionControls = selectionControls;
  rt.hasComposer = hasComposer;
  rt.composerExpanded = composerExpanded;
  rt.composerRunning = composerRunning;
  rt.hasToolbar = hasToolbar;
  rt.mediaBounds = mediaBounds;
  rt.actionParameters = actionParameters;
  rt.expansion = expansion;
  rt.presentationBounds = presentationBounds;
  rt.selectionPresentation = selectionPresentation;
  rt.flowNodes = flowNodes;
  rt.flowEdges = flowEdges;
  rt.projected = projected;
  rt.stack = stack;
  rt.onWorkspaceKey = onWorkspaceKey;
  rt.resizeSubjectDescription = resizeSubjectDescription;
  rt.actions = actions;
  rt.contextItems = contextItems;
  rt.menuButton = menuButton;
  rt.portMetrics = portMetrics;
  rt.pendingSource = pendingSource;
  rt.pendingConnection = pendingConnection;
  rt.pendingBatchPreviews = pendingBatchPreviews;
  rt.referencePreviews = referencePreviews;
}
