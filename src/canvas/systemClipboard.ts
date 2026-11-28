import { tNow } from "../i18n/messages.ts";
import type { ClipboardMedia } from "./clipboardMedia.ts";
import type { CanvasFragment } from "./operations.ts";

/** What a canvas copy offers other apps besides the in-app fragment. */
export type SystemClipboardPayload =
  | { kind: "text"; text: string }
  | { kind: "image"; blob: Promise<Blob> };

/**
 * Only a single text or image node has an unambiguous external form; other
 * selections stay in-app so the system clipboard is not filled with a guess.
 */
export function systemClipboardPayload(
  fragment: CanvasFragment,
  media: ClipboardMedia,
): SystemClipboardPayload | null {
  if (fragment.nodes.length !== 1) return null;
  const node = fragment.nodes[0]!;
  if (node.type === "text")
    return node.data.text ? { kind: "text", text: node.data.text } : null;
  if (node.type !== "image" || !node.data.src) return null;
  if (node.data.assetState === "missing") {
    const missing = Promise.reject<Blob>(
      new Error(tNow("errors.files.clipboardRead")),
    );
    missing.catch(() => {});
    return { kind: "image", blob: missing };
  }
  const blob = media.blobs.get(node.data.src);
  return blob ? { kind: "image", blob } : null;
}

/** Browsers only accept PNG as clipboard image data, so other formats are re-encoded. */
export async function pngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(tNow("errors.files.clipboardRead"));
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (png) =>
          png ? resolve(png) : reject(new Error(tNow("errors.files.clipboardRead"))),
        "image/png",
      ),
    );
  } finally {
    bitmap.close();
  }
}

export interface SystemClipboardDeps {
  clipboard?: Pick<Clipboard, "write" | "writeText">;
  createItem?: (items: Record<string, Promise<Blob>>) => ClipboardItem;
  toPng?: (blob: Blob) => Promise<Blob>;
}

/**
 * Writes the payload to the system clipboard. The write starts synchronously,
 * inside the shortcut's user activation, and resolves only once the platform
 * accepted it; failures carry a localized reason.
 */
export async function writeSystemClipboard(
  payload: SystemClipboardPayload,
  {
    clipboard = globalThis.navigator?.clipboard,
    createItem = globalThis.ClipboardItem
      ? (items) => new ClipboardItem(items)
      : undefined,
    toPng = pngBlob,
  }: SystemClipboardDeps = {},
): Promise<void> {
  if (!clipboard) throw new Error(tNow("errors.files.clipboardUnavailable"));
  if (payload.kind === "text") {
    try {
      await clipboard.writeText(payload.text);
    } catch {
      throw new Error(tNow("errors.files.clipboardWrite"));
    }
    return;
  }
  if (!createItem) throw new Error(tNow("errors.files.clipboardUnavailable"));
  let readFailed = false;
  const png = payload.blob.then(toPng).catch(() => {
    readFailed = true;
    throw new Error(tNow("errors.files.clipboardRead"));
  });
  try {
    await clipboard.write([createItem({ "image/png": png })]);
  } catch {
    // The write may reject before the image settles; report whichever failed.
    await png.catch(() => {});
    throw new Error(
      tNow(readFailed ? "errors.files.clipboardRead" : "errors.files.clipboardWrite"),
    );
  }
}
