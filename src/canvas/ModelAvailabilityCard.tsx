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
}: {
  value?: ModelAvailability | null;
  onRefresh?: () => void;
  checking?: boolean;
  title?: string;
  error?: string;
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
  const details = availabilityCardDetails(current?.operations ?? []);
  return (
    <section
      className="cw-model-availability"
      aria-label={t("availability.title")}
    >
      <div className="cw-model-availability-heading">
        <strong>{title ?? t("availability.title")}</strong>
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
      {message && <p role={error ? "alert" : "status"}>{message}</p>}
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
          <summary>{t("availability.details")}</summary>
          <dl>
            {details.map((detail, index) => (
              <div key={`${detail.name}:${index}`}>
                <dt>{detail.label}</dt>
                <dd>
                  <span>{detail.text}</span>
                  {detail.scope && <small>{detail.scope}</small>}
                  <small>{detail.source}</small>
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
