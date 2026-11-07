/** Trash: restore or permanently purge. Never touches canvas data (L4). */
import { useEffect, useState } from "react";
import { errorMessage } from "../../backend/api";
import { formatDateTime } from "../../i18n/format";
import { useI18n } from "../../i18n/I18nProvider";
import {
  listItems,
  peekItems,
  purgeAll,
  purgeOne,
  restoreItems,
  sameLibraryItems,
  type LibraryItem,
} from "./libraryClient";
import { MediaCard } from "./MediaCard";

export function TrashPanel({
  query,
  selected,
  onToggle,
  onChanged,
  onNotice,
  reloadKey,
}: {
  query: string;
  selected: Set<string>;
  onToggle: (item: LibraryItem) => void;
  onChanged: () => void;
  onNotice: (message: string) => void;
  reloadKey: number;
}) {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let active = true;
    // A reopened tab paints the rows already fetched instead of an empty grid.
    const seed = peekItems({ state: "trashed", query });
    if (seed) {
      setItems(seed);
      setBusy(false);
    } else setBusy(true);
    listItems({ state: "trashed", query })
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
  }, [query, reloadKey]);

  const restore = async () => {
    const ids = items.filter((item) => selected.has(item.id)).map((item) => item.id);
    if (!ids.length) return;
    setBusy(true);
    try {
      await restoreItems(ids);
      onNotice(t("library.trash.restored", { count: ids.length }));
      onChanged();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const purgeSelected = async () => {
    const ids = items.filter((item) => selected.has(item.id)).map((item) => item.id);
    if (!ids.length) return;
    setBusy(true);
    try {
      for (const id of ids) await purgeOne(id);
      onNotice(t("library.trash.purged", { count: ids.length }));
      onChanged();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const empty = async () => {
    setBusy(true);
    try {
      const result = await purgeAll();
      onNotice(
        t("library.trash.emptied", {
          count: result.blobsRemoved.length,
        }),
      );
      setConfirming(false);
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
        <button type="button" className="cw-lib-tab cw-lib-tab-on">
          {t("library.all")}
        </button>
        <div className="cw-lib-tab-actions">
          <button
            type="button"
            onClick={() => void restore()}
            disabled={busy || !items.some((item) => selected.has(item.id))}
          >
            {t("library.trash.restore")}
          </button>
          <button
            type="button"
            onClick={() => void purgeSelected()}
            disabled={busy || !items.some((item) => selected.has(item.id))}
          >
            {t("library.trash.purge")}
          </button>
          <button
            type="button"
            className="cw-lib-danger"
            onClick={() => setConfirming(true)}
            disabled={busy || !items.length}
          >
            {t("library.trash.empty")}
          </button>
        </div>
      </div>
      {confirming && (
        <div
          className="cw-lib-confirm"
          role="alertdialog"
          aria-label={t("library.trash.confirmLabel")}
        >
          <p>{t("library.trash.confirmBody")}</p>
          <div>
            <button type="button" onClick={() => setConfirming(false)}>
              {t("library.trash.cancel")}
            </button>
            <button
              type="button"
              className="cw-lib-danger"
              onClick={() => void empty()}
            >
              {t("library.trash.confirm")}
            </button>
          </div>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {busy && !items.length && (
        <p role="status">{t("library.trash.loading")}</p>
      )}
      {!busy && !items.length && (
        <p className="cw-lib-empty">{t("library.trash.emptyState")}</p>
      )}
      <div className="cw-lib-grid">
        {items.map((item) => (
          <MediaCard
            key={item.id}
            title={item.name}
            subtitle={
              item.trashedAt
                ? formatDateTime(locale, new Date(item.trashedAt), {
                    dateStyle: "short",
                    timeStyle: "medium",
                  })
                : undefined
            }
            icon={item.kind === "subject" ? "subject" : item.mediaKind ?? "file"}
            item={
              item.kind === "asset" &&
              (item.mediaKind === "image" ||
                item.mediaKind === "video" ||
                item.mediaKind === "audio")
                ? item
                : undefined
            }
            selected={selected.has(item.id)}
            onSelect={() => onToggle(item)}
          />
        ))}
      </div>
    </div>
  );
}