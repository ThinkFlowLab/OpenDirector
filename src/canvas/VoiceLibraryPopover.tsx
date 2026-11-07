import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ComposerPopover } from "./ComposerPopover";
import { CanvasIcon } from "./CanvasIcon";
import { TooltipButton } from "./TooltipButton";
import { useI18n } from "../i18n/I18nProvider";
import { errorMessage } from "../backend/api";
import {
  createVoice,
  deleteVoice,
  listVoices,
  type Voice,
} from "../backend/voices";
import {
  serviceConnectionId,
  type ModelConfig,
} from "../backend/rules";
import {
  isVoiceFavorite,
  readVoiceFavorites,
  toggleVoiceFavorite,
  writeVoiceFavorites,
} from "./voiceFavorites";

type Tab = "all" | "mine" | "favorites";

const TAB_KEYS = {
  all: "generation.voice.tabs.all",
  mine: "generation.voice.tabs.mine",
  favorites: "generation.voice.tabs.favorites",
} as const;

export interface VoiceLibraryPopoverProps {
  config: ModelConfig;
  anchor: HTMLElement | null;
  composer: HTMLElement | null;
  selectedVoice?: string;
  selectedConnectionId?: string;
  onClose: () => void;
  onSelect: (voice: Voice) => void;
  onDeleted?: (voice: Voice) => void;
}

function voiceIsMine(voice: Voice) {
  return voice.source !== "builtin";
}

