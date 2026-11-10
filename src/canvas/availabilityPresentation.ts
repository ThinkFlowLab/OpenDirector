import {
  availabilityProfile,
  availabilityReason,
  currentAvailability,
  type ModelAvailability,
  type OperationAvailability,
} from "../backend/availability.ts";
import { hasMessage, tNow } from "../i18n/messages.ts";

const SHARED_REASONS = new Set([
  "not_checked",
  "execution_paused",
  "observation_expired",
  "query_timeout",
  "query_busy",
  "query_failed",
  "connection_failed",
  "authentication_failed",
  "protocol_unavailable",
  "invalid_response",
  "unsupported_version",
  "model_not_declared",
]);

/** This only groups server decisions for display; it never decides support. */
export function availabilityNotice(
  value: ModelAvailability | null,
): string | null {
  if (!value) return "not_checked";
  if (SHARED_REASONS.has(value.reasonCode)) return value.reasonCode;
  const reasons = new Set(value.operations.map((item) => item.reasonCode));
  const reason = value.operations[0]?.reasonCode;
  return reasons.size === 1 &&
    reason &&
    value.operations.every((item) => item.status !== "available")
    ? reason
    : null;
}

export function availabilityRow(
  item: OperationAvailability,
  notice: string | null,
) {
  const displayed =
    notice === "execution_paused" &&
    item.reasonCode === "execution_paused" &&
    item.declaration
      ? item.declaration
      : item;
  const shared =
    displayed.reasonCode === notice ||
    (displayed.status === "unknown" &&
      notice !== null &&
      SHARED_REASONS.has(notice));
  return {
    status: displayed.status,
    muted: shared && displayed.status === "unknown",
    text: shared
      ? "—"
      : displayed.status === "available"
        ? tNow("availability.status.available")
        : availabilityReason(displayed.reasonCode),
  };
}

/** A selector describes the affected modes rather than the aggregate status. */
export function availabilitySummary(
  value?: ModelAvailability | null,
): string | undefined {
  if (!value) return undefined;
  const current = currentAvailability(value);
  const notice = availabilityNotice(current);
  if (notice) return availabilityReason(notice);
  const details = current.operations
    .filter((item) => item.status !== "available")
    .map(
      (item) =>
        `${availabilityProfile(item.profile)}: ${availabilityReason(item.reasonCode)}`,
    );
  return details.length ? details.join("; ") : undefined;
}

export function availabilityInputDetails(item: OperationAvailability) {
  return (item.inputDetails ?? []).flatMap((detail) => {
    const key = `availability.input.${detail.name}`;
    if (!hasMessage(key)) return [];
    const values: string[] = [];
    if (detail.support === "unsupported")
      values.push(tNow("availability.detail.unsupported"));
    else if (detail.support === "unknown")
      values.push(tNow("availability.status.unknown"));
    else {
      const countKind =
        detail.name === "image" || detail.name === "reference_image"
          ? "image"
          : "count";
      if (detail.minCount != null && detail.maxCount != null)
        values.push(
          tNow(`availability.detail.${countKind}Range`, {
            min: detail.minCount,
            max: detail.maxCount,
          }),
        );
      else if (detail.maxCount != null)
        values.push(
          tNow(
            countKind === "image"
              ? "availability.detail.maxImages"
              : "availability.detail.maxCount",
            { count: detail.maxCount },
          ),
        );
      else if (detail.minCount != null)
        values.push(
          tNow(
            countKind === "image"
              ? "availability.detail.minImages"
              : "availability.detail.minCount",
            { count: detail.minCount },
          ),
        );
      if (detail.min != null && detail.max != null)
        values.push(`${detail.min}–${detail.max}`);
      else if (detail.min != null)
        values.push(tNow("availability.detail.minimum", { value: detail.min }));
      else if (detail.max != null)
        values.push(tNow("availability.detail.maximum", { value: detail.max }));
      if (detail.multipleOf != null)
        values.push(
          tNow("availability.detail.multiple", { value: detail.multipleOf }),
        );
      if (detail.values?.length)
        values.push(
          detail.values
            .map((value) =>
              typeof value === "boolean"
                ? tNow(
                    value
                      ? "availability.detail.yes"
                      : "availability.detail.no",
                  )
                : String(value),
            )
            .join(", "),
        );
      if (!values.length) values.push(tNow("availability.status.available"));
    }
    return [
      {
        name: detail.name,
        label: tNow(key),
        text: values.join(" · "),
        source: tNow(
          detail.source === "service"
            ? "availability.detail.service"
            : "availability.detail.application",
        ),
      },
    ];
  });
}

/** Shared limits appear once; differing route requirements retain their mode label. */
export function availabilityCardDetails(
  items: readonly OperationAvailability[],
) {
  const details = new Map<
    string,
    ReturnType<typeof availabilityInputDetails>[number] & { profiles: string[] }
  >();
  for (const item of items)
    for (const detail of availabilityInputDetails(item)) {
      const key = JSON.stringify([detail.name, detail.text, detail.source]);
      const existing = details.get(key);
      if (existing) existing.profiles.push(availabilityProfile(item.profile));
      else
        details.set(key, {
          ...detail,
          profiles: [availabilityProfile(item.profile)],
        });
    }
  const values = [...details.values()];
  return values.map((detail) => ({
    ...detail,
    scope: values.some(
      (other) => other !== detail && other.name === detail.name,
    )
      ? [...new Set(detail.profiles)].join(" / ")
      : undefined,
  }));
}
