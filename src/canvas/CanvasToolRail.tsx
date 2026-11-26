import { useState, type KeyboardEvent } from "react";
import { useT } from "../i18n/I18nProvider";
import { CanvasIcon } from "./CanvasIcon";

export function CanvasToolRail({
  menuOpen,
  libraryOpen,
  onToggleMenu,
  onAssets,
  onUpload,
}: {
  menuOpen: boolean;
  libraryOpen: boolean;
  onToggleMenu: (trigger: HTMLButtonElement) => void;
  onAssets: () => void;
  onUpload: () => void;
}) {
  const t = useT();
  const [tabStop, setTabStop] = useState(0);
  const navigate = (event: KeyboardEvent<HTMLElement>) => {
    const buttons = Array.from(event.currentTarget.querySelectorAll("button"));
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    let next: number;
    switch (event.key) {
      case "Home":
        next = 0;
        break;
      case "End":
        next = buttons.length - 1;
        break;
      case "ArrowDown":
        next = (index + 1) % buttons.length;
        break;
      case "ArrowUp":
        next = (index - 1 + buttons.length) % buttons.length;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    buttons[next].focus({ preventScroll: true });
  };
  return (
    <div
      className="cw-rail"
      role="toolbar"
      aria-label={t("canvas.rail.tools")}
      aria-orientation="vertical"
      onKeyDown={navigate}
    >
      <button
        type="button"
        className="cw-rail-button cw-rail-add"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        tabIndex={tabStop === 0 ? 0 : -1}
        onFocus={() => setTabStop(0)}
        onClick={(event) => onToggleMenu(event.currentTarget)}
      >
        <CanvasIcon name="plus" size={20} />
        <span className="cw-rail-label">{t("canvas.rail.addNode")}</span>
      </button>
      <span className="cw-divider" aria-hidden="true" />
      <button
        type="button"
        className="cw-rail-button"
        aria-haspopup="dialog"
        aria-expanded={libraryOpen}
        tabIndex={tabStop === 1 ? 0 : -1}
        onFocus={() => setTabStop(1)}
        onClick={onAssets}
      >
        <CanvasIcon name="rail-folder" size={18} />
        <span className="cw-rail-label">{t("canvas.rail.assets")}</span>
      </button>
      <button
        type="button"
        className="cw-rail-button"
        aria-label={t("canvas.rail.uploadLocal")}
        aria-keyshortcuts={
          navigator.platform.includes("Mac") ? "Meta+O" : "Control+O"
        }
        tabIndex={tabStop === 2 ? 0 : -1}
        onFocus={() => setTabStop(2)}
        onClick={onUpload}
      >
        <CanvasIcon name="rail-upload" size={18} />
        <span className="cw-rail-label">{t("canvas.rail.upload")}</span>
      </button>
    </div>
  );
}
