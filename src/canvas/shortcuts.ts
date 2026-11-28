import type { MessageKey } from "../i18n/types";

/**
 * One registry for every keyboard shortcut the workspace handles.
 *
 * Combos are written once, in a modifier+key form: `mod` is ⌘ on macOS and
 * Ctrl elsewhere. Tooltips, the help dialog and the key handlers all read from
 * here, so a shortcut cannot be documented in one place and handled in another.
 */
export const SHORTCUT_COMBOS = {
  "new-project": "mod+n",
  "switch-project": "mod+k",
  settings: "mod+comma",
  assistant: "mod+j",
  help: "?",
  upload: "mod+o",
  undo: "mod+z",
  redo: "mod+shift+z",
  "select-all": "mod+a",
  copy: "mod+c",
  cut: "mod+x",
  paste: "mod+v",
  ungroup: "mod+shift+g",
  group: "mod+g",
  duplicate: "mod+d",
  fit: "shift+1",
  "fit-selection": "shift+2",
  delete: "delete",
  "add-text": "t",
  "hand-tool": "h",
  "select-tool": "v",
} as const;

export type ShortcutId = keyof typeof SHORTCUT_COMBOS;

/** Action names reused from the toolbar so the hint never invents a new label. */
export const SHORTCUT_LABELS: Partial<Record<ShortcutId, MessageKey>> = {
  "new-project": "canvas.project.create",
  "switch-project": "canvas.project.switch",
  settings: "canvas.workspace.toolbar.settings",
  assistant: "canvas.workspace.toolbar.chat",
  help: "canvas.workspace.toolbar.help",
};

const KEY_NAMES: Record<string, string> = {
  comma: ",",
  slash: "/",
  space: "Space",
  delete: "Delete",
  enter: "Enter",
  escape: "Esc",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
};

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac/i.test(navigator.platform ?? "");
}

function parts(combo: string) {
  const tokens = combo.toLowerCase().split("+");
  return { key: tokens.at(-1) ?? "", mods: tokens.slice(0, -1) };
}

function keyName(key: string, mac: boolean) {
  if (key === "delete") return mac ? "⌫" : "Delete";
  return KEY_NAMES[key] ?? key.toUpperCase();
}

/**
 * Display form for tooltips and the help dialog: `⌘N`, `⇧⌘Z`, `Ctrl+Shift+Z`.
 * macOS uses the menu-bar symbols; other platforms spell the modifiers out.
 */
export function shortcutKeys(id: ShortcutId, mac = isMacPlatform()): string {
  const { key, mods } = parts(SHORTCUT_COMBOS[id]);
  if (!mods.length && key === "?") return "?";
  if (mac) {
    const symbols = mods
      .map((mod) =>
        mod === "mod" ? "⌘" : mod === "shift" ? "⇧" : mod === "alt" ? "⌥" : "⌃",
      )
      .sort((a, b) => "⌃⌥⇧⌘".indexOf(a) - "⌃⌥⇧⌘".indexOf(b))
      .join("");
    return `${symbols}${keyName(key, mac)}`;
  }
  const names = mods
    .map((mod) => (mod === "mod" ? "Ctrl" : mod === "shift" ? "Shift" : "Alt"))
    .sort((a, b) => ["Ctrl", "Alt", "Shift"].indexOf(a) - ["Ctrl", "Alt", "Shift"].indexOf(b));
  return [...names, keyName(key, mac)].join("+");
}

/**
 * `aria-keyshortcuts` spelling: "Control+N Meta+N" so both platforms match.
 * Screen readers announce these, while tooltips show the local one.
 */
export function shortcutAriaKeys(id: ShortcutId): string {
  const { key, mods } = parts(SHORTCUT_COMBOS[id]);
  const name = (mod: string) =>
    mod === "mod" ? "Control" : mod === "shift" ? "Shift" : mod === "alt" ? "Alt" : "Ctrl";
  const control = [...mods.map(name), keyName(key, false)].join("+");
  if (!mods.includes("mod")) return control;
  const meta = [
    ...mods.map((mod) => (mod === "mod" ? "Meta" : name(mod))),
    keyName(key, false),
  ].join("+");
  return `${control} ${meta}`;
}

// Combos spell the key; native events report what the key prints.
const EVENT_KEYS: Record<string, string> = { comma: ",", slash: "/" };

/** True when a native keyboard event matches the registered combo. */
export function matchesShortcut(
  event: {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  },
  id: ShortcutId,
): boolean {
  const { key, mods } = parts(SHORTCUT_COMBOS[id]);
  const mod = Boolean(event.ctrlKey || event.metaKey);
  if (mods.includes("mod") !== mod) return false;
  if (mods.includes("shift") !== Boolean(event.shiftKey)) return false;
  if (mods.includes("alt") !== Boolean(event.altKey)) return false;
  if (mods.includes("ctrl") && !event.ctrlKey) return false;
  return event.key.toLowerCase() === (EVENT_KEYS[key] ?? key);
}

/**
 * Rows for the help dialog. Canvas gestures stay written as prose; the key
 * combinations come from the registry so they cannot drift from the handlers.
 */
export function helpShortcutRows(
  t: (key: MessageKey) => string,
  mac = isMacPlatform(),
): Array<[string, string]> {
  const rows: Array<[ShortcutId, MessageKey]> = [
    ["new-project", "canvas.project.create"],
    ["switch-project", "canvas.project.switch"],
    ["settings", "canvas.workspace.toolbar.settings"],
    ["assistant", "canvas.workspace.toolbar.chat"],
    ["upload", "canvas.rail.upload"],
    ["undo", "canvas.workspace.toolbar.undo"],
    ["redo", "canvas.workspace.toolbar.redo"],
    ["select-all", "canvas.workspace.help.selectAll"],
    ["fit", "canvas.workspace.help.fit"],
    ["delete", "canvas.workspace.help.delete"],
    ["add-text", "canvas.kind.text"],
    ["help", "canvas.workspace.toolbar.help"],
  ];
  return rows.map(([id, key]) => [t(key), shortcutKeys(id, mac)]);
}
