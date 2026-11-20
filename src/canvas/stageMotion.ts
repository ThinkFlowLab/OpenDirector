/** Original articulated mannequin motions, sampled in seconds independently of frame rate. */
import type { MessageKey } from "../i18n/types.ts";
import { tNow } from "../i18n/messages.ts";

export const STAGE_MOTIONS = {
  idle: "errors.stage.motionIdle",
  walk: "errors.stage.motionWalk",
  run: "errors.stage.motionRun",
  wave: "errors.stage.motionWave",
} as const satisfies Record<string, MessageKey>;
export interface StageMotion {
  preset: keyof typeof STAGE_MOTIONS;
  speed: number;
  amount: number;
}
/** Name hints that map a procedural motion preset onto imported animation clips. */
export const STAGE_ANIMATION_HINTS: Record<
  StageMotion["preset"],
  readonly string[]
> = {
  idle: ["idle", "rest", "stand", "default"],
  walk: ["walk", "walking"],
  run: ["run", "running"],
  wave: ["wave", "waving"],
};
/** Clip choice for a preset: first clip whose name contains a hint, else the first clip. */
export function selectStageAnimation<T extends { name: string }>(
  clips: readonly T[],
  preset: StageMotion["preset"],
): T | undefined {
  const hints = STAGE_ANIMATION_HINTS[preset];
  return (
    clips.find((clip) =>
      hints.some((hint) => clip.name.toLowerCase().includes(hint)),
    ) ?? clips[0]
  );
}
export interface JointPose {
  hipsY: number;
  leftHip: number;
  rightHip: number;
  leftKnee: number;
  rightKnee: number;
  leftShoulderX: number;
  rightShoulderX: number;
  rightShoulderZ: number;
  leftElbow: number;
  rightElbow: number;
}
export function parseStageMotion(value: unknown): StageMotion {
  if (!value || typeof value !== "object")
    throw new Error(tNow("errors.stage.invalidMotion"));
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.preset !== "string" ||
    !Object.hasOwn(STAGE_MOTIONS, raw.preset) ||
    typeof raw.speed !== "number" ||
    !Number.isFinite(raw.speed) ||
    raw.speed <= 0 ||
    typeof raw.amount !== "number" ||
    !Number.isFinite(raw.amount) ||
    raw.amount < 0 ||
    raw.amount > 1
  )
    throw new Error(tNow("errors.stage.invalidMotionValue"));
  return {
    preset: raw.preset as StageMotion["preset"],
    speed: raw.speed,
    amount: raw.amount,
  };
}
export function sampleJointPose(
  motion: StageMotion | undefined,
  time: number,
): JointPose {
  const pose: JointPose = {
    hipsY: 0,
    leftHip: 0,
    rightHip: 0,
    leftKnee: 0,
    rightKnee: 0,
    leftShoulderX: 0,
    rightShoulderX: 0,
    rightShoulderZ: 0,
    leftElbow: 0,
    rightElbow: 0,
  };
  if (!motion || motion.preset === "idle") return pose;
  const phase = time * motion.speed * Math.PI * 2,
    amount = motion.amount;
  if (motion.preset === "wave") {
    pose.rightShoulderZ = 2.5 * amount;
    pose.rightElbow = (-0.7 + Math.sin(phase) * 0.5) * amount;
  } else {
    const running = motion.preset === "run",
      swing = Math.sin(phase) * (running ? 0.95 : 0.55) * amount;
    pose.hipsY = Math.abs(Math.sin(phase)) * (running ? 0.15 : 0.04) * amount;
    pose.leftHip = swing;
    pose.rightHip = -swing;
    pose.leftKnee =
      Math.max(0, -Math.sin(phase)) * (running ? 1.5 : 0.65) * amount;
    pose.rightKnee =
      Math.max(0, Math.sin(phase)) * (running ? 1.5 : 0.65) * amount;
    pose.leftShoulderX = -swing;
    pose.rightShoulderX = swing;
    pose.leftElbow = pose.rightElbow = (running ? -1.1 : -0.2) * amount;
  }
  return pose;
}
