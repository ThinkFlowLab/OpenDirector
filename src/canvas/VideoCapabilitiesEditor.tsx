import type { VideoAdapter, VideoCapabilities } from "../backend/rules.ts";
import { useT } from "../i18n/I18nProvider.tsx";
import {
  videoOutputDrafts,
  type VideoOutputDraft,
} from "../backend/videoCapabilities.ts";

export interface VideoCapabilityDraft {
  custom: boolean;
  outputs: VideoOutputDraft[];
  defaultResolution: string;
  defaultDuration: string;
  dimensionStep: VideoCapabilities["dimensionStep"];
}

export function capabilityDraft(
  caps: VideoCapabilities | null | undefined,
  custom = false,
): VideoCapabilityDraft {
  return {
    custom,
    outputs: videoOutputDrafts(caps),
    defaultResolution: caps?.defaultResolution ?? "auto",
    defaultDuration: String(caps?.defaultDuration ?? 5),
    dimensionStep: caps?.dimensionStep ?? 2,
  };
}

export function VideoCapabilitiesEditor({
  value,
  adapter = "auto",
  onChange,
}: {
  value: VideoCapabilityDraft;
  adapter?: VideoAdapter;
  onChange: (value: VideoCapabilityDraft) => void;
}) {
  const t = useT();
  const h3 = adapter === "fasth3" || adapter === "fasth3_dual" || adapter === "minimax_h3";
  const update = (patch: Partial<VideoCapabilityDraft>) =>
    onChange({ ...value, ...patch });
  const rowChange = (index: number, patch: Partial<VideoOutputDraft>) =>
    update({
      outputs: value.outputs.map((row, item) =>
        item === index ? { ...row, ...patch } : row,
      ),
    });
  return (
    <div className="cw-video-capabilities">
      <label className="cw-domain-checkbox">
        <input
          type="checkbox"
          checked={value.custom}
          onChange={(event) => update({ custom: event.target.checked })}
        />
        {t("tools.videoCapabilities.custom")}
      </label>
      <p className="cw-capability-help">
        {h3
          ? t("tools.videoCapabilities.helpH3")
          : t("tools.videoCapabilities.helpDefault")}
      </p>
      <fieldset disabled={!value.custom}>
        {value.outputs.map((row, index) => (
          <div className="cw-output-spec" key={index}>
            <div className="cw-output-spec-heading">
              <strong>
                {t("tools.videoCapabilities.output.heading", {
                  index: index + 1,
                })}
              </strong>
              <button
                className="cw-settings-button"
                type="button"
                disabled={value.outputs.length === 1}
                onClick={() =>
                  update({
                    outputs: value.outputs.filter((_, item) => item !== index),
                  })
                }
              >
                {t("tools.videoCapabilities.output.remove", {
                  index: index + 1,
                })}
              </button>
            </div>
            <div className="cw-capability-grid">
              <label className="cw-domain-field">
                {t("tools.videoCapabilities.output.resolution")}
                <input
                  aria-label={t("tools.videoCapabilities.output.resolutionAria", {
                    index: index + 1,
                  })}
                  maxLength={24}
                  value={row.resolution}
                  placeholder={t(
                    "tools.videoCapabilities.output.resolutionPlaceholder",
                  )}
                  onChange={(event) =>
                    rowChange(index, { resolution: event.target.value })
                  }
                />
              </label>
              <label className="cw-domain-field">
                {t("tools.videoCapabilities.output.seconds")}
                <input
                  aria-label={t("tools.videoCapabilities.output.secondsAria", {
                    index: index + 1,
                  })}
                  maxLength={200}
                  value={row.seconds}
                  placeholder={t(
                    "tools.videoCapabilities.output.secondsPlaceholder",
                  )}
                  onChange={(event) =>
                    rowChange(index, { seconds: event.target.value })
                  }
                />
              </label>
              <label className="cw-domain-field">
                {t("tools.videoCapabilities.output.width")}
                <input
                  aria-label={t("tools.videoCapabilities.output.widthAria", {
                    index: index + 1,
                  })}
                  type="number"
                  min={64}
                  max={8192}
                  value={row.width}
                  placeholder={t(
                    "tools.videoCapabilities.output.widthPlaceholder",
                  )}
                  onChange={(event) =>
                    rowChange(index, { width: event.target.value })
                  }
                />
              </label>
              <label className="cw-domain-field">
                {t("tools.videoCapabilities.output.height")}
                <input
                  aria-label={t("tools.videoCapabilities.output.heightAria", {
                    index: index + 1,
                  })}
                  type="number"
                  min={64}
                  max={8192}
                  value={row.height}
                  placeholder={t(
                    "tools.videoCapabilities.output.heightPlaceholder",
                  )}
                  onChange={(event) =>
                    rowChange(index, { height: event.target.value })
                  }
                />
              </label>
            </div>
          </div>
        ))}
        <button
          className="cw-settings-button"
          type="button"
          disabled={value.outputs.length >= 20}
          onClick={() =>
            update({
              outputs: [
                ...value.outputs,
                { resolution: "", seconds: "", width: "", height: "" },
              ],
            })
          }
        >
          {t("tools.videoCapabilities.output.add")}
        </button>
        <div className="cw-capability-grid">
          <label className="cw-domain-field">
            {t("tools.videoCapabilities.defaults.resolution")}
            <select
              aria-label={t("tools.videoCapabilities.defaults.resolution")}
              value={value.defaultResolution}
              onChange={(event) =>
                update({ defaultResolution: event.target.value })
              }
            >
              <option value="auto">{t("common.auto")}</option>
              {[
                ...new Set(
                  value.outputs
                    .map((row) => row.resolution.trim().toUpperCase())
                    .filter((label) => label && label !== "AUTO"),
                ),
              ].map((label) => (
                <option key={label} value={label}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="cw-domain-field">
            {t("tools.videoCapabilities.defaults.duration")}
            <input
              aria-label={t("tools.videoCapabilities.defaults.durationAria")}
              type="number"
              min={1}
              max={60}
              value={value.defaultDuration}
              onChange={(event) =>
                update({ defaultDuration: event.target.value })
              }
            />
          </label>
          <label className="cw-domain-field">
            {t("tools.videoCapabilities.defaults.alignment")}
            <select
              aria-label={t("tools.videoCapabilities.defaults.alignment")}
              value={value.dimensionStep}
              onChange={(event) =>
                update({
                  dimensionStep: Number(
                    event.target.value,
                  ) as VideoCapabilityDraft["dimensionStep"],
                })
              }
            >
              {[1, 2, 8, 16, 32, 64].map((step) => (
                <option key={step} value={step}>
                  {step}
                </option>
              ))}
            </select>
          </label>
        </div>
      </fieldset>
    </div>
  );
}
