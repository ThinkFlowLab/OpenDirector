import { pinnedReferenceAssets } from "./pinnedReferenceAssets.ts";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlowProvider,
  SelectionMode,
  useKeyPress,
  useReactFlow,
  ViewportPortal,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type OnConnectEnd,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { NodeVersionHistory, useNodeVersionCounts } from "./NodeVersionHistory";
import openDirectorLogoAnimation from "../assets/open_director_logo_anim.gif";
import { request as apiRequest, errorMessage } from "../backend/api.ts";
import {
  copyCanvasSource,
  copySubjectAsset,
  type CanvasSource,
} from "../backend/canvasSources";
import { currentAsset } from "../backend/creationClient";
import {
  creationClient,
  itemSpec,
  objectVersion,
  visibleItems,
} from "../backend/creationClient.ts";
import { CreationEditorSession } from "../backend/creationEditorSession";
import type { ModelSelections } from "../backend/chat";
import { fingerprint, type GenerationRequest } from "../backend/generation.ts";
import { previewImageSelection } from "../backend/imageSelections";
import { MediaPublication } from "../backend/mediaPublication";
import { useBackendModels } from "../backend/models.ts";
import { openBackendProject } from "../backend/projects.ts";
import {
  backendBlocker,
  backendModel,
  backendReferences,
  backendVideoMode,
  modelLabel,
  serviceAudioSettings,
  serviceVoice,
} from "../backend/rules.ts";
import {
  backUpLibrarySubject,
  copyLibrarySubjects,
} from "../backend/subjectLibrary.ts";
import { timelinePublication } from "../backend/timelinePublication";
import { deliverTool, pendingToolDelivery } from "../backend/toolDeliveries";
import {
  acknowledgeToolPlacement,
  cancelToolTask,
  submitToolTask,
  ToolSubmissionError,
  useToolCatalog,
} from "../backend/tools.ts";
import {
  createWorkspaceProject,
  importWorkspaceDocument,
  initializeWorkspace,
  listWorkspaceProjects,
  openWorkspaceProject,
  renameWorkspaceProject,
  saveWorkspaceDocument,
  workspaceProjection,
} from "../backend/workspace";
import {
  downloadFile,
  downloadFilename,
  exampleDocument,
  studyImage,
} from "./assets";
import { AssistantPanel } from "./AssistantPanel";
import { assistantReferences } from "./assistantReferences";
import { CanvasActionsContext } from "./CanvasActionsContext";
import {
  CanvasConnectionLine,
  CanvasConnectionPreview,
  CanvasInteractionOverlay,
  CanvasReferenceEdge,
} from "./CanvasConnections";
import { CanvasContextMenu } from "./CanvasContextMenu";
import { CanvasCreationMenu, CreationMenuContent } from "./CanvasCreationMenu";
import {
  CanvasFlowSurface,
  type CanvasFlowSurfaceHandle,
} from "./CanvasFlowSurface";
import { CanvasIcon } from "./CanvasIcon";
import { CanvasPlaybackProvider } from "./CanvasMediaPreview";
import { CanvasNodeView } from "./CanvasNodeView";
import {
  CanvasNotifications,
  useCanvasNotifications,
} from "./CanvasNotifications";
import { CanvasToolRail } from "./CanvasToolRail";
import { fingerprintMatches } from "./chatReferenceContent.ts";
import {
  canStartReference,
  connectedCreationKinds,
  REFERENCE_ISSUE_TEXT,
  referenceIssue,
  referenceMaterial,
} from "./connectionPolicy";
import { REFERENCE_PORT_SIZE, referencePortMetrics } from "./connectionPorts";
import "./control-theme.css";
import { CreationAssetList } from "./CreationAssetList.tsx";
import { CANVAS_CREATION_TOOLS } from "./creationTools";
import { sameNodeData } from "./dataBoundary.ts";
import { classifyImportFile, readEditorResource } from "./editorMedia";
import { EditorModal } from "./EditorModal";
import {
  generationActivities,
  jobActivities,
  type ActiveGeneration,
} from "./generationActivity";
import { expectedDuration, recordDuration } from "./generationDurations";
import {
  toolProvenanceEdges,
  type GenerationJob as Job,
} from "./generationHistory";
import { GenerationHistoryPanel } from "./GenerationHistoryPanel";
import {
  generationContent,
  incomingReferenceNodes,
} from "./generationReferenceContent.ts";
import { referenceContentCommand } from "./generationReferenceEdit.ts";
import type { GenerationReferenceControls } from "./GenerationReferenceEditor";
import { absolutePosition, arrangeNodes } from "./geometry";
import { lockedNodeIds } from "./hierarchy";
import {
  beginTransaction,
  commitTransaction,
  createHistory,
  executeCommand,
  recordChange,
  type CanvasHistory,
} from "./history";
import { ImageActionEditor, isImageActionTool } from "./ImageActionEditor";
import { imageAnnotationPayload } from "./imageActionPayload";
import { ImageEditor } from "./ImageEditor";
import { readImportBatch } from "./importBatch";
import { AssetLibraryDialog } from "./library/AssetLibraryDialog";
import "./library/library.css";
import {
  itemBlob,
  itemToResource,
  withMediaSuffix,
  type LibraryItem,
} from "./library/libraryClient";
import {
  SubjectImportDialog,
  type SubjectImportChoice,
  type SubjectImportTab,
} from "./library/SubjectImportDialog";
import {
  appendPendingResult,
  captureEditorSource,
  removePendingResult,
  validateNodeActionSource,
  type GenerationResultMode,
  type LinkedMediaResult,
  type ResultSource,
} from "./linkedResults";
import { generationDefaults } from "./generationCatalog.ts";
import {
  applyModelResolution,
  resolveGenerationModel,
} from "./modelResolution.ts";
import { LocalImageTools } from "./LocalImageTools";
import { LocalMediaEditor } from "./LocalMediaEditor";
import {
  applyCommand,
  canAddReference,
  createDocument,
  createNode,
  MAX_ZOOM,
  MIN_ZOOM,
  type CanvasCommand,
  type CanvasDocument,
  type CanvasNode,
  type CanvasNodeData,
  type CanvasNodeKind,
  type CanvasResource,
  type Point,
} from "./model";
import {
  createVideoExtensionDraft,
  gridSplitImage,
} from "./nodeActionWorkflow";
import { getNodeGenerationSettings, NodeComposer } from "./NodeComposer";
import { NodeInfoButton } from "./NodeInfoButton";
import { NodeSelectionToolbar } from "./NodeSelectionToolbar";
import { NodeTaskPanel } from "./NodeTaskPanel";
import {
  copySelection,
  cutSelection,
  groupSelection,
  orderNodesForCanvas,
  pasteFragment,
  resourceFromNode,
  stackSelection,
  ungroupSelection,
  unstackSelection,
  updateStack,
  type CanvasFragment,
} from "./operations";
import { CanvasPointerGesture } from "./pointerGesture";
import { portableDocument } from "./portableDocument.ts";
import { resourceNodeData } from "./projectAssets";
import { persistCurrentDocument } from "./projectManagement";
import { ProjectNameDialog } from "./ProjectNameDialog";
import { ProjectSelector } from "./ProjectSelector";
import { referencePresentation, referenceSnapshot } from "./referenceEvidence";
import "./settings.css";
import { SettingsDialog } from "./SettingsDialog";
import { alignNodes, type Alignment } from "./snapping";
import { StackEditor } from "./StackEditor";
import { projectCanvasStacks, visibleSelectionIds } from "./stackProjection";
import { serializeDocument } from "./storage";
import { subjectDescriptionLayout } from "./subjectLayout.ts";
import { measureSubjectNodeHeight } from "./subjectLayoutMeasurement.ts";
import {
  librarySubjectCommand,
  mergeLibrarySubjectImport,
  subjectImportSelection,
  subjectTargetIdentity,
} from "./subjectLibraryImport.ts";
import { subjectWithResource, type SubjectMediaSlot } from "./subjectMedia.ts";
import { agentGenerationBlocker, agentNodeSettings } from "./textGeneration";
import { TextNodeComposer } from "./TextNodeComposer";
import { useTheme } from "./theme";
import "./themes.css";
import { TimelineEditor } from "./TimelineEditor";
import {
  CANVAS_TOOLS,
  createCanvasToolTask,
  initialToolParameters,
  type CanvasToolId,
  type CanvasToolTask,
  type ToolParameters,
  type ToolSource,
} from "./toolCatalog";
import { ToolEditor } from "./ToolEditor";
import { TooltipButton, TooltipProvider } from "./TooltipButton";
import { assertUpload } from "./uploadPolicy.ts";
import { useAssistantLayout } from "./useAssistantLayout";
import {
  portPoint,
  useCanvasReferences,
  type PortSide,
} from "./useCanvasReferences";
import { useCanvasWheelBoundary } from "./useCanvasWheelBoundary";
import { useGenerationJobs } from "./useGenerationJobs";
import { useProjectMentionAssets } from "./useProjectMentionAssets";
import { useSelectionPresentation } from "./useSelectionPresentation";
import { VideoActionEditor } from "./VideoActionEditor";
import { captureVideoEndpoint, extractVideoAudio } from "./videoActionRuntime";
import "./workspace.css";
const DirectorStage = lazy(() =>
  import("./DirectorStage").then((module) => ({
    default: module.DirectorStage,
  })),
);

type FlowNode = Node<CanvasNodeData, CanvasNodeKind>;
type Panel = "assets" | "search" | "history" | null;
type Menu = {
  mode?: "create" | "context";
  x: number;
  y: number;
  world: Point;
  nodeId?: string;
  parentId?: string;
  connected?: {
    id: string;
    direction: "source" | "target";
    side?: PortSide;
    anchor?: Point;
  };
};
/** A generation submitted to the local API from this page. */
type ServiceRun = ActiveGeneration & {
  controller: AbortController;
  projectId?: string;
  taskId?: string;
  /** Pending unified delivery, not a persisted or synthetic Job. */
  unified?: boolean;
  /** Tool tasks are cancelled through the tool task route. */
  tool?: CanvasToolId;
  targetNodeId?: string;
};
/** Media kind of a tool's first result, or null when it is only known after the run. */
const toolOutputKind = (
  tool: CanvasToolId,
  source: CanvasNodeKind,
): "image" | "video" | "audio" | null => {
  if (tool === "dynamic-poster") return "video";
  // Separation returns a soundtrack and a silent video in one run.
  if (tool === "audio-separation") return null;
  return source === "image" || source === "video" || source === "audio"
    ? source
    : null;
};
const jobTime = () =>
  new Date().toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
const nodeTypes = {
  image: CanvasNodeView,
  video: CanvasNodeView,
  audio: CanvasNodeView,
  file: CanvasNodeView,
  text: CanvasNodeView,
  group: CanvasNodeView,
  timeline: CanvasNodeView,
  subject: CanvasNodeView,
  stack: CanvasNodeView,
  tool: CanvasNodeView,
  external: CanvasNodeView,
};
const edgeTypes = { reference: CanvasReferenceEdge };
const labels: Record<CanvasNodeKind, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  text: "文本",
  file: "文件",
  group: "分组",
  timeline: "时间线",
  subject: "主体",
  stack: "资源堆叠",
  tool: "工具",
  external: "导演台",
};
const kinds: CanvasNodeKind[] = [
  "image",
  "video",
  "audio",
  "text",
  "timeline",
  "subject",
  "stack",
  "tool",
  "external",
  "file",
  "group",
];
type EditorMode =
  | "default"
  | "layers"
  | "annotation"
  | "grid"
  | "mask"
  | "trim"
  | "frame"
  | "extract-audio"
  | "crop";

function IconButton({
  name,
  label,
  onClick,
  active,
  highlighted = active,
  disabled,
  shortcut,
  tooltipSide = "top",
  tooltipDelay = 200,
}: {
  name: string;
  label: string;
  onClick: () => void;
  active?: boolean;
  highlighted?: boolean;
  disabled?: boolean;
  shortcut?: string;
  tooltipSide?: "top" | "bottom" | "left" | "right";
  tooltipDelay?: number;
}) {
  return (
    <TooltipButton
      className={`cw-icon-button ${highlighted ? "is-active" : ""}`}
      aria-label={label}
      label={label}
      shortcut={shortcut}
      tooltipSide={tooltipSide}
      tooltipDelay={tooltipDelay}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
    >
      <CanvasIcon name={name} />
    </TooltipButton>
  );
}

export default function CanvasWorkspace() {
  return (
    <TooltipProvider>
      <ReactFlowProvider>
        <Workspace />
      </ReactFlowProvider>
    </TooltipProvider>
  );
}

function incomingNodes(
  document: CanvasDocument,
  nodeId: string | null | undefined,
) {
  return incomingReferenceNodes(document, nodeId);
}

