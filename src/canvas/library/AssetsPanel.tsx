/** Assets: global media backed up from uploads and canvases. */
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../backend/api";
import { useT } from "../../i18n/I18nProvider";
import {
  ASSET_CATEGORIES,
  listItems,
  peekItems,
  sameLibraryItems,
  trashItems,
  uploadItem,
  type LibraryItem,
  type LibraryMediaKind,
} from "./libraryClient";
import { MediaCard } from "./MediaCard";

const ICONS: Record<string, "image" | "video" | "audio" | "file"> = {
  image: "image",
  video: "video",
  audio: "audio",
  file: "file",
};

export function AssetsPanel({
  query,
  selected,
  onToggle,
  onChanged,
  onNotice,
  onState,
  disabled = false,
  reloadKey,
}: {
  query: string;
  selected: Set<string>;
  onToggle: (item: LibraryItem) => void;
  onChanged: () => void;
  onNotice: (message: string) => void;
  /** Report the current page so the dialog can validate its single selection. */
  onState: (items: LibraryItem[], busy: boolean) => void;
  disabled?: boolean;
  reloadKey: number;
}) {
  const t = useT();
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [kind, setKind] = useState<LibraryMediaKind | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(
    () => onState(items, busy || Boolean(error)),
    [items, busy, error, onState],
  );
  useEffect(() => {
    let active = true;
    const filters = {
      kind: "asset" as const,
      state: "active" as const,
      query,
      mediaKind: kind || undefined,
    };
    // A reopened tab paints the rows already fetched instead of an empty grid.
    const seed = peekItems(filters);
    if (seed) {
      setItems(seed);
      setBusy(false);
    } else setBusy(true);
    setError("");
    listItems(filters)
      .then((rows) => {
        if (active)
          setItems((previous) =>
            sameLibraryItems(previous, rows) ? previous : rows,
          );
      })
      .catch((reason) => {
        if (active) setError(errorMessage(reason));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [query, kind, reloadKey]);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setError("");
    setBusy(true);
    try {
      for (const file of Array.from(files)) await uploadItem(file);
      onNotice(t("library.assets.uploaded", { count: files.length }));
      onChanged();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  const remove = async () => {
    const ids = items
      .filter((item) => selected.has(item.id))
      .map((item) => item.id);
    if (!ids.length) return;
    setBusy(true);
    try {
      await trashItems(ids);
      onNotice(t("library.assets.trashed", { count: ids.length }));
      onChanged();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cw-lib-panel">
      <div className="cw-lib-tabs">
        <button
          type="button"
          className={kind === "" ? "cw-lib-tab cw-lib-tab-on" : "cw-lib-tab"}
          disabled={disabled}
          onClick={() => {
            onChanged();
            setKind("");
          }}
        >
          {t("library.all")}
        </button>
        {ASSET_CATEGORIES.map((category) => (
          <button
            key={category.key}
            type="button"
            className={
              kind === category.key ? "cw-lib-tab cw-lib-tab-on" : "cw-lib-tab"
            }
            disabled={disabled}
            onClick={() => {
              onChanged();
              setKind(category.key);
            }}
          >
            {t(category.labelKey)}
          </button>
        ))}
        <div className="cw-lib-tab-actions">
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(event) => void upload(event.target.files)}
          />
          <button
            type="button"
            onClick={() => input.current?.click()}
            disabled={disabled || busy}
          >
            {t("library.assets.upload")}
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            disabled={
              disabled || busy || !items.some((item) => selected.has(item.id))
            }
          >
            {t("library.moveToTrash")}
          </button>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      {busy && !items.length && (
        <p role="status">{t("library.assets.loading")}</p>
      )}
      {!busy && !items.length && (
        <p className="cw-lib-empty">{t("library.assets.empty")}</p>
      )}
      <div className="cw-lib-grid">
        {items.map((item) => (
          <MediaCard
            key={item.id}
            title={item.name}
            icon={ICONS[item.mediaKind ?? "file"]}
            item={
              item.mediaKind === "image" ||
              item.mediaKind === "video" ||
              item.mediaKind === "audio"
                ? item
                : undefined
            }
            selected={selected.has(item.id)}
            disabled={disabled || busy}
            onSelect={() => onToggle(item)}
          />
        ))}
      </div>
    </div>
  );
}
