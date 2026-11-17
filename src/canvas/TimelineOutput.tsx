import { useEffect, useRef, useState } from "react";
import { creationClient, CreationCommandError } from "../backend/creationClient.ts";
import { CreationProjection } from "../backend/creationProjection.ts";
import { timelinePublication, timelineOutputItem } from "../backend/timelinePublication.ts";
import { errorMessage } from "../backend/api.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { NodeFrame } from "./NodeFrame";
import { GeneratingOverlay } from "./GeneratingOverlay";
import { timelineDuration } from "./timeline.ts";
import { mediaBlobDataUrl } from "./localMediaRuntime.ts";
import type { CanvasNode } from "./model.ts";
import type { LinkedMediaResult } from "./linkedResults.ts";
import "./timeline-output.css";

export type TimelineOutputPreview = {
  id: string;
  title: string;
  position: { x: number; y: number };
};

type OutputState = {
  output: TimelineOutputPreview;
  itemId: string;
  phase: "rendering" | "publishing" | "failed" | "done";
  progress: number;
  error?: string;
};

/** Rendering stays in this browser; publication uses the existing versioned command. */
export function useTimelineOutput(projectId: string, nodes: readonly CanvasNode[]) {
  const t = useT();
  const [state, setState] = useState<OutputState | null>(null);
  const active = useRef<AbortController | null>(null);
  const pending = useRef<{
    itemId: string;
    output: TimelineOutputPreview;
    publish: (result: LinkedMediaResult) => Promise<boolean>;
    result: LinkedMediaResult;
  } | null>(null);
  useEffect(
    () => () => {
      active.current?.abort();
      active.current = null;
      pending.current = null;
    },
    [projectId],
  );
  useEffect(() => {
    setState(null);
  }, [projectId]);

  useEffect(() => {
    if (!state || nodes.some((node) => node.id === state.itemId)) return;
    active.current?.abort();
    active.current = null;
    pending.current = null;
    setState(null);
  }, [nodes, state?.itemId]);

  const run = async (source: CanvasNode, save: () => Promise<boolean>) => {
    const itemId = source.id;
    if (
      active.current ||
      (pending.current && pending.current.itemId !== itemId)
    )
      return;
    const existing = timelineOutputItem(creationClient(projectId).snapshot, itemId);
    const output = pending.current?.output ?? {
      id: existing?.id ?? crypto.randomUUID(),
      title: t("timeline.action.renderTitle", { title: source.data.title }),
      position: existing?.position ?? {
        x: source.position.x,
        y: source.position.y + source.height + 160,
      },
    };
    const controller = new AbortController();
    active.current = controller;
    const owns = () => active.current === controller;
    setState({
      itemId,
      output,
      phase: pending.current ? "publishing" : "rendering",
      progress: 0,
    });
    try {
      const client = creationClient(projectId);
      if (!pending.current) {
        if (!(await save()))
          throw new Error(t("canvas.workspace.error.timelineUnsaved"));
        controller.signal.throwIfAborted();
        const snapshot = await client.refresh();
        const item = snapshot.canvasItems.find((entry) => entry.id === itemId);
        if (!item || item.binding.role !== "editor")
          throw new Error(t("errors.backend.timelineSourceMissing"));
        const editorId = item.binding.objectRef.id;
        const editor = snapshot.editorDocuments.find(
          (entry) => entry.id === editorId,
        );
        if (!editor || editor.kind !== "timeline")
          throw new Error(t("errors.backend.timelineSourceMissing"));
        const publish = timelinePublication(
          client,
          snapshot,
          itemId,
          output.position,
          output.id,
        );
        const { timeline } = await new CreationProjection(client).editorData(
          editor,
        );
        controller.signal.throwIfAborted();
        if (!timeline)
          throw new Error(t("errors.backend.timelineSourceMissing"));
        const { renderTimelineMp4 } = await import("./timelineRender.ts");
        const blob = await renderTimelineMp4(
          timeline,
          controller.signal,
          (progress) => {
            if (owns())
              setState({ itemId, output, phase: "rendering", progress });
          },
        );
        const src = await mediaBlobDataUrl(blob, controller.signal);
        controller.signal.throwIfAborted();
        pending.current = {
          itemId,
          output,
          publish,
          result: {
            kind: "video",
            src,
            mimeType: "video/mp4",
            title: t("timeline.action.renderTitle", { title: item.title }),
            media: {
              width: timeline.width,
              height: timeline.height,
              durationSeconds: timelineDuration(timeline),
            },
          },
        };
      }
      if (!owns()) return;
      setState({ itemId, output, phase: "publishing", progress: 1 });
      await pending.current.publish(pending.current.result);
      if (!owns()) return;
      pending.current = null;
      setState({ itemId, output, phase: "done", progress: 1 });
    } catch (reason) {
      if (owns() && reason instanceof CreationCommandError) pending.current = null;
      if (owns() && !controller.signal.aborted)
        setState({
          itemId,
          output,
          phase: "failed",
          progress: 0,
          error: errorMessage(reason),
        });
    } finally {
      if (owns()) {
        active.current = null;
        if (controller.signal.aborted) setState(null);
      }
    }
  };
  return {
    state,
    busy: state?.phase === "rendering" || state?.phase === "publishing",
    blockedItemId: pending.current?.itemId,
    run,
    cancel: () => {
      if (state?.phase === "rendering") active.current?.abort();
    },
  };
}

