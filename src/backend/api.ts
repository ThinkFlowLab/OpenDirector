/** Requests to the local OpenDirector API started by scripts/opendirector.py. */
import { detectLocale } from "../i18n/locale.ts";
import type { Locale } from "../i18n/types.ts";
import { tNow } from "../i18n/messages.ts";

const SESSION_KEY = "opendirector.session.v1";

function tabStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

const previousSession = tabStorage()?.getItem(SESSION_KEY) ?? null;
export const reloadedTab = previousSession !== null;
export let sessionId = previousSession ?? crypto.randomUUID();

async function claimSession(id: string): Promise<boolean> {
  if (!globalThis.navigator?.locks) return true;
  return new Promise((resolve, reject) => {
    void navigator.locks.request(`opendirector.session.${id}`, { ifAvailable: true }, async (lock) => {
      resolve(Boolean(lock));
      if (lock) await new Promise<void>(() => {});
    }).catch(reject);
  });
}

function installSession(id: string) {
  sessionId = id;
  headers["X-OpenDirector-Session"] = id;
  try {
    tabStorage()?.setItem(SESSION_KEY, id);
  } catch {
    // Storage can be disabled in the browser.
  }
  globalThis.window?.opendirectorDesktop?.registerSession(id);
}

export async function rotateSession() {
  const id = crypto.randomUUID();
  await claimSession(id);
  installSession(id);
}

const sessionReady = (async () => {
  if (await claimSession(sessionId).catch(() => true)) installSession(sessionId);
  else await rotateSession();
})();

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

type LeaseRecovery = (projectId: string) => Promise<boolean>;
let leaseRecovery: LeaseRecovery | undefined;

/** Installed by the project session owner: renew this page's lease on `projectId`.
 *
 * A lease lapses when renewals stop for a minute (a suspended page, a renewal
 * stuck on a dropped connection). The server rejects the write with
 * `session_expired` before applying anything, so one renewal and one resend of
 * the same request is safe; commands are also deduplicated by commandId. */
export function setLeaseRecovery(recover: LeaseRecovery | undefined) {
  leaseRecovery = recover;
}

const PROJECT_PATH = /^\/creation\/projects\/([^/?]+)\//;

export async function sessionFetch(
  path: string,
  options: RequestInit = {},
  leaseRenewed = false,
): Promise<Response> {
  await sessionReady;
  const requestedSession = sessionId;
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
  if (!response.ok) {
    const projectId = PROJECT_PATH.exec(path)?.[1];
    if (
      response.status === 409 &&
      !leaseRenewed &&
      requestedSession === sessionId &&
      projectId &&
      leaseRecovery &&
      !options.signal?.aborted
    ) {
      const error = await responseError(response.clone());
      if (
        error.code === "session_expired" &&
        (await leaseRecovery(projectId).catch(() => false)) &&
        requestedSession === sessionId
      ) {
        return sessionFetch(path, options, true);
      }
    }
  }
  return response;
}

export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await sessionFetch(path, options);
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
