import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import "./tooltips.css";

type TooltipSide = "top" | "bottom" | "left" | "right" | "bottom-right";
const TooltipContext = createContext<{
  openId: string | null;
  setOpenId: Dispatch<SetStateAction<string | null>>;
} | null>(null);

export function TooltipProvider({ children }: { children: ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <TooltipContext.Provider value={{ openId, setOpenId }}>
      {children}
    </TooltipContext.Provider>
  );
}

/** Shared by icon controls; a portal keeps labels out of clipped/zoomed canvases. */
export function TooltipButton({
  label,
  shortcut,
  tooltipSide = "top",
  tooltipAnchorSelector,
  tooltipCompact = false,
  tooltipDelay = 200,
  showTooltip = true,
  showOnClick = false,
  children,
  onPointerEnter,
  onPointerLeave,
  onFocus,
  onBlur,
  onClick,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  shortcut?: string;
  tooltipSide?: TooltipSide;
  /** Anchor to a child icon when the button also contains a wider label. */
  tooltipAnchorSelector?: string;
  tooltipCompact?: boolean;
  tooltipDelay?: number;
  /** Off when the button already shows its label as text. */
  showTooltip?: boolean;
  /** An informational trigger can also reveal its description on touch. */
  showOnClick?: boolean;
}) {
  const id = useId();
  const context = useContext(TooltipContext);
  if (!context) throw new Error("TooltipButton requires TooltipProvider");
  const { openId, setOpenId } = context;
  const button = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const open = openId === id;
  const setOpen = (value: boolean) =>
    setOpenId((current) => (value ? id : current === id ? null : current));
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const clearTimer = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
    setPending(false);
  };
  const close = () => {
    clearTimer();
    setOpen(false);
  };
  const show = (delay: number) => {
    clearTimer();
    if (!showTooltip) return;
    if (delay) {
      setPending(true);
      timer.current = setTimeout(() => {
        timer.current = undefined;
        setPending(false);
        setOpen(true);
      }, delay);
    } else setOpen(true);
  };
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      setOpenId((current) => (current === id ? null : current));
    },
    [id, setOpenId],
  );
  useLayoutEffect(() => {
    if (!open || !button.current || !tooltip.current) return;
    const anchorElement = tooltipAnchorSelector
      ? button.current.querySelector(tooltipAnchorSelector)
      : null;
    const anchor = (anchorElement ?? button.current).getBoundingClientRect();
    const tip = tooltip.current.getBoundingClientRect();
    const corner = tooltipSide === "bottom-right";
    const gap = corner ? 4 : 12;
    const padding = 12;
    let side = corner ? "right" : tooltipSide;
    if (side === "top" && anchor.top < tip.height + gap + padding)
      side = "bottom";
    if (
      side === "bottom" &&
      anchor.bottom + tip.height + gap > innerHeight - padding
    )
      side = "top";
    if (side === "left" && anchor.left < tip.width + gap + padding)
      side = "right";
    if (
      side === "right" &&
      anchor.right + tip.width + gap > innerWidth - padding
    )
      side = "left";
    const x =
      side === "left"
        ? anchor.left - gap - tip.width
        : side === "right"
          ? (corner ? anchor.left + anchor.width / 2 : anchor.right) + gap
          : anchor.left + (anchor.width - tip.width) / 2;
    const y = corner
      ? anchor.bottom + 2
      : side === "top"
        ? anchor.top - gap - tip.height
        : side === "bottom"
          ? anchor.bottom + gap
          : anchor.top + (anchor.height - tip.height) / 2;
    setPosition({
      x: Math.max(padding, Math.min(innerWidth - tip.width - padding, x)),
      y: Math.max(padding, Math.min(innerHeight - tip.height - padding, y)),
    });
  }, [
    open,
    label,
    shortcut,
    tooltipSide,
    tooltipAnchorSelector,
    tooltipCompact,
  ]);
  useEffect(() => {
    if (!open && !pending) return;
    const dismiss = () => {
      clearTimeout(timer.current);
      timer.current = undefined;
      setPending(false);
      setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (open) {
        event.preventDefault();
        event.stopPropagation();
      }
      dismiss();
    };
    const press = (event: PointerEvent) => {
      if (showOnClick && event.target instanceof Node && button.current?.contains(event.target)) return;
      dismiss();
    };
    window.addEventListener("keydown", escape, true);
    window.addEventListener("pointerdown", press, true);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("pointerdown", press, true);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [open, pending, showOnClick]);

  return (
    <>
      <button
        {...props}
        ref={button}
        type={props.type ?? "button"}
        aria-label={props["aria-label"] ?? label}
        aria-describedby={
          [props["aria-describedby"], open ? id : ""]
            .filter(Boolean)
            .join(" ") || undefined
        }
        onPointerEnter={(event) => {
          onPointerEnter?.(event);
          if (event.pointerType !== "touch" && !event.buttons)
            show(tooltipDelay);
        }}
        onPointerLeave={(event) => {
          onPointerLeave?.(event);
          close();
        }}
        onFocus={(event) => {
          onFocus?.(event);
          if (event.currentTarget.matches(":focus-visible")) show(0);
        }}
        onBlur={(event) => {
          onBlur?.(event);
          close();
        }}
        onPointerDownCapture={showOnClick ? undefined : close}
        onClick={(event) => {
          if (showOnClick && !open) show(0);
          else close();
          onClick?.(event);
        }}
      >
        {children}
      </button>
      {open &&
        createPortal(
          <div
            ref={tooltip}
            id={id}
            role="tooltip"
            className={`cw-tooltip${tooltipCompact ? " is-compact" : ""}`}
            style={{ left: position.x, top: position.y }}
          >
            <span>{label}</span>
            {shortcut && <kbd>{shortcut}</kbd>}
          </div>,
          document.body,
        )}
    </>
  );
}
