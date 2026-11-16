import type { Element, Root } from "hast";

const WORD_CHARACTER = /\w/;

/** Turn plain @title mentions into the same clickable canvas-reference nodes. */
export function renderCanvasMentions({ targets }: { targets: string[] }): (tree: Root) => void {
  // Longer names first so a prefix mention never splits a longer one.
  const mentions = targets.filter((target) => target.startsWith("@"))
    .sort((a, b) => b.length - a.length);
  return (tree: Root) => {
    if (!mentions.length) return;
    const split = (value: string): Element["children"] => {
      const parts: Element["children"] = [];
      let rest = value;
      while (rest.length) {
        let index = -1;
        let mention = "";
        for (const target of mentions) {
          let found = -1;
          let from = 0;
          while ((found = rest.indexOf(target, from)) !== -1) {
            // Mirror the backend's (?<!\w) word boundary: a mention glued to a
            // word character (foo@Title) is prose, not a canvas reference.
            if (found === 0 || !WORD_CHARACTER.test(rest[found - 1])) {
              break;
            }
            from = found + 1;
          }
          if (found !== -1 && (index === -1 || found < index)) {
            index = found;
            mention = target;
          }
        }
        if (index === -1) {
          parts.push({ type: "text", value: rest });
          break;
        }
        if (index > 0) parts.push({ type: "text", value: rest.slice(0, index) });
        parts.push({
          type: "element",
          tagName: "canvas-reference",
          properties: { href: mention },
          children: [{ type: "text", value: mention }],
        });
        rest = rest.slice(index + mention.length);
      }
      return parts;
    };
    const visit = (parent: Root | Element) => {
      const next: Element["children"] = [];
      for (const child of parent.children) {
        if (child.type === "element") {
          if (child.tagName !== "code" && child.tagName !== "pre" &&
              child.tagName !== "a" && child.tagName !== "canvas-reference") {
            visit(child);
          }
          next.push(child);
        } else if (child.type === "text") {
          next.push(...split(child.value));
        } else {
          next.push(child as Element["children"][number]);
        }
      }
      parent.children = next;
    };
    visit(tree);
  };
}
