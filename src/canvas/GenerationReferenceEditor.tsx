import { generationEditIdentity } from "./generationSettings.ts";
import { creationClient } from "../backend/creationClient.ts";
import { loadReferenceCatalog } from "../backend/referenceCatalog.ts";
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import { useReferenceUploads } from "./useReferenceUploads.tsx";
import { fingerprintMatches, assetKind } from "./chatReferenceContent.ts";
import { assertUpload, assertReferenceSize } from "./uploadPolicy.ts";
import { classifyImportFile, readEditorResource } from "./editorMedia.ts";
import { resourceNodeData } from "./projectAssets.ts";
import type { Ref } from "react";
import { createNode, type CanvasNode, type CanvasNodeData } from "./model.ts";
import {
  ChatReferenceEditor,
  type ChatReferenceEditorHandle,
} from "./ChatReferenceEditor";
import {
  generationContent,
  generationContentPatch,
  nodeReferenceAsset,
} from "./generationReferenceContent.ts";
import { type MentionOption } from "./referenceMentions.ts";
import { referenceCandidates, assetOptionId } from "./referenceCandidates.ts";
import { canSourceReference } from "./connectionPolicy.ts";
import type {
  ReferenceAsset,
  ReferenceContent,
} from "./chatReferenceContent.ts";
import { normalizeContent, referencePart } from "./chatReferenceContent.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";

