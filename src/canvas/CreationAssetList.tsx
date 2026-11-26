import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { Asset } from "../contracts/generated.ts";
import {
  creationClient,
  creationPath,
  objectVersion,
} from "../backend/creationClient.ts";
import { errorMessage, json, request } from "../backend/api.ts";
import { classifyImportFile } from "./editorMedia.ts";
import { readImportBatch } from "./importBatch.ts";
import type { Point } from "./model.ts";
import { findAssetItem, showExistingItem, showNewAssetItem } from "./canvasAssetPlacement.ts";
import { CanvasIcon } from "./CanvasIcon.tsx";
import {
  AssetThumbnail,
  HoverPreview,
  type AssetPreview,
} from "./CreationAssetPreview.tsx";
import "./creation-assets.css";
import { useT } from "../i18n/I18nProvider.tsx";
import { PREVIEW_LABEL_KEYS } from "./creationPreviewText.ts";
import type { MessageKey } from "../i18n/types.ts";

interface Usage {
  assetId: string;
  used: boolean;
  reasons: { type: string; id: string }[];
  hiddenItemIds: string[];
}
interface Row {
  asset: Asset;
  usage: Usage;
  owners: { itemId: string; title: string; visible: boolean }[];
  specId: string | null;
  createdOrder: number;
  categories: string[];
}
type Category =
  | "all"
  | "image"
  | "video"
  | "audio"
  | "text"
  | "subject"
  | "timeline";
const CATEGORIES: readonly { id: Category; label: MessageKey }[] = [
  { id: "all", label: "canvasNodes.assets.all" },
  { id: "image", label: "canvasNodes.assets.image" },
  { id: "video", label: "canvasNodes.assets.video" },
  { id: "audio", label: "canvasNodes.assets.audio" },
  { id: "text", label: "canvasNodes.assets.text" },
  { id: "subject", label: "canvasNodes.assets.subject" },
  { id: "timeline", label: "canvasNodes.assets.timeline" },
] as const;
interface Listing {
  items: Row[];
  nodes: NodeRow[];
  total: number;
  eventCursor: number;
  counts: Record<Category, number>;
}
interface NodeRow {
  itemId: string;
  title: string;
  kind: "subject" | "timeline";
  visible: boolean;
  asset: Asset | null;
  previewLabel: string;
}
interface Impact {
  fingerprint: string;
  usage: Usage[];
  canDelete: boolean;
  clearsAllUndoRedo: boolean;
  hiddenItemIds: string[];
}

