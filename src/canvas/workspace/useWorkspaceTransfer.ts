import { useEffect } from "react";
import { errorMessage } from "../../backend/api.ts";

import {
  canvasSources,
  copyCanvasSource,
  copySubjectAsset,
  type CanvasSource,
} from "../../backend/canvasSources";
import { creationClient } from "../../backend/creationClient.ts";
import { fingerprint } from "../../backend/generation.ts";

import {
  backUpLibrarySubject,
  copyLibrarySubjects,
} from "../../backend/subjectLibrary.ts";
import { importWorkspaceDocument, workspaceProjection } from "../../backend/workspace";
import { downloadFile, downloadFilename } from "../assets";
import { referenceIssueText, referenceIssue } from "../connectionPolicy";

import { sameNodeData } from "../dataBoundary.ts";
import { classifyImportFile, readEditorResource } from "../editorMedia";
import { lockedNodeIds } from "../hierarchy";
import { readImportBatch } from "../importBatch";
import {
  itemBlob,
  itemToResource,
  withMediaSuffix,
  type LibraryItem,
} from "../library/libraryClient";
import { type SubjectImportChoice } from "../library/SubjectImportDialog";
import { applyCommand, createNode, type CanvasCommand, type CanvasNode, type CanvasResource, type Point } from "../model";
import { copySelection, cutSelection, deleteSelection, groupSelection, pasteFragment, ungroupSelection, type CanvasFragment } from "../operations";

import { buildCanvasArchive, readCanvasArchive } from "../canvasArchive.ts";
import {
  captureClipboardMedia,
  transferClipboardMedia,
  type ClipboardMedia,
} from "../clipboardMedia.ts";
import { resourceNodeData } from "../projectAssets";
import { persistCurrentDocument } from "../projectManagement";
import { measureSubjectNodeHeight } from "../subjectLayoutMeasurement.ts";
import {
  librarySubjectCommand,
  mergeLibrarySubjectImport,
  subjectImportSelection,
  subjectTargetIdentity,
} from "../subjectLibraryImport.ts";
import { subjectWithResource, type SubjectMediaSlot } from "../subjectMedia.ts";
import { importedNodeIds, uploadPickerPlan } from "./entryPoints.ts";

import { assertUpload } from "../uploadPolicy.ts";
import { prefetchLibrary } from "../library/libraryPrefetch";
import type { WorkspaceRuntime } from "./runtimeTypes.ts";

