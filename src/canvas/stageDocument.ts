import type { Translate } from "../i18n/I18nProvider.tsx";
import { defaultTranslate } from "./assistantTranslate.ts";
import { parseStageMotion, type StageMotion } from "./stageMotion.ts";
import type { AssetRef } from "../contracts/generated.ts";

/** Local previsualization format. V1 is migrated here, never in consumers. */
export interface Vector3Value {
  x: number;
  y: number;
  z: number;
}
export interface StageTransform {
  position: Vector3Value;
  rotation: Vector3Value;
  scale: Vector3Value;
}
export interface StageTransformFrame {
  id: string;
  time: number;
  value: StageTransform;
}
export interface StageMotionClip {
  id: string;
  start: number;
  duration: number;
  motion: StageMotion;
}
export type StageAssetRole = "character" | "scene";
export type StageAssetFormat = "glb" | "gltf";
export interface StageObject extends StageTransform {
  id: string;
  kind: "person" | "box" | "sphere" | "gltf";
  name: string;
  color: string;
  keyframes: StageTransformFrame[];
  motionClips: StageMotionClip[];
  /** Registered asset identity. Omitted only while a local import is unsaved. */
  asset?: AssetRef;
  /** Browser URL used to reconstruct a preview; never sent to the backend. */
  source?: string;
  role?: StageAssetRole;
  format?: StageAssetFormat;
  animationNames?: string[];
  hasAnimation?: boolean;
}
export interface StageCamera {
  position: Vector3Value;
  target: Vector3Value;
  fov: number;
}
export interface StageCameraRig {
  id: string;
  name: string;
  pose: StageCamera;
  keyframes: { id: string; time: number; value: StageCamera }[];
}
export interface StageShot {
  id: string;
  cameraId: string;
  start: number;
  duration: number;
}
export const STAGE_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;
function hasExternalGltfResources(value: unknown) {
  if (!value || typeof value !== "object") return true;
  const document = value as {
    buffers?: unknown;
    images?: unknown;
  };
  return [document.buffers, document.images].some(
    (resources) =>
      Array.isArray(resources) &&
      resources.some(
        (resource) =>
          resource &&
          typeof resource === "object" &&
          "uri" in resource &&
          typeof resource.uri === "string" &&
          !resource.uri.startsWith("data:"),
      ),
  );
}
const isGltfDocument = (value: unknown) => {
  const asset = (value as { asset?: unknown })?.asset;
  return (
    !!value &&
    typeof value === "object" &&
    !!asset &&
    typeof asset === "object" &&
    "version" in asset
  );
};
export interface StageAssetProbe {
  format: StageAssetFormat;
  /** Whether the parsed document references external buffers or images. */
  external: boolean;
  /** Whether the document needs decoders the browser loader cannot provide. */
  compressed: boolean;
}
const COMPRESSED_GLTF_EXTENSIONS = new Set([
  "KHR_draco_mesh_compression",
  "EXT_meshopt_compression",
  "KHR_texture_basisu",
]);
function usesCompressedGltfExtensions(value: unknown) {
  const document = (value as { extensionsUsed?: unknown; extensionsRequired?: unknown }) ?? {};
  return [document.extensionsUsed, document.extensionsRequired].some(
    (list) =>
      Array.isArray(list) &&
      list.some(
        (name) =>
          typeof name === "string" && COMPRESSED_GLTF_EXTENSIONS.has(name),
      ),
  );
}
/**
 * Container and self-containment come from the actual bytes, matching the
 * backend probe. Returns "corrupt" when a GLB header is valid but its
 * embedded JSON chunk is missing, unparsable, or not a glTF document, and
 * undefined when the bytes are no stage model at all.
 */
