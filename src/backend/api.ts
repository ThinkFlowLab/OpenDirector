/** Requests to the local OpenDirector API started by scripts/opendirector.py. */
import { detectLocale } from "../i18n/locale.ts";
import type { Locale } from "../i18n/types.ts";
import { tNow } from "../i18n/messages.ts";

export const sessionId = crypto.randomUUID();

const SESSION_KEY = "opendirector.session.v1";
const lockName = (id: string) => `opendirector.session.${id}`;

interface SessionLocks {
  request(name: string, callback: () => Promise<void>): Promise<void>;
  query(): Promise<{ held?: { name?: string }[] }>;
}

/** Release this tab's previous page lease after a reload or crash.
 *
 * Each page load uses a new session. When the previous page could not send its
 * release (crash, killed process, lost keepalive), its lease would otherwise
 * block the reloaded tab as "another window" until it expires. The previous
 * session is released only when no live page still holds its Web Lock, so a
 * duplicated tab, which copies sessionStorage, never releases a live window.
 * Without Web Locks nothing is released and the lease simply expires. */
export async function releaseStaleSession(
  previous: string | null,
  current: string,
  locks: SessionLocks | undefined,
  release: (id: string) => Promise<unknown>,
  pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  if (!locks) return false;
  // Hold this page's lock for its lifetime; the browser drops it on unload.
  void locks.request(lockName(current), () => new Promise<void>(() => {})).catch(() => {});
  if (!previous || previous === current) return false;
  for (let attempt = 0; attempt < 8; attempt++) {
    // A reloading page may still be tearing down; look again briefly.
    if (attempt) await pause(250);
    const state = await locks.query().catch(() => null);
    if (!state) return false;
    if (!state.held?.some((lock) => lock.name === lockName(previous))) {
      await release(previous).catch(() => {});
      return true;
    }
  }
  return false;
}

function tabStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

const previousSession = tabStorage()?.getItem(SESSION_KEY) ?? null;
/** This page replaced an earlier page of the same tab (reload or reconnect). */
export const reloadedTab = previousSession !== null;
try {
  tabStorage()?.setItem(SESSION_KEY, sessionId);
} catch {
  // Private modes may refuse storage; the lease then just expires.
}

/** Requests wait until a stale lease from this tab's previous page is gone. */
const sessionReady = releaseStaleSession(
  previousSession,
  sessionId,
  (globalThis.navigator as { locks?: SessionLocks } | undefined)?.locks,
  (id) =>
    fetch(`/api/creation/sessions/${id}`, {
      method: "DELETE",
      headers: { "X-OpenDirector-Request": "1" },
    }),
).catch(() => false);

export class ApiError extends Error {
  status: number | null;
  code: string;
  constructor(message: string, status: number | null, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const headers: Record<string, string> = {
  "X-OpenDirector-Request": "1",
  "X-OpenDirector-Session": sessionId,
  "Accept-Language": detectLocale(),
};

/** Keep the request language aligned with the visible UI. */
export function setRequestLocale(locale: Locale) {
  headers["Accept-Language"] = locale;
}

export async function responseError(response: Response) {
  const error = await response.json().catch(() => null);
  return new ApiError(
    typeof error?.detail === "string"
      ? error.detail
      : tNow("api.requestFailed", { status: response.status }),
    response.status,
    error?.code ?? "operation_rejected",
  );
}

export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  await sessionReady;
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: { ...headers, ...options.headers },
    });
  } catch (failure) {
    if (options.signal?.aborted) throw failure;
    throw new ApiError(tNow("api.networkError"), null, "network_error");
  }
  if (!response.ok) throw await responseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function json(
  method: string,
  value: unknown,
  extra: Record<string, string> = {},
): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json", ...extra },
    body: JSON.stringify(value),
  };
}

/** For reads and idempotent writes only. Replay the exact request after an
 * explicit lock timeout; conflicts and unknown delivery outcomes still fail. */
export async function storageRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request<T>(path, options);
    } catch (error) {
      if (
        attempt >= 2 ||
        options.signal?.aborted ||
        !(error instanceof ApiError) ||
        error.status !== 409 ||
        error.code !== "storage_busy"
      )
        throw error;
    }
    await new Promise<void>((resolve, reject) => {
      const signal = options.signal;
      const cancel = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        reject(signal?.reason);
      };
      const timer = setTimeout(
        () => {
          signal?.removeEventListener("abort", cancel);
          resolve();
        },
        1000 * 2 ** attempt,
      );
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : tNow("api.unknownError");
}
