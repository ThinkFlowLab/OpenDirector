import type {
  ModelAvailability,
  OperationAvailability,
} from "../contracts/generated.ts";
import type { ModelConfig } from "./rules.ts";
import { hasMessage, tNow } from "../i18n/messages.ts";

export type { ModelAvailability, OperationAvailability };

/** A transport failure clears decisions while retaining the saved connection identity for retry. */
export function failedAvailability(
  value: ModelAvailability,
): ModelAvailability {
  return {
    ...value,
    status: "unknown",
    reasonCode: "query_failed",
    checkedAt: null,
    expiresAt: null,
    operations: value.operations.map((item) => ({
      ...item,
      status: "unknown",
      reasonCode: "query_failed",
      checkedAt: null,
      expiresAt: null,
    })),
  };
}

export interface AvailabilityClock {
  wallNow(): number;
  monotonicNow(): number;
}

const clock: AvailabilityClock = {
  wallNow: () => Date.now(),
  monotonicNow: () => performance.now(),
};
const deadlines = new WeakMap<
  OperationAvailability,
  { clock: AvailabilityClock; at: number }
>();
const observations = new WeakMap<AvailabilityClock, Map<string, number>>();

function deadline(
  value: OperationAvailability,
  timing: AvailabilityClock,
): number | null {
  if (value.expiresAt === null) return null;
  const existing = deadlines.get(value);
  if (existing?.clock === timing) return existing.at;
  const maximum =
    value.checkedAt === null
      ? 30_000
      : Math.max(0, value.expiresAt - value.checkedAt);
  const at =
    timing.monotonicNow() +
    Math.max(0, Math.min(maximum, value.expiresAt - timing.wallNow()));
  deadlines.set(value, { clock: timing, at });
  return at;
}

/** Call when a response arrives. Re-reading the same observation cannot renew its lifetime. */
export function receiveAvailability(
  value: ModelAvailability,
  timing: AvailabilityClock = clock,
): ModelAvailability {
  let known = observations.get(timing);
  if (!known) {
    known = new Map();
    observations.set(timing, known);
  }
  for (const operation of value.operations) {
    if (operation.expiresAt === null) continue;
    const key = JSON.stringify([
      value.identity,
      operation.operation,
      operation.profile,
      operation.method,
      operation.path,
      operation.output,
      operation.status,
      operation.reasonCode,
      operation.checkedAt,
      operation.expiresAt,
    ]);
    const previous = known.get(key);
    const at = previous ?? deadline(operation, timing)!;
    deadlines.set(operation, { clock: timing, at });
    known.delete(key);
    known.set(key, at);
    if (known.size > 1024) known.delete(known.keys().next().value!);
  }
  return value;
}

/** Remaining elapsed time, independent of later wall-clock changes. */
export function availabilityDelay(
  value: ModelAvailability,
  timing: AvailabilityClock = clock,
): number | null {
  receiveAvailability(value, timing);
  const now = timing.monotonicNow();
  const remaining = value.operations
    .map((item) => deadline(item, timing))
    .filter((at): at is number => at !== null && at > now)
    .map((at) => at - now);
  return remaining.length ? Math.min(...remaining) : null;
}

/** The server owns decisions. The browser only expires and presents observations. */
export function currentOperation(
  value: OperationAvailability,
  timing: AvailabilityClock = clock,
): OperationAvailability {
  const at = deadline(value, timing);
  return at !== null && at <= timing.monotonicNow()
    ? {
        ...value,
        status: "unknown",
        reasonCode: "observation_expired",
        expiresAt: null,
      }
    : value;
}

export function currentAvailability(
  value: ModelAvailability,
  timing: AvailabilityClock = clock,
): ModelAvailability {
  receiveAvailability(value, timing);
  const operations = value.operations.map((item) =>
    currentOperation(item, timing),
  );
  if (operations.every((item, index) => item === value.operations[index]))
    return value;
  const states = new Set(operations.map((item) => item.status));
  return {
    ...value,
    operations,
    status: states.size === 1 ? operations[0].status : "unknown",
    reasonCode: "observation_expired",
  };
}

export function availabilityReason(code: string): string {
  const key = `availability.reason.${code}`;
  return hasMessage(key)
    ? tNow(key)
    : tNow("availability.reason.declaration_incomplete");
}

export function availabilityProfile(profile: string): string {
  const key = `availability.profile.${profile}`;
  return hasMessage(key) ? tNow(key) : tNow("availability.profile.other");
}

export function availabilityBlocker(
  model: ModelConfig | undefined,
  profile: string,
  timing: AvailabilityClock = clock,
): string | null {
  if (model?.availability) receiveAvailability(model.availability, timing);
  const item = model?.availability?.operations.find(
    (value) => value.profile === profile,
  );
  if (!item) return null;
  const current = currentOperation(item, timing);
  return current.status === "unavailable"
    ? availabilityReason(current.reasonCode)
    : null;
}

/** Local identity excludes credentials; saves additionally invalidate pending reads. */
export function availabilityModelKey(model: ModelConfig): string {
  return JSON.stringify([
    model.id,
    model.providerId,
    model.kind,
    model.url,
    model.modelId,
    model.protocol,
    model.connectionType,
    model.authMode,
    model.proxyMode,
    model.videoAdapter,
    model.inputModalities,
    model.videoCapabilities,
    model.capabilityAutoCheck,
  ]);
}

/** Saved observations require the opaque identity captured before the request. */
export function availabilityMatchesModel(
  model: ModelConfig,
  observation: ModelAvailability,
  expectedIdentity: string | undefined = model.availability?.identity,
): boolean {
  return (
    expectedIdentity !== undefined &&
    observation.configId === model.id &&
    observation.modelId === model.modelId &&
    observation.identity === expectedIdentity
  );
}

export function nextAvailabilityDelay(
  models: readonly ModelConfig[],
  timing: AvailabilityClock = clock,
): number | null {
  const remaining = models
    .map((model) =>
      model.availability ? availabilityDelay(model.availability, timing) : null,
    )
    .filter((value): value is number => value !== null);
  return remaining.length ? Math.min(...remaining) : null;
}

export function nextAvailabilityExpiry(
  models: readonly ModelConfig[],
  timing: AvailabilityClock = clock,
): number | null {
  const delay = nextAvailabilityDelay(models, timing);
  return delay === null ? null : timing.wallNow() + delay;
}
