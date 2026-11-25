import { useEffect, useRef, useState } from "react";
import type {
  Asset,
  CanvasItem,
  InputSnapshot,
  ObjectVersion,
  ProjectSnapshot,
} from "../contracts/generated.ts";
import {
  assetReference,
  creationClient,
  creationPath,
} from "../backend/creationClient.ts";
import { errorMessage, request } from "../backend/api.ts";
import { CanvasIcon } from "./CanvasIcon";
import { NodeVersionComposer } from "./NodeVersionComposer";
import "./generation-composer.css";
import "./node-version-history.css";
import { useT } from "../i18n/I18nProvider.tsx";

export interface NodeVersion {
  asset: Asset;
  source: string;
  available: boolean;
  inputSnapshot: InputSnapshot | null;
  modelAvailable: boolean | null;
  currentReferencesDiffer: boolean;
  jobId: string | null;
  createdAt?: string | null;
}
interface VersionListing {
  item: CanvasItem;
  versions: NodeVersion[];
  currentAssetId: string | null;
  expectedVersions: ObjectVersion[];
  eventCursor: number;
}

/** One inventory request per content change, never per node or pointer movement. */
export function useNodeVersionCounts(projectId: string) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    const client = creationClient(projectId);
    let key = "",
      active = true,
      ticket = 0;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    setCounts({});
    const update = (snapshot: ProjectSnapshot) => {
      const next = JSON.stringify([
        snapshot.assets.map((asset) => asset.id),
        snapshot.results.map((result) => result.id),
        snapshot.generationSpecs.map((spec) => [spec.id, spec.currentResultId]),
        snapshot.canvasItems.map((item) => [item.id, item.binding]),
      ]);
      if (next === key) return;
      key = next;
      const sequence = ++ticket;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void request<{ counts: Record<string, number> }>(
          `${creationPath(projectId)}/version-counts`,
          { signal: abort.signal },
        )
          .then((value) => {
            if (active && sequence === ticket) setCounts(value.counts);
          })
          .catch(() => {
            if (active && sequence === ticket) key = "";
          });
      }, 180);
    };
    const unsubscribe = client.listen(update);
    if (client.snapshot) update(client.snapshot);
    return () => {
      active = false;
      abort.abort();
      clearTimeout(timer);
      unsubscribe();
    };
  }, [projectId]);
  return counts;
}

