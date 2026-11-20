import { saveChatDraft, type ChatDraft, type Conversation } from "./chat.ts";

// Only unsaved UI drafts live here; the backend owns persisted conversation state.
const latest = new Map<string, Conversation>();
const pending = new Map<string, Promise<void>>();

/**
 * The draft endpoint validates strictly and rejects unknown members, so send
 * the fields it owns instead of forwarding whatever the view happens to hold.
 * `activeTurnId` in particular is only present on a conversation read while a
 * reply is running; echoing it back made every autosave fail with a 422.
 */
function draftOf(value: Conversation): ChatDraft {
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

export function rememberChat(projectId: string, value: Conversation) {
  latest.set(projectId, value);
}
export function currentChat(projectId: string) {
  return latest.get(projectId);
}
export function flushChatDraft(projectId: string): Promise<void> {
  const value = latest.get(projectId);
  if (!value) return pending.get(projectId) ?? Promise.resolve();
  const next = (pending.get(projectId) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await saveChatDraft(projectId, draftOf(value));
    });
  pending.set(projectId, next);
  void next
    .finally(() => {
      if (pending.get(projectId) === next) pending.delete(projectId);
    })
    .catch(() => {});
  return next;
}
