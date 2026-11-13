import { useEffect, useMemo } from "react";

import { currentAsset } from "../../backend/creationClient";
import { creationClient } from "../../backend/creationClient.ts";

import { CreationEditorSession } from "../../backend/creationEditorSession";
import { MediaPublication } from "../../backend/mediaPublication";
import { backendModel } from "../../backend/rules.ts";
import { workspaceProjection } from "../../backend/workspace";

import { lockedNodeIds } from "../hierarchy";
import { captureEditorSource, validateNodeActionSource, type LinkedMediaResult, type ResultSource } from "../linkedResults";
import { type CanvasDocument, type CanvasNode, type CanvasNodeData } from "../model";
import { createVideoExtensionDraft } from "../nodeActionWorkflow";
import { getNodeGenerationSettings } from "../NodeComposer";
import { resourceFromNode } from "../operations";

import { persistCurrentDocument } from "../projectManagement";
import { createCanvasToolTask, type CanvasToolId, type CanvasToolTask, type ToolParameters } from "../toolCatalog";

import type { WorkspaceRuntime } from "./runtimeTypes.ts";
import type { EditorMode } from "./workspaceChrome.tsx";


export function useWorkspaceEditor(rt: WorkspaceRuntime) {
  const {
    actionNode,
    actionSession,
    backendCatalog,
    change,
    command,
    doc,
    editorOrigin,
    editorSaving,
    editorSession,
    focusSelection,
    historyRef,
    invalidateScheduledAutosave,
    lockedIds,
    mediaPublications,
    notify,
    persist,
    quickAction,
    resultBinding,
    resultInput,
    root,
    saveQueue,
    setActionSession,
    setEditing,
    setEditorMode,
    setHistory,
    setMenu,
    setPanel,
    setPreview,
    setSelected,
    single,
    t,
  } = rt;

  useEffect(() => {
    if (actionSession && !actionNode) setActionSession(null);
  }, [actionSession, actionNode]);
  useEffect(() => () => quickAction.current?.abort(), [doc.id]);

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
      notify(t("canvas.workspace.toast.unlockFirst"));
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
        notify(t("canvas.workspace.toast.editorUnsaved"));
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
      throw new Error(t("canvas.workspace.error.editorUnavailable"));
    const projectId = session.projection.client.id;
    if (historyRef.current.present.id !== projectId)
      throw new Error(t("canvas.workspace.error.editNotCommitted"));
    invalidateScheduledAutosave();
    editorSaving.current = true;
    try {
      await saveQueue.current!.wait();
      if (historyRef.current.present.id !== projectId)
        throw new Error(t("canvas.workspace.error.editNotCommitted"));
      if (!(await persist(historyRef.current.present)))
        throw new Error(t("canvas.workspace.error.editorDraftSaveFailed"));
      await session.apply(data);
      const client = session.projection.client,
        projection = workspaceProjection(projectId);
      const snapshot = client.snapshot;
      let next: CanvasDocument;
      try {
        next = await projection.read(snapshot);
      } catch {
        throw new Error(t("canvas.workspace.error.editorRefreshFailed"));
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
      notify(t("canvas.workspace.toast.editorSaved"));
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
    if (editorSaving.current) throw Error(t("canvas.workspace.error.editorSaving"));
    if (historyRef.current.present.id !== source.documentId)
      throw Error(t("canvas.workspace.error.resultNotCommitted"));
    invalidateScheduledAutosave();
    editorSaving.current = true;
    try {
      await saveQueue.current!.wait();
      const current = historyRef.current.present;
      if (current.id !== source.documentId)
        throw Error(t("canvas.workspace.error.resultNotCommitted"));
      if (!(await persist(current)))
        throw Error(t("canvas.workspace.error.resultSaveFailed"));
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
          throw Error(t("canvas.workspace.error.sourceChanged"));
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
      notify(
        t("canvas.workspace.toast.resultsSaved", {
          count: ids.length || outputs.length,
        }),
      );
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
  const openNodeAction = (tool: CanvasToolId, source = single, parameters?: ToolParameters) => {
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
    setActionSession({ ...origin, tool, token: crypto.randomUUID(), parameters });
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
      resultInput.current.accept = "image/*,.heic,.heif,video/*,audio/*";
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
    notify(t("canvas.workspace.toast.processingMedia"));
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
        notify(error instanceof Error ? error.message : t("canvas.workspace.toast.mediaProcessFailed"));
    } finally {
      if (quickAction.current === controller) quickAction.current = null;
    }
  };
  rt.resources = resources;
  rt.openEditor = openEditor;
  rt.closeEditor = closeEditor;
  rt.commitEditorData = commitEditorData;
  rt.addLinkedOutputs = addLinkedOutputs;
  rt.editorOutputs = editorOutputs;
  rt.sourceFor = sourceFor;
  rt.closeAction = closeAction;
  rt.openNodeAction = openNodeAction;
  rt.saveActionDraft = saveActionDraft;
  rt.importActionResults = importActionResults;
  rt.runQuickAction = runQuickAction;
}
