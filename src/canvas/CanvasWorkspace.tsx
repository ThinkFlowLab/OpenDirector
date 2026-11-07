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
  useWorkspaceSelection(rt);
  useWorkspaceChrome(rt);
  useWorkspaceDocument(rt);
  useWorkspaceEditor(rt);
  useWorkspaceGeneration(rt);
  useWorkspaceTransfer(rt);
  useWorkspaceInteraction(rt);
  return <WorkspaceView rt={rt} />;
}
