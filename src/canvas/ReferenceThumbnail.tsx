import type { CanvasNode } from "./model";
import { CanvasIcon } from "./CanvasIcon";
import { assetDisplayName } from "./assetNames";
import { useT } from "../i18n/I18nProvider.tsx";
import { AssetMedia } from "./useAssetMedia.tsx";

/** Inserting a mention and removing its relation are separate sibling buttons. */
export function ReferenceThumbnail({
  node,
  title,
  disabled,
  removalDisabled,
  onInsert,
  onRemove,
}: {
  node: CanvasNode;
  title?: string;
  disabled: boolean;
  removalDisabled: boolean;
  onInsert: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const name = assetDisplayName(node.data.title);
  return (
    <div className="cw-reference-thumbnail">
      <button
        type="button"
        className="cw-reference-chip"
        aria-label={t("canvasNodes.reference.aria", { name })}
        title={title ?? name}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onInsert}
      >
        {node.type === "image" &&
        node.data.src &&
        node.data.assetState !== "missing" ? (
          <AssetMedia as="img" src={node.data.src} alt="" draggable={false} />
        ) : (
          <CanvasIcon name={node.type} size={22} />
        )}
        <span>{name}</span>
      </button>
      <button
        type="button"
        className="cw-reference-remove"
        aria-label={t("canvasNodes.reference.remove", { name })}
        title={t("canvasNodes.reference.remove", { name })}
        disabled={removalDisabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onRemove}
      >
        <CanvasIcon name="close" size={11} />
      </button>
    </div>
  );
}
