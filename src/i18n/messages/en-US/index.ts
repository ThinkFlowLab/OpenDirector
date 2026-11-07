import { voiceLibrary } from "./voiceLibrary.ts";
import { trace } from "./trace.ts";
import { modelSetup } from "./modelSetup.ts";
import type { MessageEntry } from "../../types.ts";
import { api } from "./api.ts";
import { assistant } from "./assistant.ts";
import { canvas } from "./canvas.ts";
import { canvasNodes } from "./canvasNodes.ts";
import { canvasShell } from "./canvasShell.ts";
import { canvasWorkspace } from "./canvasWorkspace.ts";
import { common } from "./common.ts";
import { editors } from "./editors.ts";
import { errors } from "./errors.ts";
import { generation } from "./generation.ts";
import { library } from "./library.ts";
import { models } from "./models.ts";
import { settings } from "./settings.ts";
import { timeline } from "./timeline.ts";
import { tools } from "./tools.ts";

type ZhCatalog = typeof import("../zh-CN/index.ts").zhCN;

/** `Record<keyof ZhCatalog, ...>` makes a missing English key a compile error. */
export const enUS: Record<keyof ZhCatalog, MessageEntry> = {
  ...common,
  ...voiceLibrary,
  ...settings,
  ...modelSetup,
  ...trace,
  ...canvas,
  ...canvasShell,
  ...canvasNodes,
  ...canvasWorkspace,
  ...generation,
  ...tools,
  ...editors,
  ...timeline,
  ...library,
  ...assistant,
  ...models,
  ...api,
  ...errors,
};