export interface GenerationReferenceControls {
  projectId: string;
  /** All logical sources remain available for resolving existing references. */
  nodes: CanvasNode[];
  /** Only current canvas items are offered by the @ picker. */
  visibleNodes: CanvasNode[];
  assets: ReferenceAsset[];
  pinned?: ReferenceAsset[];
  onChange: (content: ReferenceContent, sources: CanvasNode[]) => void;
  /** Removes the connection itself; the strip owns relationships, not the text. */
  removeReference?: (source: CanvasNode) => void;
  prepareAsset: (
    asset: ReferenceAsset,
    signal: AbortSignal,
  ) => Promise<{ src?: string; text?: string }>;
  issue: (node: CanvasNode) => string | null;
  referenceId: (nodeId: string) => string | undefined;
}
export interface GenerationReferenceHandle {
  openPicker: () => void;
  openUpload: () => void;
  insert: (node: CanvasNode) => void;
  remove: (node: CanvasNode) => void;
}
export function GenerationReferenceEditor({
  node,
  incoming,
  controls,
  issue,
  onUpdate,
  running,
  pickerRef,
  placeholder,
  label,
  onRun,
  validate,
}: {
  node: CanvasNode;
  incoming: CanvasNode[];
  controls?: GenerationReferenceControls;
  issue: (source: CanvasNode) => string | null;
  onUpdate: (patch: Partial<CanvasNodeData>) => void;
  running: boolean;
  pickerRef: Ref<GenerationReferenceHandle>;
  placeholder: string;
  label: string;
  onRun: () => void;
  validate?: (sources: CanvasNode[]) => string | null;
}) {
  const { t } = useI18n();
  const uploads = useReferenceUploads(controls?.projectId ?? "");
  const editor = useRef<ChatReferenceEditorHandle>(null);
  const file = useRef<HTMLInputElement>(null);
  const upload = useRef<AbortController | null>(null);
  const latestNode = useRef(node);
  latestNode.current = node;
  const latestContent = useRef<ReferenceContent>([]);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(
    () => () => upload.current?.abort(),
    [controls?.projectId, node.id],
  );
  const prepared = useRef(new Map<string, CanvasNode>());
  const preparedPins = useRef(new Map<string, ReferenceAsset>());
  const librarySources = useRef(new Map<string, CanvasNode>());
  const nodes = [
    ...new Map(
      [
        ...(controls?.nodes ?? incoming),
        ...incoming,
        ...prepared.current.values(),
      ].map((source) => [source.id, source]),
    ).values(),
  ];
  let value = generationContent(node, incoming, controls?.referenceId);
  const located = new Set(
    value.flatMap((part) =>
      part.type === "reference" && part.referenceId ? [part.referenceId] : [],
    ),
  );
  const pins =
    node.data.promptContent === undefined
      ? (controls?.pinned ?? []).filter(
          (asset) => !asset.referenceId || !located.has(asset.referenceId),
        )
      : [];
  if (pins.length)
    value = normalizeContent([
      ...pins.flatMap((asset, index) => [
        ...(index ? [{ type: "text" as const, text: " " }] : []),
        referencePart(asset),
      ]),
      ...(value.length
        ? [{ type: "text" as const, text: "\n" }, ...value]
        : []),
    ]);
  latestContent.current = value;
  const assets: ReferenceAsset[] = nodes
    .filter(canSourceReference)
    .map((source) => {
      const part = value.find(
        (part) => part.type === "reference" && part.nodeId === source.id,
      );
      return nodeReferenceAsset(
        source,
        part?.type === "reference" ? part.referenceId : undefined,
      );
    });
  assets.push(...(controls?.pinned ?? []), ...preparedPins.current.values());
  for (const part of value)
    if (
      part.type === "reference" &&
      !assets.some((asset) => asset.id === part.assetId)
    )
      assets.push({
        ...controls?.assets.find((asset) => asset.id === part.assetId),
        id: part.assetId,
        nodeId: part.nodeId ?? undefined,
        referenceId: part.referenceId,
        binding: part.binding,
        name: part.name,
        fingerprint: part.fingerprint ?? "",
        size:
          controls?.assets.find((asset) => asset.id === part.assetId)?.size ??
          0,
        ...(controls?.assets.some((asset) => asset.id === part.assetId)
          ? {}
          : { available: false, fileAvailable: false }),
        type:
          controls?.assets.find((asset) => asset.id === part.assetId)?.type ??
          "text/reference",
      });
  const projectId = controls?.projectId;
  const pinnedImageIds = JSON.stringify(
    [
      ...new Set(
        assets
          .filter(
            (asset) =>
              asset.binding === "asset" && assetKind(asset) === "image",
          )
          .map((asset) => asset.id),
      ),
    ].sort(),
  );
  const [fixedPreviews, setFixedPreviews] = useState<{
    projectId: string;
    urls: Record<string, string>;
  }>();
  useEffect(() => {
    let active = true;
    if (!projectId) return;
    const client = creationClient(projectId);
    void Promise.all(
      (JSON.parse(pinnedImageIds) as string[]).map(async (id) => {
        try {
          return [id, await client.mediaUrl(id)] as const;
        } catch {
          return null;
        }
      }),
    ).then((values) => {
      if (active)
        setFixedPreviews({
          projectId,
          urls: Object.fromEntries(values.filter((value) => value !== null)),
        });
    });
    return () => {
      active = false;
    };
  }, [projectId, pinnedImageIds]);
  const library = (controls?.assets ?? []).map((asset) => ({
    ...asset,
    nodeId:
      asset.nodeId ?? librarySources.current.get(assetOptionId(asset))?.id,
  }));
  const pinnedSources = (content: ReferenceContent) => [
    ...new Map(
      content
        .flatMap((part) => {
          if (part.type !== "reference" || part.binding !== "asset") return [];
          const asset = assets.find((asset) => asset.id === part.assetId);
          if (!asset) return [];
          const source = createNode(
            assetKind(asset) as CanvasNode["type"],
            undefined,
            {
              title: asset.name,
              src: "inventory",
              text: "inventory",
              byteSize: asset.size,
              media: {
                width: asset.width ?? undefined,
                height: asset.height ?? undefined,
                durationSeconds: asset.durationSeconds ?? undefined,
              },
              mediaRole: "asset",
            },
          );
          source.id = `pinned:${asset.id}`;
          return [source];
        })
        .map((source) => [source.id, source]),
    ).values(),
  ];
  const check = (source: CanvasNode) => {
    const reason = controls?.issue(source) ?? issue(source);
    if (reason) return reason;
    try {
      assertReferenceSize(source.type, nodeReferenceAsset(source).size);
    } catch (error) {
      return (error as Error).message;
    }
    const selected = new Set(
      value.flatMap((part) =>
        part.type === "reference" && part.nodeId ? [part.nodeId] : [],
      ),
    );
    return (
      validate?.([
        ...nodes.filter(
          (node) => selected.has(node.id) && node.id !== source.id,
        ),
        ...pinnedSources(value).filter((pin) => pin.id !== source.id),
        source,
      ]) ?? null
    );
  };
  const options: MentionOption[] = referenceCandidates(
    (controls?.visibleNodes ?? incoming).filter(
      (source) => source.id !== node.id,
    ),
    [],
    check,
  );
  const adoptAsset = async (
    asset: ReferenceAsset,
    signal: AbortSignal,
  ): Promise<ReferenceAsset[]> => {
    if (!controls) return [];
    const known = nodes.find(
      (source) =>
        source.id === asset.logicalNodeId || source.id === asset.nodeId,
    );
    if (known) {
      const reason = check(known);
      if (reason) throw new Error(reason);
      return [
        nodeReferenceAsset(
          known,
          controls.referenceId(known.id) ?? crypto.randomUUID(),
        ),
      ];
    }
    const retained = librarySources.current.get(assetOptionId(asset));
    if (retained)
      return [
        nodeReferenceAsset(
          retained,
          assets.find((asset) => asset.nodeId === retained.id)?.referenceId ??
            crypto.randomUUID(),
        ),
      ];
    const data = await controls.prepareAsset(asset, signal);
    signal.throwIfAborted();
    const source = createNode(asset.kind as CanvasNode["type"], undefined, {
      ...data,
      title: asset.name,
      byteSize: asset.size,
      backendAssetId: asset.id,
      media: {
        width: asset.width ?? undefined,
        height: asset.height ?? undefined,
        durationSeconds: asset.durationSeconds ?? undefined,
      },
      mediaRole: "asset",
      assetState: "ready",
    });
    source.id = asset.nodeId ?? crypto.randomUUID();
    const reason = check(source);
    if (reason) throw new Error(reason);
    prepared.current.set(source.id, source);
    librarySources.current.set(assetOptionId(asset), source);
    return [nodeReferenceAsset(source, crypto.randomUUID())];
  };
  const choose = async (
    option: MentionOption,
    signal: AbortSignal,
  ): Promise<ReferenceAsset[] | null> => {
    if (option.id.startsWith("node:")) {
      const source = nodes.find((source) => `node:${source.id}` === option.id);
      if (!source) throw new Error(t("generation.error.sourceMissing"));
      const reason = check(source);
      if (reason) throw new Error(reason);
      return [
        nodeReferenceAsset(
          source,
          assets.find((asset) => asset.nodeId === source.id)?.referenceId ??
            crypto.randomUUID(),
        ),
      ];
    }
    const asset = library.find((asset) => assetOptionId(asset) === option.id);
    if (!asset || !controls) return null;
    return adoptAsset(asset, signal);
  };
  useImperativeHandle(pickerRef, () => ({
    openPicker: () => editor.current?.openPicker(),
    openUpload: () => {
      if (!running && !uploading) file.current?.click();
    },
    remove: (source) =>
      controls?.removeReference
        ? controls.removeReference(source)
        : editor.current?.removeSource(source.id),
    insert: (source) => {
      const reason = check(source);
      if (reason) {
        setNotice(reason);
        return;
      }
      editor.current?.insert([
        nodeReferenceAsset(
          source,
          assets.find((asset) => asset.nodeId === source.id)?.referenceId ??
            crypto.randomUUID(),
        ),
      ]);
    },
  }));
  const uploadFiles = async (files: File[]) => {
    if (running || upload.current || !files.length) return;
    let registered = false;
    const startingData = generationEditIdentity(node, value);
    const abort = new AbortController();
    upload.current = abort;
    setUploading(true);
    setNotice("");
    try {
      for (const file of files) {
        const { kind } = classifyImportFile(file);
        assertUpload(kind, "reference");
        const candidate = createNode(kind as CanvasNode["type"], undefined, {
          src: "inventory",
          text: "inventory",
          byteSize: file.size,
          mediaRole: "asset",
        });
        const reason = check(candidate);
        if (reason) throw new Error(reason);
      }
      const uploaded = controls
        ? await uploads.prepare(files, abort.signal)
        : null;
      registered = !!uploaded?.length;
      const sources = uploaded
        ? await Promise.all(
            uploaded.map(async (asset) => {
              const existing = nodes.find(
                (source) => source.id === asset.nodeId,
              );
              if (existing) return existing;
              const source = createNode(
                asset.kind as CanvasNode["type"],
                undefined,
                {
                  ...(await controls!.prepareAsset(asset, abort.signal)),
                  title: asset.name,
                  byteSize: asset.size,
                  backendAssetId: asset.id,
                  media: {
                    width: asset.width ?? undefined,
                    height: asset.height ?? undefined,
                    durationSeconds: asset.durationSeconds ?? undefined,
                  },
                  mediaRole: "asset",
                  assetState: "ready",
                },
              );
              source.id = asset.nodeId ?? crypto.randomUUID();
              librarySources.current.set(assetOptionId(asset), source);
              return source;
            }),
          )
        : await Promise.all(
            files.map(async (file) => {
              const resource = await readEditorResource(file, abort.signal);
              return createNode(
                resource.kind as CanvasNode["type"],
                undefined,
                resourceNodeData(resource),
              );
            }),
          );
      for (const source of sources) {
        const reason = check(source);
        if (reason) throw new Error(reason);
      }
      const selected = new Set(
        value.flatMap((part) =>
          part.type === "reference" && part.nodeId ? [part.nodeId] : [],
        ),
      );
      const reason = validate?.([
        ...nodes.filter((source) => selected.has(source.id)),
        ...pinnedSources(value),
        ...sources,
      ]);
      if (reason) throw new Error(reason);
      abort.signal.throwIfAborted();
      if (
        generationEditIdentity(latestNode.current, latestContent.current) !==
        startingData
      )
        throw new Error(
          t("generation.error.batchNotInserted"),
        );
      for (const source of sources) prepared.current.set(source.id, source);
      setUploading(false);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      abort.signal.throwIfAborted();
      const inserted = editor.current?.insert(
        sources.map((source) =>
          nodeReferenceAsset(source, crypto.randomUUID()),
        ),
      );
      if (!inserted) throw new Error(t("generation.error.batchRejected"));
    } catch (error) {
      if (!abort.signal.aborted)
        setNotice(
          (error instanceof Error ? error.message : t("generation.error.uploadFailed")) +
            (registered ? t("generation.error.assetRetained") : ""),
        );
    } finally {
      if (!abort.signal.aborted) setUploading(false);
      if (upload.current === abort) upload.current = null;
    }
  };
  const previews = Object.fromEntries(
    nodes.flatMap((source) =>
      source.type === "image" && source.data.src
        ? [[`node:${source.id}`, source.data.src]]
        : source.type === "subject" &&
            source.data.subject?.main?.kind === "image" &&
            source.data.subject.main.src
          ? [[`node:${source.id}`, source.data.subject.main.src]]
          : [],
    ),
  );
  return (
    <>
      {uploads.dialog}
      <input
        ref={file}
        type="file"
        disabled={running || uploading}
        hidden
        multiple
        accept="image/*,.heic,.heif,video/*,audio/*,.txt,.md"
        aria-label={t("generation.reference.upload")}
        onChange={(event) => {
          void uploadFiles([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
      <ChatReferenceEditor
        visibleReferenceNodeIds={
          controls
            ? new Set(controls.visibleNodes.map((source) => source.id))
            : undefined
        }
        ref={editor}
        scope={controls?.projectId ?? node.id}
        value={value}
        assets={assets}
        previews={{
          ...previews,
          ...(fixedPreviews?.projectId === projectId
            ? fixedPreviews?.urls
            : {}),
        }}
        options={options}
        disabled={running || uploading}
        referencesDisabled={running || uploading}
        // Candidates already come from the live canvas. Catalog reads only
        // enrich fixed/pasted references and must not block choosing a source.
        loading={false}
        loadError=""
        onOpen={() => {}}
        onChoose={choose}
        onChange={(content) => {
          const previous = new Set(
            value.flatMap((part) =>
              part.type === "reference" ? [part.nodeId ?? part.assetId] : [],
            ),
          );
          if (
            content.some(
              (part) =>
                part.type === "reference" &&
                !previous.has(part.nodeId ?? part.assetId),
            )
          ) {
            const selected = new Set(
              content.flatMap((part) =>
                part.type === "reference" && part.nodeId ? [part.nodeId] : [],
              ),
            );
            const sources = [
              ...new Map(
                [...nodes, ...prepared.current.values()].map((source) => [
                  source.id,
                  source,
                ]),
              ).values(),
            ].filter((source) => selected.has(source.id));
            const reason = validate?.([...sources, ...pinnedSources(content)]);
            if (reason) throw new Error(reason);
          }
          if (controls)
            controls.onChange(content, [...prepared.current.values()]);
          else onUpdate(generationContentPatch(content));
        }}
        onSubmit={onRun}
        onPasteFiles={(files) => void uploadFiles(files)}
        rebindOnPaste
        onPasteReference={async (part, signal) => {
          if (part.binding === "asset" && controls) {
            const inventory = [...library, ...preparedPins.current.values()];
            const asset =
              inventory.find((asset) => asset.id === part.assetId) ??
              (await loadReferenceCatalog(controls.projectId, signal)).find(
                (asset) => asset.id === part.assetId,
              );
            if (
              !asset ||
              !part.fingerprint ||
              !fingerprintMatches(asset, part.fingerprint)
            )
              throw new Error(t("generation.error.fixedReferenceMissing"));
            const data = await controls.prepareAsset(asset, signal);
            const source = createNode(
              assetKind(asset) as CanvasNode["type"],
              undefined,
              {
                ...data,
                title: asset.name,
                byteSize: asset.size,
                media: {
                  width: asset.width ?? undefined,
                  height: asset.height ?? undefined,
                  durationSeconds: asset.durationSeconds ?? undefined,
                },
                mediaRole: "asset",
              },
            );
            source.id = `pinned:${asset.id}`;
            const reason = check(source);
            if (reason) throw new Error(reason);
            const existing = value.find(
              (value) =>
                value.type === "reference" &&
                value.binding === "asset" &&
                value.assetId === part.assetId,
            );
            const pinned: ReferenceAsset = {
              ...asset,
              binding: "asset",
              referenceId:
                existing?.type === "reference"
                  ? existing.referenceId
                  : crypto.randomUUID(),
            };
            preparedPins.current.set(asset.id, pinned);
            assets.push(pinned);
            return [pinned];
          }
          // Pasting an explicit source is independent of canvas visibility.
          const option = referenceCandidates(nodes, library, check).find(
            (option) =>
              option.id === `node:${part.nodeId}` ||
              option.id ===
                assetOptionId({
                  id: part.assetId,
                  nodeId: part.nodeId ?? undefined,
                  sourceRole: part.sourceRole,
                }),
          );
          if (!option && controls && !part.assetId.startsWith("node:")) {
            const inventory = await loadReferenceCatalog(
              controls.projectId,
              signal,
            );
            const asset = inventory.find(
              (asset) =>
                asset.available &&
                (part.nodeId
                  ? asset.nodeId === part.nodeId &&
                    asset.sourceRole === part.sourceRole
                  : asset.id === part.assetId),
            );
            if (asset) return adoptAsset(asset, signal);
          }
          if (!option || option.disabledReason)
            throw new Error(
              option?.disabledReason || t("generation.error.referenceUnavailable"),
            );
          const source = nodes.find((source) => source.id === part.nodeId);
          if (
            source &&
            part.fingerprint?.startsWith("source:") &&
            part.fingerprint !== nodeReferenceAsset(source).fingerprint
          )
            throw new Error(t("generation.error.contentChanged"));
          return (await choose(option, signal)) ?? [];
        }}
        label={label}
        placeholder={placeholder}
        className="cw-prompt-input"
        autoGrow
        submitOnEnter={false}
        metadataOnlyKinds={node.type === "text" ? ["video", "audio"] : []}
        referenceRules={{
          allowedKinds: ["text", "image", "video", "audio", "subject"],
          maxImages: 64,
          imageBytes: 32 * 1024 * 1024,
        }}
      />
      {notice && (
        <p className="cw-reference-mention-notice" role="alert">
          {notice}
        </p>
      )}
    </>
  );
}
