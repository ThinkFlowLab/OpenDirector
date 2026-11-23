import { fromMarkdown } from "mdast-util-from-markdown";
import type { List } from "mdast";

const marker = "[opendirector-replies]: #";

function suggestionOptions(list: List) {
  if (list.children.length < 3 || list.children.length > 5) return null;
  const options: string[] = [];
  const seen = new Set<string>();
  for (const item of list.children) {
    const paragraph = item.children[0];
    if (
      item.children.length !== 1 ||
      paragraph?.type !== "paragraph" ||
      paragraph.children.length !== 1 ||
      paragraph.position?.start.line !== paragraph.position?.end.line
    ) return null;
    const node = paragraph.children[0];
    if (node.type !== "text") return null;
    const option = node.value.trim();
    if (!option || /^\[[ xX]\](?:\s|$)/.test(option) || /[\uE200-\uE202]/.test(option)) return null;
    if (Array.from(option).length > 80) continue;
    const normalized = option.replace(/\s+/g, " ");
    if (seen.has(normalized)) return null;
    seen.add(normalized);
    options.push(option);
  }
  return options;
}

export function parseSuggestedReplies(text: string) {
  if (!text.trimEnd().endsWith(marker)) return null;
  const { children } = fromMarkdown(text);
  const definition = children.at(-1);
  const markerStart = definition?.position?.start.offset;
  if (
    definition?.type !== "definition" ||
    definition.identifier !== "opendirector-replies" ||
    definition.url !== "#" ||
    definition.title != null ||
    markerStart === undefined ||
    text.slice(markerStart).trimEnd() !== marker
  ) return null;

  // The marker is recognized even when the preceding list cannot become buttons.
  const list = children.at(-2);
  const start = list?.position?.start.offset;
  const options = list?.type === "list" ? suggestionOptions(list) : null;
  return {
    textWithoutMarker: text.slice(0, markerStart).trimEnd(),
    suggestions: options && start !== undefined
      ? { prefix: text.slice(0, start).trimEnd(), options }
      : null,
  };
}

/** A marker can arrive in multiple deltas, including after tool use. */
export function hidePartialSuggestionMarker(text: string): string {
  const lineStart = text.lastIndexOf("\n") + 1;
  const tail = text.slice(lineStart).trimEnd();
  if (!tail || !marker.startsWith(tail)) return text;
  const before = text.slice(0, lineStart);
  return parseSuggestedReplies(before + marker)?.suggestions ? before.trimEnd() : text;
}
