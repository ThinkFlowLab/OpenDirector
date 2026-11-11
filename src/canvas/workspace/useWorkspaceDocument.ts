
import { pinnedReferenceAssets } from "../pinnedReferenceAssets.ts";
import { SaveQueue } from "../saveQueue.ts";
import { useCallback, useEffect, useRef } from "react";
import { errorMessage } from "../../backend/api.ts";
import { creationClient, CreationCommandError, itemSpec } from "../../backend/creationClient.ts";
import { fingerprint } from "../../backend/generation.ts";

import { openBackendProject } from "../../backend/projects.ts";
import { createWorkspaceProject, initializeWorkspace, listWorkspaceProjects, openWorkspaceProject, renameWorkspaceProject, saveWorkspaceDocument, trashWorkspaceProject, workspaceProjection, type WorkspaceProject } from "../../backend/workspace";

import { fingerprintMatches } from "../chatReferenceContent.ts";
import { referenceIssueText, referenceIssue } from "../connectionPolicy";

import { referenceContentCommand } from "../generationReferenceEdit.ts";
import type { GenerationReferenceControls } from "../GenerationReferenceEditor";
import { lockedNodeIds } from "../hierarchy";
import { beginTransaction, commitTransaction, createHistory, executeCommand, recordChange, sameCanvasContent } from "../history";
import { type CanvasCommand, type CanvasDocument, type CanvasNode } from "../model";

import { deleteOpenProject, persistCurrentDocument } from "../projectManagement";
import type { WorkspaceRuntime } from "./runtimeTypes.ts";

