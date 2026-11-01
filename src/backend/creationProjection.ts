/** React Flow is a projection. These adapters translate typed editor/media
 * values; no browser URL is ever put into the authoritative project. */
import type {
  Asset,
  AssetRef,
  CanvasItem,
  EditorDocument,
  EditorDocumentInput,
  GenerationSpec,
  GenerationSpecInput,
  ObjectVersion,
  ProjectSnapshot,
  ReferenceInput,
  TimelineResource,
} from "../contracts/generated.ts";
import {
  createDocument,
  createNode,
  DEFAULT_SETTINGS,
  type CanvasDocument,
  type CanvasNode,
  type CanvasResource,
  type GenerationSettings,
} from "../canvas/model.ts";
import {
  createLocalStage,
  parseLocalStageValue,
} from "../canvas/stageDocument.ts";
import { generationContentPatch } from "../canvas/generationReferenceContent.ts";
import { assemblyResource } from "../canvas/editorAssembly.ts";
import {
  assetReference,
  CreationClient,
  currentAsset,
  itemSpec,
  objectVersion,
  visibleItems,
  type CreationOperation,
} from "./creationClient.ts";

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const extension: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};

export class CreationProjection {
  baseline!: CanvasDocument;
  basis!: ProjectSnapshot;
  private imported = new Map<string, Promise<AssetRef>>();
  readonly client: CreationClient;
  constructor(client: CreationClient) {
    this.client = client;
  }

  async resource(ref: AssetRef, title?: string): Promise<CanvasResource> {
    const asset = this.client.snapshot.assets.find(
      (a) => a.id === ref.assetId,
    )!;
    return {
      id: asset.id,
      assetId: asset.id,
      byteSize: asset.metadata.size,
      kind: asset.kind as CanvasResource["kind"],
      title: title ?? asset.name,
      src: await this.client.mediaUrl(asset.id).catch(() => undefined),
      mimeType: asset.metadata.mimeType,
      width: asset.metadata.width ?? undefined,
      height: asset.metadata.height ?? undefined,
      durationSeconds: asset.metadata.durationSeconds ?? undefined,
    };
  }
  async importResource(resource: {
    id?: string;
    src?: string;
    title: string;
    kind: Asset["kind"];
    text?: string;
    identity?: string;
    previous?: AssetRef;
  }) {
    const existing = resource.src && this.client.assetForSource(resource.src);
    if (existing) return assetReference(existing);
    const retained =
      resource.id &&
      this.client.snapshot.assets.find(
        (asset) => asset.id === resource.id && asset.kind === resource.kind,
      );
    if (retained && !resource.src) return assetReference(retained);
    const key = `${resource.identity ?? ""}:${resource.previous?.assetId ?? ""}:${resource.kind}:${resource.src ?? resource.text ?? ""}`;
    let pending = this.imported.get(key);
    if (!pending) {
      pending = (async () => {
        if (resource.kind === "text")
          return this.client.writeText(
            resource.title,
            resource.text ?? "",
            resource.previous,
          );
        if (!resource.src) throw new Error("素材没有可读取的内容。");
        const response = await fetch(resource.src);
        if (!response.ok) throw new Error("素材读取失败。");
        const blob = await response.blob();
        const suffix = extension[blob.type] ?? blob.type.split("/")[1] ?? "bin";
        const name = /\.[\w]+$/.test(resource.title)
          ? resource.title
          : `${resource.title}.${suffix}`;
        return this.client.importBlob(blob, name, resource.kind);
      })().catch((error) => {
        this.imported.delete(key);
        throw error;
      });
      this.imported.set(key, pending);
    }
    return pending;
  }

