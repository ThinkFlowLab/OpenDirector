import type { MessageKey } from "../i18n/types";
import type { CanvasNodeKind } from "./model.ts";

/** Keep the creation menu and the left rail in the same order. */
export const CANVAS_CREATION_TOOLS: readonly {
  kind: CanvasNodeKind;
  labelKey: MessageKey;
  icon: string;
  unavailable?: boolean;
}[] = [
  { kind: "text", labelKey: "canvas.kind.text", icon: "text" },
  { kind: "image", labelKey: "canvas.kind.image", icon: "image" },
  { kind: "video", labelKey: "canvas.kind.video", icon: "video" },
  { kind: "audio", labelKey: "canvas.kind.audio", icon: "audio" },
  { kind: "timeline", labelKey: "canvas.kind.timeline", icon: "timeline" },
  { kind: "subject", labelKey: "canvas.kind.subject", icon: "subject" },
  {
    kind: "tool",
    labelKey: "canvas.kind.directorToolbox",
    icon: "rail-tool",
    unavailable: true,
  },
  {
    kind: "external",
    labelKey: "canvas.kind.external",
    icon: "rail-stage",
  },
];
