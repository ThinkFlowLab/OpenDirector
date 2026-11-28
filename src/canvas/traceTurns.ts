/** Turn index of a conversation on the Trace page, and the per-turn runtime choices. */
export type ConversationTurn = {
  id: string;
  number: number;
  text: string;
  runtime: string;
  model: string | null;
  status: "streaming" | "complete" | "stopped" | "interrupted";
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
};

const RUNTIME_NAMES: Record<string, string> = {
  default: "OpenCode", opencode: "OpenCode", codex: "Codex", claude: "Claude Code",
  jiuwenswarm: "JiuwenSwarm", deepseek: "DeepSeek Harness",
};

/** The Default runtime logs under the opencode source. */
export const traceRuntime = (runtime: string) => runtime === "default" ? "opencode" : runtime;

export const runtimeName = (runtime: string) => RUNTIME_NAMES[runtime] ?? runtime;

/** Log sources read for a runtime. Only opencode records raw model requests. */
export const traceSources = (runtime: string) => runtime === "opencode" ? ["model", runtime] : [runtime];

/** The linked turn if the conversation lists it, otherwise the latest turn. */
export function initialTurn(turns: ConversationTurn[], target: string): string {
  return turns.some((item) => item.id === target) ? target : turns.at(-1)?.id ?? "";
}
