import { useEffect, useRef } from "react";
import { errorMessage } from "../../backend/api.ts";
import { creationClient } from "../../backend/creationClient.ts";
import { type GenerationRequest } from "../../backend/generation.ts";
import { modelLabel } from "../../backend/rules.ts";

import { deliverTool, pendingToolDelivery } from "../../backend/toolDeliveries";
import { acknowledgeToolPlacement, cancelToolTask, submitToolTask, ToolSubmissionError } from "../../backend/tools.ts";
import { readEditorResource } from "../editorMedia";

import { expectedDuration, recordDuration } from "../generationDurations";
import { type GenerationJob as Job } from "../generationHistory";

import { lockedNodeIds } from "../hierarchy";
import { imageAnnotationPayload } from "../imageActionPayload";
import { appendPendingResult, removePendingResult, validateNodeActionSource, type GenerationResultMode, type LinkedMediaResult, type ResultSource } from "../linkedResults";
import { type CanvasNode } from "../model";
import { getNodeGenerationSettings } from "../NodeComposer";
import { serviceGenerationPlan, textGenerationPlan } from "../workspaceInteraction.ts";
import { generationPrepareBlock } from "./entryPoints.ts";
import { CANVAS_TOOLS, type CanvasToolTask } from "../toolCatalog";

import { translateToolText } from "../toolText.ts";
import type { WorkspaceRuntime } from "./runtimeTypes.ts";
import { toolOutputKind, jobTime, incomingNodes } from "./workspaceChrome.tsx";
import type { ServiceRun } from "./workspaceChrome.tsx";


