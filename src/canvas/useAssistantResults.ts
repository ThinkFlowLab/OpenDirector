import { useCallback, useMemo, useSyncExternalStore } from "react";
import { creationClient } from "../backend/creationClient";
import type { ChatMessage } from "../backend/chat";
import { assistantResultsByTurn, withPublishedAssistantResults } from "./assistantResults";

export function useAssistantResults(projectId: string, enabled: boolean, messages: readonly ChatMessage[]) {
  const client = enabled ? creationClient(projectId) : null;
  const subscribe = useCallback(
    (notify: () => void) => client ? client.listen(notify) : () => {},
    [client],
  );
  const snapshot = useSyncExternalStore(subscribe, () => client?.snapshot);
  const live = useMemo(() => assistantResultsByTurn(snapshot), [snapshot]);
  return useMemo(() => withPublishedAssistantResults(live, messages, snapshot), [live, messages, snapshot]);
}
