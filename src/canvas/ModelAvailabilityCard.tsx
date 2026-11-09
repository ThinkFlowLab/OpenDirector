import { useEffect, useState } from "react";
import {
  availabilityDelay,
  availabilityProfile,
  availabilityReason,
  currentAvailability,
  type ModelAvailability,
} from "../backend/availability.ts";
import { useT } from "../i18n/I18nProvider";

/** Observations do not edit the model's saved input rules or voice selection. */
export function ModelAvailabilityCard({
  value,
  onRefresh,
  checking = false,
  title,
}: {
  value?: ModelAvailability | null;
  onRefresh?: () => void;
  checking?: boolean;
  title?: string;
}) {
  const t = useT();
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
            {t(checking ? "availability.checking" : "availability.check")}
          </button>
        )}
      </div>
      <p role="status">
        {checking
          ? t("availability.checking")
          : availabilityReason(current?.reasonCode ?? "not_checked")}
      </p>
      {current?.operations.length ? (
        <ul>
          {current.operations.map((item) => (
            <li key={`${item.operation}:${item.profile}:${item.path}`}>
              <span>{availabilityProfile(item.profile)}</span>
              <span data-availability={item.status}>
                {t(`availability.status.${item.status}`)} —{" "}
                {availabilityReason(item.reasonCode)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {current?.checkedAt != null && (
        <small>
          {t("availability.checkedAt", {
            time: new Date(current.checkedAt).toLocaleTimeString(),
          })}
        </small>
      )}
    </section>
  );
}