  async editorData(doc: EditorDocument): Promise<Partial<CanvasNode["data"]>> {
    switch (doc.kind) {
      case "subject":
        return {
          subject: {
            description: doc.data.description,
            category: doc.data.category,
            ...(doc.data.librarySource
              ? { librarySource: { ...doc.data.librarySource } }
              : {}),
            main: doc.data.main
              ? await this.resource(doc.data.main)
              : undefined,
            auxiliaries: await Promise.all(
              doc.data.auxiliaries.map((r) => this.resource(r)),
            ),
            voice: doc.data.voice
              ? await this.resource(doc.data.voice)
              : undefined,
          },
        };
      case "timeline":
        return {
          timeline: {
            fps: doc.data.fps,
            width: doc.data.width,
            height: doc.data.height,
            importedAssets: await Promise.all(
              doc.data.importedAssets.map((r) =>
                this.resource(r.asset, r.title),
              ),
            ),
            tracks: await Promise.all(
              doc.data.tracks.map(async (track) => ({
                ...track,
                clips: await Promise.all(
                  track.clips.map(async (clip) => ({
                    ...clip,
                    start: clip.start ?? undefined,
                    resource: await this.resource(
                      clip.resource.asset,
                      clip.resource.title,
                    ),
                  })),
                ),
              })),
            ),
          },
        };
      case "stack":
        return { stack: { ...doc.data, nodeIds: [...doc.data.nodeIds] } };
      case "tool":
        return {
          tool: {
            ...doc.data,
            fields: doc.data.fields.map((field) => ({
              ...field,
              values: [...field.values],
            })),
            provenance: doc.data.provenance ?? undefined,
            palette: doc.data.palette
              ? {
                  name: doc.data.palette.name ?? undefined,
                  sourceImageUri: doc.data.palette.sourceImage
                    ? await this.client.mediaUrl(
                        doc.data.palette.sourceImage.assetId,
                      )
                    : undefined,
                }
              : undefined,
          },
        };
      case "director":
        return {
          external: { externalType: "director-stage" },
          localStage: parseLocalStageValue({
            format: "opendirector-local-stage",
            version: 2,
            ...doc.data,
          }),
        };
      case "layers":
        return {
          layers: {
            format: "opendirector-layers",
            version: 1,
            ...doc.data,
            layers: await Promise.all(
              doc.data.layers.map(async (layer) => ({
                ...layer,
                mask: layer.mask.map((stroke) => ({
                  ...stroke,
                  points: stroke.points.map((p) => ({ ...p })),
                })),
                content:
                  layer.content.kind === "image"
                    ? {
                        kind: "image" as const,
                        width: layer.content.width,
                        height: layer.content.height,
                        src: await this.client.mediaUrl(
                          layer.content.asset.assetId,
                        ),
                      }
                    : layer.content,
              })),
            ),
          },
        };
      case "media_edit":
        return {}; // Dedicated tool command bridge is C13.
    }
  }
  async read(snapshot = this.client.snapshot): Promise<CanvasDocument> {
    const document = {
      ...createDocument(snapshot.project.name),
      id: snapshot.project.id,
    };
    const view = await this.client.view();
    document.viewport = view.viewport;
    const visible = visibleItems(snapshot);
    document.nodes = await Promise.all(
      snapshot.canvasItems.map(async (item) => {
        const node = {
          ...createNode(item.kind, item.position),
          id: item.id,
          width: item.width,
          height: item.height,
          locked: item.locked,
          zIndex: item.zIndex,
          parentId: item.parentId ?? undefined,
        };
        node.data.title = item.title;
        const asset = currentAsset(snapshot, item);
        if (asset) {
          try {
            if (asset.kind === "text")
              node.data.text = await this.client.textContent(asset.id);
            else node.data.src = await this.client.mediaUrl(asset.id);
            node.data.assetState = "ready";
          } catch {
            node.data.assetState = "missing";
          }
          node.data.mimeType = asset.metadata.mimeType;
          node.data.byteSize = asset.metadata.size;
          node.data.backendAssetId = asset.id;
          node.data.mediaRole =
            item.binding.role === "material" ? "asset" : "generation";
          node.data.media = {
            width: asset.metadata.width ?? undefined,
            height: asset.metadata.height ?? undefined,
            durationSeconds: asset.metadata.durationSeconds ?? undefined,
          };
        } else if (item.binding.role === "empty" && item.kind === "text")
          node.data.text = item.binding.manualText ?? "";
        const spec = itemSpec(snapshot, item);
        if (spec) {
          node.data.prompt = spec.prompt;
          if (spec.promptContent) {
            node.data.promptContent = [];
            let prompt = "";
            const mentions: NonNullable<CanvasNode["data"]["promptMentions"]> =
              [];
            for (const part of spec.promptContent) {
              if (part.type === "text") {
                prompt += part.text;
                node.data.promptContent.push({ type: "text", text: part.text });
              } else {
                const ref = snapshot.references.find(
                  (r) => r.id === part.referenceId,
                );
                if (!ref) continue;
                const source =
                  ref.binding === "follow_current"
                    ? snapshot.canvasItems.find((i) => i.id === ref.source.id)
                    : undefined;
                const asset =
                  ref.binding === "pinned"
                    ? snapshot.assets.find((a) => a.id === ref.source.assetId)
                    : undefined;
                const label = `@${source?.title ?? asset?.name ?? "参考"}`;
                node.data.promptContent.push({
                  type: "reference",
                  assetId:
                    ref.binding === "follow_current"
                      ? `node:${ref.source.id}`
                      : ref.source.assetId,
                  ...(ref.binding === "follow_current"
                    ? { nodeId: ref.source.id }
                    : { binding: "asset" as const }),
                  referenceId: ref.id,
                  name: source?.title ?? asset?.name ?? "参考",
                  fingerprint: asset?.fingerprint ?? null,
                });
                mentions.push({
                  ...(source ? { sourceNodeId: source.id } : {}),
                  referenceId: ref.id,
                  start: prompt.length,
                  end: prompt.length + label.length,
                });
                prompt += label;
              }
            }
            node.data.prompt = prompt;
            node.data.promptMentions = mentions;
          }
          const located = new Set(
            node.data.promptContent?.flatMap((part) =>
              part.type === "reference" && part.referenceId
                ? [part.referenceId]
                : [],
            ) ?? [],
          );
          const pins = snapshot.references.flatMap((ref) => {
            if (
              !ref.active ||
              ref.targetSpecId !== spec.id ||
              ref.binding !== "pinned" ||
              located.has(ref.id)
            )
              return [];
            const asset = snapshot.assets.find(
              (asset) => asset.id === ref.source.assetId,
            );
            return asset
              ? [
                  {
                    type: "reference" as const,
                    assetId: asset.id,
                    referenceId: ref.id,
                    binding: "asset" as const,
                    name: asset.name,
                    fingerprint: asset.fingerprint,
                  },
                ]
              : [];
          });
          if (pins.length) {
            const body =
              node.data.promptContent ??
              (node.data.prompt
                ? [{ type: "text" as const, text: node.data.prompt }]
                : []);
            Object.assign(
              node.data,
              generationContentPatch([
                ...pins.flatMap((part, index) => [
                  ...(index ? [{ type: "text" as const, text: " " }] : []),
                  part,
                ]),
                ...(body.length
                  ? [{ type: "text" as const, text: "\n" }, ...body]
                  : []),
              ]),
            );
          }
          if (spec.kind === "text")
            node.data.agentSettings = {
              modelConfigId: spec.modelConfigId ?? undefined,
              ...spec.parameters,
            };
          else
            node.data.settings = {
              ...DEFAULT_SETTINGS,
              mode: spec.kind,
              modelConfigId: spec.modelConfigId ?? undefined,
              prompt: node.data.prompt,
              count: view.generationCounts?.[item.id] ?? 1,
              ...(spec.kind === "video"
                ? {
                    videoMode:
                      spec.parameters.videoMode === "first_frame"
                        ? "first-last"
                        : spec.parameters.videoMode,
                    durationSeconds:
                      spec.parameters.durationSeconds ??
                      DEFAULT_SETTINGS.durationSeconds,
                    aspectRatio:
                      spec.parameters.aspectRatio ??
                      DEFAULT_SETTINGS.aspectRatio,
                    resolution: spec.parameters.resolution,
                  }
                : {}),
              ...(spec.kind === "audio"
                ? { voiceName: spec.parameters.voice ?? undefined }
                : {}),
            };
          if (spec.kind === "video" && node.data.settings) {
            const frame = snapshot.references.find(
              (ref) =>
                ref.active &&
                ref.targetSpecId === spec.id &&
                ref.role === "first_frame" &&
                ref.binding === "follow_current",
            );
            if (frame?.binding === "follow_current")
              node.data.settings.firstFrameNodeId = frame.source.id;
          }
          const selected = snapshot.results.find(
            (r) => r.id === spec.currentResultId,
          );
          const job = snapshot.jobs.find((j) => j.id === selected?.jobId);
          if (job && asset) {
            const references: Record<string, string> = {};
            for (const ref of job.inputSnapshot.references) {
              if (ref.sourceVersion?.objectType === "canvas_item")
                references[ref.sourceVersion.id] = ref.asset.fingerprint;
            }
            node.data.generationEvidence = {
              output:
                asset.kind === "text"
                  ? (node.data.text ?? "")
                  : (node.data.src ?? ""),
              references,
            };
          }
        }
        if (item.binding.role === "editor") {
          const binding = item.binding;
          const doc = snapshot.editorDocuments.find(
            (d) => d.id === binding.objectRef.id,
          )!;
          Object.assign(node.data, await this.editorData(doc));
        }
        if ("editors" in item)
          for (const ref of item.editors) {
            const doc = snapshot.editorDocuments.find((d) => d.id === ref.id)!;
            Object.assign(node.data, await this.editorData(doc));
          }
        return node;
      }),
    );
    document.edges = snapshot.references.flatMap((ref) => {
      if (!ref.active || ref.binding !== "follow_current") return [];
      return snapshot.canvasItems
        .filter((item) => itemSpec(snapshot, item)?.id === ref.targetSpecId)
        .map((item) => ({
          id: ref.id,
          source: ref.source.id,
          target: item.id,
          intent: "generation_input" as const,
          referenceState: this.client.referenceStates.get(ref.id),
        }));
    });
    for (const node of document.nodes) {
      const item = snapshot.canvasItems.find((item) => item.id === node.id)!;
      if (item.binding.role !== "editor") continue;
      const docId = item.binding.objectRef.id;
      const editor = snapshot.editorDocuments.find((doc) => doc.id === docId)!;
      for (const connection of editor.inputConnections ?? []) {
        if (
          !snapshot.canvasItems.some(
            (source) => source.id === connection.sourceId,
          )
        )
          continue;
        const resource = assemblyResource(node, connection.slotId);
        if (resource) resource.nodeId = connection.sourceId;
        document.edges.push({
          id: connection.id,
          source: connection.sourceId,
          target: node.id,
          intent: "assembly_input",
          assemblySlotId: connection.slotId,
        });
      }
    }
    document.hiddenNodes = document.nodes.filter(
      (node) => !visible.has(node.id),
    );
    document.nodes = document.nodes.filter((node) => visible.has(node.id));
    return document;
  }
  async open() {
    await this.client.open();
    this.baseline = await this.read();
    this.basis = this.client.snapshot;
    return this.baseline;
  }

