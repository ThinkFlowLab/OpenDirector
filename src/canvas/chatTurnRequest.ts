import { builtinThinking } from "./agentPreferences.ts";
import type {
  AgentRuntime,
  Conversation,
  ModelSelections,
  Thinking,
} from "../backend/chat.ts";
import type { ReferenceContent } from "./chatReferenceContent";

/** The turn being edited: a stopped attempt and the draft it is replacing. */
export interface ChatEditing {
  turnId: string;
  conversationId: string;
  saved: Pick<Conversation, "draft" | "draftContent" | "assets" | "skills">;
}

export interface TurnRequest {
  id: string;
  conversationId?: string;
  modelId?: string;
  runtime: AgentRuntime;
  runtimeModel?: string | null;
  text: string;
  content?: ReferenceContent | null;
  assets: string[];
  thinking: Thinking;
  modelSelections: ModelSelections;
  skills: string[];
  /** The turn this request replaces. Absent for an ordinary turn. */
  revisionOf?: string;
  /** The conversation revision this request was composed against. */
  expectedRevision?: number;
}

/**
 * The request body for a turn, including the identity an edit must carry so the
 * server can validate it against the conversation it was composed on.
 */
export function turnRequest(
  input: Conversation,
  {
    id,
    modelId,
    editing,
    revision,
  }: {
    id: string;
    modelId?: string;
    editing: ChatEditing | null;
    revision?: number;
  },
): TurnRequest {
  return {
    id,
    conversationId: input.conversationId,
    modelId,
    runtime: input.runtime ?? "default",
    runtimeModel: input.runtimeModel,
    text: input.draft,
    content: input.draftContent,
    assets: input.assets.map((asset) => asset.id),
    thinking: builtinThinking(input, modelId),
    modelSelections: input.modelSelections,
    skills: input.skills ?? [],
    ...(editing
      ? { revisionOf: editing.turnId, expectedRevision: revision }
      : {}),
  };
}
