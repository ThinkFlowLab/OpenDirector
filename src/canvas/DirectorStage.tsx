import { useEditorCommit, type EditorApplyResult } from "./useEditorCommit";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinnedObject } from "three/addons/utils/SkeletonUtils.js";
import type { CanvasNode } from "./model";
import type { AssetRef } from "../contracts/generated.ts";
import { ControlSlider } from "./ControlSlider";
import {
  createLocalStage,
  parseLocalStageDocument,
  parseLocalStageValue,
  probeStageAsset,
  sampleStage,
  stageCameraAt,
  editStageObjectAt,
  editStageCameraAt,
  captureStageFrame,
  stageFrameTimes,
  removeStageFrame,
  stageOutputSize,
  unregisteredStageAssets,
  defaultStageCamera,
  STAGE_RATIOS,
  STAGE_ASSET_MAX_BYTES,
} from "./stageDocument";
import type {
  LocalStageDocument,
  StageCamera,
  StageSample,
  StageSampleObject,
  StageMotionClip,
  StageShot,
  StageObject,
  StageTransform,
  StageAssetRole,
  Vector3Value,
} from "./stageDocument";
import {
  commitStageHistory,
  createStageHistory,
  navigateStageHistory,
  type StageHistory,
} from "./stageHistory";
import { EditorModal } from "./EditorModal";
import "./director-stage.css";
import {
  STAGE_MOTIONS,
  sampleJointPose,
  selectStageAnimation,
  type StageMotion,
} from "./stageMotion";
import { encodeMp4 } from "./mp4Export";
import { downloadFile, downloadFilename } from "./assets";
import { withMediaDuration } from "./editorMedia";
import { mediaBlobDataUrl } from "./localMediaRuntime";
import type { LinkedMediaResult } from "./linkedResults";
import { useI18n } from "../i18n/I18nProvider.tsx";
import type { MessageKey } from "../i18n/types.ts";

export interface DirectorStageProps {
  node: CanvasNode;
  onApply: (
    stage: LocalStageDocument,
    screenshot?: string,
  ) => EditorApplyResult;
  onClose: () => void;
  onRender: (result: LinkedMediaResult) => boolean | Promise<boolean>;
  onPrepareRender?: (
    stage: LocalStageDocument,
  ) => Promise<(result: LinkedMediaResult) => Promise<boolean>>;
  /** Whether a pinned asset is registered in the currently open project;
   * stage JSON imports reject objects pinning assets it reports as absent. */
  isRegisteredAsset?: (asset: AssetRef) => boolean;
}
interface LoadedStageAsset {
  scene: THREE.Object3D;
  animations: THREE.AnimationClip[];
}
interface RestPose {
  object: THREE.Object3D;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}
interface ImportedRuntime {
  root: THREE.Group;
  clips: THREE.AnimationClip[];
  mixer?: THREE.AnimationMixer;
  activeClip?: THREE.AnimationClip;
  restPose: RestPose[];
}
interface StageRuntime {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  root: THREE.Group;
  grid: THREE.GridHelper;
  imported: Map<string, ImportedRuntime>;
  /** In-flight or resolved loads keyed by pinned asset id or source URL, so
   * concurrent effect runs share one load and one set of GPU resources. */
  assetCache: Map<string, Promise<LoadedStageAsset>>;
}
const vector = (value: THREE.Vector3): Vector3Value => ({
  x: value.x,
  y: value.y,
  z: value.z,
});
const axes = ["x", "y", "z"] as const;
const titles: Record<StageObject["kind"], MessageKey> = {
  person: "editors.stage.ui.objectPerson",
  box: "editors.stage.ui.objectBox",
  sphere: "editors.stage.ui.objectSphere",
  gltf: "editors.stage.ui.objectGltf",
};
function applyTransform(object: THREE.Object3D, value: StageTransform) {
  object.position.set(value.position.x, value.position.y, value.position.z);
  object.rotation.set(value.rotation.x, value.rotation.y, value.rotation.z);
  object.scale.set(value.scale.x, value.scale.y, value.scale.z);
}
function buildObject(value: StageObject): THREE.Group {
  const group = new THREE.Group();
  group.userData.objectId = value.id;
  group.userData.objectKind = value.kind;
  if (value.kind === "gltf") {
    group.userData.assetSource = value.source;
    // The translucent box owns exclusive GPU resources, unlike loaded
    // clones that share them with the cached scene.
    group.userData.placeholder = true;
  }
  const material = new THREE.MeshStandardMaterial({
    color: value.color,
    roughness: 0.58,
    metalness: 0.08,
  });
  const add = (
    geometry: THREE.BufferGeometry,
    x: number,
    y: number,
    z: number,
  ) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  if (value.kind === "box") add(new THREE.BoxGeometry(1, 1, 1), 0, 0.5, 0);
  else if (value.kind === "sphere")
    add(new THREE.SphereGeometry(0.6, 32, 24), 0, 0.6, 0);
  else if (value.kind === "gltf") {
    material.transparent = true;
    material.opacity = 0.35;
    add(new THREE.BoxGeometry(1, 1, 1), 0, 0.5, 0);
  } else {
    const bone = (
      parent: THREE.Object3D,
      name: string,
      x: number,
      y: number,
      z = 0,
    ) => {
      const joint = new THREE.Bone();
      joint.name = name;
      joint.position.set(x, y, z);
      parent.add(joint);
      return joint;
    };
    const mesh = (
      parent: THREE.Object3D,
      geometry: THREE.BufferGeometry,
      y: number,
    ) => {
      const part = new THREE.Mesh(geometry, material);
      part.position.y = y;
      part.castShadow = true;
      part.receiveShadow = true;
      parent.add(part);
    };
    const hips = bone(group, "hips", 0, 0.9);
    mesh(hips, new THREE.CylinderGeometry(0.23, 0.19, 0.55, 16), 0.28);
    mesh(hips, new THREE.SphereGeometry(0.22, 24, 16), 0.8);
    for (const [side, sign] of [
      ["left", -1],
      ["right", 1],
    ] as const) {
      const hip = bone(hips, `${side}Hip`, sign * 0.13, 0);
      mesh(hip, new THREE.CapsuleGeometry(0.085, 0.25, 6, 12), -0.21);
      const knee = bone(hip, `${side}Knee`, 0, -0.42);
      mesh(knee, new THREE.CapsuleGeometry(0.075, 0.28, 6, 12), -0.22);
      const shoulder = bone(hips, `${side}Shoulder`, sign * 0.3, 0.5);
      mesh(shoulder, new THREE.CapsuleGeometry(0.065, 0.2, 6, 12), -0.16);
      const elbow = bone(shoulder, `${side}Elbow`, 0, -0.32);
      mesh(elbow, new THREE.CapsuleGeometry(0.055, 0.2, 6, 12), -0.15);
    }
  }
  applyTransform(group, value);
  return group;
}
function cloneImportedAsset(
  value: StageObject,
  loaded: LoadedStageAsset,
): THREE.Group {
  const group = new THREE.Group();
  group.userData.objectId = value.id;
  group.userData.objectKind = value.kind;
  group.userData.assetSource = value.source;
  group.add(cloneSkinnedObject(loaded.scene));
  applyTransform(group, value);
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  return group;
}
async function loadStageAsset(source: string): Promise<LoadedStageAsset> {
  const loaded = await new GLTFLoader().loadAsync(source);
  return { scene: loaded.scene, animations: loaded.animations };
}
function applySelectionHighlight(
  root: THREE.Object3D,
  selected: string | null,
) {
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      let owner: THREE.Object3D | null = child;
      while (owner && !owner.userData.objectId) owner = owner.parent;
      const highlighted = owner?.userData.objectId === selected;
      // Imported models may use unlit or other materials without emissive.
      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];
      for (const material of materials)
        if (material instanceof THREE.MeshStandardMaterial)
          material.emissive.set(highlighted ? "#1e1536" : "#000000");
    }
  });
}
function createImportedRuntime(
  group: THREE.Group,
  clips: THREE.AnimationClip[],
): ImportedRuntime {
  const restPose: RestPose[] = [];
  for (const child of group.children)
    child.traverse((object) => {
      restPose.push({
        object,
        position: object.position.clone(),
        quaternion: object.quaternion.clone(),
        scale: object.scale.clone(),
      });
    });
  return {
    root: group,
    clips,
    mixer: clips.length ? new THREE.AnimationMixer(group) : undefined,
    restPose,
  };
}
function applyImportedAnimation(
  imported: Map<string, ImportedRuntime>,
  value: StageSampleObject,
) {
  if (value.kind !== "gltf") return;
  const binding = imported.get(value.id);
  if (!binding?.mixer) return;
  const clip = value.motion
    ? selectStageAnimation(binding.clips, value.motion.preset)
    : undefined;
  if (binding.activeClip !== clip) {
    binding.mixer.stopAllAction();
    if (clip) binding.mixer.clipAction(clip).reset().play();
    // Leaving a clip must return the skeleton to its authored rest pose;
    // stopAllAction alone leaves bones at the last sampled pose.
    else
      for (const part of binding.restPose) {
        part.object.position.copy(part.position);
        part.object.quaternion.copy(part.quaternion);
        part.object.scale.copy(part.scale);
      }
    binding.activeClip = clip;
  }
  binding.mixer.setTime(
    clip && value.motion ? value.motionTime * value.motion.speed : 0,
  );
}
function poseJoints(group: THREE.Object3D, value: StageSampleObject) {
  if (value.kind !== "person") return;
  const pose = sampleJointPose(value.motion, value.motionTime);
  const hips = group.getObjectByName("hips");
  if (hips) hips.position.y = 0.9 + pose.hipsY;
  for (const side of ["left", "right"] as const) {
    const hip = group.getObjectByName(`${side}Hip`),
      knee = group.getObjectByName(`${side}Knee`);
    const shoulder = group.getObjectByName(`${side}Shoulder`),
      elbow = group.getObjectByName(`${side}Elbow`);
    if (hip) hip.rotation.x = pose[`${side}Hip`];
    if (knee) knee.rotation.x = pose[`${side}Knee`];
    if (shoulder)
      shoulder.rotation.set(
        pose[`${side}ShoulderX`],
        0,
        side === "right" ? pose.rightShoulderZ : 0,
      );
    if (elbow) elbow.rotation.x = pose[`${side}Elbow`];
  }
}
function disposeObject(object: THREE.Object3D) {
  const materials = new Set<THREE.Material>();
  object.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      (Array.isArray(child.material)
        ? child.material
        : [child.material]
      ).forEach((material) => materials.add(material));
    }
  });
  materials.forEach((material) => material.dispose());
}
function setCamera(runtime: StageRuntime, value: StageCamera) {
  runtime.camera.position.set(
    value.position.x,
    value.position.y,
    value.position.z,
  );
  runtime.camera.fov = value.fov;
  runtime.camera.updateProjectionMatrix();
  runtime.controls.target.set(value.target.x, value.target.y, value.target.z);
  runtime.controls.update();
}
function displayPose(runtime: StageRuntime, pose: StageSample) {
  setCamera(runtime, pose.camera);
  for (const child of runtime.root.children) {
    const data = pose.objects.find(
      (item) => item.id === child.userData.objectId,
    );
    if (data) {
      applyTransform(child, data);
      poseJoints(child, data);
      applyImportedAnimation(runtime.imported, data);
    }
  }
}
const focalLength = (fov: number) =>
  35 / (16 / 9) / (2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2));
