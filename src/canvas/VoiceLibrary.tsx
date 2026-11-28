import { useEffect, useMemo, useRef, useState } from "react";
import { errorMessage, headers, responseError } from "../backend/api";
import {
  deleteVoice,
  listVoices,
  VOICE_PAGE_SIZE,
  voiceSelection,
  type VoiceCapabilities,
  type VoiceRecord,
  type VoiceSelection,
} from "../backend/voices";
import { useI18n } from "../i18n/I18nProvider";
import { CanvasIcon } from "./CanvasIcon";
import { CreateVoiceForm } from "./CreateVoiceForm";
import {
  readVoiceFavoriteRecords,
  readVoiceFavorites,
  saveVoiceFavoriteRecords,
  saveVoiceFavorites,
} from "./voiceFavorites";
import "./voice-library.css";

type Tab = "all" | "mine" | "favorites";
type VoicePage = {
  voices: VoiceRecord[];
  cursors: string[];
  nextCursor: string | null;
};
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
  const [page, setPage] = useState<VoicePage>();
  const [firstMossPage, setFirstMossPage] = useState<VoicePage>();
  const paginated = Boolean(page?.cursors.length || page?.nextCursor);
  const moss = capabilities.provider === "moss";
  const mossFavoritesTab = moss && tab === "favorites";
  const [favorites, setFavorites] = useState(() =>
    readVoiceFavorites(capabilities.connectionId),
  );
  const [favoriteRecords, setFavoriteRecords] = useState(() =>
    moss
      ? readVoiceFavoriteRecords(capabilities.connectionId, modelConfigId)
      : new Map<string, VoiceRecord>(),
  );
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [pageLoading, setPageLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [searchPage, setSearchPage] = useState(0);
  const [catalog, setCatalog] = useState<VoicePage>();
  const catalogProgress = useRef<VoicePage>(undefined);
  const [catalogError, setCatalogError] = useState("");
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchTerm = query.trim().toLowerCase();
  const searching = searchTerm.length > 0;
  const mossCatalog = catalog ?? firstMossPage;
  const knownMossFavorites = useMemo(() => {
    const known = new Map<string, VoiceRecord>();
    if (!moss || !favorites.size) return known;
    for (const id of favorites) {
      const cached = favoriteRecords.get(id);
      if (cached) known.set(id, cached);
    }
    for (const source of [firstMossPage, catalog, page]) {
      for (const voice of source?.voices ?? []) {
        if (favorites.has(voice.voiceId)) known.set(voice.voiceId, voice);
      }
    }
    return known;
  }, [moss, favorites, favoriteRecords, firstMossPage, catalog, page]);
  const missingFavorites = mossFavoritesTab && knownMossFavorites.size < favorites.size;
  const needsCatalog = mossFavoritesTab ? missingFavorites : searching;
  const catalogView = needsCatalog ? mossCatalog : undefined;
  const hasMoreCatalogPages = Boolean(catalogView?.nextCursor);
  const voices = mossFavoritesTab
    ? [...knownMossFavorites.values()]
    : ((searching ? mossCatalog ?? page : page)?.voices ?? []);
  const listLoading = catalogView ? hasMoreCatalogPages && !catalogError : pageLoading;
  const loading = (!mossFavoritesTab || missingFavorites) && listLoading;
  const listError = catalogView ? catalogError : pageError;
  const displayError = error || (mossFavoritesTab && !missingFavorites ? "" : listError);
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
    setPageLoading(true);
    setPageError("");
    const scope = {
      connectionId: capabilities.connectionId,
      page: capabilities.provider === "moss"
        ? { after: requestedCursors.at(-1) }
        : undefined,
    };
    listVoices(modelConfigId, controller.signal, scope)
      .then((data) => {
        if (controller.signal.aborted) return;
        if (data.connectionId !== capabilities.connectionId)
          throw Error(t("voiceLibrary.connectionChanged"));
        if (data.nextCursor && requestedCursors.includes(data.nextCursor))
          throw Error(t("voiceLibrary.invalidPage"));
        const loaded = {
          voices: data.voices,
          cursors: requestedCursors,
          nextCursor: data.nextCursor ?? null,
        };
        setPage(loaded);
        if (capabilities.provider === "moss" && requestedCursors.length === 0)
          setFirstMossPage(loaded);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setPageError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setPageLoading(false);
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
  useEffect(() => {
    if (!hasMoreCatalogPages || !firstMossPage || creating) return;
    const controller = new AbortController();
    setCatalogError("");
    const readRemainingPages = async (prefix: VoicePage) => {
      let current = prefix;
      let size = 100;
      const seenIds = new Set(current.voices.map((voice) => voice.voiceId));
      const seenCursors = new Set(current.cursors);
      while (current.nextCursor && !controller.signal.aborted) {
        const after = current.nextCursor;
        const data = await listVoices(modelConfigId, controller.signal, {
          connectionId: capabilities.connectionId,
          page: { after, size },
        });
        if (controller.signal.aborted) return;
        if (data.connectionId !== capabilities.connectionId)
          throw Error(t("voiceLibrary.connectionChanged"));
        seenCursors.add(after);
        if (
          (data.nextCursor && seenCursors.has(data.nextCursor)) ||
          data.voices.some((voice) => seenIds.has(voice.voiceId))
        ) {
          throw Error(t("voiceLibrary.invalidPage"));
        }
        for (const voice of data.voices) seenIds.add(voice.voiceId);
        if (data.voices.length <= 50) size = 50;
        current = {
          voices: [...current.voices, ...data.voices],
          cursors: [...current.cursors, after],
          nextCursor: data.nextCursor ?? null,
        };
        catalogProgress.current = current;
        setCatalog(current);
      }
    };
    // Resume at the accepted prefix for a new search or an unresolved favorite.
    void readRemainingPages(catalogProgress.current ?? firstMossPage).catch(
      (failure) => {
        if (!controller.signal.aborted) setCatalogError(errorMessage(failure));
      },
    );
    return () => controller.abort();
  }, [
    hasMoreCatalogPages,
    firstMossPage,
    creating,
    modelConfigId,
    capabilities.connectionId,
    catalogAttempt,
    t,
  ]);
  useEffect(() => {
    if (!moss) return;
    if (
      favoriteRecords.size === knownMossFavorites.size &&
      [...knownMossFavorites].every(([id, voice]) => favoriteRecords.get(id) === voice)
    ) return;
    setFavoriteRecords(knownMossFavorites);
    saveVoiceFavoriteRecords(capabilities.connectionId, modelConfigId, knownMossFavorites);
  }, [moss, favoriteRecords, knownMossFavorites, capabilities.connectionId, modelConfigId]);
  const resetCardActivity = () => {
    stop();
    setDeleting(undefined);
    setNotice("");
    setError("");
  };
  const firstBrowsePage = () => {
    setRequestedCursors((current) => current.length ? [] : current);
  };
  const changePage = (cursors: string[]) => {
    resetCardActivity();
    setRequestedCursors(cursors);
  };
  const changeTab = (next: Tab) => {
    if (next === tab) return;
    resetCardActivity();
    setTab(next);
    setSearchPage(0);
    if (!searching) firstBrowsePage();
  };
  const changeQuery = (value: string) => {
    resetCardActivity();
    setQuery(value);
    setSearchPage(0);
    if (!value.trim()) firstBrowsePage();
  };
  const toggleFavorite = (voice: VoiceRecord) => {
    const id = voice.voiceId;
    const next = new Set(favorites);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFavorites(next);
    saveVoiceFavorites(capabilities.connectionId, next);
    if (moss) {
      const records = new Map(knownMossFavorites);
      if (next.has(id)) records.set(id, voice);
      else records.delete(id);
      setFavoriteRecords(records);
      saveVoiceFavoriteRecords(capabilities.connectionId, modelConfigId, records);
    }
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
  const matches = relevant.filter((voice) =>
    (!searching || voice.name.toLowerCase().includes(searchTerm)) &&
    filterFields.every(
      (field) => !filters[field] || voice.metadata[field] === filters[field],
    ),
  );
  const emptyBrowseMessage = tab === "favorites"
    ? missingFavorites
      ? "voiceLibrary.unavailableFavorites"
      : "voiceLibrary.emptyFavorites"
    : capabilities.supportsUploadedVoices === false
      ? "voiceLibrary.modelUnsupported"
      : paginated
        ? "voiceLibrary.noPageMatches"
        : "voiceLibrary.uploadGuidance";
  const resultPageCount = Math.ceil(matches.length / VOICE_PAGE_SIZE);
  const resultPage = Math.min(searchPage, Math.max(0, resultPageCount - 1));
  const localPages = searching || mossFavoritesTab;
  const shown = localPages
    ? matches.slice(resultPage * VOICE_PAGE_SIZE, (resultPage + 1) * VOICE_PAGE_SIZE)
    : matches;
  const pageNumber = localPages ? resultPage : page?.cursors.length ?? 0;
  const canAdvance = localPages
    ? resultPage + 1 < resultPageCount
    : Boolean(page?.nextCursor);
  const pageControls = localPages ? resultPageCount > 1 : paginated;
  const turnPage = (direction: -1 | 1) => {
    if (localPages) {
      resetCardActivity();
      setSearchPage(resultPage + direction);
    } else if (page) {
      if (direction === -1) changePage(page.cursors.slice(0, -1));
      else if (page.nextCursor) changePage([...page.cursors, page.nextCursor]);
    }
  };
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
      <div className="cw-voice-search">
        <CanvasIcon name="search" size={16} aria-hidden="true" />
        <input
          ref={searchInput}
          type="search"
          aria-label={t("voiceLibrary.search")}
          placeholder={t("voiceLibrary.search")}
          value={query}
          onChange={(event) => changeQuery(event.target.value)}
        />
        {query && (
          <button
            type="button"
            aria-label={t("voiceLibrary.clearSearch")}
            title={t("voiceLibrary.clearSearch")}
            onClick={() => {
              changeQuery("");
              searchInput.current?.focus();
            }}
          >
            <CanvasIcon name="close" size={14} />
          </button>
        )}
      </div>
      {availableFilters.length > 0 && (
        <div className="cw-voice-filters">
          {availableFilters.map(({ field, values }) => (
            <select
              key={field}
              aria-label={t(`voiceLibrary.${field}`)}
              value={filters[field] || ""}
              onChange={(event) => {
                setFilters({ ...filters, [field]: event.target.value });
                setSearchPage(0);
              }}
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
      {loading && (
        <p className="cw-voice-loading" role="status">
          <span className="cw-voice-loading-wave" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {t(mossFavoritesTab
            ? "voiceLibrary.loadingFavorites"
            : catalogView
              ? "voiceLibrary.searchingMore"
              : "voiceLibrary.loading")}
        </p>
      )}
      {displayError && (
        <div className="cw-voice-error" role="alert">
          {displayError}{" "}
          <button
            type="button"
            onClick={() => {
              setError("");
              if (catalogView && catalogError)
                setCatalogAttempt((value) => value + 1);
              else setAttempt((value) => value + 1);
            }}
          >
            {t("voiceLibrary.retry")}
          </button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {!loading &&
        !displayError &&
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
                  toggleFavorite(deleting);
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
        !displayError &&
        !paginated &&
        capabilities.requiresReferenceAudio &&
        !voices.some(
          (voice) => voice.compatible && voice.hasReferenceAudio,
        ) && (
          <p className="cw-voice-hint">{t("voiceLibrary.referenceRequired")}</p>
        )}
      {searching && !loading && !displayError && !shown.length ? (
        <div
          className="cw-voice-empty"
          role="tabpanel"
          aria-label={t(`voiceLibrary.${tab}`)}
        >
          {createButton}
          <p role="status">{t("voiceLibrary.noSearchMatches")}</p>
        </div>
      ) : !searching && (page || mossFavoritesTab) && !loading && !displayError && !relevant.length ? (
        <div
          className="cw-voice-empty"
          role="tabpanel"
          aria-label={t(`voiceLibrary.${tab}`)}
        >
          {createButton}
          <p>{t(emptyBrowseMessage)}</p>
        </div>
      ) : (
        <div
          className="cw-voice-grid"
          key={localPages ? `results:${resultPage}` : page?.cursors.at(-1) ?? ""}
          role="tabpanel"
          aria-label={t(`voiceLibrary.${tab}`)}
        >
          {createButton}
          {loading && !displayError && shown.length === 0 &&
            [0, 1, 2].map((slot) => (
              <div className="cw-voice-entry cw-voice-skeleton" key={slot} aria-hidden="true">
                <span className="cw-voice-circle" />
                <span className="cw-voice-skeleton-name" />
                <span className="cw-voice-skeleton-actions" />
              </div>
            ))}
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
                onClick={() => toggleFavorite(voice)}
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
          {!searching && !loading && relevant.length > 0 && shown.length === 0 && (
            <p>
              {t(
                paginated && !mossFavoritesTab
                  ? "voiceLibrary.noPageMatches"
                  : "voiceLibrary.noMatches",
              )}
            </p>
          )}
        </div>
      )}
      {pageControls && (
        <div className="cw-voice-pages">
          <button
            type="button"
            disabled={(!localPages && loading) || pageNumber === 0}
            onClick={() => turnPage(-1)}
          >
            {t("voiceLibrary.previousPage")}
          </button>
          <span>
            {t("voiceLibrary.page", { number: pageNumber + 1 })}
          </span>
          <button
            type="button"
            disabled={(!localPages && loading) || !canAdvance}
            onClick={() => turnPage(1)}
          >
            {t("voiceLibrary.nextPage")}
          </button>
        </div>
      )}
    </div>
  );
}
