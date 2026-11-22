import { useState } from "react";
import type { Asset } from "../contracts/generated.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import type { AssistantResult } from "./assistantResults.ts";
import { AssetThumbnail } from "./CreationAssetPreview.tsx";
import { CanvasIcon } from "./CanvasIcon.tsx";
import { assetDisplayName } from "./assetNames.ts";

export function AssistantResultCard({
  projectId, result, referenceDisabled, onPreview, onReference, onViewOnCanvas,
}: {
  projectId: string;
  result: AssistantResult;
  referenceDisabled: boolean;
  onPreview: (asset: Asset) => void;
  onReference: (asset: Asset) => void;
  onViewOnCanvas: (asset: Asset, itemId?: string | null) => Promise<void>;
}) {
  const t = useT();
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState("");
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
  async function viewOnCanvas() {
    if (!asset || locating) return;
    setLocating(true);
    setError("");
    try {
      await onViewOnCanvas(asset, result.itemId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("assistant.result.locateFailed"));
    } finally {
      setLocating(false);
    }
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
        <button type="button" disabled={locating} aria-busy={locating}
          onClick={() => void viewOnCanvas()}>
          <CanvasIcon name="canvas" size={14} />{t("assistant.result.viewOnCanvas")}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
