import { useEffect, useState } from "react";
import {
  availabilityDelay,
  availabilityProfile,
  availabilityReason,
  currentAvailability,
  type ModelAvailability,
} from "../backend/availability.ts";
import { useI18n } from "../i18n/I18nProvider";
import {
  availabilityCardDetails,
  availabilityNotice,
  availabilityRow,
} from "./availabilityPresentation.ts";

/** Observations do not edit the model's saved input rules or voice selection. */
export function ModelAvailabilityCard({
  value,
  onRefresh,
  checking = false,
  title,
  error,
  compact = false,
}: {
  value?: ModelAvailability | null;
  onRefresh?: () => void;
  checking?: boolean;
  title?: string;
  error?: string;
  /** One line inside a model row: no card heading, chips instead of rows. */
  compact?: boolean;
}) {
  const { t, locale } = useI18n();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const delay = value ? availabilityDelay(value) : null;
    if (delay === null) return;
    const timer = setTimeout(
      () => setTick((previous) => previous + 1),
      Math.max(1, delay + 1),
    );
    return () => clearTimeout(timer);
  }, [value, tick]);
  const current = value ? currentAvailability(value) : null;
  const notice = availabilityNotice(current);
  const message = checking
    ? null
    : error || (notice ? availabilityReason(notice) : null);
  // A row keeps the action but not the "not checked yet" placeholder: the
  // button already says what it does, and the empty line only cost space.
  const showMessage = !(compact && !error && notice === "not_checked");
  const details = availabilityCardDetails(current?.operations ?? []);
  const commonSource =
    details.length > 0 &&
    details.every((detail) => detail.source === details[0].source)
      ? details[0].source
      : null;
  const messageNode = message && showMessage ? (
    <p role={error ? "alert" : "status"}>{message}</p>
  ) : null;
  return (
    <section
      className={`cw-model-availability${compact ? " is-compact" : ""}`}
      aria-label={title ?? t("availability.title")}
    >
      <div className="cw-model-availability-heading">
        <strong>{title ?? t("availability.title")}</strong>
        {compact && messageNode}
        {onRefresh && (
          <button
            type="button"
            className="cw-settings-button"
            disabled={checking}
            onClick={onRefresh}
          >
            {t(
              checking
                ? "availability.checking"
                : error || notice?.includes("failed")
                  ? "availability.retry"
                  : !current || notice === "not_checked"
                    ? "availability.check"
                    : "availability.refresh",
            )}
          </button>
        )}
      </div>
      {!compact && messageNode}
      {current?.operations.length ? (
        <ul>
          {current.operations.map((item) => {
            const row = availabilityRow(item, notice);
            return (
              <li
                key={`${item.operation}:${item.profile}:${item.path}`}
                data-stale={row.muted || undefined}
              >
                <span>{availabilityProfile(item.profile)}</span>
                <div>
                  <span data-availability={row.status}>{row.text}</span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {details.length > 0 && (
        <details
          className="cw-model-input-details"
          data-stale={
            notice === "observation_expired" ||
            notice === "query_failed" ||
            undefined
          }
        >
          <summary>
            <span>{t("availability.details")}</span>
            {commonSource && <small>{commonSource}</small>}
          </summary>
          <dl>
            {details.map((detail, index) => (
              <div key={`${detail.name}:${index}`}>
                <dt>{detail.label}</dt>
                <dd>
                  <span>{detail.text}</span>
                  {detail.scope && <small>{detail.scope}</small>}
                  {!commonSource && <small>{detail.source}</small>}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {current?.checkedAt != null && (
        <small>
          {t("availability.checkedAt", {
            time: new Date(current.checkedAt).toLocaleTimeString(locale),
          })}
        </small>
      )}
    </section>
  );
}
