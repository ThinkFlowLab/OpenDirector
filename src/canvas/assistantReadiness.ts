import type { RuntimeInfo } from "../backend/chat.ts";

/** A settings-backed engine is ready but has no conversation model to run.
 * The send button stays disabled, so the panel explains why and links to
 * the model settings instead of failing silently. */
export function needsAgentModel(
  loaded: boolean,
  runtime: Pick<RuntimeInfo, "status" | "modelSource"> | undefined,
  hasAgent: boolean,
): boolean {
  return loaded && runtime?.status === "ready" && runtime.modelSource === "settings" && !hasAgent;
}