export function useWorkspaceDocument(rt: WorkspaceRuntime) {
  const {
    doc,
    editorOrigin,
    editorSaving,
    flow,
    flowSurface,
    frameCapabilities,
    historyRef,
    historyReplayQueue,
    historyReplaying,
    importAbort,
    notify,
    pointerGesture,
    projectRenaming,
    quickAction,
    ready,
    referenceAssets,
    referenceTarget,
    resultBinding,
    revealCreatedNodes,
    saveError,
    saveQueue,
    setActionSession,
    setArrivingNodes,
    setAssistantOpen,
    setAssistantSelectionRequest,
    setBusinessHistory,
    setComposerNodeId,
    setDismissedComposer,
    setEditing,
    setHand,
    setHistory,
    setHistoryReplaying,
    setInitializationError,
    setInteracting,
    setMeasurements,
    setMenu,
    setPageVisible,
    setPanel,
    setPreview,
    setProjectRenaming,
    setReady,
    setRename,
    setSaveStatus,
    setSelected,
    setSelectedEdges,
    setSwitching,
    setTextEditingId,
    setTextWindowId,
    setZoomMenu,
    switchPending,
    switching,
    t,
    textEditingId,
    uploadTarget,
  } = rt;

  const autosaveEpoch = useRef(0);
  const invalidateScheduledAutosave = useCallback(() => {
    autosaveEpoch.current++;
  }, []);

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
      return snapshot && spec
        ? pinnedReferenceAssets(snapshot, spec.id)
        : [];
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
        ? referenceIssueText(issue)
        : null;
    },
    prepareAsset: async (asset, signal) => {
      const bytes = await creationClient(doc.id).blob(asset.id);
      signal.throwIfAborted();
      if (!fingerprintMatches(asset, await fingerprint(bytes)))
        throw new Error(t("canvas.workspace.error.referenceAssetChanged"));
      {
        const client = creationClient(doc.id);
        const record = client.snapshot.assets.find(
          (item) => item.id === asset.id,
        );
        if (!record) throw new Error(t("canvas.workspace.error.assetMissing"));
        signal.throwIfAborted();
        return record.kind === "text"
          ? { text: await client.textContent(record.id) }
          : { src: await client.mediaUrl(record.id, { signal }) };
      }
    },
    onChange: (content, sources) => {
      const current = historyRef.current.present;
      if (current.id !== doc.id || lockedNodeIds(current.nodes).has(target.id))
        throw new Error(t("canvas.workspace.error.referenceBatchStale"));
      const edit = referenceContentCommand(
        current,
        target.id,
        content,
        sources,
      );
      command(edit);
    },
    removeReference: (source) => {
      const ids = historyRef.current.present.edges
        .filter(
          (edge) =>
            edge.intent !== "post_edit_result" &&
            edge.source === source.id &&
            edge.target === target.id,
        )
        .map((edge) => edge.id);
      if (ids.length) command({ type: "remove-edges", ids });
    },
  });
  const command = useCallback(
    (value: CanvasCommand) =>
      setHistory((h) => executeCommand(h, value, frameCapabilities.current)),
    [],
  );
  const change = useCallback(
    (fn: (document: CanvasDocument) => CanvasDocument) =>
      setHistory((h) => recordChange(h, fn(h.present))),
    [],
  );
  const begin = useCallback(() => setHistory(beginTransaction), []);
  const end = useCallback(() => setHistory(commitTransaction), []);

  if (!saveQueue.current) {
    saveQueue.current = new SaveQueue(async ({ snapshot, saveView }) => {
      try {
        const projection = workspaceProjection(snapshot.id);
        // A preceding write can change the baseline while this save waits.
        if (
          saveView &&
          projection.baseline &&
          sameCanvasContent(snapshot, projection.baseline)
        ) {
          await projection.saveView(snapshot);
        } else {
          await saveWorkspaceDocument(snapshot, { saveView });
        }
        saveError.current = "";
        if (historyRef.current.present === snapshot) {
          const warning = workspaceProjection(snapshot.id).viewError;
          setSaveStatus(
            warning
              ? { state: "savedViewFailed", warning }
              : { state: "saved" },
          );
        }
        return true;
      } catch (error) {
        const message =
          error instanceof CreationCommandError &&
          error.receipt.issues.some((issue) => issue.code === "revision_conflict")
            ? t("errors.backend.saveConflict")
            : errorMessage(error);
        saveError.current = message;
        setSaveStatus({ state: "failed", error: message });
        return false;
      }
    });
  }
  const persist = useCallback(
    (
      snapshot: CanvasDocument,
      saveView = true,
      automatic = false,
    ): Promise<boolean> =>
      saveQueue.current!.enqueue(
        { snapshot, saveView },
        automatic ? snapshot.id : undefined,
      ),
    [],
  );

  const replayHistory = (forward = false) => {
    if (historyReplayQueue.current) {
      historyReplayQueue.current.push(forward);
      return;
    }
    const requests = [forward];
    historyReplayQueue.current = requests;
    setHistoryReplaying(true);
    const projectId = historyRef.current.present.id;
    void (async () => {
      if (!(await persist(historyRef.current.present, false))) return;
      for (const redo of requests) {
        if (switchPending.current || historyRef.current.present.id !== projectId)
          return;
        await creationClient(projectId).undo(redo);
      }
    })()
      .catch((error) => notify(errorMessage(error)))
      .finally(() => {
        historyReplayQueue.current = null;
        setHistoryReplaying(false);
      });
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
      setTextWindowId(null);
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
      const fitAll =
        fit ||
        (next.viewPersisted === false && next.nodes.length > 0);
      requestAnimationFrame(() => {
        void flow.setViewport(next.viewport);
        if (fitAll)
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
          if (throwOnFailure) throw new Error(t("canvas.workspace.error.switchSaveFailed"));
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
          const message = t("canvas.workspace.error.switchReopenFailed", {
            error: errorMessage(reopenError),
          });
          if (throwOnFailure) throw new Error(message);
          notify(message);
          return false;
        }
        if (throwOnFailure) throw error;
        notify(error instanceof Error ? error.message : t("canvas.workspace.error.openCanvasFailed"));
        return false;
      } finally {
        switchPending.current = false;
        setSwitching(false);
      }
    },
    [installDocument, persist, notify],
  );

  const renameCurrentProject = async (name: string) => {
    if (switchPending.current) throw new Error(t("canvas.workspace.error.projectSaving"));
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
        throw new Error(t("canvas.workspace.error.renameUnsaved"));
      const project = (await listWorkspaceProjects()).projects.find(
        (item) => item.id === projectId,
      );
      if (!project) throw new Error(t("canvas.workspace.error.projectMissing"));
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

  const renameProject = async (project: WorkspaceProject, nextName: string) => {
    if (project.id === historyRef.current.present.id)
      return renameCurrentProject(nextName);
    if (switchPending.current) throw new Error(t("canvas.workspace.error.projectSaving"));
    await renameWorkspaceProject(project, nextName);
  };

  const deleteProject = async (project: WorkspaceProject) => {
    if (switchPending.current) throw new Error(t("canvas.workspace.error.projectSaving"));
    if (project.id !== historyRef.current.present.id) {
      await trashWorkspaceProject(project);
      return;
    }
    // The open project goes away with its lease, so the workspace must move to
    // another document instead of saving into a deleted folder. The move starts
    // once the project is gone; loading the next canvas must not hold the
    // confirmation open, because that can take as long as the project is big.
    switchPending.current = true;
    setSwitching(true);
    importAbort.current?.abort();
    const openNext = async (
      next: WorkspaceProject | undefined,
      taken: Set<string>,
    ) => {
      if (next) installDocument(await openWorkspaceProject(next), true);
      else {
        let freshName = t("canvas.workspace.error.projectUntitled");
        for (let suffix = 2; ; suffix++) {
          if (!taken.has(freshName.toLocaleLowerCase())) break;
          freshName = t("canvas.workspace.error.projectUntitledSuffix", {
            suffix,
          });
        }
        installDocument(
          await openWorkspaceProject(
            await createWorkspaceProject(freshName, crypto.randomUUID()),
          ),
          true,
        );
      }
    };
    try {
      await deleteOpenProject(project, {
        // The open canvas already holds the authoritative revision; deleting it
        // must not transfer the same snapshot again.
        snapshot: creationClient(project.id).snapshot,
        flush: async () => {
          if (
            !(await persistCurrentDocument(
              () => historyRef.current.present,
              persist,
            ))
          )
            throw new Error(t("canvas.workspace.error.deleteUnsaved"));
        },
        list: listWorkspaceProjects,
        trash: trashWorkspaceProject,
        openNext,
        fail: (error) =>
          notify(
            t("canvas.workspace.error.deletedNextOpenFailed", {
              error: errorMessage(error),
            }),
          ),
        settle: () => {
          switchPending.current = false;
          setSwitching(false);
        },
      });
    } catch (error) {
      switchPending.current = false;
      setSwitching(false);
      throw error;
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
    if (!ready || switching || projectRenaming || historyReplaying || editorSaving.current) return;
    // An open editing transaction (inline text, layer and other drag edits) must
    // not be flushed mid-gesture. Saving each keystroke rewrote the text asset,
    // moved the item's binding and re-rendered the field, which dropped the
    // caret and split IME composition. finishTextEdit flushes when the edit ends.
    if (historyRef.current.transaction) return;
    const baseline = workspaceProjection(doc.id).baseline;
    const contentChanged = !baseline || !sameCanvasContent(doc, baseline);
    const epoch = autosaveEpoch.current;
    if (contentChanged) setSaveStatus({ state: "saving" });
    const timeout = setTimeout(() => {
      // An editor transaction explicitly flushes the current canvas draft.
      // Its preceding timer must not save that old document after the receipt.
      if (epoch === autosaveEpoch.current && !switchPending.current && !editorSaving.current)
        void persist(doc, true, true);
    }, contentChanged ? 450 : 900);
    return () => clearTimeout(timeout);
  }, [doc, ready, switching, projectRenaming, historyReplaying, persist, textEditingId]);
  useEffect(() => {
    if (!ready) return;
    const client = creationClient(doc.id),
      projection = workspaceProjection(doc.id),
      queue = saveQueue.current!;
    let active = true,
      token = 0,
      waitingForSave = false;
    const update = () => {
      if (!active) return;
      // A pending paste can make a later local delete look clean against
      // the old baseline until the paste receipt reaches the save queue.
      if (queue.busy) {
        if (!waitingForSave) {
          waitingForSave = true;
          void queue.wait().then(() => {
            waitingForSave = false;
            update();
          });
        }
        return;
      }
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
          if (active && queue.busy) {
            update();
            return;
          }
          // Editor commits and newer notifications may finish while read()
          // hydrates resources. A late read must not roll their CAS basis back,
          // including when its visible content happens to be unchanged.
          if (
            !active ||
            ticket !== token ||
            editorSaving.current ||
            client.snapshot !== snapshot ||
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
          // Compare authoritative identities, including hidden items that have
          // never been visible. History replay and re-showing retain them.
          const known = new Set(
            (projection.basis?.canvasItems ?? []).map((item) => item.id),
          );
          projection.baseline = merged;
          projection.basis = snapshot;
          setHistory((history) => ({ ...history, present: merged }));
          const created = next.nodes.filter((node) => !known.has(node.id));
          if (created.length) requestAnimationFrame(() => {
            if (active && historyRef.current.present.id === current.id) revealCreatedNodes.current(created, next.nodes);
          });
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
      void creationClient(doc.id)
        .history()
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
    const epoch = autosaveEpoch.current;
    const canPersist = !editorSaving.current;
    const flush = () => {
      setPageVisible(!document.hidden);
      if (document.visibilityState === "hidden" && ready && canPersist &&
        epoch === autosaveEpoch.current && !editorSaving.current)
        void persist(historyRef.current.present);
    };
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, [doc, persist, ready]);
  rt.generationReferenceControls = generationReferenceControls;
  rt.command = command;
  rt.change = change;
  rt.invalidateScheduledAutosave = invalidateScheduledAutosave;
  rt.begin = begin;
  rt.end = end;
  rt.persist = persist;
  rt.replayHistory = replayHistory;
  rt.installDocument = installDocument;
  rt.switchDocument = switchDocument;
  rt.renameCurrentProject = renameCurrentProject;
  rt.renameProject = renameProject;
  rt.deleteProject = deleteProject;
}
