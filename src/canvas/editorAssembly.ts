import type { CanvasEdge, CanvasNode, CanvasResource } from "./model.ts";
import { addTimelineClip } from "./timeline.ts";

export const isAssemblyTarget = (node: CanvasNode) =>
  node.type === "subject" || node.type === "timeline";

/** Assembly retains a source snapshot; it does not configure a generation. */
function sourceResource(node: CanvasNode): CanvasResource {
  return {
    id: `node:${node.id}`,
    nodeId: node.id,
    ...(node.data.backendAssetId ? { assetId: node.data.backendAssetId } : {}),
    kind: node.type as CanvasResource["kind"],
    title: node.data.title,
    src: node.data.src,
    mimeType: node.data.mimeType,
    byteSize: node.data.byteSize,
    ...node.data.media,
  };
}

/** A clip keeps the media it was assembled with. Regenerating the source node
 * afterwards leaves the link naming a node that no longer produces that media,
 * and an exported archive carries the pair as it stood. The clip still owns its
 * media, so such a link is stale rather than corrupt: sending it asks the
 * domain to record a relation it would refuse. */
export function staleAssembly(
  source: CanvasNode | undefined,
  resource: CanvasResource,
) {
  const media = source ? sourceResource(source).src : undefined;
  return Boolean(media && resource.src && resource.src !== media);
}

export function assemblyIssue(source: CanvasNode, target: CanvasNode) {
  if (target.type === "subject") {
    const subject = target.data.subject;
    if (subject?.main) {
      if (source.type === "video" || subject.main.kind === "video")
        return "subject_mode_conflict" as const;
      if ((subject.auxiliaries.length ?? 0) >= 3)
        return "subject_capacity_exceeded" as const;
      if (
        [subject.main, ...subject.auxiliaries].some(
          (r) =>
            r.nodeId === source.id ||
            r.id === `node:${source.id}` ||
            Boolean(
              source.data.backendAssetId &&
              r.assetId === source.data.backendAssetId,
            ),
        )
      )
        return "duplicate_relation" as const;
    }
    if (
      source.type === "video" &&
      source.data.media?.durationSeconds !== undefined &&
      source.data.media.durationSeconds > 15
    )
      return "subject_duration_exceeded" as const;
  }
  if (
    ["video", "audio"].includes(source.type) &&
    !(
      Number.isFinite(source.data.media?.durationSeconds) &&
      source.data.media!.durationSeconds! > 0
    )
  )
    return "source_duration_missing" as const;
  return null;
}

export function assembleNode(source: CanvasNode, target: CanvasNode) {
  const resource = sourceResource(source);
  if (target.type === "subject") {
    const subject = target.data.subject ?? {
      description: "",
      category: "character",
      auxiliaries: [],
    };
    const main = !subject.main;
    return {
      slotId: main ? "main" : resource.id,
      node: {
        ...target,
        data: {
          ...target.data,
          subject: {
            ...subject,
            ...(main
              ? { main: resource }
              : { auxiliaries: [...subject.auxiliaries, resource] }),
          },
        },
      },
    };
  }
  const timeline = addTimelineClip(target.data.timeline!, resource);
  const oldIds = new Set(
    target.data.timeline!.tracks.flatMap((t) => t.clips.map((c) => c.id)),
  );
  const clip = timeline.tracks
    .flatMap((t) => t.clips)
    .find((c) => !oldIds.has(c.id))!;
  return {
    slotId: clip.id,
    node: { ...target, data: { ...target.data, timeline } },
  };
}

export function assemblyResource(
  target: CanvasNode | undefined,
  slotId: string | undefined,
) {
  if (!target || !slotId) return undefined;
  if (target.type === "subject")
    return slotId === "main"
      ? target.data.subject?.main
      : target.data.subject?.auxiliaries.find((r) => r.id === slotId);
  return target.data.timeline?.tracks
    .flatMap((t) => t.clips)
    .find((c) => c.id === slotId)?.resource;
}

export function removeAssembly(node: CanvasNode, edges: CanvasEdge[]) {
  if (!edges.length) return node;
  const slots = new Set(edges.map((e) => e.assemblySlotId));
  if (node.type === "subject" && node.data.subject) {
    const subject = node.data.subject;
    return {
      ...node,
      data: {
        ...node.data,
        subject: {
          ...subject,
          main: slots.has("main") ? undefined : subject.main,
          auxiliaries: slots.has("main")
            ? []
            : subject.auxiliaries.filter((r) => !slots.has(r.id)),
          voice: slots.has("main") ? undefined : subject.voice,
        },
      },
    };
  }
  if (node.type === "timeline" && node.data.timeline)
    return {
      ...node,
      data: {
        ...node.data,
        timeline: {
          ...node.data.timeline,
          tracks: node.data.timeline.tracks.map((track) => ({
            ...track,
            clips: track.clips.filter((clip) => !slots.has(clip.id)),
          })),
        },
      },
    };
  return node;
}