export function probeStageAsset(
  buffer: ArrayBuffer,
): StageAssetProbe | "corrupt" | undefined {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const glbVersion = () => view.getUint32(4, true);
  const declaredLength = () => view.getUint32(8, true);
  const isGlbMagic =
    bytes.length >= 4 &&
    bytes[0] === 0x67 &&
    bytes[1] === 0x6c &&
    bytes[2] === 0x54 &&
    bytes[3] === 0x46;
  const isGlb =
    bytes.length >= 12 &&
    isGlbMagic &&
    glbVersion() === 2 &&
    declaredLength() >= 12 &&
    declaredLength() <= bytes.length;
  if (isGlbMagic && !isGlb) return undefined;
  if (isGlb) {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const length = view.getUint32(offset, true);
      if (view.getUint32(offset + 4, true) === 0x4e4f534a) {
        try {
          const document: unknown = JSON.parse(
            new TextDecoder().decode(
              bytes.subarray(offset + 8, offset + 8 + length),
            ),
          );
          if (!isGltfDocument(document)) return "corrupt";
          return {
            format: "glb",
            external: hasExternalGltfResources(document),
            compressed: usesCompressedGltfExtensions(document),
          };
        } catch {
          return "corrupt";
        }
      }
      offset += 8 + length;
    }
    return "corrupt";
  }
  try {
    const document: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isGltfDocument(document)) return undefined;
    return {
      format: "gltf",
      external: hasExternalGltfResources(document),
      compressed: usesCompressedGltfExtensions(document),
    };
  } catch {
    return undefined;
  }
}
export interface LocalStageDocument {
  format: "opendirector-local-stage";
  version: 2;
  background: string;
  grid: boolean;
  duration: number;
  aspectRatio: (typeof STAGE_RATIOS)[number];
  cameras: StageCameraRig[];
  activeCameraId: string;
  cameraSource: "camera" | "storyboard";
  shots: StageShot[];
  objects: StageObject[];
}
export interface StageSampleObject extends StageObject {
  motion?: StageMotion;
  motionTime: number;
}
export interface StageSample {
  camera: StageCamera;
  cameraId: string;
  objects: StageSampleObject[];
}
export const STAGE_ASSET_MAX_BYTES = 100 * 1024 * 1024;
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const vector = (v: unknown): v is Vector3Value =>
  record(v) && finite(v.x) && finite(v.y) && finite(v.z);
const nonempty = (v: unknown): v is string =>
  typeof v === "string" && !!v.trim();
const color = (v: unknown): v is string =>
  typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const assetRef = (v: unknown): v is AssetRef =>
  record(v) &&
  nonempty(v.assetId) &&
  typeof v.revision === "number" &&
  Number.isInteger(v.revision) &&
  v.revision >= 1 &&
  typeof v.fingerprint === "string" &&
  /^sha256:[0-9a-f]{64}$/.test(v.fingerprint) &&
  v.kind === "file";
const sameVector = (a: Vector3Value, b: Vector3Value) =>
  a.x === b.x && a.y === b.y && a.z === b.z;
