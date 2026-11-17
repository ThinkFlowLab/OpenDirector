import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";
import type { ChatSource } from "../backend/chat.ts";
import type { Translate } from "../i18n/I18nProvider.tsx";
import { defaultTranslate } from "./assistantTranslate.ts";

// Complete envelopes first; partial ASCII protocol tails stop before prose.
const MARKER = /\uE200[^\uE200\uE201\r\n]*\uE201|\uE200[A-Za-z0-9_:\-\uE202]*|\uE202[A-Za-z0-9_:\-]*|\uE201/g;
const CITATION = /^\uE200cite((?:\uE202turn\d+(?:search|view|news)\d+)+)\uE201$/;
const REF = /turn\d+(?:search|view|news)\d+/g;

function sourceUrl(source: ChatSource): string | null {
  try {
    const url = new URL(source.url);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password &&
      !/[\u0000-\u0020\u007f]/.test(source.url)
      ? url.href.replace(/[<>]/g, (char) => encodeURIComponent(char)) : null;
  } catch { return null; }
}

/** Visit prose only. Source offsets preserve every other byte of Markdown. */
function markers(text: string) {
  const found: { start: number; end: number; raw: string }[] = [];
  if (!/[\uE200-\uE202]/.test(text)) return found;
  const visit = (node: Nodes) => {
    if (node.type === "text") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      for (const match of text.slice(start, end).matchAll(MARKER)) {
        found.push({ start: start + match.index, end: start + match.index + match[0].length, raw: match[0] });
      }
    } else if ("children" in node && node.type !== "link" && node.type !== "linkReference") {
      node.children.forEach(visit);
    }
  };
  visit(fromMarkdown(text));
  return found;
}

/** Format after raw tool offsets have been split; copy uses the same formatter. */
export function assistantCitationFormatter(
  text: string,
  sources: ChatSource[] = [],
  streaming = false,
  t: Translate = defaultTranslate,
) {
  const available = new Map(sources.map((source) => [source.id, { source, url: sourceUrl(source) }]));
  const numbers = new Map<string, number>();
  for (const marker of markers(text)) {
    if (!CITATION.test(marker.raw)) continue;
    for (const id of marker.raw.match(REF) ?? []) {
      if (available.get(id)?.url && !numbers.has(id)) numbers.set(id, numbers.size + 1);
    }
  }
  return (part: string) => {
    const edits = markers(part);
    let result = "", offset = 0;
    for (const edit of edits) {
      result += part.slice(offset, edit.start);
      if (CITATION.test(edit.raw)) {
        result += [...new Set(edit.raw.match(REF))].map((id) => {
          const entry = available.get(id);
          const number = numbers.get(id);
          if (!entry?.url || !number) return `[${t("assistant.reply.sourceUnavailable")}]`;
          const title = entry.source.title.replace(/[\r\n\u0000-\u001f]/g, " ").replace(/[\\"]/g, "\\$&");
          return `[\\[${number}\\]](<${entry.url}> "${title}")`;
        }).join(" ");
      } else if (!(streaming && edit.end === part.length && !edit.raw.endsWith("\uE201"))) {
        result += `[${t("assistant.reply.sourceUnavailable")}]`;
      }
      offset = edit.end;
    }
    return result + part.slice(offset);
  };
}
