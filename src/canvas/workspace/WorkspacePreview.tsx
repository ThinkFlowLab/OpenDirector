import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { errorMessage } from "../../backend/api.ts";
import { creationClient } from "../../backend/creationClient.ts";
import type { Asset } from "../../contracts/generated.ts";
import { useT } from "../../i18n/I18nProvider.tsx";
import { downloadFile, downloadFilename } from "../assets.ts";
import type { CanvasNode } from "../model.ts";
import { IconButton } from "./workspaceChrome.tsx";

export function WorkspacePreview({ preview, onClose, onDownloadNode }: {
  preview: CanvasNode | Asset;
  onClose: () => void;
  onDownloadNode: (node: CanvasNode) => void;
}) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const isNode = "data" in preview;
  const asset = isNode ? null : preview;
  const title = isNode ? preview.data.title : preview.name;
  const kind = isNode ? preview.type : preview.kind;
  const [content, setContent] = useState<string>();
  const [error, setError] = useState("");
  const [downloadError, setDownloadError] = useState("");
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  useEffect(() => {
    if (!asset || asset.kind === "file") return;
    let active = true;
    const client = creationClient(asset.projectId);
    const read = asset.kind === "text" ? client.textContent(asset.id) : client.mediaUrl(asset.id);
    void read.then(value => { if (active) setContent(value); })
      .catch(reason => { if (active) setError(errorMessage(reason)); });
    return () => { active = false; };
  }, [asset]);
  const download = async () => {
    if (isNode) return onDownloadNode(preview);
    setDownloadError("");
    try {
      const blob = await creationClient(preview.projectId).blob(preview.id);
      downloadFile(blob, downloadFilename(preview.name, preview.metadata.mimeType));
    } catch (reason) {
      setDownloadError(errorMessage(reason));
    }
  };
  const src = isNode ? preview.data.src : content;
  const text = isNode ? preview.data.text : content;
  const unavailable = () => setError(t("errors.preview.unavailable"));
  let body;
  if (error) body = <p role="alert">{error}</p>;
  else if (asset && kind !== "file" && content === undefined)
    body = <p role="status">{t("errors.preview.loading")}</p>;
  else if (kind === "image" && src) body = <img src={src} alt={title} onError={unavailable} />;
  else if (kind === "video" && src) body = <video src={src} controls onError={unavailable} />;
  else if (kind === "audio" && src) body = <audio src={src} controls onError={unavailable} />;
  else if (text) body = <pre>{text}</pre>;
  else body = <p>{src || kind === "file" ? t("canvas.workspace.preview.fileHint") : t("canvas.workspace.preview.emptyHint")}</p>;
  return (
    <dialog ref={dialog} className="cw-modal-backdrop cw-preview"
      aria-label={t("canvas.workspace.aria.previewDialog")}
      onCancel={onClose}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <header>
        <span>{title}</span>
        <IconButton name="download" label={t("canvas.workspace.aria.downloadPreview")} onClick={download} />
        <IconButton name="close" label={t("canvas.workspace.aria.closePreview")} onClick={onClose} />
      </header>
      <div>
        {body}
        {downloadError && <p role="alert">{downloadError}</p>}
      </div>
    </dialog>
  );
}
