import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

export type AssistantSurface = {
  left: number;
  top: number;
  width: number;
  height: number;
};
type Position = { x: number; y: number };
type Preference = { floating: boolean; position: Position };
const KEY = "opendirector.assistant-floating.v1";
const GUTTER = 14;
const clamp = (value: number, max: number) => Math.min(Math.max(0, value), max);

function readPreference(): Preference {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (
      typeof saved?.floating === "boolean" &&
      Number.isFinite(saved.position?.x) &&
      Number.isFinite(saved.position?.y)
    ) {
      return {
        floating: saved.floating,
        position: {
          x: clamp(saved.position.x, 1),
          y: clamp(saved.position.y, 1),
        },
      };
    }
  } catch {
    /* Storage is optional. */
  }
  return { floating: false, position: { x: 1, y: 0 } };
}

type Move = {
  panel: HTMLElement;
  handle: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  origin: Position;
  point: Position;
  active: boolean;
};

function paintMove(move: Move) {
  move.panel.style.setProperty("--cw-chat-drag-x", `${move.point.x}px`);
  move.panel.style.setProperty("--cw-chat-drag-y", `${move.point.y}px`);
}

/** Panel coordinates are local to the workspace, independent of canvas pan and zoom. */
export function useFloatingAssistant(
  available: boolean,
  surface: AssistantSurface,
  dockedWidth: number,
) {
  const [preference, setPreference] = useState(readPreference);
  const [moving, setMoving] = useState(false);
  const gesture = useRef<Move | null>(null);
  const frame = useRef<number | null>(null);
  const floating = available && (preference.floating || moving);
  const width = Math.min(
    460,
    Math.max(320, dockedWidth),
    Math.max(1, surface.width - 2 * GUTTER),
  );
  const room = Math.max(1, surface.height - 2 * GUTTER);
  const height = Math.min(room, 620, Math.max(320, Math.round(room * 0.75)));
  const left = surface.left + GUTTER;
  const top = surface.top + GUTTER;
  const travelX = Math.max(0, surface.width - 2 * GUTTER - width);
  const travelY = room - height;
  const place = (x: number, y: number): Position => ({
    x: left + clamp(x - left, travelX),
    y: top + clamp(y - top, travelY),
  });
  const position = {
    x: left + preference.position.x * travelX,
    y: top + preference.position.y * travelY,
  };

  function save(next: Preference) {
    setPreference(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* Keep the in-memory layout. */
    }
  }
  function savePosition(point: Position) {
    save({
      floating: true,
      position: {
        x: travelX
          ? clamp((point.x - left) / travelX, 1)
          : preference.position.x,
        y: travelY
          ? clamp((point.y - top) / travelY, 1)
          : preference.position.y,
      },
    });
  }
  function finish(commit: boolean) {
    const move = gesture.current;
    if (!move) return;
    gesture.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (move.handle.hasPointerCapture(move.pointerId)) {
      move.handle.releasePointerCapture(move.pointerId);
    }
    if (move.active && commit) savePosition(move.point);
    move.panel.style.removeProperty("--cw-chat-drag-x");
    move.panel.style.removeProperty("--cw-chat-drag-y");
    setMoving(false);
  }
  // A sidebar toggle or viewport change can invalidate the geometry mid-gesture.
  useLayoutEffect(() => {
    if (!available) return;
    const cancel = () => finish(false);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      cancel();
    };
  }, [available, surface, width]);

  function onPointerDown(event: PointerEvent<HTMLElement>) {
    if (!available || !event.isPrimary || event.button !== 0 || gesture.current)
      return;
    const panel = event.currentTarget.closest<HTMLElement>("#canvas-assistant");
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    // Preserve the point grabbed on the title, including when the docked title is wider.
    const origin = {
      x:
        panel.offsetLeft +
        Math.max(0, event.clientX - rect.left - width + GUTTER),
      y: panel.offsetTop,
    };
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panel,
      handle: event.currentTarget,
      origin,
      point: origin,
      active: false,
    };
  }
  function onPointerMove(event: PointerEvent<HTMLElement>) {
    const move = gesture.current;
    if (!move || move.pointerId !== event.pointerId) return;
    const dx = event.clientX - move.startX;
    const dy = event.clientY - move.startY;
    move.point = place(move.origin.x + dx, move.origin.y + dy);
    if (!move.active) {
      if (Math.hypot(dx, dy) < 5) return;
      move.active = true;
      // On detachment the next render must start at the grip, even before its first frame.
      paintMove(move);
      setMoving(true);
      return;
    }
    if (frame.current === null) {
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        paintMove(move);
      });
    }
  }
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!available) return;
    if (event.key === "Escape" && gesture.current) {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
      return;
    }
    const step = event.shiftKey ? 48 : 16;
    const offset: Record<string, Position> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const delta = offset[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const panel = event.currentTarget.closest<HTMLElement>("#canvas-assistant");
    const origin =
      !floating && panel
        ? { x: panel.offsetLeft, y: panel.offsetTop }
        : position;
    savePosition(place(origin.x + delta.x, origin.y + delta.y));
  }
  const floatingStyle: CSSProperties | undefined = floating
    ? {
        left: `var(--cw-chat-drag-x, ${position.x}px)`,
        top: `var(--cw-chat-drag-y, ${position.y}px)`,
        right: "auto",
        bottom: "auto",
        width,
        height,
      }
    : undefined;
  return {
    floating,
    floatingStyle,
    enableFloating() {
      finish(false);
      save({ ...preference, floating: true });
    },
    toggleFloating() {
      if (available) {
        finish(false);
        save({ ...preference, floating: !floating });
      }
    },
    moveHandle: {
      onPointerDown,
      onPointerMove,
      onKeyDown,
      onPointerUp: (event: PointerEvent<HTMLElement>) => {
        const move = gesture.current;
        if (!move || event.pointerId !== move.pointerId) return;
        move.point = place(
          move.origin.x + event.clientX - move.startX,
          move.origin.y + event.clientY - move.startY,
        );
        finish(true);
      },
      onPointerCancel: (event: PointerEvent<HTMLElement>) => {
        if (event.pointerId === gesture.current?.pointerId) finish(false);
      },
      onLostPointerCapture: (event: PointerEvent<HTMLElement>) => {
        if (event.pointerId === gesture.current?.pointerId) finish(false);
      },
    },
  };
}
