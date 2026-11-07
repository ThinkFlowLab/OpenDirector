import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { useToolCatalog } from "../../backend/tools.ts";
import type { Translate } from "../../i18n/I18nProvider.tsx";
import type { Locale } from "../../i18n/types.ts";
import type { GenerationJob } from "../generationHistory.ts";
import type { NodeGenerationActivity } from "../generationActivity.ts";
import type { CanvasHistory } from "../history.ts";
import type { LinkedMediaResult, ResultSource } from "../linkedResults.ts";
import type {
  CanvasCommand,
  CanvasDocument,
  CanvasNode,
  CanvasNodeData,
  CanvasNodeKind,
} from "../model.ts";
import { SaveQueue } from "../saveQueue.ts";
import { multiSelectionGeometry } from "../selectionReferences.ts";
import type { SubjectMediaSlot } from "../subjectMedia.ts";
import type { CanvasToolId, ToolParameters } from "../toolCatalog.ts";
import type { useCanvasReferences } from "../useCanvasReferences.ts";
import {
  type WorkspaceActionSession,
  type WorkspaceSetters,
  type WorkspaceState,
} from "./state.ts";
import type { ServiceRun } from "./workspaceChrome.tsx";

export type WorkspaceFlowNode = Node<CanvasNodeData, CanvasNodeKind>;

type CanvasReferences = ReturnType<typeof useCanvasReferences>;

/**
 * Shared bridge for the workspace hooks. Fields each hook owns stay on this
 * object so later hooks and the view read the same render's values.
 */
export interface WorkspaceRuntime extends WorkspaceState, WorkspaceSetters {
  doc: CanvasDocument;
  single: CanvasNode | null;
  composerNode: CanvasNode | undefined;
  textWindowNode: CanvasNode | undefined;
  selectedNodes: CanvasNode[];
  actionNode: CanvasNode | undefined;
  activeAction: WorkspaceActionSession | null;
  t: Translate;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  notify: (message: string) => void;
  flow: ReactFlowInstance<WorkspaceFlowNode, Edge>;
  jobs: GenerationJob[];
  setJobs: Dispatch<SetStateAction<GenerationJob[]>>;
  readJobs: (signal?: AbortSignal) => Promise<GenerationJob[]>;
  command: (value: CanvasCommand) => void;
  change: (fn: (document: CanvasDocument) => CanvasDocument) => void;
  begin: () => void;
  end: () => void;
  persist: (
    snapshot: CanvasDocument,
    saveView?: boolean,
    automatic?: boolean,
  ) => Promise<boolean>;
  installDocument: (next: CanvasDocument, fit?: boolean) => void;
  switchDocument: (
    read: () => CanvasDocument | Promise<CanvasDocument>,
    fit?: boolean,
    throwOnFailure?: boolean,
  ) => Promise<boolean>;
  historyRef: RefObject<CanvasHistory>;
  selectedRef: RefObject<string[]>;
  actionSessionRef: RefObject<WorkspaceActionSession | null>;
  lockedIds: Set<string>;
  serviceRuns: RefObject<Map<string, ServiceRun>>;
  references: CanvasReferences;
  generationByNode: ReadonlyMap<string, NodeGenerationActivity>;
  toolCatalog: ReturnType<typeof useToolCatalog>;
  selectionNodes: CanvasNode[];
  selectionGeometry: ReturnType<typeof multiSelectionGeometry>;
  referencePreviews: { sourceId: string; path: string }[];
  revealCreatedNodes: RefObject<
    (nodes: CanvasNode[], allNodes: CanvasNode[]) => void
  >;
  selectionAtPointerDown: RefObject<string[]>;
  root: RefObject<HTMLDivElement | null>;
  composerElement: RefObject<HTMLDivElement | null>;
  toolbarElement: RefObject<HTMLDivElement | null>;
  fileInput: RefObject<HTMLInputElement | null>;
  saveQueue: RefObject<SaveQueue<{
    snapshot: CanvasDocument;
    saveView: boolean;
  }> | null>;
  uploadSource: RefObject<{
    projectId: string;
    node: CanvasNode;
    subjectSlot?: SubjectMediaSlot;
  } | null>;
  runQuickAction: (
    operation: (
      source: ResultSource,
      signal: AbortSignal,
    ) => Promise<LinkedMediaResult[]>,
    tool: CanvasToolId,
    parameters?: ToolParameters,
  ) => Promise<void>;
  [key: string]: any;
}
