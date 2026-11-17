import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { rememberAgentSelection, restoreAgentSelection, builtinThinking } from "./agentPreferences";
import { errorMessage } from "../backend/api";
import {
  attachChat,
  ChatTurnEnded,
  type ChatEvent,
  conversation,
  conversations,
  activateConversation,
  type ConversationSummary,
  chatRuntimeInventory,
  chatRuntimeStatus,
  type AgentRuntime,
  type RuntimeInfo,
  streamChat,
  stopChat,
  type ChatAsset,
  type Conversation,
  conversationIsEmpty,
} from "../backend/chat";
import { flushChatDraft, rememberChat } from "../backend/chatDrafts";
import { creationClient } from "../backend/creationClient.ts";
import { fingerprint } from "../backend/generation";
import { getActiveLocale } from "../i18n/messages.ts";
import type { BackendModels } from "../backend/models";
import { loadReferenceCatalog } from "../backend/referenceCatalog.ts";
import { isGenerationModel } from "../backend/rules";
import { resolveGenerationModel } from "./modelResolution.ts";
import {
  contentText,
  referenceContent,
  referenceIds,
  type ReferenceAsset,
  type ReferenceContent,
} from "./chatReferenceContent.ts";
import type { CanvasNode } from "./model";
import { pendingCanvasReferences } from "./pendingCanvasReferences.ts";
import type { Translate } from "../i18n/I18nProvider.tsx";

export interface ProjectChatAsset extends ReferenceAsset {
  kind: string;
}
export const attachment = ({
  id,
  name,
  type,
  size,
  fingerprint,
}: ChatAsset): ChatAsset => ({ id, name, type, size, fingerprint });
const empty = (): Conversation => ({
  messages: [],
  draft: "",
  assets: [],
  thinking: "auto",
  modelSelections: {},
});

/** A streaming reply is interrupted unless its turn is still running on the server. */
function restoreConversation(
  projectId: string,
  saved: Conversation,
  running = false,
): Conversation {
  return {
    ...restoreAgentSelection(projectId, saved),
    messages: saved.messages.map(message => message.status === "streaming" && !running
      ? { ...message, status: "interrupted" } : message),
  };
}