  private specInput(
    node: CanvasNode,
    current?: GenerationSpec,
  ): GenerationSpecInput {
    const common = {
      id: current?.id ?? crypto.randomUUID(),
      projectId: this.client.id,
      revision: current?.revision ?? 1,
      purpose: current?.purpose ?? "draft",
      modelConfigId:
        (node.type === "text"
          ? node.data.agentSettings?.modelConfigId
          : node.data.settings?.modelConfigId) ?? null,
      prompt: node.data.prompt,
      promptContent: current?.promptContent ?? null,
      currentResultId: current?.currentResultId ?? null,
    };
    switch (node.type) {
      case "text":
        return {
          ...common,
          kind: "text",
          parameters: {
            thinking: node.data.agentSettings?.thinking ?? "auto",
            maxTokens: node.data.agentSettings?.maxTokens ?? 8192,
          },
        };
      case "image":
        return {
          ...common,
          kind: "image",
          parameters:
            current?.kind === "image" ? current.parameters : { size: "2K" },
        };
      case "audio":
        return {
          ...common,
          kind: "audio",
          parameters: { voice: node.data.settings?.voiceName ?? null },
        };
      case "video": {
        const settings = node.data.settings;
        return {
          ...common,
          kind: "video",
          parameters: {
            videoMode:
              settings?.videoMode === "first-last"
                ? "first_frame"
                : (settings?.videoMode ?? "first_frame"),
            durationSeconds: settings?.durationSeconds ?? null,
            aspectRatio: settings?.aspectRatio ?? null,
            resolution:
              settings?.resolution === "自动"
                ? "auto"
                : (settings?.resolution ?? "auto"),
          },
        };
      }
      default:
        throw new Error("该节点不支持生成配置。");
    }
  }

