import { useEffect, useRef } from "react";
import { useI18n, useT } from "../../../i18n/I18nProvider.tsx";
import type { ExampleEntry } from "./exampleCatalog.ts";
import { useExampleImport } from "./useExampleImport.ts";
import { exampleFailureText, examplePercent } from "./exampleFailure.ts";
import "./example-canvas.css";

function megabytes(bytes: number | undefined): string | null {
  if (!bytes) return null;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Picks an example canvas, downloads it and hands the archive to the caller's
 * import path. Every row owns its own status, so one failure cannot block the
 * others.
 */
export function ExampleCanvasDialog({
  entries,
  onClose,
  onImport,
}: {
  entries: ExampleEntry[];
  onClose: () => void;
  onImport: (archive: Blob) => Promise<void>;
}) {
  const t = useT();
  const { locale } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const { statuses, start, cancel, reset, isRunning } = useExampleImport({ importCanvas: onImport });

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  const busy = entries.some((entry) => isRunning(entry.id));

  return (
    <dialog
      ref={dialog}
      className="cw-example-dialog"
      aria-labelledby="cw-example-title"
      onCancel={(event) => {
        // Escape must not orphan a running download.
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <header>
        <h2 id="cw-example-title">{t("canvas.example.dialog.title")}</h2>
        <p>{t("canvas.example.dialog.hint")}</p>
      </header>
      {entries.length === 0 ? (
        <p role="status">{t("canvas.example.dialog.empty")}</p>
      ) : (
        <ul className="cw-example-list">
          {entries.map((entry) => {
            const status = statuses[entry.id] ?? { phase: "idle" as const };
            const running = isRunning(entry.id);
            const size = megabytes(entry.bytes);
            const percent = examplePercent(status);
            return (
              <li key={entry.id} className="cw-example-item" data-example-id={entry.id}>
                <div className="cw-example-item-heading">
                  <strong>{entry.title[locale]}</strong>
                  {size && <small>{size}</small>}
                </div>
                {entry.summary && <p className="cw-example-summary">{entry.summary[locale]}</p>}
                <div className="cw-example-actions">
                  {running ? (
                    <>
                      {status.phase === "downloading" && (
                        <progress
                          className="cw-example-progress"
                          aria-label={t("canvas.example.progress.label")}
                          {...(percent === null
                            ? {}
                            : { value: status.received ?? 0, max: status.total ?? 1 })}
                        />
                      )}
                      <span role="status" aria-live="polite">
                        {status.phase === "importing"
                          ? t("canvas.example.state.importing")
                          : percent === null
                            ? t("canvas.example.state.downloading")
                            : t("canvas.example.state.downloadingPercent", { percent })}
                      </span>
                      <button type="button" onClick={() => cancel(entry.id)}>
                        {t("canvas.example.action.cancelDownload")}
                      </button>
                    </>
                  ) : status.phase === "done" ? (
                    <>
                      <span role="status" aria-live="polite">
                        {t("canvas.example.state.done", { title: status.title ?? entry.title[locale] })}
                      </span>
                      <button type="button" onClick={onClose}>
                        {t("canvas.example.action.close")}
                      </button>
                    </>
                  ) : (
                    <button type="button" onClick={() => void start(entry)}>
                      {status.phase === "failed"
                        ? t("canvas.example.action.retry")
                        : t("canvas.example.action.import")}
                    </button>
                  )}
                  {status.phase === "failed" && (
                    <button type="button" onClick={() => reset(entry.id)}>
                      {t("canvas.example.action.dismiss")}
                    </button>
                  )}
                </div>
                {status.phase === "failed" && (
                  <p className="cw-example-error" role="alert">
                    {exampleFailureText(t, status)}
                  </p>
                )}
                {entry.manual?.shareUrl && (
                  <details className="cw-example-manual">
                    <summary>{t("canvas.example.action.manual")}</summary>
                    <p>{t("canvas.example.manual.steps")}</p>
                    <a href={entry.manual.shareUrl} target="_blank" rel="noreferrer noopener">
                      {t("canvas.example.manual.share", { code: entry.manual.code ?? "-" })}
                    </a>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="cw-example-dialog-actions">
        <button type="button" disabled={busy} onClick={onClose}>
          {t("canvas.example.action.close")}
        </button>
      </div>
    </dialog>
  );
}
