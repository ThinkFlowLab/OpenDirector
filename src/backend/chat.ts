import { assistant as chineseAssistant } from "../i18n/messages/zh-CN/assistant.ts";
import type { ReferenceContent } from "../canvas/chatReferenceContent.ts";
import { defaultTranslate } from "../canvas/assistantTranslate.ts";
import type { Translate } from "../i18n/I18nProvider.tsx";
import { json, request, responseError, sessionFetch } from "./api.ts";

export type AgentRuntime =
  | "default"
  | "opencode"
  | "codex"
  | "claude"
  | "jiuwenswarm"
  | "deepseek";
export interface RuntimeInfo {
  id: AgentRuntime;
  label: string;
  group: "default" | "harness";
  modelSource: "settings" | "cli";
  modelOverride: boolean;
  available: boolean;
  status:
    | "checking"
    | "ready"
    | "not_installed"
    | "needs_login"
    | "needs_configuration"
    | "unsupported_version"
    | "unknown";
  supportsSkills?: boolean;
}
export interface ChatSkill {
  source?: "builtin" | "workspace" | "project";
  name: string;
  description: string;
}

export interface ChatTool {
  id: string;
  name: string;
  status: "running" | "complete" | "failed" | "interrupted";
  textOffset: number;
  error?: string | null;
  code?: string;
  message?: string | null;
  taskId?: string | null;
  arguments?: Record<string, unknown>;
  result?: string;
  resultTruncated?: boolean;
}
export interface ConversationSummary {
  id: string;
  title: string | null;
  messageCount: number;
  hasDraft: boolean;
}
export interface ChatPlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
}
export interface ChatSource {
  id: string;
  url: string;
  title: string;
}
export type InteractionMode = "auto" | "ask";

export interface DecisionOption {
  id: string;
  label: string;
  impact: string;
}

export interface DecisionQuestion {
  id: string;
  question: string;
  multiSelect?: boolean;
  required?: boolean;
  defaultOptionIds?: string[];
  defaultText?: string | null;
  options: DecisionOption[];
}

export type AnswerSource = "options" | "custom" | "default";

export interface QuestionAnswerItem {
  questionId: string;
  source: AnswerSource;
  selectedOptionIds: string[];
  selectedLabels?: string[];
  customText?: string | null;
  displayText?: string;
}

export type DecisionStatus =
  | "waiting_input"
  | "answer_saved"
  | "resuming"
  | "completed"
  | "invalidated"
  | "resume_failed"
  | "status_unknown";

export interface DecisionRecord {
  requestId: string;
  taskId: string;
  conversationId: string;
  turnId: string;
  messageId: string;
  stage: string;
  planRevision: number;
  questions: DecisionQuestion[];
  status: DecisionStatus;
  answers?: QuestionAnswerItem[] | null;
  answerFingerprint?: string | null;
  continuationId?: string | null;
  error?: string | null;
  errorCode?: string | null;
}

export interface VersionedPlanStep {
  kind?: "write" | "read" | "inspection";
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "failed";
}

export interface VersionedPlan {
  revision: number;
  summary: string;
  steps: VersionedPlanStep[];
  updatedAtTurnId: string;
}

export type LogicalTaskStage =
  | "running"
  | "planning"
  | "waiting_input"
  | "answer_saved"
  | "resuming"
  | "waiting_confirmation"
  | "executing"
  | "waiting_jobs"
  | "execution_failed"
  | "completed"
  | "interrupted"
  | "status_unknown";

export interface LogicalTaskRecord {
  taskId: string;
  conversationId: string;
  mode: InteractionMode;
  runtime: AgentRuntime;
  planOnly?: boolean;
  stage: LogicalTaskStage;
  planRevision: number;
  plan?: VersionedPlan | null;
  confirmedPlanRevision?: number | null;
  executionContinuationId?: string | null;
  activeDecisionId?: string | null;
  pendingContinuationId?: string | null;
  segmentTurnIds: string[];
  error?: string | null;
}