export function VersionMedia({
  projectId,
  assetId,
  kind,
  name,
  compact = false,
}: {
  projectId: string;
  assetId: string;
  kind: string;
  name: string;
  compact?: boolean;
}) {
  const t = useT();
  const [content, setContent] = useState<string>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setContent(undefined);
    setError("");
    const client = creationClient(projectId);
    void (
      kind === "text"
        ? client.textContent(assetId)
        : kind === "image"
          ? client.thumbnailUrl(assetId)
          : client.mediaUrl(assetId)
    )
      .then((value) => {
        if (active) setContent(value);
      })
      .catch((reason) => {
        if (active) setError(errorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, [projectId, assetId, kind]);
  return (
    <div className={`cw-version-media${compact ? " is-compact" : ""}`}>
      {error ? (
        <span role="status">
          {t("canvasNodes.version.missingMedia", { error })}
        </span>
      ) : content === undefined ? (
        <span>{t("canvasNodes.version.reading")}</span>
      ) : kind === "text" ? (
        <pre>{content || t("canvasNodes.version.emptyText")}</pre>
      ) : kind === "image" ? (
        <img src={content} alt={name} />
      ) : kind === "video" ? (
        <video src={content} controls preload="metadata" aria-label={name} />
      ) : kind === "audio" ? (
        <audio src={content} controls preload="metadata" aria-label={name} />
      ) : (
        <span>{name}</span>
      )}
    </div>
  );
}

function VersionDetails({
  projectId,
  version,
}: {
  projectId: string;
  version: NodeVersion;
}) {
  const t = useT();
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    // Keep the list geometry fixed without fetching every historical media file.
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    if (element.current) observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={element} className="cw-version-details" aria-busy={!visible}>
      {visible && (
        <>
          {version.available ? (
            <VersionMedia
              projectId={projectId}
              assetId={version.asset.id}
              kind={version.asset.kind}
              name={version.asset.name}
            />
          ) : (
            <p role="status">{t("canvasNodes.version.missingFile")}</p>
          )}
          <NodeVersionComposer projectId={projectId} version={version} />
        </>
      )}
    </div>
  );
}

export function NodeVersionHistory({
  projectId,
  itemId,
  anchor,
  preparation,
  readOnly = false,
  onClose,
  onApplied,
}: {
  projectId: string;
  itemId: string;
  anchor: DOMRect;
  preparation: Promise<void>;
  readOnly?: boolean;
  onClose: () => void;
  onApplied: (referencesChanged: boolean) => void;
}) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    const resize = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const [listing, setListing] = useState<VersionListing>();
  const [preparing, setPreparing] = useState(true);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => {
      alive.current = false;
      element.close();
      previous?.isConnected && previous.focus();
    };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    setListing(undefined);
    setPreparing(true);
    setError("");
    setStale(false);
    void preparation
      .then(() => {
        abort.signal.throwIfAborted();
        setPreparing(false);
        return request<VersionListing>(
          `${creationPath(projectId)}/items/${itemId}/versions`,
          { signal: abort.signal },
        );
      })
      .then((value) => {
        if (abort.signal.aborted) return;
        // The service lists newest assets first; display creation order,
        // independent of which result is currently adopted.
        const versions = [...value.versions].reverse();
        setListing({ ...value, versions });
        setSelected((id) =>
          versions.some((version) => version.asset.id === id)
            ? id
            : (versions[0]?.asset.id ?? ""),
        );
      })
      .catch((reason) => {
        if (!abort.signal.aborted) setError(errorMessage(reason));
      });
    return () => abort.abort();
  }, [projectId, itemId, preparation]);
  const apply = async () => {
    const version = listing?.versions.find((row) => row.asset.id === selected);
    if (!listing || !version || pending.current || stale) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await creationClient(projectId).command(
        "canvas.applyVersion",
        {
          itemId,
          asset: assetReference(version.asset),
          referencePolicy: "follow_current",
        },
        listing.expectedVersions,
      );
      if (alive.current) onApplied(version.currentReferencesDiffer);
    } catch (reason) {
      if (alive.current) {
        setError(
          t("canvasNodes.version.reopen", { message: errorMessage(reason) }),
        );
        setStale(true);
      }
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const close = () => {
    if (!pending.current) onClose();
  };
  const width = Math.min(560, viewport.width - 32);
  const height = Math.min(210, viewport.height - 32);
  const left = Math.max(
    16,
    Math.min(anchor.right + 12, viewport.width - width - 16),
  );
  const top = Math.max(16, Math.min(anchor.top, viewport.height - height - 16));
  const current = listing?.versions.find((row) => row.asset.id === selected);
  return (
    <dialog
      ref={dialog}
      className="cw-version-dialog nodrag nopan nowheel"
      aria-label={t("canvasNodes.version.aria")}
      style={{ left, top, width, height }}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            close();
        }
      }}
      onKeyDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header>
        <div>
          <strong>
            {t("canvasNodes.version.title", {
              title:
                listing?.item.title ?? t("canvasNodes.version.nodeFallback"),
            })}
          </strong>
          <small>
            {listing
              ? t("canvasNodes.version.count", {
                  count: listing.versions.length,
                })
              : error
                ? t("canvasNodes.version.loadFailed")
                : preparing
                  ? t("canvasNodes.version.saving")
                  : t("canvasNodes.version.loading")}
          </small>
        </div>
        <button
          aria-label={t("canvasNodes.version.close")}
          disabled={busy}
          onClick={close}
        >
          <CanvasIcon name="close" size={14} />
        </button>
      </header>
      <div
        className="cw-version-list"
        role="radiogroup"
        aria-label={t("canvasNodes.version.select")}
        aria-busy={!listing || busy}
      >
        {listing && !listing.versions.length && (
          <p>{t("canvasNodes.version.none")}</p>
        )}
        {listing?.versions.map((version, index) => {
          const chosen = selected === version.asset.id;
          return (
            <article
              key={version.asset.id}
              className={`cw-version-entry${chosen ? " is-selected" : ""}`}
              role="radio"
              aria-label={t("canvasNodes.version.item", {
                index: index + 1,
              })}
              data-version-asset-id={version.asset.id}
              data-current-version={version.asset.id === listing.currentAssetId}
              aria-checked={chosen}
              aria-disabled={busy}
              tabIndex={busy ? -1 : 0}
              onClick={() => {
                if (!busy) setSelected(version.asset.id);
              }}
              onKeyDown={(event) => {
                if (
                  event.target === event.currentTarget &&
                  !busy &&
                  (event.key === "Enter" || event.key === " ")
                ) {
                  event.preventDefault();
                  setSelected(version.asset.id);
                }
              }}
            >
              <VersionDetails projectId={projectId} version={version} />
            </article>
          );
        })}
      </div>
      {error && (
        <p className="cw-version-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <small>{t("canvasNodes.version.hint")}</small>
        <div>
          <button
            className="cw-version-apply"
            disabled={
              readOnly || busy || stale || !current?.available || listing?.item.locked
            }
            onClick={() => void apply()}
          >
            {busy
              ? t("canvasNodes.version.applying")
              : t("canvasNodes.version.apply")}
          </button>
        </div>
      </footer>
    </dialog>
  );
}
