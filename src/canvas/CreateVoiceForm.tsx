import { useEffect, useId, useRef, useState } from "react";
import {
  createVoice,
  type VoiceCapabilities,
  type VoiceRecord,
} from "../backend/voices";
import { errorMessage } from "../backend/api";
import { useI18n } from "../i18n/I18nProvider";
import { CanvasIcon } from "./CanvasIcon";
import { withMediaDuration } from "./editorMedia";

export function CreateVoiceForm({
  modelConfigId,
  capabilities,
  onBack,
  onCreated,
}: {
  modelConfigId: string;
  capabilities: VoiceCapabilities;
  onBack: () => void;
  onCreated: (voice: VoiceRecord) => Promise<void>;
}) {
  const { t } = useI18n();
  const prefix = useId();
  const [name, setName] = useState("");
  const [file, setFile] = useState<File>();
  const [url, setUrl] = useState("");
  const [duration, setDuration] = useState<number>();
  const [refText, setRefText] = useState("");
  const [speakerDescription, setSpeakerDescription] = useState("");
  const [consent, setConsent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const maxMB = capabilities.maxBytes / 1024 / 1024;
  const isVllm = capabilities.provider === "vllm_omni";
  const inputIssue = !file
    ? null
    : file.size === 0
      ? t("voiceLibrary.invalidAudio")
      : file.size > capabilities.maxBytes
        ? t("voiceLibrary.fileTooLarge", { size: maxMB })
        : !capabilities.formats.includes(
              file.name.split(".").at(-1)!.toLowerCase(),
            )
          ? t("voiceLibrary.fileFormat", {
              formats: capabilities.formats.join(", "),
            })
          : null;
  useEffect(() => {
    setDuration(undefined);
    setError("");
    if (!file || inputIssue) {
      setUrl("");
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    const controller = new AbortController();
    setUrl(objectUrl);
    withMediaDuration(
      { id: objectUrl, kind: "audio", title: file.name, src: objectUrl },
      controller.signal,
      t,
    ).then(
      (audio) => {
        if (!controller.signal.aborted) setDuration(audio.durationSeconds);
      },
      () => {
        if (!controller.signal.aborted)
          setError(t("voiceLibrary.invalidAudio"));
      },
    );
    return () => {
      controller.abort();
      URL.revokeObjectURL(objectUrl);
    };
  }, [file, inputIssue, t]);
  const fileIssue =
    inputIssue ??
    (duration !== undefined &&
    ((capabilities.minSeconds !== null && duration < capabilities.minSeconds) ||
      (capabilities.maxSeconds !== null && duration > capabilities.maxSeconds))
      ? t("voiceLibrary.fileDuration")
      : null);
  return (
    <form
      className="cw-voice-create"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!file || fileIssue || duration === undefined || busy) return;
        setBusy(true);
        setError("");
        try {
          const voice = await createVoice(modelConfigId, file, {
            connectionId: capabilities.connectionId,
            name: name.trim(),
            consent,
            refText: refText.trim(),
            speakerDescription: speakerDescription.trim(),
          });
          if (mounted.current) await onCreated(voice);
        } catch (failure) {
          if (mounted.current) setError(errorMessage(failure));
        } finally {
          if (mounted.current) setBusy(false);
        }
      }}
    >
      <button
        className="cw-voice-back"
        type="button"
        disabled={busy}
        onClick={onBack}
      >
        <CanvasIcon name="arrowLeft" size={14} />
        {t("voiceLibrary.back")}
      </button>
      <label htmlFor={`${prefix}-file`}>{t("voiceLibrary.recording")}</label>
      <p>{t("voiceLibrary.uploadGuidance")}</p>
      <p id={`${prefix}-requirements`}>
        {t("voiceLibrary.formats", {
          formats: capabilities.formats.join(", "),
          size: maxMB,
        })}
        {capabilities.minSeconds !== null && (
          <>
            {" "}
            ·{" "}
            {t("voiceLibrary.durationMin", {
              seconds: capabilities.minSeconds,
            })}
          </>
        )}
        {capabilities.maxSeconds !== null && (
          <>
            {" "}
            ·{" "}
            {t("voiceLibrary.durationMax", {
              seconds: capabilities.maxSeconds,
            })}
          </>
        )}
      </p>
      <input
        id={`${prefix}-file`}
        type="file"
        autoFocus
        accept={capabilities.formats.map((format) => `.${format}`).join(",")}
        required
        disabled={busy}
        aria-describedby={`${prefix}-requirements`}
        onChange={(event) => setFile(event.target.files?.[0])}
      />
      {file && !inputIssue && (duration !== undefined || !error) && (
        <p>
          {duration === undefined
            ? t("voiceLibrary.checking")
            : t("voiceLibrary.fileInfo", {
                name: file.name,
                size: (file.size / 1024 / 1024).toFixed(2),
                seconds: duration.toFixed(1),
              })}
        </p>
      )}
      {url && <audio key={url} src={url} controls preload="metadata" />}
      <label htmlFor={`${prefix}-name`}>{t("voiceLibrary.name")}</label>
      <input
        id={`${prefix}-name`}
        required
        maxLength={100}
        value={name}
        disabled={busy}
        onChange={(event) => setName(event.target.value)}
      />
      {(capabilities.requiresTranscript || capabilities.acceptsTranscript) && (
        <>
          <label htmlFor={`${prefix}-transcript`}>
            {t(
              capabilities.requiresTranscript
                ? "voiceLibrary.transcript"
                : "voiceLibrary.transcriptOptional",
            )}
          </label>
          <textarea
            id={`${prefix}-transcript`}
            required={capabilities.requiresTranscript}
            maxLength={10000}
            rows={3}
            value={refText}
            disabled={busy}
            onChange={(event) => setRefText(event.target.value)}
          />
          {capabilities.requiresTranscript && (
            <p>{t("voiceLibrary.transcriptRequired")}</p>
          )}
        </>
      )}
      {isVllm && (
        <>
          <label htmlFor={`${prefix}-description`}>
            {t("voiceLibrary.description")}
          </label>
          <input
            id={`${prefix}-description`}
            maxLength={1000}
            value={speakerDescription}
            disabled={busy}
            onChange={(event) => setSpeakerDescription(event.target.value)}
          />
          <label htmlFor={`${prefix}-consent`}>{t("voiceLibrary.consent")}</label>
          <input
            id={`${prefix}-consent`}
            required
            value={consent}
            disabled={busy}
            onChange={(event) => setConsent(event.target.value)}
          />
        </>
      )}
      {(error || fileIssue) && (
        <p className="cw-voice-error" role="alert">
          {error || fileIssue}
        </p>
      )}
      {busy && <p role="status">{t("voiceLibrary.creating")}</p>}
      <button
        type="submit"
        className="cw-voice-primary"
        disabled={
          busy ||
          !file ||
          !name.trim() ||
          duration === undefined ||
          Boolean(fileIssue) ||
          (isVllm && !consent.trim()) ||
          (capabilities.requiresTranscript && !refText.trim())
        }
      >
        {t("voiceLibrary.create")}
      </button>
    </form>
  );
}