  private async editorInput(
    node: CanvasNode,
    kind: EditorDocument["kind"],
    current?: EditorDocument,
    edges: CanvasDocument["edges"] = [],
  ): Promise<EditorDocumentInput> {
    const common = {
      id: current?.id ?? crypto.randomUUID(),
      projectId: this.client.id,
      revision: current?.revision ?? 1,
      inputConnections: await Promise.all(
        edges
          .filter(
            (edge) =>
              edge.target === node.id && edge.intent === "assembly_input",
          )
          .map(async (edge) => {
            const resource = assemblyResource(node, edge.assemblySlotId);
            if (!resource)
              throw new Error("装配连线对应的主体素材或时间线片段已不存在。");
            const asset = await this.importResource(resource);
            return {
              id: edge.id,
              sourceId: edge.source,
              asset,
              slotId:
                node.type === "subject" && edge.assemblySlotId !== "main"
                  ? asset.assetId
                  : edge.assemblySlotId!,
            };
          }),
      ),
    };
    const ref = (resource: CanvasResource) => this.importResource(resource);
    switch (kind) {
      case "subject": {
        // A partially populated node must not throw while projecting the canvas.
        const data = node.data.subject ?? {
          description: "",
          category: "",
          auxiliaries: [],
        };
        return {
          ...common,
          kind,
          data: {
            description: data.description,
            category: data.category,
            librarySource: data.librarySource ?? null,
            main: data.main ? await ref(data.main) : null,
            auxiliaries: await Promise.all(data.auxiliaries.map(ref)),
            voice: data.voice ? await ref(data.voice) : null,
          },
        };
      }
      case "timeline": {
        const resource = async (
          r: CanvasResource,
        ): Promise<TimelineResource> => ({
          asset: await ref(r),
          title: r.title,
          durationSeconds: r.durationSeconds ?? null,
        });
        const data = node.data.timeline!;
        return {
          ...common,
          kind,
          data: {
            fps: data.fps,
            width: data.width,
            height: data.height,
            importedAssets: await Promise.all(
              (data.importedAssets ?? []).map(resource),
            ),
            tracks: await Promise.all(
              data.tracks.map(async (track) => ({
                ...track,
                clips: await Promise.all(
                  track.clips.map(async (clip) => ({
                    ...clip,
                    start: clip.start ?? null,
                    resource: await resource(clip.resource),
                  })),
                ),
              })),
            ),
          },
        };
      }
      case "stack":
        return { ...common, kind, data: node.data.stack! };
      case "tool": {
        const data = node.data.tool!;
        return {
          ...common,
          kind,
          data: {
            kind: data.kind,
            fields: data.fields,
            provenance: data.provenance ?? null,
            palette: data.palette
              ? {
                  name: data.palette.name ?? null,
                  sourceImage: data.palette.sourceImageUri
                    ? await this.importResource({
                        kind: "image",
                        title: data.palette.name ?? "配色来源",
                        src: data.palette.sourceImageUri,
                      })
                    : null,
                }
              : null,
          },
        };
      }
      case "director": {
        const {
          format: _format,
          version: _version,
          ...data
        } = node.data.localStage ?? createLocalStage();
        return { ...common, kind, data };
      }
      case "layers": {
        const {
          format: _format,
          version: _version,
          ...data
        } = node.data.layers!;
        return {
          ...common,
          kind,
          data: {
            ...data,
            layers: await Promise.all(
              data.layers.map(async (layer) => ({
                ...layer,
                content:
                  layer.content.kind === "image"
                    ? {
                        kind: "image",
                        width: layer.content.width,
                        height: layer.content.height,
                        asset: await this.importResource({
                          kind: "image",
                          src: layer.content.src,
                          title: layer.name,
                        }),
                      }
                    : layer.content,
              })),
            ),
          },
        };
      }
      default:
        throw new Error("此编辑器需要专属命令。");
    }
  }

