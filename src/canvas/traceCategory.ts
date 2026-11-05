/** Semantic colors are shared by every harness, independent of its event names. */
export type TraceCategory =
  | "system" | "user" | "context" | "reasoning" | "tool" | "assistant" | "model" | "event";

export function traceCategory(type?: string, role?: string): TraceCategory {
  if (role === "system" || role === "developer" || type === "system") return "system";
  if (role === "user" || type === "user" || type === "user_message") return "user";
  if (type === "plan" || type === "context" || type === "session_meta" || type === "turn_context") return "context";
  if (type === "reasoning" || type === "model.reasoning" || type === "reasoning_summary") return "reasoning";
  if (role === "tool" || ["tool", "tool_use", "tool_result", "command_execution", "function_call", "function_call_output", "chat.tool_call", "chat.tool_result"].includes(type ?? "")) return "tool";
  if (role === "assistant" || ["assistant", "text", "agent_message", "chat.delta"].includes(type ?? "")) return "assistant";
  if (type?.startsWith("model.") || type?.startsWith("step_")) return "model";
  return "event";
}
