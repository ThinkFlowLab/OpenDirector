/** Turn index of a conversation on the Trace page, and the per-turn runtime choices. */
import { normalizeClaudeTrace } from "./claudeTrace.ts";
import { normalizeCodexTrace } from "./codexTrace.ts";
import { normalizeDeepseekTrace } from "./deepseekTrace.ts";
import { normalizePiTrace } from "./piTrace.ts";

export type ConversationTurn = {
  id: string;
  number: number;
  text: string;
  runtime: string;
  model: string | null;
  status: "streaming" | "complete" | "stopped" | "interrupted";
};

const RUNTIME_NAMES: Record<string, string> = {
  default: "OpenCode", opencode: "OpenCode", codex: "Codex", claude: "Claude Code",
  jiuwenswarm: "JiuwenSwarm", deepseek: "DeepSeek Harness", pi: "Pi",
};

/** The Default runtime logs under the opencode source. */
export const traceRuntime = (runtime: string) => runtime === "default" ? "opencode" : runtime;

export const runtimeName = (runtime: string) => RUNTIME_NAMES[runtime] ?? runtime;

/** Log sources read for a runtime. Only opencode records raw model requests. */
export const traceSources = (runtime: string) => runtime === "opencode" ? ["model", runtime] : [runtime];

/** Each runtime keeps its own log format; the page never applies one runtime's parser to another turn. */
export function normalizeTrace(source: string, body: string): string {
  return source === "deepseek" ? normalizeDeepseekTrace(body)
    : source === "codex" ? normalizeCodexTrace(body)
    : source === "claude" ? normalizeClaudeTrace(body)
    : source === "pi" ? normalizePiTrace(body)
    : body;
}

/** The linked turn if the conversation lists it, otherwise the latest turn. */
export function initialTurn(turns: ConversationTurn[], target: string): string {
  return turns.some((item) => item.id === target) ? target : turns.at(-1)?.id ?? "";
}
