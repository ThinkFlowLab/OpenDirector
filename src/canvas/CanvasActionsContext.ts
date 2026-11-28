import { createContext, type MouseEvent } from "react";
import type { CanvasNode, CanvasNodeData } from "./model";
import type { NodeGenerationActivity } from "./generationActivity";
import type { TextSelections } from "./TextNodeEditor";
import type { SubjectMediaSlot } from "./subjectMedia.ts";

export interface CanvasActions {
  readOnly?: boolean;
  select: (id: string, event: MouseEvent) => void;
  reopenComposer: (id: string, event: MouseEvent) => void;
  update: (id: string, data: Partial<CanvasNodeData>) => void;
  rename: (id: string) => void;
  nameEdit?: { id: string; value: string } | null;
  changeNameDraft?: (value: string) => void;
  finishNameEdit?: (save: boolean) => void;
  versionCount?: (id: string) => number;
  versionsOpen?: (id: string) => boolean;
  showVersions?: (id: string, anchor: DOMRect) => void;
  upload: (id: string) => void;
  preview: (id: string) => void;
  newConnected: (id: string, direction: "source" | "target") => void;
  contextMenu: (id: string, event: MouseEvent) => void;
  beginEdit?: (id: string) => void;
  endEdit?: (id: string) => void;
  beginResize: () => void;
  endResize: () => void;
  textSelections: TextSelections;
  isTextEditing: (id: string) => boolean;
  finishTextEdit: () => void;
  edit: (id: string) => void;
  pickSubject?: (
    id: string,
    source: "file" | "canvas" | "assets" | "import",
    slot?: SubjectMediaSlot,
  ) => void;
  isLocked: (id: string) => boolean;
  getNode: (id: string) => CanvasNode | undefined;
  generationActivity: (id: string) => NodeGenerationActivity | undefined;
  isArriving: (id: string) => boolean;
  referenceTargetState?: (id: string) => "valid" | "invalid" | null;
  removeReference?: (id: string) => void;
  resizeSubjectDescription?: (id: string, contentHeight: number) => void;
  cycleStack: (id: string, delta: number) => void;
  metadata: (
    id: string,
    media: { width?: number; height?: number; durationSeconds?: number },
  ) => void;
}

export const CanvasActionsContext = createContext<CanvasActions | null>(null);
