
import { SaveQueue } from "../saveQueue.ts";
import { useKeyPress, useReactFlow, type Edge } from "@xyflow/react";
import { useEffect, useMemo, useRef } from "react";
import { useNodeVersionCounts } from "../NodeVersionHistory";

import { CreationEditorSession } from "../../backend/creationEditorSession";
import { MediaPublication } from "../../backend/mediaPublication";
import { useBackendModels } from "../../backend/models.ts";
import { useToolCatalog } from "../../backend/tools.ts";
import { type CanvasFlowSurfaceHandle } from "../CanvasFlowSurface";
import { useCanvasNotifications } from "../CanvasNotifications";
import { generationActivities, jobActivities } from "../generationActivity";

import { lockedNodeIds } from "../hierarchy";
import { modelFrameCapabilities } from "../frameReferences";
import { validateNodeActionSource, type ResultSource } from "../linkedResults";

import { newNodeGenerationSettings } from "../modelResolution.ts";
import { type CanvasDocument, type CanvasNode, type CanvasNodeData, type CanvasNodeKind, type Point } from "../model";
import { type CanvasFragment } from "../operations";
import { type ClipboardMedia } from "../clipboardMedia.ts";

import { CanvasPointerGesture } from "../pointerGesture";
import { type SubjectMediaSlot } from "../subjectMedia.ts";

import { useTheme } from "../theme";
import { useI18n } from "../../i18n/I18nProvider";
import { type CanvasToolTask } from "../toolCatalog";

import { useAssistantLayout } from "../useAssistantLayout";
import { useGenerationJobs } from "../useGenerationJobs";
import { liveCanvasSources } from "../library/liveCanvasSources";
import { useProjectMentionAssets } from "../useProjectMentionAssets";
import type { WorkspaceRuntime } from "./runtimeTypes.ts";
import { incomingNodes } from "./workspaceChrome.tsx";
import type { FlowNode, ServiceRun } from "./workspaceChrome.tsx";

import { useWorkspaceStore } from "./state.ts";

