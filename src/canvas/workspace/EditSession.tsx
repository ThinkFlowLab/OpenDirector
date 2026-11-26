import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../backend/api.ts";
import { readEditingState, installEditingState, takeEditingOwnership } from "../../backend/editSession.ts";
import { activeBackendProjectId, serializeSessionChange } from "../../backend/projects.ts";
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
        installEditingState(doc.id, await takeEditingOwnership(doc.id));
    })),
  };
}

export type EditSession = ReturnType<typeof useEditSession>;