export function VoiceLibraryPopover({
  config,
  anchor,
  composer,
  selectedVoice,
  selectedConnectionId,
  onClose,
  onSelect,
  onDeleted,
}: VoiceLibraryPopoverProps) {
  const { t } = useI18n();
  const capabilities = config.inputRules.voiceLibrary;
  const connectionId = serviceConnectionId(config);
  const [tab, setTab] = useState<Tab>("all");
  const [view, setView] = useState<"library" | "create">("library");
  const [voices, setVoices] = useState<Voice[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [favorites, setFavorites] = useState(() => readVoiceFavorites());
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileUrl, setFileUrl] = useState("");
  const [name, setName] = useState("");
  const [consent, setConsent] = useState("");
  const [refText, setRefText] = useState("");
  const [speakerDescription, setSpeakerDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const abort = useRef<AbortController | null>(null);
  const nameId = useId();
  const consentId = useId();
  const refTextId = useId();
  const speakerId = useId();

  const load = useCallback(
    async (cursor?: string) => {
      if (!capabilities) return;
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      if (cursor) setLoadingMore(true);
      else {
        setLoading(true);
        setError("");
      }
      try {
        const page = await listVoices(config.id, {
          cursor,
          limit: 20,
          signal: controller.signal,
        });
        setVoices((current) =>
          cursor ? [...current, ...page.voices] : page.voices,
        );
        setNextCursor(page.nextCursor ?? null);
        setHasMore(page.hasMore);
      } catch (failure) {
        if (controller.signal.aborted) return;
        setError(errorMessage(failure));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [capabilities, config.id],
  );

  useEffect(() => {
    void load();
    return () => abort.current?.abort();
  }, [load]);

  useEffect(() => {
    if (!file) {
      setFileUrl("");
      return;
    }
    const url = URL.createObjectURL(file);
    setFileUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  if (!capabilities) return null;

  const favoriteFor = (voice: Voice) => ({
    connectionId,
    provider: voice.provider,
    voiceId: voice.id,
  });
  const favorite = (voice: Voice) =>
    isVoiceFavorite(favoriteFor(voice), favorites);
  const toggleFavorite = (voice: Voice) => {
    const next = toggleVoiceFavorite(favoriteFor(voice), favorites);
    setFavorites(next);
    writeVoiceFavorites(next);
  };
  const unsupported = (voice: Voice) =>
    Boolean(capabilities.filterUnsupported) &&
    voice.source === "builtin" &&
    voice.metadata?.refAudio === "required";
  const metadataKeys = Array.from(
    new Set(
      voices.flatMap((voice) =>
        Object.entries(voice.metadata ?? {})
          .filter(([, value]) => Boolean(value))
          .map(([key]) => key),
      ),
    ),
  );
  const visible = voices.filter((voice) => {
    if (tab === "favorites" && !favorite(voice)) return false;
    if (tab === "mine" && !voiceIsMine(voice)) return false;
    if (unsupported(voice)) return false;
    return metadataKeys.every(
      (key) => !filters[key] || voice.metadata?.[key] === filters[key],
    );
  });
  const empty = !loading && !error && !visible.length;
  const createAllowed = capabilities.canCreate && tab !== "favorites";
  const accept = capabilities.formats.map((format) => `.${format}`).join(",");
  const extension = file?.name.split(".").pop()?.toLowerCase() ?? "";
  const fileIssue = file
    ? file.size > capabilities.maxBytes
      ? t("generation.voice.fileTooLarge")
      : !capabilities.formats.includes(extension)
        ? t("generation.voice.fileType")
        : ""
    : "";

  const submitCreate = async () => {
    if (!file || creating) return;
    setCreating(true);
    setCreateError("");
    try {
      const created = await createVoice(config.id, {
        file,
        name,
        consent,
        refText,
        speakerDescription,
      });
      setVoices((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setView("library");
      setTab("mine");
      setFile(null);
      setName("");
      setConsent("");
      setRefText("");
      setSpeakerDescription("");
      onSelect(created);
    } catch (failure) {
      setCreateError(errorMessage(failure));
    } finally {
      setCreating(false);
    }
  };

  const remove = async (voice: Voice) => {
    setDeleting(true);
    setError("");
    try {
      await deleteVoice(config.id, voice.id);
      setVoices((current) => current.filter((item) => item.id !== voice.id));
      setDeleteConfirm(null);
      onDeleted?.(voice);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <ComposerPopover
      anchor={anchor}
      composer={composer}
      className="cw-voice-library"
      label={t("generation.field.voiceLibrary")}
      onClose={onClose}
    >
      <div className="cw-voice-library-heading">
        {view === "create" ? (
          <TooltipButton
            type="button"
            className="cw-icon-button cw-voice-back"
            label={t("generation.voice.back")}
            onClick={() => setView("library")}
          >
            <CanvasIcon name="chevronDown" size={15} />
          </TooltipButton>
        ) : null}
        <strong>
          {t(
            view === "create"
              ? "generation.voice.createTitle"
              : "generation.field.voiceLibrary",
          )}
        </strong>
        <TooltipButton
          type="button"
          className="cw-icon-button"
          label={t("generation.voice.close")}
          onClick={onClose}
        >
          <CanvasIcon name="close" size={15} />
        </TooltipButton>
      </div>

      {view === "create" ? (
        <form
          className="cw-voice-create"
          onSubmit={(event) => {
            event.preventDefault();
            void submitCreate();
          }}
        >
          <p className="cw-voice-help">{t("generation.voice.createHelp")}</p>
          <label className="cw-voice-file">
            <span>{t("generation.voice.file")}</span>
            <input
              type="file"
              accept={accept}
              required
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>
          {file ? (
            <div className="cw-voice-file-info">
              <strong>{file.name}</strong>
              <span>
                {t("generation.voice.fileSize", {
                  size: `${Math.ceil(file.size / 1024)} KB`,
                })}
              </span>
              <span>
                {t("generation.voice.fileFormats", {
                  formats: capabilities.formats.join(", ").toUpperCase(),
                })}
              </span>
              {capabilities.maxDurationSeconds ? (
                <span>
                  {t("generation.voice.durationLimit", {
                    seconds: capabilities.maxDurationSeconds,
                  })}
                </span>
              ) : null}
              <audio controls src={fileUrl} aria-label={t("generation.voice.localPreview")} />
            </div>
          ) : null}
          <label htmlFor={nameId}>{t("generation.voice.name")}</label>
          <input
            id={nameId}
            value={name}
            required
            maxLength={64}
            placeholder={t("generation.voice.namePlaceholder")}
            onChange={(event) => setName(event.target.value)}
          />
          <small>{t("generation.voice.nameRule")}</small>
          {capabilities.requiresConsent ? (
            <>
              <label htmlFor={consentId}>{t("generation.voice.consent")}</label>
              <input
                id={consentId}
                value={consent}
                required
                maxLength={512}
                placeholder={t("generation.voice.consentPlaceholder")}
                onChange={(event) => setConsent(event.target.value)}
              />
              <small>{t("generation.voice.consentHelp")}</small>
            </>
          ) : null}
          {capabilities.provider === "vllm-omni" ? (
            <>
              <label htmlFor={refTextId}>
                {t("generation.voice.transcript")}
                {capabilities.requiresRefText ? " *" : ""}
              </label>
              <textarea
                id={refTextId}
                value={refText}
                required={capabilities.requiresRefText}
                maxLength={8000}
                placeholder={t("generation.voice.transcriptPlaceholder")}
                onChange={(event) => setRefText(event.target.value)}
              />
              <small>
                {t(
                  capabilities.requiresRefText
                    ? "generation.voice.transcriptRequired"
                    : "generation.voice.transcriptHelp",
                )}
              </small>
              <label htmlFor={speakerId}>
                {t("generation.voice.description")}
              </label>
              <textarea
                id={speakerId}
                value={speakerDescription}
                maxLength={500}
                placeholder={t("generation.voice.descriptionPlaceholder")}
                onChange={(event) => setSpeakerDescription(event.target.value)}
              />
            </>
          ) : null}
          {createError || fileIssue ? (
            <p className="cw-voice-error" role="alert">
              {createError || fileIssue}
            </p>
          ) : null}
          <div className="cw-voice-form-actions">
            <button
              type="button"
              className="cw-voice-secondary"
              onClick={() => setView("library")}
            >
              {t("generation.voice.cancel")}
            </button>
            <button
              type="submit"
              className="cw-voice-primary"
              disabled={creating || !file || Boolean(fileIssue) || !name.trim() ||
                (capabilities.requiresConsent && !consent.trim()) ||
                (capabilities.requiresRefText && !refText.trim())}
            >
              {t(creating ? "generation.voice.creating" : "generation.voice.createSubmit")}
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="cw-voice-tabs" role="tablist">
            {(["all", "mine", "favorites"] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={tab === item}
                className={tab === item ? "cw-is-active" : ""}
                onClick={() => setTab(item)}
              >
                {t(TAB_KEYS[item])}
              </button>
            ))}
          </div>
          {metadataKeys.length ? (
            <div className="cw-voice-filters">
              {metadataKeys.map((key) => (
                <select
                  key={key}
                  aria-label={t("generation.voice.filter", { name: key })}
                  value={filters[key] ?? ""}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      [key]: event.target.value,
                    }))
                  }
                >
                  <option value="">{t("generation.voice.filterAll", { name: key })}</option>
                  {Array.from(
                    new Set(
                      voices.map((voice) => voice.metadata?.[key]).filter(Boolean),
                    ),
                  ).map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              ))}
            </div>
          ) : null}
          {error ? (
            <div className="cw-voice-error" role="alert">
              <span>{error}</span>
              <button type="button" onClick={() => void load()}>
                {t("generation.voice.retry")}
              </button>
            </div>
          ) : null}
          {loading ? (
            <p className="cw-voice-loading">{t("generation.voice.loading")}</p>
          ) : (
            <div className="cw-voice-grid" role="list">
              {createAllowed ? (
                <button
                  type="button"
                  className="cw-voice-create-tile"
                  aria-label={t("generation.voice.create")}
                  onClick={() => {
                    setCreateError("");
                    setView("create");
                  }}
                >
                  <CanvasIcon name="plus" size={20} />
                  <strong>{t("generation.voice.create")}</strong>
                  <small>{t("generation.voice.createShort")}</small>
                </button>
              ) : null}
              {visible.map((voice) => {
                const selected =
                  voice.id === selectedVoice &&
                  selectedConnectionId === connectionId;
                const selectedFavorite = favorite(voice);
                return (
                  <article
                    key={voice.id}
                    className={`cw-voice-card${selected ? " cw-is-active" : ""}`}
                    role="listitem"
                  >
                    <div className="cw-voice-card-actions">
                      <button
                        type="button"
                        className={`cw-voice-star${selectedFavorite ? " cw-is-favorite" : ""}`}
                        aria-label={t(
                          selectedFavorite
                            ? "generation.voice.unfavorite"
                            : "generation.voice.favorite",
                          { name: voice.name },
                        )}
                        aria-pressed={selectedFavorite}
                        onClick={() => toggleFavorite(voice)}
                      >
                        <CanvasIcon name="star" size={14} />
                      </button>
                      <button
                        type="button"
                        className="cw-voice-preview"
                        aria-label={t("generation.voice.preview", {
                          name: voice.name,
                        })}
                        title={t("generation.voice.previewUnavailable")}
                        disabled
                      >
                        <CanvasIcon name="play" size={13} />
                      </button>
                    </div>
                    <button
                      type="button"
                      className="cw-voice-select"
                      aria-label={t("generation.voice.select", { name: voice.name })}
                      aria-pressed={selected}
                      onClick={() => onSelect(voice)}
                    >
                      <span className="cw-voice-avatar">
                        <CanvasIcon name="audio" size={22} />
                      </span>
                      <strong title={voice.name}>{voice.name}</strong>
                      <small>
                        {t(
                          voice.source === "builtin"
                            ? "generation.voice.source.builtin"
                            : voice.source === "uploaded"
                              ? "generation.voice.source.uploaded"
                              : "generation.voice.source.custom",
                        )}
                      </small>
                      {voice.id !== voice.name ? (
                        <code title={voice.id}>{voice.id}</code>
                      ) : null}
                      {selected ? (
                        <span className="cw-voice-selected">
                          <CanvasIcon name="check" size={13} />
                        </span>
                      ) : null}
                    </button>
                    {voice.deletable ? (
                      deleteConfirm === voice.id ? (
                        <div className="cw-voice-delete-confirm">
                          <span>{t("generation.voice.deleteConfirm")}</span>
                          <button
                            type="button"
                            disabled={deleting}
                            onClick={() => void remove(voice)}
                          >
                            {t("generation.voice.deleteAccept")}
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteConfirm(null)}
                          >
                            {t("generation.voice.deleteCancel")}
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="cw-voice-delete"
                          aria-label={t("generation.voice.delete", {
                            name: voice.name,
                          })}
                          onClick={() => setDeleteConfirm(voice.id)}
                        >
                          <CanvasIcon name="trash" size={13} />
                        </button>
                      )
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
          {empty ? (
            <div className="cw-voice-empty">
              <strong>
                {t(
                  tab === "favorites"
                    ? "generation.voice.emptyFavorites"
                    : tab === "mine"
                      ? "generation.voice.emptyMine"
                      : "generation.voice.emptyAll",
                )}
              </strong>
              <p>
                {t(
                  tab === "favorites"
                    ? "generation.voice.emptyFavoritesHelp"
                    : tab === "mine"
                      ? "generation.voice.emptyMineHelp"
                      : "generation.voice.emptyAllHelp",
                )}
              </p>
              {createAllowed ? (
                <button type="button" onClick={() => setView("create")}>
                  {t("generation.voice.create")}
                </button>
              ) : null}
            </div>
          ) : null}
          {hasMore ? (
            <button
              type="button"
              className="cw-voice-load-more"
              disabled={loadingMore}
              onClick={() => void load(nextCursor ?? undefined)}
            >
              {t(loadingMore ? "generation.voice.loading" : "generation.voice.loadMore")}
            </button>
          ) : null}
        </>
      )}
    </ComposerPopover>
  );
}
