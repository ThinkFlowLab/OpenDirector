import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useReactFlow, useViewport } from "@xyflow/react";
import type { Rect, Viewport } from "./model";
import {
  centeredViewport,
  selectionPlacement,
  selectionViewport,
  visibleSelectionArea,
  type SelectionChrome,
} from "./selectionPresentation";

function floatingPanelRect(host: HTMLElement | null): Rect | null {
  const floating = host?.closest(".cw-workspace")?.querySelector(
    '#canvas-assistant[data-floating="true"]:not([hidden])',
  );
  if (!host || !floating) return null;
  const canvas = host.getBoundingClientRect();
  const panel = floating.getBoundingClientRect();
  return {
    x: panel.left - canvas.left - 8,
    y: panel.top - canvas.top - 8,
    width: panel.width + 16,
    height: panel.height + 16,
  };
}

function fitOutsidePanel(
  bounds: Rect, view: Viewport, chrome: SelectionChrome, panel: Rect | null,
): SelectionChrome {
  const safe = visibleSelectionArea(bounds, view, chrome, panel);
  if (safe === chrome.safe) return chrome;
  return {
    ...chrome, safe,
    toolbar: { ...chrome.toolbar, width: Math.min(chrome.toolbar.width, safe.width) },
    composer: chrome.scaleComposer ? chrome.composer : {
      ...chrome.composer, width: Math.min(chrome.composer.width, safe.width),
    },
  };
}

