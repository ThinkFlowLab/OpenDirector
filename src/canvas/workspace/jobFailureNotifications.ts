import type { GenerationJob } from "../generationHistory.ts";

type JobState = Pick<GenerationJob, "id" | "status" | "createdAt" | "revision">;

/** Submission and background observers share ownership of one task failure.
 * Observing a revision does not mean its failure was announced. Only claim()
 * owns the notification; a confirmed recovery permits a later failure version.
 */
export class JobFailureNotifications {
  private openedAt: number;
  private states = new Map<
    string,
    {
      observedStatus?: GenerationJob["status"];
      revision?: number;
      /** Set only when the observer actually claims this version's failure. */
      reportedRevision?: number;
      recoveredAfter?: number;
      reported: boolean;
    }
  >();

  constructor(openedAt = Date.now()) {
    this.openedAt = openedAt;
  }

  /** Claim before publishing failed state, which can immediately wake observers. */
  claim(id: string): boolean {
    const previous = this.states.get(id);
    if (previous?.reported) return false;
    // A callback can report before React observes the failed projection. Keep
    // the last observed status so an older running render is not a retry.
    this.states.set(id, { ...previous, reported: true });
    return true;
  }

  /** A confirmed recovery may finish again before a running snapshot arrives. */
  recovered(id: string, failedRevision: number) {
    const previous = this.states.get(id);
    if (
      previous?.reported &&
      (previous.reportedRevision ?? -1) > failedRevision &&
      (previous.observedStatus === "failed" ||
        previous.observedStatus === "interrupted")
    )
      return; // The observer already announced this recovery's failure.
    this.states.set(id, {
      ...previous,
      reported: false,
      recoveredAfter: failedRevision,
    });
  }

  observe(job: JobState): boolean {
    const previous = this.states.get(job.id);
    if (
      job.revision !== undefined &&
      previous?.revision !== undefined &&
      job.revision < previous.revision
    )
      return false;
    if (
      previous?.recoveredAfter !== undefined &&
      (job.revision === undefined || job.revision <= previous.recoveredAfter)
    )
      return false; // A replay of the failure preceding the accepted recovery.
    if (job.status === "running") {
      // A resumed execution may keep its task ID. Its next failure is new.
      const resumed =
        previous?.observedStatus === "failed" ||
        previous?.observedStatus === "interrupted";
      this.states.set(job.id, {
        ...previous,
        observedStatus: job.status,
        revision: job.revision,
        reported: resumed ? false : (previous?.reported ?? false),
      });
      return false;
    }
    if (job.status !== "failed" && job.status !== "interrupted") {
      this.states.set(job.id, {
        ...previous,
        observedStatus: job.status,
        revision: job.revision,
        reported: previous?.reported ?? false,
      });
      return false;
    }
    // Reopening a page must not announce a failure that was already history,
    // even when it happened only milliseconds before this page opened.
    if (
      previous?.observedStatus !== "running" &&
      previous?.recoveredAfter === undefined &&
      (job.createdAt ?? 0) < this.openedAt
    ) {
      this.states.set(job.id, {
        ...previous,
        observedStatus: job.status,
        revision: job.revision,
        reported: true,
      });
      return false;
    }
    const report = this.claim(job.id);
    this.states.set(job.id, {
      observedStatus: job.status,
      revision: job.revision,
      reportedRevision: report ? job.revision : previous?.reportedRevision,
      reported: true,
    });
    return report;
  }
}