export interface ChatMessage {
  sources?: ChatSource[];
  plan?: ChatPlanEntry[];
  runtime?: AgentRuntime;
  tools?: ChatTool[];
  id: string;
  role: "user" | "assistant";
  text: string;
  content?: ReferenceContent | null;
  status: "complete" | "streaming" | "stopped" | "interrupted";
  assets?: ChatAsset[];
  model?: string | null;
  modelIsCliDefault?: boolean;
  runtimeModel?: string | null;
  thinking?: Thinking;
  source?: "preview" | "model";
  mode?: InteractionMode;
  turnId?: string;
  taskId?: string;
  segmentKind?: "continuation" | "execution";
  parentRequestId?: string;
  decisionRequestId?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  durationMs?: number | null;
}

export type Thinking = "auto" | "low" | "medium" | "high";
export interface AssistantModelSelection {
  runtime: AgentRuntime;
  modelId?: string;
  runtimeModel?: string | null;
  thinking: Thinking;
}
export type ModelSelections = Partial<
  Record<"agent" | "image" | "video" | "audio", string | null>
>;
export interface ChatAsset {
  id: string;
  name: string;
  type: string;
  size: number;
  fingerprint: string;
}
export interface ChatDraft {
  conversationId?: string;
  draft: string;
  draftContent?: ReferenceContent | null;
  assets: ChatAsset[];
  thinking: Thinking;
  builtinModelThinking?: Record<string, Thinking>;
  modelSelections: ModelSelections;
  runtime?: AgentRuntime;
  runtimeModel?: string | null;
  harnessModels?: Partial<
    Record<Exclude<AgentRuntime, "default">, string | null>
  >;
  skills?: string[];
}
export interface Conversation extends ChatDraft {
  messages: ChatMessage[];
  decisions?: DecisionRecord[];
  tasks?: LogicalTaskRecord[];
}

export function draftContentIsEmpty(
  content: Conversation["draftContent"] | undefined,
) {
  if (!content || content.length === 0) return true;
  return content.every(
    (part) =>
      part.type === "text" &&
      typeof part.text === "string" &&
      !part.text.trim(),
  );
}

export function conversationIsEmpty(value: Conversation) {
  return (
    value.messages.length === 0 &&
    !value.draft.trim() &&
    value.assets.length === 0 &&
    !(value.skills && value.skills.length) &&
    draftContentIsEmpty(value.draftContent)
  );
}

export type ChatEvent =
  | { type: "start"; turnId?: string; conversation: Conversation }
  | { type: "queued"; message: ChatMessage }
  | { type: "thinking" }
  | { type: "plan"; entries: ChatPlanEntry[] }
  | ({ type: "tool" } & ChatTool)
  | { type: "delta"; text: string }
  | { type: "sources"; sources: ChatSource[] }
  | { type: "decision"; decision: DecisionRecord; task?: LogicalTaskRecord | null }
  | { type: "task"; task: LogicalTaskRecord }
  | { type: "end"; turnId?: string; nextTurnId?: string | null; conversation: Conversation | null; error: string | null };

export interface ChatRequest {
  conversationId?: string;
  id: string;
  modelId?: string;
  text: string;
  content?: ReferenceContent | null;
  assets: string[];
  thinking: Thinking;
  modelSelections: ModelSelections;
  runtime?: AgentRuntime;
  runtimeModel?: string | null;
  skills?: string[];
  mode?: InteractionMode;
  planOnly?: boolean;
}

function normalizeConversation(value: Conversation): Conversation {
  const messages = value.messages.map((message, index) => {
    const previous = value.messages[index - 1];
    // Older replies stored the fallback label before the API exposed its source.
    if (message.role === "assistant" && message.modelIsCliDefault === undefined &&
        message.model === chineseAssistant["assistant.agent.cliDefault"] &&
        message.runtime !== undefined && message.runtime !== "default" &&
        previous?.role === "user" && !previous.runtimeModel) {
      return { ...message, modelIsCliDefault: true };
    }
    return message;
  });
  return { ...value, messages };
}

