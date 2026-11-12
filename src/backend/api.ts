/** Requests to the local OpenDirector API started by scripts/opendirector.py. */
import { detectLocale } from "../i18n/locale.ts";
import type { Locale } from "../i18n/types.ts";
import { tNow } from "../i18n/messages.ts";
import { browserSessionIdentity } from "./sessionIdentity.ts";

const session = browserSessionIdentity();
let sessionHidden = false;
export function setSessionHidden(hidden: boolean) {
  sessionHidden = hidden;
}
export const sessionId = session.id;
export const SESSION_GENERATION = "X-OpenDirector-Session-Generation";

/** Include pending acquisitions when fencing work at page exit. */
export function sessionReleaseHeaders() {
  return { [SESSION_GENERATION]: String(session.issued) };
}

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
  [SESSION_GENERATION]: "0",
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
  const acquisition =
    options.method === "POST" &&
    /^\/creation\/projects\/[^/]+\/open(?:-canvas)?$/.test(path);
  if (acquisition && sessionHidden)
    throw new DOMException(
      tNow("errors.backend.selectionAborted"),
      "AbortError",
    );
  let generation: number | undefined;
  if (acquisition) {
    try {
      generation = session.issue();
    } catch {
      throw new ApiError(
        tNow("api.unknownError"),
        409,
        "session_generation_invalid",
      );
    }
  }
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: {
        ...headers,
        ...options.headers,
        ...(generation === undefined
          ? {}
          : { [SESSION_GENERATION]: String(generation) }),
      },
    });
  } catch (failure) {
    if (options.signal?.aborted) throw failure;
    throw new ApiError(tNow("api.networkError"), null, "network_error");
  }
  if (!response.ok) throw await responseError(response);
  if (generation !== undefined) {
    session.accept(generation);
    headers[SESSION_GENERATION] = String(session.accepted);
  }
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
