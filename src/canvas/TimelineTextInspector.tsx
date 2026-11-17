import { useEffect, useRef, useState, useMemo } from "react";
import { useI18n } from "../i18n/I18nProvider.tsx";
import type { TimelineData, TimelineTextOverlayView } from "./model.ts";
import { validTimelineText, type TimelineTextPatch } from "./timelineText.ts";
import {
  prepareTimelineFonts,
  type TimelineFontSession,
} from "./timelineTextRenderer.ts";
import { layoutTimelineText } from "./timelineTextLayout.ts";

export function TimelineTextInspector({
  timeline,
  overlay,
  onChange,
  onDelete,
  onReorder,
  onDraftChange,
  onError,
  onValidityChange,
}: {
  timeline: TimelineData;
  overlay: TimelineTextOverlayView;
  onChange: (patch: TimelineTextPatch, gesture?: string) => void;
  onDraftChange: (dirty: boolean) => void;
  onValidityChange: (valid: boolean) => void;
  onError: (error: Error) => void;
  onDelete: () => void;
  onReorder: (delta: number) => void;
}) {
  const { t } = useI18n();
  const [body, setBody] = useState(overlay.text),
    composing = useRef(false);
  useEffect(() => setBody(overlay.text), [overlay.id, overlay.text]);
  const commit = (text: string) => {
    if (text !== overlay.text) onChange({ text });
  };
  const number = (
    key: "start" | "end" | "x" | "y" | "maxWidth",
    low: number,
    high?: number,
  ) => (
    <label className="cw-domain-field">
      {t(`timeline.text.${key}`)}
      <input
        type="number"
        min={low}
        max={high}
        step={key === "start" || key === "end" ? 1 / timeline.fps : 0.01}
        value={overlay[key]}
        onChange={(e) => {
          if (e.target.value.trim())
            onChange({ [key]: Number(e.target.value) }, key);
        }}
        onBlur={() => onChange({})}
      />
    </label>
  );
  const styleNumber = (
    key: "fontSize" | "lineHeight",
    low: number,
    high: number,
    step: number,
  ) => (
    <label className="cw-domain-field">
      {t(`timeline.text.${key}`)}
      <input
        type="number"
        min={low}
        max={high}
        step={step}
        value={overlay.style[key]}
        onChange={(e) => {
          if (e.target.value.trim())
            onChange(
              { style: { ...overlay.style, [key]: Number(e.target.value) } },
              key,
            );
        }}
        onBlur={() => onChange({})}
      />
    </label>
  );
  const { background, stroke } = overlay.style;
  const [measurement, setMeasurement] = useState<{
    context: CanvasRenderingContext2D;
    session: TimelineFontSession;
    key: symbol;
  } | null>(null);
  const errorCallback = useRef(onError);
  errorCallback.current = onError;
  const selectedFont = timeline.fonts?.find(
    (font) => font.id === overlay.fontId,
  );
  const fontKey = useMemo(
    () => Symbol("inspectorFont"),
    [selectedFont?.id, selectedFont?.src, selectedFont?.asset?.fingerprint],
  );
  useEffect(() => {
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    setMeasurement(null);
    void prepareTimelineFonts(
      { ...timeline, overlays: [overlay] },
      controller.signal,
    )
      .then((session) => {
        if (controller.signal.aborted) {
          session.dispose();
          return;
        }
        dispose = () => session.dispose();
        const context = document.createElement("canvas").getContext("2d");
        if (context) setMeasurement({ context, session, key: fontKey });
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          errorCallback.current(
            reason instanceof Error ? reason : new Error(String(reason)),
          );
      });
    return () => {
      controller.abort();
      dispose?.();
    };
  }, [fontKey]);
  const coverageError = useMemo(() => {
    if (!measurement || measurement.key !== fontKey) return null;
    try {
      measurement.session.assertText(overlay.fontId, body);
      return null;
    } catch (reason) {
      return reason instanceof Error ? reason : new Error(String(reason));
    }
  }, [measurement, fontKey, overlay.fontId, body]);
  useEffect(() => {
    if (coverageError) errorCallback.current(coverageError);
  }, [coverageError]);
  useEffect(() => {
    onDraftChange(body !== overlay.text);
    onValidityChange(
      !!measurement &&
        measurement.key === fontKey &&
        !coverageError &&
        validTimelineText({
          ...timeline,
          overlays: timeline.overlays?.map((o) =>
            o.id === overlay.id ? { ...o, text: body } : o,
          ),
        }),
    );
    return () => {
      onDraftChange(false);
      onValidityChange(true);
    };
  }, [
    body,
    overlay.text,
    timeline,
    measurement,
    fontKey,
    coverageError,
    onDraftChange,
    onValidityChange,
  ]);
  const overflow = useMemo(() => {
    if (!measurement || measurement.key !== fontKey || coverageError)
      return false;
    measurement.context.font = `${overlay.style.fontSize}px "${measurement.session.family(overlay.fontId)}"`;
    return layoutTimelineText(
      { ...overlay, text: body },
      { width: timeline.width, height: timeline.height },
      (text) => measurement.context.measureText(text).width,
    ).overflow;
  }, [
    measurement,
    fontKey,
    coverageError,
    body,
    overlay,
    timeline.width,
    timeline.height,
  ]);
  return (
    <div className="cw-timeline-text-inspector">
      <h3>{t("timeline.text.properties")}</h3>
      <label className="cw-domain-field">
        {t("timeline.text.content")}
        <textarea
          aria-label={t("timeline.text.content")}
          value={body}
          rows={4}
          onChange={(e) => setBody(e.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(e) => {
            composing.current = false;
            commit(e.currentTarget.value);
          }}
          onBlur={() => {
            if (!composing.current) commit(body);
          }}
        />
      </label>
      <label className="cw-domain-field">
        {t("timeline.text.font")}
        <select
          aria-label={t("timeline.text.font")}
          value={overlay.fontId}
          onChange={(e) => onChange({ fontId: e.target.value })}
        >
          {timeline.fonts?.map((font) => (
            <option key={font.id} value={font.id}>
              {font.id === "noto-sans-cjk-sc-regular"
                ? t("timeline.text.defaultFont")
                : font.title}
            </option>
          ))}
        </select>
      </label>
      {number("start", 0)}
      {number("end", 0)}
      {number("x", 0, 1)}
      {number("y", 0, 1)}
      {number("maxWidth", 0.01, 1)}
      {styleNumber("fontSize", 1, 512, 1)}
      {styleNumber("lineHeight", 0.8, 3, 0.1)}
      <label className="cw-domain-field">
        {t("timeline.text.color")}
        <input
          type="color"
          value={overlay.style.color}
          onChange={(e) =>
            onChange({ style: { ...overlay.style, color: e.target.value } })
          }
        />
      </label>
      <label className="cw-domain-field">
        {t("timeline.text.align")}
        <select
          value={overlay.style.align}
          onChange={(e) =>
            onChange({
              style: {
                ...overlay.style,
                align: e.target.value as "left" | "center" | "right",
              },
            })
          }
        >
          {(["left", "center", "right"] as const).map((a) => (
            <option key={a} value={a}>
              {t(`timeline.text.${a}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="cw-domain-checkbox">
        <input
          type="checkbox"
          checked={!!background}
          onChange={(e) =>
            onChange({
              style: {
                ...overlay.style,
                background: e.target.checked
                  ? { color: "#000000", opacity: 0.5, padding: 4 }
                  : null,
              },
            })
          }
        />
        {t("timeline.text.background")}
      </label>
      {background && (
        <>
          <label className="cw-domain-field">
            {t("timeline.text.backgroundColor")}
            <input
              type="color"
              value={background.color}
              onChange={(e) =>
                onChange({
                  style: {
                    ...overlay.style,
                    background: { ...background, color: e.target.value },
                  },
                })
              }
            />
          </label>
          {(["opacity", "padding"] as const).map((key) => (
            <label key={key} className="cw-domain-field">
              {t(`timeline.text.${key}`)}
              <input
                type="number"
                min={0}
                max={key === "opacity" ? 1 : 128}
                step={key === "opacity" ? 0.05 : 1}
                value={background[key]}
                onChange={(e) => {
                  if (e.target.value.trim())
                    onChange(
                      {
                        style: {
                          ...overlay.style,
                          background: {
                            ...background,
                            [key]: Number(e.target.value),
                          },
                        },
                      },
                      key,
                    );
                }}
                onBlur={() => onChange({})}
              />
            </label>
          ))}
        </>
      )}
      <label className="cw-domain-checkbox">
        <input
          type="checkbox"
          checked={!!stroke}
          onChange={(e) =>
            onChange({
              style: {
                ...overlay.style,
                stroke: e.target.checked
                  ? { color: "#000000", width: 1 }
                  : null,
              },
            })
          }
        />
        {t("timeline.text.stroke")}
      </label>
      {stroke && (
        <>
          <label className="cw-domain-field">
            {t("timeline.text.strokeColor")}
            <input
              type="color"
              value={stroke.color}
              onChange={(e) =>
                onChange({
                  style: {
                    ...overlay.style,
                    stroke: { ...stroke, color: e.target.value },
                  },
                })
              }
            />
          </label>
          <label className="cw-domain-field">
            {t("timeline.text.strokeWidth")}
            <input
              type="number"
              min={0}
              max={32}
              value={stroke.width}
              onChange={(e) => {
                if (e.target.value.trim())
                  onChange(
                    {
                      style: {
                        ...overlay.style,
                        stroke: { ...stroke, width: Number(e.target.value) },
                      },
                    },
                    "strokeWidth",
                  );
              }}
              onBlur={() => onChange({})}
            />
          </label>
        </>
      )}
      {overflow && (
        <p role="status" className="cw-domain-note">
          {t("timeline.text.overflow")}
        </p>
      )}
      <div className="cw-domain-row">
        <button onClick={() => onReorder(-1)}>{t("timeline.text.down")}</button>
        <button onClick={() => onReorder(1)}>{t("timeline.text.up")}</button>
        <button onClick={onDelete}>{t("timeline.text.delete")}</button>
      </div>
    </div>
  );
}
