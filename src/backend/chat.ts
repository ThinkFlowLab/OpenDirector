import type { ReferenceContent } from "../canvas/chatReferenceContent.ts";
import { defaultTranslate } from "../canvas/assistantTranslate.ts";
import type { Translate } from "../i18n/I18nProvider.tsx";
import { headers, json, request, responseError } from "./api.ts";

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
  title: string;
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
export interface ChatMessage {
  sources?: ChatSource[];
  plan?: ChatPlanEntry[];
  runtime?: AgentRuntime;
  tools?: ChatTool[];
  id: string;
  role: "user" | "assistant";
  text: string;
  content?: ReferenceContent | null;
  status:
    | "complete"
    | "streaming"
    | "queued"
    | "cancelled"
    | "stopped"
    | "interrupted";
  /** Position of a queued message in the delivery order the server assigned. */
  queueSeq?: number;
  assets?: ChatAsset[];
  model?: string;
  thinking?: Thinking;
  source?: "preview" | "model";
}

export type Thinking = "auto" | "low" | "medium" | "high";
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
  | { type: "start"; conversation: Conversation }
  | { type: "thinking" }
  | { type: "plan"; entries: ChatPlanEntry[] }
  | ({ type: "tool" } & ChatTool)
  | { type: "delta"; text: string }
  | { type: "sources"; sources: ChatSource[] }
  /** A message accepted while a reply runs; it starts when that reply ends. */
  | { type: "queued"; message: ChatMessage }
  /** A queued message was withdrawn before it started. */
  | { type: "retracted"; messageId: string }
  | {
      type: "end";
      turnId?: string;
      /** Set when the server has already started the next queued message. */
      nextTurnId?: string | null;
      conversation: Conversation | null;
      error: string | null;
    };

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
  );
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
  return { conversation: saved, activeTurnId: activeTurnId ?? null };
}
export const saveChatDraft = (id: string, draft: ChatDraft) =>
  request(path(id) + "/draft", json("PUT", draft));
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
  const response = await fetch("/api" + path(id) + "/turns", {
    ...json("POST", value),
    headers: { ...headers, "Content-Type": "application/json" },
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
  const response = await fetch("/api" + path(id) + `/turns/${turn}/events`, {
    headers,
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
          ended ||= event.type === "end";
          onEvent(event);
        }
      }
    }
    if (!ended) throw new Error(t("assistant.stream.interrupted"));
  } finally {
    reader.releaseLock();
  }
}

export interface QueuedReply {
  queued: ChatMessage;
  chainId: string;
  turnId: string;
}

/**
 * Hand a message to the assistant without waiting for the running reply.
 *
 * The server answers with a stream when the project is idle and with
 * `202 { queued }` when a reply is running, so a client submits here without
 * having to know which of the two it is.
 */
export async function sendChat(
  id: string,
  value: ChatRequest,
  signal: AbortSignal,
  onEvent: (event: ChatEvent) => void,
  t: Translate = defaultTranslate,
): Promise<QueuedReply | null> {
  const response = await fetch("/api" + path(id) + "/messages", {
    ...json("POST", value),
    headers: { ...headers, "Content-Type": "application/json" },
    signal,
  });
  if (response.status === 202) return (await response.json()) as QueuedReply;
  await readChatEvents(response, onEvent, t);
  return null;
}

/**
 * Take back a message that is still waiting behind the running reply.
 *
 * A message that has already started is part of the record: the server
 * refuses it with 409 and the caller still has to stop the reply instead.
 */
export async function retractChatMessage(
  id: string,
  message: string,
): Promise<{ retracted: string; conversation: Conversation }> {
  return request<{ retracted: string; conversation: Conversation }>(
    path(id) + `/messages/${message}`,
    { method: "DELETE", headers },
  );
}

/**
 * Continue a queue that nothing is draining, for example after a restart
 * or after a reply failed with messages still waiting behind it.
 */
export async function continueQueue(
  id: string,
  signal: AbortSignal,
  onEvent: (event: ChatEvent) => void,
  t: Translate = defaultTranslate,
) {
  const response = await fetch("/api" + path(id) + "/queue/dispatch", {
    ...json("POST", {}),
    headers: { ...headers, "Content-Type": "application/json" },
    signal,
  });
  await readChatEvents(response, onEvent, t);
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
