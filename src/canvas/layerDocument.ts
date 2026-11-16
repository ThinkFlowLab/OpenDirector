/** Local, editable pixel layers. This document is independent of AI task results. */
import type { Translate } from "../i18n/I18nProvider.tsx";
import { defaultTranslate } from "./assistantTranslate.ts";

export interface LayerPoint {
  x: number;
  y: number;
}
export interface MaskStroke {
  mode: "erase" | "restore";
  size: number;
  points: LayerPoint[];
}
export type LayerContent =
  | { kind: "image"; src: string; width: number; height: number }
  | {
      kind: "text";
      text: string;
      color: string;
      fontSize: number;
      width: number;
      height: number;
    }
  | { kind: "rectangle"; color: string; width: number; height: number };
export interface ImageLayer {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  content: LayerContent;
  mask: MaskStroke[];
}
export interface LayerDocument {
  format: "opendirector-layers";
  version: 1;
  width: number;
  height: number;
  background: string;
  /** Painter's order: index 0 is the bottom layer. */
  layers: ImageLayer[];
}
export const MAX_LAYER_PIXELS = 16_777_216;
export const MAX_LAYER_SIDE = 8192;
export const MAX_LAYERS = 40;
export function assertLayerSize(
  width: number,
  height: number,
  t: Translate = defaultTranslate,
): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_LAYER_SIDE ||
    height > MAX_LAYER_SIDE ||
    width * height > MAX_LAYER_PIXELS
  )
    throw new Error(t("editors.layerDocument.error.size"));
}
export function createImageLayer(
  content: LayerContent,
  name: string,
  t: Translate = defaultTranslate,
): ImageLayer {
  assertLayerSize(content.width, content.height, t);
  return {
    id: crypto.randomUUID(),
    name: name.slice(0, 200),
    content,
    visible: true,
    locked: false,
    opacity: 1,
    x: 0,
    y: 0,
    width: content.width,
    height: content.height,
    rotation: 0,
    flipX: false,
    flipY: false,
    mask: [],
  };
}
export function createLayerDocument(
  src: string,
  width: number,
  height: number,
  name?: string,
  t: Translate = defaultTranslate,
): LayerDocument {
  assertLayerSize(width, height, t);
  return {
    format: "opendirector-layers",
    version: 1,
    width,
    height,
    background: "transparent",
    layers: [
      createImageLayer(
        { kind: "image", src, width, height },
        name ?? t("editors.layerDocument.defaultName"),
        t,
      ),
    ],
  };
}
/** Inverse of the exact center-based canvas transform, including flips. */
export function worldToLayer(layer: ImageLayer, point: LayerPoint): LayerPoint {
  const radians = (-layer.rotation * Math.PI) / 180;
  const dx = point.x - layer.x - layer.width / 2;
  const dy = point.y - layer.y - layer.height / 2;
  const x = dx * Math.cos(radians) - dy * Math.sin(radians);
  const y = dx * Math.sin(radians) + dy * Math.cos(radians);
  return {
    x:
      ((x * layer.content.width) / layer.width) * (layer.flipX ? -1 : 1) +
      layer.content.width / 2,
    y:
      ((y * layer.content.height) / layer.height) * (layer.flipY ? -1 : 1) +
      layer.content.height / 2,
  };
}
export function layerToWorld(layer: ImageLayer, point: LayerPoint): LayerPoint {
  const radians = (layer.rotation * Math.PI) / 180;
  const x =
    (((point.x - layer.content.width / 2) * layer.width) /
      layer.content.width) *
    (layer.flipX ? -1 : 1);
  const y =
    (((point.y - layer.content.height / 2) * layer.height) /
      layer.content.height) *
    (layer.flipY ? -1 : 1);
  return {
    x:
      layer.x + layer.width / 2 + x * Math.cos(radians) - y * Math.sin(radians),
    y:
      layer.y +
      layer.height / 2 +
      x * Math.sin(radians) +
      y * Math.cos(radians),
  };
}
export function hitLayer(
  document: LayerDocument,
  point: LayerPoint,
): ImageLayer | undefined {
  return [...document.layers].reverse().find((layer) => {
    if (!layer.visible || layer.locked || !layer.opacity) return false;
    const local = worldToLayer(layer, point);
    return (
      local.x >= 0 &&
      local.y >= 0 &&
      local.x <= layer.content.width &&
      local.y <= layer.content.height
    );
  });
}
export function reorderLayer(
  document: LayerDocument,
  id: string,
  destination: number,
): LayerDocument {
  const index = document.layers.findIndex((layer) => layer.id === id);
  if (index >= 0 && document.layers[index]!.locked) return document;
  const target = Math.max(0, Math.min(document.layers.length - 1, destination));
  if (index < 0 || index === target) return document;
  const layers = [...document.layers];
  const [layer] = layers.splice(index, 1);
  layers.splice(target, 0, layer!);
  return { ...document, layers };
}
export interface LayerHistory {
  past: LayerDocument[];
  present: LayerDocument;
  future: LayerDocument[];
}
export function recordLayers(
  history: LayerHistory,
  next: LayerDocument,
  previous = history.present,
): LayerHistory {
  if (next === previous) return history;
  return {
    past: [...history.past, previous].slice(-40),
    present: next,
    future: [],
  };
}
export function undoLayers(history: LayerHistory): LayerHistory {
  const previous = history.past.at(-1);
  return previous
    ? {
        past: history.past.slice(0, -1),
        present: previous,
        future: [history.present, ...history.future],
      }
    : history;
}
export function redoLayers(history: LayerHistory): LayerHistory {
  const next = history.future[0];
  return next
    ? {
        past: [...history.past, history.present],
        present: next,
        future: history.future.slice(1),
      }
    : history;
}
/** Strict editable-document boundary; unsupported fields never become rendering instructions. */
export function parseLayerDocument(
  text: string,
  t: Translate = defaultTranslate,
): LayerDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(t("editors.layerDocument.error.notJson"));
  }
  return parseLayerDocumentValue(value, t);
}
export function parseLayerDocumentValue(
  value: unknown,
  t: Translate = defaultTranslate,
): LayerDocument {
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(t("editors.layerDocument.error.structure"));
    return value as Record<string, unknown>;
  };
  const finite = (value: unknown, min: number, max: number): number => {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < min ||
      value > max
    )
      throw new Error(t("editors.layerDocument.error.invalidParameter"));
    return value;
  };
  const string = (value: unknown, max = 2000): string => {
    if (typeof value !== "string" || value.length > max)
      throw new Error(t("editors.layerDocument.error.invalidText"));
    return value;
  };
  const color = (value: unknown): string => {
    if (typeof value !== "string" || !/^#[a-f\d]{6}$/i.test(value))
      throw new Error(t("editors.layerDocument.error.invalidColor"));
    return value;
  };
  const boolean = (value: unknown): boolean => {
    if (typeof value !== "boolean")
      throw new Error(t("editors.layerDocument.error.invalidBoolean"));
    return value;
  };
  const size = (value: unknown) => finite(value, 1, MAX_LAYER_SIDE);
  const raw = object(value);
  if (raw.format !== "opendirector-layers" || raw.version !== 1)
    throw new Error(t("editors.layerDocument.error.unsupported"));
  const width = size(raw.width),
    height = size(raw.height);
  assertLayerSize(width, height, t);
  if (!Array.isArray(raw.layers) || raw.layers.length > MAX_LAYERS)
    throw new Error(
      t("editors.layerDocument.error.tooManyLayers", { count: MAX_LAYERS }),
    );
  const ids = new Set<string>();
  let points = 0;
  const layers = raw.layers.map((value): ImageLayer => {
    const layer = object(value),
      source = object(layer.content);
    const id = string(layer.id, 100);
    if (!id || ids.has(id))
      throw new Error(t("editors.layerDocument.error.emptyId"));
    ids.add(id);
    const contentWidth = size(source.width),
      contentHeight = size(source.height);
    assertLayerSize(contentWidth, contentHeight, t);
    let content: LayerContent;
    if (source.kind === "image") {
      const src = string(source.src, 90_000_000);
      const localBlob =
        src.startsWith("blob:") &&
        typeof location !== "undefined" &&
        location.origin !== "null" &&
        URL.canParse(src) &&
        new URL(src).origin === location.origin;
      if (
        !/^data:image\/[a-z\d.+-]+[;,]/i.test(src) &&
        !/^\/(?!\/)/.test(src) &&
        !localBlob
      )
        throw new Error(t("editors.layerDocument.error.remoteImage"));
      content = {
        kind: "image",
        src,
        width: contentWidth,
        height: contentHeight,
      };
    } else if (source.kind === "text") {
      content = {
        kind: "text",
        text: string(source.text, 10000),
        color: color(source.color),
        fontSize: finite(source.fontSize, 4, 1000),
        width: contentWidth,
        height: contentHeight,
      };
    } else if (source.kind === "rectangle") {
      content = {
        kind: "rectangle",
        color: color(source.color),
        width: contentWidth,
        height: contentHeight,
      };
    } else
      throw new Error(t("editors.layerDocument.error.unsupportedKind"));
    if (!Array.isArray(layer.mask) || layer.mask.length > 2000)
      throw new Error(t("editors.layerDocument.error.maskTooLarge"));
    const mask = layer.mask.map((value): MaskStroke => {
      const stroke = object(value);
      if (
        (stroke.mode !== "erase" && stroke.mode !== "restore") ||
        !Array.isArray(stroke.points) ||
        !stroke.points.length
      )
        throw new Error(t("editors.layerDocument.error.invalidStroke"));
      points += stroke.points.length;
      if (points > 200000)
        throw new Error(t("editors.layerDocument.error.tooManyPoints"));
      return {
        mode: stroke.mode,
        size: finite(stroke.size, 1, 4096),
        points: stroke.points.map((value) => {
          const point = object(value);
          return {
            x: finite(point.x, -1000000, 1000000),
            y: finite(point.y, -1000000, 1000000),
          };
        }),
      };
    });
    return {
      id,
      name: string(layer.name, 200),
      content,
      visible: boolean(layer.visible),
      locked: boolean(layer.locked),
      opacity: finite(layer.opacity, 0, 1),
      x: finite(layer.x, -1000000, 1000000),
      y: finite(layer.y, -1000000, 1000000),
      width: finite(layer.width, 1, 100000),
      height: finite(layer.height, 1, 100000),
      rotation: finite(layer.rotation, -36000, 36000),
      flipX: boolean(layer.flipX),
      flipY: boolean(layer.flipY),
      mask,
    };
  });
  return {
    format: "opendirector-layers",
    version: 1,
    width,
    height,
    background:
      raw.background === "transparent" ? "transparent" : color(raw.background),
    layers,
  };
}

