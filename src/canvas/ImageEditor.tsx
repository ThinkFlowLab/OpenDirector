import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { useT } from "../i18n/I18nProvider.tsx";
import type { Translate } from "../i18n/I18nProvider.tsx";
import type { CanvasNode } from "./model";
import { LayerBoard } from "./LayerBoard";
import type { LayerDocument } from "./layerDocument";
import "./image-editor.css";
import { INITIAL_CROP_OPTIONS, type ImageCropState } from "./imageCrop.ts";
import type { ImageCropOptions as EditOptions } from "../contracts/generated.ts";
import { defaultTranslate } from "./assistantTranslate.ts";
import { parseAssetSource } from "../backend/assetSource.ts";
import { resolveMediaSource } from "../backend/creationClient.ts";

export interface ImageEditorProps {
  node: CanvasNode;
  onApply: (
    src: string,
    layers?: LayerDocument,
    crop?: ImageCropState,
  ) => boolean | void | Promise<boolean | void>;
  onClose: () => void;
  initialTab?: "crop" | "layers";
  initialLayers?: LayerDocument;
  embedSourcesOnApply?: boolean;
}

type Aspect = EditOptions["aspect"];
interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
  imageWidth: number;
  imageHeight: number;
}

const INITIAL_OPTIONS = INITIAL_CROP_OPTIONS;

function calculateCrop(image: HTMLImageElement, options: EditOptions): Crop {
  const turned = options.rotation % 180 !== 0;
  const imageWidth = turned ? image.naturalHeight : image.naturalWidth;
  const imageHeight = turned ? image.naturalWidth : image.naturalHeight;
  if (options.aspect === "free") {
    const width = Math.max(1, (imageWidth * options.freeWidth) / 100);
    const height = Math.max(1, (imageHeight * options.freeHeight) / 100);
    return {
      x: ((imageWidth - width) * options.x) / 100,
      y: ((imageHeight - height) * options.y) / 100,
      width,
      height,
      imageWidth,
      imageHeight,
    };
  }
  const [ratioWidth, ratioHeight] =
    options.aspect === "original"
      ? [imageWidth, imageHeight]
      : options.aspect.split(":").map(Number);
  const ratio = ratioWidth! / ratioHeight!;
  const baseWidth = Math.min(imageWidth, imageHeight * ratio);
  const width = baseWidth / (options.zoom / 100);
  const height = width / ratio;
  return {
    x: ((imageWidth - width) * options.x) / 100,
    y: ((imageHeight - height) * options.y) / 100,
    width,
    height,
    imageWidth,
    imageHeight,
  };
}

