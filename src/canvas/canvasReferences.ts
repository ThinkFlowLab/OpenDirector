import type { Element, Root } from "hast";

/**
 * Rewrite persisted project-reference anchors into a private, sanitizable URL
 * before the Markdown sanitizer runs, then restore the original target and
 * tag after it. The placeholder is https so a sanitizer that keeps ordinary
 * links cannot drop the reference; the reverse pass runs last so no sanitizer
 * sees the custom `canvas-reference` element.
 */
function canvasReferencePlugin({ targets, prepare }: { targets: string[]; prepare: boolean }) {
  const placeholders = new Map(targets.map((target, index) =>
    [target, `https://opendirector.invalid/canvas-reference/${index}`]));
  const originals = new Map(Array.from(placeholders, ([target, placeholder]) => [placeholder, target]));
  return (tree: Root) => {
    const visit = (parent: Root | Element) => {
      for (const child of parent.children) {
        if (child.type !== "element") continue;
        if (child.tagName === "a") {
          const href = String(child.properties.href);
          if (prepare && placeholders.has(href)) {
            child.properties.href = placeholders.get(href);
          } else if (!prepare && originals.has(href)) {
            child.tagName = "canvas-reference";
            child.properties.href = originals.get(href);
          }
        }
        visit(child);
      }
    };
    visit(tree);
  };
}

export function prepareCanvasReferences(options: { targets: string[] }) {
  return canvasReferencePlugin({ ...options, prepare: true });
}

export function renderCanvasReferences(options: { targets: string[] }) {
  return canvasReferencePlugin({ ...options, prepare: false });
}
