import {
  normalizeContent,
  type ReferenceContent,
} from "./chatReferenceContent.ts";

// An atomic reference occupies one editing position, regardless of its label.
export function units(node: Node): number {
  if (node instanceof HTMLElement) {
    if (node.dataset.reference || node.dataset.skill || node.dataset.preset) return 1;
  }
  if (node.nodeType === Node.TEXT_NODE)
    return (node.textContent ?? "").replaceAll("\u200b", "").length;
  if (node.nodeName === "BR") return 1;
  return [...node.childNodes].reduce((sum, item) => sum + units(item), 0);
}
export type Caret = { start: number; end: number };
export function selection(root: HTMLElement): Caret | null {
  const range = window.getSelection()?.rangeCount
    ? window.getSelection()!.getRangeAt(0)
    : null;
  if (
    !range ||
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  )
    return null;
  function offset(container: Node, index: number): number {
    // Browsers can create DIV/P line wrappers while typing or pasting. Use the
    // same projection as input(), including their implicit newlines and atomic
    // references, instead of counting only text descendants.
    const prefix = document.createRange();
    prefix.selectNodeContents(root);
    prefix.setEnd(container, index);
    const fragment = document.createElement("div");
    fragment.append(prefix.cloneContents());
    return editingText(readDOM(fragment)).length;
  }
  return {
    start: offset(range.startContainer, range.startOffset),
    end: offset(range.endContainer, range.endOffset),
  };
}
export function select(root: HTMLElement, caret: Caret) {
  function point(position: number): [Node, number] {
    let remaining = Math.max(0, position);
    const walk = (parent: Node): [Node, number] | null => {
      for (const [index, node] of [...parent.childNodes].entries()) {
        const size = units(node);
        if (remaining > size) {
          remaining -= size;
          continue;
        }
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent ?? "";
          if (!text.includes("\u200b")) return [node, remaining];
          // Zero-width anchors have DOM offsets but take no editing positions.
          let offset = 0;
          while (remaining > 0 && offset < text.length) {
            if (text[offset] !== "\u200b") remaining--;
            offset++;
          }
          while (text[offset] === "\u200b") offset++;
          return [node, offset];
        }
        if (node instanceof HTMLElement && node.dataset.preset && remaining === size) {
          // Use the editable anchor after the chip instead of its DOM boundary.
          remaining = 0;
          continue;
        }
        if (
          (node instanceof HTMLElement && (node.dataset.reference || node.dataset.skill || node.dataset.preset)) ||
          node.nodeName === "BR"
        )
          return [parent, index + (remaining ? 1 : 0)];
        const found = walk(node);
        if (found) return found;
      }
      return null;
    };
    return walk(root) ?? [root, root.childNodes.length];
  }
  const range = document.createRange();
  const [start, a] = point(caret.start),
    [end, b] = point(caret.end);
  range.setStart(start, a);
  range.setEnd(end, b);
  const value = window.getSelection();
  value?.removeAllRanges();
  value?.addRange(range);
}
export function readDOM(root: HTMLElement): ReferenceContent {
  if (root.childNodes.length === 1 && root.firstChild?.nodeName === "BR") return [];
  const parts: ReferenceContent = [];
  function read(node: Node) {
    if (node instanceof HTMLElement && node.dataset.preset) {
      parts.push({
        type: "skill",
        name: node.dataset.label ?? "",
        preset: node.dataset.preset,
        ...(node.dataset.faceEmphasis ? { faceEmphasis: true } : {}),
      });
    } else if (node instanceof HTMLElement && node.dataset.skill) {
      parts.push({type: "skill", name: node.dataset.skill});
    } else if (node instanceof HTMLElement && node.dataset.reference) {
      try {
        parts.push(JSON.parse(node.dataset.reference));
      } catch {
        /* Only our own atomic nodes are accepted. */
      }
    } else if (node.nodeType === Node.TEXT_NODE)
      parts.push({ type: "text", text: node.textContent ?? "" });
    else if (node.nodeName === "BR") parts.push({ type: "text", text: "\n" });
    else {
      if (node !== root && /^(DIV|P)$/.test(node.nodeName) && parts.length)
        parts.push({ type: "text", text: "\n" });
      node.childNodes.forEach(read);
    }
  }
  root.childNodes.forEach(read);
  return normalizeContent(parts);
}
export function editContent(
  content: ReferenceContent,
  caret: Caret,
  inserted: ReferenceContent,
): ReferenceContent {
  const before: ReferenceContent = [],
    after: ReferenceContent = [];
  let offset = 0;
  for (const part of content) {
    const size = part.type === "text" ? part.text.length : 1;
    if (offset < caret.start)
      before.push(
        part.type === "text"
          ? { type: "text", text: part.text.slice(0, caret.start - offset) }
          : part,
      );
    if (offset + size > caret.end)
      after.push(
        part.type === "text"
          ? {
              type: "text",
              text: part.text.slice(Math.max(0, caret.end - offset)),
            }
          : part,
      );
    offset += size;
  }
  return normalizeContent([...before, ...inserted, ...after]);
}
export function editingText(content: ReferenceContent) {
  return content
    .map((part) => (part.type === "text" ? part.text : "\ufffc"))
    .join("");
}
