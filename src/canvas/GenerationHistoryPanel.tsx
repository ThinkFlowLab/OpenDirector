import { useState } from "react";
import { generationTaskActions, type GenerationJob } from "./generationHistory";
import { CanvasIcon } from "./CanvasIcon";
import { useI18n } from "../i18n/I18nProvider.tsx";

export function GenerationHistoryPanel({
  jobs,
  onRestore,
  onLocate,
  onSync,
  onTaskAction,
  onRestoreConfiguration,
  authoritative = false,
}: {
  jobs: GenerationJob[];
  onRestore: (jobs: GenerationJob[], request?: boolean) => void;
  onLocate: (id: string) => void;
  onSync?: () => void;
  onTaskAction?: (
    job: GenerationJob,
    action: "recover" | "cancel",
  ) => Promise<void>;
  onRestoreConfiguration?: (
    job: GenerationJob,
    policy: "follow_current" | "pinned",
  ) => Promise<void>;
  authoritative?: boolean;
}) {
  const { t, locale } = useI18n();
  const durationFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 3 });
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const taskAction = async (
    job: GenerationJob,
    action: "recover" | "cancel",
  ) => {
    setPending((ids) => [...ids, job.id]);
    try {
      await onTaskAction?.(job, action);
    } finally {
      setPending((ids) => ids.filter((id) => id !== job.id));
    }
  };
  const restoreConfiguration = async (
    job: GenerationJob,
    policy: "follow_current" | "pinned",
  ) => {
    setPending((ids) => [...ids, job.id]);
    try {
      await onRestoreConfiguration?.(job, policy);
    } finally {
      setPending((ids) => ids.filter((id) => id !== job.id));
    }
  };
  const rows = jobs.filter(
    (job) =>
      filter === "all" ||
      job.outputKind === filter ||
      job.request?.kind === filter ||
      job.outputs?.some((item) => item.kind === filter),
  );
  const labels = {
    draft: t("generation.history.draft"),
    imported: t("generation.history.imported"),
    running: t("generation.history.running"),
    succeeded: t("generation.history.succeeded"),
    failed: t("generation.history.failed"),
    cancelled: t("generation.history.cancelled"),
    interrupted: t("generation.history.interrupted"),
  };
  const taskActions = (job: GenerationJob) =>
    authoritative && !job.tool
      ? {
          recover:
            !!job.taskId &&
            ["interrupted", "failed", "cancelled"].includes(job.status) &&
            job.serviceTask?.resumeAllowed === true &&
            [
              "remote",
              "download",
              "local",
              ...(job.serviceTask.cancelRequested ? [] : ["submit"]),
            ].includes(job.serviceTask.recovery ?? "") &&
            job.serviceTask.remoteCancellation !== "confirmed",
          cancel:
            !!job.taskId &&
            (job.status === "running" ||
              (!!job.serviceTask?.externalTaskId &&
                job.serviceTask.recovery === "remote" &&
                job.serviceTask.remoteCancellation !== "confirmed")),
        }
      : generationTaskActions(job);
  return (
    <>
      <p className="cw-panel-note">
        {t("generation.history.note")}
      </p>
      {onSync && (
        <button className="cw-wide-button" onClick={onSync}>
          {t("generation.history.sync")}
        </button>
      )}
      <div className="cw-search-categories" role="group" aria-label={t("generation.history.type")}>
        {[
          ["all", t("generation.history.all")],
          ["image", t("generation.history.image")],
          ["video", t("generation.history.video")],
          ["audio", t("generation.history.audio")],
        ].map(([value, title]) => (
          <button
            key={value}
            aria-pressed={filter === value}
            onClick={() => setFilter(value!)}
          >
            {title}
          </button>
        ))}
      </div>
      {!!selected.length && (
        <button
          className="cw-wide-button"
          onClick={() =>
            onRestore(jobs.filter((job) => selected.includes(job.id)))
          }
        >
          {authoritative ? t("generation.history.useSelected") : t("generation.history.placeSelected")}{" "}
          ({selected.length})
        </button>
      )}
      {!rows.length && <p className="cw-panel-note">{t("generation.history.empty")}</p>}
      {rows.map((job) => (
        <div className="cw-history-entry" key={job.id}>
          <label>
            <input
              type="checkbox"
              aria-label={t("generation.history.selectJob", {
                title: job.title,
              })}
              checked={selected.includes(job.id)}
              disabled={!job.outputs?.length}
              onChange={(e) =>
                setSelected((ids) =>
                  e.target.checked
                    ? [...ids, job.id]
                    : ids.filter((id) => id !== job.id),
                )
              }
            />
            <strong>{job.title}</strong>
          </label>
          <small>
            {job.createdAt
              ? new Date(job.createdAt).toLocaleString(locale)
              : job.time}{" "}
            ·{" "}
            {job.toolTask?.localState === "stopping"
              ? t("generation.history.stopping")
              : job.tool && job.status === "cancelled"
                ? t("generation.history.localStopped")
                : job.tool && job.status === "interrupted"
                  ? t("generation.history.toolInterrupted")
                  : labels[job.status]}
          </small>
          {job.message && <small>{job.message}</small>}
          {job.videoDuration?.requestedSeconds !== undefined && (
            <small>{t("generation.history.requestedDuration", {
              seconds: durationFormat.format(job.videoDuration.requestedSeconds),
            })}</small>
          )}
          {job.videoDuration?.resultSeconds !== undefined && (
            <small>{t("generation.history.resultDuration", {
              seconds: durationFormat.format(job.videoDuration.resultSeconds),
            })}</small>
          )}
          {job.preview?.state === "pending" && <small>{t("generation.history.readingPreview")}</small>}
          <div className="cw-history-thumbnails">
            {job.outputs?.map((output, i) =>
              output.kind === "image" ? (
                <img
                  key={i}
                  src={output.src}
                  alt={output.title}
                  draggable={false}
                />
              ) : (
                <span key={i}>
                  <CanvasIcon name={output.kind} size={20} />
                  {output.title}
                </span>
              ),
            )}
          </div>
          <div className="cw-history-actions">
            {onTaskAction && taskActions(job).recover && (
              <button
                disabled={pending.includes(job.id)}
                onClick={() => void taskAction(job, "recover")}
              >
                {t("generation.history.query")}
              </button>
            )}
            {onTaskAction && taskActions(job).cancel && (
              <button
                disabled={pending.includes(job.id)}
                onClick={() => void taskAction(job, "cancel")}
              >
                {job.tool
                  ? t("generation.history.cancelTool")
                  : t("generation.history.cancelCloud")}
              </button>
            )}
            <button onClick={() => onLocate(job.nodeId)}>{t("generation.history.locate")}</button>
            {!!job.outputs?.length && (
              <button onClick={() => onRestore([job])}>
                {authoritative && !job.tool ? t("generation.history.use") : t("generation.history.place")}
              </button>
            )}
            {job.request && (
              <button onClick={() => onRestore([job], true)}>
                {t("generation.history.restoreNode")}
              </button>
            )}
            {onRestoreConfiguration && !job.tool && (
              <>
                <button
                  disabled={pending.includes(job.id)}
                  onClick={() =>
                    void restoreConfiguration(job, "follow_current")
                  }
                >
                  {t("generation.history.restoreConfig")}
                </button>
                <button
                  disabled={pending.includes(job.id)}
                  onClick={() => void restoreConfiguration(job, "pinned")}
                >
                  {t("generation.history.restoreFromAssets")}
                </button>
              </>
            )}
          </div>
        </div>
      ))}
    </>
  );
}