function parseTransform(
  v: unknown,
  t: Translate = defaultTranslate,
): StageTransform {
  if (
    !record(v) ||
    !vector(v.position) ||
    !vector(v.rotation) ||
    !vector(v.scale) ||
    v.scale.x <= 0 ||
    v.scale.y <= 0 ||
    v.scale.z <= 0
  )
    throw new Error(t("editors.stage.error.invalidTransform"));
  return {
    position: { ...v.position },
    rotation: { ...v.rotation },
    scale: { ...v.scale },
  };
}
function parseCamera(
  v: unknown,
  t: Translate = defaultTranslate,
): StageCamera {
  if (
    !record(v) ||
    !vector(v.position) ||
    !vector(v.target) ||
    !finite(v.fov) ||
    v.fov <= 0 ||
    v.fov >= 180 ||
    sameVector(v.position, v.target)
  )
    throw new Error(t("editors.stage.error.invalidCamera"));
  return { position: { ...v.position }, target: { ...v.target }, fov: v.fov };
}
export function defaultStageCamera(): StageCamera {
  return {
    position: { x: 5, y: 3.5, z: 7 },
    target: { x: 0, y: 1, z: 0 },
    fov: 45,
  };
}
export function createLocalStage(
  t: Translate = defaultTranslate,
): LocalStageDocument {
  return {
    format: "opendirector-local-stage",
    version: 2,
    background: "#151923",
    grid: true,
    duration: 6,
    aspectRatio: "16:9",
    cameras: [
      {
        id: "camera-1",
        name: t("editors.stage.defaultCameraName"),
        pose: defaultStageCamera(),
        keyframes: [],
      },
    ],
    activeCameraId: "camera-1",
    cameraSource: "camera",
    shots: [],
    objects: [
      {
        id: crypto.randomUUID(),
        kind: "person",
        name: t("editors.stage.defaultPersonName"),
        color: "#a09af9",
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
        keyframes: [],
        motionClips: [],
      },
    ],
  };
}
function frames<T>(
  raw: unknown,
  duration: number,
  parse: (v: unknown) => T,
  t: Translate = defaultTranslate,
): { id: string; time: number; value: T }[] {
  if (!Array.isArray(raw))
    throw new Error(t("editors.stage.error.invalidKeyframes"));
  const ids = new Set<string>(),
    times = new Set<number>();
  return raw
    .map((v) => {
      if (
        !record(v) ||
        !nonempty(v.id) ||
        ids.has(v.id) ||
        !finite(v.time) ||
        v.time < 0 ||
        v.time > duration ||
        times.has(v.time)
      )
        throw new Error(t("editors.stage.error.invalidKeyframeTime"));
      ids.add(v.id);
      times.add(v.time);
      return { id: v.id, time: v.time, value: parse(v.value) };
    })
    .sort((a, b) => a.time - b.time);
}
function intervals<T extends { id: string; start: number; duration: number }>(
  items: T[],
  duration: number,
  label: string,
  t: Translate = defaultTranslate,
): T[] {
  const ids = new Set<string>();
  const sorted = items.sort((a, b) => a.start - b.start);
  for (const [i, v] of sorted.entries()) {
    if (
      !nonempty(v.id) ||
      ids.has(v.id) ||
      !finite(v.start) ||
      !finite(v.duration) ||
      v.start < 0 ||
      v.duration <= 0 ||
      v.start + v.duration > duration + 1e-8
    )
      throw new Error(t("editors.stage.error.intervalInvalid", { label }));
    if (i && sorted[i - 1]!.start + sorted[i - 1]!.duration > v.start + 1e-8)
      throw new Error(t("editors.stage.error.intervalOverlap", { label }));
    ids.add(v.id);
  }
  return sorted;
}
function migrateV1(
  v: Record<string, unknown>,
  t: Translate = defaultTranslate,
): Record<string, unknown> {
  if (
    !Array.isArray(v.objects) ||
    !Array.isArray(v.keyframes) ||
    !finite(v.duration)
  )
    throw new Error(t("editors.stage.error.invalidLegacy"));
  const objectIds = new Set(
    v.objects.map((o) => (record(o) ? o.id : undefined)),
  );
  const legacy = frames(
    v.keyframes.map((f) => (record(f) ? { ...f, value: f } : f)),
    v.duration,
    (f) => {
      if (!record(f) || !Array.isArray(f.objects))
        throw new Error(t("editors.stage.error.invalidLegacyKeyframe"));
      const ids = new Set();
      return {
        camera: parseCamera(f.camera, t),
        objects: f.objects.map((o) => {
          if (!record(o) || !objectIds.has(o.id) || ids.has(o.id))
            throw new Error(t("editors.stage.error.missingObject"));
          ids.add(o.id);
          return { id: o.id, transform: parseTransform(o.transform, t) };
        }),
      };
    },
    t,
  );
  return {
    ...v,
    version: 2,
    aspectRatio: "16:9",
    activeCameraId: "camera-1",
    cameraSource: "camera",
    shots: [],
    cameras: [
      {
        id: "camera-1",
        name: t("editors.stage.defaultCameraName"),
        pose: parseCamera(v.camera, t),
        keyframes: legacy.map((f) => ({
          id: f.id,
          time: f.time,
          value: f.value.camera,
        })),
      },
    ],
    objects: v.objects.map((o) => {
      if (!record(o))
        throw new Error(t("editors.stage.error.invalidLegacyObject"));
      if (o.motion !== undefined && o.kind !== "person")
        throw new Error(t("editors.stage.error.jointMotionPerson"));
      return {
        ...o,
        keyframes: legacy.map((f) => ({
          id: f.id,
          time: f.time,
          value:
            f.value.objects.find((item) => item.id === o.id)?.transform ??
            parseTransform(o, t),
        })),
        motionClips:
          o.motion === undefined
            ? []
            : [
                {
                  id: `legacy-${String(o.id)}`,
                  start: 0,
                  duration: v.duration,
                  motion: o.motion,
                },
              ],
      };
    }),
  };
}
/** Text boundary for stage imports; unparsable files report a localized error
 * instead of an engine SyntaxError quoting the file's bytes. */
