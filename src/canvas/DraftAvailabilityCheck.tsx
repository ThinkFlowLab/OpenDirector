import { useEffect, useRef, useState } from "react";
import {
  checkDraftAvailability,
  type ModelConfigInput,
} from "../backend/models.ts";
import type { ModelAvailability } from "../backend/availability.ts";
import { errorMessage } from "../backend/api.ts";
import { ModelAvailabilityCard } from "./ModelAvailabilityCard";

/** A draft check never publishes an observation into the saved model catalog. */
export function DraftAvailabilityCheck({
  connection,
  configId,
  modelId,
}: {
  connection: ModelConfigInput;
  configId?: string;
  modelId: string;
}) {
  const signature = JSON.stringify([connection, configId, modelId]);
  const latest = useRef(signature);
  latest.current = signature;
  const serial = useRef(0);
  const alive = useRef(true);
  const [value, setValue] = useState<{
    signature: string;
    observation: ModelAvailability;
  } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [failure, setFailure] = useState<{
    signature: string;
    message: string;
  } | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const check = async () => {
    const attempt = ++serial.current;
    setPending(signature);
    setFailure(null);
    try {
      const observation = await checkDraftAvailability(
        { ...connection, modelId },
        configId,
      );
      if (
        alive.current &&
        latest.current === signature &&
        serial.current === attempt
      )
        setValue({ signature, observation });
    } catch (error) {
      if (
        alive.current &&
        latest.current === signature &&
        serial.current === attempt
      ) {
        setValue(null);
        setFailure({ signature, message: errorMessage(error) });
      }
    } finally {
      if (alive.current && serial.current === attempt) setPending(null);
    }
  };
  return (
    <ModelAvailabilityCard
      value={value?.signature === signature ? value.observation : null}
      checking={pending === signature}
      onRefresh={() => void check()}
      error={failure?.signature === signature ? failure.message : undefined}
    />
  );
}
