import { useLayoutEffect, useRef, type PointerEvent } from "react";
import { useT } from "../../i18n/I18nProvider";
import type { WorkspaceMode } from "../workspaceMode";

export function preserveModeInput(event: PointerEvent<HTMLButtonElement>) {
  const input = document.activeElement;
  if (event.button === 0 && input instanceof HTMLElement &&
      (input.isContentEditable || input.matches("input, textarea"))) {
    // Preserve the native caret and selection direction through the layout update.
    event.preventDefault();
  }
}

export function focusAfterModeChange(target?: HTMLElement | null) {
  const active = document.activeElement;
  if (!active || active === document.body || active.closest("[inert], [hidden]") ||
      !active.checkVisibility({ visibilityProperty: true })) {
    target?.focus({ preventScroll: true });
  }
}

export function WorkspaceModeSwitch({
  mode,
  onChange,
}: {
  mode: WorkspaceMode;
  onChange: (mode: WorkspaceMode) => void;
}) {
  const t = useT();
  const activatedButton = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const button = activatedButton.current;
    activatedButton.current = null;
    if (button) focusAfterModeChange(button);
  }, [mode]);
  return (
    <div
      className="cw-workspace-mode-switch"
      role="group"
      aria-label={t("workspaceModes.label")}
    >
      {(["agent", "canvas"] as const).map((value) => (
        <button
          key={value}
          type="button"
          data-testid={`workspace-mode-${value}`}
          aria-pressed={mode === value}
          onPointerDown={preserveModeInput}
          onClick={(event) => {
            if (mode !== value) activatedButton.current = event.currentTarget;
            onChange(value);
          }}
        >
          {t(`workspaceModes.short.${value}`)}
        </button>
      ))}
    </div>
  );
}