export function parseLocalStageDocument(
  text: string,
  t: Translate = defaultTranslate,
): LocalStageDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(t("editors.stage.ui.importNotJson"));
  }
  return parseLocalStageValue(value, t);
}
export function parseLocalStageValue(
  input: unknown,
  t: Translate = defaultTranslate,
): LocalStageDocument {
  let v = input;
  if (record(v) && v.format === "opendirector-local-stage" && v.version === 1)
    v = migrateV1(v, t);
  if (
    !record(v) ||
    v.format !== "opendirector-local-stage" ||
    v.version !== 2 ||
    !color(v.background) ||
    typeof v.grid !== "boolean" ||
    !finite(v.duration) ||
    v.duration <= 0 ||
    !Array.isArray(v.objects) ||
    !Array.isArray(v.cameras) ||
    !Array.isArray(v.shots) ||
    !STAGE_RATIOS.includes(
      v.aspectRatio as LocalStageDocument["aspectRatio"],
    ) ||
    !["camera", "storyboard"].includes(String(v.cameraSource))
  )
    throw new Error(t("editors.stage.error.invalidDocument"));
  const duration = v.duration,
    ids = new Set<string>(),
    cameraIds = new Set<string>();
  const objects: StageObject[] = v.objects.map((o) => {
    const rawObject = record(o) ? o : undefined;
    const imported = rawObject?.kind === "gltf";
    const importedAsset =
      imported && assetRef(rawObject?.asset) ? rawObject.asset : undefined;
    const importedSource =
      imported && typeof rawObject?.source === "string" && rawObject.source.trim()
        ? rawObject.source
        : undefined;
    const animationNames =
      imported && Array.isArray(rawObject?.animationNames)
        ? rawObject.animationNames.filter((name): name is string => nonempty(name))
        : [];
    if (
      !record(o) ||
      !nonempty(o.id) ||
      ids.has(o.id) ||
      !["person", "box", "sphere", "gltf"].includes(String(o.kind)) ||
      typeof o.name !== "string" ||
      !color(o.color) ||
      !Array.isArray(o.motionClips) ||
      (imported &&
        ((!importedAsset && !importedSource) ||
          !["character", "scene"].includes(String(rawObject?.role)) ||
          !["glb", "gltf"].includes(String(rawObject?.format)) ||
          !Array.isArray(rawObject?.animationNames) ||
          animationNames.length !== rawObject?.animationNames.length ||
          typeof rawObject?.hasAnimation !== "boolean" ||
          rawObject.hasAnimation !== Boolean(animationNames.length)))
    )
      throw new Error(t("editors.stage.error.invalidObject"));
    ids.add(o.id);
    if (o.kind !== "person" && o.kind !== "gltf" && o.motionClips.length)
      throw new Error(t("editors.stage.error.jointMotionPerson"));
    if (imported && o.role === "scene" && o.motionClips.length)
      throw new Error(t("editors.stage.error.importedSceneMotion"));
    if (imported && !o.hasAnimation && o.motionClips.length)
      throw new Error(t("editors.stage.error.importedMotionUnavailable"));
    return {
      id: o.id,
      kind: o.kind as StageObject["kind"],
      name: o.name,
      color: o.color,
      ...parseTransform(o, t),
      keyframes: frames(o.keyframes, duration, (v) => parseTransform(v, t), t),
      motionClips: intervals(
        o.motionClips.map((c) => {
          if (!record(c))
            throw new Error(t("editors.stage.error.invalidMotionClip"));
          return {
            id: c.id as string,
            start: c.start as number,
            duration: c.duration as number,
            motion: parseStageMotion(c.motion),
          };
        }),
        duration,
        t("editors.stage.label.motionClip"),
        t,
      ),
      ...(importedAsset ? { asset: { ...importedAsset } } : {}),
      ...(importedSource ? { source: importedSource } : {}),
      ...(imported
        ? {
            role: o.role as StageAssetRole,
            format: o.format as StageAssetFormat,
            animationNames: [...animationNames],
            hasAnimation: o.hasAnimation as boolean,
          }
        : {}),
    };
  });
  const cameras: StageCameraRig[] = v.cameras.map((c) => {
    if (
      !record(c) ||
      !nonempty(c.id) ||
      cameraIds.has(c.id) ||
      typeof c.name !== "string"
    )
      throw new Error(t("editors.stage.error.invalidCameraId"));
    cameraIds.add(c.id);
    return {
      id: c.id,
      name: c.name,
      pose: parseCamera(c.pose, t),
      keyframes: frames(c.keyframes, duration, (v) => parseCamera(v, t), t),
    };
  });
  if (!cameras.length || !cameraIds.has(v.activeCameraId as string))
    throw new Error(t("editors.stage.error.cameraRequired"));
  const shots = intervals(
    v.shots.map((s) => {
      if (!record(s) || !cameraIds.has(s.cameraId as string))
        throw new Error(t("editors.stage.error.shotCamera"));
      return {
        id: s.id as string,
        cameraId: s.cameraId as string,
        start: s.start as number,
        duration: s.duration as number,
      };
    }),
    duration,
    t("editors.stage.label.shot"),
    t,
  );
  return {
    format: "opendirector-local-stage",
    version: 2,
    background: v.background,
    grid: v.grid,
    duration,
    aspectRatio: v.aspectRatio as LocalStageDocument["aspectRatio"],
    activeCameraId: v.activeCameraId as string,
    cameraSource: v.cameraSource as LocalStageDocument["cameraSource"],
    objects,
    cameras,
    shots,
  };
}
const sameTransform = (a: StageTransform, b: StageTransform) =>
  sameVector(a.position, b.position) &&
  sameVector(a.rotation, b.rotation) &&
  sameVector(a.scale, b.scale);