export function useAssistantChat(
  projectId: string,
  catalog: BackendModels,
  onTurnEnd: () => void,
  t: Translate,
  open: boolean,
) {
  const [value, setValue] = useState<Conversation>(empty);
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [runtimesLoading, setRuntimesLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [sending, setSending] = useState(false);
  const [started, setStarted] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [adding, setAdding] = useState(false);
  const [thinkingNow, setThinkingNow] = useState(false);
  const [threads, setThreads] = useState<ConversationSummary[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadsError, setThreadsError] = useState("");
  const [changing, setChanging] = useState(false);
  const switching = useRef(false);
  const [error, setError] = useState("");
  const displayError = (text: string) =>
    getActiveLocale() === "en-US" && /[\u3400-\u9fff]/.test(text)
      ? t("assistant.error.replyFailed")
      : text;
  const alive = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const listController = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const uploading = useRef(false);
  const turnId = useRef<string | null>(null);
  const resume = useRef<(turn: string) => Promise<void>>(async () => {});
  const current = useRef(value);
  current.current = value;
  // Retain metadata for editor undo after a reference is removed from the draft.
  const knownAssets = useRef(new Map<string, ReferenceAsset>());
  value.assets.forEach((asset) =>
    knownAssets.current.set(asset.id, {
      ...knownAssets.current.get(asset.id),
      ...asset,
    }),
  );
  const setContent = (
    content: ReferenceContent,
    added: ReferenceAsset[] = [],
  ) => {
    added.forEach((asset) => knownAssets.current.set(asset.id, asset));
    const assets = referenceIds(content).map((id) => {
      const asset = knownAssets.current.get(id);
      if (!asset) throw new Error(t("assistant.error.referenceMissing"));
      return attachment(asset);
    });
    setValue((previous) => ({
      ...previous,
      draft: contentText(content, false, t),
      draftContent: content,
      skills: content.flatMap(part => part.type === "skill" ? [part.name] : []),
      assets,
    }));
  };
  const onEnd = useRef(onTurnEnd);
  onEnd.current = onTurnEnd;

  const refreshConversations = useCallback(async (saveDraft = false) => {
    listController.current?.abort();
    const abort = new AbortController();
    listController.current = abort;
    setThreadsLoading(true);
    setThreadsError("");
    try {
      if (saveDraft) {
        rememberChat(projectId, current.current);
        await flushChatDraft(projectId);
        abort.signal.throwIfAborted();
      }
      const list = await conversations(projectId, abort.signal);
      if (!abort.signal.aborted && alive.current) setThreads(list.items);
    } catch (reason) {
      if (!abort.signal.aborted && alive.current)
        setThreadsError(
          t("assistant.error.threads", { detail: errorMessage(reason) }),
        );
    } finally {
      if (listController.current === abort && alive.current) {
        listController.current = null;
        setThreadsLoading(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    setLoaded(false);
    setRuntimes([]);
    setRuntimesLoading(true);
    setError("");
    const discovery = new AbortController();
    void chatRuntimeInventory(projectId, discovery.signal)
      .then((available) => {
        if (!cancelled) setRuntimes(available);
      })
      .catch((reason) => {
        if (!cancelled)
          setError(
            t("assistant.error.runtimes", { detail: errorMessage(reason) }),
          );
      })
      .finally(() => {
        if (!cancelled) setRuntimesLoading(false);
      });
    void refreshConversations();
    void conversation(projectId)
      .then(({ conversation: saved, activeTurnId }) => {
        if (cancelled) return;
        setValue(restoreConversation(projectId, saved, Boolean(activeTurnId)));
        setLoaded(true);
        // Navigation only detached the previous view; pick the run back up.
        if (activeTurnId) void resume.current(activeTurnId);
      })
      .catch((reason) => {
        if (!cancelled)
          setError(
            t("assistant.error.conversation", { detail: errorMessage(reason) }),
          );
      });
    return () => {
      cancelled = true;
      discovery.abort();
      alive.current = false;
      // Closing the stream detaches this view only; the server keeps the
      // turn running. Release the turn now so the next project starts idle.
      controller.current?.abort();
      controller.current = null;
      submitting.current = false;
      turnId.current = null;
      setSending(false);
      setStarted(false);
      setStopping(false);
      setThinkingNow(false);
      uploadController.current?.abort();
      listController.current?.abort();
    };
  }, [projectId, loadAttempt, refreshConversations]);

  useEffect(() => {
    if (loaded && !runtimesLoading && runtimes.length && value.runtime &&
        !runtimes.some((item) => item.id === value.runtime)) {
      setError(t("assistant.error.runtimeRemoved"));
    }
  }, [loaded, runtimesLoading, runtimes, value.runtime]);

  useLayoutEffect(() => {
    if (loaded) rememberChat(projectId, value);
  }, [projectId, loaded, value]);
  useEffect(() => {
    if (
      !loaded ||
      !runtimes.some((item) => item.id === (value.runtime ?? "default"))
    )
      return;
    const timer = window.setTimeout(() => {
      void flushChatDraft(projectId).catch((reason) => {
        if (alive.current)
          setError(
            t("assistant.error.draft", { detail: errorMessage(reason) }),
          );
      });
    }, 180);
    return () => clearTimeout(timer);
  }, [
    projectId,
    loaded,
    value.conversationId,
    value.draft,
    value.draftContent,
    value.assets,
    value.thinking,
    value.builtinModelThinking,
    value.modelSelections,
    value.skills,
    value.runtime,
    value.runtimeModel,
    value.harnessModels,
    runtimes,
  ]);

  useEffect(() => {
    if (!loaded || !catalog.connected) return;
    setValue((previous) => {
      const selections = { ...previous.modelSelections };
      let changed = false;
      for (const kind of ["agent", "image", "video", "audio"] as const) {
        const options = catalog.models.filter(
          (model) => model.kind === kind && isGenerationModel(model),
        );
        if (!options.some((model) => model.id === selections[kind])) {
          // Canvas creation uses the same deterministic generation fallback
          // before the assistant conversation has loaded. Loading the picker
          // must not silently change that choice to the API's first row.
          const resolution = kind === "agent" ? null
            : resolveGenerationModel({}, kind, catalog.models);
          const next = kind === "agent" ? options[0]?.id ?? null
            : resolution?.status === "default" ? resolution.modelConfigId : null;
          if (selections[kind] !== next) {
            selections[kind] = next;
            changed = true;
          }
        }
      }
      return changed ? { ...previous, modelSelections: selections } : previous;
    });
  }, [loaded, catalog.connected, catalog.models]);

  const agent = catalog.models.find(
    (model) =>
      model.kind === "agent" && model.id === value.modelSelections.agent,
  );
  const currentRuntime = runtimes.find(
    (item) => item.id === (value.runtime ?? "default"),
  );
  const refreshRuntimes = useCallback(async (runtime: AgentRuntime, signal?: AbortSignal, force = false) => {
    try {
      const status = await chatRuntimeStatus(projectId, runtime, signal, force);
      if (!signal?.aborted && alive.current)
        setRuntimes((items) => items.map((item) => item.id === runtime ? status : item));
    } catch (reason) {
      if (!signal?.aborted && alive.current)
        setRuntimes((items) => items.map((item) => item.id === runtime ? { ...item, status: "unknown" } : item));
      throw reason;
    }
  }, [projectId]);

  const runtimeToCheck = currentRuntime?.status === "checking" ? currentRuntime.id : null;
  useEffect(() => {
    if (!open || !loaded || runtimesLoading || !runtimeToCheck) return;
    const abort = new AbortController();
    void refreshRuntimes(runtimeToCheck, abort.signal).catch(() => {});
    return () => abort.abort();
  }, [open, loaded, runtimesLoading, runtimeToCheck, refreshRuntimes]);

  const canSend =
    currentRuntime?.status === "ready" &&
    !!currentRuntime.available &&
    (currentRuntime.modelSource === "cli" || !!agent);
  const addAssets = (assets: ChatAsset[]) => {
    assets.forEach((asset) =>
      knownAssets.current.set(asset.id, attachment(asset)),
    );
    setValue((previous) => {
      const merged = [
        ...new Map(
          [...previous.assets, ...assets.map(attachment)].map((asset) => [
            asset.id,
            asset,
          ]),
        ).values(),
      ];
      const content = referenceContent(
        previous.draft,
        merged.map((asset) => asset.id),
        merged,
        previous.draftContent,
        t,
      );
      return {
        ...previous,
        draft: contentText(content, false, t),
        draftContent: content,
        assets: referenceIds(content).map((id) => knownAssets.current.get(id)!),
      };
    });
  };
  const add = async (
    read: (signal: AbortSignal) => Promise<ReferenceAsset[]>,
    externalSignal?: AbortSignal,
    commit?: (assets: ReferenceAsset[]) => boolean | Promise<boolean>,
  ) => {
    if (
      !loaded ||
      switching.current ||
      uploading.current ||
      submitting.current ||
      externalSignal?.aborted
    )
      return false;
    uploading.current = true;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    externalSignal?.addEventListener("abort", cancel, { once: true });
    uploadController.current = abort;
    setAdding(true);
    setError("");
    try {
      const assets = await read(abort.signal);
      abort.signal.throwIfAborted();
      if (!alive.current) return false;
      if (
        new Set([...current.current.assets, ...assets].map((asset) => asset.id))
          .size > 64
      )
        throw new Error(t("assistant.error.tooManyReferences"));
      if (commit) {
        setAdding(false);
        return await commit(assets);
      }
      addAssets(assets);
      return true;
    } catch (reason) {
      if (alive.current && !abort.signal.aborted)
        setError(displayError(errorMessage(reason)));
      return false;
    } finally {
      externalSignal?.removeEventListener("abort", cancel);
      uploading.current = false;
      if (uploadController.current === abort) uploadController.current = null;
      if (alive.current) setAdding(false);
    }
  };
  const upload = (
    files: File[],
    prepare: (files: File[], signal: AbortSignal) => Promise<ReferenceAsset[]>,
    commit?: (assets: ReferenceAsset[]) => boolean | Promise<boolean>,
  ) => add((signal) => prepare(files, signal), undefined, commit);
  const addNodes = (
    nodes: CanvasNode[],
    signal?: AbortSignal,
    commit?: (assets: ReferenceAsset[]) => boolean | Promise<boolean>,
  ) =>
    add(
      async (signal) => {
        const invalid = pendingCanvasReferences(nodes).filter(
          (item) => item.error,
        );
        if (invalid.length)
          throw new Error(
            t("assistant.error.batchNotInserted", {
              detail: invalid
                .map((item) => `${item.title}：${item.error}`)
                .join(" "),
            }),
          );
        {
          const client = creationClient(projectId);
          await client.refresh();
          const catalog = await loadReferenceCatalog(projectId, signal);
          const selected = nodes.flatMap((node) => {
            const assets = catalog.filter(
              (asset) => asset.nodeId === node.id && asset.available,
            );
            if (!assets.length)
              throw new Error(t("assistant.error.noUsableAssets"));
            return assets;
          });
          for (const asset of selected) {
            signal.throwIfAborted();
            if (
              (await fingerprint(await client.blob(asset.id))) !==
              asset.fingerprint
            )
              throw new Error(t("assistant.error.referenceChangedBatch"));
          }
          return selected;
        }
      },
      signal,
      commit,
    );

  const send = async () => {
    if (
      !loaded ||
      switching.current ||
      submitting.current ||
      uploading.current ||
      !canSend ||
      !current.current.draft.trim()
    )
      return;
    const input = current.current;
    await follow(crypto.randomUUID(), async (id, signal, onEvent) => {
      await flushChatDraft(projectId);
      await streamChat(
        projectId,
        {
          id,
          conversationId: input.conversationId,
          modelId: agent?.id,
          runtime: input.runtime ?? "default",
          runtimeModel: input.runtimeModel,
          text: input.draft,
          content: input.draftContent,
          assets: input.assets.map((asset) => asset.id),
          thinking: builtinThinking(input, agent?.id),
          modelSelections: input.modelSelections,
          skills: input.skills ?? [],
        },
        signal,
        onEvent,
        t,
      );
    });
  };
  /** Re-attach to a turn that kept running while this project was not shown. */
  resume.current = async (id: string) => {
    if (switching.current || submitting.current) return;
    await follow(id, async (turn, signal, onEvent) => {
      try {
        await attachChat(projectId, turn, signal, onEvent, t);
      } catch (reason) {
        if (!(reason instanceof ChatTurnEnded)) throw reason;
        // It finished in between: the saved conversation has the final reply.
        const { conversation: saved } = await conversation(projectId);
        if (alive.current && !signal.aborted)
          setValue(restoreConversation(projectId, saved));
      }
    });
  };
  const follow = async (
    id: string,
    run: (
      id: string,
      signal: AbortSignal,
      onEvent: (event: ChatEvent) => void,
    ) => Promise<void>,
  ) => {
    submitting.current = true;
    setSending(true);
    setStarted(false);
    setError("");
    setThinkingNow(false);
    const abort = new AbortController();
    controller.current = abort;
    turnId.current = id;
    const assistantId = crypto.randomUUID();
    try {
      await run(
        id,
        abort.signal,
        (event) => {
          if (!alive.current) return;
          if (event.type === "start") {
            setStarted(true);
            setValue({
              ...event.conversation,
              messages: event.conversation.messages.map((message) =>
                message.status === "streaming"
                  ? {
                      ...message,
                      id: assistantId,
                    }
                  : message,
              ),
            });
          } else if (event.type === "delta") {
            setThinkingNow(false);
            setValue((previous) => ({
              ...previous,
              messages: previous.messages.map((message) =>
                message.id === assistantId
                  ? { ...message, text: message.text + event.text }
                  : message,
              ),
            }));
          } else if (event.type === "sources") {
            setValue((previous) => ({
              ...previous,
              messages: previous.messages.map((message) => message.id === assistantId
                ? { ...message, sources: Array.from(new Map([
                    ...event.sources.map((source) => [source.id, source] as const),
                    ...(message.sources ?? []).map((source) => [source.id, source] as const),
                  ]).values()) }
                : message),
            }));
          } else if (event.type === "thinking") setThinkingNow(true);
          else if (event.type === "plan") {
            setValue((previous) => ({
              ...previous,
              messages: previous.messages.map((message) => message.id === assistantId
                ? { ...message, plan: event.entries } : message),
            }));
          } else if (event.type === "tool") {
            setThinkingNow(false);
            const { type, ...tool } = event;
            setValue((previous) => ({
              ...previous,
              messages: previous.messages.map((message) => {
                if (message.id !== assistantId) return message;
                const tools = [...(message.tools ?? [])];
                const index = tools.findIndex((item) => item.id === tool.id);
                if (index < 0) tools.push(tool);
                else tools[index] = tool;
                return { ...message, tools };
              }),
            }));
            if (event.status !== "running") onEnd.current();
          } else if (event.type === "end") {
            if (event.conversation) setValue(event.conversation);
            if (event.error) setError(displayError(event.error));
          }
        },
      );
    } catch (reason) {
      if (alive.current && !abort.signal.aborted)
        setError(displayError(errorMessage(reason)));
    } finally {
      // A newer view may already own these refs after a project switch.
      if (controller.current === abort) {
        submitting.current = false;
        turnId.current = null;
        controller.current = null;
      }
      if (alive.current && !abort.signal.aborted) {
        // Aborting only detaches this view (project switch, unmount); the
        // turn keeps running on the server and is resumed on return.
        setSending(false);
        setStarted(false);
        setStopping(false);
        setThinkingNow(false);
        onEnd.current();
        void refreshConversations();
      }
    }
  };
  const changeConversation = async (
    id?: string,
    create = false,
  ): Promise<boolean> => {
    if (!loaded || submitting.current || uploading.current || switching.current)
      return false;
    if (create && conversationIsEmpty(current.current)) return true;
    if (!create && current.current.conversationId === id) return true;
    id ??= crypto.randomUUID();
    switching.current = true;
    setChanging(true);
    setLoaded(false);
    setError("");
    try {
      rememberChat(projectId, current.current);
      await flushChatDraft(projectId);
      const saved = restoreConversation(projectId, await activateConversation(projectId, id, create));
      if (!alive.current) return false;
      knownAssets.current.clear();
      current.current = saved;
      rememberChat(projectId, saved);
      setValue(saved);
      setThinkingNow(false);
      void refreshConversations();
      return true;
    } catch (reason) {
      if (alive.current) setError(errorMessage(reason));
      return false;
    } finally {
      switching.current = false;
      if (alive.current) {
        setChanging(false);
        setLoaded(true);
      }
    }
  };
  const stop = async () => {
    if (!turnId.current || stopping) return;
    setStopping(true);
    try {
      await stopChat(projectId, turnId.current);
    } catch (reason) {
      if (alive.current) {
        setError(
          t("assistant.error.stop", { detail: errorMessage(reason) }),
        );
        setStopping(false);
      }
    }
  };
  return {
    value,
    runtimes,
    runtimesLoading,
    refreshRuntimes,
    setValue,
    selectAgent: (patch: Partial<Conversation>) => {
      const next = {...current.current, ...patch};
      rememberAgentSelection(projectId, next);
      current.current = next;
      rememberChat(projectId, next);
      setValue(next);
      setError("");
    },
    setContent,
    referenceAssets: [...knownAssets.current.values()],
    loaded,
    sending,
    started,
    stopping,
    thinkingNow,
    threads,
    threadsLoading,
    threadsError,
    refreshConversations,
    changing,
    changeConversation,
    error,
    setError,
    agent,
    canSend,
    adding,
    upload,
    addNodes,
    addAssets,
    send,
    stop,
    reload: () => setLoadAttempt((n) => n + 1),
  };
}
