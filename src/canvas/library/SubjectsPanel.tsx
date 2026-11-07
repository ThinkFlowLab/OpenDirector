/** Subjects: global subjects snapshotted from completed subject nodes. */
import { useEffect, useState } from "react";
import { errorMessage } from "../../backend/api";
import { useT } from "../../i18n/I18nProvider";
import { trashItems, sameLibraryItems, type LibraryItem } from "./libraryClient";
import { MediaCard } from "./MediaCard";
import {
  listLibrarySubjects,
  peekLibrarySubjects,
  type SubjectLibraryItem,
} from "../../backend/subjectLibrary";

export function SubjectsPanel({
  query,
  selected,
  onToggle,
  onChanged,
  onNotice,
  reloadKey,
  onState,
  disabled = false,
  onBackup,
  backupIssue,
}: {
  query: string;
  selected: Set<string>;
  onToggle: (item: LibraryItem) => void;
  onChanged: () => void;
  onNotice: (message: string) => void;
  reloadKey: number;
  onState: (items: SubjectLibraryItem[], busy: boolean) => void;
  disabled?: boolean;
  onBackup: () => void;
  backupIssue: string | null;
}) {
  const t = useT();
  const [items, setItems] = useState<SubjectLibraryItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(
    () => onState(items, busy || Boolean(error)),
    [items, busy, error, onState],
  );

  useEffect(() => {
    let active = true;
    // A reopened tab paints the rows already fetched instead of an empty grid.
    const seed = peekLibrarySubjects(query);
    if (seed) {
      setItems(seed);
      setBusy(false);
    } else setBusy(true);
    setError("");
    listLibrarySubjects(query)
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

  const remove = async () => {
    const ids = items
      .filter((item) => selected.has(item.id))
      .map((item) => item.id);
    if (!ids.length) return;
    setBusy(true);
    try {
      await trashItems(ids);
      onNotice(t("library.subjects.trashed", { count: ids.length }));
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
            disabled={disabled || Boolean(backupIssue)}
            title={backupIssue ?? t("library.subjects.addHint")}
            onClick={onBackup}
          >
            {t("library.subjects.add")}
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
        <p role="status">{t("library.subjects.loading")}</p>
      )}
      {!busy && !items.length && (
        <p className="cw-lib-empty">{t("library.subjects.empty")}</p>
      )}
      <div className="cw-lib-grid">
        {items.map((item) => (
          <MediaCard
            key={item.id}
            title={item.name}
            subtitle={item.issue ?? (item.subject?.category || undefined)}
            icon="subject"
            selected={selected.has(item.id)}
            disabled={disabled}
            onSelect={() => onToggle(item)}
          />
        ))}
      </div>
    </div>
  );
}
