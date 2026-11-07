import { Background, BackgroundVariant, MiniMap, SelectionMode, ViewportPortal } from "@xyflow/react";

import "@xyflow/react/dist/style.css";
import { Suspense, type CSSProperties } from "react";
import { NodeVersionHistory } from "../NodeVersionHistory";

import openDirectorLogoAnimation from "../../assets/open_director_logo_anim.gif";
import { request as apiRequest, errorMessage } from "../../backend/api.ts";
import { creationClient, objectVersion, visibleItems } from "../../backend/creationClient.ts";

import { previewImageSelection } from "../../backend/imageSelections";
import { MediaPublication } from "../../backend/mediaPublication";
import { timelinePublication } from "../../backend/timelinePublication";
import { acknowledgeToolPlacement, cancelToolTask } from "../../backend/tools.ts";
import { createWorkspaceProject, listWorkspaceProjects, openExampleWorkspaceProject, openWorkspaceProject, saveWorkspaceDocument, workspaceProjection } from "../../backend/workspace";
import { exampleDocument, exampleProjectTitle, studyImage } from "../assets";

import { AssistantPanel } from "../AssistantPanel";
import { CanvasActionsContext } from "../CanvasActionsContext";
import { CanvasConnectionLine, CanvasConnectionPreview, CanvasInteractionOverlay } from "../CanvasConnections";

import { CanvasCreationMenu, CreationMenuContent } from "../CanvasCreationMenu";
import { CanvasFlowSurface } from "../CanvasFlowSurface";

import { CanvasIcon } from "../CanvasIcon";
import { CanvasPlaybackProvider } from "../CanvasMediaPreview";
import { CanvasNotifications } from "../CanvasNotifications";

import { CanvasToolRail } from "../CanvasToolRail";
import { canStartReference, connectedCreationKinds } from "../connectionPolicy";
import { REFERENCE_PORT_ICON_SIZE, REFERENCE_PORT_SIZE, referencePortIcon } from "../connectionPorts";
import { batchCreationKinds, SELECTION_PADDING, SELECTION_PORT_SIZE } from "../selectionReferences";

import "../multi-selection.css";
import "../node-reference-ports.css";
import "../control-theme.css";
import { CreationAssetList } from "../CreationAssetList.tsx";
import { CANVAS_CREATION_TOOLS } from "../creationTools";
import { EditorModal } from "../EditorModal";
import { GenerationHistoryPanel } from "../GenerationHistoryPanel";
import { arrangeNodes } from "../geometry";

import { ImageActionEditor, isImageActionTool } from "../ImageActionEditor";
import { ImageEditor } from "../ImageEditor";
import { AssetLibraryDialog } from "../library/AssetLibraryDialog";
import "../library/library.css";
import { SubjectImportDialog } from "../library/SubjectImportDialog";
import { validateNodeActionSource } from "../linkedResults";

import { LocalImageTools } from "../LocalImageTools";
import { LocalMediaEditor } from "../LocalMediaEditor";
import { canAddReference, MAX_ZOOM, MIN_ZOOM } from "../model";
import { gridSplitImage } from "../nodeActionWorkflow";
import { NodeComposer } from "../NodeComposer";

import { NodeInfoButton } from "../NodeInfoButton";
import { NodeSelectionToolbar } from "../NodeSelectionToolbar";
import { TextNodeWindow } from "../TextNodeWindow";
import { SelectionBarAnchor } from "../SelectionBarAnchor";
import { NodeTaskPanel } from "../NodeTaskPanel";
import { unstackSelection } from "../operations";

import { ProjectSelector } from "../ProjectSelector";
import "../settings.css";
import { dismissModelSetup } from "../ModelSetup";

import { WelcomeScreen } from "../WelcomeScreen";
import { SettingsDialog } from "../SettingsDialog";
import { alignNodes, type Alignment } from "../snapping";
import { StackEditor } from "../StackEditor";
import { subjectImportSelection, subjectTargetIdentity } from "../subjectLibraryImport.ts";

import { TextNodeComposer } from "../TextNodeComposer";
import "../themes.css";
import { TimelineEditor } from "../TimelineEditor";
import { CANVAS_TOOLS, createCanvasToolTask, initialToolParameters } from "../toolCatalog";

import { translateToolText } from "../toolText.ts";
import { ToolEditor } from "../ToolEditor";
import { TooltipButton } from "../TooltipButton";

import { VideoActionEditor } from "../VideoActionEditor";
import { captureVideoEndpoint, extractVideoAudio } from "../videoActionRuntime";
import "../workspace.css";
import type { WorkspaceRuntime } from "./runtimeTypes.ts";
import { DirectorStage, IconButton, helpShortcuts, nodeTypes, edgeTypes, referenceSideKeys, incomingNodes } from "./workspaceChrome.tsx";