const sameCamera = (a: StageCamera, b: StageCamera) =>
  sameVector(a.position, b.position) &&
  sameVector(a.target, b.target) &&
  a.fov === b.fov;
const sameAsset = (a: AssetRef | undefined, b: AssetRef | undefined) =>
  a === b ||
  (!!a &&
    !!b &&
    a.assetId === b.assetId &&
    a.revision === b.revision &&
    a.fingerprint === b.fingerprint &&
    a.kind === b.kind);
const sameFrames = <T>(
  a: { id: string; time: number; value: T }[],
  b: { id: string; time: number; value: T }[],
  same: (a: T, b: T) => boolean,
) =>
  a.length === b.length &&
  a.every(
    (f, i) =>
      f.id === b[i]!.id && f.time === b[i]!.time && same(f.value, b[i]!.value),
  );
export function sameLocalStage(
  a: LocalStageDocument | undefined,
  b: LocalStageDocument | undefined,
): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.background === b.background &&
      a.grid === b.grid &&
      a.duration === b.duration &&
      a.aspectRatio === b.aspectRatio &&
      a.activeCameraId === b.activeCameraId &&
      a.cameraSource === b.cameraSource &&
      a.objects.length === b.objects.length &&
      a.objects.every((o, i) => {
        const p = b.objects[i]!;
        return (
          o.id === p.id &&
          o.name === p.name &&
          o.kind === p.kind &&
          o.color === p.color &&
          sameAsset(o.asset, p.asset) &&
          o.role === p.role &&
          o.format === p.format &&
          o.hasAnimation === p.hasAnimation &&
          (o.animationNames ?? []).join("\u0000") ===
            (p.animationNames ?? []).join("\u0000") &&
          sameTransform(o, p) &&
          sameFrames(o.keyframes, p.keyframes, sameTransform) &&
          o.motionClips.length === p.motionClips.length &&
          o.motionClips.every((c, j) => {
            const d = p.motionClips[j]!;
            return (
              c.id === d.id &&
              c.start === d.start &&
              c.duration === d.duration &&
              c.motion.preset === d.motion.preset &&
              c.motion.amount === d.motion.amount &&
              c.motion.speed === d.motion.speed
            );
          })
        );
      }) &&
      a.cameras.length === b.cameras.length &&
      a.cameras.every((c, i) => {
        const d = b.cameras[i]!;
        return (
          c.id === d.id &&
          c.name === d.name &&
          sameCamera(c.pose, d.pose) &&
          sameFrames(c.keyframes, d.keyframes, sameCamera)
        );
      }) &&
      a.shots.length === b.shots.length &&
      a.shots.every((s, i) => {
        const t = b.shots[i]!;
        return (
          s.id === t.id &&
          s.cameraId === t.cameraId &&
          s.start === t.start &&
          s.duration === t.duration
        );
      }))
  );
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mixVector = (
  a: Vector3Value,
  b: Vector3Value,
  t: number,
): Vector3Value => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  z: lerp(a.z, b.z, t),
});
function sample<T>(
  base: T,
  frames: { time: number; value: T }[],
  time: number,
  mix: (a: T, b: T, t: number) => T,
): T {
  if (!frames.length) return base;
  const left = [...frames].reverse().find((f) => f.time <= time) ?? frames[0]!,
    right = frames.find((f) => f.time >= time) ?? frames.at(-1)!;
  return mix(
    left.value,
    right.value,
    left.time === right.time
      ? 0
      : (time - left.time) / (right.time - left.time),
  );
}
export function sampleStageCamera(
  stage: LocalStageDocument,
  id: string,
  time: number,
  t: Translate = defaultTranslate,
): StageCamera {
  const c = stage.cameras.find((c) => c.id === id);
  if (!c) throw new Error(t("editors.stage.error.cameraMissing"));
  return sample(c.pose, c.keyframes, time, (a, b, t) => ({
    position: mixVector(a.position, b.position, t),
    target: mixVector(a.target, b.target, t),
    fov: lerp(a.fov, b.fov, t),
  }));
}
/** The shot whose camera evaluates at a time, or the gap fallback. Half-open
 * cut boundaries match the sampler shared by editor, screenshots and MP4. */