export function useWorkspaceRuntime(): WorkspaceRuntime {
  const rt = useRef<WorkspaceRuntime | null>(null);
  if (!rt.current) rt.current = {} as WorkspaceRuntime;
  const runtime = rt.current;
  const store = useWorkspaceStore();
  Object.assign(runtime, store);
  const {
    actionSession,
    activeGenerations,
    assistantModels,
    assistantOpen,
    composerNodeId,
    hand,
    history,
    panel,
    ready,
    saveStatus,
    selected,
    setAssistantOpen,
    setComposerNodeId,
    setPresentationFocus,
    textWindowId,
  } = runtime;

  const { t, locale, setLocale } = useI18n();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const flow = useReactFlow<FlowNode, Edge>();
  const historyRef = useRef(history);
  const historyReplayQueue = useRef<boolean[] | null>(null);
  historyRef.current = history;
  const doc = history.present;
  // The library's canvas tab shows the open document itself, so it never waits
  // for a round trip and never disagrees with what the canvas is showing.
  const liveCanvas = useMemo(
    () => ({ projectId: doc.id, sources: liveCanvasSources(doc) }),
    [doc],
  );
  const versionCounts = useNodeVersionCounts(doc.id);
  const switchPending = useRef(false);
  const revealCreatedNodes = useRef<(nodes: CanvasNode[], allNodes: CanvasNode[]) => void>(() => {});
  const viewportMoving = useRef(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const selectionAtPointerDown = useRef<string[]>([]);
  const marqueeClick = useRef(false);
  const pointerGesture = useRef(new CanvasPointerGesture());
  const assetListAnchor = useRef<HTMLSpanElement>(null);
  const flowSurface = useRef<CanvasFlowSurfaceHandle>(null);
  const dragging = useRef(false);
  const bypassSnapping = useRef(false);
  const connectionStarted = useRef<Point | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const saveStatusText = (() => {
    switch (saveStatus.state) {
      case "opening":
        return t("canvas.workspace.save.opening");
      case "saving":
        return t("canvas.workspace.save.saving");
      case "saved":
        return t("canvas.workspace.save.saved");
      case "savedViewFailed":
        return t("canvas.workspace.save.savedViewFailed", {
          warning: saveStatus.warning,
        });
      case "failed":
        return t("canvas.workspace.save.failed", {
          error: saveStatus.error,
        });
    }
  })();
  const { notifications, notify, dismiss } = useCanvasNotifications();
  const editorOrigin = useRef<ResultSource | null>(null);
  const mediaPublications = useRef(
    new WeakMap<ResultSource, MediaPublication>(),
  );
  const editorSession = useRef<CreationEditorSession | null>(null);
  const editorSaving = useRef(false);
  const actionSessionRef = useRef(actionSession);
  actionSessionRef.current = actionSession;
  const quickAction = useRef<AbortController | null>(null);
  const resultInput = useRef<HTMLInputElement>(null);
  const resultBinding = useRef<
    | (ResultSource & {
        actionToken?: string;
        task?: CanvasToolTask;
      })
    | null
  >(null);
  const importAbort = useRef<AbortController | null>(null);
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
  const setupChecked = useRef(false);
  const theme = useTheme();
  const serviceRuns = useRef(new Map<string, ServiceRun>());
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
  const clipboard = useRef<CanvasFragment | null>(null);
  const clipboardMedia = useRef<ClipboardMedia | null>(null);
  const pasting = useRef(false);
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
  const focusSelection = (id: string) => {
    setComposerNodeId(id);
    setPresentationFocus((value) => value + 1);
  };
  const saveQueue = useRef<SaveQueue<{
    snapshot: CanvasDocument;
    saveView: boolean;
  }> | null>(null);
  const saveError = useRef("");
  const spacePressed = useKeyPress("Space");
  const panning = hand || spacePressed;
  const single =
    selected.length === 1
      ? (doc.nodes.find((n) => n.id === selected[0]) ?? null)
      : null;
  const textWindowNode = textWindowId
    ? doc.nodes.find((node) => node.id === textWindowId)
    : undefined;
  const selectedNodes =
    selected.length > 1
      ? doc.nodes.filter((node) => selected.includes(node.id))
      : [];
  const composerNode = doc.nodes.find((node) => node.id === composerNodeId);
  const composerIncoming = useMemo(
    () => incomingNodes(doc, composerNodeId),
    [doc.nodes, doc.hiddenNodes, doc.edges, composerNodeId],
  );
  const referenceAssets = useProjectMentionAssets(doc.id, ready);
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
  const frameCapabilities = useRef(modelFrameCapabilities([]));
  frameCapabilities.current = useMemo(
    () => modelFrameCapabilities(backendCatalog.models),
    [backendCatalog.models],
  );

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
        agents.find((model) => model.id === assistantModels.agent) ?? agents[0];
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
    return {
      settings: newNodeGenerationSettings(
        kind,
        backendCatalog.models,
        assistantModels,
      ),
    };
  };
  const lockedIds = useMemo(() => lockedNodeIds(doc.nodes), [doc.nodes]);
  runtime.t = t;
  runtime.locale = locale;
  runtime.setLocale = setLocale;
  runtime.mounted = mounted;
  runtime.flow = flow;
  runtime.historyRef = historyRef;
  runtime.historyReplayQueue = historyReplayQueue;
  runtime.doc = doc;
  runtime.liveCanvas = liveCanvas;
  runtime.versionCounts = versionCounts;
  runtime.switchPending = switchPending;
  runtime.revealCreatedNodes = revealCreatedNodes;
  runtime.viewportMoving = viewportMoving;
  runtime.selectedRef = selectedRef;
  runtime.selectionAtPointerDown = selectionAtPointerDown;
  runtime.marqueeClick = marqueeClick;
  runtime.pointerGesture = pointerGesture;
  runtime.assetListAnchor = assetListAnchor;
  runtime.flowSurface = flowSurface;
  runtime.dragging = dragging;
  runtime.bypassSnapping = bypassSnapping;
  runtime.connectionStarted = connectionStarted;
  runtime.importInput = importInput;
  runtime.saveStatusText = saveStatusText;
  runtime.notifications = notifications;
  runtime.notify = notify;
  runtime.dismiss = dismiss;
  runtime.editorOrigin = editorOrigin;
  runtime.mediaPublications = mediaPublications;
  runtime.editorSession = editorSession;
  runtime.editorSaving = editorSaving;
  runtime.actionSessionRef = actionSessionRef;
  runtime.quickAction = quickAction;
  runtime.resultInput = resultInput;
  runtime.resultBinding = resultBinding;
  runtime.importAbort = importAbort;
  runtime.backendCatalog = backendCatalog;
  runtime.selectionSource = selectionSource;
  runtime.jobs = jobs;
  runtime.setJobs = setJobs;
  runtime.readJobs = readJobs;
  runtime.toolCatalog = toolCatalog;
  runtime.setupChecked = setupChecked;
  runtime.theme = theme;
  runtime.serviceRuns = serviceRuns;
  runtime.generationByNode = generationByNode;
  runtime.clipboard = clipboard;
  runtime.clipboardMedia = clipboardMedia;
  runtime.pasting = pasting;
  runtime.pasteCount = pasteCount;
  runtime.fileInput = fileInput;
  runtime.uploadTarget = uploadTarget;
  runtime.uploadSource = uploadSource;
  runtime.referenceTarget = referenceTarget;
  runtime.root = root;
  runtime.assistantLayout = assistantLayout;
  runtime.toolbarElement = toolbarElement;
  runtime.composerElement = composerElement;
  runtime.focusSelection = focusSelection;
  runtime.saveQueue = saveQueue;
  runtime.saveError = saveError;
  runtime.spacePressed = spacePressed;
  runtime.panning = panning;
  runtime.single = single;
  runtime.textWindowNode = textWindowNode;
  runtime.selectedNodes = selectedNodes;
  runtime.composerNode = composerNode;
  runtime.composerIncoming = composerIncoming;
  runtime.referenceAssets = referenceAssets;
  runtime.actionSource = actionSource;
  runtime.actionNode = actionNode;
  runtime.activeAction = activeAction;
  runtime.frameCapabilities = frameCapabilities;
  runtime.center = center;
  runtime.snapshotModel = snapshotModel;
  runtime.lockedIds = lockedIds;
  return runtime;
}