const fovFromFocal = (focal: number) =>
  THREE.MathUtils.radToDeg(2 * Math.atan(35 / (16 / 9) / (2 * focal)));

/** Canonical decimal form: the only text that becomes a domain value. Leading
 * zeros ("03"), trailing dots ("1."), exponents, and empty text never commit;
 * clearing a field therefore cannot silently write 0. */
const DECIMAL_TEXT = /^-?(0|[1-9]\d*)(\.\d+)?$/;
function NumberField({
  ariaLabel,
  value,
  min,
  max,
  decimals = 3,
  quantize = false,
  clamp = false,
  onCommit,
}: {
  ariaLabel: string;
  value: number;
  min?: number;
  max?: number;
  /** Display precision; quantize also rounds committed values to it. */
  decimals?: number;
  quantize?: boolean;
  /** Clamp out-of-range entries instead of refusing them until blur. */
  clamp?: boolean;
  onCommit: (value: number) => void;
}) {
  // null = not editing; "" = editing with an empty field (no committed value).
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const canonical = String(Number(value.toFixed(decimals)));
  const commit = (raw: number) => {
    let next = quantize ? Math.round(raw * 10 ** decimals) / 10 ** decimals : raw;
    if (clamp) {
      if (min !== undefined) next = Math.max(min, next);
      if (max !== undefined) next = Math.min(max, next);
      onCommit(next);
      return;
    }
    if (
      Number.isFinite(next) &&
      (min === undefined || next >= min) &&
      (max === undefined || next <= max)
    )
      onCommit(next);
  };
  return (
    <input
      aria-label={ariaLabel}
      type="text"
      inputMode="decimal"
      value={editing ? draft : canonical}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        if (DECIMAL_TEXT.test(text)) commit(Number(text));
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === "Escape") setDraft(null);
      }}
    />
  );
}
function VectorFields({
  label,
  value,
  onChange,
  rotation = false,
  min,
}: {
  label: string;
  value: Vector3Value;
  onChange: (value: Vector3Value) => void;
  rotation?: boolean;
  min?: number;
}) {
  const { t } = useI18n();
  return (
    <fieldset className="cw-stage-vector">
      <legend>
        {label}
        {rotation ? t("editors.stage.ui.degreesSuffix") : ""}
      </legend>
      {axes.map((axis) => (
        <label key={axis}>
          {axis.toUpperCase()}
          <NumberField
            ariaLabel={`${label} ${axis.toUpperCase()}`}
            min={min}
            decimals={rotation ? 1 : 3}
            value={
              rotation ? THREE.MathUtils.radToDeg(value[axis]) : value[axis]
            }
            onCommit={(raw) =>
              onChange({
                ...value,
                [axis]: rotation ? THREE.MathUtils.degToRad(raw) : raw,
              })
            }
          />
        </label>
      ))}
    </fieldset>
  );
}

