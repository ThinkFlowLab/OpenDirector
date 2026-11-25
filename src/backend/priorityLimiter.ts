type Job = { key?: string; priority: number; start: () => void };

/** Runs reads with a fixed concurrency. Lower priority numbers start first, and
 * jobs with equal priority keep their order. */
export class PriorityLimiter {
  private readonly queue: Job[] = [];
  private active = 0;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  run<T>(
    task: () => Promise<T>,
    {
      priority = 0,
      key,
      signal,
    }: { priority?: number; key?: string; signal?: AbortSignal } = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const cancel = () => {
        this.queue.splice(this.queue.indexOf(job), 1);
        reject(signal!.reason);
      };
      const job: Job = {
        key,
        priority,
        start: () => {
          signal?.removeEventListener("abort", cancel);
          this.active += 1;
          void Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              this.active -= 1;
              this.drain();
            });
        },
      };
      signal?.addEventListener("abort", cancel, { once: true });
      this.enqueue(job);
      this.drain();
    });
  }

  /** Moves a queued job forward when a more urgent consumer needs it. */
  prioritize(key: string, priority: number) {
    const index = this.queue.findIndex((job) => job.key === key);
    if (index < 0 || this.queue[index]!.priority <= priority) return;
    const [job] = this.queue.splice(index, 1);
    job!.priority = priority;
    this.enqueue(job!);
  }

  private enqueue(job: Job) {
    const index = this.queue.findIndex((item) => item.priority > job.priority);
    if (index < 0) this.queue.push(job);
    else this.queue.splice(index, 0, job);
  }

  private drain() {
    while (this.active < this.limit && this.queue.length)
      this.queue.shift()!.start();
  }
}