  /** Compare the edited view to the view it was based on, then send explicit
   * operations with that basis' versions. Server events never silently grant a
   * stale form permission to overwrite newer business fields. */
  async save(document: CanvasDocument) {
    if (!this.baseline || document.id !== this.client.id)
      throw new Error("请先打开统一工程。");
    const basis = this.basis;
    const oldNodes = new Map(
      [...this.baseline.nodes, ...(this.baseline.hiddenNodes ?? [])].map(
        (n) => [n.id, n],
      ),
    );
    const items = new Map(basis.canvasItems.map((i) => [i.id, i]));
    const operations: CreationOperation[] = [];
    const versions = new Map<string, ObjectVersion>();
    const expect = (
      type: ObjectVersion["objectType"],
      obj: { id: string; revision: number },
    ) => {
      versions.set(`${type}:${obj.id}`, objectVersion(type, obj));
    };
    const addReference = (reference: ReferenceInput) => {
      const previous = basis.references.find((ref) => ref.id === reference.id);
      if (previous) {
        expect("reference", previous);
        operations.push({
          type: "reference.restore",
          payload: {
            reference: {
              ...previous,
              ...reference,
              active: true,
              revision: previous.revision,
            },
          },
        });
      } else {
        operations.push({ type: "reference.add", payload: { reference } });
      }
    };
    const specs = new Map<string, string>();
    const moves: { itemId: string; position: { x: number; y: number } }[] = [];
    for (const node of [
      ...document.nodes,
      ...(document.hiddenNodes ?? []).filter((node) => !items.has(node.id)),
    ]) {
      const old = oldNodes.get(node.id),
        item = items.get(node.id);
      if (
        item &&
        !this.baseline.nodes.some((visible) => visible.id === item.id)
      ) {
        expect("canvas_item", item);
        operations.push({
          type: "canvas.show",
          payload: { item: { ...item, visible: true } },
        });
      }
      if (old && same(old, node)) {
        const spec = item && itemSpec(basis, item);
        if (spec) specs.set(node.id, spec.id);
        continue;
      }
      if (item) expect("canvas_item", item);
      let binding: CanvasItem["binding"] | undefined = item?.binding;
      const isMedia = ["text", "image", "video", "audio", "file"].includes(
        node.type,
      );
      if (isMedia) {
        const materialChanged =
          node.type === "text"
            ? node.data.text !== undefined &&
              node.data.text !== old?.data.text &&
              (!!node.data.text || !!old?.data.text)
            : !!node.data.src && node.data.src !== old?.data.src;
        if (materialChanged) {
          const previous =
            item && node.type === "text"
              ? currentAsset(basis, item)
              : undefined;
          const ref = await this.importResource({
            kind: node.type as Asset["kind"],
            title: node.data.title,
            src: node.data.src,
            text: node.data.text,
            identity: node.type === "text" ? node.id : undefined,
            previous: previous ? assetReference(previous) : undefined,
          });
          if (item)
            operations.push({
              type: "canvas.materialize",
              payload: {
                itemId: item.id,
                asset: ref,
                discardGenerationDraft: true,
              },
            });
          binding =
            item?.binding.role === "generation" && node.type === "text"
              ? { ...item.binding, materialOverride: ref }
              : { role: "material", objectRef: ref };
        }
        if (node.type !== "file") {
          const current = item ? itemSpec(basis, item) : undefined;
          const configureText =
            node.type === "text" && !!node.data.agentSettings?.modelConfigId;
          const cloneGeneration =
            !item &&
            binding?.role === "material" &&
            node.data.mediaRole === "generation";
          if (
            binding?.role !== "material" ||
            configureText ||
            cloneGeneration
          ) {
            const spec = {
              ...this.specInput(node, current),
              ...(cloneGeneration ? { purpose: "generation" as const } : {}),
            };
            specs.set(node.id, spec.id);
            if (!current)
              operations.push({
                type: "generationSpec.create",
                payload: { spec },
              });
            else if (!same(spec, this.specInput(old ?? node, current))) {
              expect("generation_spec", current);
              operations.push({
                type: "generationSpec.update",
                payload: { spec },
              });
            }
            if (cloneGeneration && binding?.role === "material")
              binding = {
                role: "generation",
                objectRef: { objectType: "generation_spec", id: spec.id },
                materialOverride: binding.objectRef,
              };
            else if (!binding || binding.role === "empty")
              binding = {
                role: "empty",
                draftSpec: { objectType: "generation_spec", id: spec.id },
                manualText: null,
              };
            else if (binding.role === "material" && configureText) {
              if (!item)
                binding = { role: "material", objectRef: binding.objectRef };
              // Preserve handwritten content while explicitly enabling Agent.
              operations.push({
                type: "canvas.configure",
                payload: {
                  itemId: node.id,
                  specId: spec.id,
                  preserveMaterial: true,
                },
              });
              if (current) expect("generation_spec", current);
            }
          }
        }
        binding ??= { role: "empty", draftSpec: null, manualText: null };
      } else if (node.type !== "group") {
        const kind = node.type === "external" ? "director" : node.type;
        const editorBinding =
          item?.binding.role === "editor" ? item.binding : undefined;
        const current = editorBinding
          ? basis.editorDocuments.find(
              (d) => d.id === editorBinding.objectRef.id,
            )
          : undefined;
        const doc = await this.editorInput(
          node,
          kind as EditorDocument["kind"],
          current,
          document.edges,
        );
        if (!current)
          operations.push({
            type: "editor.create",
            payload: { document: doc },
          });
        else {
          const previous = await this.editorInput(
            old ?? node,
            kind as EditorDocument["kind"],
            current,
            this.baseline.edges,
          );
          if (!same(doc, previous)) {
            expect("editor_document", current);
            operations.push({
              type: "editor.save",
              payload: { document: doc },
            });
          }
        }
        binding = {
          role: "editor",
          objectRef: {
            objectType: "editor_document",
            id: doc.id,
            kind: doc.kind,
          },
        };
      } else binding = { role: "container" };
      if (!item) {
        // Show precedes configure in a new text material+Agent transaction.
        const configureIndex = operations.findIndex(
          (op) =>
            op.type === "canvas.configure" && op.payload.itemId === node.id,
        );
        const show: CreationOperation = {
          type: "canvas.show",
          payload: {
            item: {
              id: node.id,
              projectId: this.client.id,
              kind: node.type,
              title: node.data.title,
              position: node.position,
              width: node.width,
              height: node.height,
              zIndex: node.zIndex ?? 0,
              locked: node.locked ?? false,
              parentId: node.parentId ?? null,
              binding,
            } as CanvasItem,
          },
        };
        if (configureIndex >= 0) operations.splice(configureIndex, 0, show);
        else operations.push(show);
        if (!document.nodes.some((visible) => visible.id === node.id))
          operations.push({
            type: "canvas.hide",
            payload: { itemId: node.id },
          });
      } else {
        const presentation = {
          title: node.data.title,
          width: node.width,
          height: node.height,
          zIndex: node.zIndex ?? 0,
          locked: node.locked ?? false,
          parentId: node.parentId ?? null,
        };
        const oldPresentation = {
          title: old?.data.title,
          width: old?.width,
          height: old?.height,
          zIndex: old?.zIndex ?? 0,
          locked: old?.locked ?? false,
          parentId: old?.parentId ?? null,
        };
        if (!same(presentation, oldPresentation))
          operations.push({
            type: "canvas.update",
            payload: { itemId: node.id, ...presentation },
          });
        if (!same(node.position, old?.position))
          moves.push({ itemId: node.id, position: node.position });
      }
    }
    if (moves.length)
      operations.push({ type: "canvas.move", payload: { items: moves } });
    for (const { id } of this.baseline.nodes)
      if (!document.nodes.some((n) => n.id === id)) {
        const item = items.get(id)!;
        expect("canvas_item", item);
        operations.push({ type: "canvas.hide", payload: { itemId: id } });
      }
    const oldEdges = new Map(this.baseline.edges.map((e) => [e.id, e]));
    // Hiding a node retains its business references. Explicit removals must
    // precede additions so replacing a relation to the same source in one
    // save does not have its new ID discarded as a duplicate.
    const stillVisible = new Set(
      [...document.nodes, ...(document.hiddenNodes ?? [])].map((n) => n.id),
    );
    for (const edge of this.baseline.edges)
      if (
        !document.edges.some((e) => e.id === edge.id) &&
        stillVisible.has(edge.source) &&
        stillVisible.has(edge.target)
      ) {
        const ref = basis.references.find((r) => r.id === edge.id);
        if (ref) {
          expect("reference", ref);
          const spec = basis.generationSpecs.find(
            (s) => s.id === ref.targetSpecId,
          )!;
          expect("generation_spec", spec);
          operations.push({
            type: "reference.remove",
            payload: { referenceId: ref.id },
          });
        }
      }
    for (const edge of document.edges) {
      if (edge.intent === "assembly_input") {
        if (!oldEdges.has(edge.id)) {
          const source = items.get(edge.source);
          if (source) expect("canvas_item", source);
        }
        continue;
      }
      if (edge.intent === "post_edit_result" || oldEdges.has(edge.id)) continue;
      const target = items.get(edge.target),
        current = target && itemSpec(basis, target);
      const specId = specs.get(edge.target) ?? current?.id;
      if (!specId) throw new Error("素材节点不能直接接受生成参考。");
      if (current) expect("generation_spec", current);
      if (target) expect("canvas_item", target);
      const existingOrders = basis.references
        .filter((r) => r.active && r.targetSpecId === specId)
        .map((r) => r.order);
      const addedOrders = operations.flatMap((op) =>
        (op.type === "reference.add" || op.type === "reference.restore") &&
        op.payload.reference.targetSpecId === specId
          ? [op.payload.reference.order ?? 0]
          : [],
      );
      const reference: ReferenceInput = {
        id: edge.id,
        projectId: this.client.id,
        targetSpecId: specId,
        binding: "follow_current",
        source: { id: edge.source },
        order: Math.max(-1, ...existingOrders, ...addedOrders) + 1,
        role: "reference",
      };
      addReference(reference);
    }
    for (const node of document.nodes.filter((node) => node.type === "video")) {
      const target = items.get(node.id),
        specId =
          specs.get(node.id) ??
          (target ? itemSpec(basis, target)?.id : undefined);
      if (!specId) continue;
      const settings = node.data.settings;
      for (const ref of basis.references.filter(
        (ref) => ref.active && ref.targetSpecId === specId,
      )) {
        if (
          operations.some(
            (op) =>
              op.type === "reference.remove" &&
              op.payload.referenceId === ref.id,
          )
        )
          continue;
        const sourceKind =
          ref.binding === "follow_current"
            ? items.get(ref.source.id)?.kind
            : ref.source.kind;
        const role =
          settings?.videoMode === "continuation" && sourceKind === "video"
            ? "continuation"
            : settings?.videoMode === "first-last" &&
                ((ref.binding === "follow_current" &&
                  ref.source.id === settings.firstFrameNodeId) ||
                  (ref.binding === "pinned" &&
                    ref.role === "first_frame" &&
                    !settings.firstFrameNodeId))
              ? "first_frame"
              : "reference";
        if (role !== ref.role) {
          expect("reference", ref);
          operations.push({
            type: "reference.update",
            payload: { reference: { ...ref, role } },
          });
        }
      }
      for (let index = 0; index < operations.length; index++) {
        const op = operations[index]!;
        if (
          (op.type === "reference.add" || op.type === "reference.restore") &&
          op.payload.reference.targetSpecId === specId
        ) {
          const ref = op.payload.reference;
          const sourceKind =
            ref.binding === "follow_current"
              ? (document.nodes.find((item) => item.id === ref.source.id)
                  ?.type ?? items.get(ref.source.id)?.kind)
              : ref.source.kind;
          const role =
            settings?.videoMode === "continuation" && sourceKind === "video"
              ? "continuation"
              : settings?.videoMode === "first-last" &&
                  ((ref.binding === "follow_current" &&
                    ref.source.id === settings.firstFrameNodeId) ||
                    (ref.binding === "pinned" &&
                      ref.role === "first_frame" &&
                      !settings.firstFrameNodeId))
                ? "first_frame"
                : "reference";
          operations[index] = {
            type: op.type,
            payload: { reference: { ...ref, role } },
          };
        }
      }
    }
    for (const node of document.nodes) {
      const old = oldNodes.get(node.id),
        specId =
          specs.get(node.id) ??
          (items.has(node.id)
            ? itemSpec(basis, items.get(node.id)!)?.id
            : undefined);
      if (
        !specId ||
        (node.data.prompt === old?.data.prompt &&
          same(node.data.promptContent, old?.data.promptContent) &&
          same(node.data.promptMentions, old?.data.promptMentions))
      )
        continue;
      const previousMentions = new Set(
        old?.data.promptContent?.flatMap((part) =>
          part.type === "reference" && part.referenceId
            ? [part.referenceId]
            : [],
        ) ?? [],
      );
      const nextMentions = new Set(
        node.data.promptContent?.flatMap((part) =>
          part.type === "reference" && part.referenceId
            ? [part.referenceId]
            : [],
        ) ?? [],
      );
      // Fixed references have no canvas edge, so their removals are derived
      // from the prompt and must also precede any replacement additions.
      for (const ref of basis.references.filter(
        (ref) =>
          ref.active &&
          ref.targetSpecId === specId &&
          node.data.promptContent !== undefined &&
          (ref.binding === "pinned" || previousMentions.has(ref.id)) &&
          !nextMentions.has(ref.id),
      )) {
        if (
          operations.some(
            (op) =>
              op.type === "reference.remove" &&
              op.payload.referenceId === ref.id,
          )
        )
          continue;
        expect("reference", ref);
        operations.push({
          type: "reference.remove",
          payload: { referenceId: ref.id },
        });
      }
      for (const part of node.data.promptContent ?? []) {
        if (
          part.type !== "reference" ||
          part.binding !== "asset" ||
          !part.referenceId
        )
          continue;
        if (
          basis.references.some(
            (ref) =>
              ref.id === part.referenceId &&
              ref.targetSpecId === specId &&
              ref.active,
          )
        )
          continue;
        if (
          operations.some(
            (op) =>
              (op.type === "reference.add" ||
                op.type === "reference.restore") &&
              op.payload.reference.id === part.referenceId,
          )
        )
          continue;
        const asset = basis.assets.find((asset) => asset.id === part.assetId);
        if (
          !asset ||
          (part.fingerprint && part.fingerprint !== asset.fingerprint)
        )
          throw new Error("固定参考版本已缺失或内容已改变。");
        const orders = [
          ...basis.references
            .filter((ref) => ref.active && ref.targetSpecId === specId)
            .map((ref) => ref.order),
          ...operations.flatMap((op) =>
            (op.type === "reference.add" || op.type === "reference.restore") &&
            op.payload.reference.targetSpecId === specId
              ? [op.payload.reference.order ?? 0]
              : [],
          ),
        ];
        addReference({
          id: part.referenceId,
          projectId: this.client.id,
          targetSpecId: specId,
          binding: "pinned",
          source: assetReference(asset),
          order: Math.max(-1, ...orders) + 1,
        });
      }
      const content: (
        | { type: "text"; text: string }
        | { type: "reference"; referenceId: string }
      )[] = [];
      let cursor = 0;
      for (const mention of node.data.promptMentions ?? []) {
        const edge = document.edges.find(
          (edge) =>
            edge.source === mention.sourceNodeId && edge.target === node.id,
        );
        const existing = basis.references.find(
          (ref) =>
            ref.active &&
            ref.targetSpecId === specId &&
            (ref.id === mention.referenceId ||
              (ref.binding === "follow_current" &&
                ref.source.id === mention.sourceNodeId)),
        );
        const pending = operations.find(
          (op) =>
            (op.type === "reference.add" || op.type === "reference.restore") &&
            op.payload.reference.id === mention.referenceId &&
            op.payload.reference.targetSpecId === specId,
        );
        const referenceId =
          edge?.id ??
          existing?.id ??
          (pending &&
          (pending.type === "reference.add" ||
            pending.type === "reference.restore")
            ? pending.payload.reference.id
            : undefined);
        const removed = operations.some(
          (op) =>
            op.type === "reference.remove" &&
            op.payload.referenceId === referenceId,
        );
        if (
          !referenceId ||
          removed ||
          mention.start < cursor ||
          mention.end > node.data.prompt.length
        )
          continue;
        if (mention.start > cursor)
          content.push({
            type: "text",
            text: node.data.prompt.slice(cursor, mention.start),
          });
        content.push({ type: "reference", referenceId });
        cursor = mention.end;
      }
      if (cursor < node.data.prompt.length)
        content.push({ type: "text", text: node.data.prompt.slice(cursor) });
      const spec = basis.generationSpecs.find((spec) => spec.id === specId);
      if (spec) expect("generation_spec", spec);
      operations.push({
        type: "generationSpec.setPrompt",
        payload: { specId, prompt: node.data.prompt, promptContent: content },
      });
    }
    await this.client.batch(operations, [...versions.values()]);
    const view = await this.client.view();
    await this.client.view({
      viewport: document.viewport,
      generationCounts: {
        ...view.generationCounts,
        ...Object.fromEntries(
          document.nodes
            .filter((node) => node.data.settings)
            .map((node) => [node.id, node.data.settings!.count ?? 1]),
        ),
      },
    });
    this.basis = this.client.snapshot;
    // Preserve ephemeral UI values until the next authoritative projection,
    // while all persisted business fields have been acknowledged by the server.
    this.baseline = document;
    return operations.length > 0;
  }
}
