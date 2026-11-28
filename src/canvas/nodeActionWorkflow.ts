import { loadLayerImage } from "./layerRenderer.ts";
import { absolutePosition } from "./geometry.ts";
import { generationDefaults } from "./generationCatalog.ts";
import { assertLayerSize } from "./layerDocument.ts";
import { mediaBlobDataUrl } from "./localMediaRuntime.ts";
import {
  validateNodeActionSource,
  type LinkedMediaResult,
  type ResultSource,
} from "./linkedResults.ts";
import { tNow } from "../i18n/messages.ts";
import { createNode, type CanvasDocument, type CanvasNode } from "./model.ts";

/** Source toolbar action creates a new connected draft; generation later fills that draft. */
/**
 * Whether a clip can be continued from the service's own cached latents: only one that the same model
 * configuration generated. An upload, an edit or another model's clip is extended as a reference video.
 */
export function continuesOwnClip(
  source: Pick<CanvasNode, "data">,
  modelConfigId: string | undefined,
): boolean {
  return (
    Boolean(modelConfigId) &&
    source.data.generationProvenance?.source === "generated" &&
    source.data.settings?.modelConfigId === modelConfigId
  );
}

export function createVideoExtensionDraft(
  document: CanvasDocument,
  source: Readonly<ResultSource>,
): { document: CanvasDocument; ids: string[]; error?: string } {
  const validation = validateNodeActionSource(document, source);
  if (!validation.node) return { document, ids: [], error: validation.error };
  const origin = validation.node;
  if (origin.type !== "video")
    return { document, ids: [], error: tNow("errors.nodeAction.extendNeedsVideo") };
  const inherited =
    origin.data.settings?.mode === "video" ? origin.data.settings : undefined;
  const defaults = generationDefaults("video");
  const prompt = tNow("errors.nodeAction.extendPrompt");
  const settings = {
    ...defaults,
    ...(inherited
      ? {
          model: inherited.model,
          modelConfigId: inherited.modelConfigId,
          aspectRatio: inherited.aspectRatio,
          resolution: inherited.resolution,
          audioEnabled: inherited.audioEnabled,
        }
      : {}),
    videoMode: "reference" as const,
    durationSeconds: 5,
    count: 1,
    prompt,
  };
  const position = absolutePosition(origin, document.nodes);
  const draft = createNode(
    "video",
    {
      x: position.x + origin.width + 80,
      y: position.y,
    },
    {
      title: `${origin.data.title} · ${tNow("errors.nodeAction.extendTitle")}`,
      prompt,
      settings,
    },
  );
  // The published action requests rightward-free placement with an 80 px gap.
  // Group boxes do not obstruct their children; actual child positions do.
  const occupied = document.nodes
    .filter((node) => node.type !== "group")
    .map((node) => ({
      ...absolutePosition(node, document.nodes),
      width: node.width,
      height: node.height,
    }));
  for (let attempt = 0; attempt <= occupied.length; attempt++) {
    const collisions = occupied.filter(
      (rect) =>
        draft.position.x < rect.x + rect.width + 80 &&
        draft.position.x + draft.width + 80 > rect.x &&
        draft.position.y < rect.y + rect.height &&
        draft.position.y + draft.height > rect.y,
    );
    if (!collisions.length) break;
    draft.position.x = Math.max(
      ...collisions.map((rect) => rect.x + rect.width + 80),
    );
  }
  return {
    document: {
      ...document,
      nodes: [...document.nodes, draft],
      edges: [
        ...document.edges,
        {
          id: crypto.randomUUID(),
          source: origin.id,
          target: draft.id,
          intent: "generation_input",
        },
      ],
    },
    ids: [draft.id],
  };
}

function assertGridSize(rows: number, columns: number) {
  if (
    !Number.isInteger(rows) ||
    !Number.isInteger(columns) ||
    rows < 1 ||
    columns < 1 ||
    rows > 7 ||
    columns > 7 ||
    rows * columns < 2
  )
    throw new Error(tNow("errors.nodeAction.gridRange"));
}

/** Integer pixel boundaries cover every pixel exactly once, including uneven edges. */
export function gridSplitCells(
  width: number,
  height: number,
  rows: number,
  columns: number,
) {
  assertGridSize(rows, columns);
  assertLayerSize(width, height);
  if (rows > height || columns > width)
    throw new Error(tNow("errors.nodeAction.gridPixels"));
  return Array.from({ length: rows * columns }, (_, index) => {
    const row = Math.floor(index / columns),
      column = index % columns;
    const x = Math.floor((column * width) / columns),
      y = Math.floor((row * height) / rows);
    return {
      row: row + 1,
      column: column + 1,
      x,
      y,
      width: Math.floor(((column + 1) * width) / columns) - x,
      height: Math.floor(((row + 1) * height) / rows) - y,
    };
  });
}

/** Produces portable PNG tiles; the caller validates its frozen source before committing them. */
export async function gridSplitImage(
  source: Readonly<ResultSource>,
  rows: number,
  columns: number,
  signal: AbortSignal,
): Promise<LinkedMediaResult[]> {
  signal.throwIfAborted();
  assertGridSize(rows, columns);
  if (source.kind !== "image" || !source.src)
    throw new Error(tNow("errors.nodeAction.gridImage"));
  const src = source.src;
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    loadLayerImage(src).then(
      (loaded) => {
        signal.removeEventListener("abort", cancel);
        if (signal.aborted) {
          loaded.onload = loaded.onerror = null;
          loaded.removeAttribute("src");
          reject(signal.reason);
        } else resolve(loaded);
      },
      (error) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      },
    );
  });
  let canvas: HTMLCanvasElement | undefined;
  try {
    signal.throwIfAborted();
    const cells = gridSplitCells(
      image.naturalWidth,
      image.naturalHeight,
      rows,
      columns,
    );
    canvas = window.document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error(tNow("errors.nodeAction.gridCanvas"));
    const outputs: LinkedMediaResult[] = [];
    for (const cell of cells) {
      signal.throwIfAborted();
      canvas.width = cell.width;
      canvas.height = cell.height;
      context.drawImage(
        image,
        cell.x,
        cell.y,
        cell.width,
        cell.height,
        0,
        0,
        cell.width,
        cell.height,
      );
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas!.toBlob(resolve, "image/png"),
      );
      signal.throwIfAborted();
      if (!blob) throw new Error(tNow("errors.nodeAction.gridEncode"));
      outputs.push({
        kind: "image",
        src: await mediaBlobDataUrl(blob, signal),
        mimeType: "image/png",
        title: tNow("errors.nodeAction.gridTitle", {
          row: cell.row,
          column: cell.column,
        }),
        media: { width: cell.width, height: cell.height },
      });
    }
    signal.throwIfAborted();
    return outputs;
  } finally {
    image.onload = image.onerror = null;
    image.removeAttribute("src");
    if (canvas) canvas.width = canvas.height = 1;
  }
}