/** The preview and exported PNG share the same transform, crop and pixel filters. */
function renderImage(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  options: EditOptions,
  preview = false,
  t: Translate = defaultTranslate,
): Crop {
  const crop = calculateCrop(image, options);
  const scale = preview
    ? Math.min(1, 1200 / Math.max(crop.width, crop.height))
    : 1;
  canvas.width = Math.max(1, Math.round(crop.width * scale));
  canvas.height = Math.max(1, Math.round(crop.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error(t("editors.image.error.noCanvas"));
  if (!("filter" in context))
    throw new Error(t("editors.image.error.noFilter"));
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.filter = `brightness(${options.brightness}%) contrast(${options.contrast}%) saturate(${options.saturation}%)`;
  context.scale(canvas.width / crop.width, canvas.height / crop.height);
  context.translate(-crop.x, -crop.y);
  context.translate(crop.imageWidth / 2, crop.imageHeight / 2);
  // Flip in the visible, rotated image's axes rather than the original image's axes.
  context.scale(options.flipX ? -1 : 1, options.flipY ? -1 : 1);
  context.rotate((options.rotation * Math.PI) / 180);
  context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
  return crop;
}

function localImageSource(src: string): boolean {
  if (/^data:image\//i.test(src) || parseAssetSource(src)) return true;
  try {
    const url = new URL(src, window.location.href);
    return (
      (url.protocol === "blob:" && url.origin === window.location.origin) ||
      ((url.protocol === "http:" || url.protocol === "https:") &&
        url.origin === window.location.origin)
    );
  } catch {
    return false;
  }
}

function failureMessage(
  error: unknown,
  t: Translate = defaultTranslate,
): string {
  return error instanceof Error
    ? error.message
    : t("editors.image.error.failed");
}

export function ImageEditor({
  initialTab = "crop",
  initialLayers,
  embedSourcesOnApply,
  ...props
}: ImageEditorProps) {
  const [tab, setTab] = useState(initialTab);
  const [layerSource, setLayerSource] = useState(props.node.data.src);
  const [layers, setLayers] = useState(initialLayers);
  return tab === "layers" ? (
    <LayerBoard
      src={layerSource}
      title={props.node.data.title}
      initialDocument={layers}
      embedSourcesOnApply={embedSourcesOnApply}
      onApply={props.onApply}
      onClose={props.onClose}
    />
  ) : (
    <CropEditor
      {...props}
      onOpenLayers={(src, unchanged) => {
        setLayerSource(src);
        setLayers(unchanged ? initialLayers : undefined);
        setTab("layers");
      }}
    />
  );
}

function CropEditor({
  node,
  onApply,
  onClose,
  onOpenLayers,
}: ImageEditorProps & {
  onOpenLayers: (src: string, unchanged: boolean) => void;
}) {
  const t = useT();
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [options, setOptions] = useState<EditOptions>({ ...INITIAL_OPTIONS });
  const [loadError, setLoadError] = useState("");
  const [renderError, setRenderError] = useState("");
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const id = useId();
  closeRef.current = onClose;
  const crop = useMemo(
    () => (image ? calculateCrop(image, options) : null),
    [image, options],
  );
  const error = loadError || renderError;
  const cropDrag = useRef<{
    id: number;
    x: number;
    y: number;
    options: EditOptions;
    crop: Crop;
    bounds: DOMRect;
    resize: boolean;
  } | null>(null);
  const startCrop = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !crop || !canvasRef.current) return;
    event.preventDefault();
    cropDrag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      options: { ...options },
      crop,
      bounds: canvasRef.current.getBoundingClientRect(),
      resize: Boolean((event.target as HTMLElement).closest(".cw-crop-resize")),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveCrop = (event: PointerEvent<HTMLDivElement>) => {
    const drag = cropDrag.current;
    if (!drag || drag.id !== event.pointerId) return;
    const { crop: c } = drag;
    const dx = ((event.clientX - drag.x) / drag.bounds.width) * c.imageWidth;
    const dy = ((event.clientY - drag.y) / drag.bounds.height) * c.imageHeight;
    const width = drag.resize
      ? Math.max(1, Math.min(c.imageWidth - c.x, c.width + dx))
      : c.width;
    const height = drag.resize
      ? Math.max(1, Math.min(c.imageHeight - c.y, c.height + dy))
      : c.height;
    const x = drag.resize
      ? c.x
      : Math.max(0, Math.min(c.imageWidth - width, c.x + dx));
    const y = drag.resize
      ? c.y
      : Math.max(0, Math.min(c.imageHeight - height, c.y + dy));
    setOptions({
      ...drag.options,
      freeWidth: (width / c.imageWidth) * 100,
      freeHeight: (height / c.imageHeight) * 100,
      x: c.imageWidth === width ? 0 : (x / (c.imageWidth - width)) * 100,
      y: c.imageHeight === height ? 0 : (y / (c.imageHeight - height)) * 100,
    });
  };
  const endCrop = (event: PointerEvent<HTMLDivElement>, cancel = false) => {
    const drag = cropDrag.current;
    if (!drag || drag.id !== event.pointerId) return;
    if (cancel) setOptions(drag.options);
    cropDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  useEffect(() => {
    let cancelled = false;
    setImage(null);
    setOptions({ ...(node.data.imageCrop?.options ?? INITIAL_OPTIONS) });
    setLoadError("");
    setRenderError("");
    setLoading(true);
    const src = node.data.imageCrop?.src ?? node.data.src;
    if (!src) {
      setLoadError(t("editors.image.error.noLocalSource"));
      setLoading(false);
      return;
    }
    if (!localImageSource(src)) {
      setLoadError(t("editors.image.error.remoteSource"));
      setLoading(false);
      return;
    }
    const source = new Image();
    source.decoding = "async";
    source.onload = () => {
      if (cancelled) return;
      if (!source.naturalWidth || !source.naturalHeight)
        setLoadError(t("editors.image.error.invalidSize"));
      else setImage(source);
      setLoading(false);
    };
    source.onerror = () => {
      if (!cancelled) {
        setLoadError(t("editors.image.error.readFailed"));
        setLoading(false);
      }
    };
    void resolveMediaSource(src).then(
      (url) => {
        if (!cancelled) source.src = url;
      },
      () => {
        if (!cancelled) {
          setLoadError(t("editors.image.error.readFailed"));
          setLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
      source.onload = null;
      source.onerror = null;
    };
  }, [node.id, node.data.src, node.data.imageCrop]);

  useEffect(() => {
    if (!image) return;
    const frame = requestAnimationFrame(() => {
      if (!canvasRef.current) return;
      try {
        renderImage(
          canvasRef.current,
          image,
          options.aspect === "free"
            ? { ...options, aspect: "original", zoom: 100 }
            : options,
          true,
          t,
        );
        setRenderError("");
      } catch (error) {
        setRenderError(failureMessage(error, t));
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [image, options]);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [
        ...dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]',
        ),
      ];
      const first = focusable[0],
        last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === dialogRef.current)
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          document.activeElement === dialogRef.current)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKey, true);
    return () => {
      document.removeEventListener("keydown", handleKey, true);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  const update = <K extends keyof EditOptions>(key: K, value: EditOptions[K]) =>
    setOptions((current) => ({ ...current, [key]: value }));
  const apply = async () => {
    if (!image || applying) return;
    setApplying(true);
    setRenderError("");
    try {
      const output = document.createElement("canvas");
      renderImage(output, image, options, false, t);
      const src = output.toDataURL("image/png");
      if (!src.startsWith("data:image/png;base64,"))
        throw new Error(t("editors.image.error.tooLarge"));
      const accepted = await onApply(src, undefined, {
        src: node.data.imageCrop?.src ?? node.data.src!,
        options,
        width: output.width,
        height: output.height,
      });
      if (accepted === false)
        throw new Error(t("editors.image.error.notApplied"));
      onClose();
    } catch (error) {
      setRenderError(
        t("editors.image.error.applyFailed", {
          reason: failureMessage(error, t),
        }),
      );
      setApplying(false);
    }
  };

  const slider = (
    key:
      | "zoom"
      | "freeWidth"
      | "freeHeight"
      | "x"
      | "y"
      | "brightness"
      | "contrast"
      | "saturation",
    label: string,
    min: number,
    max: number,
    disabled = false,
  ) => (
    <label className="cw-editor-slider" htmlFor={`${id}-${key}`}>
      <span>
        {label}
        <output htmlFor={`${id}-${key}`}>
          {Math.round(options[key] * 10) / 10}%
        </output>
      </span>
      <input
        id={`${id}-${key}`}
        type="range"
        min={min}
        max={max}
        step={1}
        value={options[key]}
        disabled={!image || disabled}
        onChange={(event) => update(key, Number(event.target.value))}
      />
    </label>
  );

  return (
    <div
      className="cw-image-editor-overlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="cw-image-editor"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        tabIndex={-1}
      >
        <header className="cw-editor-header">
          <div>
            <span className="cw-editor-eyebrow">LOCAL IMAGE EDITOR</span>
            <h2 id={`${id}-title`}>
              {t("editors.image.title")}
              <span>{node.data.title}</span>
            </h2>
          </div>
          <div className="cw-editor-header-actions">
            <button
              type="button"
              className="cw-editor-layers"
              disabled={!image || applying}
              onClick={() => {
                if (!image) return;
                try {
                  const unchanged = (
                    Object.keys(INITIAL_OPTIONS) as (keyof EditOptions)[]
                  ).every(
                    (key) =>
                      options[key] ===
                      (node.data.imageCrop?.options ?? INITIAL_OPTIONS)[key],
                  );
                  if (unchanged && node.data.src)
                    onOpenLayers(node.data.src, true);
                  else {
                    const output = document.createElement("canvas");
                    renderImage(output, image, options, false, t);
                    const src = output.toDataURL("image/png");
                    if (!src.startsWith("data:image/png;base64,"))
                      throw new Error(
                        t("editors.image.error.exportCropFailed"),
                      );
                    onOpenLayers(src, false);
                  }
                } catch (error) {
                  setRenderError(failureMessage(error, t));
                }
              }}
            >
              {t("editors.image.openLayers")}
            </button>
            <button
              type="button"
              className="cw-editor-close"
              onClick={onClose}
              aria-label={t("editors.image.closeAria")}
            >
              ×
            </button>
          </div>
        </header>
        <div className="cw-editor-body">
          <div className="cw-editor-preview-panel">
            <div
              className={`cw-editor-preview ${loading || !image ? "is-empty" : ""}`}
            >
              {loading && (
                <div className="cw-editor-loading" role="status">
                  <span />
                  {t("editors.image.loading")}
                </div>
              )}
              {!loading && !image && (
                <div className="cw-editor-empty">
                  <span aria-hidden="true">▧</span>
                  <p>{t("editors.image.emptyPreview")}</p>
                </div>
              )}
              <div
                className="cw-crop-stage"
                style={
                  crop
                    ? {
                        width: `min(100%, ${510 * (options.aspect === "free" ? crop.imageWidth / crop.imageHeight : crop.width / crop.height)}px)`,
                      }
                    : undefined
                }
              >
                <canvas
                  ref={canvasRef}
                  className={!image ? "cw-editor-hidden" : ""}
                  aria-label={t("editors.image.previewAria")}
                />
                {options.aspect === "free" && crop && (
                  <div
                    className="cw-free-crop"
                    aria-label={t("editors.image.freeCropAria")}
                    style={{
                      left: `${(crop.x / crop.imageWidth) * 100}%`,
                      top: `${(crop.y / crop.imageHeight) * 100}%`,
                      width: `${(crop.width / crop.imageWidth) * 100}%`,
                      height: `${(crop.height / crop.imageHeight) * 100}%`,
                    }}
                    onPointerDown={startCrop}
                    onPointerMove={moveCrop}
                    onPointerUp={(e) => endCrop(e)}
                    onPointerCancel={(e) => endCrop(e, true)}
                    onLostPointerCapture={(e) => endCrop(e, true)}
                  >
                    <span className="cw-crop-resize" aria-hidden="true" />
                  </div>
                )}
              </div>
            </div>
            <div className="cw-editor-preview-meta">
              <span>
                {image
                  ? t("editors.image.originalSize", {
                      width: image.naturalWidth,
                      height: image.naturalHeight,
                    })
                  : t("editors.image.localImage")}
              </span>
              <span>
                {crop
                  ? t("editors.image.outputSize", {
                      width: Math.round(crop.width),
                      height: Math.round(crop.height),
                    })
                  : t("editors.image.outputPng")}
              </span>
            </div>
            <p id={`${id}-description`} className="cw-editor-description">
              {t("editors.image.description")}
            </p>
          </div>
          <aside
            className="cw-editor-controls"
            aria-label={t("editors.image.controlsAria")}
          >
            <section>
              <div className="cw-editor-section-title">
                <h3>{t("editors.image.section.crop")}</h3>
                <button
                  type="button"
                  disabled={!image}
                  onClick={() => setOptions({ ...INITIAL_OPTIONS })}
                >
                  {t("editors.image.resetAll")}
                </button>
              </div>
              <label className="cw-editor-select" htmlFor={`${id}-aspect`}>
                <span>{t("editors.image.aspect")}</span>
                <select
                  id={`${id}-aspect`}
                  value={options.aspect}
                  disabled={!image}
                  onChange={(event) =>
                    update("aspect", event.target.value as Aspect)
                  }
                >
                  <option value="original">
                    {t("editors.image.aspect.original")}
                  </option>
                  <option value="free">
                    {t("editors.image.aspect.free")}
                  </option>
                  {(["1:1", "4:3", "3:4", "16:9", "9:16"] as const).map(
                    (aspect) => (
                      <option key={aspect} value={aspect}>
                        {aspect}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <div className="cw-editor-transform-buttons">
                <button
                  type="button"
                  disabled={!image}
                  onClick={() =>
                    update(
                      "rotation",
                      ((options.rotation + 90) %
                        360) as EditOptions["rotation"],
                    )
                  }
                >
                  <span aria-hidden="true">↻</span>
                  {t("editors.image.rotate")}
                </button>
                <button
                  type="button"
                  disabled={!image}
                  className={options.flipX ? "active" : ""}
                  aria-pressed={options.flipX}
                  onClick={() => update("flipX", !options.flipX)}
                >
                  <span aria-hidden="true">↔</span>
                  {t("editors.image.flipX")}
                </button>
                <button
                  type="button"
                  disabled={!image}
                  className={options.flipY ? "active" : ""}
                  aria-pressed={options.flipY}
                  onClick={() => update("flipY", !options.flipY)}
                >
                  <span aria-hidden="true">↕</span>
                  {t("editors.image.flipY")}
                </button>
              </div>
              {options.aspect === "free" ? (
                <>
                  {slider("freeWidth", t("editors.image.freeWidth"), 1, 100)}
                  {slider("freeHeight", t("editors.image.freeHeight"), 1, 100)}
                </>
              ) : (
                slider("zoom", t("editors.image.zoom"), 100, 400)
              )}
              {slider(
                "x",
                t("editors.image.positionX"),
                0,
                100,
                !!crop && Math.abs(crop.imageWidth - crop.width) < 0.01,
              )}
              {slider(
                "y",
                t("editors.image.positionY"),
                0,
                100,
                !!crop && Math.abs(crop.imageHeight - crop.height) < 0.01,
              )}
            </section>
            <section className="cw-editor-adjustments">
              <div className="cw-editor-section-title">
                <h3>{t("editors.image.section.color")}</h3>
                <span>{t("editors.image.livePreview")}</span>
              </div>
              {slider("brightness", t("editors.image.brightness"), 0, 200)}
              {slider("contrast", t("editors.image.contrast"), 0, 200)}
              {slider("saturation", t("editors.image.saturation"), 0, 200)}
            </section>
            <p className="cw-editor-local-note">
              <span aria-hidden="true">◉</span>
              {t("editors.image.localNote")}
            </p>
          </aside>
        </div>
        {error && (
          <p className="cw-editor-error" role="alert">
            {error}
          </p>
        )}
        <footer className="cw-editor-footer">
          <span>{t("editors.image.footerNote")}</span>
          <div>
            <button
              type="button"
              className="cw-editor-cancel"
              onClick={onClose}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="cw-editor-apply"
              disabled={!image || loading || applying || !!loadError}
              onClick={apply}
            >
              {applying
                ? t("editors.image.applying")
                : t("editors.image.apply")}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

export default ImageEditor;