/** Compare owned fields without serializing or duplicating inline image data. */
export function sameLayerDocument(
  a: LayerDocument | undefined,
  b: LayerDocument | undefined,
): boolean {
  if (a === b) return true;
  if (
    !a ||
    !b ||
    a.format !== b.format ||
    a.version !== b.version ||
    a.width !== b.width ||
    a.height !== b.height ||
    a.background !== b.background ||
    a.layers.length !== b.layers.length
  )
    return false;
  return a.layers.every((layer, index) => {
    const other = b.layers[index]!;
    if (layer === other) return true;
    const keys = [
      "id",
      "name",
      "visible",
      "locked",
      "opacity",
      "x",
      "y",
      "width",
      "height",
      "rotation",
      "flipX",
      "flipY",
    ] as const;
    if (keys.some((key) => layer[key] !== other[key])) return false;
    const content = layer.content,
      next = other.content;
    if (content !== next) {
      if (
        content.kind !== next.kind ||
        content.width !== next.width ||
        content.height !== next.height
      )
        return false;
      if (
        content.kind === "image" &&
        (next.kind !== "image" || content.src !== next.src)
      )
        return false;
      if (
        content.kind === "text" &&
        (next.kind !== "text" ||
          content.text !== next.text ||
          content.fontSize !== next.fontSize ||
          content.color !== next.color)
      )
        return false;
      if (
        content.kind === "rectangle" &&
        (next.kind !== "rectangle" || content.color !== next.color)
      )
        return false;
    }
    return (
      layer.mask === other.mask ||
      (layer.mask.length === other.mask.length &&
        layer.mask.every((stroke, index) => {
          const next = other.mask[index]!;
          return (
            stroke === next ||
            (stroke.mode === next.mode &&
              stroke.size === next.size &&
              stroke.points.length === next.points.length &&
              stroke.points.every(
                (point, index) =>
                  point.x === next.points[index]!.x &&
                  point.y === next.points[index]!.y,
              ))
          );
        }))
    );
  });
}
