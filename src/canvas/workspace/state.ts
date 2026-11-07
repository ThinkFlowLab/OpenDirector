import {
  useMemo,
  useReducer,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { ModelSelections } from "../../backend/chat.ts";
import type { ActiveGeneration } from "../generationActivity.ts";
import { createHistory, type CanvasHistory } from "../history.ts";
import type { ResultSource } from "../linkedResults.ts";
import { createDocument, type CanvasNode, type Point } from "../model.ts";
import type { SubjectMediaSlot } from "../subjectMedia.ts";
import type { CanvasToolId, ToolParameters } from "../toolCatalog.ts";
import type { SubjectImportTab } from "../library/SubjectImportDialog.tsx";
import type { PortSide } from "../connectionPorts.ts";

export type WorkspacePanel = "assets" | "search" | "history" | null;

export type WorkspaceMenu = {
  mode?: "create" | "context";
  x: number;
  y: number;
  world: Point;
  nodeId?: string;
  parentId?: string;
  connected?: {
    id: string;
    ids?: string[];
    direction: "source" | "target";
    side?: PortSide;
    anchor?: Point;
  };
};

export type WorkspaceEditorMode =
  | "default"
  | "layers"
  | "annotation"
  | "grid"
  | "mask"
  | "trim"
  | "frame"
  | "extract-audio"
  | "crop";

export type WorkspaceSaveStatus =
  | { state: "opening" | "saving" | "saved" }
  | { state: "savedViewFailed"; warning: string }
  | { state: "failed"; error: string };

export type WorkspaceVersionHistory = {
  projectId: string;
  itemId: string;
  anchor: DOMRect;
  preparation: Promise<void>;
};

export type WorkspaceSubjectImport = {
  projectId: string;
  nodeId: string;
  slot: SubjectMediaSlot;
  tab: SubjectImportTab;
  identity: string;
};

export type WorkspaceActionSession = ResultSource & {
  tool: CanvasToolId;
  token: string;
  parameters?: ToolParameters;
};

export type WorkspaceMeasurements = Record<
  string,
  { width: number; height: number }
>;

/** UI and document state that used to be one useState per field on Workspace. */
export type WorkspaceState = {
  history: CanvasHistory;
  historyReplaying: boolean;
  versionHistory: WorkspaceVersionHistory | null;
  ready: boolean;
  pageVisible: boolean;
  initializationError: string;
  editProjectNameId: string | null;
  projectRenaming: boolean;
  switching: boolean;
  selected: string[];
  hoveredNode: string | null;
  selectedEdges: string[];
  measurements: WorkspaceMeasurements;
  interacting: boolean;
  textEditingId: string | null;
  composerNodeId: string | null;
  dismissedComposer: string | null;
  expandedComposerId: string | null;
  textWindowId: string | null;
  assistantModels: ModelSelections;
  panel: WorkspacePanel;
  libraryOpen: boolean;
  subjectImport: WorkspaceSubjectImport | null;
  subjectLibraryBusy: boolean;
  zoomMenu: boolean;
  hand: boolean;
  toolRevision: number;
  minimap: boolean;
  showEdges: boolean;
  menu: WorkspaceMenu | null;
  saveStatus: WorkspaceSaveStatus;
  preview: CanvasNode | null;
  editing: CanvasNode | null;
  editorMode: WorkspaceEditorMode;
  actionSession: WorkspaceActionSession | null;
  actionMedia: HTMLDivElement | null;
  maskTool: CanvasToolId;
  rename: { id: string; value: string } | null;
  help: boolean;
  settingsOpen: boolean;
  businessHistory: { undo: boolean; redo: boolean };
  settingsCategory: "general" | "models";
  welcomeOpen: boolean;
  activeGenerations: ActiveGeneration[];
  arrivingNodes: ReadonlySet<string>;
  assistantOpen: boolean;
  assistantSelectionRequest: number;
  presentationFocus: number;
  zoom: number;
};

export type WorkspaceAction = {
  [K in keyof WorkspaceState]: {
    type: "set";
    key: K;
    value: SetStateAction<WorkspaceState[K]>;
  };
}[keyof WorkspaceState];

type WorkspaceSetterName<K extends keyof WorkspaceState> =
  `set${Capitalize<K & string>}`;

export type WorkspaceSetters = {
  [K in keyof WorkspaceState as WorkspaceSetterName<K>]: Dispatch<
    SetStateAction<WorkspaceState[K]>
  >;
};

const workspaceKeys = [
  "history",
  "historyReplaying",
  "versionHistory",
  "ready",
  "pageVisible",
  "initializationError",
  "editProjectNameId",
  "projectRenaming",
  "switching",
  "selected",
  "hoveredNode",
  "selectedEdges",
  "measurements",
  "interacting",
  "textEditingId",
  "composerNodeId",
  "dismissedComposer",
  "expandedComposerId",
  "textWindowId",
  "assistantModels",
  "panel",
  "libraryOpen",
  "subjectImport",
  "subjectLibraryBusy",
  "zoomMenu",
  "hand",
  "toolRevision",
  "minimap",
  "showEdges",
  "menu",
  "saveStatus",
  "preview",
  "editing",
  "editorMode",
  "actionSession",
  "actionMedia",
  "maskTool",
  "rename",
  "help",
  "settingsOpen",
  "businessHistory",
  "settingsCategory",
  "welcomeOpen",
  "activeGenerations",
  "arrivingNodes",
  "assistantOpen",
  "assistantSelectionRequest",
  "presentationFocus",
  "zoom",
] as const satisfies readonly (keyof WorkspaceState)[];

type MissingWorkspaceKey = Exclude<
  keyof WorkspaceState,
  (typeof workspaceKeys)[number]
>;
const _allWorkspaceKeys: MissingWorkspaceKey extends never ? true : never = true;
void _allWorkspaceKeys;

export function createWorkspaceState(): WorkspaceState {
  return {
    history: createHistory(createDocument()),
    historyReplaying: false,
    versionHistory: null,
    ready: false,
    pageVisible: typeof document === "undefined" ? true : !document.hidden,
    initializationError: "",
    editProjectNameId: null,
    projectRenaming: false,
    switching: false,
    selected: [],
    hoveredNode: null,
    selectedEdges: [],
    measurements: {},
    interacting: false,
    textEditingId: null,
    composerNodeId: null,
    dismissedComposer: null,
    expandedComposerId: null,
    textWindowId: null,
    assistantModels: {},
    panel: null,
    libraryOpen: false,
    subjectImport: null,
    subjectLibraryBusy: false,
    zoomMenu: false,
    hand: false,
    toolRevision: 0,
    minimap: false,
    showEdges: true,
    menu: null,
    saveStatus: { state: "opening" },
    preview: null,
    editing: null,
    editorMode: "default",
    actionSession: null,
    actionMedia: null,
    maskTool: "cutout",
    rename: null,
    help: false,
    settingsOpen: false,
    businessHistory: { undo: false, redo: false },
    settingsCategory: "general",
    welcomeOpen: false,
    activeGenerations: [],
    arrivingNodes: new Set(),
    assistantOpen: false,
    assistantSelectionRequest: 0,
    presentationFocus: 0,
    zoom: 1,
  };
}

export function workspaceReducer(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  const key = action.key;
  const current = state[key];
  const next = (
    typeof action.value === "function"
      ? (action.value as (prev: typeof current) => typeof current)(current)
      : action.value
  ) as typeof current;
  if (Object.is(current, next)) return state;
  return { ...state, [key]: next };
}

export function workspaceSetters(
  dispatch: Dispatch<WorkspaceAction>,
): WorkspaceSetters {
  const set =
    <K extends keyof WorkspaceState>(key: K) =>
    (value: SetStateAction<WorkspaceState[K]>) => {
      dispatch({ type: "set", key, value } as WorkspaceAction);
    };
  return Object.fromEntries(
    workspaceKeys.map((key) => [
      `set${key[0]!.toUpperCase()}${key.slice(1)}`,
      set(key),
    ]),
  ) as WorkspaceSetters;
}

export function useWorkspaceStore(): WorkspaceState & WorkspaceSetters {
  const [state, dispatch] = useReducer(
    workspaceReducer,
    undefined,
    createWorkspaceState,
  );
  const setters = useMemo(() => workspaceSetters(dispatch), [dispatch]);
  return { ...state, ...setters };
}