const path = (id: string) => `/creation/projects/${id}/assistant`;
export const conversations = (id: string, signal?: AbortSignal) =>
  request<{ activeId: string; items: ConversationSummary[] }>(
    path(id) + "/conversations",
    { signal },
  );
export const activateConversation = (
  projectId: string,
  id: string,
  create = false,
) =>
  request<Conversation>(
    path(projectId) +
      (create ? "/conversations" : `/conversations/${id}/activate`),
    create ? json("POST", { id }) : json("POST", {}),
  ).then(normalizeConversation);
const runtimeStatuses = new Map<AgentRuntime, { value: RuntimeInfo; expires: number }>();
const discoveryTtlMs = 30_000;

export async function chatRuntimeStatus(id: string, runtime: AgentRuntime, signal?: AbortSignal, refresh = false) {
  const cached = runtimeStatuses.get(runtime);
  if (!refresh && cached && cached.expires > Date.now()) return cached.value;
  const value = await request<RuntimeInfo>(path(id) + `/runtimes/${runtime}/status`, { signal });
  runtimeStatuses.set(runtime, { value, expires: Date.now() + discoveryTtlMs });
  return value;
}

export async function chatRuntimeInventory(id: string, signal?: AbortSignal) {
  const rows = await request<RuntimeInfo[]>(path(id) + "/runtimes?probe=false", { signal });
  return rows.map((item) => {
    const cached = runtimeStatuses.get(item.id);
    return item.status === "checking" && cached && cached.expires > Date.now() ? cached.value : item;
  });
}
/** The saved conversation, plus the turn still running for it, if any. */
export async function conversation(
  id: string,
): Promise<{ conversation: Conversation; activeTurnId: string | null }> {
  const { activeTurnId, ...saved } = await request<
    Conversation & { activeTurnId?: string }
  >(path(id));
  return { conversation: normalizeConversation(saved), activeTurnId: activeTurnId ?? null };
}
/**
 * The draft endpoint validates strictly and rejects unknown members, so send
 * the fields it owns instead of forwarding whatever a view or conversation read
 * happens to hold (`messages`, `activeTurnId`, `decisions`, `tasks`).
 */
export function draftOf(value: ChatDraft): ChatDraft {
  return {
    conversationId: value.conversationId,
    draft: value.draft,
    draftContent: value.draftContent,
    assets: value.assets,
    thinking: value.thinking,
    builtinModelThinking: value.builtinModelThinking,
    modelSelections: value.modelSelections,
    runtime: value.runtime,
    runtimeModel: value.runtimeModel,
    harnessModels: value.harnessModels,
    skills: value.skills,
  };
}
export const saveChatDraft = (id: string, draft: ChatDraft) =>
  request(path(id) + "/draft", json("PUT", draftOf(draft)));
export const chatSkills = (id: string, signal?: AbortSignal) =>
  request<ChatSkill[]>(path(id) + "/skills", { signal });
export const stopChat = (id: string, turn: string) =>
  request(path(id) + `/turns/${turn}/stop`, json("POST", {}));
export async function streamChat(
  id: string,
  value: ChatRequest,
  signal: AbortSignal,
  onEvent: (event: ChatEvent) => void,
  t: Translate = defaultTranslate,
) {
  const response = await sessionFetch(path(id) + "/turns", {
    ...json("POST", value),
    signal,
  });
  await readChatEvents(response, onEvent, t);
}

/** Thrown when the turn already ended; read the conversation instead. */
export class ChatTurnEnded extends Error {}

/**
 * Attach to a turn that is still running, for example after returning to the
 * project. The server replays the turn from its start event; closing this
 * stream only detaches the viewer and never stops the Agent.
 */