export function useWorkspaceGeneration(rt: WorkspaceRuntime) {
  const {
    actionSessionRef,
    addLinkedOutputs,
    arrivingNodes,
    backendCatalog,
    change,
    closeAction,
    doc,
    generationByNode,
    historyRef,
    importAbort,
    jobs,
    locale,
    mounted,
    notify,
    persist,
    readJobs,
    ready,
    referenceAssets,
    resultBinding,
    serviceRuns,
    setActionSession,
    setActiveGenerations,
    setArrivingNodes,
    setJobs,
    snapshotModel,
    t,
    toolCatalog,
  } = rt;

  useEffect(() => {
    if (!arrivingNodes.size) return;
    const timer = window.setTimeout(() => setArrivingNodes(new Set()), 1200);
    return () => window.clearTimeout(timer);
  }, [arrivingNodes]);
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
        notify(t("canvas.workspace.toast.generationSubmitted"));
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
          notify(t("canvas.workspace.toast.toolDeliveryConfirmed"));
        } catch (error) {
          notify(errorMessage(error));
        }
        return;
      }
    }
    const entry = toolCatalog.tools.find((item) => item.id === task.tool);
    if (!entry?.available) {
      notify(entry?.reason ?? t("canvas.workspace.toast.toolUnavailable"));
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
      notify(t("canvas.workspace.toast.sourceMissing"));
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
    const title = translateToolText(
      locale,
      CANVAS_TOOLS.find((tool) => tool.id === task.tool)?.title ?? task.tool,
    );
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
        time: jobTime(locale),
        createdAt: run.startedAt,
        targetNodeId,
        targetKind: outputKind ?? undefined,
        targetTitle: targetNodeId ? title : undefined,
        durationKey: `tool:${task.tool}`,
        message: t("canvas.workspace.job.preparingTool"),
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
          message: t("canvas.workspace.job.saveFailed"),
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
      updateJob(id, { message: t("canvas.workspace.job.uploadingSources") });
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
          ? t("canvas.workspace.job.submitUnconfirmed")
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

  /** A job the service gives up on must say so: the node otherwise just stays
   * empty and the prompt looks like it did nothing. Failures that predate this
   * session are history, not news; a job we watched run always qualifies. */
  const failureWatch = useRef({
    mountedAt: Date.now(),
    active: new Set<string>(),
    reported: new Set<string>(),
  });
  useEffect(() => {
    const watch = failureWatch.current;
    for (const job of jobs) {
      if (job.status === "running") watch.active.add(job.id);
      if (job.status !== "failed" && job.status !== "interrupted") continue;
      if (watch.reported.has(job.id)) continue;
      const recent = (job.createdAt ?? 0) >= watch.mountedAt - 5_000;
      if (!recent && !watch.active.has(job.id)) continue;
      watch.reported.add(job.id);
      const node = [...doc.nodes, ...(doc.hiddenNodes ?? [])].find(
        (item) => item.id === (job.targetNodeId ?? job.nodeId),
      );
      const name = node?.data.title ?? job.targetTitle ?? job.title;
      // Tool jobs keep their reason in `message`; generation jobs have a phase
      // there, so only the explicit failure text may be shown.
      const detail = (job.failure ?? (job.tool ? job.message : undefined))?.trim();
      notify(
        detail
          ? t("generation.error.jobFailedDetail", { name, detail })
          : t("generation.error.jobFailed", { name }),
      );
    }
  }, [jobs, doc.nodes, doc.hiddenNodes, notify, t]);

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
  const submissionAssets = () => [
    ...(creationClient(doc.id).snapshot?.assets ?? []),
    ...referenceAssets.assets,
  ];
  const runServiceGeneration = (node: CanvasNode, incoming: CanvasNode[]) => {
    const document = historyRef.current.present;
    const plan = serviceGenerationPlan({
      document,
      node,
      incoming,
      models: backendCatalog.models,
      assets: submissionAssets(),
    });
    if (plan.status === "blocked") {
      notify(plan.message ?? t("canvas.workspace.error.modelUnavailable"));
      return;
    }
    const batchId = plan.count > 1 ? crypto.randomUUID() : undefined;
    for (let index = 0; index < plan.count; index++)
      void runServiceTask(
        { ...plan.request, batchId, executionSlot: index },
        plan.origin,
        plan.label,
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
    if (
      generationPrepareBlock({
        nodeFound: Boolean(node),
        locked: Boolean(node && lockedNodeIds(current.nodes).has(nodeId)),
        alreadyRunning:
          generationByNode.has(nodeId) ||
          [...serviceRuns.current.values()].some(
            (run) => run.documentId === current.id && run.nodeId === nodeId,
          ),
      }    )
    )
      return;
    if (!node) return;
    const incoming = incomingNodes(current, nodeId);
    if (node.type === "text") {
      const plan = textGenerationPlan({
        document: current,
        node,
        incoming,
        models: backendCatalog.models,
        assets: submissionAssets(),
      });
      if (plan.status === "blocked") {
        notify(plan.message ?? t("canvas.workspace.error.agentUnavailable"));
        return;
      }
      void runServiceTask(plan.request, plan.origin, plan.label);
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
      t("canvas.workspace.error.noGenerationModel"),
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
      notify(t("canvas.workspace.error.taskSourceInvalid"));
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
          throw new Error(t("canvas.workspace.error.resultNotMedia"));
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
        notify(error instanceof Error ? error.message : t("canvas.workspace.error.resultImportFailed"));
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
  rt.updateJob = updateJob;
  rt.refreshRunning = refreshRunning;
  rt.revealResults = revealResults;
  rt.syncServiceResults = syncServiceResults;
  rt.runServiceTask = runServiceTask;
  rt.runToolTask = runToolTask;
  rt.observedRuns = observedRuns;
  rt.failureWatch = failureWatch;
  rt.toolPlacementQueue = toolPlacementQueue;
  rt.placingTools = placingTools;
  rt.placementRetryAfter = placementRetryAfter;
  rt.submissionAssets = submissionAssets;
  rt.runServiceGeneration = runServiceGeneration;
  rt.cancelServiceRuns = cancelServiceRuns;
  rt.prepareGeneration = prepareGeneration;
  rt.importActionResultFiles = importActionResultFiles;
  rt.cancelResultImport = cancelResultImport;
}
