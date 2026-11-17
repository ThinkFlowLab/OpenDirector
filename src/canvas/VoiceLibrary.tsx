import { useEffect, useRef, useState } from "react";
import { errorMessage, headers, responseError } from "../backend/api";
import {
  deleteVoice,
  listVoices,
  voiceSelection,
  type VoiceCapabilities,
  type VoiceRecord,
  type VoiceSelection,
} from "../backend/voices";
import { useI18n } from "../i18n/I18nProvider";
import { CanvasIcon } from "./CanvasIcon";
import { CreateVoiceForm } from "./CreateVoiceForm";
import { readVoiceFavorites, saveVoiceFavorites } from "./voiceFavorites";
import "./voice-library.css";

type Tab = "all" | "mine" | "favorites";
const tabs: Tab[] = ["all", "mine", "favorites"];
const filterFields = ["gender", "age", "language", "style"] as const;

export function VoiceLibrary({
  modelConfigId,
  capabilities,
  selected,
  onSelect,
}: {
  modelConfigId: string;
  capabilities: VoiceCapabilities;
  selected?: VoiceSelection;
  onSelect: (selection: VoiceSelection) => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("all");
  const [requestedCursors, setRequestedCursors] = useState<string[]>([]);
  const [page, setPage] = useState<{
    voices: VoiceRecord[];
    cursors: string[];
    nextCursor: string | null;
  }>();
  const voices = page?.voices ?? [];
  const paginated = Boolean(page?.cursors.length || page?.nextCursor);
  const [favorites, setFavorites] = useState(() =>
    readVoiceFavorites(capabilities.connectionId),
  );
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<VoiceRecord>();
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const audio = useRef<HTMLAudioElement | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  const previewObjectUrl = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const stop = () => {
    previewRequest.current?.abort();
    if (previewObjectUrl.current) URL.revokeObjectURL(previewObjectUrl.current);
    previewObjectUrl.current = undefined;
    audio.current?.pause();
    audio.current = null;
    setPlaying(undefined);
  };
  useEffect(() => {
    mounted.current = true;
    tabRefs.current[0]?.focus({ preventScroll: true });
    return () => {
      mounted.current = false;
      previewRequest.current?.abort();
      if (previewObjectUrl.current)
        URL.revokeObjectURL(previewObjectUrl.current);
      audio.current?.pause();
      audio.current = null;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const query =
      capabilities.provider === "moss"
        ? {
            connectionId: capabilities.connectionId,
            after: requestedCursors.at(-1),
          }
        : undefined;
    listVoices(modelConfigId, controller.signal, query)
      .then((data) => {
        if (controller.signal.aborted) return;
        if (data.connectionId !== capabilities.connectionId)
          throw Error(t("voiceLibrary.connectionChanged"));
        if (data.nextCursor && requestedCursors.includes(data.nextCursor))
          throw Error(t("voiceLibrary.invalidPage"));
        setPage({
          voices: data.voices,
          cursors: requestedCursors,
          nextCursor: data.nextCursor ?? null,
        });
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    modelConfigId,
    capabilities.connectionId,
    capabilities.provider,
    requestedCursors,
    attempt,
    t,
  ]);
  const changePage = (cursors: string[]) => {
    stop();
    setDeleting(undefined);
    setNotice("");
    setRequestedCursors(cursors);
  };
  const changeTab = (next: Tab) => {
    stop();
    setTab(next);
    setNotice("");
    setDeleting(undefined);
  };
  const toggleFavorite = (id: string) => {
    const next = new Set(favorites);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFavorites(next);
    saveVoiceFavorites(capabilities.connectionId, next);
  };
  const preview = async (voice: VoiceRecord) => {
    if (!voice.previewUrl) return;
    if (playing === voice.voiceId) {
      stop();
      return;
    }
    stop();
    setNotice("");
    const controller = new AbortController();
    previewRequest.current = controller;
    try {
      // The backend returns only its local proxy. Preserve API admission headers
      // and never send them to a provider-supplied URL in the browser.
      if (!voice.previewUrl.startsWith("/api/voices/"))
        throw Error(t("voiceLibrary.previewError"));
      const response = await fetch(voice.previewUrl, {
        headers,
        signal: controller.signal,
      });
      if (!response.ok) throw await responseError(response);
      const blob = await response.blob();
      if (controller.signal.aborted || !mounted.current) return;
      const url = URL.createObjectURL(blob);
      previewObjectUrl.current = url;
      const player = new Audio(url);
      audio.current = player;
      player.onended = () => {
        if (audio.current === player) stop();
      };
      player.onerror = () => {
        if (mounted.current && audio.current === player) {
          stop();
          setError(t("voiceLibrary.previewError"));
        }
      };
      await player.play();
      if (mounted.current && audio.current === player)
        setPlaying(voice.voiceId);
      else player.pause();
    } catch (failure) {
      if (!controller.signal.aborted && mounted.current) {
        stop();
        setError(errorMessage(failure));
      }
    }
  };
  const isSelectedVoice = (voice: VoiceRecord) =>
    selected?.connectionId === voice.connectionId && selected.voiceId === voice.voiceId;
  const relevant = voices.filter(
    (voice) =>
      tab === "all" ||
      (tab === "mine"
        ? voice.source === "uploaded"
        : favorites.has(voice.voiceId)),
  );
  const shown = relevant.filter((voice) =>
    filterFields.every(
      (field) => !filters[field] || voice.metadata[field] === filters[field],
    ),
  );
  const availableFilters = filterFields
    .map((field) => ({
      field,
      values: [
        ...new Set(
          [
            filters[field],
            ...voices.map((voice) => voice.metadata[field]),
          ].filter(Boolean),
        ),
      ].sort(),
    }))
    .filter((filter) => filter.values.length);
  const create = () => {
    stop();
    setError("");
    setCreating(true);
  };
  const createButton = (
    <button
      type="button"
      className="cw-voice-create-entry"
      onClick={create}
      disabled={capabilities.supportsUploadedVoices === false}
      title={
        capabilities.supportsUploadedVoices === false
          ? t("voiceLibrary.modelUnsupported")
          : undefined
      }
    >
      <span className="cw-voice-circle">
        <CanvasIcon name="plus" size={20} />
      </span>
      <span>{t("voiceLibrary.create")}</span>
    </button>
  );
  const incompatibility = (voice: VoiceRecord) =>
    t(
      voice.incompatibility === "voice_reference_required"
        ? "voiceLibrary.referenceRequired"
        : voice.incompatibility === "voice_transcript_required"
          ? "voiceLibrary.transcriptRequired"
          : voice.incompatibility === "voice_model_unsupported"
            ? "voiceLibrary.modelUnsupported"
            : "voiceLibrary.incompatible",
    );

  if (creating)
    return (
      <CreateVoiceForm
        modelConfigId={modelConfigId}
        capabilities={capabilities}
        onBack={() => setCreating(false)}
        onCreated={async (voice) => {
          if (voice.connectionId !== capabilities.connectionId) {
            setCreating(false);
            setError(t("voiceLibrary.connectionChanged"));
            return;
          }
          if (mounted.current) onSelect(voiceSelection(voice));
        }}
      />
    );
  return (
    <div className="cw-voice-library">
      <div
        className="cw-voice-tabs"
        role="tablist"
        aria-label={t("generation.field.voiceLibrary")}
      >
        {tabs.map((value, index) => (
          <button
            key={value}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            type="button"
            role="tab"
            aria-selected={tab === value}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => changeTab(value)}
            onKeyDown={(event) => {
              const target =
                event.key === "ArrowRight"
                  ? (index + 1) % tabs.length
                  : event.key === "ArrowLeft"
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? tabs.length - 1
                        : null;
              if (target !== null) {
                event.preventDefault();
                changeTab(tabs[target]!);
                tabRefs.current[target]?.focus();
              }
            }}
          >
            {t(`voiceLibrary.${value}`)}
          </button>
        ))}
      </div>
      {availableFilters.length > 0 && (
        <div className="cw-voice-filters">
          {availableFilters.map(({ field, values }) => (
            <select
              key={field}
              aria-label={t(`voiceLibrary.${field}`)}
              value={filters[field] || ""}
              onChange={(event) =>
                setFilters({ ...filters, [field]: event.target.value })
              }
            >
              <option value="">
                {t("voiceLibrary.allFilter", {
                  field: t(`voiceLibrary.${field}`),
                })}
              </option>
              {values.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          ))}
        </div>
      )}
      {loading && <p role="status">{t("voiceLibrary.loading")}</p>}
      {error && (
        <div className="cw-voice-error" role="alert">
          {error}{" "}
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            {t("voiceLibrary.retry")}
          </button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {!loading &&
        !error &&
        !paginated &&
        selected &&
        selected.connectionId === capabilities.connectionId &&
        !voices.some((voice) => voice.voiceId === selected.voiceId) && (
          <p className="cw-voice-hint" role="status">
            {t("voiceLibrary.selectionMissing")}
          </p>
        )}
      {deleting && (
        <div
          className="cw-voice-delete"
          role="alertdialog"
          aria-label={t("voiceLibrary.delete")}
        >
          <p>{t("voiceLibrary.deleteConfirm", { name: deleting.name })}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => setDeleting(undefined)}
          >
            {t("voiceLibrary.cancel")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              stop();
              try {
                await deleteVoice(modelConfigId, deleting);
                if (!mounted.current) return;
                setPage(
                  (current) =>
                    current && {
                      ...current,
                      voices: current.voices.filter(
                        (voice) => voice.voiceId !== deleting.voiceId,
                      ),
                    },
                );
                if (favorites.has(deleting.voiceId))
                  toggleFavorite(deleting.voiceId);
                setDeleting(undefined);
                setAttempt((value) => value + 1);
              } catch (failure) {
                if (mounted.current) setError(errorMessage(failure));
              } finally {
                if (mounted.current) setBusy(false);
              }
            }}
          >
            {t(busy ? "voiceLibrary.deleting" : "voiceLibrary.delete")}
          </button>
        </div>
      )}
      {!loading &&
        !error &&
        !paginated &&
        capabilities.requiresReferenceAudio &&
        !voices.some(
          (voice) => voice.compatible && voice.hasReferenceAudio,
        ) && (
          <p className="cw-voice-hint">{t("voiceLibrary.referenceRequired")}</p>
        )}
      {page && !loading && !relevant.length ? (
        <div
          className="cw-voice-empty"
          role="tabpanel"
          aria-label={t(`voiceLibrary.${tab}`)}
        >
          {createButton}
          <p>
            {t(
              capabilities.supportsUploadedVoices === false
                ? "voiceLibrary.modelUnsupported"
                : paginated && (tab !== "favorites" || favorites.size > 0)
                  ? "voiceLibrary.noPageMatches"
                  : tab === "favorites"
                    ? "voiceLibrary.emptyFavorites"
                    : "voiceLibrary.uploadGuidance",
            )}
          </p>
        </div>
      ) : (
        <div
          className="cw-voice-grid"
          key={page?.cursors.at(-1) ?? ""}
          role="tabpanel"
          aria-label={t(`voiceLibrary.${tab}`)}
        >
          {createButton}
          {shown.map((voice) => (
            <div
              className={`cw-voice-entry${isSelectedVoice(voice) ? " cw-is-active" : ""}`}
              key={voice.voiceId}
            >
              {voice.previewUrl ? (
                <button
                  type="button"
                  className="cw-voice-circle"
                  title={t(playing === voice.voiceId ? "voiceLibrary.stop" : "voiceLibrary.preview", {
                    name: voice.name,
                  })}
                  onClick={() => void preview(voice)}
                >
                  <CanvasIcon name={playing === voice.voiceId ? "pause" : "play"} size={18} />
                </button>
              ) : (
                <span
                  className="cw-voice-circle cw-voice-no-preview"
                  role={voice.compatible ? undefined : "img"}
                  aria-hidden={voice.compatible}
                  title={
                    voice.compatible
                      ? undefined
                      : t("voiceLibrary.previewUnavailable", { name: voice.name })
                  }
                >
                  <CanvasIcon name="audio" size={18} />
                </span>
              )}
              <button
                type="button"
                className="cw-voice-name"
                aria-pressed={isSelectedVoice(voice)}
                disabled={!voice.compatible}
                title={
                  !voice.compatible
                    ? incompatibility(voice)
                    : voice.previewUrl
                      ? voice.name
                      : t("voiceLibrary.selectWithoutPreview", { name: voice.name })
                }
                onClick={() => onSelect(voiceSelection(voice))}
              >
                {voice.name}
              </button>
              {!voice.compatible && (
                <small className="cw-voice-incompatible">
                  {incompatibility(voice)}
                </small>
              )}
              <button
                type="button"
                className={`cw-voice-favorite${favorites.has(voice.voiceId) ? " cw-is-favorite" : ""}`}
                aria-label={t(
                  favorites.has(voice.voiceId)
                    ? "voiceLibrary.unfavorite"
                    : "voiceLibrary.favorite",
                  { name: voice.name },
                )}
                aria-pressed={favorites.has(voice.voiceId)}
                onClick={() => toggleFavorite(voice.voiceId)}
              >
                <CanvasIcon name="star" size={14} />
              </button>
              <details className="cw-voice-actions">
                <summary
                  aria-label={t("voiceLibrary.actions", { name: voice.name })}
                >
                  <CanvasIcon name="more" size={16} />
                </summary>
                <div>
                  <button
                    type="button"
                    onClick={async (event) => {
                      const details = event.currentTarget.closest("details");
                      try {
                        await navigator.clipboard.writeText(voice.voiceId);
                        setNotice(t("voiceLibrary.copied"));
                      } catch {
                        setError(t("voiceLibrary.copyFailed"));
                      }
                      details?.removeAttribute("open");
                    }}
                  >
                    {t("voiceLibrary.copyId")}
                  </button>
                  {voice.canDelete &&
                    voice.source === "uploaded" &&
                    capabilities.canDelete && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.currentTarget
                            .closest("details")
                            ?.removeAttribute("open");
                          setDeleting(voice);
                        }}
                      >
                        {t("voiceLibrary.delete")}
                      </button>
                    )}
                </div>
              </details>
            </div>
          ))}
          {!loading && relevant.length > 0 && shown.length === 0 && (
            <p>
              {t(
                paginated
                  ? "voiceLibrary.noPageMatches"
                  : "voiceLibrary.noMatches",
              )}
            </p>
          )}
        </div>
      )}
      {paginated && page && (
        <div className="cw-voice-pages">
          <button
            type="button"
            disabled={loading || page.cursors.length === 0}
            onClick={() => changePage(page.cursors.slice(0, -1))}
          >
            {t("voiceLibrary.previousPage")}
          </button>
          <span>
            {t("voiceLibrary.page", { number: page.cursors.length + 1 })}
          </span>
          <button
            type="button"
            disabled={loading || !page.nextCursor}
            onClick={() => {
              if (page.nextCursor)
                changePage([...page.cursors, page.nextCursor]);
            }}
          >
            {t("voiceLibrary.nextPage")}
          </button>
        </div>
      )}
    </div>
  );
}
