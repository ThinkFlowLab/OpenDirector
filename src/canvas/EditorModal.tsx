import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { useT } from "../i18n/I18nProvider.tsx";
import type { CanvasResource } from "./model";
import { CanvasIcon } from "./CanvasIcon";
import "./node-editors.css";

export function EditorModal({
  title,
  subtitle,
  children,
  onClose,
  onApply,
  applyLabel,
  disabled = false,
  error,
  className = "",
  actions,
  headerAction,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  onClose: () => void;
  onApply?: () => void;
  applyLabel?: string;
  disabled?: boolean;
  error?: string;
  className?: string;
  actions?: ReactNode;
  headerAction?: ReactNode;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null),
    closeRef = useRef(onClose),
    id = useId();
  closeRef.current = onClose;
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className="cw-domain-overlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        className={`cw-domain-dialog ${className}`}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            closeRef.current();
          }
          if (event.key === "Tab") {
            const elements = [
              ...(ref.current?.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]',
              ) ?? []),
            ];
            const first = elements[0],
              last = elements.at(-1);
            if (!first || !last) {
              event.preventDefault();
              return;
            }
            if (
              event.shiftKey &&
              (document.activeElement === first ||
                document.activeElement === ref.current)
            ) {
              event.preventDefault();
              last.focus();
            }
            if (
              !event.shiftKey &&
              (document.activeElement === last ||
                document.activeElement === ref.current)
            ) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <header className="cw-domain-header">
          <div>
            <h2 id={id}>{title}</h2>
            <p>{subtitle}</p>
          </div>
          {headerAction}
          <button onClick={onClose} aria-label={t("editors.modal.closeAria")}>
            <CanvasIcon name="close" />
          </button>
        </header>
        <div className="cw-domain-body">{children}</div>
        {error && (
          <p className="cw-domain-error" role="alert">
            {error}
          </p>
        )}
        <footer className="cw-domain-footer">
          <div>{actions}</div>
          <div>
            <button onClick={onClose}>{t("common.cancel")}</button>
            {onApply && (
              <button
                className="cw-domain-primary"
                disabled={disabled}
                onClick={onApply}
              >
                {applyLabel ?? t("editors.modal.apply")}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

export function ResourcePreview({
  resource,
  controls = true,
}: {
  resource?: CanvasResource;
  controls?: boolean;
}) {
  const t = useT();
  if (!resource?.src)
    return (
      <div className="cw-resource-empty">
        <CanvasIcon name={resource?.kind ?? "image"} size={28} />
        <span>
          {resource
            ? t("editors.modal.resourceUnavailable")
            : t("editors.modal.addResource")}
        </span>
      </div>
    );
  if (resource.kind === "image")
    return <img src={resource.src} alt={resource.title} draggable={false} />;
  if (resource.kind === "video")
    return (
      <video
        src={resource.src}
        controls={controls}
        preload="metadata"
        playsInline
        aria-label={resource.title}
      />
    );
  if (resource.kind === "audio")
    return (
      <div className="cw-resource-audio">
        <CanvasIcon name="audio" size={30} />
        <audio
          src={resource.src}
          controls={controls}
          preload="metadata"
          aria-label={resource.title}
        />
      </div>
    );
  return (
    <div className="cw-resource-empty">
      <CanvasIcon name="file" size={30} />
      <span>{resource.title}</span>
    </div>
  );
}