/** One geometry owner for the node, upper action bar and lower generator. */
export function useSelectionPresentation({
  root,
  toolbar,
  composer,
  bounds,
  mediaBounds = bounds,
  nodeId,
  panel,
  focusRequest,
  blocked,
  controlsKey,
  preferredZoom,
  scaleComposer = false,
  preserveViewportKey = "",
}: {
  root: RefObject<HTMLDivElement | null>;
  toolbar: RefObject<HTMLDivElement | null>;
  composer: RefObject<HTMLDivElement | null>;
  bounds: Rect | null;
  mediaBounds?: Rect | null;
  nodeId: string | undefined;
  panel: string | null;
  focusRequest: number;
  blocked: boolean;
  controlsKey: string;
  /** Dedicated media editing may enlarge its source; ordinary selection preserves zoom. */
  preferredZoom?: number;
  scaleComposer?: boolean;
  /** Layout changes update control placement while preserving the user's viewport. */
  preserveViewportKey?: string;
}) {
  const flow = useReactFlow();
  const viewport = useViewport();
  const measurementKey = JSON.stringify([
    nodeId,
    panel,
    focusRequest,
    controlsKey,
    scaleComposer,
  ]);
  const [measurement, setMeasurement] = useState<{
    key: string;
    obscured: boolean;
    fullSafe: Rect;
    chrome: SelectionChrome;
  }>({
    key: "",
    obscured: false,
    fullSafe: { x: 80, y: 72, width: 0, height: 0 },
    chrome: {
      safe: { x: 80, y: 72, width: 0, height: 0 },
      toolbar: { width: 0, height: 0 },
      composer: { width: 0, height: 0 },
    },
  });
  const { chrome, obscured } = measurement;
  // Observe real controls, including wrapping, sidebar resizing and viewport size.
  useLayoutEffect(() => {
    const host = root.current;
    if (!host) return;
    const startingViewport = flow.getViewport();
    const measure = () => {
      const rect = host.getBoundingClientRect();
      const panels = [...host.querySelectorAll(".cw-side-panel,.cw-assistant-panel:not([hidden])")];
      let left = rect.width < 700 ? 64 : 80;
      let right = rect.width - 20;
      for (const panel of panels) {
        const sidebar = panel.getBoundingClientRect();
        if (!panel.classList.contains("cw-assistant-panel") && sidebar.left - rect.left < rect.width / 2)
          left = Math.max(left, sidebar.right - rect.left + 16);
        else right = Math.min(right, sidebar.left - rect.left - 16);
      }
      const covered = right - left < 240;
      if (covered) {
        left = rect.width < 700 ? 64 : 80;
        right = rect.width - 20;
      }
      const safe = {
        x: left,
        y: 72,
        width: Math.max(1, right - left),
        height: Math.max(1, rect.height - 150),
      };
      const size = (element: HTMLDivElement | null, canvasUnits = false) => {
        const box = element?.getBoundingClientRect();
        return {
          width: canvasUnits
            ? (element?.offsetWidth ?? 0)
            : Math.min(safe.width, box?.width ?? 0),
          height: canvasUnits
            ? (element?.offsetHeight ?? 0)
            : (box?.height ?? 0),
        };
      };
      const measured: SelectionChrome = {
        safe,
        toolbar: size(toolbar.current),
        composer: size(composer.current, scaleComposer),
        scaleComposer,
      };
      const overlay = floatingPanelRect(host);
      const next = {
        key: measurementKey,
        obscured: covered,
        fullSafe: safe,
        chrome: bounds && overlay
          ? fitOutsidePanel(bounds, selectionViewport(bounds, startingViewport, measured), measured, overlay)
          : measured,
      };
      setMeasurement((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    if (toolbar.current) observer.observe(toolbar.current);
    if (composer.current) observer.observe(composer.current);
    for (const panel of host.querySelectorAll(".cw-side-panel,.cw-assistant-panel:not([hidden])")) observer.observe(panel);
    measure();
    return () => observer.disconnect();
  }, [root, toolbar, composer, measurementKey, scaleComposer]);

  const lastLayout = useRef("");
  const lastPresentation = useRef({ layout: preserveViewportKey, intent: "" });
  const preservedIntent = useRef<string | null>(null);
  const origin = useRef<{ key: string; viewport: Viewport } | null>(null);
  const animation = useRef<symbol | null>(null);
  const stopPresentation = useCallback(() => {
    if (!animation.current) return;
    animation.current = null;
    // Interrupt only a transition started here, never a user's zoom command.
    void flow.setViewport(flow.getViewport(), { duration: 0 });
  }, [flow]);
  const present = (next: Viewport) => {
    const token = Symbol();
    animation.current = token;
    void flow
      .setViewport(next, {
        duration: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 0
          : 180,
      })
      .finally(() => {
        if (animation.current === token) animation.current = null;
      });
  };
  useLayoutEffect(() => stopPresentation, [stopPresentation]);
  useLayoutEffect(() => {
    const intent = JSON.stringify([nodeId, focusRequest, panel]);
    if (lastPresentation.current.layout !== preserveViewportKey) {
      preservedIntent.current = intent;
      lastPresentation.current = { layout: preserveViewportKey, intent };
      origin.current = { key: intent, viewport: flow.getViewport() };
    }
    if (!bounds || blocked || obscured) stopPresentation();
    // A new node must not be fitted using the previous node's generator height.
    if (measurement.key !== measurementKey) return;
    const key = JSON.stringify([
      nodeId,
      focusRequest,
      controlsKey,
      chrome,
      obscured,
    ]);
    if (key === lastLayout.current) return;
    if (!bounds || blocked || obscured || chrome.safe.width === 0) return;
    lastLayout.current = key;
    const current = flow.getViewport();
    if (preservedIntent.current === intent) {
      stopPresentation();
      return;
    }
    preservedIntent.current = null;
    if (origin.current?.key !== intent)
      origin.current = {
        key: intent,
        viewport: preferredZoom
          ? {
              ...current,
              zoom: preferredZoom,
              x:
                current.x +
                (bounds.x + bounds.width / 2) * (current.zoom - preferredZoom),
              y: current.y + bounds.y * (current.zoom - preferredZoom),
            }
          : current,
      };
    // Measurement may settle over several frames (wrapping and max-height). Fit
    // from the same user viewport, otherwise each intermediate size only shrinks.
    const next = selectionViewport(bounds, origin.current.viewport, chrome);
    if (
      Math.abs(next.x - current.x) > 0.5 ||
      Math.abs(next.y - current.y) > 0.5 ||
      Math.abs(next.zoom - current.zoom) > 0.0001
    )
      present(next);
    else stopPresentation();
    // bounds/viewport positions are deliberately not triggers: dragging and manual
    // navigation must never be undone by the presentation's automatic fitting.
  }, [
    nodeId,
    focusRequest,
    panel,
    chrome,
    obscured,
    blocked,
    flow,
    measurement.key,
    measurementKey,
    preferredZoom,
    preserveViewportKey,
  ]);

  let placement = bounds
    ? selectionPlacement(bounds, viewport, chrome)
    : null;
  // A manually panned node is still editable anywhere on the canvas.
  if (bounds && placement && !placement.visible && chrome.safe !== measurement.fullSafe) {
    placement = selectionPlacement(bounds, viewport, { ...chrome, safe: measurement.fullSafe });
  }
  return {
    userNavigation: () => {
      stopPresentation();
      origin.current = null;
    },
    fitSelection: (maxZoom = 1.5) => {
      if (!bounds || obscured || !chrome.safe.width) return;
      const full = { ...chrome, safe: measurement.fullSafe };
      const view = { ...flow.getViewport(), zoom: maxZoom };
      const proposed = centeredViewport(bounds, view, full);
      const visible = fitOutsidePanel(bounds, proposed, full, floatingPanelRect(root.current));
      const safe = visible.safe;
      view.x = safe.x + safe.width / 2 - (bounds.x + bounds.width / 2) * maxZoom;
      view.y = safe.y + safe.height / 2 - (bounds.y + bounds.height / 2) * maxZoom;
      origin.current = {
        key: JSON.stringify([nodeId, focusRequest, panel]),
        viewport: view,
      };
      present(selectionViewport(bounds, view, visible));
    },
    reveal: (bounds: Rect) => {
      if (obscured || !chrome.safe.width) return;
      const view = flow.getViewport();
      const full = {
        safe: measurement.fullSafe, toolbar: { width: 0, height: 0 }, composer: { width: 0, height: 0 },
      };
      const proposed = centeredViewport(bounds, view, full);
      const visible = fitOutsidePanel(bounds, proposed, full, floatingPanelRect(root.current));
      present(visible === full ? proposed : centeredViewport(bounds, view, visible));
    },
    placement,
    mediaRect: mediaBounds
      ? {
          left: mediaBounds.x * viewport.zoom + viewport.x + viewport.zoom,
          top: mediaBounds.y * viewport.zoom + viewport.y + viewport.zoom,
          width: (mediaBounds.width - 2) * viewport.zoom,
          height: (mediaBounds.height - 2) * viewport.zoom,
        }
      : null,
    visible: Boolean(placement?.visible) && !obscured,
    composerWidth:
      !scaleComposer && chrome.safe.width
        ? Math.min(680, chrome.safe.width)
        : 680,
    composerTransform: scaleComposer ? `scale(${viewport.zoom})` : undefined,
    toolbarMaxWidth: chrome.safe.width || undefined,
    composerMaxHeight:
      !scaleComposer && chrome.safe.height
        ? Math.max(120, Math.min(360, chrome.safe.height * 0.58))
        : 360,
  };
}