export function DirectorStage({
  node,
  onApply,
  onClose,
  onRender,
  onPrepareRender,
  isRegisteredAsset,
}: DirectorStageProps) {
  const { t } = useI18n();
  const [historyState, setHistoryState] = useState(() =>
    createStageHistory(
      node.data.localStage
        ? parseLocalStageValue(node.data.localStage, t)
        : createLocalStage(t),
    ),
  );
  const commit = useEditorCommit(onClose);
  const stage = historyState.present;
  const history = useRef(historyState);
  const [selected, setSelected] = useState<string | null>(
      () => stage.objects[0]?.id ?? null,
    ),
    [error, setError] = useState(""),
    [playing, setPlaying] = useState(false),
    [time, setTime] = useState(0),
    [ready, setReady] = useState(false);
  const [inserted, setInserted] = useState(false);
  const [renderProgress, setRenderProgress] = useState<number | null>(null);
  const [assetRole, setAssetRole] = useState<StageAssetRole>("character");
  const [assetNotice, setAssetNotice] = useState("");
  const [pendingStill, setPendingStill] = useState<string | null>(null);
  const renderPublisher = useRef<
    ((result: LinkedMediaResult) => boolean | Promise<boolean>) | null
  >(null);
  const [rendered, setRendered] = useState<Blob | null>(null);
  const exporting = useRef<AbortController | null>(null);
  const mount = useRef<HTMLDivElement>(null),
    runtime = useRef<StageRuntime | null>(null),
    stageRef = useRef(stage),
    timeRef = useRef(time),
    playingRef = useRef(playing),
    selectedRef = useRef(selected),
    importInput = useRef<HTMLInputElement>(null),
    assetInput = useRef<HTMLInputElement>(null),
    ownedAssetUrls = useRef(new Set<string>()),
    active = useRef(true);
  stageRef.current = stage;
  timeRef.current = time;
  playingRef.current = playing;
  selectedRef.current = selected;
  const sampled = sampleStage(stage, time);
  const object = sampled.objects.find((item) => item.id === selected);
  const cameraValue = sampled.camera;
  const outputSize = stageOutputSize(stage.aspectRatio);
  // The frame sits centered at a comfortable size (a 16:9 stage is 900px
  // wide) and the timeline track, transport and storyboard match its width.
  const stageStackWidth = `min(100%, calc(min(60vh, 506px) * ${outputSize.width / outputSize.height}))`;
  const frameTimes = stageFrameTimes(stage);
  const installHistory = (next: StageHistory) => {
    if (next === history.current) return;
    history.current = next;
    stageRef.current = next.present;
    setHistoryState(next);
    setTime((current) => Math.min(current, next.present.duration));
    setPlaying(false);
    setRendered(null);
    setInserted(false);
    setError("");
    setAssetNotice("");
  };
  const edit = (
    operation: (value: LocalStageDocument) => LocalStageDocument,
  ) => {
    try {
      installHistory(
        commitStageHistory(history.current, operation(stageRef.current)),
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t("editors.stage.ui.editFailed"),
      );
    }
  };
  const navigate = (direction: "undo" | "redo") => {
    if (renderProgress !== null) return;
    installHistory(navigateStageHistory(history.current, direction));
  };
  const editObject = (patch: Partial<StageObject>) => {
    if (selected)
      edit((current) =>
        editStageObjectAt(current, selected, timeRef.current, patch),
      );
  };
  const editCamera = (patch: Partial<StageCamera>) =>
    edit((current) =>
      editStageCameraAt(
        current,
        sampleStage(current, timeRef.current).cameraId,
        timeRef.current,
        patch,
      ),
    );
  const updateClip = (id: string, patch: Partial<StageMotionClip>) => {
    if (object)
      editObject({
        motionClips: object.motionClips.map((clip) =>
          clip.id === id ? { ...clip, ...patch } : clip,
        ),
      });
  };
  const addMotionClip = () => {
    if (
      !object ||
      (object.kind !== "person" &&
        !(
          object.kind === "gltf" &&
          object.role === "character" &&
          object.hasAnimation
        ))
    )
      return;
    const start = timeRef.current;
    const next =
      object.motionClips.find((clip) => clip.start > start)?.start ??
      stage.duration;
    editObject({
      motionClips: [
        ...object.motionClips,
        {
          id: crypto.randomUUID(),
          start,
          duration: Math.min(2, next - start),
          motion: { preset: "walk", speed: 1, amount: 1 },
        },
      ],
    });
  };
  const updateShot = (id: string, patch: Partial<StageShot>) =>
    edit((current) => ({
      ...current,
      shots: current.shots.map((shot) =>
        shot.id === id ? { ...shot, ...patch } : shot,
      ),
    }));
  const addShot = () =>
    edit((current) => {
      const start = timeRef.current;
      const next =
        current.shots.find((shot) => shot.start > start)?.start ??
        current.duration;
      return {
        ...current,
        cameraSource: "storyboard",
        shots: [
          ...current.shots,
          {
            id: crypto.randomUUID(),
            cameraId: current.activeCameraId,
            start,
            duration: Math.min(2, next - start),
          },
        ],
      };
    });
  const addCamera = () =>
    edit((current) => {
      const id = crypto.randomUUID();
      return {
        ...current,
        // The duplicate becomes the edit target; camera management must not
        // silently flip storyboard-cut evaluation back to a single camera.
        activeCameraId: id,
        cameras: [
          ...current.cameras,
          {
            id,
            name: t("editors.stage.ui.cameraName", {
              number: current.cameras.length + 1,
            }),
            pose: sampleStage(current, timeRef.current).camera,
            keyframes: [],
          },
        ],
      };
    });
  const removeCamera = () =>
    edit((current) => {
      if (current.cameras.length === 1)
        throw new Error(t("editors.stage.ui.keepCamera"));
      const id = current.activeCameraId;
      if (current.shots.some((shot) => shot.cameraId === id))
        throw new Error(t("editors.stage.ui.cameraInUse"));
      const cameras = current.cameras.filter((camera) => camera.id !== id);
      return { ...current, cameras, activeCameraId: cameras[0]!.id };
    });
  const gestureEdit = useRef(edit);
  gestureEdit.current = edit;
  const shortcut = useRef(navigate);
  shortcut.current = navigate;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        !(target instanceof HTMLElement) ||
        !target.closest(".cw-stage-dialog") ||
        target.matches(
          "input:not([type=range]),textarea,select,[contenteditable=true]",
        )
      )
        return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.stopPropagation();
        shortcut.current(event.shiftKey ? "redo" : "undo");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    active.current = true;
    const container = mount.current;
    if (!container) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        preserveDrawingBuffer: true,
      });
    } catch (reason) {
      setError(
        t("editors.stage.ui.webglInit", {
          reason:
            reason instanceof Error ? reason.message : String(reason),
        }),
      );
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.append(renderer.domElement);
    const scene = new THREE.Scene(),
      camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.05, 1000),
      controls = new OrbitControls(camera, renderer.domElement),
      root = new THREE.Group();
    controls.enableDamping = false;
    controls.minDistance = 0.2;
    controls.maxDistance = 200;
    root.name = "stage-objects";
    scene.add(root);
    const grid = new THREE.GridHelper(30, 30, 0x535b76, 0x2b344b);
    scene.add(grid);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: 0x202737, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    ground.receiveShadow = true;
    scene.add(ground);
    scene.add(new THREE.HemisphereLight(0xe2e7ff, 0x3c3354, 2.6));
    const light = new THREE.DirectionalLight(0xffffff, 3.5);
    light.position.set(5, 10, 6);
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    scene.add(light);
    const fill = new THREE.DirectionalLight(0x8d88ff, 1.8);
    fill.position.set(-6, 5, -5);
    scene.add(fill);
    const current: StageRuntime = {
      renderer,
      scene,
      camera,
      controls,
      root,
      grid,
      imported: new Map(),
      assetCache: new Map(),
    };
    runtime.current = current;
    setCamera(current, sampleStage(stageRef.current, timeRef.current).camera);
    const resize = () => {
      const width = container.clientWidth;
      if (!width) return;
      const size = stageOutputSize(stageRef.current.aspectRatio);
      renderer.setSize(width, (width * size.height) / size.width, false);
      camera.aspect = size.width / size.height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    let gestureCameraId: string | null = null;
    const orbitStart = () => {
      setPlaying(false);
      playingRef.current = false;
      gestureCameraId = sampleStage(stageRef.current, timeRef.current).cameraId;
    };
    const orbitEnd = () => {
      if (!gestureCameraId) return;
      const id = gestureCameraId;
      gestureCameraId = null;
      const pose = {
        position: vector(camera.position),
        target: vector(controls.target),
        fov: camera.fov,
      };
      gestureEdit.current((current) =>
        editStageCameraAt(current, id, timeRef.current, pose),
      );
    };
    controls.addEventListener("start", orbitStart);
    controls.addEventListener("end", orbitEnd);
    const raycaster = new THREE.Raycaster(),
      pointer = new THREE.Vector2();
    let start: { x: number; y: number; pointerId: number } | null = null;
    const pointerDown = (event: PointerEvent) => {
      start =
        event.isPrimary && event.button === 0
          ? { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
          : null;
    };
    const pointerUp = (event: PointerEvent) => {
      const down = start;
      start = null;
      if (
        !down ||
        down.pointerId !== event.pointerId ||
        Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4
      )
        return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        (-(event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      let found: THREE.Object3D | undefined = raycaster.intersectObjects(
        root.children,
        true,
      )[0]?.object;
      while (found && !found.userData.objectId)
        found = found.parent ?? undefined;
      if (found) setSelected(found.userData.objectId as string);
    };
    const pointerCancel = () => {
      start = null;
    };
    renderer.domElement.addEventListener("pointercancel", pointerCancel);
    window.addEventListener("blur", pointerCancel);
    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointerup", pointerUp);
    const contextLost = (event: Event) => {
      event.preventDefault();
      setPlaying(false);
      setError(t("editors.stage.ui.webglLost"));
    };
    renderer.domElement.addEventListener("webglcontextlost", contextLost);
    let frame = 0;
    const render = () => {
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    render();
    setReady(true);
    return () => {
      active.current = false;
      exporting.current?.abort();
      setReady(false);
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.removeEventListener("start", orbitStart);
      controls.removeEventListener("end", orbitEnd);
      controls.dispose();
      renderer.domElement.removeEventListener("pointercancel", pointerCancel);
      window.removeEventListener("blur", pointerCancel);
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      renderer.domElement.removeEventListener("webglcontextlost", contextLost);
      disposeObject(scene);
      for (const pending of runtime.current?.assetCache.values() ?? [])
        void pending.then(
          (loaded) => disposeObject(loaded.scene),
          () => undefined,
        );
      for (const url of ownedAssetUrls.current) URL.revokeObjectURL(url);
      ownedAssetUrls.current.clear();
      light.shadow.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      runtime.current = null;
    };
  }, []);

  useEffect(() => {
    const current = runtime.current;
    if (!current) return;
    const objects = new Map(stage.objects.map((item) => [item.id, item]));
    for (const child of [...current.root.children]) {
      const item = objects.get(child.userData.objectId as string);
      const sourceChanged =
        item?.kind === "gltf" &&
        child.userData.assetSource !== item.source;
      if (!item || child.userData.objectKind !== item.kind || sourceChanged) {
        current.root.remove(child);
        // Loaded imported clones share GPU resources with the cached scene;
        // placeholders own theirs and must be disposed.
        if (child.userData.objectKind !== "gltf" || child.userData.placeholder)
          disposeObject(child);
        current.imported.delete(child.userData.objectId as string);
      }
    }
    for (const item of stage.objects) {
      const existing = current.root.children.find(
        (child) => child.userData.objectId === item.id,
      );
      if (!existing) current.root.add(buildObject(item));
      else if (item.kind !== "gltf")
        existing.traverse((child) => {
          if (child instanceof THREE.Mesh) {
            const materials = Array.isArray(child.material)
              ? child.material
              : [child.material];
            materials.forEach((material) => {
              if (material instanceof THREE.MeshStandardMaterial)
                material.color.set(item.color);
            });
          }
        });
    }
    // Loaded clones share GPU resources with their cached scene, so a cached
    // scene must stay resident while any live object or clone references it;
    // once the last one is gone, dispose instead of holding model-sized memory.
    const liveKeys = new Set<string>();
    for (const child of current.root.children) {
      const key = child.userData.assetCacheKey;
      if (typeof key === "string") liveKeys.add(key);
    }
    for (const item of stage.objects)
      if (item.kind === "gltf")
        liveKeys.add(item.asset?.assetId ?? item.source ?? "");
    for (const [key, pending] of [...current.assetCache]) {
      if (liveKeys.has(key)) continue;
      current.assetCache.delete(key);
      void pending.then(
        (loaded) => disposeObject(loaded.scene),
        () => undefined,
      );
    }
  }, [stage.objects, ready]);
  useEffect(() => {
    const current = runtime.current;
    if (!current || !ready) return;
    let cancelled = false;
    const load = async () => {
      for (const item of stage.objects) {
        if (item.kind !== "gltf") continue;
        if (!item.source) {
          if (item.asset) setError(t("editors.stage.ui.assetUnavailable"));
          continue;
        }
        const existing = current.root.children.find(
          (child) => child.userData.objectId === item.id,
        );
        if (
          existing?.userData.assetSource === item.source &&
          current.imported.has(item.id)
        )
          continue;
        try {
          const cacheKey = item.asset?.assetId ?? item.source;
          let pending = current.assetCache.get(cacheKey);
          if (!pending) {
            pending = loadStageAsset(item.source);
            current.assetCache.set(cacheKey, pending);
            // A failed load must not poison the cache; evict it so a later
            // effect run can retry.
            pending.catch(() => {
              if (current.assetCache.get(cacheKey) === pending)
                current.assetCache.delete(cacheKey);
            });
          }
          const loaded = await pending;
          if (cancelled || !active.current) return;
          const previous = current.root.children.find(
            (child) => child.userData.objectId === item.id,
          );
          if (previous) {
            current.root.remove(previous);
            if (previous.userData.placeholder) disposeObject(previous);
          }
          const group = cloneImportedAsset(item, loaded);
          group.userData.assetCacheKey = cacheKey;
          current.root.add(group);
          current.imported.set(
            item.id,
            createImportedRuntime(group, loaded.animations),
          );
          if (item.role === "character" && !loaded.animations.length)
            setAssetNotice(t("editors.stage.ui.assetNotice"));
          // The clone lands after the selection effect ran, so it must pick up
          // the highlight for the currently selected object itself.
          applySelectionHighlight(group, selectedRef.current);
          displayPose(current, sampleStage(stageRef.current, timeRef.current));
        } catch {
          if (!cancelled && active.current)
            setError(
              t("editors.stage.ui.assetLoadFailed", { name: item.name }),
            );
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [stage.objects, ready, t]);
  useEffect(() => {
    const current = runtime.current;
    if (!current) return;
    current.scene.background = new THREE.Color(stage.background);
    current.grid.visible = stage.grid;
  }, [stage.background, stage.grid, ready]);
  useEffect(() => {
    const current = runtime.current;
    if (!current) return;
    applySelectionHighlight(current.root, selected);
  }, [selected, stage.objects, ready]);
  useEffect(() => {
    if (!runtime.current) return;
    runtime.current.controls.enabled = renderProgress === null;
  }, [renderProgress, ready]);
  useEffect(() => {
    if (!runtime.current) return;
    const size = stageOutputSize(stage.aspectRatio);
    runtime.current.camera.aspect = size.width / size.height;
    const width = mount.current?.clientWidth ?? size.width;
    runtime.current.renderer.setSize(
      width,
      (width * size.height) / size.width,
      false,
    );
    displayPose(runtime.current, sampleStage(stage, time));
  }, [stage, time, ready]);
  useEffect(() => {
    if (!playing) return;
    const initial = timeRef.current,
      start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const next = Math.min(
        stageRef.current.duration,
        initial + (now - start) / 1000,
      );
      setTime(next);
      if (next >= stageRef.current.duration) {
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const addObject = (kind: StageObject["kind"]) => {
    const id = crypto.randomUUID();
    edit((current) => ({
      ...current,
      objects: [
        ...current.objects,
        {
          id,
          kind,
          name: `${t(titles[kind])} ${current.objects.length + 1}`,
          color:
            kind === "person"
              ? "#a09af9"
              : kind === "box"
                ? "#80c9c0"
                : "#e6aa6b",
          position: { x: current.objects.length * 1.3, y: 0, z: 0 },
          rotation: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 },
          keyframes: [],
          motionClips: [],
        },
      ],
    }));
    setSelected(id);
  };
  const removeObject = () => {
    if (!selected) return;
    edit((current) => ({
      ...current,
      objects: current.objects.filter((item) => item.id !== selected),
    }));
    setSelected(null);
  };
  const captureKeyframe = () =>
    edit((current) => captureStageFrame(current, timeRef.current));
  /** Same sampler and output frame as the MP4 render, at the encoder aspect. */
  const captureOutputStill = () => {
    const current = runtime.current;
    if (!current) throw new Error(t("editors.stage.ui.rendererNotReady"));
    const size = stageOutputSize(stageRef.current.aspectRatio);
    const dom = current.renderer.domElement;
    // setSize() takes CSS units while the drawing buffer multiplies by the
    // pixel ratio; save CSS units and pin the ratio to 1 so the still is
    // captured at exactly the encoder resolution on high-DPI displays.
    const previous = current.renderer.getSize(new THREE.Vector2());
    const ratio = current.renderer.getPixelRatio();
    const aspect = current.camera.aspect;
    current.renderer.setPixelRatio(1);
    current.renderer.setSize(size.width, size.height, false);
    current.camera.aspect = size.width / size.height;
    current.camera.updateProjectionMatrix();
    try {
      displayPose(current, sampleStage(stageRef.current, timeRef.current));
      current.renderer.render(current.scene, current.camera);
      return dom.toDataURL("image/png");
    } finally {
      current.renderer.setPixelRatio(ratio);
      current.renderer.setSize(previous.x, previous.y, false);
      current.camera.aspect = aspect;
      current.camera.updateProjectionMatrix();
      current.renderer.render(current.scene, current.camera);
    }
  };
  const captureStill = () => {
    try {
      setPendingStill(captureOutputStill());
      setAssetNotice(t("editors.stage.ui.stillCaptured"));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t("editors.stage.ui.screenshotFailed"),
      );
    }
  };
  const download = (content: string, name: string, mime: string) => {
    downloadFile(
      content.startsWith("data:")
        ? content
        : new Blob([content], { type: mime }),
      name,
    );
  };
  const importStage = async (file: File) => {
    try {
      const next = parseLocalStageDocument(await file.text(), t);
      const foreign = isRegisteredAsset
        ? unregisteredStageAssets(next, isRegisteredAsset)
        : [];
      if (foreign.length)
        throw new Error(
          t("editors.stage.ui.importForeignAssets", {
            names: foreign.map((object) => object.name).join(", "),
          }),
        );
      if (active.current) {
        edit(() => next);
        setTime(0);
        setSelected(next.objects[0]?.id ?? null);
      }
    } catch (reason) {
      if (active.current)
        setError(
          reason instanceof Error
            ? reason.message
            : t("editors.stage.ui.importFailed"),
        );
    }
  };
  const importAsset = async (file: File) => {
    const lowerName = file.name.toLowerCase();
    let source: string | undefined;
    try {
      if (!lowerName.endsWith(".glb") && !lowerName.endsWith(".gltf"))
        throw new Error(t("editors.stage.ui.assetUnsupported"));
      if (file.size > STAGE_ASSET_MAX_BYTES)
        throw new Error(
          t("editors.stage.ui.assetTooLarge", {
            name: file.name,
            size: STAGE_ASSET_MAX_BYTES / 1024 / 1024,
          }),
        );
      const probed = probeStageAsset(await file.arrayBuffer());
      if (probed === "corrupt")
        throw new Error(t("editors.stage.ui.assetCorrupt", { name: file.name }));
      if (!probed)
        throw new Error(
          t("editors.stage.ui.assetLoadFailed", { name: file.name }),
        );
      if (probed.external)
        throw new Error(t("editors.stage.ui.assetUnsupported"));
      // Self-contained but Draco/meshopt/KTX2-compressed: the loader has no
      // decoders, so say that instead of letting the parse fail as "corrupt".
      if (probed.compressed)
        throw new Error(t("editors.stage.ui.assetCompressed"));
      const url = URL.createObjectURL(file);
      source = url;
      ownedAssetUrls.current.add(url);
      let loaded: LoadedStageAsset;
      try {
        // Seed the shared cache so the effect run that follows this edit
        // reuses this load instead of parsing the same blob twice.
        const current = runtime.current;
        const pending = loadStageAsset(url);
        if (current) {
          current.assetCache.set(url, pending);
          pending.catch(() => {
            if (current.assetCache.get(url) === pending)
              current.assetCache.delete(url);
          });
        }
        loaded = await pending;
      } catch (reason) {
        console.debug("stage asset import failed", reason);
        throw new Error(
          t("editors.stage.ui.assetLoadFailed", { name: file.name }),
        );
      }
      const id = crypto.randomUUID();
      const name = file.name.replace(/\.(?:glb|gltf)$/i, "") || file.name;
      edit((current) => ({
        ...current,
        objects: [
          ...current.objects,
          {
            id,
            kind: "gltf",
            name,
            color: "#b8c5ff",
            role: assetRole,
            format: probed.format,
            source,
            animationNames: loaded.animations.map(
              // Fallback must match the backend probe's animation_{index}.
              (clip, index) => clip.name.trim() || `animation_${index}`,
            ),
            hasAnimation: loaded.animations.length > 0,
            position: { x: current.objects.length * 1.3, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
            keyframes: [],
            motionClips: [],
          },
        ],
      }));
      setSelected(id);
      setAssetNotice(
        loaded.animations.length
          ? t("editors.stage.ui.assetImported", {
              name,
              animationCount: loaded.animations.length,
            })
          : t("editors.stage.ui.assetImportedStatic", { name }),
      );
    } catch (reason) {
      if (source) {
        URL.revokeObjectURL(source);
        ownedAssetUrls.current.delete(source);
      }
      setError(
        reason instanceof Error
          ? reason.message
          : t("editors.stage.ui.assetLoadFailed", { name: file.name }),
      );
    }
  };

  const renderVideo = async () => {
    if (!runtime.current) return;
    const previewRuntime = runtime.current;
    const controller = new AbortController();
    exporting.current?.abort();
    exporting.current = controller;
    const exportStage = parseLocalStageValue(stageRef.current, t);
    setPlaying(false);
    setError("");
    setRendered(null);
    setInserted(false);
    setRenderProgress(0);
    let scene: THREE.Scene | undefined;
    const materials = new Map<THREE.Material, THREE.Material>();
    let renderer: THREE.WebGLRenderer | undefined;
    try {
      renderPublisher.current = onPrepareRender
        ? await onPrepareRender(exportStage)
        : onRender;
      controller.signal.throwIfAborted();
      // Snapshot the scene only after preparation: a model whose preview
      // load lands while preparing would otherwise export as its placeholder.
      scene = previewRuntime.scene.clone(true);
      const root = scene.getObjectByName("stage-objects")!;
      const renderImported = new Map<string, ImportedRuntime>();
      for (const [id, binding] of previewRuntime.imported) {
        const item = exportStage.objects.find((object) => object.id === id);
        const cloned = root.children.find(
          (child) => child.userData.objectId === id,
        );
        // Clone from the pristine cached scene, not the posed runtime clone,
        // so frames outside motion clips render the authored rest pose.
        const cached = previewRuntime.assetCache.get(
          item?.asset?.assetId ?? item?.source ?? "",
        );
        const source =
          (cached ? await cached.catch(() => undefined) : undefined)?.scene ??
          binding.root.children[0];
        if (!item || !cloned || !source) continue;
        const replacement = cloneImportedAsset(item, {
          scene: source,
          animations: binding.clips,
        });
        root.remove(cloned);
        root.add(replacement);
        renderImported.set(id, createImportedRuntime(replacement, binding.clips));
      }
      scene.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const clone = (source: THREE.Material) => {
          let material = materials.get(source);
          if (!material) {
            material = source.clone();
            if (material instanceof THREE.MeshStandardMaterial)
              material.emissive.set("#000000");
            materials.set(source, material);
          }
          return material;
        };
        child.material = Array.isArray(child.material)
          ? child.material.map(clone)
          : clone(child.material);
      });
      renderer = new THREE.WebGLRenderer({ antialias: true });
      const size = stageOutputSize(exportStage.aspectRatio);
      renderer.setSize(size.width, size.height);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.shadowMap.enabled = true;
      const camera = new THREE.PerspectiveCamera(
        45,
        size.width / size.height,
        0.05,
        1000,
      );
      const blob = await encodeMp4({
        canvas: renderer.domElement,
        duration: exportStage.duration,
        fps: 30,
        signal: controller.signal,
        progress: setRenderProgress,
        draw: (at) => {
          const pose = sampleStage(exportStage, at);
          camera.position.set(
            pose.camera.position.x,
            pose.camera.position.y,
            pose.camera.position.z,
          );
          camera.fov = pose.camera.fov;
          camera.updateProjectionMatrix();
          camera.lookAt(
            pose.camera.target.x,
            pose.camera.target.y,
            pose.camera.target.z,
          );
          for (const child of root.children) {
            const object = pose.objects.find(
              (item) => item.id === child.userData.objectId,
            );
            if (object) {
              applyTransform(child, object);
              poseJoints(child, object);
              applyImportedAnimation(renderImported, object);
            }
          }
          renderer!.render(scene!, camera);
        },
      });
      if (active.current && !controller.signal.aborted) setRendered(blob);
    } catch (reason) {
      if (active.current && !controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : t("editors.stage.ui.exportFailed"),
        );
    } finally {
      // Geometry stays shared with the preview; cloned materials, renderer and shadows are export-owned.
      scene?.traverse((child) => {
        if (child instanceof THREE.DirectionalLight) child.shadow.dispose();
      });
      materials.forEach((material) => material.dispose());
      renderer?.dispose();
      if (active.current && exporting.current === controller)
        setRenderProgress(null);
    }
  };
  const insertRender = async () => {
    if (!rendered) return;
    const controller = new AbortController();
    exporting.current = controller;
    setRenderProgress(1);
    try {
      const src = await mediaBlobDataUrl(rendered, controller.signal);
      const media = await withMediaDuration(
        { id: "rendered", kind: "video", title: node.data.title, src },
        controller.signal,
      );
      if (active.current && !controller.signal.aborted) {
        setInserted(
          await (renderPublisher.current ?? onRender)({
            kind: "video",
            src,
            mimeType: "video/mp4",
            title: t("editors.stage.ui.motionTitle", {
              title: node.data.title,
            }),
            media: {
              width: media.width,
              height: media.height,
              durationSeconds: media.durationSeconds,
            },
          }),
        );
      }
    } catch (reason) {
      if (active.current && !controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : t("editors.stage.ui.addCanvasFailed"),
        );
    } finally {
      if (active.current) setRenderProgress(null);
    }
  };
  return (
    <EditorModal
      title={t("editors.stage.ui.title", { title: node.data.title })}
      subtitle={t("editors.stage.ui.subtitle")}
      className="cw-stage-dialog"
      onClose={commit.close}
      onApply={() =>
        commit.apply(() =>
          onApply(
            parseLocalStageValue(stageRef.current, t),
            pendingStill ??
              (!node.data.stillAsset && runtime.current
                ? captureOutputStill()
                : undefined),
          ),
        )
      }
      disabled={node.locked || renderProgress !== null || commit.saving}
      error={commit.error || error}
      actions={
        <>
          <button
            disabled={!history.current.past.length || renderProgress !== null}
            onClick={() => navigate("undo")}
          >
            {t("editors.stage.ui.undo")}
          </button>
          <button
            disabled={!history.current.future.length || renderProgress !== null}
            onClick={() => navigate("redo")}
          >
            {t("editors.stage.ui.redo")}
          </button>
          <button
            disabled={renderProgress !== null}
            onClick={() => importInput.current?.click()}
          >
            {t("editors.stage.ui.importJson")}
          </button>
          <button
            onClick={() => {
              // Exports carry no model bytes: an import that exists only as a
              // browser URL would become an unopenable object, so name it.
              const unsaved = stageRef.current.objects.filter(
                (object) => object.kind === "gltf" && !object.asset,
              );
              if (unsaved.length) {
                setError(
                  t("editors.stage.ui.exportUnsavedImports", {
                    names: unsaved.map((object) => object.name).join(", "),
                  }),
                );
                return;
              }
              download(
                JSON.stringify(
                  {
                    ...stageRef.current,
                    objects: stageRef.current.objects.map(
                      ({ source: _source, ...object }) => object,
                    ),
                  },
                  null,
                  2,
                ),
                `${node.data.title || "director-stage"}.stage.json`,
                "application/json",
              );
            }}
          >
            {t("editors.stage.ui.exportJson")}
          </button>
          <button disabled={!ready} onClick={captureStill}>
            {t("editors.stage.ui.screenshot")}
          </button>
          <button
            disabled={!ready || renderProgress !== null}
            onClick={() => void renderVideo()}
          >
            {t("editors.stage.ui.renderMp4")}
          </button>
        </>
      }
    >
      <div className="cw-stage-shell">
        {renderProgress !== null && (
          <div className="cw-render-status" role="status">
            <progress value={renderProgress} max={1} />
            <span>
              {t("editors.stage.ui.renderProgress", {
                percent: Math.round(renderProgress * 100),
              })}
            </span>
            <button onClick={() => exporting.current?.abort()}>
              {t("editors.stage.ui.cancelRender")}
            </button>
          </div>
        )}
        {rendered && (
          <div className="cw-render-status" role="status">
            <span>
              {t("editors.stage.ui.renderDone", {
                width: outputSize.width,
                height: outputSize.height,
              })}
            </span>
            <button
              disabled={renderProgress !== null}
              onClick={() =>
                downloadFile(
                  rendered,
                  downloadFilename(
                    `${node.data.title}-${t("editors.stage.ui.previewSuffix")}`,
                    "video/mp4",
                  ),
                )
              }
            >
              {t("editors.stage.ui.downloadMp4")}
            </button>
            <button
              disabled={renderProgress !== null || node.locked || inserted}
              onClick={() => void insertRender()}
            >
              {inserted
                ? t("editors.stage.ui.addedToCanvas")
                : t("editors.stage.ui.addToCanvas")}
            </button>
          </div>
        )}
        <fieldset className="cw-editor-work" disabled={renderProgress !== null}>
          <div className="cw-stage-layout">
            <div className="cw-stage-main">
            <aside className="cw-stage-objects">
              <h3>{t("editors.stage.ui.sceneObjects")}</h3>
              <div className="cw-stage-add">
                {(["person", "box", "sphere"] as const).map((kind) => (
                  <button key={kind} onClick={() => addObject(kind)}>
                    + {t(titles[kind])}
                  </button>
                ))}
              </div>
              <label className="cw-domain-field">
                {t("editors.stage.ui.assetRole")}
                <select
                  value={assetRole}
                  onChange={(event) =>
                    setAssetRole(event.target.value as StageAssetRole)
                  }
                >
                  <option value="character">
                    {t("editors.stage.ui.assetCharacter")}
                  </option>
                  <option value="scene">
                    {t("editors.stage.ui.assetScene")}
                  </option>
                </select>
              </label>
              <button onClick={() => assetInput.current?.click()}>
                + {t("editors.stage.ui.importAsset")}
              </button>
              {assetNotice && (
                <p className="cw-domain-note" role="status">
                  {assetNotice}
                </p>
              )}
              <div className="cw-stage-object-list">
                {stage.objects.map((item) => (
                  <button
                    key={item.id}
                    aria-pressed={selected === item.id}
                    onClick={() => setSelected(item.id)}
                  >
                    <span style={{ background: item.color }} />
                    {item.name}
                  </button>
                ))}
              </div>
              <label className="cw-domain-field">
                {t("editors.stage.ui.background")}
                <input
                  type="color"
                  value={stage.background}
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      background: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="cw-domain-checkbox">
                <input
                  type="checkbox"
                  checked={stage.grid}
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      grid: event.target.checked,
                    }))
                  }
                />
                {t("editors.stage.ui.grid")}
              </label>
              <p className="cw-domain-note">
                {t("editors.stage.ui.orbitHint")}
                <br />
                {t("editors.stage.ui.selectHint")}
              </p>
            </aside>
            <section className="cw-stage-center">
              <div className="cw-stage-stack" style={{ width: stageStackWidth }}>
              <div
                className="cw-stage-viewport"
                style={{
                  aspectRatio: `${outputSize.width} / ${outputSize.height}`,
                }}
                ref={mount}
                role="img"
                aria-label={t("editors.stage.ui.stageAria")}
              />
              <div className="cw-stage-transport">
                <button
                  disabled={!ready}
                  onClick={() => {
                    if (time >= stage.duration) setTime(0);
                    setPlaying((current) => !current);
                  }}
                >
                  {playing
                    ? t("editors.stage.ui.pause")
                    : t("editors.stage.ui.playAction")}
                </button>
                <label>
                  {t("editors.stage.ui.currentTime")}
                  <NumberField
                    ariaLabel={t("editors.stage.ui.currentTimeAria")}
                    value={time}
                    min={0}
                    max={stage.duration}
                    decimals={2}
                    quantize
                    clamp
                    onCommit={(next) => {
                      setPlaying(false);
                      setTime(next);
                    }}
                  />
                </label>
                <label>
                  {t("editors.stage.ui.totalDuration")}
                  <NumberField
                    ariaLabel={t("editors.stage.ui.stageDurationAria")}
                    value={stage.duration}
                    min={0.1}
                    decimals={2}
                    onCommit={(duration) =>
                      edit((current) => ({ ...current, duration }))
                    }
                  />
                </label>
                <button onClick={captureKeyframe} disabled={!ready}>
                  {t("editors.stage.ui.recordKeyframe")}
                </button>
              </div>
              <ControlSlider
                aria-label={t("editors.stage.ui.playheadAria")}
                min={0}
                max={stage.duration}
                step={0.01}
                value={Math.min(time, stage.duration)}
                onChange={(event) => {
                  setPlaying(false);
                  setTime(Number(event.target.value));
                }}
              />
              <div className="cw-stage-keyframes">
                {frameTimes.map((frame) => (
                  <div key={frame}>
                    <button
                      onClick={() => {
                        setPlaying(false);
                        setTime(frame);
                      }}
                    >
                      {frame.toFixed(2)}s
                    </button>
                    <button
                      aria-label={t("editors.stage.ui.deleteKeyframe", {
                        frame,
                      })}
                      onClick={() =>
                        edit((current) => removeStageFrame(current, frame))
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
                {!frameTimes.length && (
                  <p>
                    {t("editors.stage.ui.keyframeHint")}
                  </p>
                )}
              </div>
              <section className="cw-stage-storyboard">
                <h3>{t("editors.stage.ui.storyboard")}</h3>
                <button onClick={addShot}>
                  {t("editors.stage.ui.addShot")}
                </button>
                <p className="cw-domain-note">
                  {t("editors.stage.ui.shotHint")}
                </p>
                {stage.shots.map((shot, index) => (
                  <div className="cw-stage-shot" key={shot.id}>
                    <label>
                      {t("editors.stage.ui.shot", { number: index + 1 })}
                      <select
                        aria-label={t("editors.stage.ui.shotCameraAria", {
                          number: index + 1,
                        })}
                        value={shot.cameraId}
                        onChange={(event) =>
                          updateShot(shot.id, { cameraId: event.target.value })
                        }
                      >
                        {stage.cameras.map((camera) => (
                          <option key={camera.id} value={camera.id}>
                            {camera.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {t("editors.stage.ui.startSeconds")}
                      <NumberField
                        ariaLabel={t("editors.stage.ui.shotStartAria", {
                          number: index + 1,
                        })}
                        value={shot.start}
                        min={0}
                        decimals={2}
                        onCommit={(start) => updateShot(shot.id, { start })}
                      />
                    </label>
                    <label>
                      {t("editors.stage.ui.durationSeconds")}
                      <NumberField
                        ariaLabel={t("editors.stage.ui.shotDurationAria", {
                          number: index + 1,
                        })}
                        value={shot.duration}
                        min={0.1}
                        decimals={2}
                        onCommit={(duration) =>
                          updateShot(shot.id, { duration })
                        }
                      />
                    </label>
                    <button
                      onClick={() => {
                        setPlaying(false);
                        setTime(shot.start);
                        edit((current) => ({
                          ...current,
                          cameraSource: "storyboard",
                        }));
                      }}
                    >
                      {t("editors.stage.ui.locate")}
                    </button>
                    <button
                      onClick={() =>
                        edit((current) => ({
                          ...current,
                          shots: current.shots.filter(
                            (item) => item.id !== shot.id,
                          ),
                        }))
                      }
                    >
                      {t("editors.stage.ui.deleteShot", {
                        number: index + 1,
                      })}
                    </button>
                  </div>
                ))}
              </section>
              </div>
            </section>
            </div>
            <aside className="cw-stage-inspector">
              <h3>
                {object
                  ? t("editors.stage.ui.transform")
                  : t("editors.stage.ui.camera")}
              </h3>
              {object && (
                <>
                  <label className="cw-domain-field">
                    {t("editors.stage.ui.name")}
                    <input
                      value={object.name}
                      onChange={(event) =>
                        editObject({ name: event.target.value })
                      }
                    />
                  </label>
                  {object.kind !== "gltf" && (
                    <label className="cw-domain-field">
                      {t("editors.stage.ui.material")}
                      <input
                        type="color"
                        value={object.color}
                        onChange={(event) =>
                          editObject({ color: event.target.value })
                        }
                      />
                    </label>
                  )}
                  {object.kind === "gltf" && (
                    <p className="cw-domain-note" role="status">
                      {object.role === "character"
                        ? t("editors.stage.ui.assetCharacter")
                        : t("editors.stage.ui.assetScene")}
                      {" · "}
                      {object.hasAnimation
                        ? t("editors.stage.ui.assetImported", {
                            name: object.name,
                            animationCount: object.animationNames?.length ?? 0,
                          })
                        : t("editors.stage.ui.assetImportedStatic", {
                            name: object.name,
                          })}
                    </p>
                  )}
                  {(object.kind === "person" ||
                    (object.kind === "gltf" &&
                      object.role === "character" &&
                      object.hasAnimation)) && (
                    <section className="cw-stage-clips">
                      <h3>{t("editors.stage.ui.motionClips")}</h3>
                      <button onClick={addMotionClip}>
                        {t("editors.stage.ui.addMotion")}
                      </button>
                      <p className="cw-domain-note">
                        {t("editors.stage.ui.motionHint")}
                      </p>
                      {object.motionClips.map((clip, index) => (
                        <div className="cw-stage-clip" key={clip.id}>
                          <label>
                            {t("editors.stage.ui.motion", {
                              number: index + 1,
                            })}
                            <select
                              aria-label={t("editors.stage.ui.motionAria", {
                                number: index + 1,
                              })}
                              value={clip.motion.preset}
                              onChange={(event) =>
                                updateClip(clip.id, {
                                  motion: {
                                    ...clip.motion,
                                    preset: event.target
                                      .value as keyof typeof STAGE_MOTIONS,
                                  },
                                })
                              }
                            >
                              {Object.entries(STAGE_MOTIONS).map(
                                ([id, label]) => (
                                  <option key={id} value={id}>
                                    {t(label)}
                                  </option>
                                ),
                              )}
                            </select>
                          </label>
                          <label>
                            {t("editors.stage.ui.startSeconds")}
                            <NumberField
                              ariaLabel={t(
                                "editors.stage.ui.motionStartAria",
                                { number: index + 1 },
                              )}
                              value={clip.start}
                              min={0}
                              decimals={2}
                              onCommit={(start) =>
                                updateClip(clip.id, { start })
                              }
                            />
                          </label>
                          <label>
                            {t("editors.stage.ui.durationSeconds")}
                            <NumberField
                              ariaLabel={t(
                                "editors.stage.ui.motionDurationAria",
                                { number: index + 1 },
                              )}
                              value={clip.duration}
                              min={0.1}
                              decimals={2}
                              onCommit={(duration) =>
                                updateClip(clip.id, { duration })
                              }
                            />
                          </label>
                          <label>
                            {t("editors.stage.ui.speed")}
                            <NumberField
                              ariaLabel={t(
                                "editors.stage.ui.motionSpeedAria",
                                { number: index + 1 },
                              )}
                              value={clip.motion.speed}
                              min={0.1}
                              decimals={2}
                              onCommit={(speed) =>
                                updateClip(clip.id, {
                                  motion: { ...clip.motion, speed },
                                })
                              }
                            />
                          </label>
                          <label>
                            {t("editors.stage.ui.amplitude")}
                            <input
                              aria-label={t(
                                "editors.stage.ui.motionAmplitudeAria",
                                { number: index + 1 },
                              )}
                              type="range"
                              min={0}
                              max={1}
                              step={0.05}
                              value={clip.motion.amount}
                              onChange={(event) =>
                                updateClip(clip.id, {
                                  motion: {
                                    ...clip.motion,
                                    amount: Number(event.target.value),
                                  },
                                })
                              }
                            />
                          </label>
                          <button
                            onClick={() => {
                              setPlaying(false);
                              setTime(clip.start);
                            }}
                          >
                             {t("editors.stage.ui.locate")}
                          </button>
                          <button
                            onClick={() =>
                              editObject({
                                motionClips: object.motionClips.filter(
                                  (item) => item.id !== clip.id,
                                ),
                              })
                            }
                          >
                            {t("editors.stage.ui.deleteMotion", {
                        number: index + 1,
                      })}
                          </button>
                        </div>
                      ))}
                    </section>
                  )}
                  <VectorFields
                    label={t("editors.stage.ui.position")}
                    value={object.position}
                    onChange={(position) => editObject({ position })}
                  />
                  <VectorFields
                    label={t("editors.stage.ui.rotation")}
                    value={object.rotation}
                    rotation
                    onChange={(rotation) => editObject({ rotation })}
                  />
                  <VectorFields
                    label={t("editors.stage.ui.scale")}
                    value={object.scale}
                    min={0.01}
                    onChange={(scale) => editObject({ scale })}
                  />
                  <button onClick={removeObject}>
                    {t("editors.stage.ui.deleteObject")}
                  </button>
                </>
              )}
              <h3>
                {t("editors.stage.ui.cameraLabel")}{" "}
                {
                  stage.cameras.find((camera) => camera.id === sampled.cameraId)
                    ?.name
                }
              </h3>
              <label className="cw-domain-field">
                {t("editors.stage.ui.editCamera")}
                <select
                  aria-label={t("editors.stage.ui.editCamera")}
                  value={sampled.cameraId}
                  onChange={(event) =>
                    edit((current) => {
                      const cameraId = event.target.value;
                      // Retarget the camera that evaluates at the playhead;
                      // choosing an edit target must not flip the evaluation
                      // strategy between the active camera and storyboard cuts.
                      const { shot } = stageCameraAt(current, timeRef.current);
                      return shot
                        ? {
                            ...current,
                            shots: current.shots.map((item) =>
                              item.id === shot.id ? { ...item, cameraId } : item,
                            ),
                          }
                        : { ...current, activeCameraId: cameraId };
                    })
                  }
                >
                  {stage.cameras.map((camera) => (
                    <option value={camera.id} key={camera.id}>
                      {camera.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="cw-domain-field">
                {t("editors.stage.ui.cameraNameAria")}
                <input
                  aria-label={t("editors.stage.ui.cameraNameAria")}
                  value={
                    stage.cameras.find(
                      (camera) => camera.id === sampled.cameraId,
                    )?.name ?? ""
                  }
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      cameras: current.cameras.map((camera) =>
                        camera.id === sampled.cameraId
                          ? { ...camera, name: event.target.value }
                          : camera,
                      ),
                    }))
                  }
                />
              </label>
              <div className="cw-stage-camera-actions">
                <button onClick={addCamera}>
                  {t("editors.stage.ui.copyCamera")}
                </button>
                <button
                  disabled={
                    stage.cameras.length === 1 ||
                    stage.cameraSource === "storyboard"
                  }
                  onClick={removeCamera}
                >
                  {t("editors.stage.ui.deleteCamera")}
                </button>
              </div>
              <label className="cw-domain-field">
                {t("editors.stage.ui.outputAspect")}
                <select
                  aria-label={t("editors.stage.ui.outputAspectAria")}
                  value={stage.aspectRatio}
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      aspectRatio: event.target
                        .value as LocalStageDocument["aspectRatio"],
                    }))
                  }
                >
                  {STAGE_RATIOS.map((ratio) => (
                    <option key={ratio} value={ratio}>
                      {ratio}
                    </option>
                  ))}
                </select>
              </label>
              <label className="cw-domain-field">
                {t("editors.stage.ui.source")}
                <select
                  aria-label={t("editors.stage.ui.sourceAria")}
                  value={stage.cameraSource}
                  onChange={(event) =>
                    edit((current) => ({
                      ...current,
                      cameraSource: event.target
                        .value as LocalStageDocument["cameraSource"],
                    }))
                  }
                >
                  <option value="camera">
                    {t("editors.stage.ui.currentCamera")}
                  </option>
                  <option value="storyboard">
                    {t("editors.stage.ui.storyboardCut")}
                  </option>
                </select>
              </label>
              <VectorFields
                label={t("editors.stage.ui.cameraShort")}
                value={cameraValue.position}
                onChange={(position) => editCamera({ position })}
              />
              <VectorFields
                label={t("editors.stage.ui.target")}
                value={cameraValue.target}
                onChange={(target) => editCamera({ target })}
              />
              <label className="cw-domain-field">
                {t("editors.stage.ui.focal")}
                <NumberField
                  ariaLabel={t("editors.stage.ui.focal")}
                  value={focalLength(cameraValue.fov)}
                  min={1}
                  decimals={1}
                  onCommit={(focal) => editCamera({ fov: fovFromFocal(focal) })}
                />
              </label>
              <label className="cw-domain-field">
                {t("editors.stage.ui.verticalFov", {
                   value: cameraValue.fov.toFixed(1),
                 })}
                <input
                  type="range"
                  min={10}
                  max={120}
                  step={0.1}
                  value={cameraValue.fov}
                  onChange={(event) =>
                    editCamera({ fov: Number(event.target.value) })
                  }
                />
              </label>
              <button
                onClick={() => {
                  setSelected(null);
                  editCamera(defaultStageCamera());
                }}
              >
                {t("editors.stage.ui.resetCamera")}
              </button>
            </aside>
          </div>
          <input
            className="cw-domain-file-input"
            ref={importInput}
            type="file"
            accept="application/json,.json"
            aria-label={t("editors.stage.ui.importAria")}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importStage(file);
              event.target.value = "";
            }}
          />
          <input
            className="cw-domain-file-input"
            ref={assetInput}
            type="file"
            accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
            aria-label={t("editors.stage.ui.importAsset")}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importAsset(file);
              event.target.value = "";
            }}
          />
        </fieldset>
          <p className="cw-domain-note">
            {t("editors.stage.ui.footerHint")}
          </p>
      </div>
    </EditorModal>
  );
}
export default DirectorStage;
