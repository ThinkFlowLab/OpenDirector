import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import {
  useFloatingAssistant,
  type AssistantSurface,
} from "./useFloatingAssistant";
import type { WorkspaceMode } from "./workspaceMode";

const KEY = "opendirector.assistant-layout.v1";
const DESKTOP_MIN_WIDTH = 320;
const MAX_WIDTH = 720;
const COLLAPSE_AT = 200;
const GUTTER = 28;

function readWidth(): number | null {
  try {
    const width = JSON.parse(localStorage.getItem(KEY) ?? "null")?.width;
    return typeof width === "number" &&
      Number.isFinite(width) &&
      width > COLLAPSE_AT
      ? width
      : null;
  } catch {
    return null;
  }
}

/** A left conversation column; the default column occupies one third of the workspace. */
export function useAssistantLayout(
  root: RefObject<HTMLDivElement | null>,
  open: boolean,
  onCollapse: () => void,
  mode: WorkspaceMode,
) {
  const [preferredWidth, setPreferredWidth] = useState(readWidth);
  const [surface, setSurface] = useState<AssistantSurface>(() => ({
    left: 0,
    top: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const viewport = surface.width;
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{
    x: number;
    width: number;
    restore: number | null;
  } | null>(null);
  const mobile = viewport <= 700;
  const defaultWidth = Math.max(COLLAPSE_AT + 1, viewport / 3 - GUTTER);
  const minWidth = window.opendirectorDesktop ? DESKTOP_MIN_WIDTH : COLLAPSE_AT;
  const maxWidth = Math.min(
    Math.max(MAX_WIDTH, defaultWidth),
    Math.max(COLLAPSE_AT + 1, viewport - 360 - GUTTER),
  );
  const width = mobile
    ? Math.max(1, viewport - GUTTER)
    : Math.min(Math.max(preferredWidth ?? defaultWidth, minWidth), maxWidth);
  const floatingLayout = useFloatingAssistant(
    mode === "canvas" && open && !mobile,
    surface,
    width,
  );
  const stop = () => {
    drag.current = null;
    setDragging(false);
  };
  useLayoutEffect(() => {
    const host = root.current;
    if (!host) return;
    // The native project sidebar takes space from the header and both columns.
    const topbar = host.querySelector<HTMLElement>(".cw-topbar");
    if (!topbar) return;
    const measure = () => {
      const bounds = host.getBoundingClientRect();
      const header = topbar.getBoundingClientRect();
      const next = {
        left: header.left - bounds.left,
        top: header.bottom - bounds.top,
        width: topbar.clientWidth,
        height: Math.max(0, bounds.bottom - header.bottom),
      };
      setSurface((previous) =>
        previous.left === next.left &&
        previous.top === next.top &&
        previous.width === next.width &&
        previous.height === next.height
          ? previous
          : next,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    observer.observe(topbar);
    measure();
    return () => observer.disconnect();
  }, [root]);
  useEffect(() => {
    if (dragging) return;
    try {
      localStorage.setItem(KEY, JSON.stringify({ width: preferredWidth }));
    } catch {
      /* The active layout remains usable without storage. */
    }
  }, [preferredWidth, dragging]);
  useEffect(() => {
    document.body.classList.toggle("cw-resizing-assistant", dragging);
    return () => document.body.classList.remove("cw-resizing-assistant");
  }, [dragging]);
  useEffect(() => {
    if (!open) stop();
  }, [open]);
  const resize = (next: number, restore = preferredWidth) => {
    if (next <= COLLAPSE_AT) {
      stop();
      setPreferredWidth(restore);
      onCollapse();
    } else setPreferredWidth(Math.min(next, maxWidth));
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width, restore: preferredWidth };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current)
      resize(
        drag.current.width + event.clientX - drag.current.x,
        drag.current.restore,
      );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? maxWidth
          : event.key === "ArrowLeft"
            ? width - 10
            : event.key === "ArrowRight"
              ? width + 10
              : null;
    if (next !== null) {
      event.preventDefault();
      event.stopPropagation();
      resize(next);
    }
  };
  return {
    ...floatingLayout,
    width,
    maxWidth,
    mobile,
    canShowSessionSidebar: viewport >= 900,
    dragging,
    columnWidth:
      open && !mobile && !floatingLayout.floating ? width + GUTTER : 0,
    resizer: {
      onPointerDown,
      onPointerMove,
      onPointerUp: stop,
      onPointerCancel: stop,
      onLostPointerCapture: stop,
      onKeyDown,
      onDoubleClick: () => setPreferredWidth(null),
    },
  };
}
export type AssistantLayout = ReturnType<typeof useAssistantLayout>;
