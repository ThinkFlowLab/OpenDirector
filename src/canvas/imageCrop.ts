/** Retained crop state uses a browser source only in the UI projection. */
import { parseAssetSource } from "../backend/assetSource.ts";
import type { ImageCropOptions } from "../contracts/generated.ts";
import type { Translate } from "../i18n/I18nProvider.tsx";
import { defaultTranslate } from "./assistantTranslate.ts";

export interface ImageCropState {
  src: string;
  width: number;
  height: number;
  options: ImageCropOptions;
}

export const INITIAL_CROP_OPTIONS: ImageCropOptions = {
  rotation: 0,
  flipX: false,
  flipY: false,
  aspect: "original",
  zoom: 100,
  freeWidth: 100,
  freeHeight: 100,
  x: 50,
  y: 50,
  brightness: 100,
  contrast: 100,
  saturation: 100,
};

export function parseImageCrop(
  value: unknown,
  t: Translate = defaultTranslate,
): ImageCropState {
  if (!value || typeof value !== "object")
    throw new Error(t("editors.imageCrop.error.invalidDocument"));
  const data = value as ImageCropState;
  const options = data.options;
  const local =
    typeof data.src === "string" &&
    (/^data:image\//i.test(data.src) ||
      /^\/(?!\/)/.test(data.src) ||
      Boolean(parseAssetSource(data.src)) ||
      (data.src.startsWith("blob:") &&
        typeof location !== "undefined" &&
        location.origin !== "null" &&
        URL.canParse(data.src) &&
        new URL(data.src).origin === location.origin));
  if (
    !local ||
    !Number.isInteger(data.width) ||
    data.width <= 0 ||
    !Number.isInteger(data.height) ||
    data.height <= 0 ||
    !options ||
    ![0, 90, 180, 270].includes(options.rotation) ||
    !["free", "original", "1:1", "4:3", "3:4", "16:9", "9:16"].includes(
      options.aspect,
    ) ||
    typeof options.flipX !== "boolean" ||
    typeof options.flipY !== "boolean"
  )
    throw new Error(t("editors.imageCrop.error.invalidSource"));
  const bounds = {
    zoom: [100, 400],
    freeWidth: [1, 100],
    freeHeight: [1, 100],
    x: [0, 100],
    y: [0, 100],
    brightness: [0, 200],
    contrast: [0, 200],
    saturation: [0, 200],
  } as const;
  for (const key of Object.keys(bounds) as (keyof typeof bounds)[]) {
    if (
      !Number.isFinite(options[key]) ||
      options[key] < bounds[key][0] ||
      options[key] > bounds[key][1]
    )
      throw new Error(t("editors.imageCrop.error.outOfRange"));
  }
  return {
    src: data.src,
    width: data.width,
    height: data.height,
    options: Object.fromEntries(
      Object.keys(INITIAL_CROP_OPTIONS).map((key) => [
        key,
        options[key as keyof ImageCropOptions],
      ]),
    ) as unknown as ImageCropOptions,
  };
}
