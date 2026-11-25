import { useSyncExternalStore } from "react";
import { getEditingState, subscribeEditingState } from "../backend/editSession.ts";
import { EditHandoff, useEditSession } from "./workspace/EditSession.tsx";
import { ReactFlowProvider } from "@xyflow/react";
import { TooltipProvider } from "./TooltipButton";
import { WorkspaceView } from "./workspace/WorkspaceView.tsx";
import { useWorkspaceChrome } from "./workspace/useWorkspaceChrome.ts";
import { useWorkspaceDocument } from "./workspace/useWorkspaceDocument.ts";
import { useWorkspaceEditor } from "./workspace/useWorkspaceEditor.ts";
import { useWorkspaceGeneration } from "./workspace/useWorkspaceGeneration.ts";
import { useWorkspaceInteraction } from "./workspace/useWorkspaceInteraction.tsx";
import { useWorkspaceRuntime } from "./workspace/useWorkspaceRuntime.ts";
import { useWorkspaceSelection } from "./workspace/useWorkspaceSelection.ts";
import { useWorkspaceTransfer } from "./workspace/useWorkspaceTransfer.ts";

export default function CanvasWorkspace() {
  return (
    <TooltipProvider>
      <ReactFlowProvider>
        <Workspace />
      </ReactFlowProvider>
    </TooltipProvider>
  );
}

function Workspace() {
  const rt = useWorkspaceRuntime();
  const editing = useSyncExternalStore(subscribeEditingState, () => getEditingState(rt.doc.id));
  const readOnly = editing?.mode === "preview";
  useWorkspaceSelection(rt);
  useWorkspaceChrome(rt);
  useWorkspaceDocument(rt, readOnly);
  const editSession = useEditSession(rt);
  useWorkspaceEditor(rt, readOnly);
  useWorkspaceGeneration(rt, readOnly || editSession.working);
  useWorkspaceTransfer(rt, readOnly);
  useWorkspaceInteraction(rt, readOnly);
  return <>
    <WorkspaceView rt={rt} editingState={editing} editSession={editSession} />
    {rt.ready && editing?.mode === "edit" && editing.requester &&
      <EditHandoff rt={rt} requester={editing.requester} session={editSession} />}
  </>;
}
