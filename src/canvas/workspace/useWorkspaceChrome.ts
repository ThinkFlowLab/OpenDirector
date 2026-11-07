/** Panels, assistant shortcut, menus, and welcome. */
import { doubleShiftDetector } from "../doubleShift.ts";
import { useEffect, useRef } from "react";
import { modelSetupMissing, shouldShowModelSetup } from "../ModelSetup";

import type { WorkspaceRuntime } from "./runtimeTypes.ts";
import type { Panel } from "./workspaceChrome.tsx";


export function useWorkspaceChrome(rt: WorkspaceRuntime) {
  const {
    assistantOpen,
    backendCatalog,
    menu,
    ready,
    referenceTarget,
    root,
    selected,
    setAssistantOpen,
    setAssistantSelectionRequest,
    setMenu,
    setPanel,
    setSettingsCategory,
    setSettingsOpen,
    setWelcomeOpen,
    setupChecked,
    switching,
  } = rt;

  useEffect(() => {
    if (setupChecked.current || !backendCatalog.connected) return;
    setupChecked.current = true;
    const preview = new URLSearchParams(window.location.search).get("setup");
    if (preview === "models") {
      setSettingsCategory("models");
      setSettingsOpen(true);
    } else if (preview === "welcome" || (shouldShowModelSetup() && modelSetupMissing(backendCatalog.models).length > 0)) {
      setWelcomeOpen(true);
    }
  }, [backendCatalog.connected, backendCatalog.models]);
  const showAssistant = () => {
    setPanel(null);
    setAssistantOpen(true);
    if (selected.length) setAssistantSelectionRequest((n) => n + 1);
  };
  const assistantReturnFocus = useRef<HTMLElement | null>(null);
  const toggleAssistantShortcut = useRef(() => {});
  toggleAssistantShortcut.current = () => {
    if (!ready || switching || document.querySelector("dialog[open], .cw-modal-backdrop")) return;
    if (assistantOpen) {
      setAssistantOpen(false);
      const target = assistantReturnFocus.current;
      requestAnimationFrame(() => {
        if (target?.isConnected && !target.closest(".cw-assistant-panel")) target.focus({ preventScroll: true });
        else root.current?.focus({ preventScroll: true });
      });
    } else {
      assistantReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      showAssistant();
    }
  };
  useEffect(() => {
    const detector = doubleShiftDetector();
    const down = (event: KeyboardEvent) => detector.keydown(event);
    const up = (event: KeyboardEvent) => {
      if (detector.keyup(event)) toggleAssistantShortcut.current();
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", detector.reset);
    window.addEventListener("pointerdown", detector.reset, true);
    window.addEventListener("compositionstart", detector.reset, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", detector.reset);
      window.removeEventListener("pointerdown", detector.reset, true);
      window.removeEventListener("compositionstart", detector.reset, true);
    };
  }, []);
  const togglePanel = (value: Panel) => {
    setAssistantOpen(false);
    referenceTarget.current = null;
    setPanel((p) => (p === value ? null : value));
    setMenu(null);
  };
  useEffect(() => {
    if (!menu) return;
    if (menu.connected) {
      const element =
        root.current?.querySelector<HTMLElement>(".cw-canvas-menu");
      element
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus({ preventScroll: true });
    }
    const close = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest(".cw-context-menu")
      )
        setMenu(null);
    };
    // Capture phase, like the selection and creation menus: surfaces that stop
    // pointerdown propagation (the node composer, action docks, the assistant
    // panel) must still dismiss this menu instead of trapping it open.
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [menu]);
  rt.showAssistant = showAssistant;
  rt.assistantReturnFocus = assistantReturnFocus;
  rt.toggleAssistantShortcut = toggleAssistantShortcut;
  rt.togglePanel = togglePanel;
}