/** OpenDirector's asset management layout without its independent preview branch. */
export function CreationAssetList({
  projectId,
  anchor,
  hidden = false,
  onClose,
  actions,
}: {
  projectId: string;
  anchor: HTMLElement | null;
  hidden?: boolean;
  onClose: () => void;
  actions:
    | { kind: "preview"; onPreview: (asset: Asset) => void }
    | { kind: "canvas"; onLocate: (id: string) => void; position: Point }
    | {
        kind: "chat";
        referenceDisabled: boolean;
        onReference: (asset: Asset) => void;
        onCreateTimeline: () => Promise<string>;
        onOpenTimeline: (itemId: string) => Promise<void>;
      };
}) {
  const t = useT();
  const previewLabel = (label: string) => {
    const key = PREVIEW_LABEL_KEYS[label];
    return key ? t(key) : label;
  };
  const [text, setText] = useState(""),
    [visibility, setVisibility] = useState("all"),
    [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category>("all");
  const [preview, setPreview] = useState<AssetPreview | null>(null);
  const previewTimer = useRef<number | undefined>(undefined);
  const clearPreview = useCallback(() => {
    window.clearTimeout(previewTimer.current);
    setPreview(null);
  }, []);
  useEffect(() => {
    window.addEventListener("resize", clearPreview);
    return () => {
      window.removeEventListener("resize", clearPreview);
      window.clearTimeout(previewTimer.current);
    };
  }, [clearPreview]);
  const showPreview = (
    button: HTMLButtonElement,
    value: Omit<AssetPreview, "anchor">,
  ) => {
    clearPreview();
    const panel = dialog.current!.getBoundingClientRect();
    const bounds = button.getBoundingClientRect();
    const anchor = new DOMRect(
      panel.left,
      bounds.top,
      panel.width,
      bounds.height,
    );
    previewTimer.current = window.setTimeout(
      () => setPreview({ ...value, anchor }),
      200,
    );
  };
  const rowsId = useId();
  const [loading, setLoading] = useState(true);
  const [listing, setListing] = useState<Listing | null>(null),
    [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [attempt, setAttempt] = useState(0);
  const [deleting, setDeleting] = useState<{
    ids: string[];
    impact: Impact;
  } | null>(null);
  const dialog = useRef<HTMLElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const importController = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    if (actions.kind === "preview") importController.current?.abort();
  }, [actions.kind]);
  const [createdTimelineId, setCreatedTimelineId] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (hidden) return;
    const dismiss = (event: PointerEvent) => {
      if (busy || !(event.target instanceof Node)) return;
      if (
        !dialog.current?.contains(event.target) &&
        !anchor?.contains(event.target)
      )
        onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      event.stopPropagation();
      if (
        event.target instanceof Node &&
        dialog.current?.contains(event.target)
      )
        anchor?.querySelector("button")?.focus();
      onClose();
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [anchor, busy, hidden, onClose]);
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(text), 200);
    return () => window.clearTimeout(timer);
  }, [text]);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setListing(null);
    setLoading(true);
    setError("");
    void (async () => {
      const rows: Row[] = [];
      const nodes: NodeRow[] = [];
      let total = Infinity,
        cursor = 0;
      while (rows.length + nodes.length < total) {
        const page = await request<Listing>(
          `${creationPath(projectId)}/asset-list?text=${encodeURIComponent(query)}&visibility=${visibility}&category=${category}&offset=${rows.length + nodes.length}&limit=200`,
          { signal: controller.signal },
        );
        if ((rows.length || nodes.length) && page.eventCursor !== cursor)
          throw new Error(t("canvasNodes.assets.changed"));
        rows.push(...page.items);
        nodes.push(...(page.nodes ?? []));
        total = page.total;
        cursor = page.eventCursor;
        if (active)
          setListing({
            items: [...rows],
            nodes: [...nodes],
            total,
            eventCursor: cursor,
            counts: page.counts,
          });
        if (!page.items.length && !page.nodes?.length) break;
      }
      if (active) {
        setLoading(false);
        setSelected((ids) =>
          ids.filter((id) => rows.some((row) => row.asset.id === id)),
        );
      }
    })().catch((reason) => {
      if (active) {
        setListing(null);
        setLoading(false);
        setError(errorMessage(reason));
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [projectId, query, visibility, category, attempt]);
  useEffect(clearPreview, [category, query, visibility, clearPreview]);
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setActionError("");
    try {
      await action();
    } catch (reason) {
      if (alive.current) setActionError(errorMessage(reason));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const inspect = async (ids: string[]) => {
    let impact = await request<Impact>(
      `${creationPath(projectId)}/asset-delete-preview`,
      json("POST", { assetIds: ids }),
    );
    const onlyUndo = impact.usage.every((entry) =>
      entry.reasons.every((reason) => reason.type === "undo_history"),
    );
    if (!impact.canDelete && onlyUndo)
      impact = await request<Impact>(
        `${creationPath(projectId)}/asset-delete-preview`,
        json("POST", { assetIds: ids, clearHistory: true }),
      );
    if (alive.current) setDeleting({ ids, impact });
  };
  const destroy = async () => {
    if (!deleting) return;
    const client = creationClient(projectId);
    await client.refresh();
    const versions = [
      ...client.snapshot.assets
        .filter((a) => deleting.ids.includes(a.id))
        .map((a) => objectVersion("asset", a)),
      ...client.snapshot.canvasItems
        .filter((i) => deleting.impact.hiddenItemIds.includes(i.id))
        .map((i) => objectVersion("canvas_item", i)),
    ];
    await client.command(
      "asset.delete",
      {
        assetIds: deleting.ids,
        clearHistory: deleting.impact.clearsAllUndoRedo,
      },
      versions,
      deleting.impact.fingerprint,
    );
    if (alive.current) {
      setDeleting(null);
      setSelected([]);
      setAttempt((n) => n + 1);
    }
  };
  const importFiles = async (files: File[]) => {
    const client = creationClient(projectId);
    setImporting(true);
    const controller = new AbortController();
    importController.current = controller;
    try {
      const { failures } = await readImportBatch(files, async (file, signal) => {
        await client.importBlob(file, file.name, classifyImportFile(file).kind, undefined, undefined, signal);
      }, controller.signal);
      if (failures.length) throw new Error(failures.map(({ name, message }) =>
        t("canvas.workspace.toast.assetIssue", { name, reason: message }),
      ).join(t("canvas.workspace.list.separator")));
    } catch (cause) {
      if (!controller.signal.aborted) throw cause;
    } finally {
      importController.current = null;
      if (alive.current) {
        setAttempt((value) => value + 1);
        setImporting(false);
      }
    }
  };
  const open = async (row: Row) => {
    if (actions.kind === "preview") {
      onClose();
      actions.onPreview(row.asset);
      return;
    }
    if (actions.kind === "chat") {
      actions.onReference(row.asset);
      onClose();
      return;
    }
    const client = creationClient(projectId);
    await client.refresh();
    const item = findAssetItem(client.snapshot, row.asset.id);
    if (row.owners.length && !item) {
      setAttempt((n) => n + 1);
      throw new Error(t("canvasNodes.assets.versionChanged"));
    }
    const itemId = item ? await showExistingItem(client, item)
      : await showNewAssetItem(client, row.asset, actions.position, row.specId);
    actions.onLocate(itemId);
    onClose();
  };
  const openNode = async (row: NodeRow) => {
    if (actions.kind === "preview") {
      if (row.asset) actions.onPreview(row.asset);
      onClose();
      return;
    }
    if (actions.kind === "chat") {
      if (row.kind === "timeline") await actions.onOpenTimeline(row.itemId);
      else if (row.asset) actions.onReference(row.asset);
      onClose();
      return;
    }
    const client = creationClient(projectId);
    await client.refresh();
    const item = client.snapshot.canvasItems.find(
      (item) => item.id === row.itemId,
    );
    if (!item) {
      setAttempt((value) => value + 1);
      throw new Error(t("canvasNodes.assets.nodeChanged"));
    }
    await showExistingItem(client, item);
    actions.onLocate(item.id);
    onClose();
  };
  const labels: Record<string, MessageKey> = {
    visible_canvas_item: "canvasNodes.assets.role.visibleCanvasItem",
    reference: "canvasNodes.assets.role.reference",
    job: "canvasNodes.assets.role.job",
    result: "canvasNodes.assets.role.result",
    editor_document: "canvasNodes.assets.role.editorDocument",
    asset_provenance: "canvasNodes.assets.role.assetProvenance",
    undo_history: "canvasNodes.assets.role.undoHistory",
    unresolved_reference: "canvasNodes.assets.role.unresolvedReference",
  };
  return (
    <>
      <aside
        ref={dialog}
        hidden={hidden}
        aria-busy={busy || loading}
        className="cw-creation-assets nodrag nopan nowheel"
        data-actions={actions.kind}
        role="dialog"
        aria-label={t("canvasNodes.assets.title")}
        onKeyDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
        onMouseLeave={clearPreview}
      >
        <header>
          <h2>
            {deleting
              ? t("canvasNodes.assets.deleteTitle")
              : t("canvasNodes.assets.title")}
          </h2>
          <button
            aria-label={t("canvasNodes.assets.close")}
            disabled={busy}
            onClick={onClose}
          >
            <CanvasIcon name="close" />
          </button>
        </header>
        {deleting ? (
          <>
            <p>
              {t("canvasNodes.assets.deleteConfirm", {
                count: deleting.ids.length,
              })}
            </p>
            {deleting.impact.hiddenItemIds.length > 0 && (
              <p>{t("canvasNodes.assets.deleteHiddenKeep")}</p>
            )}
            {!deleting.impact.canDelete ? (
              <>
                <p>{t("canvasNodes.assets.deleteDependencies")}</p>
                <ul>
                  {deleting.impact.usage.flatMap((entry) =>
                    entry.reasons.map((reason) => (
                      <li key={`${entry.assetId}:${reason.type}:${reason.id}`}>
                        {t(labels[reason.type] ?? "canvasNodes.assets.fallback")}{" "}
                        ·{" "}
                        {reason.id.slice(0, 8)}
                      </li>
                    )),
                  )}
                </ul>
              </>
            ) : (
              deleting.impact.clearsAllUndoRedo && (
                <p role="note">
                  {t("canvasNodes.assets.deleteUndoWarning")}
                </p>
              )
            )}
            <footer>
              <button disabled={busy} onClick={() => setDeleting(null)}>
                {t("canvasNodes.assets.back")}
              </button>
              {deleting.impact.canDelete && (
                <button disabled={busy} onClick={() => void perform(destroy)}>
                  {deleting.impact.clearsAllUndoRedo
                    ? t("canvasNodes.assets.deleteAndClear")
                    : t("canvasNodes.assets.confirmDelete")}
                </button>
              )}
            </footer>
          </>
        ) : (
          <>
            {actions.kind === "chat" && (
              <div className="cw-project-asset-actions">
                <button disabled={busy} onClick={() => fileInput.current?.click()}>
                  {t(importing ? "workspaceModes.importingMedia" : "workspaceModes.importMedia")}
                </button>
                <input ref={fileInput} hidden type="file" multiple data-project-import
                  accept="image/*,.heic,.heif,video/*,audio/*,text/*,.md,.txt"
                  aria-label={t("workspaceModes.importMedia")}
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = "";
                    if (files.length) void perform(() => importFiles(files));
                  }}
                />
                <button disabled={busy} data-create-timeline onClick={() => void perform(async () => {
                  const itemId = createdTimelineId ?? await actions.onCreateTimeline();
                  if (!alive.current) return;
                  // Creation has committed. An opening failure must retry this item.
                  setCreatedTimelineId(itemId);
                  await actions.onOpenTimeline(itemId);
                  onClose();
                })}>
                  {t(createdTimelineId ? "workspaceModes.retryOpenTimeline" : "workspaceModes.createTimeline")}
                </button>
              </div>
            )}
            <div className="cw-creation-asset-filters">
              <input
                autoFocus
                aria-label={t("canvasNodes.assets.search")}
                placeholder={t("canvasNodes.assets.searchPlaceholder")}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              <select
                aria-label={t("canvasNodes.assets.visibility")}
                value={visibility}
                onChange={(event) => setVisibility(event.target.value)}
              >
                <option value="all">{t("canvasNodes.assets.all")}</option>
                <option value="visible">
                  {t("canvasNodes.assets.visible")}
                </option>
                <option value="hidden">
                  {t("canvasNodes.assets.hidden")}
                </option>
              </select>
            </div>
            <div
              className="cw-creation-asset-categories"
              role="tablist"
              aria-label={t("canvasNodes.assets.type")}
              onKeyDown={(event) => {
                const index = CATEGORIES.findIndex(
                  (entry) => entry.id === category,
                );
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % CATEGORIES.length
                    : event.key === "ArrowLeft"
                      ? (index + CATEGORIES.length - 1) % CATEGORIES.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? CATEGORIES.length - 1
                          : -1;
                if (next < 0) return;
                event.preventDefault();
                setCategory(CATEGORIES[next].id);
                event.currentTarget
                  .querySelectorAll<HTMLButtonElement>("button")
                  [next]?.focus();
              }}
            >
              {CATEGORIES.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={category === entry.id}
                  aria-label={`${t(entry.label)} ${listing?.counts?.[entry.id] ?? 0}`}
                  aria-controls={rowsId}
                  tabIndex={category === entry.id ? 0 : -1}
                  onClick={() => setCategory(entry.id)}
                >
                  {t(entry.label)}
                  <span>{listing?.counts?.[entry.id] ?? 0}</span>
                </button>
              ))}
            </div>
            {loading && !error && (
              <p role="status">
                {t("canvasNodes.assets.loading")}
                {listing &&
                  t("canvasNodes.assets.progress", {
                    shown: listing.items.length + listing.nodes.length,
                    total: listing.total,
                  })}
              </p>
            )}
            <div
              id={rowsId}
              className="cw-creation-asset-rows"
              aria-label={t("canvasNodes.assets.items")}
              onScroll={clearPreview}
            >
              {listing?.nodes.map((row) => (
                <div key={row.itemId} className="cw-creation-asset-row">
                  <span
                    className="cw-creation-asset-checkbox-space"
                    aria-hidden="true"
                  />
                  <button
                    className="cw-creation-asset-open"
                    aria-describedby={
                      preview?.id === row.itemId
                        ? `asset-preview-${row.itemId}`
                        : undefined
                    }
                    data-open-timeline={actions.kind === "chat" && row.kind === "timeline" ? row.itemId : undefined}
                    disabled={busy || (actions.kind === "preview" && !row.asset) || (actions.kind === "chat" && row.kind !== "timeline" && (!row.asset || actions.referenceDisabled))}
                    onClick={() => void perform(() => openNode(row))}
                    onMouseEnter={(event) =>
                      showPreview(event.currentTarget, {
                        id: row.itemId,
                        name: row.title,
                        kind: row.kind,
                        label: previewLabel(row.previewLabel),
                        asset: row.asset,
                      })
                    }
                    onFocus={(event) =>
                      showPreview(event.currentTarget, {
                        id: row.itemId,
                        name: row.title,
                        kind: row.kind,
                        label: previewLabel(row.previewLabel),
                        asset: row.asset,
                      })
                    }
                    onMouseLeave={clearPreview}
                    onBlur={clearPreview}
                  >
                    {row.asset ? (
                      <AssetThumbnail projectId={projectId} asset={row.asset} />
                    ) : (
                      <span
                        className="cw-creation-asset-thumbnail"
                        aria-hidden="true"
                      >
                        <CanvasIcon name={row.kind} size={24} />
                      </span>
                    )}
                    <span className={row.visible ? undefined : "is-removed"}>
                      {row.title}
                    </span>
                    <small>
                      {actions.kind === "preview"
                        ? row.asset && t("assistant.result.preview")
                        : actions.kind === "chat"
                        ? t(row.kind === "timeline" ? "canvas.workspace.menu.openEditor" : "workspaceModes.referenceAsset")
                        : row.visible
                        ? t("canvasNodes.assets.locate")
                        : t("canvasNodes.assets.restore")}
                    </small>
                  </button>
                </div>
              ))}
              {listing?.items.map((row) => {
                const owner =
                  row.owners.find((owner) => owner.visible) ?? row.owners[0];
                const name = owner?.title.trim() || row.asset.name;
                return (
                  <div key={row.asset.id} className="cw-creation-asset-row">
                    {actions.kind === "canvas" && <input
                      type="checkbox"
                      aria-label={t("canvasNodes.assets.select", { name })}
                      checked={selected.includes(row.asset.id)}
                      disabled={
                        busy ||
                        (!selected.includes(row.asset.id) &&
                          selected.length >= 100)
                      }
                      onChange={() =>
                        setSelected((ids) =>
                          ids.includes(row.asset.id)
                            ? ids.filter((id) => id !== row.asset.id)
                            : [...ids, row.asset.id],
                        )
                      }
                    />}
                    <button
                      className="cw-creation-asset-open"
                      aria-describedby={
                        preview?.id === row.asset.id
                          ? `asset-preview-${row.asset.id}`
                          : undefined
                      }
                      title={row.asset.name}
                      data-reference-asset={actions.kind === "chat" ? row.asset.id : undefined}
                      disabled={busy || (actions.kind === "chat" && (actions.referenceDisabled || row.asset.kind === "file"))}
                      onClick={() => void perform(() => open(row))}
                      onMouseEnter={(event) =>
                        showPreview(event.currentTarget, {
                          id: row.asset.id,
                          name,
                          label:
                            CATEGORIES.find(
                              (entry) => entry.id === row.asset.kind,
                          )?.label
                            ? t(
                                CATEGORIES.find(
                                  (entry) => entry.id === row.asset.kind,
                                )!.label,
                              )
                            : t("canvasNodes.assets.fallback"),
                          kind: row.asset.kind,
                          asset: row.asset,
                        })
                      }
                      onFocus={(event) =>
                        showPreview(event.currentTarget, {
                          id: row.asset.id,
                          name,
                          label:
                            CATEGORIES.find(
                              (entry) => entry.id === row.asset.kind,
                          )?.label
                            ? t(
                                CATEGORIES.find(
                                  (entry) => entry.id === row.asset.kind,
                                )!.label,
                              )
                            : t("canvasNodes.assets.fallback"),
                          kind: row.asset.kind,
                          asset: row.asset,
                        })
                      }
                      onMouseLeave={clearPreview}
                      onBlur={clearPreview}
                    >
                      <AssetThumbnail projectId={projectId} asset={row.asset} />
                      <span
                        className={owner && !owner.visible ? "is-removed" : undefined}
                      >
                        {name}
                      </span>
                      <small>
                        {actions.kind === "preview"
                          ? t("assistant.result.preview")
                          : actions.kind === "chat"
                          ? t("workspaceModes.referenceAsset")
                          : owner?.visible
                          ? t("canvasNodes.assets.locate")
                          : owner
                            ? t("canvasNodes.assets.restore")
                            : t("canvasNodes.assets.show")}
                      </small>
                    </button>
                  </div>
                );
              })}
              {listing && !listing.items.length && !listing.nodes.length && (
                <p>
                  {text || visibility !== "all" || category !== "all"
                    ? t("canvasNodes.assets.noneMatch")
                    : t("canvasNodes.assets.empty")}
                </p>
              )}
            </div>
            {actions.kind === "canvas" && (!!listing?.items.length || !!selected.length) && (
              <footer>
                <button
                  disabled={busy || !listing?.items.length}
                  onClick={() =>
                    setSelected(
                      listing!.items.slice(0, 100).map((row) => row.asset.id),
                    )
                  }
                >
                  {t("canvasNodes.assets.selectAll")}
                </button>
                {!!selected.length && (
                  <button disabled={busy} onClick={() => setSelected([])}>
                    {t("canvasNodes.assets.clearSelection")}
                  </button>
                )}
                {!!selected.length && (
                  <button
                    disabled={busy}
                    onClick={() => void perform(() => inspect(selected))}
                  >
                    {t("canvasNodes.assets.deleteSelected", {
                      count: selected.length,
                    })}
                  </button>
                )}
              </footer>
            )}
          </>
        )}
        {(error || actionError) && (
          <p role="alert">
            {actionError || error}
            <button
              disabled={busy}
              onClick={() => {
                setActionError("");
                if (deleting) void perform(() => inspect(deleting.ids));
                else setAttempt((n) => n + 1);
              }}
            >
              {t("canvasNodes.assets.reload")}
            </button>
          </p>
        )}
      </aside>
      {!hidden && preview && (
        <HoverPreview
          key={preview.id}
          projectId={projectId}
          preview={preview}
        />
      )}
    </>
  );
}
