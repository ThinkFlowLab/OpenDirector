import { useEffect, useRef, useState } from "react";
import type { Asset, ProjectSnapshot } from "../contracts/generated.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import { deliveredTimelineState, type DeliveredTimeline, type ProjectEditorTarget, type ProjectTimelineTarget } from "./assistantResultEditors.ts";
import type { AssistantResult } from "./assistantResults.ts";
import { AssetThumbnail } from "./CreationAssetPreview.tsx";
import { CanvasIcon } from "./CanvasIcon.tsx";
import { assetDisplayName } from "./assetNames.ts";

function useResultAction() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const [error, setError] = useState("");
  async function open(action: (signal: AbortSignal) => Promise<void>) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    try {
      await action(controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : t("canvas.workspace.error.editorUnavailable"));
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return { open, busy, error };
}

export function AssistantResultCard({
  projectId, result, timelines, referenceDisabled, onPreview, onReference, onViewOnCanvas, onEdit,
}: {
  projectId: string;
  result: AssistantResult;
  timelines: (ProjectTimelineTarget & { itemId: string; title: string })[];
  onEdit: (target: ProjectEditorTarget, signal: AbortSignal) => Promise<void>;
  referenceDisabled: boolean;
  onPreview: (asset: Asset) => void;
  onReference: (asset: Asset) => void;
  onViewOnCanvas: (asset: Asset, itemId?: string | null) => Promise<void>;
}) {
  const t = useT();
  const { open, busy, error } = useResultAction();
  const [timelineId, setTimelineId] = useState("");
  const timeline = timelines.length === 1 ? timelines[0] : timelines.find(item => item.itemId === timelineId);
  const { asset, status } = result;
  const title = assetDisplayName(asset?.name ?? result.name ?? t("assistant.result.unavailable"));
  if (!asset) {
    return (
      <section className="cw-chat-result" aria-label={title} data-asset-id={result.assetId}>
        <div className="cw-chat-result-preview">
          <span className="cw-chat-result-details">
            <strong>{title}</strong>
            {result.name && <small>{t("assistant.result.unavailable")}</small>}
          </span>
        </div>
      </section>
    );
  }
  return (
    <section className="cw-chat-result" aria-label={title} data-asset-id={result.assetId}>
      <button type="button" className="cw-chat-result-preview"
        aria-label={t("assistant.result.preview")} onClick={() => onPreview(asset)}>
        <AssetThumbnail key={asset.id} projectId={projectId} asset={asset} />
        <span className="cw-chat-result-details">
          <strong>{title}</strong>
          <small>
            {t(`canvasNodes.kind.${asset.kind}`)}
            {status !== "asset" && <> · {t(`assistant.result.${status}`)}</>}
          </small>
          <span className="cw-chat-result-preview-label">
            <CanvasIcon name="preview" size={14} /> {t("assistant.result.preview")}
          </span>
        </span>
      </button>
      <div className="cw-chat-result-actions">
        <button type="button" disabled={referenceDisabled}
          onClick={() => onReference(asset)}>
          <CanvasIcon name="link" size={14} />{t("assistant.result.reference")}
        </button>
        {["image", "audio", "video"].includes(asset.kind) && (
          <button type="button" aria-disabled={busy}
            onClick={() => void open(signal => onEdit({ kind: "media", asset, itemId: result.itemId }, signal))}>
            <CanvasIcon name="edit" size={14} />{t("assistant.result.editMedia")}
          </button>
        )}
        <button type="button" aria-disabled={busy}
          onClick={() => void open(() => onViewOnCanvas(asset, result.itemId))}>
          <CanvasIcon name="canvas" size={14} />{t("assistant.result.viewOnCanvas")}
        </button>
      </div>
      {timelines.length > 0 && (
        <div className="cw-chat-result-actions">
          {timelines.length > 1 && (
            <select aria-label={t("assistant.result.timeline")} value={timeline?.itemId ?? ""}
              onChange={event => setTimelineId(event.target.value)}>
              <option value="">{t("assistant.result.timeline")}</option>
              {timelines.map(target => (
                <option key={target.itemId} value={target.itemId}>
                  {target.title || t("assistant.result.timeline")}
                  {(!target.title || timelines.some(other => other !== target && other.title === target.title)) &&
                    ` · ${target.itemId}`}
                </option>
              ))}
            </select>
          )}
          <button type="button" disabled={!timeline} aria-disabled={!timeline || busy}
            onClick={() => timeline && void open(signal => onEdit(timeline, signal))}>
            <CanvasIcon name="timeline" size={14} />{t("assistant.result.openTimeline")}
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export function AssistantTimelineResultCard({ result, projectId, eventCursor, snapshot, onEdit }: {
  result: DeliveredTimeline;
  projectId: string;
  eventCursor?: number;
  snapshot?: ProjectSnapshot;
  onEdit: (target: ProjectEditorTarget, signal: AbortSignal) => Promise<void>;
}) {
  const t = useT();
  const { open, busy, error } = useResultAction();
  const current = deliveredTimelineState(result, projectId, eventCursor, snapshot);
  const title = current.title || t("assistant.result.timeline");
  return (
    <section className="cw-chat-result" aria-label={title} data-editor-id={result.editorId}>
      <div className="cw-chat-result-preview">
        <CanvasIcon name="timeline" />
        <span className="cw-chat-result-details">
          <strong>{title}</strong>
          <small>{t("assistant.result.timelineVersion", { revision: result.revision })}</small>
          {current.status === "pending" && <small role="status">{t("assistant.result.syncingTimeline")}</small>}
          {current.status === "missing" && <small>{t("errors.backend.timelineSourceMissing")}</small>}
        </span>
      </div>
      {current.status === "available" && (
        <div className="cw-chat-result-actions">
          <button type="button" aria-disabled={busy} onClick={() => void open(signal => onEdit({
            kind: "timeline", projectId, itemId: result.itemId,
            editorId: result.editorId, revision: current.revision,
          }, signal))}>
            {current.revision === result.revision ? t("assistant.result.openTimeline")
              : t("assistant.result.openTimelineVersion", { revision: current.revision })}
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