export function stageCameraAt(
  stage: LocalStageDocument,
  time: number,
): { cameraId: string; shot?: StageShot } {
  const at = Math.max(0, Math.min(stage.duration, time));
  const shot =
    stage.cameraSource === "storyboard"
      ? stage.shots.find(
          (s) =>
            at >= s.start &&
            (at < s.start + s.duration ||
              (at === stage.duration && at === s.start + s.duration)),
        )
      : undefined;
  return { cameraId: shot?.cameraId ?? stage.activeCameraId, shot };
}
/** Same global timeline and half-open cut boundaries for editor, screenshots and MP4. */
export function sampleStage(
  stage: LocalStageDocument,
  time: number,
): StageSample {
  const at = Math.max(0, Math.min(stage.duration, time));
  const cameraId = stageCameraAt(stage, at).cameraId;
  return {
    cameraId,
    camera: sampleStageCamera(stage, cameraId, at),
    objects: stage.objects.map((o) => {
      const transform = sample<StageTransform>(
        o,
        o.keyframes,
        at,
        (a, b, t) => ({
          position: mixVector(a.position, b.position, t),
          rotation: mixVector(a.rotation, b.rotation, t),
          scale: mixVector(a.scale, b.scale, t),
        }),
      );
      const clip = o.motionClips.find(
        (c) =>
          at >= c.start &&
          (at < c.start + c.duration ||
            (at === stage.duration && at === c.start + c.duration)),
      );
      return {
        ...o,
        ...transform,
        motion: clip?.motion,
        motionTime: clip ? at - clip.start : 0,
      };
    }),
  };
}
const putFrame = <T>(
  frames: { id: string; time: number; value: T }[],
  time: number,
  value: T,
) =>
  [
    ...frames.filter((f) => f.time !== time),
    {
      id: frames.find((f) => f.time === time)?.id ?? crypto.randomUUID(),
      time,
      value,
    },
  ].sort((a, b) => a.time - b.time);
