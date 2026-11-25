import {
  assertLayerSize,
  type ImageLayer,
  type LayerDocument,
  type MaskStroke,
} from "./layerDocument.ts";
import { parseAssetSource } from "../backend/assetSource.ts";
import { resolveMediaSource } from "../backend/creationClient.ts";
import { tNow } from "../i18n/messages.ts";

export function localLayerSource(src: string): boolean {
  if (/^data:image\//i.test(src)) return true;
  try {
    const url = new URL(src, window.location.href);
    return (
      ["blob:", "http:", "https:"].includes(url.protocol) &&
      url.origin === window.location.origin
    );
  } catch {
    return false;
  }
}
export async function loadLayerImage(source: string): Promise<HTMLImageElement> {
  const src = parseAssetSource(source) ? await resolveMediaSource(source) : source;
  return new Promise((resolve, reject) => {
    if (!localLayerSource(src)) {
      reject(new Error(tNow("errors.render.layerLocalOnly")));
      return;
    }
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      try {
        assertLayerSize(image.naturalWidth, image.naturalHeight);
        resolve(image);
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = () =>
      reject(new Error(tNow("errors.render.layerDecode")));
    image.src = src;
  });
}
export class LayerImageCache {
  private sources = new Map<string, Promise<HTMLImageElement>>();
  async images(
    document: LayerDocument,
  ): Promise<Map<string, HTMLImageElement>> {
    const sources = [
      ...new Set(
        document.layers.flatMap((layer) =>
          layer.content.kind === "image" ? [layer.content.src] : [],
        ),
      ),
    ];
    for (const source of this.sources.keys())
      if (!sources.includes(source)) this.sources.delete(source);
    return new Map(
      await Promise.all(
        sources.map(async (src) => {
          let pending = this.sources.get(src);
          if (!pending) {
            pending = loadLayerImage(src);
            this.sources.set(src, pending);
          }
          try {
            return [src, await pending] as const;
          } catch (error) {
            this.sources.delete(src);
            throw error;
          }
        }),
      ),
    );
  }
}
function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const result = canvas.getContext("2d");
  if (!result) throw new Error(tNow("errors.render.layerCanvas"));
  return result;
}
function drawStroke(ctx: CanvasRenderingContext2D, stroke: MaskStroke): void {
  ctx.globalCompositeOperation =
    stroke.mode === "erase" ? "destination-out" : "source-over";
  ctx.strokeStyle = "#ffffff";
  ctx.fillStyle = "#ffffff";
  ctx.lineWidth = stroke.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const first = stroke.points[0];
  if (!first) return;
  if (stroke.points.length === 1) {
    ctx.beginPath();
    ctx.arc(first.x, first.y, stroke.size / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (const point of stroke.points.slice(1)) ctx.lineTo(point.x, point.y);
    ctx.stroke();
  }
}
function paintLayer(
  scratch: HTMLCanvasElement,
  mask: HTMLCanvasElement,
  layer: ImageLayer,
  images: Map<string, HTMLImageElement>,
  rasterScale: number,
  draft?: MaskStroke,
): void {
  const content = layer.content;
  scratch.width = Math.max(1, Math.round(content.width * rasterScale));
  scratch.height = Math.max(1, Math.round(content.height * rasterScale));
  const ctx = context(scratch);
  ctx.scale(scratch.width / content.width, scratch.height / content.height);
  if (content.kind === "image") {
    const image = images.get(content.src);
    if (!image)
      throw new Error(tNow("errors.render.layerNotLoaded", { name: layer.name }));
    ctx.drawImage(image, 0, 0, content.width, content.height);
  } else if (content.kind === "rectangle") {
    ctx.fillStyle = content.color;
    ctx.fillRect(0, 0, content.width, content.height);
  } else {
    ctx.font = `600 ${content.fontSize}px system-ui, sans-serif`;
    ctx.fillStyle = content.color;
    ctx.textBaseline = "top";
    content.text
      .split("\n")
      .forEach((line, index) =>
        ctx.fillText(line, 0, index * content.fontSize * 1.3),
      );
  }
  if (layer.mask.length || draft) {
    mask.width = scratch.width;
    mask.height = scratch.height;
    const maskCtx = context(mask);
    maskCtx.fillStyle = "#ffffff";
    maskCtx.fillRect(0, 0, mask.width, mask.height);
    maskCtx.scale(mask.width / content.width, mask.height / content.height);
    layer.mask.forEach((stroke) => drawStroke(maskCtx, stroke));
    if (draft) drawStroke(maskCtx, draft);
    ctx.globalCompositeOperation = "destination-in";
    ctx.resetTransform();
    ctx.drawImage(mask, 0, 0);
  }
}
export interface LayerRenderOptions {
  maxSide?: number;
  draft?: { layerId: string; stroke: MaskStroke };
}
/** Export and preview share painter order, mask compositing, opacity and transforms. */
export function renderLayers(
  canvas: HTMLCanvasElement,
  document: LayerDocument,
  images: Map<string, HTMLImageElement>,
  options: LayerRenderOptions = {},
): void {
  assertLayerSize(document.width, document.height);
  const scale = Math.min(
    1,
    (options.maxSide ?? Infinity) / Math.max(document.width, document.height),
  );
  canvas.width = Math.max(1, Math.round(document.width * scale));
  canvas.height = Math.max(1, Math.round(document.height * scale));
  const ctx = context(canvas);
  ctx.scale(canvas.width / document.width, canvas.height / document.height);
  if (document.background !== "transparent") {
    ctx.fillStyle = document.background;
    ctx.fillRect(0, 0, document.width, document.height);
  }
  const scratch = window.document.createElement("canvas"),
    mask = window.document.createElement("canvas");
  for (const layer of document.layers) {
    if (!layer.visible || !layer.opacity) continue;
    const rasterScale = Math.min(
      1,
      scale *
        Math.max(
          layer.width / layer.content.width,
          layer.height / layer.content.height,
        ),
    );
    paintLayer(
      scratch,
      mask,
      layer,
      images,
      rasterScale,
      options.draft?.layerId === layer.id ? options.draft.stroke : undefined,
    );
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    ctx.translate(layer.x + layer.width / 2, layer.y + layer.height / 2);
    ctx.rotate((layer.rotation * Math.PI) / 180);
    ctx.scale(
      ((layer.flipX ? -1 : 1) * layer.width) / layer.content.width,
      ((layer.flipY ? -1 : 1) * layer.height) / layer.content.height,
    );
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      scratch,
      -layer.content.width / 2,
      -layer.content.height / 2,
      layer.content.width,
      layer.content.height,
    );
    ctx.restore();
  }
  scratch.width = mask.width = 1;
  scratch.height = mask.height = 1;
}
export function portableLayerDocument(
  document: LayerDocument,
  images: Map<string, HTMLImageElement>,
): LayerDocument {
  return {
    ...document,
    layers: document.layers.map((layer) => {
      if (
        layer.content.kind !== "image" ||
        layer.content.src.startsWith("data:")
      )
        return layer;
      const image = images.get(layer.content.src);
      if (!image)
        throw new Error(tNow("errors.render.layerNotPortable"));
      const canvas = window.document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      context(canvas).drawImage(image, 0, 0);
      return {
        ...layer,
        content: { ...layer.content, src: canvas.toDataURL("image/png") },
      };
    }),
  };
}
