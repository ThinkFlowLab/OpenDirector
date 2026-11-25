import { useCallback, useEffect, useRef } from "react";
import { matchesShortcut, type ShortcutId } from "../shortcuts";

/** Shortcuts that open or create something from anywhere in the workspace. */
const APP_SHORTCUTS: ShortcutId[] = [
  "new-project",
  "switch-project",
  "settings",
  "assistant",
];

function blocked(target: Element | null): boolean {
  if (
    target instanceof HTMLElement &&
    target.closest("input,textarea,select,[contenteditable=true]")
  )
    return true;
  return (
    document.querySelector("dialog[open],[role=dialog],.cw-modal-backdrop") !==
    null
  );
}

/**
 * App-wide shortcuts that must reach the workspace from any panel.
 *
 * Canvas keys (undo, copy, nudge, …) live in `canvasKeyAction`; these four open
 * or create things and were previously desktop-only or mouse-only. Text fields,
 * open dialogs and IME composition keep their own keys.
 *
 * A browser keeps `Ctrl+N`, `Ctrl+K` and `Ctrl+J` for itself and runs its own
 * action instead; the page only wins the keys no browser claims (`Ctrl+,`).
 * Chromium inside the desktop shell has no such defaults, so the packaged app
 * receives every one of these keys here and needs no extra plumbing.
 */
export function useAppShortcuts(input: {
  enabled: boolean;
  onNewProject: () => void;
  onSwitchProject: () => void;
  onSettings: () => void;
  onAssistant: () => void;
}) {
  const latest = useRef(input);
  latest.current = input;
  const run = useCallback((id: ShortcutId) => {
    const handlers = latest.current;
    if (!handlers.enabled || blocked(document.activeElement)) return;
    if (id === "new-project") handlers.onNewProject();
    else if (id === "switch-project") handlers.onSwitchProject();
    else if (id === "settings") handlers.onSettings();
    else if (id === "assistant") handlers.onAssistant();
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const handlers = latest.current;
      if (!handlers.enabled || event.isComposing || event.repeat) return;
      if (event.altKey) return;
      const id = APP_SHORTCUTS.find((candidate) =>
        matchesShortcut(event, candidate),
      );
      if (!id) return;
      if (blocked(event.target as Element | null)) return;
      event.preventDefault();
      run(id);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [run]);
}