function authorFrame<T>(
  frames: { id: string; time: number; value: T }[],
  time: number,
  value: T,
  base: T,
) {
  // The first edit later in time must not retroactively replace the opening pose.
  return putFrame(
    !frames.length && time > 0 ? putFrame([], 0, base) : frames,
    time,
    value,
  );
}
export function editStageObjectAt(
  stage: LocalStageDocument,
  id: string,
  time: number,
  patch: Partial<StageObject>,
  t: Translate = defaultTranslate,
): LocalStageDocument {
  const pose = sampleStage(stage, time).objects.find((o) => o.id === id);
  if (!pose) return stage;
  const transform = parseTransform({ ...pose, ...patch }, t);
  const {
    position: _position,
    rotation: _rotation,
    scale: _scale,
    ...metadata
  } = patch;
  const changesTransform =
    !!(patch.position || patch.rotation || patch.scale) &&
    !sameTransform(pose, transform);
  return parseLocalStageValue(
    {
      ...stage,
      objects: stage.objects.map((o) =>
        o.id !== id
          ? o
          : {
              ...o,
              ...metadata,
              ...(changesTransform ? transform : {}),
              keyframes: changesTransform
                ? authorFrame(o.keyframes, time, transform, parseTransform(o, t))
                : o.keyframes,
            },
      ),
    },
    t,
  );
}
export function editStageCameraAt(
  stage: LocalStageDocument,
  id: string,
  time: number,
  patch: Partial<StageCamera>,
  t: Translate = defaultTranslate,
): LocalStageDocument {
  const current = sampleStageCamera(stage, id, time, t);
  const pose = parseCamera({ ...current, ...patch }, t);
  if (sameCamera(current, pose)) return stage;
  return parseLocalStageValue(
    {
      ...stage,
      cameras: stage.cameras.map((c) =>
        c.id !== id
          ? c
          : {
              ...c,
              pose,
              keyframes: authorFrame(c.keyframes, time, pose, c.pose),
            },
      ),
    },
    t,
  );
}
export function captureStageFrame(
  stage: LocalStageDocument,
  time: number,
  t: Translate = defaultTranslate,
): LocalStageDocument {
  const pose = sampleStage(stage, time);
  return parseLocalStageValue(
    {
      ...stage,
      objects: stage.objects.map((o) => ({
        ...o,
        keyframes: putFrame(
          o.keyframes,
          time,
          parseTransform(pose.objects.find((p) => p.id === o.id)!, t),
        ),
      })),
      cameras: stage.cameras.map((c) =>
        c.id === pose.cameraId
          ? { ...c, keyframes: putFrame(c.keyframes, time, pose.camera) }
          : c,
      ),
    },
    t,
  );
}
export function stageFrameTimes(stage: LocalStageDocument): number[] {
  return [
    ...new Set([
      ...stage.objects.flatMap((o) => o.keyframes.map((f) => f.time)),
      ...stage.cameras.flatMap((c) => c.keyframes.map((f) => f.time)),
    ]),
  ].sort((a, b) => a - b);
}
export function removeStageFrame(
  stage: LocalStageDocument,
  time: number,
): LocalStageDocument {
  return {
    ...stage,
    objects: stage.objects.map((o) => ({
      ...o,
      keyframes: o.keyframes.filter((f) => f.time !== time),
    })),
    cameras: stage.cameras.map((c) => ({
      ...c,
      keyframes: c.keyframes.filter((f) => f.time !== time),
    })),
  };
}
export function stageOutputSize(ratio: LocalStageDocument["aspectRatio"]): {
  width: number;
  height: number;
} {
  const [w, h] = ratio.split(":").map(Number);
  return {
    width: Math.round((1280 * w!) / Math.max(w!, h!) / 2) * 2,
    height: Math.round((1280 * h!) / Math.max(w!, h!) / 2) * 2,
  };
}
/** Imported objects pinning assets the current project has not registered.
 * Stage JSON exports carry no model bytes, so such objects can neither
 * preview nor apply; importers reject them explicitly instead of failing
 * at save time. */
export function unregisteredStageAssets(
  stage: LocalStageDocument,
  isRegistered: (asset: AssetRef) => boolean,
): StageObject[] {
  return stage.objects.filter(
    (object) => object.kind === "gltf" && object.asset && !isRegistered(object.asset),
  );
}
