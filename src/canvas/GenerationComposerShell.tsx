import type { ReactNode, RefObject } from "react";
import "./generation-composer.css";

/** Owns bounded height and scrolling for Agent and all media generators. */
export function GenerationComposerShell({
  composerRef,
  label,
  running,
  optimizing = false,
  onEscape,
  children,
}: {
  composerRef: RefObject<HTMLDivElement | null>;
  label: string;
  running: boolean;
  optimizing?: boolean;
  onEscape: () => void;
  children: ReactNode;
}) {
  return (
    <div
      ref={composerRef}
      className={`cw-composer cw-generation-composer nodrag nopan nowheel${running ? " cw-composer-running" : ""}${optimizing ? " cw-composer-optimizing" : ""}`}
      aria-label={label}
      aria-busy={running || optimizing}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") onEscape();
      }}
    >
      {children}
    </div>
  );
}
