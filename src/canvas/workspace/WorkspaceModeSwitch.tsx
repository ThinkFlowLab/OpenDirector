import { useT } from "../../i18n/I18nProvider";
import type { WorkspaceMode } from "../workspaceMode";

export function WorkspaceModeSwitch({
  mode,
  onChange,
}: {
  mode: WorkspaceMode;
  onChange: (mode: WorkspaceMode) => void;
}) {
  const t = useT();
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
          onClick={() => onChange(value)}
        >
          {t(`workspaceModes.short.${value}`)}
        </button>
      ))}
    </div>
  );
}