export async function attachChat(
  id: string,
  turn: string,
  signal: AbortSignal,
  onEvent: (event: ChatEvent) => void,
  t: Translate = defaultTranslate,
) {
  const response = await sessionFetch(path(id) + `/turns/${turn}/events`, {
    signal,
  });
  if (response.status === 404) throw new ChatTurnEnded();
  await readChatEvents(response, onEvent, t);
}

async function readChatEvents(
  response: Response,
  onEvent: (event: ChatEvent) => void,
  t: Translate,
) {
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new Error(t("assistant.stream.unavailable"));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "",
    ended = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.startsWith("data: ")) {
          const event = JSON.parse(frame.slice(6)) as ChatEvent;
          if (event.type === "start") ended = false;
          if (event.type === "end" && !event.nextTurnId) ended = true;
          if ((event.type === "start" || event.type === "end") && event.conversation) {
            event.conversation = normalizeConversation(event.conversation);
          }
          onEvent(event);
        }
      }
    }
    if (!ended) throw new Error(t("assistant.stream.interrupted"));
  } finally {
    reader.releaseLock();
  }
}

export interface RuntimeModel {
  isDefault?: boolean;
  id: string;
  label: string;
  efforts: string[];
}
const runtimeModelCatalogs = new Map<AgentRuntime, { value: RuntimeModel[]; expires: number }>();

export async function runtimeModels(projectId: string, runtime: AgentRuntime, selected?: string | null, signal?: AbortSignal) {
  const cached = runtimeModelCatalogs.get(runtime);
  if (!selected && cached && cached.expires > Date.now()) return cached.value;
  const value = await request<RuntimeModel[]>(path(projectId) + `/runtimes/${runtime}/models` +
    (selected ? `?selected=${encodeURIComponent(selected)}` : ""), { signal });
  if (!selected) runtimeModelCatalogs.set(runtime, { value, expires: Date.now() + discoveryTtlMs });
  return value;
}

export interface DecisionAnswerSubmissionItem {
  questionId: string;
  source: AnswerSource;
  selectedOptionIds: string[];
  customText?: string | null;
}

export interface DecisionAnswerReceipt {
  replayed: boolean;
  requestId: string;
  status: DecisionStatus;
  continuationId: string;
  busy: boolean;
  decision: DecisionRecord;
  task: LogicalTaskRecord;
}

async function streamSegmentPost(
  endpoint: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  onEvent: (event: ChatEvent) => void,
  t: Translate,
) {
  const response = await sessionFetch(endpoint, {
    ...json("POST", body),
    signal,
  });
  await readChatEvents(response, onEvent, t);
}

export function submitDecisionAnswer(
  projectId: string,
  requestId: string,
  answers: DecisionAnswerSubmissionItem[],
): Promise<DecisionAnswerReceipt> {
  return request<DecisionAnswerReceipt>(
    path(projectId) + `/decisions/${requestId}/answers`,
    json("POST", { answers }),
  );
}

export const streamDecisionContinuation = (
  projectId: string,
  continuationId: string,
  signal: AbortSignal,
  onEvent: (event: ChatEvent) => void,
  t: Translate = defaultTranslate,
) =>
  streamSegmentPost(
    path(projectId) + `/continuations/${continuationId}`,
    {},
    signal,
    onEvent,
    t,
  );

export const streamPlanConfirmation = (
  projectId: string,
  taskId: string,
  planRevision: number,
  signal: AbortSignal,
  onEvent: (event: ChatEvent) => void,
  t: Translate = defaultTranslate,
) =>
  streamSegmentPost(
    path(projectId) + `/tasks/${taskId}/confirm-plan`,
    { planRevision },
    signal,
    onEvent,
    t,
  );

export function adjustTaskPlan(
  projectId: string,
  taskId: string,
  planRevision: number,
  prompt?: string | null,
) {
  return request<{ task: LogicalTaskRecord }>(
    path(projectId) + `/tasks/${taskId}/adjust-plan`,
    json("POST", { planRevision, prompt: prompt ?? null }),
  );
}