export function WorkspaceView({ rt }: { rt: WorkspaceRuntime }) {
  const {
    actionMedia,
    actionNode,
    actions,
    activeAction,
    addLinkedOutputs,
    addNode,
    assetListAnchor,
    assistantLayout,
    assistantOpen,
    assistantSelectionRequest,
    backendCatalog,
    backupLibrarySubject,
    begin,
    beginDrag,
    businessHistory,
    bypassSnapping,
    cancelServiceRuns,
    center,
    change,
    changeTool,
    clipboard,
    closeAction,
    closeEditor,
    command,
    commitEditorData,
    composerElement,
    composerExpanded,
    composerIncoming,
    composerNode,
    composerRunning,
    confirmSubjectImport,
    connect,
    connectionStarted,
    contextItems,
    copy,
    cut,
    deleteProject,
    dismiss,
    doc,
    downloadNode,
    editProjectNameId,
    editing,
    editorMode,
    editorOrigin,
    editorOutputs,
    editorSession,
    end,
    endDrag,
    exportDocument,
    fileInput,
    fit,
    flow,
    flowSurface,
    focusSelection,
    generationReferenceControls,
    group,
    hand,
    hasComposer,
    hasToolbar,
    help,
    historyRef,
    historyReplaying,
    importActionResultFiles,
    importActionResults,
    importCanvasSource,
    importDocument,
    importFiles,
    importInput,
    importLibrarySubjects,
    initializationError,
    insertLibraryItems,
    installDocument,
    interacting,
    jobs,
    libraryOpen,
    liveCanvas,
    locale,
    lockedIds,
    marqueeClick,
    maskTool,
    mediaPublications,
    menu,
    menuButton,
    minimap,
    notifications,
    notify,
    onConnectEnd,
    onNodesChange,
    onWorkspaceKey,
    openEditor,
    openFilePicker,
    openNodeAction,
    pageVisible,
    panel,
    panning,
    paste,
    pendingBatchPreviews,
    pendingConnection,
    persist,
    pointerGesture,
    portMetrics,
    prepareGeneration,
    preview,
    projectRenaming,
    projected,
    readJobs,
    ready,
    referenceEdges,
    referencePreviews,
    referenceTarget,
    references,
    removeSelected,
    renameCurrentProject,
    renameProject,
    replayHistory,
    resources,
    resultInput,
    revealResults,
    root,
    runQuickAction,
    runToolTask,
    saveActionDraft,
    saveStatus,
    saveStatusText,
    selectAndFocus,
    selected,
    selectedEdges,
    selectedNodes,
    selectedRef,
    selectionAtPointerDown,
    selectionGeometry,
    selectionNodes,
    selectionPresentation,
    selectionReferenceReason,
    selectionSource,
    setActionMedia,
    setActionSession,
    setAssistantModels,
    setAssistantOpen,
    setAssistantSelectionRequest,
    setDismissedComposer,
    setEditProjectNameId,
    setExpandedComposerId,
    setHelp,
    setHistory,
    setHoveredNode,
    setInteracting,
    setJobs,
    setLibraryOpen,
    setLocale,
    setMaskTool,
    setMenu,
    setMinimap,
    setPanel,
    setPreview,
    setSaveStatus,
    setSelected,
    setSelectedEdges,
    setSettingsCategory,
    setSettingsOpen,
    setShowEdges,
    setSubjectImport,
    setTextEditingId,
    setTextWindowId,
    setVersionHistory,
    setWelcomeOpen,
    setZoom,
    setZoomMenu,
    settingsCategory,
    settingsOpen,
    showAssistant,
    showEdges,
    single,
    snapshotModel,
    spacePressed,
    stack,
    subjectImport,
    subjectLibraryBusy,
    switchDocument,
    switching,
    syncServiceResults,
    t,
    textWindowNode,
    theme,
    togglePanel,
    toolCatalog,
    toolRevision,
    toolbarElement,
    ungroup,
    uploadTarget,
    versionHistory,
    viewportMoving,
    welcomeOpen,
    zoom,
    zoomMenu,
  } = rt;


  const workspace = (
    <div
      inert={!ready || switching}
      aria-busy={!ready || switching}
      className={`cw-workspace${panning ? " cw-workspace-panning" : ""}${spacePressed ? " cw-workspace-space-panning" : ""}`}
      ref={root}
      data-testid="canvas-workspace"
      data-edge-motion={pageVisible}
      data-assistant-open={assistantOpen}
      data-assistant-resizing={assistantLayout.dragging}
      data-canvas-interacting={interacting}
      style={
        {
          "--assistant-width": `${assistantLayout.width}px`,
          "--assistant-toolbar-offset": `${assistantLayout.toolbarOffset}px`,
          "--assistant-top": assistantLayout.belowHeader ? "78px" : "14px",
          "--cw-selection-padding": `${SELECTION_PADDING / zoom}px`,
        } as CSSProperties
      }
      tabIndex={-1}
      onPointerMove={references.hover}
      onPointerLeave={() => {
        references.hide();
        setHoveredNode(null);
      }}
      onContextMenuCapture={(event) => {
        // React Flow may open our menu from mouseup. Cancel the actual native
        // contextmenu as well, including repeated right clicks on that menu.
        if (
          event.target instanceof Element &&
          !event.target.closest(".cw-node-title-input") &&
          event.target.closest(".react-flow,.cw-context-menu")
        )
          event.preventDefault();
      }}
      onPointerDownCapture={(event) => {
        marqueeClick.current = false;
        selectionAtPointerDown.current = selectedRef.current;
        bypassSnapping.current = event.metaKey || event.ctrlKey;
        const target = event.target as HTMLElement;
        const surface = Boolean(target.closest(".react-flow"));
        if (surface) selectionPresentation.userNavigation();
        pointerGesture.current.begin(
          event.pointerId,
          event.clientX,
          event.clientY,
          surface,
          panning,
        );
        if (
          surface &&
          !target.closest(
            "button,input,textarea,select,video,audio,a,[contenteditable=true],.nodrag:not(.react-flow__handle)",
          )
        )
          setInteracting(true);
      }}
      onClickCapture={(event) => {
        if (pointerGesture.current.blocksClick(event.detail)) {
          event.preventDefault();
          // Let the pane consume the click ending a marquee. Otherwise its
          // selection flag swallows the next edge/button click instead.
          if (!marqueeClick.current) event.stopPropagation();
          marqueeClick.current = false;
        } else if (
          event.detail === 2 &&
          !pointerGesture.current.blocksDoubleClick() &&
          !panning &&
          (event.target as HTMLElement).classList.contains("react-flow__pane")
        ) {
          // In selection mode onPaneClick receives pointerup (detail=0).
          // Read native click count here; the pan/zoom layer can consume dblclick.
          setMenu({
            mode: "create",
            x: event.clientX,
            y: event.clientY,
            world: flow.screenToFlowPosition({
              x: event.clientX,
              y: event.clientY,
            }),
          });
        }
      }}
      onDoubleClickCapture={(event) => {
        const nodeClick = Boolean(
          (event.target as HTMLElement).closest(".react-flow__node"),
        );
        if (
          pointerGesture.current.blocksDoubleClick(nodeClick && !spacePressed)
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDownCapture={onWorkspaceKey}
      onKeyUpCapture={(event) => {
        bypassSnapping.current = event.metaKey || event.ctrlKey;
      }}
      onDragOver={(event) => {
        if ((event.target as HTMLElement).closest("[role=dialog]")) return;
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(event) => {
        if (
          event.defaultPrevented ||
          (event.target as HTMLElement).closest("[role=dialog]")
        )
          return;
        if (event.dataTransfer.files.length) {
          event.preventDefault();
          uploadTarget.current = null;
          void importFiles(
            [...event.dataTransfer.files],
            flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
          );
        }
      }}
    >
      <CanvasPlaybackProvider
        blocked={
          // Dragging a node is intentionally absent here: the video node keeps
          // playing while the node is dragged. Only gestures that move the
          // viewport or open another surface interrupt playback.
          panning ||
          references.connecting ||
          Boolean(
            editing ||
            preview ||
            activeAction ||
            menu ||
            libraryOpen ||
            subjectImport,
          )
        }
      >
        <CanvasActionsContext.Provider value={actions}>
          <CanvasFlowSurface
            ref={flowSurface}
            documentNodes={doc.nodes}
            gesture={pointerGesture}
            bypassSnapping={bypassSnapping}
            proOptions={{ hideAttribution: true }}
            nodes={projected.nodes}
            edges={projected.edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={(changes) => {
              for (const c of changes)
                if (c.type === "select")
                  setSelectedEdges((ids) =>
                    c.selected
                      ? [...new Set([...ids, c.id])]
                      : ids.filter((id) => id !== c.id),
                  );
            }}
            onConnect={connect}
            connectionLineComponent={CanvasConnectionLine}
            onConnectStart={(event) => {
              setMenu(null);
              const point = "touches" in event ? event.touches[0] : event;
              connectionStarted.current = point
                ? { x: point.clientX, y: point.clientY }
                : null;
            }}
            onConnectEnd={onConnectEnd}
            connectOnClick={false}
            elementsSelectable={!spacePressed && !references.connecting}
            nodesDraggable={!spacePressed}
            nodesConnectable={!spacePressed}
            isValidConnection={(c) =>
              !lockedIds.has(c.source) &&
              !lockedIds.has(c.target) &&
              canAddReference(doc, c.source, c.target)
            }
            onEdgeClick={(_, edge) => {
              if (edge.id.startsWith("tool-")) return;
              setSelected([]);
              setMenu(null);
            }}
            onNodeClick={(event, node) => {
              if (
                pointerGesture.current.blocksClick(event.detail) ||
                (event.target as HTMLElement).closest(
                  "button,input,textarea,select,video,audio,a,[contenteditable=true],.nodrag",
                )
              )
                return;
              setMenu(null);
              setSelectedEdges([]);
              setDismissedComposer(null);
              if (assistantOpen) setAssistantSelectionRequest((n) => n + 1);
              // Keep focus on the canvas when selecting a node. Autofocusing
              // the prompt intercepts keyboard shortcuts for selected nodes.
              root.current?.focus({ preventScroll: true });
              // Read modifiers from the gesture itself, including focus changes between clicks.
              if (event.shiftKey || event.metaKey || event.ctrlKey) {
                const ids = new Set(selectionAtPointerDown.current);
                if (ids.has(node.id)) ids.delete(node.id);
                else ids.add(node.id);
                setSelected([...ids]);
                return;
              }
              setSelected([node.id]);
              focusSelection(node.id);
            }}
            onNodeDoubleClick={(event, node) => {
              if (
                spacePressed ||
                (event.target as HTMLElement).closest(
                  "button,input,textarea,select,video,audio,a,[contenteditable=true],.nodrag",
                )
              )
                return;
              setSelected([node.id]);
              if (node.type === "text" && !lockedIds.has(node.id)) {
                setTextEditingId(node.id);
                return;
              }
              focusSelection(node.id);
            }}
            onNodeContextMenu={(event, node) =>
              actions.contextMenu(node.id, event)
            }
            onNodeMouseEnter={(_, node) => setHoveredNode(node.id)}
            onNodeMouseLeave={() => setHoveredNode(null)}
            onNodeDragStart={beginDrag}
            onNodeDragStop={endDrag}
            onSelectionDragStart={beginDrag}
            onSelectionDragStop={endDrag}
            onSelectionEnd={() => {
              marqueeClick.current = true;
              if (assistantOpen) setAssistantSelectionRequest((n) => n + 1);
            }}
            onPaneClick={(event) => {
              if (pointerGesture.current.blocksClick(1)) return;
              root.current?.focus({ preventScroll: true });
              setMenu(null);
              setSelected([]);
              setDismissedComposer(null);
              setSelectedEdges([]);
              setZoomMenu(false);
            }}
            onPaneContextMenu={(event) => {
              event.preventDefault();
              // The pan layer also reports right-button releases over nodes.
              // Let the shared node handler own that menu in either tool mode.
              if ((event.target as Element).closest(".react-flow__node"))
                return;
              if (
                panning ||
                pointerGesture.current.moved ||
                pointerGesture.current.cancelled
              ) {
                setMenu(null);
                return;
              }
              root.current?.focus({ preventScroll: true });
              setMenu({
                x: event.clientX,
                y: event.clientY,
                world: flow.screenToFlowPosition({
                  x: event.clientX,
                  y: event.clientY,
                }),
              });
            }}
            onMoveStart={(event) => {
              if (event) {
                selectionPresentation.userNavigation();
                viewportMoving.current = true;
              }
            }}
            onMove={(event, view) => {
              setZoom(view.zoom);
              if (event) setMenu(null);
            }}
            onMoveEnd={(_, viewport) => {
              viewportMoving.current = false;
              command({ type: "viewport", viewport });
            }}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            nodeDragThreshold={0}
            nodeClickDistance={4}
            selectionMode={SelectionMode.Partial}
            selectionOnDrag={!panning}
            panOnDrag={
              references.connecting ? false : panning ? [0, 1, 2] : [1, 2]
            }
            panOnScroll
            zoomOnScroll={false}
            zoomOnPinch
            zoomActivationKeyCode={["Meta", "Control"]}
            panActivationKeyCode="Space"
            multiSelectionKeyCode={["Meta", "Control", "Shift"]}
            selectionKeyCode="Shift"
            deleteKeyCode={null}
            zoomOnDoubleClick={false}
            colorMode="dark"
            aria-label={t("canvas.workspace.aria.canvas")}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={18 * Math.max(1, 2 ** Math.ceil(Math.log2(0.65 / zoom)))}
              size={Math.max(1, 1 / zoom)}
              color={theme.theme === "dark" ? "#55565d" : "#c7cbd2"}
              bgColor={theme.theme === "dark" ? "#0d0d0d" : "#f7f8fa"}
            />
            <CanvasInteractionOverlay
              guides={[]}
              pending={
                pendingBatchPreviews.length ? undefined : pendingConnection
              }
            />
            <ViewportPortal>
              {selectionGeometry && !interacting && (
                <div
                  className="cw-multi-selection-frame"
                  aria-hidden="true"
                  style={{
                    left: selectionGeometry.frame.x,
                    top: selectionGeometry.frame.y,
                    width: selectionGeometry.frame.width,
                    height: selectionGeometry.frame.height,
                    borderWidth: 1 / zoom,
                    borderRadius: 10 / zoom,
                  }}
                />
              )}
              {referencePreviews.length > 0 && (
                <svg className="cw-interaction-overlay">
                  {referencePreviews.map((preview) => (
                    <g
                      key={preview.sourceId}
                      data-reference-preview-source={preview.sourceId}
                    >
                      <CanvasConnectionPreview
                        path={preview.path}
                        invalid={Boolean(
                          references.targetId &&
                          actions.referenceTargetState(references.targetId) ===
                            "invalid",
                        )}
                      />
                    </g>
                  ))}
                </svg>
              )}
              {selectionGeometry && !interacting && !spacePressed && !menu && (
                <button
                  type="button"
                  className="cw-reference-port cw-selection-reference-port nodrag nopan"
                  aria-label={t("canvas.workspace.aria.batchConnect")}
                  title={
                    selectionReferenceReason ||
                    t("canvas.workspace.aria.batchConnectHint")
                  }
                  disabled={
                    Boolean(selectionReferenceReason) || references.disabled
                  }
                  style={{
                    left:
                      references.selectionPort?.x ?? selectionGeometry.port.x,
                    top:
                      references.selectionPort?.y ?? selectionGeometry.port.y,
                    transform: `translate(-50%, -50%) scale(${1 / zoom})`,
                    opacity: references.connecting ? 0 : undefined,
                  }}
                  onPointerDown={(event) =>
                    references.startSelection(
                      event,
                      selectionNodes.map((node) => node.id),
                      references.selectionPort ?? selectionGeometry.port,
                    )
                  }
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                >
                  <CanvasIcon name="plus" size={SELECTION_PORT_SIZE * 0.6} />
                </button>
              )}
              {selected.length < 2 &&
                !menu &&
                references.ports.map((port) => (
                  <button
                    key={`${port.nodeId}:${port.side}`}
                    type="button"
                    className="cw-reference-port cw-node-reference-port nodrag nopan"
                    aria-label={
                      port.active
                        ? t("canvas.workspace.aria.addDownstream")
                        : t("canvas.workspace.aria.addDownstreamSide", {
                            side: t(referenceSideKeys[port.side]),
                          })
                    }
                    data-reference-source={port.nodeId}
                    data-side={port.side}
                    data-active={port.active}
                    style={{
                      left: port.point.x,
                      top: port.point.y,
                      width: REFERENCE_PORT_SIZE,
                      height: REFERENCE_PORT_SIZE,
                      transform: `translate(-50%, -50%) scale(${portMetrics.scale})`,
                      opacity: references.connecting ? 0 : 1,
                    }}
                    onPointerDown={(event) => references.start(event, port)}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                  >
                    <CanvasIcon
                      name={referencePortIcon(
                        port.side,
                        doc.nodes.find((node) => node.id === port.nodeId)?.data
                          .mediaRole === "asset",
                      )}
                      size={REFERENCE_PORT_ICON_SIZE}
                    />
                  </button>
                ))}
            </ViewportPortal>
          </CanvasFlowSurface>
        </CanvasActionsContext.Provider>
      </CanvasPlaybackProvider>

      {minimap && (
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => (n.type === "text" ? "#8b887f" : "#59656c")}
          maskColor={theme.theme === "dark" ? "#080809bb" : "#f7f8fabb"}
          position="bottom-left"
          style={{ bottom: 66, left: 12 }}
        />
      )}

      {versionHistory?.projectId === doc.id && (
        <NodeVersionHistory
          key={`${doc.id}:${versionHistory.itemId}`}
          projectId={doc.id}
          itemId={versionHistory.itemId}
          anchor={versionHistory.anchor}
          preparation={versionHistory.preparation}
          onClose={() => setVersionHistory(null)}
          onApplied={(referencesChanged) => {
            setVersionHistory(null);
            notify(
              referencesChanged
                ? t("canvas.workspace.toast.versionAppliedReferences")
                : t("canvas.workspace.toast.versionApplied"),
            );
          }}
        />
      )}
      <header className="cw-topbar">
        <div className="cw-project-heading">
          <img
            className="cw-brand"
            src={openDirectorLogoAnimation}
            alt="OpenDirector"
            draggable={false}
          />
          <ProjectSelector
            currentId={doc.id}
            editNameForId={editProjectNameId}
            name={doc.title}
            disabled={!ready || switching || projectRenaming}
            onSelect={(project) =>
              switchDocument(() => openWorkspaceProject(project))
            }
            onCreate={() => {
              const id = crypto.randomUUID();
              void switchDocument(async () => {
                const { projects } = await listWorkspaceProjects();
                const names = new Set(projects.map(project => project.name));
                const base = t("canvas.project.defaultName");
                let name = base;
                for (let suffix = 2; names.has(name); suffix++) name = `${base} ${suffix}`;
                const project = await createWorkspaceProject(name, id);
                const document = await openWorkspaceProject(project);
                await saveWorkspaceDocument(document);
                return document;
              }).then(success => { if (success) setEditProjectNameId(id); });
            }}
            onRename={renameCurrentProject}
            onRenameProject={renameProject}
            onDeleteProject={deleteProject}
          />
          <div
            className="cw-language-toggle"
            role="group"
            aria-label={t("common.language")}
          >
            <button
              type="button"
              className={locale === "zh-CN" ? "is-active" : ""}
              aria-pressed={locale === "zh-CN"}
              onClick={() => setLocale("zh-CN")}
            >
              {t("common.chinese")}
            </button>
            <span aria-hidden="true">|</span>
            <button
              type="button"
              className={locale === "en-US" ? "is-active" : ""}
              aria-pressed={locale === "en-US"}
              onClick={() => setLocale("en-US")}
            >
              {t("common.englishShort")}
            </button>
          </div>
          <NodeInfoButton nodes={doc.nodes} />
          <span className="cw-save-status" title={saveStatusText}>
            <i className={saveStatus.state === "saved" ? "saved" : ""} />
            {saveStatusText}
          </span>
          {saveStatus.state === "failed" && (
            <div className="cw-save-conflict-actions">
              <button onClick={() => void exportDocument()}>
                {t("canvas.workspace.save.exportCopy")}
              </button>
              <button
                onClick={() => {
                  if (
                    !window.confirm(
                      t("canvas.workspace.save.reloadConfirm"),
                    )
                  )
                    return;
                  void workspaceProjection(doc.id)
                    .open()
                    .then((next) => {
                      installDocument(next);
                      setSaveStatus({ state: "saved" });
                    })
                    .catch((error) => notify(errorMessage(error)));
                }}
              >
                {t("canvas.workspace.save.reload")}
              </button>
            </div>
          )}
        </div>
        <div className="cw-top-actions">
          <span ref={assetListAnchor} className="cw-asset-list-anchor">
            <IconButton
              name="search"
              label={t("canvas.workspace.toolbar.assets")}
              tooltipSide="bottom"
              active={panel === "search"}
              onClick={() => {
                void persist(historyRef.current.present, false).then(
                  (saved) => {
                    if (saved) togglePanel("search");
                  },
                );
              }}
            />
          </span>
          <IconButton
            name="history"
            label={t("canvas.workspace.toolbar.history")}
            tooltipSide="bottom"
            active={panel === "history"}
            onClick={() => togglePanel("history")}
          />
          <IconButton
            name="upload"
            label={t("canvas.workspace.toolbar.importCanvas")}
            tooltipSide="bottom"
            onClick={() => importInput.current?.click()}
          />
          <IconButton
            name="download"
            label={t("canvas.workspace.toolbar.exportCanvas")}
            tooltipSide="bottom"
            onClick={exportDocument}
          />
          <input
            ref={importInput}
            type="file"
            accept=".canvas,application/zip"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importDocument(file);
            }}
          />
        </div>
      </header>
      <CanvasToolRail
        holdCollapsed={false}
        items={[
          ...CANVAS_CREATION_TOOLS.map((tool) => ({
            name: tool.kind,
            icon: tool.icon,
            label: t(tool.labelKey),
            actionLabel: tool.unavailable
              ? t(tool.labelKey)
              : t("canvas.rail.add", { label: t(tool.labelKey) }),
            shortcut: tool.kind === "text" ? "T" : undefined,
            unavailable: tool.unavailable,
            onClick: tool.unavailable ? undefined : () => addNode(tool.kind),
          })),
          {
            name: "folder",
            icon: "rail-folder",
            label: t("canvas.rail.assets"),
            preserveCollapsedOnFocusRestore: true,
            separatorBefore: true,
            active: libraryOpen,
            onClick: () => setLibraryOpen(true),
          },
          {
            name: "upload",
            icon: "rail-upload",
            label: t("canvas.rail.upload"),
            preserveCollapsedOnFocusRestore: true,
            actionLabel: t("canvas.rail.uploadLocal"),
            shortcut: navigator.platform.includes("Mac")
              ? "Meta+O"
              : "Control+O",
            onClick: () => openFilePicker(),
          },
        ]}
      />
      {!doc.nodes.length && ready && (
        <div className="cw-empty">
          <div className="cw-aurora" />
          <div className="cw-empty-orb">
            <CanvasIcon name="clapperboard" size={56} />
          </div>
          <h1>{t("canvas.workspace.empty.title")}</h1>
          <p>{t("canvas.workspace.empty.hint")}</p>
          <div>
            <button
              onClick={() => {
                setSettingsCategory("models");
                setSettingsOpen(true);
              }}
            >
              <CanvasIcon name="model" size={15} />
              {t("canvas.workspace.empty.configureModels")}
            </button>
            <button
              onClick={() => {
                void switchDocument(
                  () =>
                    openExampleWorkspaceProject(
                      exampleProjectTitle(locale),
                      () => exampleDocument(locale),
                    ),
                  true,
                );
              }}
            >
              {t("canvas.workspace.empty.example")} <span>↗</span>
            </button>
          </div>
          <small>{t("canvas.workspace.empty.tagline")}</small>
        </div>
      )}
      {!ready && <div className="cw-loading canvas-loading-message"><span className="canvas-loading-spinner" aria-hidden="true" />{t("canvas.workspace.loading.opening")}</div>}

      <div className="cw-bottom-left">
        <div className="cw-settings-control">
          <IconButton
            name="settings"
            label={t("canvas.workspace.toolbar.settings")}
            active={settingsOpen}
            onClick={() => {
              setZoomMenu(false);
              setSettingsCategory("general");
              setSettingsOpen(true);
            }}
          />
        </div>
        <div className="cw-bottom-controls">
          <IconButton
            name={hand ? "hand" : "pointer"}
            label={hand ? t("canvas.workspace.toolbar.selectTool") : t("canvas.workspace.toolbar.handTool")}
            shortcut={hand ? "V" : "H"}
            tooltipDelay={0}
            highlighted
            onClick={() => changeTool(!hand)}
          />
          <IconButton
            name="minimap"
            label={minimap ? t("canvas.workspace.toolbar.hideMinimap") : t("canvas.workspace.toolbar.showMinimap")}
            tooltipDelay={0}
            active={minimap}
            onClick={() => setMinimap(!minimap)}
          />
          <IconButton
            name="connections"
            label={showEdges ? t("canvas.workspace.toolbar.hideEdges") : t("canvas.workspace.toolbar.showEdges")}
            tooltipDelay={0}
            active={showEdges}
            onClick={() => setShowEdges(!showEdges)}
          />
          <span className="cw-vline" />
          <TooltipButton
            className="cw-zoom-button"
            label={t("canvas.workspace.toolbar.zoomOptions")}
            aria-expanded={zoomMenu}
            tooltipDelay={0}
            onClick={() => setZoomMenu(!zoomMenu)}
          >
            {Math.round(zoom * 100)}%<CanvasIcon name="chevron" size={11} />
          </TooltipButton>
        </div>
        <div className="cw-undo-controls">
          <IconButton
            name="undo"
            label={t("canvas.workspace.toolbar.undo")}
            shortcut={navigator.platform.includes("Mac") ? "⌘ Z" : "Ctrl Z"}
            tooltipDelay={0}
            disabled={!businessHistory.undo || historyReplaying}
            onClick={() => replayHistory()}
          />
          <IconButton
            name="redo"
            label={t("canvas.workspace.toolbar.redo")}
            shortcut={
              navigator.platform.includes("Mac") ? "⌘ ⇧ Z" : "Ctrl Shift Z"
            }
            tooltipDelay={0}
            disabled={!businessHistory.redo || historyReplaying}
            onClick={() => replayHistory(true)}
          />
        </div>
      </div>
      {zoomMenu && (
        <div className="cw-zoom-menu cw-menu-popover">
          <div className="cw-zoom-row">
            <IconButton
              name="minus"
              label={t("canvas.workspace.toolbar.zoomOut")}
              onClick={() => {
                selectionPresentation.userNavigation();
                void flow.zoomOut();
              }}
            />
            <input
              aria-label={t("canvas.workspace.toolbar.zoomPercent")}
              type="number"
              min="8"
              max="800"
              value={Math.round(zoom * 100)}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v >= 8 && v <= 800) {
                  selectionPresentation.userNavigation();
                  void flow.zoomTo(v / 100);
                }
              }}
            />
            <span>%</span>
            <IconButton
              name="plus"
              label={t("canvas.workspace.toolbar.zoomIn")}
              onClick={() => {
                selectionPresentation.userNavigation();
                void flow.zoomIn();
              }}
            />
          </div>
          <button
            onClick={() => {
              fit();
              setZoomMenu(false);
            }}
          >
            {t("canvas.workspace.toolbar.fitAll")} <kbd>⇧ 1</kbd>
          </button>
          <button
            onClick={() => {
              fit(true);
              setZoomMenu(false);
            }}
          >
            {t("canvas.workspace.toolbar.fitSelection")} <kbd>⇧ 2</kbd>
          </button>
          {[0.5, 1, 2].map((z) => (
            <button
              key={z}
              onClick={() => {
                selectionPresentation.userNavigation();
                void flow.zoomTo(z);
                setZoomMenu(false);
              }}
            >
              {z * 100}%
            </button>
          ))}
        </div>
      )}
      <div className="cw-bottom-right">
        <IconButton
          name="help"
          label={t("canvas.workspace.toolbar.help")}
          shortcut="?"
          onClick={() => setHelp(true)}
        />
        <button
          className="cw-chat-button"
          aria-controls="canvas-assistant"
          aria-expanded={assistantOpen}
          onClick={() =>
            assistantOpen ? setAssistantOpen(false) : showAssistant()
          }
        >
          <CanvasIcon name="star" size={18} />{t("canvas.workspace.toolbar.chat")}
        </button>
      </div>
      {selectedEdges.length > 0 && selected.length === 0 && (
        <div
          className="cw-selection-bar"
          role="toolbar"
          aria-label={t("canvas.workspace.selection.edgeToolbar")}
        >
          <span>
            {t("canvas.workspace.selection.edgesSelected", {
              count: selectedEdges.length,
            })}
          </span>
          <button
            onClick={() => {
              command({ type: "remove-edges", ids: selectedEdges });
              setSelectedEdges([]);
            }}
          >
            {t("canvas.workspace.selection.disconnectReference")}
          </button>
          <button onClick={() => setSelectedEdges([])}>{t("canvas.workspace.selection.clear")}</button>
        </div>
      )}
      {selected.length > 1 && !interacting && !spacePressed && (
        <SelectionBarAnchor nodes={selectedNodes} allNodes={doc.nodes}>
          <span>
            {t("canvas.workspace.selection.nodesSelected", {
              count: selected.length,
            })}
          </span>
          <select
            aria-label={t("canvas.workspace.selection.align")}
            value=""
            onChange={(event) => {
              const alignment = event.target.value as Alignment;
              if (alignment)
                change((document) => ({
                  ...document,
                  nodes: alignNodes(document.nodes, selected, alignment),
                }));
            }}
          >
            <option value="" disabled>
              {t("canvas.workspace.selection.alignPlaceholder")}
            </option>
            <option value="left">{t("canvas.workspace.selection.alignLeft")}</option>
            <option value="center">{t("canvas.workspace.selection.alignCenter")}</option>
            <option value="right">{t("canvas.workspace.selection.alignRight")}</option>
            <option value="top">{t("canvas.workspace.selection.alignTop")}</option>
            <option value="middle">{t("canvas.workspace.selection.alignMiddle")}</option>
            <option value="bottom">{t("canvas.workspace.selection.alignBottom")}</option>
            <option value="horizontal" disabled={selected.length < 3}>
              {t("canvas.workspace.selection.distributeHorizontal")}
            </option>
            <option value="vertical" disabled={selected.length < 3}>
              {t("canvas.workspace.selection.distributeVertical")}
            </option>
          </select>
          <button onClick={group}>
            <CanvasIcon name="group" size={16} />
            {t("canvas.workspace.selection.group")}
          </button>
          <button onClick={stack}>
            <CanvasIcon name="stack" size={16} />
            {t("canvas.workspace.selection.stack")}
          </button>
          <button
            onClick={() =>
              change((d) => ({
                ...d,
                nodes: arrangeNodes(d.nodes, selected),
              }))
            }
          >
            {t("canvas.workspace.selection.autoArrange")}
          </button>
          <IconButton
            name="copy"
            label={t("canvas.workspace.selection.duplicate")}
            onClick={() => paste(true)}
          />
          <IconButton name="trash" label={t("canvas.workspace.selection.deleteSelected")} onClick={removeSelected} />
        </SelectionBarAnchor>
      )}
      {hasToolbar && single && (
        <div
          ref={toolbarElement}
          className="cw-node-toolbar-anchor"
          style={{
            ...selectionPresentation.placement?.toolbar,
            maxWidth: selectionPresentation.toolbarMaxWidth,
          }}
          data-interacting={
            interacting ||
            references.connecting ||
            spacePressed ||
            !selectionPresentation.visible
          }
          aria-hidden={
            interacting ||
            references.connecting ||
            spacePressed ||
            !selectionPresentation.visible
          }
          inert={
            interacting ||
            references.connecting ||
            spacePressed ||
            !selectionPresentation.visible
          }
        >
          <NodeSelectionToolbar
            key={`${single.id}:${toolRevision}`}
            node={single}
            locked={lockedIds.has(single.id)}
            style={{ maxWidth: selectionPresentation.toolbarMaxWidth }}
            onTool={openNodeAction}
            presets={toolCatalog.capabilities["image-presets"]?.fields
              ?.find((field) => field.key === "preset")?.options
              ?.map((option) => ({ ...option, label: translateToolText(locale, option.label) }))}
            onPreset={(preset) => {
              const models = toolCatalog.capabilities["image-presets"]?.models?.["image.edit"] ?? [];
              const selected = snapshotModel("image").settings?.modelConfigId;
              const model = models.find((item) => item.id === selected) ?? models[0];
              openNodeAction("image-presets", single, {
                preset,
                ...(model ? { imageModelConfigId: model.id } : {}),
              });
            }}
            onCaptureFrame={(position) =>
              void runQuickAction(
                async (source, signal) => [
                  await captureVideoEndpoint(
                    source.src!,
                    single.data.title,
                    position,
                    signal,
                  ),
                ],
                "video-frame-capture",
                { endpoint: position },
              )
            }
            onGridSplit={(rows, columns) =>
              void runQuickAction(
                (source, signal) =>
                  gridSplitImage(source, rows, columns, signal),
                "grid-split",
                { rows, columns },
              )
            }
            onEdit={(mode) => {
              if (single.type === "text") setTextEditingId(single.id);
              else if (single.type === "video") {
                if (mode === "extract-audio")
                  void runQuickAction(
                    async (source, signal) => [
                      await extractVideoAudio(
                        source.src!,
                        single.data.title,
                        undefined,
                        signal,
                      ),
                    ],
                    "extract-audio",
                  );
                else
                  openNodeAction(
                    mode === "frame" ? "video-frame-capture" : "video-trim",
                  );
              } else openEditor(single, mode);
            }}
            onPreview={() => setPreview(single)}
            onDownload={() => downloadNode(single)}
            onAssistant={showAssistant}
            onExpand={
              single.type === "text"
                ? () => setTextWindowId(single.id)
                : undefined
            }
            onDuplicate={() => paste(true)}
          />
        </div>
      )}
      {activeAction && actionNode && (
        <>
          <div
            ref={setActionMedia}
            className="cw-action-media-host"
            style={selectionPresentation.mediaRect ?? undefined}
            data-hidden={
              interacting ||
              references.connecting ||
              spacePressed ||
              !selectionPresentation.visible
            }
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeAction();
              }
              event.stopPropagation();
            }}
          />
          <div
            ref={composerElement}
            className="cw-composer-dock cw-node-action-dock"
            style={{
              ...selectionPresentation.placement?.composer,
              width: selectionPresentation.composerWidth,
              maxHeight: selectionPresentation.composerMaxHeight,
              transform: selectionPresentation.composerTransform,
            }}
            data-interacting={
              interacting ||
              references.connecting ||
              spacePressed ||
              !selectionPresentation.visible
            }
            inert={
              interacting ||
              references.connecting ||
              spacePressed ||
              !selectionPresentation.visible
            }
          >
            {isImageActionTool(activeAction.tool) ? (
              <ImageActionEditor
                key={activeAction.token}
                node={actionNode}
                tool={activeAction.tool}
                draft={actionNode.data.taskDraft}
                mediaContainer={actionMedia}
                onDraftChange={(task) => saveActionDraft(activeAction, task)}
                onImportResults={(task) =>
                  importActionResults(activeAction, task)
                }
                onApply={(outputs, task) =>
                  addLinkedOutputs(activeAction, outputs, task)
                }
                onGenerate={
                  toolCatalog.capabilities[activeAction.tool]?.available
                    ? (task) => void runToolTask(activeAction, task)
                    : undefined
                }
                unavailableReason={
                  toolCatalog.capabilities[activeAction.tool]?.reason
                }
                models={
                  toolCatalog.tools.find(
                    (item) => item.id === activeAction.tool,
                  )?.models["image.edit"]
                }
                selectionUnavailableReason={toolCatalog.selectionPreview.reason}
                onPreviewSelection={
                  toolCatalog.selectionPreview.available && actionNode.data.src
                    ? async (query, signal) => {
                        const src = actionNode.data.src!;
                        const cached = selectionSource.current;
                        const result = await previewImageSelection(
                          {
                            documentId: doc.id,
                            documentTitle: doc.title,
                            source: {
                              kind: "image",
                              title: actionNode.data.title,
                              src,
                            },
                            sourceAssetId:
                              cached?.documentId === doc.id &&
                              cached.nodeId === actionNode.id &&
                              cached.src === src
                                ? cached.assetId
                                : undefined,
                            ...query,
                          },
                          signal,
                        );
                        signal.throwIfAborted();
                        selectionSource.current = {
                          documentId: doc.id,
                          nodeId: actionNode.id,
                          src,
                          assetId: result.sourceAssetId,
                        };
                        return result;
                      }
                    : undefined
                }
                onClose={closeAction}
              />
            ) : actionNode.type === "video" ? (
              <VideoActionEditor
                key={activeAction.token}
                node={actionNode}
                tool={activeAction.tool}
                draft={actionNode.data.taskDraft}
                mediaContainer={actionMedia}
                onDraftChange={(task) => saveActionDraft(activeAction, task)}
                onImportResults={(task) =>
                  importActionResults(activeAction, task)
                }
                onApply={(outputs, task) =>
                  addLinkedOutputs(activeAction, outputs, task)
                }
                onGenerate={
                  toolCatalog.capabilities[activeAction.tool]?.available
                    ? (task) => void runToolTask(activeAction, task)
                    : undefined
                }
                unavailableReason={
                  toolCatalog.capabilities[activeAction.tool]?.reason
                }
                onClose={closeAction}
              />
            ) : (
              <NodeTaskPanel
                key={activeAction.token}
                node={actionNode}
                nodes={doc.nodes}
                tool={activeAction.tool}
                draft={actionNode.data.taskDraft}
                initialParameters={activeAction.parameters}
                onDraftChange={(task) => saveActionDraft(activeAction, task)}
                onImportResults={(task) =>
                  importActionResults(activeAction, task)
                }
                onClose={closeAction}
                onEditSelection={() => {
                  setMaskTool(activeAction.tool);
                  openEditor(actionNode, "mask");
                }}
                capability={toolCatalog.capabilities[activeAction.tool]}
                onGenerate={(task) => void runToolTask(activeAction, task)}
              />
            )}
          </div>
        </>
      )}
      {hasComposer && composerNode && (
        <>
          {composerExpanded && (
            <div
              className="cw-composer-backdrop"
              aria-hidden="true"
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.stopPropagation();
                setExpandedComposerId(null);
              }}
            />
          )}
          <div
            ref={composerElement}
            className="cw-composer-dock"
            data-expandable="true"
            data-expanded={composerExpanded}
            role={composerExpanded ? "dialog" : undefined}
            aria-modal={composerExpanded ? true : undefined}
            aria-label={composerExpanded ? t("canvas.workspace.aria.expandedComposer") : undefined}
            style={
              composerExpanded
                ? undefined
                : {
                    ...selectionPresentation.placement?.composer,
                    width: selectionPresentation.composerWidth,
                    maxHeight: selectionPresentation.composerMaxHeight,
                    transform: selectionPresentation.composerTransform,
                  }
            }
            data-interacting={
              !composerExpanded &&
              (interacting ||
                references.connecting ||
                spacePressed ||
                !selectionPresentation.visible)
            }
            aria-hidden={
              !composerExpanded &&
              (interacting ||
                references.connecting ||
                spacePressed ||
                !selectionPresentation.visible)
            }
            inert={
              !composerExpanded &&
              (interacting ||
                references.connecting ||
                spacePressed ||
                !selectionPresentation.visible)
            }
            onKeyDownCapture={(event) => {
              if (!composerExpanded || event.nativeEvent.isComposing) return;
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setExpandedComposerId(null);
                composerElement.current
                  ?.querySelector<HTMLButtonElement>(".cw-composer-expand")
                  ?.focus({ preventScroll: true });
              } else if (event.key === "Tab") {
                const controls = [
                  ...event.currentTarget.querySelectorAll<HTMLElement>(
                    'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[contenteditable="true"],[tabindex="0"]',
                  ),
                ].filter(
                  (element) =>
                    element.getClientRects().length &&
                    !element.closest("[hidden],[inert]"),
                );
                const edge = event.shiftKey ? controls[0] : controls.at(-1);
                if (document.activeElement === edge) {
                  event.preventDefault();
                  (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
                }
              }
            }}
          >
            <div className="cw-composer-window-controls">
              <TooltipButton
                type="button"
                className="cw-composer-expand"
                disabled={composerRunning}
                label={composerExpanded ? t("canvas.workspace.composer.collapse") : t("canvas.workspace.composer.expand")}
                aria-label={composerExpanded ? t("canvas.workspace.composer.collapse") : t("canvas.workspace.composer.expand")}
                aria-expanded={composerExpanded}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() =>
                  setExpandedComposerId(
                    composerExpanded ? null : composerNode.id,
                  )
                }
              >
                <CanvasIcon
                  name={composerExpanded ? "collapse" : "expand"}
                  size={14}
                />
              </TooltipButton>
              <TooltipButton
                className="cw-composer-dismiss"
                disabled={composerRunning}
                label={t("canvas.workspace.composer.close")}
                onClick={() => {
                  setExpandedComposerId(null);
                  setDismissedComposer(composerNode.id);
                  root.current?.focus({ preventScroll: true });
                }}
              >
                <CanvasIcon name="close" size={14} />
              </TooltipButton>
            </div>
            {composerNode.type === "text" ? (
              <TextNodeComposer
                key={`${composerNode.id}:${toolRevision}`}
                node={composerNode}
                incoming={composerIncoming}
                referenceControls={generationReferenceControls(composerNode)}
                models={backendCatalog.models}
                onUpdate={(patch) =>
                  command({
                    type: "update-node",
                    id: composerNode.id,
                    patch: { data: patch },
                  })
                }
                onRun={() => prepareGeneration(composerNode.id)}
                onCancel={() => cancelServiceRuns(composerNode.id)}
                onPickReference={() => {
                  setExpandedComposerId(null);
                  referenceTarget.current = composerNode.id;
                  setLibraryOpen(true);
                }}
                running={composerRunning}
              />
            ) : (
              <NodeComposer
                key={`${composerNode.id}:${toolRevision}`}
                selectedNode={composerNode}
                incomingNodes={composerIncoming}
                referenceControls={generationReferenceControls(composerNode)}
                onUpdate={(patch) =>
                  command({
                    type: "update-node",
                    id: composerNode.id,
                    patch: { data: patch },
                  })
                }
                onRun={() => prepareGeneration(composerNode.id)}
                onCancel={() => {
                  cancelServiceRuns(composerNode.id);
                }}
                onPickReference={() => {
                  setExpandedComposerId(null);
                  referenceTarget.current = composerNode.id;
                  setLibraryOpen(true);
                }}
                running={composerRunning}
                backendModels={backendCatalog.models}
              />
            )}
          </div>
        </>
      )}

      {menu && !menu.nodeId && !menu.connected && (
        <CanvasCreationMenu
          key={`${menu.x}:${menu.y}:${menu.mode ?? "context"}`}
          x={menu.x}
          y={menu.y}
          mode={menu.mode ?? "context"}
          canPaste={Boolean(clipboard.current?.nodes.length)}
          canUndo={businessHistory.undo && !historyReplaying}
          canRedo={businessHistory.redo && !historyReplaying}
          onCreate={(kind) => addNode(kind, menu.world)}
          onAssets={() => {
            referenceTarget.current = null;
            setAssistantOpen(false);
            setLibraryOpen(true);
          }}
          onUpload={() => openFilePicker()}
          onPaste={() => paste()}
          onUndo={() => replayHistory()}
          onRedo={() => replayHistory(true)}
          onClose={() => setMenu(null)}
        />
      )}
      {menu &&
        (menu.nodeId || menu.connected) &&
        contextItems(
          menu.nodeId ? (
            <>
              {menuButton(t("canvas.workspace.menu.rename"), "text", () => actions.rename(menu.nodeId!))}
              <button
                role="menuitem"
                disabled={
                  !doc.nodes.some(
                    (n) =>
                      n.id === menu.nodeId &&
                      canStartReference(n) &&
                      !lockedIds.has(n.id),
                  )
                }
                onClick={() => actions.newConnected(menu.nodeId!, "source")}
              >
                <CanvasIcon name="plus" size={16} />
                <span>{t("canvas.workspace.menu.addDownstream")}</span>
              </button>
              {menuButton(t("canvas.workspace.menu.copy"), "copy", copy, "⌘ C")}
              {menuButton(t("canvas.workspace.menu.cut"), "copy", cut, "⌘ X")}
              {menuButton(t("canvas.workspace.menu.paste"), "copy", () => paste(), "⌘ V")}
              {menuButton(t("canvas.workspace.selection.duplicate"), "copy", () => paste(true), "⌘ D")}
              <hr />
              {menuButton(t("canvas.workspace.selection.group"), "group", group, "⌘ G")}
              {selected.length > 1 && menuButton(t("canvas.workspace.kind.stack"), "stack", stack)}
              {menuButton(t("canvas.workspace.menu.ungroup"), "group", ungroup, "⌘ ⇧ G")}
              {menuButton(t("canvas.workspace.selection.autoArrange"), "map", () =>
                change((d) => ({
                  ...d,
                  nodes: arrangeNodes(d.nodes, selected),
                })),
              )}
              <hr />
              {menuButton(
                single && lockedIds.has(single.id) && !single.locked
                  ? t("canvas.workspace.menu.groupLocked")
                  : single?.locked
                    ? t("canvas.workspace.menu.unlock")
                    : t("canvas.workspace.menu.lock"),
                "lock",
                () => {
                  if (single && lockedIds.has(single.id) && !single.locked) {
                    notify(t("canvas.workspace.toast.unlockGroupFirst"));
                    return;
                  }
                  command({
                    type: "batch",
                    commands: selected.map((id) => ({
                      type: "update-node",
                      id,
                      patch: {
                        locked: !doc.nodes.find((n) => n.id === id)?.locked,
                      },
                    })),
                  });
                },
              )}
              {single?.type === "stack" &&
                menuButton(t("canvas.workspace.menu.unstack"), "stack", () =>
                  change((d) => unstackSelection(d, selected)),
                )}
              {menuButton(t("canvas.workspace.menu.moveToFront"), "arrow", () =>
                command({
                  type: "reorder-nodes",
                  ids: selected,
                  direction: "front",
                }),
              )}
              {menuButton(
                t("canvas.workspace.menu.moveForward"),
                "arrow",
                () =>
                  command({
                    type: "reorder-nodes",
                    ids: selected,
                    direction: "forward",
                  }),
                "⌘ ]",
              )}
              {menuButton(
                t("canvas.workspace.menu.moveBackward"),
                "arrow",
                () =>
                  command({
                    type: "reorder-nodes",
                    ids: selected,
                    direction: "backward",
                  }),
                "⌘ [",
              )}
              {menuButton(
                t("canvas.workspace.menu.moveToBack"),
                "arrow",
                () =>
                  command({
                    type: "reorder-nodes",
                    ids: selected,
                    direction: "back",
                  }),
                "⌘ ⇧ [",
              )}
              {single &&
                ["image", "video", "audio", "file"].includes(single.type) &&
                !lockedIds.has(single.id) &&
                menuButton(
                  single.data.src ? t("canvas.workspace.menu.replaceAsset") : t("canvas.workspace.menu.uploadAsset"),
                  "upload",
                  () => openFilePicker(single.id),
                )}
              {single?.data.src &&
                menuButton(t("canvas.workspace.menu.downloadAsset"), "download", () => downloadNode(single))}
              {single?.type === "image" &&
                single.data.src &&
                menuButton(t("canvas.workspace.menu.editImage"), "crop", () => openEditor(single))}
              {single &&
                ["timeline", "stack", "tool", "external"].includes(
                  single.type,
                ) &&
                menuButton(t("canvas.workspace.menu.openEditor"), single.type, () => openEditor(single))}
              {single?.data.src &&
                ["image", "video", "audio"].includes(single.type) &&
                menuButton(t("canvas.workspace.menu.editAsset"), "tool", () =>
                  openNodeAction(
                    single.data.taskDraft?.tool ??
                      (single.type === "image"
                        ? "smart-edit"
                        : single.type === "video"
                          ? "video-trim"
                          : "audio-trim"),
                  ),
                )}
              <hr />
              {menuButton(t("canvas.workspace.menu.delete"), "trash", removeSelected, "⌫")}
            </>
          ) : (
            <CreationMenuContent
              allowedKinds={
                menu.connected
                  ? menu.connected.ids && menu.connected.ids.length > 1
                    ? batchCreationKinds(
                        doc,
                        menu.connected.ids,
                        CANVAS_CREATION_TOOLS.filter(
                          (tool) => !tool.unavailable,
                        ).map((tool) => tool.kind),
                      )
                    : connectedCreationKinds(
                        doc,
                        menu.connected.id,
                        menu.connected.direction,
                        CANVAS_CREATION_TOOLS.filter((t) => !t.unavailable).map(
                          (t) => t.kind,
                        ),
                        { allowEmptySource: true },
                      )
                  : undefined
              }
              onCreate={(kind) => addNode(kind, menu.world)}
              onAssets={() => setLibraryOpen(true)}
              onUpload={() => openFilePicker()}
            />
          ),
        )}

      {panel === "search" && (
        <CreationAssetList
          key={`assets:${doc.id}`}
          projectId={doc.id}
          anchor={assetListAnchor.current}
          position={center()}
          onClose={() => setPanel(null)}
          onLocate={(id) => {
            void workspaceProjection(doc.id)
              .read()
              .then((next) => {
                if (historyRef.current.present.id !== next.id) return;
                const projection = workspaceProjection(next.id);
                projection.baseline = next;
                projection.basis = creationClient(next.id).snapshot;
                setHistory((history) => ({ ...history, present: next }));
                setSelected([id]);
                requestAnimationFrame(
                  () =>
                    void flow.fitView({
                      nodes: [{ id }],
                      padding: 0.7,
                      maxZoom: 1,
                      duration: 200,
                    }),
                );
              })
              .catch((error) => notify(errorMessage(error)));
          }}
        />
      )}
      {panel && !(panel === "search") && (
        <aside
          className={`cw-side-panel ${panel === "assets" ? "from-left" : ""}`}
          aria-label={
            {
              assets: t("canvas.workspace.panel.assets"),
              search: t("canvas.workspace.panel.search"),
              history: t("canvas.workspace.toolbar.history"),
            }[panel]
          }
        >
          <div className="cw-panel-heading">
            <h2>
              {
                {
                  assets: t("canvas.workspace.panel.assets"),
                  search: t("canvas.workspace.panel.search"),
                  history: t("canvas.workspace.toolbar.history"),
                }[panel]
              }
            </h2>
            <IconButton
              name="close"
              label={t("canvas.workspace.panel.close")}
              onClick={() => {
                setPanel(null);
                referenceTarget.current = null;
              }}
            />
          </div>
          {panel === "assets" && (
            <>
              <p className="cw-panel-note">
                {referenceTarget.current
                  ? t("canvas.workspace.panel.referenceHint")
                  : t("canvas.workspace.panel.assetsHint")}
              </p>
              <button
                className="cw-wide-button"
                onClick={() => openFilePicker()}
              >
                <CanvasIcon name="upload" />
                {t("canvas.workspace.help.upload")}
              </button>
              <h3>{t("canvas.workspace.panel.canvasAssets")}</h3>
              <div className="cw-asset-grid">
                {[...doc.nodes, ...(doc.hiddenNodes ?? [])]
                  .filter((n) => n.data.src)
                  .map((n) => (
                    <button
                      key={n.id}
                      onClick={() => {
                        if (
                          referenceTarget.current &&
                          referenceTarget.current !== n.id &&
                          doc.nodes.some(
                            (item) => item.id === referenceTarget.current,
                          )
                        ) {
                          const linked = referenceEdges(
                            [n.id],
                            referenceTarget.current,
                          );
                          if (linked.issue) {
                            notify(linked.issue);
                            return;
                          }
                          command({ type: "batch", commands: linked.commands });
                          referenceTarget.current = null;
                          setPanel(null);
                        } else selectAndFocus(n);
                      }}
                    >
                      {n.type === "image" ? (
                        <img src={n.data.src} alt={n.data.title} />
                      ) : (
                        <CanvasIcon name={n.type} size={34} />
                      )}
                      <span>{n.data.title}</span>
                    </button>
                  ))}
              </div>
              <button
                className="cw-wide-button"
                onClick={() => setLibraryOpen(true)}
              >
                <CanvasIcon name="folder" />
                {t("canvas.workspace.panel.openLibrary")}
              </button>
              <h3>{t("canvas.workspace.panel.samples")}</h3>
              <div className="cw-asset-grid">
                {[
                  t("canvas.workspace.sample.mountain"),
                  t("canvas.workspace.sample.dusk"),
                  t("canvas.workspace.sample.lake"),
                ].map((title, i) => (
                  <button
                    key={title}
                    onClick={() => {
                      const target = referenceTarget.current;
                      const n = addNode("image", undefined, {
                        title,
                        mediaRole: "asset",
                        src: studyImage(i, title),
                        assetState: "ready",
                        mimeType: "image/svg+xml",
                      });
                      if (
                        n &&
                        target &&
                        doc.nodes.some((item) => item.id === target)
                      ) {
                        const linked = referenceEdges([n.id], target, [n]);
                        if (linked.issue) notify(linked.issue);
                        else
                          command({
                            type: "batch",
                            commands: linked.commands,
                          });
                        setSelected([target]);
                        referenceTarget.current = null;
                      }
                    }}
                  >
                    <img src={studyImage(i, title)} alt={title} />
                    <span>{title}</span>
                  </button>
                ))}
              </div>
              <small className="cw-panel-note">
                {t("canvas.workspace.panel.samplesNote")}
              </small>
            </>
          )}
          {panel === "history" && (
            <GenerationHistoryPanel
              key={doc.id}
              jobs={jobs}
              authoritative={true}
              onRestoreConfiguration={async (entry, referencePolicy) => {
                try {
                  if (!(await persist(historyRef.current.present))) return;
                  const client = creationClient(doc.id),
                    job = client.snapshot.jobs.find(
                      (job) => job.id === entry.taskId,
                    );
                  if (!job) throw new Error(t("canvas.workspace.error.originalTaskMissing"));
                  const spec = client.snapshot.generationSpecs.find(
                    (spec) => spec.id === job.inputSnapshot.spec.id,
                  )!;
                  const history = await apiRequest<{
                    jobs: {
                      job: { id: string };
                      configurationCommandId: string | null;
                    }[];
                  }>(`/creation/projects/${doc.id}/specs/${spec.id}/versions`);
                  const commandId = history.jobs.find(
                    (item) => item.job.id === job.id,
                  )?.configurationCommandId;
                  if (!commandId) throw new Error(t("canvas.workspace.error.configHistoryMissing"));
                  await client.command(
                    "generationSpec.restore",
                    { specId: spec.id, commandId, referencePolicy },
                    [
                      {
                        objectType: "generation_spec",
                        id: spec.id,
                        revision: spec.revision,
                      },
                      ...client.snapshot.references
                        .filter((ref) => ref.targetSpecId === spec.id)
                        .map((ref) => ({
                          objectType: "reference" as const,
                          id: ref.id,
                          revision: ref.revision,
                        })),
                    ],
                  );
                  notify(t("canvas.workspace.toast.configRestored"));
                } catch (error) {
                  notify(errorMessage(error));
                }
              }}
              onSync={
                backendCatalog.connected
                  ? () => void syncServiceResults()
                  : undefined
              }
              onTaskAction={
                backendCatalog.connected
                  ? async (job, action) => {
                      if (!job.taskId) return;
                      try {
                        if (job.tool) {
                          if (action === "cancel")
                            await cancelToolTask(doc.id, job.taskId);
                          setJobs(await readJobs());
                          return;
                        }
                        {
                          await creationClient(doc.id).control(
                            job.taskId,
                            action,
                          );
                          return;
                        }
                      } catch (error) {
                        notify(errorMessage(error));
                      }
                    }
                  : undefined
              }
              onLocate={(id) => {
                void (async () => {
                  if (!(await persist(historyRef.current.present))) return;
                  const client = creationClient(doc.id);
                  await client.refresh();
                  const item = client.snapshot.canvasItems.find(
                    (item) => item.id === id,
                  );
                  if (!item) {
                    notify(t("canvas.workspace.toast.configNotVisible"));
                    return;
                  }
                  if (!visibleItems(client.snapshot).has(id)) {
                    const versions = [objectVersion("canvas_item", item)];
                    let parentId = item.parentId;
                    while (parentId) {
                      const parent = client.snapshot.canvasItems.find(
                        (item) => item.id === parentId,
                      )!;
                      versions.push(objectVersion("canvas_item", parent));
                      parentId = parent.parentId;
                    }
                    await client.command("canvas.show", { item }, versions);
                  }
                  const projection = workspaceProjection(doc.id),
                    snapshot = client.snapshot,
                    next = await projection.read(snapshot);
                  const current = historyRef.current.present;
                  if (
                    current.id !== doc.id ||
                    client.snapshot.eventCursor !== snapshot.eventCursor ||
                    JSON.stringify([current.nodes, current.edges]) !==
                      JSON.stringify([
                        projection.baseline.nodes,
                        projection.baseline.edges,
                      ])
                  )
                    return;
                  projection.baseline = next;
                  projection.basis = snapshot;
                  setHistory((history) => ({ ...history, present: next }));
                  setSelected([id]);
                  requestAnimationFrame(
                    () =>
                      void flow.fitView({
                        nodes: [{ id }],
                        padding: 0.7,
                        maxZoom: 1,
                        duration: 200,
                      }),
                  );
                })().catch((error) => notify(errorMessage(error)));
                return;
              }}
              onRestore={(entries, requests = false) => {
                void (async () => {
                  const toolEntries = entries.filter((entry) => entry.tool);
                  if (toolEntries.length && !requests) {
                    {
                      if (!(await persist(historyRef.current.present))) return;
                      const adoptedIds: string[] = [];
                      for (const entry of toolEntries)
                        if (entry.taskId) {
                          const placed = await acknowledgeToolPlacement(
                            doc.id,
                            entry.taskId,
                            "placed",
                            "explicit",
                          );
                          adoptedIds.push(
                            ...placed.outputs.map(
                              (output) => output.canvasItemId,
                            ),
                          );
                        }
                      await creationClient(doc.id).refresh();
                      setSelected(adoptedIds);
                      revealResults(adoptedIds);
                      setJobs(await readJobs());
                    }
                    entries = entries.filter((entry) => !entry.tool);
                    if (!entries.length) return;
                  }
                  {
                    void (async () => {
                      if (requests) {
                        notify(t("canvas.workspace.toast.useRestoreConfig"));
                        return;
                      }
                      if (!(await persist(historyRef.current.present))) return;
                      const client = creationClient(doc.id);
                      await client.refresh();
                      const results = client.snapshot.results.filter((result) =>
                        entries.some((entry) => entry.taskId === result.jobId),
                      );
                      if (
                        new Set(results.map((result) => result.specId)).size !==
                        results.length
                      ) {
                        notify(t("canvas.workspace.toast.oneResultPerSpec"));
                        return;
                      }
                      const specs = client.snapshot.generationSpecs.filter(
                        (spec) =>
                          results.some((result) => result.specId === spec.id),
                      );
                      const items = client.snapshot.canvasItems.filter(
                        (item) =>
                          item.binding.role === "generation" &&
                          specs.some(
                            (spec) =>
                              item.binding.role === "generation" &&
                              item.binding.objectRef.id === spec.id,
                          ),
                      );
                      await client.batch(
                        results.map((result) => ({
                          type: "result.select",
                          payload: {
                            specId: result.specId,
                            resultId: result.id,
                          },
                        })),
                        [
                          ...specs.map((spec) =>
                            objectVersion("generation_spec", spec),
                          ),
                          ...items.map((item) =>
                            objectVersion("canvas_item", item),
                          ),
                        ],
                      );
                    })().catch((error) => notify(errorMessage(error)));
                    return;
                  }
                })().catch((error) => notify(errorMessage(error)));
              }}
            />
          )}
        </aside>
      )}

      {ready && (
        <AssistantPanel
          key={doc.id}
          documentId={doc.id}
          documentTitle={doc.title}
          catalog={backendCatalog}
          nodes={[...doc.nodes, ...(doc.hiddenNodes ?? [])]}
          visibleNodes={doc.nodes}
          selectedNodes={doc.nodes.filter((node) => selected.includes(node.id))}
          open={assistantOpen}
          layout={assistantLayout}
          selectionRequest={assistantSelectionRequest}
          onClose={() => {
            setAssistantOpen(false);
            requestAnimationFrame(() =>
              root.current
                ?.querySelector<HTMLButtonElement>(".cw-chat-button")
                ?.focus(),
            );
          }}
          onTurnEnd={() => void syncServiceResults()}
          onModelSelections={setAssistantModels}
          onPrepareReferences={() => persist(historyRef.current.present)}
          onOpenSettings={() => {
            setSettingsCategory("models");
            setSettingsOpen(true);
          }}
        />
      )}

      <input
        ref={fileInput}
        className="sr-only"
        type="file"
        multiple
        aria-label={t("canvas.workspace.aria.fileInput")}
        onChange={(e) => {
          if (e.target.files?.length) void importFiles([...e.target.files]);
          e.target.value = "";
        }}
      />
      <input
        ref={resultInput}
        className="sr-only"
        type="file"
        multiple
        aria-label={t("canvas.workspace.aria.resultInput")}
        onChange={(event) => {
          if (event.target.files?.length)
            void importActionResultFiles([...event.target.files]);
          event.target.value = "";
        }}
      />
      <CanvasNotifications notifications={notifications} onDismiss={dismiss} />
      {textWindowNode && (
        <TextNodeWindow
          key={textWindowNode.id}
          node={textWindowNode}
          locked={lockedIds.has(textWindowNode.id)}
          onUpdate={(text) =>
            command({
              type: "update-node",
              id: textWindowNode.id,
              patch: { data: { text } },
            })
          }
          onClose={() => setTextWindowId(null)}
          onBeginEdit={begin}
          onEndEdit={end}
        />
      )}
      {preview && (
        <div
          className="cw-modal-backdrop cw-preview"
          role="dialog"
          aria-label={t("canvas.workspace.aria.previewDialog")}
          onClick={() => setPreview(null)}
        >
          <header>
            <span>{preview.data.title}</span>
            <IconButton
              name="download"
              label={t("canvas.workspace.aria.downloadPreview")}
              onClick={() => downloadNode(preview)}
            />
            <IconButton
              name="close"
              label={t("canvas.workspace.aria.closePreview")}
              onClick={() => setPreview(null)}
            />
          </header>
          <div onClick={(e) => e.stopPropagation()}>
            {preview.type === "image" && preview.data.src ? (
              <img src={preview.data.src} alt={preview.data.title} />
            ) : preview.type === "video" && preview.data.src ? (
              <video src={preview.data.src} controls />
            ) : preview.type === "audio" && preview.data.src ? (
              <audio src={preview.data.src} controls />
            ) : (
              <p>
                {preview.data.text ||
                  (preview.data.src
                    ? t("canvas.workspace.preview.fileHint")
                    : t("canvas.workspace.preview.emptyHint"))}
              </p>
            )}
          </div>
        </div>
      )}
      {editing && editorMode === "default" && editing.type === "timeline" && (
        <TimelineEditor
          node={editing}
          resources={resources}
          onApply={(timeline) => commitEditorData({ timeline })}
          onPrepareRender={async (timeline) => {
            if ((await commitEditorData({ timeline })) === false)
              throw new Error(t("canvas.workspace.error.timelineUnsaved"));
            const client = creationClient(doc.id);
            const publish = timelinePublication(
              client,
              editorSession.current!.projection.basis,
              editing.id,
            );
            return async (result) => {
              await publish(result);
              client.install(client.snapshot);
              notify(t("canvas.workspace.toast.compositeSaved"));
              return true;
            };
          }}
          onRender={(result) => editorOutputs([result])}
          onClose={closeEditor}
        />
      )}
      {editing && editorMode === "default" && editing.type === "stack" && (
        <StackEditor
          node={editing}
          nodes={doc.nodes}
          onApply={(stack) => {
            return commitEditorData({ stack });
          }}
          onClose={closeEditor}
          onSelectNode={(id) => {
            const node = doc.nodes.find((node) => node.id === id);
            if (node) selectAndFocus(node);
          }}
        />
      )}
      {editing && editorMode === "default" && editing.type === "tool" && (
        <ToolEditor
          node={editing}
          onApply={(tool) => commitEditorData({ tool })}
          onClose={closeEditor}
        />
      )}
      {editing && editorMode === "default" && editing.type === "external" && (
        <Suspense
          fallback={
            <EditorModal
              title={t("canvas.workspace.director.opening")}
              subtitle={t("canvas.workspace.director.subtitle")}
              onClose={closeEditor}
            >
              <p>{t("canvas.workspace.director.loading")}</p>
            </EditorModal>
          }
        >
          <DirectorStage
            onPrepareRender={async (localStage) => {
              await commitEditorData({ localStage });
              const origin = editorOrigin.current!;
              const client = creationClient(doc.id);
              mediaPublications.current.set(
                origin,
                new MediaPublication(client, client.snapshot, origin.nodeId),
              );
              return async (result) => addLinkedOutputs(origin, [result]);
            }}
            onRender={(result) => editorOutputs([result])}
            node={editing}
            onApply={(localStage, screenshot) =>
              commitEditorData({
                localStage,
                ...(screenshot
                  ? {
                      src: screenshot,
                      mimeType: "image/png",
                      assetState: "ready",
                      media: undefined,
                    }
                  : {}),
              })
            }
            onClose={closeEditor}
          />
        </Suspense>
      )}
      {editing &&
        editing.type === "image" &&
        ["default", "layers"].includes(editorMode) && (
          <ImageEditor
            node={editing}
            initialTab={editorMode === "layers" ? "layers" : "crop"}
            initialLayers={editing.data.layers}
            embedSourcesOnApply={false}
            onClose={closeEditor}
            onApply={(src, layers, crop) =>
              commitEditorData({
                src,
                mimeType: "image/png",
                assetState: "ready",
                layers,
                imageCrop: crop,
                media: crop
                  ? { width: crop.width, height: crop.height }
                  : layers
                    ? { width: layers.width, height: layers.height }
                    : undefined,
                taskDraft: undefined,
              })
            }
          />
        )}
      {editing &&
        editing.type === "image" &&
        ["annotation", "grid", "mask"].includes(editorMode) && (
          <LocalImageTools
            node={editing}
            mode={editorMode as "annotation" | "grid" | "mask"}
            onClose={closeEditor}
            onApply={(outputs, task) =>
              editorOutputs(
                outputs.map((output) => ({
                  kind: "image",
                  src: output.src,
                  mimeType: output.mimeType,
                  title: output.title,
                  media: { width: output.width, height: output.height },
                })),
                task,
              )
            }
            onSelection={(selection) => {
              const origin = editorOrigin.current;
              if (!origin) return;
              const current = validateNodeActionSource(
                historyRef.current.present,
                origin,
              );
              if (!current.node) {
                notify(current.error);
                return;
              }
              const spec = CANVAS_TOOLS.find((tool) => tool.id === maskTool)!;
              // The panel saved its latest parameters before opening this editor;
              // editing is an older image snapshot and does not own that draft.
              const previous =
                current.node.data.taskDraft?.tool === maskTool
                  ? current.node.data.taskDraft
                  : undefined;
              const draft =
                previous ??
                createCanvasToolTask(
                  maskTool,
                  [origin.nodeId],
                  initialToolParameters(spec),
                );
              saveActionDraft(origin, { ...draft, selection });
              setActionSession({
                ...origin,
                tool: maskTool,
                token: crypto.randomUUID(),
              });
              focusSelection(origin.nodeId);
            }}
          />
        )}
      {editing &&
        ["video", "audio"].includes(editing.type) &&
        ["trim", "frame", "extract-audio", "crop"].includes(editorMode) && (
          <LocalMediaEditor
            node={editing}
            mode={editorMode as "trim" | "frame" | "extract-audio" | "crop"}
            onApply={(output, task) => editorOutputs([output], task)}
            onClose={closeEditor}
          />
        )}
      {welcomeOpen && <WelcomeScreen
        catalog={backendCatalog}
        onSkip={() => { dismissModelSetup(); setWelcomeOpen(false); }}
      />}
      {settingsOpen && (
        <SettingsDialog
          catalog={backendCatalog}
          theme={theme}
          initialCategory={settingsCategory}
          onClose={() => { dismissModelSetup(); setSettingsOpen(false); }}
        />
      )}
      {help && (
        <div className="cw-modal-backdrop" onClick={() => setHelp(false)}>
          <section
            className="cw-modal cw-help"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label={t("canvas.workspace.help.dialogLabel")}
          >
            <div className="cw-panel-heading">
              <h2>{t("canvas.workspace.help.title")}</h2>
              <IconButton
                name="close"
                label={t("canvas.workspace.help.close")}
                onClick={() => setHelp(false)}
              />
            </div>
            <p>
              {t("canvas.workspace.help.body")}
            </p>
            <dl>
              {helpShortcuts(navigator.platform.includes("Mac"), t).map(
                ([name, key]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>{key}</dd>
                  </div>
                ),
              )}
            </dl>
          </section>
        </div>
      )}
    </div>
  );
  return (
    <>
      {workspace}
      {subjectImport && (
        <SubjectImportDialog
          projectId={subjectImport.projectId}
          targetId={subjectImport.nodeId}
          initialTab={subjectImport.tab}
          slot={subjectImport.slot}
          targetIssue={
            doc.id !== subjectImport.projectId
              ? t("canvas.workspace.error.projectSwitched")
              : (subjectImportSelection(doc, [subjectImport.nodeId]).issue ??
                (() => {
                  const target = doc.nodes.find(
                    (node) => node.id === subjectImport.nodeId,
                  );
                  return target &&
                    subjectTargetIdentity(target) !== subjectImport.identity
                    ? t("canvas.workspace.error.subjectTargetChanged")
                    : null;
                })())
          }
          busy={subjectLibraryBusy || switching || projectRenaming}
          onClose={() => setSubjectImport(null)}
          onConfirm={confirmSubjectImport}
        />
      )}
      {libraryOpen && (
        <AssetLibraryDialog
          currentId={doc.id}
          liveCanvas={liveCanvas}
          subjectBusy={subjectLibraryBusy || switching || projectRenaming}
          backupSubjectIssue={
            single?.type === "subject" &&
            single.data.subject?.main?.src &&
            single.data.assetState !== "missing"
              ? null
              : t("canvas.workspace.error.selectSingleSubject")
          }
          onImportSubjects={(items) => importLibrarySubjects(items)}
          onBackupSubject={backupLibrarySubject}
          onClose={() => {
            setLibraryOpen(false);
            referenceTarget.current = null;
          }}
          onImportCanvas={importCanvasSource}
          onInsert={insertLibraryItems}
        />
      )}
      {(!ready || switching) && (
        <div className="canvas-loading-screen" role="status">
          {initializationError ? (
            <div role="alert">
              <p>{initializationError}</p>
              <button onClick={() => window.location.reload()}>{t("canvas.workspace.loading.reconnect")}</button>
              <a href="/">{t("canvas.workspace.loading.backHome")}</a>
            </div>
          ) : (
            <span className="canvas-loading-message">
              <span className="canvas-loading-spinner" aria-hidden="true" />
              {t(switching ? "canvas.workspace.loading.switching" : "canvas.workspace.loading.opening")}
            </span>
          )}
        </div>
      )}

    </>
  );}
