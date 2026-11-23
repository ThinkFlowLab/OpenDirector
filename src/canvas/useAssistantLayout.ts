import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";

const KEY = "opendirector.assistant-layout.v1";
const DEFAULT_WIDTH = 420;
const DESKTOP_MIN_WIDTH = 320;
const MAX_WIDTH = 720;
const COLLAPSE_AT = 200;

function readWidth() {
  try {
    const width = JSON.parse(localStorage.getItem(KEY) ?? "null")?.width;
    return typeof width === "number" &&
      Number.isFinite(width) &&
      width > COLLAPSE_AT
      ? Math.min(width, MAX_WIDTH)
      : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

/** OpenDirector's drag, keyboard, reset and collapse behavior, with room for the canvas header. */
export function useAssistantLayout(
  root: RefObject<HTMLDivElement | null>,
  open: boolean,
  onCollapse: () => void,
) {
  const [preferredWidth, setPreferredWidth] = useState(readWidth);
  const [bounds, setBounds] = useState({
    viewport: window.innerWidth,
    heading: 260,
    actions: 200,
  });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; width: number; restore: number } | null>(
    null,
  );
  const mobile = bounds.viewport <= 700;
  const headerSpace = bounds.viewport - bounds.heading - bounds.actions - 72;
  const desktop = Boolean(window.opendirectorDesktop);
  const belowHeader = desktop || mobile || headerSpace <= COLLAPSE_AT;
  const maxWidth = Math.min(
    MAX_WIDTH,
    belowHeader ? bounds.viewport - (mobile ? 20 : 28) : headerSpace,
  );
  const width = mobile
    ? maxWidth
    : Math.min(Math.max(preferredWidth, desktop ? DESKTOP_MIN_WIDTH : COLLAPSE_AT), maxWidth);

  const stop = () => {
    drag.current = null;
    setDragging(false);
  };
  useLayoutEffect(() => {
    const heading = root.current?.querySelector<HTMLElement>(
      ".cw-project-heading",
    );
    const actions = root.current?.querySelector<HTMLElement>(".cw-top-actions");
    const measure = () =>
      setBounds({
        viewport: window.innerWidth,
        heading: heading?.offsetWidth ?? 260,
        actions: actions?.offsetWidth ?? 200,
      });
    const resize = () => {
      stop();
      measure();
    };
    const observer = new ResizeObserver(measure);
    if (heading) observer.observe(heading);
    if (actions) observer.observe(actions);
    window.addEventListener("resize", resize);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, [root]);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ width: preferredWidth }));
    } catch {
      /* Keep usable without storage. */
    }
  }, [preferredWidth]);
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
        drag.current.width + drag.current.x - event.clientX,
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
            ? width + 10
            : event.key === "ArrowRight"
              ? width - 10
              : null;
    if (next !== null) {
      event.preventDefault();
      event.stopPropagation();
      resize(next);
    }
  };
  return {
    width,
    maxWidth,
    mobile,
    dragging,
    belowHeader,
    toolbarOffset: open && !belowHeader ? width + 6 : 0,
    resizer: {
      onPointerDown,
      onPointerMove,
      onPointerUp: stop,
      onPointerCancel: stop,
      onLostPointerCapture: stop,
      onKeyDown,
      onDoubleClick: () => setPreferredWidth(DEFAULT_WIDTH),
    },
  };
}

export type AssistantLayout = ReturnType<typeof useAssistantLayout>;
