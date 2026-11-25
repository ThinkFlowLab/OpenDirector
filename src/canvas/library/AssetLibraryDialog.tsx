/** Global library: every import creates independent canvas nodes. */
import { useCallback, useEffect, useState } from "react";
import { CanvasIcon } from "../CanvasIcon";
import { AssetsPanel } from "./AssetsPanel";
import { SubjectsPanel } from "./SubjectsPanel";
import { CanvasesPanel } from "./CanvasesPanel";
import { TrashPanel } from "./TrashPanel";
import { errorMessage } from "../../backend/api";
import { useT } from "../../i18n/I18nProvider";
import type { MessageKey } from "../../i18n/messages";
import { toggleSelection } from "./libraryClient";
import type { LibraryItem } from "./libraryClient";
import type { SubjectLibraryItem } from "../../backend/subjectLibrary";
import type { CanvasSource } from "../../backend/canvasSources";
export type LibraryTab = "assets" | "subjects" | "canvases" | "trash";
const tabs: readonly { key: LibraryTab; labelKey: MessageKey }[] = [
  { key: "assets", labelKey: "library.tab.assets" },
  { key: "subjects", labelKey: "library.tab.subjects" },
  { key: "canvases", labelKey: "library.tab.canvases" },
  { key: "trash", labelKey: "library.tab.trash" },
];
export function AssetLibraryDialog({
  initialTab = "assets",
  currentId,
  liveCanvas,
  onClose,
  onInsert,
  onImportCanvas,
  subjectBusy = false,
  backupSubjectIssue,
  onImportSubjects,
  onBackupSubject,
}: {
  initialTab?: LibraryTab;
  currentId: string;
  /** Rows of the open canvas, so its tab never waits on the network. */
  liveCanvas?: { projectId: string; sources: CanvasSource[] };
  onClose: () => void;
  onInsert?: (items: LibraryItem[]) => Promise<void>;
  onImportCanvas?: (projectId: string, item: CanvasSource) => Promise<void>;
  subjectBusy?: boolean;
  backupSubjectIssue?: string | null;
  onImportSubjects?: (items: LibraryItem[]) => Promise<void>;
  onBackupSubject?: () => Promise<void>;
}) {
  const t = useT();
  const [tab, setTab] = useState<LibraryTab>(initialTab),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState<Set<string>>(new Set());
  const [items, setItems] = useState<LibraryItem[]>([]),
    [canvasItems, setCanvasItems] = useState<CanvasSource[]>([]),
    [canvasId, setCanvasId] = useState("");
  const [loading, setLoading] = useState(true),
    [working, setWorking] = useState(false),
    [notice, setNotice] = useState(""),
    [reload, setReload] = useState(0);
  const busy = working || subjectBusy;
  const reset = useCallback(() => setSelected(new Set()), []);
  useEffect(() => {
    reset();
    setNotice("");
    setItems([]);
    setCanvasItems([]);
    setLoading(true);
  }, [tab, query, reset]);
  const toggle = useCallback(
    (entry: { id: string }) =>
      setSelected((current) => toggleSelection(current, entry.id)),
    [],
  );
  const report = useCallback((rows: LibraryItem[], pending: boolean) => {
    setItems(rows);
    setLoading(pending);
  }, []);
  const reportCanvas = useCallback(
    (projectId: string, rows: CanvasSource[], pending: boolean) => {
      setCanvasId(projectId);
      setCanvasItems(rows);
      setLoading(pending);
    },
    [],
  );
  const changed = useCallback(() => {
    reset();
    setReload((value) => value + 1);
  }, [reset]);
  const notify = useCallback((message: string) => setNotice(message), []);
  const chosenItems = items.filter((item) => selected.has(item.id));
  const canvasChoices = canvasItems.filter((item) => selected.has(item.nodeId));
  const unavailableSubject = chosenItems.find(
    (item) => !(item as SubjectLibraryItem).available,
  );
  const issue = busy
    ? t("library.busy")
    : loading
      ? t("library.loading")
      : tab === "canvases"
        ? !canvasChoices.length
          ? t("library.issue.selectNode")
          : null
        : !chosenItems.length
          ? t("library.issue.selectItem")
          : tab === "subjects" && unavailableSubject
            ? (unavailableSubject as SubjectLibraryItem).issue ||
              t("library.issue.subjectUnavailable")
            : null;
  const run = async (action: () => Promise<void>, close = true) => {
    if (busy) return;
    setWorking(true);
    setNotice("");
    try {
      await action();
      if (close) onClose();
      else changed();
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setWorking(false);
    }
  };
  const insert = () => {
    if (issue) return;
    void run(async () => {
      if (tab === "subjects" && chosenItems.length && onImportSubjects)
        await onImportSubjects(chosenItems);
      else if (tab === "canvases" && canvasChoices.length && onImportCanvas) {
        // Every selected row becomes its own node, so import them one by one.
        for (const item of canvasChoices) await onImportCanvas(canvasId, item);
      } else if (chosenItems.length && onInsert) await onInsert(chosenItems);
      else throw new Error(t("library.importUnavailable"));
    });
  };
  return (
    <div
      className="cw-lib-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t("library.title")}
      onClick={(event) => {
        if (!busy && event.target === event.currentTarget) onClose();
      }}
    >
      <div className="cw-lib-dialog">
        <header className="cw-lib-header">
          <nav
            className="cw-lib-top"
            role="tablist"
            aria-label={t("library.sections")}
          >
            {tabs.map((entry) => (
              <button
                key={entry.key}
                type="button"
                role="tab"
                aria-selected={tab === entry.key}
                disabled={busy}
                className={tab === entry.key ? "cw-lib-top-on" : undefined}
                onClick={() => {
                  if (tab === entry.key) return;
                  reset();
                  setItems([]);
                  setCanvasItems([]);
                  setLoading(true);
                  setTab(entry.key);
                }}
              >
                {t(entry.labelKey)}
              </button>
            ))}
          </nav>
          <div className="cw-lib-search">
            <CanvasIcon name="search" size={16} />
            <input
              type="search"
              placeholder={t("library.search.placeholder")}
              aria-label={t("library.search.label")}
              value={query}
              disabled={busy}
              onChange={(event) => {
                reset();
                setItems([]);
                setCanvasItems([]);
                setLoading(true);
                setQuery(event.target.value);
              }}
            />
          </div>
          <button
            type="button"
            className="cw-lib-close"
            aria-label={t("library.close")}
            disabled={busy}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <div className="cw-lib-body">
          {tab === "assets" && (
            <AssetsPanel
              query={query}
              selected={selected}
              onToggle={toggle}
              onChanged={changed}
              onNotice={notify}
              onState={report}
              disabled={busy}
              reloadKey={reload}
            />
          )}
          {tab === "subjects" && (
            <SubjectsPanel
              query={query}
              selected={selected}
              onToggle={toggle}
              onChanged={changed}
              onNotice={notify}
              onState={report}
              disabled={busy}
              reloadKey={reload}
              onBackup={() => {
                if (onBackupSubject) void run(onBackupSubject, false);
              }}
              backupIssue={
                busy ? t("library.busy") : (backupSubjectIssue ?? null)
              }
            />
          )}
          {tab === "canvases" && (
            <CanvasesPanel
              currentId={currentId}
              live={liveCanvas}
              query={query}
              selected={selected}
              onToggle={(item) => toggle({ id: item.nodeId })}
              onNotice={notify}
              onCanvasChanged={reset}
              onState={reportCanvas}
              disabled={busy}
            />
          )}
          {tab === "trash" && (
            <TrashPanel
              query={query}
              selected={selected}
              onToggle={toggle}
              onChanged={changed}
              onNotice={notify}
              reloadKey={reload}
            />
          )}
        </div>
        <footer className="cw-lib-footer">
          <span role="status">
            {notice ||
              (busy
                ? t("library.processing")
                : t("library.selected", { count: selected.size }))}
          </span>
          <div>
            {tab === "trash" ? (
              <button type="button" onClick={onClose}>
                {t("library.action.close")}
              </button>
            ) : (
              <button
                type="button"
                disabled={Boolean(issue)}
                title={issue ?? t("library.insertHint")}
                onClick={insert}
              >
                {t("library.action.insert")}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