export function useWorkspaceTransfer(rt: WorkspaceRuntime) {
  const {
    center,
    change,
    clipboard,
    clipboardMedia,
    command,
    doc,
    editing,
    fileInput,
    generationByNode,
    historyRef,
    importAbort,
    lockedIds,
    notify,
    pasteCount,
    pasting,
    persist,
    preview,
    ready,
    referenceTarget,
    resultBinding,
    resultInput,
    root,
    saveError,
    selectedEdges,
    selectedRef,
    setMenu,
    setPanel,
    setSelected,
    setSelectedEdges,
    setSubjectLibraryBusy,
    subjectImport,
    subjectLibraryBusy,
    switchDocument,
    switchPending,
    t,
    uploadSource,
    uploadTarget,
  } = rt;

  useEffect(() => {
    // Warm the library and the project selector after this canvas settles, so
    // both open from cache; switching projects warms the next one the same way.
    if (ready) prefetchLibrary(doc.id);
  }, [ready, doc.id]);

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
      throw new Error(saveError.current || t("canvas.workspace.error.importUnsaved"));
    if (historyRef.current.present.id !== current.id) return;
    change((latest) => mergeLibrarySubjectImport(latest, current, next));
    setSelected([node.id]);
    referenceTarget.current = null;
    setPanel(null);
    notify(t("canvas.workspace.toast.resourceCopied"));
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
        issues.push(
          t("canvas.workspace.toast.assetIssue", {
            name: item.name,
            reason: String(reason),
          }),
        );
      }
    }
    if (!placed)
      throw new Error(
        issues.join(t("canvas.workspace.list.separator")) ||
          t("canvas.workspace.error.noPlaceableAssets"),
      );
    if (issues.length)
      notify(
        t("canvas.workspace.toast.partialAssets", {
          items: issues.join(t("canvas.workspace.list.separator")),
        }),
      );
  };
  const importLibrarySubjects = async (items: LibraryItem[]) => {
    if (subjectLibraryBusy || switchPending.current)
      throw new Error(t("canvas.workspace.error.busy"));
    const projectId = historyRef.current.present.id;
    setSubjectLibraryBusy(true);
    try {
      if (
        !(await persistCurrentDocument(
          () => historyRef.current.present,
          persist,
        ))
      )
        throw new Error(t("canvas.workspace.error.subjectNotImported"));
      const copies = await copyLibrarySubjects(projectId, items);
      const current = historyRef.current.present;
      if (current.id !== projectId || switchPending.current)
        throw new Error(t("canvas.workspace.error.importNotApplied"));
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
          saveError.current || t("canvas.workspace.error.subjectImportUnsaved"),
        );
      if (historyRef.current.present.id !== projectId) return;
      change((latest) => mergeLibrarySubjectImport(latest, current, next));
      const previousIds = new Set(current.nodes.map((node) => node.id));
      setSelected(
        next.nodes
          .filter((node) => !previousIds.has(node.id))
          .map((node) => node.id),
      );
      notify(
        t("canvas.workspace.toast.subjectsImported", {
          count: copies.length,
        }),
      );
    } finally {
      setSubjectLibraryBusy(false);
    }
  };

  const confirmSubjectImport = async (choice: SubjectImportChoice) => {
    const intent = subjectImport;
    if (!intent || subjectLibraryBusy || switchPending.current)
      throw new Error(t("canvas.workspace.error.busy"));
    const assertTarget = () => {
      const current = historyRef.current.present;
      const { node, issue } = subjectImportSelection(current, [intent.nodeId]);
      if (
        current.id !== intent.projectId ||
        issue ||
        !node ||
        subjectTargetIdentity(node) !== intent.identity
      )
        throw new Error(issue || t("canvas.workspace.error.subjectTargetChanged"));
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
        throw new Error(t("canvas.workspace.error.saveCanvasFirst"));
      let source: import("../model").SubjectData;
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
        throw new Error(saveError.current || t("canvas.workspace.error.subjectImportFailed"));
      if (historyRef.current.present.id === intent.projectId)
        change((latest) =>
          mergeLibrarySubjectImport(latest, current, next, node.id),
        );
      notify(t("canvas.workspace.toast.subjectImported"));
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
      throw new Error(t("canvas.workspace.error.saveFirst"));
    // Rows of the open canvas come from the document, which carries no revision
    // until the server is asked; only copying needs one.
    const resolved =
      source.revision || originProjectId !== projectId
        ? source
        : ((await canvasSources(originProjectId, { fresh: true })).find(
            (entry) => entry.nodeId === source.nodeId,
          ) ?? source);
    const copied = await copyCanvasSource(
      projectId,
      originProjectId,
      resolved,
      "main",
      false,
    );
    if (historyRef.current.present.id !== projectId)
      throw new Error(t("canvas.workspace.error.projectSwitched"));
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
        throw new Error(saveError.current || t("canvas.workspace.error.importFailed"));
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
      throw new Error(t("canvas.workspace.error.selectSubjectNode"));
    if (subjectLibraryBusy || switchPending.current)
      throw new Error(t("canvas.workspace.error.busy"));
    setSubjectLibraryBusy(true);
    try {
      if (
        !(await persistCurrentDocument(
          () => historyRef.current.present,
          persist,
        ))
      )
        throw new Error(t("canvas.workspace.error.saveCanvasFirst"));
      if (historyRef.current.present.id !== current.id)
        throw new Error(t("canvas.workspace.error.reselectSubject"));
      await backUpLibrarySubject(current.id, node.id);
    } finally {
      setSubjectLibraryBusy(false);
    }
  };
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
      if (issue) issues.add(referenceIssueText(issue));
      else working.edges.push({ id: crypto.randomUUID(), source, target });
    }
    return {
      commands: working.edges
        .slice(present.edges.length)
        .map((edge): CanvasCommand => ({ type: "add-edge", edge })),
      issue: issues.size
        ? t("canvas.workspace.error.notConnectedAsReference", {
            items: [...issues].join(
              t("canvas.workspace.list.enumeration"),
            ),
          })
        : "",
    };
  };

  const removeSelected = () => {
    const ids = selectedRef.current;
    change((document) => deleteSelection(document, ids, selectedEdges));
    setSelected([]);
    setSelectedEdges([]);
    setMenu(null);
  };
  const captureMedia = (fragment: CanvasFragment) => {
    const projectId = historyRef.current.present.id;
    const client = creationClient(projectId);
    return captureClipboardMedia(projectId, fragment, {
      resolve: (src, assetId) => {
        // A just-imported node may show its upload before it records the asset.
        const asset = assetId
          ? client.snapshot.assets.find((asset) => asset.id === assetId)
          : client.assetForSource(src);
        return asset && { assetId: asset.id, fingerprint: asset.fingerprint };
      },
    });
  };
  const copy = () => {
    clipboard.current = copySelection(
      historyRef.current.present,
      selectedRef.current,
    );
    clipboardMedia.current = captureMedia(clipboard.current);
    pasteCount.current = 0;
    notify(
      t("canvas.workspace.toast.copied", {
        count: clipboard.current.nodes.length,
      }),
    );
  };
  const cut = () => {
    const movable = selectedRef.current.filter((id) => !lockedIds.has(id));
    if (!movable.length) {
      notify(t("canvas.workspace.toast.selectEditable"));
      return;
    }
    const result = cutSelection(historyRef.current.present, movable);
    if (!result.fragment) {
      notify(t("canvas.workspace.toast.cutLocked"));
      return;
    }
    const fragment = result.fragment;
    change(() => result.document);
    clipboard.current = fragment;
    clipboardMedia.current = captureMedia(fragment);
    pasteCount.current = 0;
    setSelected([]);
    setMenu(null);
    notify(
      t("canvas.workspace.toast.cut", { count: fragment.nodes.length }),
    );
  };
  const paste = (duplicate = false) => {
    const before = historyRef.current.present;
    const fragment = duplicate
      ? copySelection(before, selectedRef.current)
      : clipboard.current;
    if (!fragment?.nodes.length) return;
    const media = clipboardMedia.current;
    if (!duplicate && media && media.projectId !== before.id) {
      void pasteFromProject(fragment, media);
      return;
    }
    insertFragment(fragment, 40 * (duplicate ? 1 : ++pasteCount.current));
  };
  const pasteFromProject = async (
    fragment: CanvasFragment,
    media: ClipboardMedia,
  ) => {
    if (pasting.current) return;
    pasting.current = true;
    const projectId = historyRef.current.present.id;
    try {
      const transferred = await transferClipboardMedia(
        fragment,
        media,
        projectId,
        async (blob, title, kind, source) => {
          const client = creationClient(projectId);
          const upload = () =>
            client.importBlob(blob, withMediaSuffix(title, blob.type), kind);
          // Saved media is copied on the server. Unsaved media, or a source
          // that changed or is gone, is uploaded from the bytes captured at copy.
          const ref = source
            ? await client.copyAsset(source).catch(upload)
            : await upload();
          // The page already holds these bytes; reading them back is not needed.
          return {
            assetId: ref.assetId,
            src: await client.adoptMedia(ref.assetId, blob),
          };
        },
      );
      if (historyRef.current.present.id !== projectId) return;
      insertFragment(transferred, 40 * ++pasteCount.current);
    } catch (error) {
      notify(
        t("canvas.workspace.toast.crossCanvasPasteFailed", {
          error: errorMessage(error),
        }),
      );
    } finally {
      pasting.current = false;
    }
  };
  const insertFragment = (fragment: CanvasFragment, distance: number) => {
    const before = historyRef.current.present;
    const result = pasteFragment(before, fragment, {
      x: distance,
      y: distance,
    });
    change(() => result.document);
    // Keep each paste in its own durable undo step, even inside the autosave debounce.
    void persist(before, false);
    void persist(result.document, false);
    setSelected(result.ids);
    setMenu(null);
    root.current?.focus({ preventScroll: true });
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
      else notify(t("canvas.workspace.toast.noDownloadableAsset"));
    } catch (error) {
      notify(error instanceof Error ? error.message : t("canvas.workspace.toast.downloadFailed"));
    }
  };
  const exportDocument = async () => {
    try {
      const archive = await buildCanvasArchive(historyRef.current.present);
      downloadFile(archive.blob, archive.filename);
    } catch (error) {
      notify(errorMessage(error));
    }
  };
  const importDocument = async (file: File) => {
    try {
      const contents = await readCanvasArchive(file);
      const switched = await switchDocument(
        () => importWorkspaceDocument(contents.document),
        true,
        true,
      );
      if (switched)
        notify(
          t("canvas.workspace.toast.archiveImported", {
            title: contents.document.title,
            count: contents.assets,
          }),
        );
    } catch (error) {
      notify(errorMessage(error));
    }
  };
  const openFilePicker = (
    id: string | null = null,
    subjectSlot?: SubjectMediaSlot,
  ) => {
    const selected = historyRef.current.present.nodes.find(
      (node) => node.id === id,
    );
    const plan = uploadPickerPlan({
      hasTarget: Boolean(id),
      locked: Boolean(id && lockedIds.has(id)),
      generating: Boolean(id && generationByNode.has(id)),
      nodeType: selected?.type,
      hasSrc: Boolean(selected?.data.src),
      mediaRole: selected?.data.mediaRole,
      subjectSlot,
    });
    if (plan.blocked === "locked") {
      notify(t("canvas.workspace.toast.unlockFirst"));
      return;
    }
    if (plan.blocked === "generation-output") {
      notify(t("canvas.workspace.toast.generationNoReplace"));
      return;
    }
    if (plan.blocked === "generating") {
      notify(t("canvas.workspace.toast.nodeGenerating"));
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
      fileInput.current.multiple = plan.multiple;
      fileInput.current.accept = plan.accept;
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
        throw new Error(t("canvas.workspace.error.replaceSingleFile"));
      if (
        target &&
        (!expected ||
          expected.projectId !== importDocumentId ||
          expected.node.id !== target)
      )
        throw new Error(t("canvas.workspace.error.uploadTargetChanged"));
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
              throw new Error(t("canvas.workspace.error.subjectNeedsMedia"));
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
          throw new Error(t("canvas.workspace.error.uploadNodeChanged"));
      }
      if (historyRef.current.present.id !== importDocumentId) {
        notify(t("canvas.workspace.toast.importCancelledSwitched"));
        return;
      }
      if (
        target &&
        !historyRef.current.present.nodes.some((n) => n.id === target)
      ) {
        notify(t("canvas.workspace.toast.importCancelledDeleted"));
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
        importedNodeIds({
          targetId: target,
          referenceTargetId: refTarget,
          createdIds: nodes.map((n) => n.id),
        }),
      );
      const importSummary = failures.length
        ? `${t("canvas.workspace.toast.importedAssets", {
            count: successes.length,
          })}${t("canvas.workspace.toast.importFailures", {
            count: failures.length,
            items: failures
              .map((item) =>
                t("canvas.workspace.toast.assetIssue", {
                  name: item.name,
                  reason: item.message,
                }),
              )
              .join(t("canvas.workspace.list.separator")),
          })}`
        : t("canvas.workspace.toast.importedAssetsSaved", {
            count: successes.length,
          });
      notify(`${importSummary}${linked.issue}`);
    } catch (error) {
      if (!controller.signal.aborted)
        notify(error instanceof Error ? error.message : t("canvas.workspace.toast.assetImportFailed"));
    } finally {
      if (importAbort.current === controller) importAbort.current = null;
    }
  };
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || !ready || switchPending.current) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (
        editing ||
        preview ||
        (target !== document.body &&
          target !== root.current &&
          !target.closest(".react-flow"))
      )
        return;
      if (
        target.closest(
          "input,textarea,select,[contenteditable=true],[role=dialog]",
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
  rt.importCanvasResource = importCanvasResource;
  rt.insertLibraryItems = insertLibraryItems;
  rt.importLibrarySubjects = importLibrarySubjects;
  rt.confirmSubjectImport = confirmSubjectImport;
  rt.importCanvasSource = importCanvasSource;
  rt.backupLibrarySubject = backupLibrarySubject;
  rt.referenceEdges = referenceEdges;
  rt.removeSelected = removeSelected;
  rt.captureMedia = captureMedia;
  rt.copy = copy;
  rt.cut = cut;
  rt.paste = paste;
  rt.pasteFromProject = pasteFromProject;
  rt.insertFragment = insertFragment;
  rt.group = group;
  rt.ungroup = ungroup;
  rt.downloadNode = downloadNode;
  rt.exportDocument = exportDocument;
  rt.importDocument = importDocument;
  rt.openFilePicker = openFilePicker;
  rt.importFiles = importFiles;
}
