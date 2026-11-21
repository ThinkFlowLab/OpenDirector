import type { CanvasNode } from "./model.ts";
import { canSourceReference } from "./connectionPolicy.ts";
import { assetDisplayName } from "./assetNames.ts";
import { tNow } from "../i18n/messages.ts";
import type { MessageKey } from "../i18n/types.ts";

export const REFERENCE_CATEGORIES = [
  { id: "all", label: "errors.stats.all" },
  { id: "image", label: "errors.stats.image" },
  { id: "video", label: "errors.stats.video" },
  { id: "audio", label: "errors.stats.audio" },
  { id: "text", label: "errors.stats.text" },
  { id: "subject", label: "errors.stats.subject" },
] as const satisfies readonly { id: string; label: MessageKey }[];
export type ReferenceCategory = (typeof REFERENCE_CATEGORIES)[number]["id"];
export type ReferenceKind = Exclude<ReferenceCategory, "all">;
export interface MentionOption {
  id: string;
  kind: ReferenceKind;
  title: string;
  detail: string;
  thumbnail?: string;
  disabledReason?: string | null;
}
export interface MentionRange {
  start: number;
  end: number;
}

/** A bare @ at the caret opens references, whatever character precedes it. */
export function mentionRange(
  value: string,
  start: number,
  end = start,
): MentionRange | null {
  if (start !== end || start < 1 || start > value.length) return null;
  // The caret is right after the @, so typing the next character closes it
  // again. Requiring a separator first would make "素材@" and "asd@" fail.
  return value[start - 1] === "@" ? { start: start - 1, end } : null;
}

export function slashRange(value: string, start: number, end = start) {
  if (start !== end || start < 1 || start > value.length) return null;
  const match = /(?:^|[\s\ufffc])\/([^\s/\ufffc]*)$/u.exec(value.slice(0, start));
  const suffix = /^[^\s/\ufffc]*/u.exec(value.slice(start))![0];
  return match ? {start: start - match[1]!.length - 1, end: start + suffix.length, query: match[1]!} : null;
}

export function insertMention(
  value: string,
  range: MentionRange,
  title: string,
) {
  const start = Math.max(0, Math.min(value.length, range.start));
  const end = Math.max(start, Math.min(value.length, range.end));
  const inserted = `@${title} `;
  return {
    value: value.slice(0, start) + inserted + value.slice(end),
    caret: start + inserted.length,
    inserted,
    start,
    end,
  };
}

export function mentionCategories(
  options: readonly MentionOption[],
): ReferenceCategory[] {
  return REFERENCE_CATEGORIES.filter(
    (category) =>
      category.id === "all" ||
      options.some(
        (option) => option.kind === category.id && !option.disabledReason,
      ),
  ).map((category) => category.id);
}

export function nodeMentionOptions(
  nodes: readonly CanvasNode[],
  issue: (node: CanvasNode) => string | null = () => null,
  origin = tNow("errors.stats.upstream"),
): MentionOption[] {
  return nodes.flatMap((node) => {
    const category = REFERENCE_CATEGORIES.find((item) => item.id === node.type);
    if (!category || !canSourceReference(node)) return [];
    const image = node.type === "subject" ? node.data.subject?.main : undefined;
    return [
      {
        id: node.id,
        kind: node.type as ReferenceKind,
        title: assetDisplayName(node.data.title),
        detail: `${tNow(category.label)} · ${origin}`,
        thumbnail:
          node.type === "image"
            ? node.data.src
            : image?.kind === "image"
              ? image.src
              : undefined,
        disabledReason: issue(node),
      },
    ];
  });
}

const CARET_NAVIGATION_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/** Keys that move the caret without inserting text. */
export function isCaretNavigationKey(key: string, composing = false) {
  return !composing && CARET_NAVIGATION_KEYS.has(key);
}

/** After Escape dismisses a mention, keep the picker closed until the caret
 * has left that mention. A later return to the same mention reopens it.
 * `leftSinceDismiss` is set when a navigation key is pressed, so a coalesced
 * selectionchange that never reports the outside caret still reopens. */
export function mentionDismissAfterEvent(
  dismissedStart: number | null,
  leftSinceDismiss: boolean,
  mentionStart: number | null,
): { dismissedStart: number | null; leftSinceDismiss: boolean; open: boolean } {
  if (mentionStart === null) {
    return { dismissedStart: null, leftSinceDismiss: false, open: false };
  }
  if (dismissedStart !== mentionStart || leftSinceDismiss) {
    return { dismissedStart: null, leftSinceDismiss: false, open: true };
  }
  return { dismissedStart, leftSinceDismiss: false, open: false };
}