export function TimelineOutputShortcut({
  node,
  state,
  blocked,
  onRun,
}: {
  node: CanvasNode;
  state: OutputState | null;
  blocked: boolean;
  onRun: () => void;
}) {
  const timeline = node.data.timeline;
  const current = state?.itemId === node.id ? state : null;
  const running =
    current?.phase === "rendering" || current?.phase === "publishing";
  const disabled = blocked || !timeline || timelineDuration(timeline) <= 0;
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        event.shiftKey ||
        !(event.metaKey || event.ctrlKey) ||
        event.key !== "Enter" ||
        (target instanceof HTMLElement &&
          target.closest(
            'input,textarea,select,[contenteditable="true"],.cw-assistant-panel,.cw-settings-dialog',
          ))
      )
        return;
      if (
        target instanceof HTMLElement &&
        target.closest('[role="dialog"]')
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (!disabled && !running) onRun();
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [disabled, running, onRun]);
  return null;
}

export function TimelinePendingVideo({
  id,
  output,
  selected,
}: {
  id: string;
  selected: boolean;
  output: {
    title: string;
    phase: OutputState["phase"];
    progress: number;
    error?: string;
    onCancel: () => void;
    onRetry: () => void;
  };
}) {
  const t = useT();
  const failed = output.phase === "failed";
  return (
    <div
      className="cw-timeline-pending"
      onDoubleClickCapture={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDownCapture={(event) => {
        if (
          event.key === "F2" ||
          (event.key === "Enter" &&
            !(
              event.target instanceof HTMLElement &&
              event.target.closest("button")
            ))
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onContextMenuCapture={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <NodeFrame
        id={id}
        kind="video"
        title={output.title}
        selected={selected}
        empty
        busy={!failed}
      >
        {!failed && (
          <GeneratingOverlay
            hasAsset={false}
            activity={{
              phase: output.phase === "publishing" ? "finishing" : "generating",
              count: 1,
            }}
            progress={output.progress}
            label={
              output.phase === "publishing"
                ? t("timeline.output.publishing")
                : t("timeline.render.progress", {
                    percent: Math.round(output.progress * 100),
                  })
            }
          />
        )}
        {failed && (
          <div className="cw-timeline-pending-error" role="alert">
            {output.error}
          </div>
        )}
        <button
          type="button"
          className="cw-timeline-pending-action nodrag nopan"
          disabled={output.phase === "publishing"}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (failed) output.onRetry();
            else output.onCancel();
          }}
        >
          {failed
            ? t("timeline.output.retry")
            : t("timeline.action.cancelRender")}
        </button>
      </NodeFrame>
    </div>
  );
}