function Workspace() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const flow = useReactFlow<FlowNode, Edge>();
  const [history, setHistory] = useState<CanvasHistory>(() =>
    createHistory(createDocument()),
  );
  const historyRef = useRef(history);
  historyRef.current = history;
  const doc = history.present;
  const versionCounts = useNodeVersionCounts(doc.id);
  const [versionHistory, setVersionHistory] = useState<{
    projectId: string;
    itemId: string;
    anchor: DOMRect;
    preparation: Promise<void>;
  } | null>(null);
  const [ready, setReady] = useState(false);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  const [initializationError, setInitializationError] = useState("");
  const [projectDialog, setProjectDialog] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [projectRenaming, setProjectRenaming] = useState(false);
  const [switching, setSwitching] = useState(false);
  const switchPending = useRef(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [selectedEdges, setSelectedEdges] = useState<string[]>([]);
  // React Flow's measured geometry is UI state, independent of authored dimensions.
  const [measurements, setMeasurements] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const selectionAtPointerDown = useRef<string[]>([]);
  const pointerGesture = useRef(new CanvasPointerGesture());
  const [interacting, setInteracting] = useState(false);
  const [textEditingId, setTextEditingId] = useState<string | null>(null);
  const [composerNodeId, setComposerNodeId] = useState<string | null>(null);
  const [dismissedComposer, setDismissedComposer] = useState<string | null>(
    null,
  );
  const [expandedComposerId, setExpandedComposerId] = useState<string | null>(
    null,
  );
  // The assistant picker is read once per new node (see snapshotModel); it is
  // never consulted again for nodes already on the canvas.
  const [assistantModels, setAssistantModels] = useState<ModelSelections>({});
  const [panel, setPanel] = useState<Panel>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [subjectImport, setSubjectImport] = useState<{
    projectId: string;
    nodeId: string;
    slot: SubjectMediaSlot;
    tab: SubjectImportTab;
    identity: string;
  } | null>(null);
  const [subjectLibraryBusy, setSubjectLibraryBusy] = useState(false);
  const [zoomMenu, setZoomMenu] = useState(false);
  const [hand, setHand] = useState(false);
  const [toolRevision, setToolRevision] = useState(0);
  const [minimap, setMinimap] = useState(false);
  const [showEdges, setShowEdges] = useState(true);
  const flowSurface = useRef<CanvasFlowSurfaceHandle>(null);
  const dragging = useRef(false);
  const bypassSnapping = useRef(false);
  const connectionStarted = useRef<Point | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [saveStatus, setSaveStatus] = useState("正在打开…");
  const { notifications, notify, dismiss } = useCanvasNotifications();
  const [preview, setPreview] = useState<CanvasNode | null>(null);
  const [editing, setEditing] = useState<CanvasNode | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>("default");
  const editorOrigin = useRef<ResultSource | null>(null);
  const mediaPublications = useRef(
    new WeakMap<ResultSource, MediaPublication>(),
  );
  const editorSession = useRef<CreationEditorSession | null>(null);
  const editorSaving = useRef(false);
  const [actionSession, setActionSession] = useState<
    (ResultSource & { tool: CanvasToolId; token: string }) | null
  >(null);
  const actionSessionRef = useRef(actionSession);
  actionSessionRef.current = actionSession;
  const [actionMedia, setActionMedia] = useState<HTMLDivElement | null>(null);
  const quickAction = useRef<AbortController | null>(null);
  const [maskTool, setMaskTool] = useState<CanvasToolId>("cutout");
  const resultInput = useRef<HTMLInputElement>(null);
  const resultBinding = useRef<
    | (ResultSource & {
        actionToken?: string;
        task?: CanvasToolTask;
      })
    | null
  >(null);
  const importAbort = useRef<AbortController | null>(null);
  const [rename, setRename] = useState<{ id: string; value: string } | null>(
    null,
  );
  const [help, setHelp] = useState(false);
  const backendCatalog = useBackendModels();
  const selectionSource = useRef<{
    documentId: string;
    nodeId: string;
    src: string;
    assetId: string;
  } | null>(null);
  const [jobs, setJobs, readJobs] = useGenerationJobs(
    doc.id,
    notify,
    ready && backendCatalog.connected,
  );
  const toolCatalog = useToolCatalog(
    backendCatalog.connected,
    backendCatalog.models,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [businessHistory, setBusinessHistory] = useState({
    undo: false,
    redo: false,
  });
  const [settingsCategory, setSettingsCategory] = useState<
    "general" | "models"
  >("general");
  const theme = useTheme();
  const serviceRuns = useRef(new Map<string, ServiceRun>());
  const [activeGenerations, setActiveGenerations] = useState<
    ActiveGeneration[]
  >([]);
  const generationByNode = useMemo(
    () =>
      generationActivities(
        [
          ...activeGenerations.filter(
            (run) =>
              !jobs.some(
                (job) =>
                  !job.tool &&
                  job.nodeId === run.nodeId &&
                  job.status === "running",
              ),
          ),
          ...jobActivities(
            jobs.filter((job) => !job.tool),
            doc.id,
          ),
          ...jobActivities(
            jobs.filter((job) => job.tool),
            doc.id,
          ),
        ],
        doc.id,
      ),
    [activeGenerations, doc.id, jobs],
  );
  const [arrivingNodes, setArrivingNodes] = useState<ReadonlySet<string>>(
    new Set(),
  );
  useEffect(() => {
    if (!arrivingNodes.size) return;
    const timer = window.setTimeout(() => setArrivingNodes(new Set()), 1200);
    return () => window.clearTimeout(timer);
  }, [arrivingNodes]);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantSelectionRequest, setAssistantSelectionRequest] = useState(0);
  const clipboard = useRef<CanvasFragment | null>(null);
  const pasteCount = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<string | null>(null);
  const uploadSource = useRef<{
    projectId: string;
    node: CanvasNode;
    subjectSlot?: SubjectMediaSlot;
  } | null>(null);
  const referenceTarget = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const assistantLayout = useAssistantLayout(root, assistantOpen, () => {
    setAssistantOpen(false);
    requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLButtonElement>(".cw-chat-button")
        ?.focus(),
    );
  });
  const toolbarElement = useRef<HTMLDivElement>(null);
  const composerElement = useRef<HTMLDivElement>(null);
  const [presentationFocus, setPresentationFocus] = useState(0);
  const focusSelection = (id: string) => {
    setComposerNodeId(id);
    setPresentationFocus((value) => value + 1);
  };
  const saveQueue = useRef(Promise.resolve(true));
  const saveError = useRef("");
  const [zoom, setZoom] = useState(1);
  const spacePressed = useKeyPress("Space");
  const panning = hand || spacePressed;
  const single =
    selected.length === 1
      ? (doc.nodes.find((n) => n.id === selected[0]) ?? null)
      : null;
  // Keep the existing generator mounted while manipulating the canvas. Selection
  // can change on pointerdown; it must not mount a different panel mid-gesture.
  useEffect(() => {
    if (!interacting) setComposerNodeId(single?.id ?? null);
  }, [single?.id, interacting]);
  const composerNode = doc.nodes.find((node) => node.id === composerNodeId);
  useEffect(() => {
    setExpandedComposerId(null);
  }, [doc.id, composerNode?.id]);
  const composerIncoming = useMemo(
    () => incomingNodes(doc, composerNodeId),
    [doc.nodes, doc.hiddenNodes, doc.edges, composerNodeId],
  );
  const referenceAssets = useProjectMentionAssets(doc.id, ready);
  const generationReferenceControls = (
    target: CanvasNode,
  ): GenerationReferenceControls => ({
    projectId: doc.id,
    nodes: [...doc.nodes, ...(doc.hiddenNodes ?? [])],
    visibleNodes: doc.nodes,
    assets: referenceAssets.assets,
    pinned: (() => {
      const snapshot = creationClient(doc.id).snapshot;
      const item = snapshot?.canvasItems.find((item) => item.id === target.id);
      const spec = item && itemSpec(snapshot, item);
      return snapshot && spec ? pinnedReferenceAssets(snapshot, spec.id) : [];
    })(),
    referenceId: (source) =>
      doc.edges.find(
        (edge) =>
          edge.intent !== "post_edit_result" &&
          edge.referenceBinding !== "pinned" &&
          edge.source === source &&
          edge.target === target.id,
      )?.id,
    issue: (source) => {
      const current = historyRef.current.present;
      const issue = referenceIssue(
        {
          ...current,
          nodes: [
            ...current.nodes,
            ...(current.hiddenNodes ?? []),
            ...(!current.nodes.some((node) => node.id === source.id) &&
            !current.hiddenNodes?.some((node) => node.id === source.id)
              ? [source]
              : []),
          ],
          hiddenNodes: [],
        },
        source.id,
        target.id,
      );
      return issue && issue !== "duplicate_relation"
        ? REFERENCE_ISSUE_TEXT[issue]
        : null;
    },
    prepareAsset: async (asset, signal) => {
      const bytes = await creationClient(doc.id).blob(asset.id);
      signal.throwIfAborted();
      if (!fingerprintMatches(asset, await fingerprint(bytes)))
        throw new Error("参考素材文件已改变，请重新核对版本。");
      {
        const client = creationClient(doc.id);
        const record = client.snapshot.assets.find(
          (item) => item.id === asset.id,
        );
        if (!record) throw new Error("素材已不存在。");
        signal.throwIfAborted();
        return record.kind === "text"
          ? { text: await client.textContent(record.id) }
          : { src: await client.mediaUrl(record.id, { signal }) };
      }
    },
    onChange: (content, sources) => {
      const current = historyRef.current.present;
      if (current.id !== doc.id || lockedNodeIds(current.nodes).has(target.id))
        throw new Error("项目或目标锁定状态已变化，本批引用未插入。");
      const edit = referenceContentCommand(
        current,
        target.id,
        content,
        sources,
      );
      command(edit);
    },
  });
  const actionSource = actionSession
    ? validateNodeActionSource(doc, actionSession)
    : null;
  const actionNode =
    actionSource &&
    "node" in actionSource &&
    single?.id === actionSession?.nodeId
      ? actionSource.node
      : undefined;
  const activeAction = actionNode ? actionSession : null;
  useEffect(() => {
    if (actionSession && !actionNode) setActionSession(null);
  }, [actionSession, actionNode]);
  useEffect(() => () => quickAction.current?.abort(), [doc.id]);
  const command = useCallback(
    (value: CanvasCommand) => setHistory((h) => executeCommand(h, value)),
    [],
  );
  const change = useCallback(
    (fn: (document: CanvasDocument) => CanvasDocument) =>
      setHistory((h) => recordChange(h, fn(h.present))),
    [],
  );
  const begin = useCallback(() => setHistory(beginTransaction), []);
  const end = useCallback(() => setHistory(commitTransaction), []);
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
  const showAssistant = () => {
    setPanel(null);
    setAssistantOpen(true);
    if (selected.length) setAssistantSelectionRequest((n) => n + 1);
  };
  const togglePanel = (value: Panel) => {
    setAssistantOpen(false);
    referenceTarget.current = null;
    setPanel((p) => (p === value ? null : value));
    setMenu(null);
  };

  /** Copies a picked resource onto the current canvas as independent nodes. */
  const importCanvasResource = async (resource: CanvasResource) => {
    const current = historyRef.current.present;
    const where = center();
    const node = createNode(
      resource.kind,
      { x: where.x - 160, y: where.y - 140 },
      resourceNodeData(resource),
    );
    const next = applyCommand(current, { type: "add-nodes", nodes: [node] });
    if (!(await persist(next)))
      throw new Error(saveError.current || "导入未能保存。");
    if (historyRef.current.present.id !== current.id) return;
    change((latest) => mergeLibrarySubjectImport(latest, current, next));
    setSelected([node.id]);
    referenceTarget.current = null;
    setPanel(null);
    notify("素材已复制到当前画布，可独立编辑。");
  };

  const insertLibraryItems = async (items: LibraryItem[]) => {
    const client = creationClient(doc.id);
    let placed = 0;
    const issues: string[] = [];
    for (const item of items) {
      try {
        const blob = await itemBlob(item);
        const resource = itemToResource(item);
        // The backend identifies uploads by suffix, and library items made from
        // canvas nodes carry a bare title ("图片 1"), so complete the name.
        const name = withMediaSuffix(
          item.name,
          item.metadata?.mimeType || blob.type,
        );
        // The library blob must become a canvas-owned asset before a node
        // can reference it, so the copy survives independently of the library.
        const ref = await client.importBlob(blob, name, resource.kind);
        resource.assetId = ref.assetId;
        resource.src = await client.mediaUrl(ref.assetId);

        await importCanvasResource(resource);
        placed += 1;
      } catch (reason) {
        issues.push(`${item.name}：${String(reason)}`);
      }
    }
    if (!placed) throw new Error(issues.join("；") || "没有素材可以放入画布。");
    if (issues.length) notify(`部分素材未能放入画布：${issues.join("；")}`);
  };

  const persist = useCallback(
    (snapshot: CanvasDocument, saveView = true): Promise<boolean> => {
      saveQueue.current = saveQueue.current
        .then(async () => {
          await saveWorkspaceDocument(snapshot, { saveView });
          saveError.current = "";
          if (historyRef.current.present === snapshot) {
            const warning = workspaceProjection(snapshot.id).viewError;
            setSaveStatus(
              warning
                ? `工程已保存；界面状态保存失败：${warning}`
                : "已保存到本机",
            );
          }
          return true;
        })
        .catch((error) => {
          saveError.current = errorMessage(error);
          setSaveStatus(`保存失败：${String(error)}`);
          return false;
        });
      return saveQueue.current;
    },
    [],
  );
  const importLibrarySubjects = async (items: LibraryItem[]) => {
    if (subjectLibraryBusy || switchPending.current)
      throw new Error("请等待当前操作完成。");
    const projectId = historyRef.current.present.id;
    setSubjectLibraryBusy(true);
    try {
      if (
        !(await persistCurrentDocument(
          () => historyRef.current.present,
          persist,
        ))
      )
        throw new Error("画布未保存，主体尚未导入。");
      const copies = await copyLibrarySubjects(projectId, items);
      const current = historyRef.current.present;
      if (current.id !== projectId || switchPending.current)
        throw new Error("项目已切换，本次导入未应用。");
      const operation = librarySubjectCommand(
        current,
        copies.map((copy) => ({
          title: copy.item.name,
          subject: copy.subject,
        })),
        center(),
        undefined,
        (subject, width) =>
          measureSubjectNodeHeight(
            subject,
            width,
            getComputedStyle(root.current!).fontFamily,
          ),
      );
      const next = applyCommand(current, operation);
      // Publish the complete subject only after its project transaction succeeds.
      if (!(await persist(next)))
        throw new Error(
          saveError.current || "主体导入未能保存，画布内容保持原状。",
        );
      if (historyRef.current.present.id !== projectId) return;
      change((latest) => mergeLibrarySubjectImport(latest, current, next));
      const previousIds = new Set(current.nodes.map((node) => node.id));
      setSelected(
        next.nodes
          .filter((node) => !previousIds.has(node.id))
          .map((node) => node.id),
      );
      notify(`已导入 ${copies.length} 个主体到画布。`);
    } finally {
      setSubjectLibraryBusy(false);
    }
  };

  const confirmSubjectImport = async (choice: SubjectImportChoice) => {
    const intent = subjectImport;
    if (!intent || subjectLibraryBusy || switchPending.current)
      throw new Error("请等待当前操作完成。");
    const assertTarget = () => {
      const current = historyRef.current.present;
      const { node, issue } = subjectImportSelection(current, [intent.nodeId]);
      if (
        current.id !== intent.projectId ||
        issue ||
        !node ||
        subjectTargetIdentity(node) !== intent.identity
      )
        throw new Error(issue || "目标主体已变化，请重新打开导入界面。");
      return { current, node };
    };
    assertTarget();
    setSubjectLibraryBusy(true);
    try {
      if (
        !(await persistCurrentDocument(
          () => historyRef.current.present,
          persist,
        ))
      )
        throw new Error("请先保存当前画布。");
      let source: import("./model").SubjectData;
      const complete =
        choice.tab === "subjects" ||
        (choice.tab === "canvas" && choice.item.kind === "subject");
      if (choice.tab === "subjects")
        source = (
          await copyLibrarySubjects(intent.projectId, [choice.item])
        )[0]!.subject;
      else {
        const copied =
          choice.tab === "assets"
            ? {
                resource: await copySubjectAsset(
                  intent.projectId,
                  choice.item,
                  intent.slot,
                ),
                subject: undefined,
              }
            : await copyCanvasSource(
                intent.projectId,
                intent.projectId,
                choice.item as CanvasSource,
                intent.slot,
              );
        const { node } = assertTarget();
        source = complete
          ? copied.subject!
          : subjectWithResource(
              node.data.subject,
              copied.resource,
              intent.slot,
            );
      }
      const { current, node } = assertTarget();
      const next = applyCommand(
        current,
        librarySubjectCommand(
          current,
          [{ title: node.data.title, subject: source }],
          center(),
          node.id,
          (subject, width) =>
            measureSubjectNodeHeight(
              subject,
              width,
              getComputedStyle(root.current!).fontFamily,
            ),
        ),
      );
      if (!(await persist(next)))
        throw new Error(saveError.current || "主体导入未能保存。");
      if (historyRef.current.present.id === intent.projectId)
        change((latest) =>
          mergeLibrarySubjectImport(latest, current, next, node.id),
        );
      notify("已导入主体内容，可撤销。");
    } finally {
      setSubjectLibraryBusy(false);
    }
  };
  const importCanvasSource = async (
    originProjectId: string,
    source: CanvasSource,
  ) => {
    const projectId = historyRef.current.present.id;
    if (
      !(await persistCurrentDocument(() => historyRef.current.present, persist))
    )
      throw new Error("请先保存画布。");
    const copied = await copyCanvasSource(
      projectId,
      originProjectId,
      source,
      "main",
      false,
    );
    if (historyRef.current.present.id !== projectId)
      throw new Error("项目已切换。");
    if (copied.kind === "subject") {
      const current = historyRef.current.present;
      const next = applyCommand(
        current,
        librarySubjectCommand(
          current,
          [{ title: copied.title, subject: copied.subject }],
          center(),
          undefined,
          (subject, width) =>
            measureSubjectNodeHeight(
              subject,
              width,
              getComputedStyle(root.current!).fontFamily,
            ),
        ),
      );
      if (!(await persist(next)))
        throw new Error(saveError.current || "导入失败。");
      change((latest) => mergeLibrarySubjectImport(latest, current, next));
    } else await importCanvasResource(copied.resource);
  };

  const backupLibrarySubject = async () => {
    const current = historyRef.current.present;
    const node =
      selectedRef.current.length === 1
        ? current.nodes.find((node) => node.id === selectedRef.current[0])
        : undefined;
    if (!node || node.type !== "subject" || !node.data.subject?.main?.src)
      throw new Error("请选择一个有内容的主体节点。");
    if (subjectLibraryBusy || switchPending.current)
      throw new Error("请等待当前操作完成。");
    setSubjectLibraryBusy(true);
    try {
      if (
        !(await persistCurrentDocument(
          () => historyRef.current.present,
          persist,
        ))
      )
        throw new Error("请先保存当前画布。");
      if (historyRef.current.present.id !== current.id)
        throw new Error("项目已切换，请重新选择主体。");
      await backUpLibrarySubject(current.id, node.id);
    } finally {
      setSubjectLibraryBusy(false);
    }
  };

  const replayHistory = (forward = false) => {
    void (async () => {
      if (!(await persist(historyRef.current.present))) return;
      await creationClient(doc.id).undo(forward);
    })().catch((error) => notify(errorMessage(error)));
  };

  const installDocument = useCallback(
    (next: CanvasDocument, fit = false) => {
      importAbort.current?.abort();
      importAbort.current = null;
      resultBinding.current = null;
      setEditing(null);
      setActionSession(null);
      quickAction.current?.abort();
      setPreview(null);
      editorOrigin.current = null;
      referenceTarget.current = null;

      uploadTarget.current = null;
      setArrivingNodes(new Set());
      setHistory(createHistory(next));
      setMeasurements({});
      setSelected([]);
      setComposerNodeId(null);
      setTextEditingId(null);
      setDismissedComposer(null);
      setInteracting(false);
      pointerGesture.current.cancel();
      flowSurface.current?.cancel();
      setSelectedEdges([]);
      setPanel(null);
      setAssistantOpen(false);
      setAssistantSelectionRequest(0);
      setMenu(null);
      setRename(null);
      setZoomMenu(false);
      setHand(false);
      window.history.replaceState({}, "", `/${window.location.search}`);
      requestAnimationFrame(() => {
        void flow.setViewport(next.viewport);
        if (fit)
          requestAnimationFrame(
            () =>
              void flow.fitView({ padding: 0.25, maxZoom: 1, duration: 250 }),
          );
      });
    },
    [flow],
  );

  const switchDocument = useCallback(
    async (
      read: () => CanvasDocument | Promise<CanvasDocument>,
      fit = false,
      throwOnFailure = false,
    ) => {
      if (switchPending.current) return false;
      switchPending.current = true;
      setSwitching(true);
      // The workspace is inert until saving and loading finish, so later edits cannot be lost.
      importAbort.current?.abort();
      try {
        if (
          !(await persistCurrentDocument(
            () => historyRef.current.present,
            persist,
          ))
        ) {
          if (throwOnFailure) throw new Error("当前画布保存失败，未切换项目。");
          return false;
        }
        const next = await read();
        installDocument(next, fit);
        return true;
      } catch (error) {
        try {
          const current = historyRef.current.present;
          await openBackendProject(current.id, current.title);
        } catch (reopenError) {
          const message = `切换失败，原项目未能重新取得编辑权限：${errorMessage(reopenError)}`;
          if (throwOnFailure) throw new Error(message);
          notify(message);
          return false;
        }
        if (throwOnFailure) throw error;
        notify(error instanceof Error ? error.message : "无法打开画布。");
        return false;
      } finally {
        switchPending.current = false;
        setSwitching(false);
      }
    },
    [installDocument, persist, notify],
  );

  const renameCurrentProject = async (name: string) => {
    if (switchPending.current) throw new Error("项目正在保存，请稍后重试。");
    const projectId = historyRef.current.present.id;
    switchPending.current = true;
    setProjectRenaming(true);
    try {
      if (
        !(await persistCurrentDocument(
          () => historyRef.current.present,
          persist,
        ))
      )
        throw new Error("当前画布尚未保存，未执行重命名。");
      const project = (await listWorkspaceProjects()).projects.find(
        (item) => item.id === projectId,
      );
      if (!project) throw new Error("项目不存在，请重新打开。");
      const renamed = await renameWorkspaceProject(project, name);
      const document = { ...historyRef.current.present, title: renamed.name };
      // Project metadata must stay consistent across canvas undo/redo.
      setHistory((current) => ({
        ...current,
        present: { ...current.present, title: renamed.name },
        past: current.past.map((item) => ({ ...item, title: renamed.name })),
        future: current.future.map((item) => ({
          ...item,
          title: renamed.name,
        })),
        transaction: current.transaction
          ? { ...current.transaction, title: renamed.name }
          : null,
      }));
      await saveWorkspaceDocument(document);
    } finally {
      switchPending.current = false;
      setProjectRenaming(false);
    }
  };

  useEffect(() => {
    let alive = true;
    const init = async () => {
      try {
        const document = await initializeWorkspace();
        if (!alive) return;
        installDocument(document);
        setReady(true);
      } catch (error) {
        if (alive) setInitializationError(errorMessage(error));
      }
    };
    void init();
    return () => {
      alive = false;
      importAbort.current?.abort();
    };
  }, [installDocument, notify]);
  useEffect(() => {
    if (!ready || switching || projectRenaming) return;
    setSaveStatus("保存中…");
    const timeout = setTimeout(() => {
      if (!switchPending.current && !editorSaving.current) void persist(doc);
    }, 450);
    return () => clearTimeout(timeout);
  }, [doc, ready, switching, projectRenaming, persist]);
  useEffect(() => {
    if (!ready) return;
    const client = creationClient(doc.id),
      projection = workspaceProjection(doc.id);
    let active = true,
      token = 0;
    const update = () => {
      const current = historyRef.current.present;
      const clean =
        projection.baseline &&
        JSON.stringify([current.nodes, current.edges]) ===
          JSON.stringify([
            projection.baseline.nodes,
            projection.baseline.edges,
          ]);
      if (!clean || editorSaving.current) return; // Keep drafts and their original CAS basis.
      const ticket = ++token,
        snapshot = client.snapshot;
      void projection
        .read(snapshot)
        .then((next) => {
          if (
            !active ||
            ticket !== token ||
            historyRef.current.present !== current
          )
            return;
          if (
            next.title === current.title &&
            JSON.stringify([next.nodes, next.edges]) ===
              JSON.stringify([current.nodes, current.edges])
          ) {
            projection.baseline = current;
            projection.basis = snapshot;
            return;
          }
          const merged = {
            ...next,
            viewport: current.viewport,
            settings: current.settings,
          };
          projection.baseline = merged;
          projection.basis = snapshot;
          setHistory((history) => ({ ...history, present: merged }));
        })
        .catch((error) => active && notify(errorMessage(error)));
    };
    const unsubscribe = client.listen(update);
    update();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [doc.id, ready, notify]);
  useEffect(() => {
    if (!ready) return;
    let active = true,
      sequence = 0;
    const refresh = () => {
      const ticket = ++sequence;
      void apiRequest<{ state: string }[]>(
        `/creation/projects/${doc.id}/history`,
      )
        .then((entries) => {
          if (active && sequence === ticket)
            setBusinessHistory({
              undo: entries.some((entry) => entry.state === "applied"),
              redo: entries.some((entry) => entry.state === "undone"),
            });
        })
        .catch((error) => active && notify(errorMessage(error)));
    };
    const unsubscribe = creationClient(doc.id).listen(refresh);
    refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [doc.id, ready, notify]);
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
  useEffect(() => {
    const input = fileInput.current;
    const result = resultInput.current;
    const cancelUpload = () => {
      uploadTarget.current = null;
    };
    input?.addEventListener("cancel", cancelUpload);
    const cancelResult = () => {
      resultBinding.current = null;
    };
    result?.addEventListener("cancel", cancelResult);
    return () => {
      input?.removeEventListener("cancel", cancelUpload);
      result?.removeEventListener("cancel", cancelResult);
    };
  }, []);
  useEffect(() => {
    const flush = () => {
      setPageVisible(!document.hidden);
      if (document.visibilityState === "hidden" && ready)
        void persist(historyRef.current.present);
    };
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, [persist, ready]);

  const center = (): Point =>
    flow.screenToFlowPosition({
      x: window.innerWidth / 2 - (panel ? 150 : 0),
      y: window.innerHeight * 0.32,
    });
  // A node freezes the dialog's model at creation. Changing the picker later
  // must not rewrite a model the viewer already has on the canvas, so this is
  // the only place the assistant selection is read.
  const snapshotModel = (kind: CanvasNodeKind): Partial<CanvasNodeData> => {
    if (kind === "text") {
      const agents = backendCatalog.models.filter(
        (model) => model.kind === "agent",
      );
      const chosen =
        agents.find((model) => model.id === assistantModels.agent) ??
        agents[0];
      return chosen
        ? {
            agentSettings: {
              modelConfigId: chosen.id,
              thinking: "auto",
              maxTokens: 8192,
            },
          }
        : {};
    }
    if (kind !== "image" && kind !== "video" && kind !== "audio") return {};
    const settings = applyModelResolution(
      generationDefaults(kind),
      resolveGenerationModel(
        { modelConfigId: undefined },
        kind,
        backendCatalog.models,
        assistantModels,
      ),
    );
    const config = backendModel(settings, backendCatalog.models);
    return {
      settings: config ? serviceAudioSettings(settings, config) : settings,
    };
  };
  const addNode = (
    kind: CanvasNodeKind,
    position?: Point,
    extra: Partial<CanvasNodeData> = {},
  ) => {
    const connected = position ? menu?.connected : undefined;
    const source =
      connected?.direction === "source"
        ? historyRef.current.present.nodes.find(
            (node) => node.id === connected.id,
          )
        : undefined;
    if (source && canStartReference(source) && !referenceMaterial(source)) {
      setMenu(null);
      notify(REFERENCE_ISSUE_TEXT.source_empty);
      return;
    }
    if (
      connected &&
      !connectedCreationKinds(
        historyRef.current.present,
        connected.id,
        connected.direction,
        [kind],
      ).length
    ) {
      setMenu(null);
      notify("该类型不能与当前节点建立参考关系。");
      return;
    }
    const where = position ?? center();
    const count = doc.nodes.filter((n) => n.type === kind).length + 1;
    const node = createNode(kind, where, {
      ...snapshotModel(kind),
      title: `${labels[kind]} ${count}`,
      ...extra,
    });
    if (kind === "timeline") node.width = 720;
    node.position = {
      x: where.x - node.width / 2,
      y: where.y - node.height / 2,
    };
    if (connected) {
      // The dropped endpoint becomes the new node's input/output port.
      node.position = {
        x: where.x - (connected.direction === "target" ? node.width : 0),
        y: where.y - node.height / 2,
      };
      if (connected.side === "left")
        node.position = {
          x: where.x - node.width,
          y: where.y - node.height / 2,
        };
      if (connected.side === "top")
        node.position = {
          x: where.x - node.width / 2,
          y: where.y - node.height,
        };
      if (connected.side === "bottom")
        node.position = { x: where.x - node.width / 2, y: where.y };
    }
    if (menu?.parentId) {
      const parent = doc.nodes.find(
        (candidate) => candidate.id === menu.parentId,
      );
      if (parent) {
        const origin = absolutePosition(parent, doc.nodes);
        node.parentId = parent.id;
        node.position = {
          x: node.position.x - origin.x,
          y: node.position.y - origin.y,
        };
      }
    }
    const commands: CanvasCommand[] = [{ type: "add-nodes", nodes: [node] }];
    if (connected)
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
  /** Reference pickers connect what the policy allows and name what it refused. */
  const referenceEdges = (
    sources: readonly string[],
    target: string,
    added: readonly CanvasNode[] = [],
  ) => {
    const present = historyRef.current.present;
    const working = {
      nodes: [...present.nodes, ...(present.hiddenNodes ?? []), ...added],
      edges: [...present.edges],
    };
    const issues = new Set<string>();
    for (const source of sources) {
      const issue = referenceIssue(working, source, target);
      if (issue) issues.add(REFERENCE_ISSUE_TEXT[issue]);
      else working.edges.push({ id: crypto.randomUUID(), source, target });
    }
    return {
      commands: working.edges
        .slice(present.edges.length)
        .map((edge): CanvasCommand => ({ type: "add-edge", edge })),
      issue: issues.size ? `未连接为参考：${[...issues].join("、")}。` : "",
    };
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
    if (spacePressed || pointerGesture.current.cancelled) return;
    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    if (
      !point ||
      !start ||
      (!pointerGesture.current.moved &&
        Math.hypot(point.clientX - start.x, point.clientY - start.y) <= 4)
    )
      return;
    if (state.isValid || !state.fromNode || !state.fromHandle) return;
    const target = document.elementFromPoint(point.clientX, point.clientY);
    const targetId = target
      ?.closest(".react-flow__node")
      ?.getAttribute("data-id");
    const group = doc.nodes.find(
      (node) =>
        node.id === targetId &&
        node.type === "group" &&
        !lockedIds.has(node.id),
    );
    if (state.toNode && state.toNode.id !== group?.id) return;
    if (!group && !target?.classList.contains("react-flow__pane")) return;
    setMenu({
      x: point.clientX,
      y: point.clientY,
      world: flow.screenToFlowPosition({ x: point.clientX, y: point.clientY }),
      connected: { id: state.fromNode.id, direction: state.fromHandle.type },
      parentId: group?.id,
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
      const selections = changes.filter((c) => c.type === "select");
      if (selections.length)
        setSelected((ids) => {
          const next = new Set(ids);
          for (const c of selections)
            if (c.type === "select") {
              if (c.selected) next.add(c.id);
              else next.delete(c.id);
            }
          return [...next];
        });
      const patches: CanvasCommand[] = [];
      // XYFlow may still deliver a final move/resize after cancellation.
      if (pointerGesture.current.cancelled) return;
      // Capture the grab offset immediately, but do not author a move inside
      // click tolerance (or let that jitter snap a node to a nearby guide).
      if (dragging.current && !pointerGesture.current.moved) return;
      const resize = changes.find(
        (c) => c.type === "dimensions" && c.dimensions && c.setAttributes,
      );
      if (resize?.type === "dimensions" && resize.dimensions) {
        const move = changes.find(
          (c) => c.type === "position" && c.id === resize.id,
        );
        // The document owns child-coordinate compensation, including locked children.
        // Do not apply React Flow's child position patches a second time.
        command({
          type: "resize-node",
          id: resize.id,
          ...resize.dimensions,
          ...(move?.type === "position" && move.position
            ? { position: move.position }
            : {}),
        });
        return;
      }
      const positions = changes.flatMap((c) =>
        c.type === "position" && c.position
          ? [{ id: c.id, position: c.position }]
          : [],
      );
      for (const { id, position } of positions)
        patches.push({ type: "update-node", id, patch: { position } });
      if (patches.length) command({ type: "batch", commands: patches });
    },
    [command, flow],
  );
  const lockedIds = useMemo(() => lockedNodeIds(doc.nodes), [doc.nodes]);
  const references = useCanvasReferences({
    nodes: doc.nodes.filter(
      (n) =>
        !doc.nodes.some(
          (s) => s.type === "stack" && s.data.stack?.nodeIds.includes(n.id),
        ),
    ),
    zoom,
    locked: lockedIds,
    disabled:
      spacePressed ||
      switching ||
      !ready ||
      Boolean(editing || preview || activeAction || textEditingId) ||
      dragging.current,
    world: (point) => flow.screenToFlowPosition(point),
    connect: (source, target) => {
      const current = historyRef.current.present;
      const node = current.nodes.find((node) => node.id === source);
      if (node && canStartReference(node) && !referenceMaterial(node)) {
        notify(REFERENCE_ISSUE_TEXT.source_empty);
        return;
      }
      const issue = referenceIssue(current, source, target);
      if (issue) {
        notify(REFERENCE_ISSUE_TEXT[issue]);
        return;
      }
      command({
        type: "add-edge",
        edge: {
          id: crypto.randomUUID(),
          source,
          target,
          sourceHandle: "out",
          targetHandle: "in",
        },
      });
      setSelected([target]);
      setSelectedEdges([]);
      setDismissedComposer(null);
    },
    create: (source, side, client, world, anchor) => {
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
        connected: { id: source, direction: "source", side, anchor },
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
    controlsKey: `${hasComposer}:${hasToolbar}:${composerExpanded}:${activeAction?.token ?? ""}:${activeAction?.tool === "outpaint" ? JSON.stringify(presentationBounds) : ""}`,
  });
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
        ariaLabel: `${labels[n.type]}节点：${n.data.title}`,
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
          ariaLabel: "参考连线",
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
              hoveredNode !== null
                ? hoveredNode === edge.source || hoveredNode === edge.target
                : selectedEdges.includes(edge.id) ||
                  selected.includes(edge.source) ||
                  selected.includes(edge.target),
          },
        };
      }),
    };
  }, [flowNodes, flowEdges, doc.nodes, selected, selectedEdges, hoveredNode]);

  const removeSelected = () => {
    command({
      type: "batch",
      commands: [
        { type: "hide-nodes", ids: selectedRef.current },
        { type: "remove-edges", ids: selectedEdges },
      ],
    });
    setSelected([]);
    setSelectedEdges([]);
    setMenu(null);
  };
  const copy = () => {
    clipboard.current = copySelection(
      historyRef.current.present,
      selectedRef.current,
    );
    pasteCount.current = 0;
    notify(`已复制 ${clipboard.current.nodes.length} 个节点`);
  };
  const cut = () => {
    const movable = selectedRef.current.filter((id) => !lockedIds.has(id));
    if (!movable.length) {
      notify("请先选择可编辑的节点。");
      return;
    }
    const result = cutSelection(historyRef.current.present, movable);
    if (!result.fragment) {
      notify("节点或其成员受锁定引用保护，未剪切。");
      return;
    }
    const fragment = result.fragment;
    change(() => result.document);
    clipboard.current = fragment;
    pasteCount.current = 0;
    setSelected([]);
    setMenu(null);
    notify(`已剪切 ${fragment.nodes.length} 个节点，可粘贴或撤销。`);
  };
  const paste = (duplicate = false) => {
    const fragment = duplicate
      ? copySelection(historyRef.current.present, selectedRef.current)
      : clipboard.current;
    if (!fragment?.nodes.length) return;
    const distance = 40 * (duplicate ? 1 : ++pasteCount.current);
    const result = pasteFragment(historyRef.current.present, fragment, {
      x: distance,
      y: distance,
    });
    change(() => result.document);
    setSelected(result.ids);
    setMenu(null);
  };
  const group = () => {
    change((d) => groupSelection(d, selectedRef.current));
    setSelected([]);
    setMenu(null);
  };
  const ungroup = () => {
    change((d) => ungroupSelection(d, selectedRef.current));
    setSelected([]);
    setMenu(null);
  };
  const downloadNode = (node: CanvasNode) => {
    try {
      if (node.data.src)
        downloadFile(
          node.data.src,
          downloadFilename(node.data.title, node.data.mimeType),
        );
      else if (node.type === "text")
        downloadFile(
          new Blob([node.data.text ?? ""], {
            type: "text/plain;charset=utf-8",
          }),
          downloadFilename(node.data.title, "text/plain"),
        );
      else notify("这个节点还没有可下载的素材。");
    } catch (error) {
      notify(error instanceof Error ? error.message : "无法下载素材，请重试。");
    }
  };
  const exportDocument = async () => {
    try {
      const current = historyRef.current.present;
      const result = serializeDocument(await portableDocument(current));
      if (!result.ok) {
        notify(result.error.message);
        return;
      }
      downloadFile(
        new Blob([result.value], { type: "application/json" }),
        `${doc.title}.canvas.json`,
      );
    } catch (error) {
      notify(errorMessage(error));
    }
  };
  const openFilePicker = (
    id: string | null = null,
    subjectSlot?: SubjectMediaSlot,
  ) => {
    if (id && lockedIds.has(id)) {
      notify("请先解锁节点或所属分组。");
      return;
    }
    const selected = historyRef.current.present.nodes.find(
      (node) => node.id === id,
    );
    if (
      selected?.data.src &&
      selected.data.mediaRole === "generation" &&
      selected.type !== "text"
    ) {
      notify("生成节点不能上传替换本体素材，请新建素材节点。");
      return;
    }
    if (id && generationByNode.has(id)) {
      notify("节点正在生成，请先等待或取消任务。");
      return;
    }
    uploadTarget.current = id;
    uploadSource.current = selected
      ? {
          projectId: historyRef.current.present.id,
          node: selected,
          subjectSlot,
        }
      : null;
    if (fileInput.current) {
      fileInput.current.multiple = !id;
      fileInput.current.accept =
        selected?.type === "text"
          ? ".txt,.md,.markdown"
          : selected?.type === "subject"
            ? subjectSlot === "auxiliary"
              ? "image/*"
              : subjectSlot === "voice"
                ? "audio/*"
                : "image/*,video/*"
            : selected && ["image", "video", "audio"].includes(selected.type)
              ? `${selected.type}/*`
              : "";
    }
    fileInput.current?.click();
  };
  const importFiles = async (files: File[], point?: Point) => {
    const target = uploadTarget.current;
    const expected = target ? uploadSource.current : null;
    uploadSource.current = null;
    uploadTarget.current = null;
    let refTarget = referenceTarget.current;
    const importDocumentId = historyRef.current.present.id;
    referenceTarget.current = null;
    const controller = new AbortController();
    importAbort.current?.abort();
    importAbort.current = controller;
    try {
      if (target && files.length !== 1)
        throw new Error("替换单个节点时请选择一个文件。");
      if (
        target &&
        (!expected ||
          expected.projectId !== importDocumentId ||
          expected.node.id !== target)
      )
        throw new Error("上传目标已变化，请重新选择节点。");
      const nodes: CanvasNode[] = [];
      const commands: CanvasCommand[] = [];
      const origin = point ?? center();
      const { successes, failures } = await readImportBatch(
        files,
        async (file, signal) => {
          const validate = (kind: CanvasResource["kind"]) =>
            assertUpload(
              kind,
              !target
                ? "create"
                : expected!.node.type === "subject"
                  ? `subject-${expected!.subjectSlot ?? (kind === "audio" ? "voice" : "main")}`
                  : "replace",
              expected?.node.type,
            );
          validate(classifyImportFile(file).kind);
          let resource = await readEditorResource(file, signal);
          validate(resource.kind);
          if (expected?.node.type === "subject") {
            // Validate the slot before registering, then retain the canonical
            // project resource so a later projection cannot change its identity.
            subjectWithResource(
              expected.node.data.subject,
              resource,
              expected.subjectSlot,
            );
            {
              const ref = await creationClient(importDocumentId).importBlob(
                file,
                file.name,
                resource.kind,
              );
              resource =
                await workspaceProjection(importDocumentId).resource(ref);
              subjectWithResource(
                expected.node.data.subject,
                resource,
                expected.subjectSlot,
              );
            }
          }
          return resource;
        },
        controller.signal,
      );
      if (target && failures.length) throw new Error(failures[0]!.message);
      for (const { index: i, value: resource } of successes) {
        const kind = resource.kind;
        const data = resourceNodeData(resource);
        if (target && i === 0) {
          const currentTarget = historyRef.current.present.nodes.find(
            (n) => n.id === target,
          );
          if (currentTarget?.type === "subject") {
            if (!["image", "video", "audio"].includes(resource.kind))
              throw new Error("主体需要图片、视频或音频素材。");
            commands.push({
              type: "update-node",
              id: target,
              patch: {
                data: {
                  subject: subjectWithResource(
                    currentTarget.data.subject,
                    resource,
                    expected?.subjectSlot,
                  ),
                },
              },
            });
            continue;
          }
          commands.push({
            type: "update-node",
            id: target,
            patch: { data },
          });
          continue;
        }
        const node = createNode(
          kind,
          { x: origin.x - 176 + i * 400, y: origin.y - 130 },
          data,
        );
        nodes.push(node);
      }
      if (controller.signal.aborted) return;
      if (target && expected) {
        const latest = historyRef.current.present.nodes.find(
          (node) => node.id === target,
        );
        if (
          !latest ||
          latest.type !== expected.node.type ||
          !sameNodeData(latest.data, expected.node.data) ||
          lockedNodeIds(historyRef.current.present.nodes).has(target)
        )
          throw new Error("节点内容、类型或锁定状态已变化，本次上传未应用。");
      }
      if (historyRef.current.present.id !== importDocumentId) {
        notify("已切换项目，本次素材导入已取消。");
        return;
      }
      if (
        target &&
        !historyRef.current.present.nodes.some((n) => n.id === target)
      ) {
        notify("目标节点已被删除，本次素材导入已取消。");
        return;
      }
      if (
        refTarget &&
        !historyRef.current.present.nodes.some((n) => n.id === refTarget)
      )
        refTarget = null;
      if (nodes.length) commands.unshift({ type: "add-nodes", nodes });
      const linked = refTarget
        ? referenceEdges(
            nodes.map((node) => node.id),
            refTarget,
            nodes,
          )
        : { commands: [], issue: "" };
      commands.push(...linked.commands);
      if (commands.length) command({ type: "batch", commands });
      setSelected(
        target ? [target] : refTarget ? [refTarget] : nodes.map((n) => n.id),
      );
      notify(
        `已导入 ${successes.length} 个素材${failures.length ? `；${failures.length} 个失败：${failures.map((item) => `${item.name}（${item.message}）`).join("；")}` : "，保存在本机。"}${linked.issue}`,
      );
    } catch (error) {
      if (!controller.signal.aborted)
        notify(error instanceof Error ? error.message : "素材导入失败");
    } finally {
      if (importAbort.current === controller) importAbort.current = null;
    }
  };

  const resources = useMemo(
    () =>
      doc.nodes.flatMap((node) => {
        const resource = resourceFromNode(node);
        return resource ? [resource] : [];
      }),
    [doc.nodes],
  );
  const openEditor = async (node: CanvasNode, mode: EditorMode = "default") => {
    if (node.type === "subject") return;
    if (lockedIds.has(node.id)) {
      notify("请先解锁节点或所属分组。");
      return;
    }
    if (node.type === "text") {
      setPreview(node);
      return;
    }
    const projectId = historyRef.current.present.id;
    editorSession.current = null;
    if (
      ["image", "timeline", "stack", "tool", "external"].includes(node.type)
    ) {
      if (
        !(await persistCurrentDocument(
          () => historyRef.current.present,
          persist,
        ))
      ) {
        notify("当前工程尚未保存，无法打开编辑会话。");
        return;
      }
      const current = historyRef.current.present;
      if (current.id !== projectId) return;
      node = current.nodes.find((item) => item.id === node.id)!;
      if (!node || lockedNodeIds(current.nodes).has(node.id)) return;
      editorSession.current = new CreationEditorSession(
        creationClient(projectId),
        current,
        node.id,
      );
    }
    editorOrigin.current = captureEditorSource(projectId, node);
    setActionSession(null);
    setEditorMode(mode);
    setEditing(node);
    setMenu(null);
  };
  const closeEditor = () => {
    if (editorSaving.current) return;
    setEditing(null);
    editorSession.current = null;
    editorOrigin.current = null;
  };
  const commitEditorData = async (data: Partial<CanvasNodeData>) => {
    const session = editorSession.current;
    if (!session || editorSaving.current)
      throw new Error("编辑会话不可用，请重新打开。");
    const projectId = session.projection.client.id;
    editorSaving.current = true;
    try {
      await saveQueue.current;
      if (historyRef.current.present.id !== projectId)
        throw new Error("项目已切换，编辑未提交。");
      if (!(await persist(historyRef.current.present)))
        throw new Error("工程保存失败，编辑草稿已保留。");
      await session.apply(data);
      const client = session.projection.client,
        projection = workspaceProjection(projectId);
      const snapshot = client.snapshot;
      let next: CanvasDocument;
      try {
        next = await projection.read(snapshot);
      } catch {
        throw new Error("编辑已保存，但画布刷新失败。请重试以刷新画布。");
      }
      if (historyRef.current.present.id === projectId) {
        const current = historyRef.current.present;
        const merged = {
          ...next,
          viewport: current.viewport,
          settings: current.settings,
        };
        projection.baseline = merged;
        projection.basis = snapshot;
        setHistory((history) => ({ ...history, present: merged }));
        const node = merged.nodes.find((item) => item.id === session.itemId);
        if (node) editorOrigin.current = captureEditorSource(projectId, node);
      }
      notify("编辑已保存到工程。");
      return true;
    } finally {
      editorSaving.current = false;
      session.projection.client.install(session.projection.client.snapshot);
    }
  };
  const addLinkedOutputs = async (
    source: ResultSource,
    outputs: readonly LinkedMediaResult[],
    sourceTask?: CanvasToolTask,
  ) => {
    if (editorSaving.current) throw Error("编辑结果正在保存。");
    editorSaving.current = true;
    try {
      await saveQueue.current;
      const current = historyRef.current.present;
      if (current.id !== source.documentId)
        throw Error("项目已切换，结果未提交。");
      if (!(await persist(current)))
        throw Error("工程保存失败，结果已保留，请重试。");
      const client = creationClient(current.id);
      let publication = mediaPublications.current.get(source);
      if (!publication) {
        const item = client.snapshot.canvasItems.find(
          (i) => i.id === source.nodeId,
        );
        const expected = source.src && client.assetForSource(source.src);
        if (
          !item ||
          (source.src &&
            (!expected ||
              currentAsset(client.snapshot, item)?.id !== expected.id))
        )
          throw Error("来源素材已变化，结果未发布，请重新打开编辑器。");
        publication = new MediaPublication(
          client,
          client.snapshot,
          source.nodeId,
        );
        mediaPublications.current.set(source, publication);
      }
      const task = sourceTask;
      const ids = await publication.publish(outputs, task);
      const projection = workspaceProjection(current.id);
      const snapshot = client.snapshot;
      const next = await projection.read(snapshot);
      if (historyRef.current.present.id === current.id) {
        const merged = {
          ...next,
          viewport: historyRef.current.present.viewport,
          settings: historyRef.current.present.settings,
        };
        projection.baseline = merged;
        projection.basis = snapshot;
        setHistory((h) => ({ ...h, present: merged }));
        if (ids.length) setSelected(ids);
      }
      notify(`已保存 ${ids.length || outputs.length} 个编辑结果到工程。`);
      return true;
    } finally {
      editorSaving.current = false;
      const client = creationClient(source.documentId);
      if (client.snapshot) client.install(client.snapshot);
    }
  };
  const editorOutputs = (
    outputs: readonly LinkedMediaResult[],
    task?: CanvasToolTask,
  ) => {
    return editorOrigin.current
      ? addLinkedOutputs(editorOrigin.current, outputs, task)
      : false;
  };
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
      notify(error instanceof Error ? error.message : "无法创建堆叠。");
    }
  };
  const sourceFor = (node: CanvasNode): ResultSource => ({
    documentId: doc.id,
    nodeId: node.id,
    kind: node.type,
    src: node.data.src,
  });
  const closeAction = () => {
    if (editorSaving.current) return;
    setActionSession(null);
    root.current?.focus({ preventScroll: true });
  };
  const openNodeAction = (tool: CanvasToolId, source = single) => {
    if (!source) return;
    const origin = sourceFor(source);
    const valid = validateNodeActionSource(historyRef.current.present, origin);
    if (valid.error) {
      notify(valid.error);
      return;
    }
    setMenu(null);
    setPanel(null);
    if (tool === "video-extend") {
      const next = createVideoExtensionDraft(
        historyRef.current.present,
        origin,
      );
      if (next.error) {
        notify(next.error);
        return;
      }
      // A model that continues its own clips (H3) extends seamlessly from cached latents.
      const draft = next.document.nodes.find((node) => node.id === next.ids[0]);
      const settings =
        draft && getNodeGenerationSettings(draft, backendCatalog.models);
      if (
        draft &&
        settings &&
        backendModel(
          settings,
          backendCatalog.models,
        )?.inputRules.videoModes.includes("continuation")
      )
        draft.data.settings = { ...settings, videoMode: "continuation" };
      setActionSession(null);
      change(() => next.document);
      setSelected(next.ids);
      if (next.ids[0]) focusSelection(next.ids[0]);
      return;
    }
    const modalModes: Partial<Record<CanvasToolId, EditorMode>> = {
      layers: "layers",
      composition: "default",
      crop: "default",
      "audio-trim": "trim",
      "director-stage": "default",
    };
    if (modalModes[tool]) {
      openEditor(source, modalModes[tool]);
      return;
    }
    setEditing(null);
    editorOrigin.current = null;
    setActionSession({ ...origin, tool, token: crypto.randomUUID() });
    focusSelection(source.id);
  };
  const saveActionDraft = (session: ResultSource, task: CanvasToolTask) => {
    const valid = validateNodeActionSource(historyRef.current.present, session);
    if ("error" in valid || task.sourceNodeIds[0] !== session.nodeId) return;
    if (JSON.stringify(valid.node.data.taskDraft) !== JSON.stringify(task))
      command({
        type: "update-node",
        id: session.nodeId,
        patch: { data: { taskDraft: task } },
      });
  };
  const importActionResults = (
    session: ResultSource & { token: string },
    task: CanvasToolTask,
  ) => {
    const valid = validateNodeActionSource(historyRef.current.present, session);
    if (valid.error) {
      notify(valid.error);
      return;
    }
    saveActionDraft(session, task);
    resultBinding.current = {
      ...session,
      actionToken: session.token,
      task,
    };
    if (resultInput.current) {
      resultInput.current.accept = "image/*,video/*,audio/*";
      resultInput.current.click();
    }
  };
  const runQuickAction = async (
    operation: (
      source: ResultSource,
      signal: AbortSignal,
    ) => Promise<LinkedMediaResult[]>,
    tool: CanvasToolId,
    parameters: ToolParameters = {},
  ) => {
    if (!single) return;
    const source = sourceFor(single);
    const valid = validateNodeActionSource(historyRef.current.present, source);
    if (valid.error) {
      notify(valid.error);
      return;
    }
    quickAction.current?.abort();
    const controller = new AbortController();
    quickAction.current = controller;
    setActionSession(null);
    notify("正在处理素材…");
    try {
      const outputs = await operation(source, controller.signal);
      if (!controller.signal.aborted)
        await addLinkedOutputs(
          source,
          outputs,
          createCanvasToolTask(tool, [source.nodeId], parameters),
        );
    } catch (error) {
      if (!controller.signal.aborted)
        notify(error instanceof Error ? error.message : "素材处理失败。");
    } finally {
      if (quickAction.current === controller) quickAction.current = null;
    }
  };
  const updateJob = (id: string, patch: Partial<Job>) =>
    setJobs((current) =>
      current.map((job) => (job.id === id ? { ...job, ...patch } : job)),
    );
  const refreshRunning = () =>
    setActiveGenerations(
      [...serviceRuns.current.values()]
        .filter(
          (run) => !run.tool && (!run.controller.signal.aborted || run.unified),
        )
        .map(({ documentId, nodeId, phase, startedAt, expectedMs }) => ({
          documentId,
          nodeId,
          phase,
          startedAt,
          expectedMs,
        })),
    );
  const revealResults = (ids: readonly string[]) =>
    setArrivingNodes((current) => new Set([...current, ...ids]));
  /** Pull finished results this page did not place, e.g. the assistant's. */
  const syncServiceResults = async () => {
    setJobs(await readJobs());
    {
      const snapshot = await creationClient(doc.id).refresh();
      return snapshot.jobs.filter(
        (job) => job.status === "queued" || job.status === "running",
      ).length;
    }
  };
  const runServiceTask = async (
    request: GenerationRequest,
    origin: ResultSource,
    _title: string,
    resultMode: GenerationResultMode = "replace",
  ) => {
    const id = crypto.randomUUID();
    const run: ServiceRun = {
      controller: new AbortController(),
      unified: true,
      documentId: origin.documentId,
      nodeId: origin.nodeId,
      phase: "preparing",
      startedAt: Date.now(),
      expectedMs: expectedDuration(
        `generate:${request.kind}:${request.config.id}`,
        request.kind,
      ),
    };
    serviceRuns.current.set(id, run);
    refreshRunning();
    try {
      const current = historyRef.current.present;
      const configured = {
        ...current,
        nodes: current.nodes.map((node) =>
          node.id !== origin.nodeId
            ? node
            : {
                ...node,
                data: {
                  ...node.data,
                  prompt: request.prompt,
                  ...(request.kind === "text"
                    ? {
                        agentSettings: {
                          modelConfigId: request.config.id,
                          thinking: request.thinking ?? "auto",
                          maxTokens: request.maxTokens ?? 8192,
                        },
                      }
                    : {
                        settings: {
                          ...getNodeGenerationSettings(
                            node,
                            backendCatalog.models,
                          ),
                          model: modelLabel(request.config),
                          modelConfigId: request.config.id,
                          prompt: request.prompt,
                        },
                      }),
                },
              },
        ),
      };
      change(() => configured);
      if (!(await persist(configured))) return;
      run.controller.signal.throwIfAborted();
      run.phase = "submitting";
      refreshRunning();
      const receipt = await creationClient(origin.documentId).submit(
        origin.nodeId,
        resultMode === "additional" ? "candidate_only" : "if_current",
        request.batchId,
        run.controller.signal,
      );
      if (run.controller.signal.aborted) {
        // Once sent, await the original receipt before cancelling its jobs.
        // Never abort delivery and mint a replacement command.
        for (const jobId of receipt.jobIds)
          await creationClient(origin.documentId).control(jobId, "cancel");
      } else if (receipt.status === "accepted")
        notify("生成任务已提交，结果将保存到当前工程。");
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        notify(errorMessage(error));
    } finally {
      serviceRuns.current.delete(id);
      refreshRunning();
    }
    return;
  };
  /** Submit once; the service ledger owns progress/history in both modes. */
  const runToolTask = async (origin: ResultSource, task: CanvasToolTask) => {
    const present = historyRef.current.present;
    if (
      present.id !== origin.documentId ||
      [...serviceRuns.current.values()].some(
        (run) =>
          run.documentId === origin.documentId && run.nodeId === origin.nodeId,
      )
    )
      return;
    {
      const pending = pendingToolDelivery(present.id, origin.nodeId);
      if (pending) {
        try {
          await deliverTool(present.id, origin.nodeId, pending);
          setJobs(await readJobs());
          notify("已确认上一次工具提交，请查看原任务进度与结果。");
        } catch (error) {
          notify(errorMessage(error));
        }
        return;
      }
    }
    const entry = toolCatalog.tools.find((item) => item.id === task.tool);
    if (!entry?.available) {
      notify(entry?.reason ?? "本地服务未提供此工具。");
      return;
    }
    const sources = task.sourceNodeIds.flatMap((id) => {
      const node = present.nodes.find((item) => item.id === id);
      return node?.data.src && ["image", "video", "audio"].includes(node.type)
        ? [
            {
              kind: node.type as "image" | "video" | "audio",
              title: node.data.title,
              src: node.data.src,
            },
          ]
        : [];
    });
    if (sources.length !== task.sourceNodeIds.length) {
      notify("来源素材已删除或尚未导入，请重新选择。");
      return;
    }
    const validation = validateNodeActionSource(
      historyRef.current.present,
      origin,
    );
    if (validation.error) {
      notify(validation.error);
      return;
    }
    const id = crypto.randomUUID();
    const title =
      CANVAS_TOOLS.find((tool) => tool.id === task.tool)?.title ?? task.tool;
    const outputKind = toolOutputKind(task.tool, origin.kind);
    const targetNodeId = outputKind ? crypto.randomUUID() : undefined;
    // Persist the draft and owned placeholder before any execution can be accepted.
    let prepared = {
      ...historyRef.current.present,
      nodes: historyRef.current.present.nodes.map((node) =>
        node.id === origin.nodeId
          ? {
              ...node,
              data: { ...node.data, taskDraft: structuredClone(task) },
            }
          : node,
      ),
    };
    if (targetNodeId && outputKind) {
      const pending = appendPendingResult(
        prepared,
        origin,
        outputKind,
        title,
        targetNodeId,
        snapshotModel(outputKind).settings,
      );
      if (pending.error) {
        notify(pending.error);
        return;
      }
      prepared = pending.document;
    }
    const run: ServiceRun = {
      controller: new AbortController(),
      documentId: origin.documentId,
      nodeId: origin.nodeId,
      targetNodeId,
      phase: "preparing",
      tool: task.tool,
      startedAt: Date.now(),
      expectedMs: expectedDuration(
        `tool:${task.tool}`,
        outputKind ?? origin.kind,
      ),
    };
    serviceRuns.current.set(id, run);
    refreshRunning();
    setJobs((current) => [
      {
        id,
        nodeId: origin.nodeId,
        title,
        status: "running",
        time: jobTime(),
        createdAt: run.startedAt,
        targetNodeId,
        targetKind: outputKind ?? undefined,
        targetTitle: targetNodeId ? title : undefined,
        durationKey: `tool:${task.tool}`,
        message: "正在准备工具任务",
        tool: { ...task, selection: undefined },
        resultSource: origin,
      },
      ...current,
    ]);
    const submissionDocument = prepared;
    change(() => submissionDocument);
    closeAction();
    try {
      if (!(await persist(submissionDocument))) {
        updateJob(id, {
          status: "failed",
          message: "工程保存失败，未提交工具任务。",
        });
        if (targetNodeId && historyRef.current.present.id === origin.documentId)
          change((current) =>
            removePendingResult(current, targetNodeId, title),
          );
        return;
      }
      if (historyRef.current.present.id !== origin.documentId)
        run.controller.abort();
      run.controller.signal.throwIfAborted();
      updateJob(id, { message: "正在上传素材" });
      const submitted = await submitToolTask(
        {
          id,
          canvas: {
            nodeId: origin.nodeId,
            sourceNodeIds: task.sourceNodeIds,
            ...(targetNodeId && outputKind
              ? { targetNodeId, targetKind: outputKind, targetTitle: title }
              : {}),
          },
          documentId: present.id,
          documentTitle: present.title,
          tool: task.tool,
          sources,
          parameters: task.parameters,
          modelConfigIds:
            typeof task.parameters.imageModelConfigId === "string" &&
            task.parameters.imageModelConfigId
              ? { "image.edit": task.parameters.imageModelConfigId }
              : undefined,
          annotatedDataUrl: sources[0]
            ? await imageAnnotationPayload(
                task,
                sources[0].src,
                run.controller.signal,
              )
            : undefined,
          maskDataUrl: task.selection?.maskDataUrl,
          boxes: task.selection?.boxes,
        },
        run.controller.signal,
      );
      Object.assign(run, submitted);
      updateJob(id, { taskId: submitted.taskId });
      setJobs(await readJobs());
    } catch (error) {
      const uncertain = error instanceof ToolSubmissionError && error.uncertain;
      updateJob(id, {
        status: uncertain
          ? "running"
          : run.controller.signal.aborted
            ? "cancelled"
            : "failed",
        message: uncertain
          ? "提交未确认，请同步服务记录核对原任务。"
          : errorMessage(error),
      });
      if (
        !uncertain &&
        targetNodeId &&
        historyRef.current.present.id === origin.documentId
      ) {
        const cleaned = removePendingResult(
          historyRef.current.present,
          targetNodeId,
          title,
          outputKind ?? undefined,
        );
        change(() => cleaned);
        await persist(cleaned);
      }
      if (!run.controller.signal.aborted)
        notify(`「${title}」：${errorMessage(error)}`);
    } finally {
      serviceRuns.current.delete(id);
      refreshRunning();
    }
  };

  const observedRuns = useRef(new Map<string, number>());
  useEffect(() => {
    for (const job of jobs) {
      if (job.status === "running" && job.createdAt)
        observedRuns.current.set(job.id, job.createdAt);
      if (job.status === "succeeded" && job.createdAt && job.durationKey) {
        const finished =
          job.finishedAt ??
          (observedRuns.current.has(job.id) ? Date.now() : undefined);
        if (finished)
          recordDuration(
            job.durationKey,
            finished - job.createdAt,
            job.taskId ?? job.id,
          );
        observedRuns.current.delete(job.id);
      }
      if (["failed", "cancelled", "interrupted"].includes(job.status))
        observedRuns.current.delete(job.id);
    }
  }, [jobs]);

  const toolPlacementQueue = useRef<Promise<unknown>>(Promise.resolve());
  const placingTools = useRef(new Set<string>());
  const placementRetryAfter = useRef(new Map<string, number>());
  useEffect(() => {
    if (!ready || !backendCatalog.connected) return;
    for (const job of jobs) {
      const placementKey = `${doc.id}:${job.id}`;
      if (
        job.targetNodeId &&
        ["failed", "cancelled", "interrupted"].includes(job.status) &&
        job.toolTask &&
        !placingTools.current.has(placementKey)
      ) {
        if (job.toolTask.placement === "pending") {
          placingTools.current.add(placementKey);
          void acknowledgeToolPlacement(doc.id, job.taskId!, "unplaced")
            .then(async () => {
              await creationClient(doc.id).refresh();
              setJobs(await readJobs());
            })
            .catch((error) => notify(errorMessage(error)))
            .finally(() => placingTools.current.delete(placementKey));
        }
        continue;
      }
      if (
        !job.toolTask ||
        job.toolTask.placement !== "pending" ||
        job.status !== "succeeded" ||
        !job.resultSource ||
        !job.outputs?.length ||
        job.toolTask.unavailable ||
        placingTools.current.has(placementKey) ||
        Date.now() < (placementRetryAfter.current.get(placementKey) ?? 0)
      )
        continue;
      placingTools.current.add(placementKey);
      placementRetryAfter.current.set(placementKey, Date.now() + 5000);
      const place = async () => {
        const origin = job.resultSource!;
        const current = () => historyRef.current.present;
        if (!mounted.current || current().id !== origin.documentId) return;
        {
          // The service validates frozen sources/locks and publishes the owned
          // outputs atomically. React Flow only observes the resulting snapshot.
          if (!(await persist(current()))) return;
          await acknowledgeToolPlacement(
            origin.documentId,
            job.taskId!,
            "placed",
          );
          await creationClient(origin.documentId).refresh();
          setJobs(await readJobs());
          return;
        }
      };
      toolPlacementQueue.current = toolPlacementQueue.current
        .catch(() => {})
        .then(place)
        .catch((error) => {
          if (mounted.current && historyRef.current.present.id === doc.id)
            notify(errorMessage(error));
        })
        .finally(() => {
          placingTools.current.delete(placementKey);
        });
    }
  }, [jobs, ready, backendCatalog.connected, doc.id, change, persist, notify]);
  const pinnedSubmissionInputs = (node: CanvasNode) =>
    (node.data.promptContent ?? []).flatMap((part) => {
      if (part.type !== "reference" || part.binding !== "asset") return [];
      const saved = creationClient(doc.id).snapshot?.assets.find(
        (asset) => asset.id === part.assetId,
      );
      const asset =
        saved ??
        referenceAssets.assets.find((asset) => asset.id === part.assetId);
      if (
        !asset ||
        !["text", "image", "video", "audio"].includes(asset.kind ?? "")
      )
        throw new Error("固定参考元数据尚未加载，请重新打开引用选择器。");
      return [
        {
          binding: "asset" as const,
          assetId: asset.id,
          fingerprint: part.fingerprint,
          referenceId: part.referenceId,
          kind: asset.kind as "image" | "video" | "audio" | "text",
          title: part.name,
        },
      ];
    });
  const runServiceGeneration = (node: CanvasNode, incoming: CanvasNode[]) => {
    const settings = getNodeGenerationSettings(node, backendCatalog.models);
    const config = backendModel(settings, backendCatalog.models);
    const blocked = backendBlocker(settings, incoming, backendCatalog.models);
    if (blocked || !config) {
      notify(blocked ?? "所选模型配置不可用。");
      return;
    }
    const references = backendReferences(settings, incoming, config);
    const document = historyRef.current.present;
    const request: GenerationRequest = {
      documentId: document.id,
      documentTitle: document.title,
      nodeId: node.id,
      promptContent: generationContent(node, incoming),
      config,
      kind: settings.mode,
      prompt: settings.prompt,
      title: node.data.title,
      videoMode: backendVideoMode(settings, references, config),
      durationSeconds: config.inputRules.videoCapabilities
        ? settings.durationSeconds
        : undefined,
      aspectRatio: settings.aspectRatio,
      resolution: settings.resolution,
      voice: serviceVoice(settings),
      references: [
        ...assistantReferences(incoming).map((input) => ({
          ...input,
          contextOnly: !references.some(
            ({ node: item }) =>
              item.id === input.nodeId &&
              item.data.kind === input.kind &&
              (input.kind === "text" || item.data.src === input.src),
          ),
        })),
        ...pinnedSubmissionInputs(node).map((input) => ({
          ...input,
          contextOnly:
            settings.mode === "audio" ||
            (settings.mode === "video" &&
              settings.videoMode === "first-last" &&
              input.kind === "image" &&
              references.some((ref) => ref.role === "firstFrame")),
        })),
      ],
    };
    const origin: ResultSource = {
      documentId: document.id,
      nodeId: node.id,
      kind: node.type,
      src: node.data.src,
      referenceInputs: referenceSnapshot(
        references.map(
          (item) =>
            document.nodes.find((n) => n.id === item.node.id) ?? item.node,
        ),
      ),
    };
    const count = settings.mode === "audio" ? 1 : (settings.count ?? 1);
    const batchId = count > 1 ? crypto.randomUUID() : undefined;
    for (let index = 0; index < count; index++)
      void runServiceTask(
        { ...request, batchId, executionSlot: index },
        origin,
        settings.prompt || node.data.title,
        index === 0 ? "replace" : "additional",
      );
  };
  const cancelServiceRuns = (nodeId: string) => {
    for (const job of jobs)
      if (
        job.tool &&
        job.taskId &&
        (job.nodeId === nodeId || job.targetNodeId === nodeId) &&
        job.status === "running"
      )
        void cancelToolTask(doc.id, job.taskId)
          .then(async () => setJobs(await readJobs()))
          .catch((error) => notify(errorMessage(error)));
    for (const run of serviceRuns.current.values())
      if (
        run.tool &&
        (run.nodeId === nodeId || run.targetNodeId === nodeId) &&
        run.documentId === doc.id
      )
        run.controller.abort();
    {
      for (const run of serviceRuns.current.values())
        if (run.unified && run.documentId === doc.id && run.nodeId === nodeId)
          run.controller.abort();
      const client = creationClient(doc.id);
      for (const job of client.snapshot.jobs)
        if (
          job.originItemId === nodeId &&
          (job.status === "queued" || job.status === "running")
        )
          void client
            .control(job.id, "cancel")
            .catch((error) => notify(errorMessage(error)));
      return;
    }
  };
  const prepareGeneration = (nodeId: string) => {
    const current = historyRef.current.present;
    const node = current.nodes.find((node) => node.id === nodeId);
    if (!node || lockedNodeIds(current.nodes).has(nodeId)) return;
    if (
      generationByNode.has(nodeId) ||
      [...serviceRuns.current.values()].some(
        (run) => run.documentId === current.id && run.nodeId === nodeId,
      )
    )
      return;
    const incoming = incomingNodes(current, nodeId);
    if (node.type === "text") {
      const settings = agentNodeSettings(node);
      const agents = backendCatalog.models.filter(
        (model) => model.kind === "agent",
      );
      const config = agents.find(
        (model) => model.id === (settings.modelConfigId ?? agents[0]?.id),
      );
      const blocker = agentGenerationBlocker(node, incoming, config);
      if (blocker || !config) {
        notify(blocker ?? "Agent 配置不可用。");
        return;
      }
      void runServiceTask(
        {
          documentId: current.id,
          documentTitle: current.title,
          nodeId: node.id,
          promptContent: generationContent(node, incoming),
          config,
          kind: "text",
          prompt: node.data.prompt,
          title: node.data.title,
          videoMode: "first_frame",
          thinking: settings.thinking,
          maxTokens: settings.maxTokens,
          references: [
            ...assistantReferences(incoming),
            ...pinnedSubmissionInputs(node),
          ],
        },
        {
          documentId: current.id,
          nodeId: node.id,
          kind: "text",
          text: node.data.text,
          referenceInputs: referenceSnapshot(incoming),
        },
        node.data.title,
      );
      return;
    }

    const settings = getNodeGenerationSettings(node, backendCatalog.models);
    if (settings.modelConfigId) {
      try {
        runServiceGeneration(node, incoming);
      } catch (error) {
        notify(errorMessage(error));
      }
      return;
    }
    notify(
      "当前未选择可用的生成模型，请先在“设置 → 模型接入”中配置服务，再选择模型。",
    );
  };
  const importActionResultFiles = async (files: File[]) => {
    const binding = resultBinding.current;
    resultBinding.current = null;
    if (!binding || !files.length) return;
    const source = historyRef.current.present.nodes.find(
      (node) => node.id === binding.nodeId,
    );
    if (!source || historyRef.current.present.id !== binding.documentId) {
      notify("任务来源已失效，请重新选择。");
      return;
    }
    const origin = binding;
    const controller = new AbortController();
    importAbort.current?.abort();
    importAbort.current = controller;
    try {
      const outputs: LinkedMediaResult[] = [];
      for (const file of files) {
        const resource = await readEditorResource(file, controller.signal);
        if (resource.kind === "file" || resource.kind === "text")
          throw new Error("结果必须是实际图片、视频或音频文件。");
        outputs.push({
          kind: resource.kind,
          src: resource.src!,
          mimeType: resource.mimeType || `${resource.kind}/*`,
          title: resource.title,
          media: {
            ...(resource.width ? { width: resource.width } : {}),
            ...(resource.height ? { height: resource.height } : {}),
            ...(resource.durationSeconds
              ? { durationSeconds: resource.durationSeconds }
              : {}),
          },
        });
      }
      if (controller.signal.aborted) return;
      {
        const applied = await addLinkedOutputs(origin, outputs, binding.task);
        if (applied && actionSessionRef.current?.token === binding.actionToken)
          setActionSession(null);
        return;
      }
    } catch (error) {
      if (!controller.signal.aborted)
        notify(error instanceof Error ? error.message : "结果导入失败。");
    } finally {
      if (importAbort.current === controller) {
        importAbort.current = null;
      }
    }
  };

  const cancelResultImport = () => {
    importAbort.current?.abort();
    resultBinding.current = null;
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
        ".cw-composer-dock,.cw-composer-popover,.cw-node-toolbar-anchor,.cw-domain-dialog,.cw-selection-menu,.cw-action-media-host,.cw-project-selector,.cw-project-dialog,.cw-settings-dialog,.cw-assistant-panel,.cw-context-menu,.cw-node-title-input,.cw-subject-description",
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
    if (
      !mod &&
      event.key === "Enter" &&
      single?.type === "text" &&
      !lockedIds.has(single.id) &&
      (el === root.current ||
        el.closest(".react-flow__node")?.getAttribute("data-id") === single.id)
    ) {
      event.preventDefault();
      event.stopPropagation();
      setTextEditingId(single.id);
    } else if (mod && key === "z") {
      event.preventDefault();
      replayHistory(event.shiftKey);
    } else if (mod && key === "y") {
      event.preventDefault();
      replayHistory(true);
    } else if (mod && key === "a") {
      event.preventDefault();
      setSelected(
        doc.nodes
          .filter((n) => !projected.ownerByNodeId.has(n.id))
          .map((n) => n.id),
      );
    } else if (mod && key === "c") {
      event.preventDefault();
      copy();
    } else if (mod && key === "x") {
      event.preventDefault();
      cut();
    } else if (
      mod &&
      (event.code === "BracketLeft" || event.code === "BracketRight")
    ) {
      event.preventDefault();
      command({
        type: "reorder-nodes",
        ids: selectedRef.current,
        direction:
          event.code === "BracketLeft"
            ? event.shiftKey
              ? "back"
              : "backward"
            : event.shiftKey
              ? "front"
              : "forward",
      });
    } else if (mod && key === "v" && clipboard.current) {
      event.preventDefault();
      paste();
    } else if (mod && key === "d") {
      event.preventDefault();
      paste(true);
    } else if (mod && key === "g") {
      event.preventDefault();
      if (event.shiftKey) ungroup();
      else group();
    } else if (mod && key === "s") {
      event.preventDefault();
      void persist(doc);
    } else if (mod && key === "o") {
      event.preventDefault();
      openFilePicker();
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      removeSelected();
    } else if (event.shiftKey && event.code === "Digit1") {
      event.preventDefault();
      fit();
    } else if (event.shiftKey && event.code === "Digit2") {
      event.preventDefault();
      fit(true);
    } else if (!mod && key === "t") addNode("text");
    else if (!mod && key === "f" && single) setPreview(single);
    else if (!mod && key === "?") setHelp(true);
    else if (
      ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    ) {
      event.preventDefault();
      event.stopPropagation();
      const step = event.shiftKey ? 10 : 1;
      command({
        type: "move-nodes",
        ids: selectedRef.current,
        delta: {
          x:
            event.key === "ArrowLeft"
              ? -step
              : event.key === "ArrowRight"
                ? step
                : 0,
          y:
            event.key === "ArrowUp"
              ? -step
              : event.key === "ArrowDown"
                ? step
                : 0,
        },
      });
    }
  };
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (!ready || switchPending.current) return;
      if (
        editing ||
        preview ||
        (event.target as HTMLElement).closest("[role=dialog]")
      )
        return;
      if (
        (event.target as HTMLElement).closest(
          "input,textarea,[contenteditable=true]",
        )
      )
        return;
      if (event.clipboardData?.files.length) {
        event.preventDefault();
        uploadTarget.current = null;
        void importFiles([...event.clipboardData.files]);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("paste", onPaste);
    };
  });

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
    referenceTargetState: (id: string): "valid" | "invalid" | null => {
      if (
        !references.connecting ||
        references.targetId !== id ||
        !references.port
      )
        return null;
      const issue = referenceIssue(doc, references.port.nodeId, id);
      return !issue || issue === "duplicate_relation" ? "valid" : "invalid";
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
          throw new Error("请先保存画布。");
        const current = historyRef.current.present;
        const { node, issue } = subjectImportSelection(current, [id]);
        if (issue || !node) throw new Error(issue || "目标主体已移除。");
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
      if (lockedIds.has(id)) notify("请先解锁节点或所属分组。");
      else if (n) setRename({ id, value: n.data.title });
    },
    versionCount: (id: string) => versionCounts[id] ?? 0,
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
            saveError.current || "当前修改保存失败，请关闭后重试。",
          );
        if (historyRef.current.present.id !== doc.id)
          throw new Error("当前项目已切换。");
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
        notify(error instanceof Error ? error.message : "堆叠切换失败。");
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
      if (
        !Object.keys(actual).length ||
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
          patch: { data: { media: { ...node.data.media, ...actual } } },
        }).present,
      }));
    },
    beginEdit: begin,
    endEdit: end,
    isTextEditing: (id: string) => textEditingId === id,
    finishTextEdit: () => {
      end();
      setTextEditingId(null);
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
  useEffect(() => {
    if (!menu) return;
    if (menu.connected) {
      const element =
        root.current?.querySelector<HTMLElement>(".cw-canvas-menu");
      element
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus({ preventScroll: true });
    }
    const close = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(".cw-context-menu")
      )
        setMenu(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);
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
          event.stopPropagation();
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
              setSelectedEdges([edge.id]);
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
              if (
                !spacePressed &&
                node.type === "text" &&
                !lockedIds.has(node.id) &&
                selectionAtPointerDown.current.length === 1 &&
                selectionAtPointerDown.current[0] === node.id
              )
                setTextEditingId(node.id);
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
              if (event) selectionPresentation.userNavigation();
            }}
            onMove={(event, view) => {
              setZoom(view.zoom);
              if (event) setMenu(null);
            }}
            onMoveEnd={(_, viewport) => command({ type: "viewport", viewport })}
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
            aria-label="无限创作画布"
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={18 * Math.max(1, 2 ** Math.ceil(Math.log2(0.65 / zoom)))}
              size={Math.max(1, 1 / zoom)}
              color={theme.theme === "dark" ? "#55565d" : "#c7cbd2"}
              bgColor={theme.theme === "dark" ? "#0d0d0d" : "#f7f8fa"}
            />
            <CanvasInteractionOverlay guides={[]} pending={pendingConnection} />
            <ViewportPortal>
              {references.preview && (
                <svg className="cw-interaction-overlay">
                  <CanvasConnectionPreview
                    path={references.preview}
                    invalid={Boolean(
                      references.targetId &&
                      actions.referenceTargetState(references.targetId) ===
                        "invalid",
                    )}
                  />
                </svg>
              )}
              {references.port && !menu && (
                <button
                  type="button"
                  className="cw-reference-port"
                  aria-label="添加下游参考节点"
                  data-reference-source={references.port.nodeId}
                  data-side={references.port.side}
                  style={{
                    left: references.port.point.x,
                    top: references.port.point.y,
                    transform: `translate(-50%, -50%) scale(${portMetrics.scale})`,
                    opacity: references.connecting ? 0 : 1,
                  }}
                  onPointerDown={references.start}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                >
                  <CanvasIcon name="plus" size={REFERENCE_PORT_SIZE * 0.75} />
                </button>
              )}
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
                ? "历史版本已应用。部分参考与历史版本不同，已使用来源节点当前内容。"
                : "历史版本已应用到画布，未开始新的生成任务。",
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
            name={doc.title}
            disabled={!ready || switching || projectRenaming}
            onSelect={(project) =>
              switchDocument(() => openWorkspaceProject(project))
            }
            onCreate={() =>
              setProjectDialog({
                id: crypto.randomUUID(),
                name: "",
              })
            }
            onRename={renameCurrentProject}
          />
          <NodeInfoButton nodes={doc.nodes} />
          <span className="cw-save-status" title={saveStatus}>
            <i className={saveStatus === "已保存到本机" ? "saved" : ""} />
            {saveStatus}
          </span>
          {saveStatus.startsWith("保存失败") && (
            <div className="cw-save-conflict-actions">
              <button onClick={() => void exportDocument()}>
                导出未保存副本
              </button>
              <button
                onClick={() => {
                  if (
                    !window.confirm(
                      "读取服务端版本会放弃本页未保存的修改。请先导出副本，确认后继续。",
                    )
                  )
                    return;
                  void workspaceProjection(doc.id)
                    .open()
                    .then((next) => {
                      installDocument(next);
                      setSaveStatus("已保存到本机");
                    })
                    .catch((error) => notify(errorMessage(error)));
                }}
              >
                读取服务端版本
              </button>
            </div>
          )}
        </div>
        <div className="cw-top-actions">
          <IconButton
            name="search"
            label={"资产列表"}
            tooltipSide="bottom"
            active={panel === "search"}
            onClick={() => {
              void persist(historyRef.current.present).then((saved) => {
                if (saved) togglePanel("search");
              });
            }}
          />
          <IconButton
            name="history"
            label="生成历史"
            tooltipSide="bottom"
            active={panel === "history"}
            onClick={() => togglePanel("history")}
          />
          <button className="cw-export-button" onClick={exportDocument}>
            导出画布
          </button>
        </div>
      </header>
      <CanvasToolRail
        holdCollapsed={false}
        items={[
          ...CANVAS_CREATION_TOOLS.map((tool) => ({
            name: tool.kind,
            icon: tool.icon,
            label: tool.label,
            actionLabel: tool.unavailable ? tool.label : `添加${tool.label}`,
            shortcut: tool.kind === "text" ? "T" : undefined,
            unavailable: tool.unavailable,
            onClick: tool.unavailable ? undefined : () => addNode(tool.kind),
          })),
          {
            name: "folder",
            icon: "rail-folder",
            label: "资产库",
            preserveCollapsedOnFocusRestore: true,
            separatorBefore: true,
            active: libraryOpen,
            onClick: () => setLibraryOpen(true),
          },
          {
            name: "upload",
            icon: "rail-upload",
            label: "上传",
            preserveCollapsedOnFocusRestore: true,
            actionLabel: "上传本地素材",
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
          <h1>你的故事，由你执导</h1>
          <p>双击画布创建节点，或拖入你的素材</p>
          <div>
            <button onClick={() => addNode("image")}>
              <CanvasIcon name="plus" size={15} />
              图片节点
            </button>
            <button
              onClick={() => {
                void switchDocument(
                  async () => importWorkspaceDocument(await exampleDocument()),
                  true,
                );
              }}
            >
              体验示例画布 <span>↗</span>
            </button>
          </div>
          <small>参考连接 · 自由编排 · 本机自动保存</small>
        </div>
      )}
      {!ready && <div className="cw-loading">正在打开画布…</div>}

      <div className="cw-bottom-left">
        <div className="cw-settings-control">
          <IconButton
            name="settings"
            label="设置"
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
            label={hand ? "切换到选择工具" : "切换到抓手工具"}
            shortcut={hand ? "V" : "H"}
            tooltipDelay={0}
            highlighted
            onClick={() => changeTool(!hand)}
          />
          <IconButton
            name="minimap"
            label={minimap ? "隐藏小地图" : "显示小地图"}
            tooltipDelay={0}
            active={minimap}
            onClick={() => setMinimap(!minimap)}
          />
          <IconButton
            name="connections"
            label={showEdges ? "隐藏连线" : "显示连线"}
            tooltipDelay={0}
            active={showEdges}
            onClick={() => setShowEdges(!showEdges)}
          />
          <span className="cw-vline" />
          <TooltipButton
            className="cw-zoom-button"
            label="缩放选项"
            tooltipDelay={0}
            onClick={() => setZoomMenu(!zoomMenu)}
          >
            {Math.round(zoom * 100)}%<CanvasIcon name="chevron" size={11} />
          </TooltipButton>
        </div>
        <div className="cw-undo-controls">
          <IconButton
            name="undo"
            label="撤销"
            shortcut={navigator.platform.includes("Mac") ? "⌘ Z" : "Ctrl Z"}
            tooltipDelay={0}
            disabled={!businessHistory.undo}
            onClick={() => replayHistory()}
          />
          <IconButton
            name="redo"
            label="重做"
            shortcut={
              navigator.platform.includes("Mac") ? "⌘ ⇧ Z" : "Ctrl Shift Z"
            }
            tooltipDelay={0}
            disabled={!businessHistory.redo}
            onClick={() => replayHistory(true)}
          />
        </div>
      </div>
      {zoomMenu && (
        <div className="cw-zoom-menu cw-menu-popover">
          <div className="cw-zoom-row">
            <IconButton
              name="minus"
              label="缩小"
              onClick={() => {
                selectionPresentation.userNavigation();
                void flow.zoomOut();
              }}
            />
            <input
              aria-label="缩放百分比"
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
              label="放大"
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
            适应所有内容 <kbd>⇧ 1</kbd>
          </button>
          <button
            onClick={() => {
              fit(true);
              setZoomMenu(false);
            }}
          >
            适应选中内容 <kbd>⇧ 2</kbd>
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
          label="使用帮助"
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
          <CanvasIcon name="star" size={18} />与 AI 对话
        </button>
      </div>
      {selectedEdges.length > 0 && selected.length === 0 && (
        <div
          className="cw-selection-bar"
          role="toolbar"
          aria-label="参考连线操作"
        >
          <span>已选 {selectedEdges.length} 条连线</span>
          <button
            onClick={() => {
              command({ type: "remove-edges", ids: selectedEdges });
              setSelectedEdges([]);
            }}
          >
            断开参考
          </button>
          <button onClick={() => setSelectedEdges([])}>取消选择</button>
        </div>
      )}
      {selected.length > 1 && !interacting && !spacePressed && (
        <div className="cw-selection-bar">
          <span>已选 {selected.length} 个节点</span>
          <select
            aria-label="对齐所选节点"
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
              对齐 / 分布
            </option>
            <option value="left">左对齐</option>
            <option value="center">水平居中</option>
            <option value="right">右对齐</option>
            <option value="top">顶对齐</option>
            <option value="middle">垂直居中</option>
            <option value="bottom">底对齐</option>
            <option value="horizontal" disabled={selected.length < 3}>
              水平等间距
            </option>
            <option value="vertical" disabled={selected.length < 3}>
              垂直等间距
            </option>
          </select>
          <button onClick={group}>
            <CanvasIcon name="group" size={16} />
            编组
          </button>
          <button onClick={stack}>
            <CanvasIcon name="stack" size={16} />
            堆叠
          </button>
          <button
            onClick={() =>
              change((d) => ({
                ...d,
                nodes: arrangeNodes(d.nodes, selected),
              }))
            }
          >
            自动排列
          </button>
          <IconButton
            name="copy"
            label="复制副本"
            onClick={() => paste(true)}
          />
          <IconButton name="trash" label="删除所选" onClick={removeSelected} />
        </div>
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
            aria-label={composerExpanded ? "展开的节点会话框" : undefined}
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
                label={composerExpanded ? "收起会话框" : "展开会话框"}
                aria-label={composerExpanded ? "收起会话框" : "展开会话框"}
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
                label="关闭生成面板"
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
                running={generationByNode.has(composerNode.id)}
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
                running={generationByNode.has(composerNode.id)}
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
          canUndo={businessHistory.undo}
          canRedo={businessHistory.redo}
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
              {menuButton("重命名", "text", () => actions.rename(menu.nodeId!))}
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
                <span>添加下游节点</span>
              </button>
              {menuButton("复制", "copy", copy, "⌘ C")}
              {menuButton("剪切", "copy", cut, "⌘ X")}
              {menuButton("粘贴", "copy", () => paste(), "⌘ V")}
              {menuButton("复制副本", "copy", () => paste(true), "⌘ D")}
              <hr />
              {menuButton("编组", "group", group, "⌘ G")}
              {selected.length > 1 && menuButton("资源堆叠", "stack", stack)}
              {menuButton("取消编组", "group", ungroup, "⌘ ⇧ G")}
              {menuButton("自动排列", "map", () =>
                change((d) => ({
                  ...d,
                  nodes: arrangeNodes(d.nodes, selected),
                })),
              )}
              <hr />
              {menuButton(
                single && lockedIds.has(single.id) && !single.locked
                  ? "所属分组已锁定"
                  : single?.locked
                    ? "解锁"
                    : "锁定",
                "lock",
                () => {
                  if (single && lockedIds.has(single.id) && !single.locked) {
                    notify("请先选择并解锁所属分组。");
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
                menuButton("解散堆叠", "stack", () =>
                  change((d) => unstackSelection(d, selected)),
                )}
              {menuButton("移到顶层", "arrow", () =>
                command({
                  type: "reorder-nodes",
                  ids: selected,
                  direction: "front",
                }),
              )}
              {menuButton(
                "上移一层",
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
                "下移一层",
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
                "移到底层",
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
                  single.data.src ? "替换素材" : "上传素材",
                  "upload",
                  () => openFilePicker(single.id),
                )}
              {single?.data.src &&
                menuButton("下载素材", "download", () => downloadNode(single))}
              {single?.type === "image" &&
                single.data.src &&
                menuButton("编辑图片", "crop", () => openEditor(single))}
              {single &&
                ["timeline", "stack", "tool", "external"].includes(
                  single.type,
                ) &&
                menuButton("打开编辑器", single.type, () => openEditor(single))}
              {single?.data.src &&
                ["image", "video", "audio"].includes(single.type) &&
                menuButton("编辑素材", "tool", () =>
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
              {menuButton("删除", "trash", removeSelected, "⌫")}
            </>
          ) : (
            <CreationMenuContent
              allowedKinds={
                menu.connected
                  ? connectedCreationKinds(
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
              assets: "资产库",
              search: "搜索节点",
              history: "生成历史",
            }[panel]
          }
        >
          <div className="cw-panel-heading">
            <h2>
              {
                {
                  assets: "资产库",
                  search: "搜索节点",
                  history: "生成历史",
                }[panel]
              }
            </h2>
            <IconButton
              name="close"
              label="关闭侧栏"
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
                  ? "选择素材作为参考，或上传本地文件。"
                  : "素材保存在当前工程，可拖入图片、视频、音频。"}
              </p>
              <button
                className="cw-wide-button"
                onClick={() => openFilePicker()}
              >
                <CanvasIcon name="upload" />
                上传本地素材
              </button>
              <h3>画布素材</h3>
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
                打开资产库
              </button>
              <h3>原创示例素材</h3>
              <div className="cw-asset-grid">
                {["青山", "暮色", "远湖"].map((title, i) => (
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
                示例为本工程绘制的矢量插画。
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
                  if (!job) throw new Error("原任务不存在。");
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
                  if (!commandId) throw new Error("未找到原任务的配置历史。");
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
                  notify("生成配置已恢复，当前结果保留；未开始新的生成任务。");
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
                    notify("该配置尚未显示，可从资产列表显示其当前结果。");
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
                        notify("请使用“恢复生成配置”，该操作不改变当前结果。");
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
                        notify("同一生成配置一次只能选用一个历史结果。");
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
        aria-label="选择本地素材文件"
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
        aria-label="导入真实生成结果"
        onChange={(event) => {
          if (event.target.files?.length)
            void importActionResultFiles([...event.target.files]);
          event.target.value = "";
        }}
      />
      <CanvasNotifications notifications={notifications} onDismiss={dismiss} />
      {preview && (
        <div
          className="cw-modal-backdrop cw-preview"
          role="dialog"
          aria-label="素材全屏预览"
          onClick={() => setPreview(null)}
        >
          <header>
            <span>{preview.data.title}</span>
            <IconButton
              name="download"
              label="下载预览素材"
              onClick={() => downloadNode(preview)}
            />
            <IconButton
              name="close"
              label="关闭全屏"
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
                    ? "此文件可通过右上角下载按钮保存查看。"
                    : "这个节点还没有素材，先上传本地文件。")}
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
              throw new Error("时间线未保存，未开始合成。");
            const client = creationClient(doc.id);
            const publish = timelinePublication(
              client,
              editorSession.current!.projection.basis,
              editing.id,
            );
            return async (result) => {
              await publish(result);
              client.install(client.snapshot);
              notify("合成视频已保存到工程。");
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
              title="正在打开导演台"
              subtitle="加载本地 3D 编辑器"
              onClose={closeEditor}
            >
              <p>正在加载…</p>
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
      {settingsOpen && (
        <SettingsDialog
          catalog={backendCatalog}
          theme={theme}
          initialCategory={settingsCategory}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {help && (
        <div className="cw-modal-backdrop" onClick={() => setHelp(false)}>
          <section
            className="cw-modal cw-help"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="画布使用说明"
          >
            <div className="cw-panel-heading">
              <h2>在画布上，自由创作</h2>
              <IconButton
                name="close"
                label="关闭说明"
                onClick={() => setHelp(false)}
              />
            </div>
            <p>
              拖动节点排列画面，从节点右侧圆点拖到另一个节点左侧即可建立参考连线。点击圆点旁的按钮可创建关联节点。
            </p>
            <dl>
              {[
                ["平移画布", "滚动 / 空格＋拖动"],
                ["缩放画布", "⌘ / Ctrl＋滚动"],
                ["框选多个节点", "空白处拖动 / Shift"],
                ["选择 / 抓手 / 文本", "V / H / T"],
                ["上传本地素材", "⌘ / Ctrl＋O"],
                ["撤销 / 重做", "⌘ Z / ⌘ ⇧ Z"],
                ["复制 / 粘贴 / 副本", "⌘ C / ⌘ V / ⌘ D"],
                ["编组 / 取消编组", "⌘ G / ⌘ ⇧ G"],
                ["适应内容 / 选区", "Shift 1 / Shift 2"],
                ["移动 / 快速移动", "方向键 / Shift＋方向键"],
                ["删除选中节点或连线", "Delete / Backspace"],
              ].map(([name, key]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{key}</dd>
                </div>
              ))}
            </dl>
            <p className="cw-panel-note">
              项目与画布保存在本地 projects 目录，导出 JSON
              可备份或交换。图像裁剪与调色在本机实际执行；节点生成通过本地服务调用“设置
              → 模型接入”中的模型。助手对话、云分享和云端资产尚未接入。
            </p>
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
              ? "项目已切换。"
              : (subjectImportSelection(doc, [subjectImport.nodeId]).issue ??
                (() => {
                  const target = doc.nodes.find(
                    (node) => node.id === subjectImport.nodeId,
                  );
                  return target &&
                    subjectTargetIdentity(target) !== subjectImport.identity
                    ? "目标主体已变化，请重新打开导入界面。"
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
          subjectBusy={subjectLibraryBusy || switching || projectRenaming}
          backupSubjectIssue={
            single?.type === "subject" &&
            single.data.subject?.main?.src &&
            single.data.assetState !== "missing"
              ? null
              : "请在画布中仅选中一个有内容的主体。"
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
              <button onClick={() => window.location.reload()}>重新连接</button>
              <a href="/">返回画布首页</a>
            </div>
          ) : switching ? (
            "正在切换画布…"
          ) : (
            "正在打开画布…"
          )}
        </div>
      )}
      {projectDialog && (
        <ProjectNameDialog
          key={projectDialog.id}
          initialName={projectDialog.name}
          onClose={() => setProjectDialog(null)}
          onSubmit={async (name) => {
            const success = await switchDocument(
              async () => {
                const project = await createWorkspaceProject(
                  name,
                  projectDialog.id,
                );
                const document = await openWorkspaceProject(project);
                await saveWorkspaceDocument(document);
                return document;
              },
              false,
              true,
            );
            if (!success)
              throw new Error("项目创建未完成，请检查名称或保存状态后重试。");
          }}
        />
      )}
    </>
  );
}
