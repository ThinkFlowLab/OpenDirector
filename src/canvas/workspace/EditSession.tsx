import { useEffect, useRef, useState } from "react";
import { flushChatDraft } from "../../backend/chatDrafts.ts";
import { errorMessage } from "../../backend/api.ts";
import { readEditingState, installEditingState, requestEditing, resolveEditing } from "../../backend/editSession.ts";
import { activeBackendProjectId, serializeSessionChange } from "../../backend/projects.ts";
import { persistCurrentDocument } from "../projectManagement.ts";
import type { WorkspaceRuntime } from "./runtimeTypes.ts";
import "./edit-session.css";

export function useEditSession(rt: WorkspaceRuntime) {
  const { doc, ready, switching } = rt;
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);

  useEffect(() => {
    if (!ready || switching) return;
    let timer: number | undefined;
    let stopped = false;
    const controller = new AbortController();
    const poll = async () => {
      try {
        await serializeSessionChange(async () => {
          if (stopped || pending.current || activeBackendProjectId() !== doc.id) return;
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
          const state = await readEditingState(doc.id, { signal });
          if (!stopped && !pending.current) installEditingState(doc.id, state);
        });
      } catch {
        // Keep the last confirmed role across transient connection failures.
      } finally {
        if (!stopped) timer = window.setTimeout(poll, 1500);
      }
    };
    timer = window.setTimeout(poll, 1500);
    return () => {
      stopped = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [doc.id, ready, switching]);

  const run = async (operation: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setWorking(true);
    setError("");
    try {
      await operation();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      pending.current = false;
      setWorking(false);
    }
  };

  return {
    working,
    error,
    request: () => run(() => serializeSessionChange(async () => {
      if (activeBackendProjectId() === doc.id)
        installEditingState(doc.id, await requestEditing(doc.id));
    })),
    decide: (requester: string, accept: boolean) => run(async () => {
      if (rt.switchPending.current) return;
      if (accept && (rt.editing || rt.activeAction || rt.editorSaving.current ||
          rt.historyRef.current.transaction || rt.historyReplayQueue.current)) {
        throw new Error(rt.t("canvas.workspace.preview.closeEditor"));
      }
      rt.switchPending.current = true;
      rt.invalidateScheduledAutosave();
      try {
        if (accept) {
          if (!await persistCurrentDocument(() => rt.historyRef.current.present, rt.persist))
            throw new Error(rt.saveError.current || rt.t("canvas.workspace.error.switchSaveFailed"));
          await flushChatDraft(doc.id);
        }
        await serializeSessionChange(async () => {
          if (activeBackendProjectId() === doc.id)
            installEditingState(doc.id, await resolveEditing(doc.id, requester, accept));
        });
      } finally {
        rt.switchPending.current = false;
      }
    }),
  };
}

export type EditSession = ReturnType<typeof useEditSession>;

export function EditHandoff({ rt, requester, session }: {
  rt: WorkspaceRuntime;
  requester: string;
  session: EditSession;
}) {
  const t = rt.t;
  return <aside className="cw-edit-handoff" aria-label={t("canvas.workspace.preview.handoff")}>
    <span role="status">{t("canvas.workspace.preview.handoff")}</span>
    <button type="button" disabled={session.working}
      onClick={() => void session.decide(requester, false)}>{t("canvas.workspace.preview.decline")}</button>
    <button type="button" disabled={session.working}
      onClick={() => void session.decide(requester, true)}>{t("canvas.workspace.preview.accept")}</button>
    {session.error && <span role="alert">{session.error}</span>}
  </aside>;
}
