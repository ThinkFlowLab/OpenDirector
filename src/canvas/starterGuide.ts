import { createDocument, createNode, type CanvasDocument } from "./model.ts";
import { fileDataUrl } from "./assets.ts";
import type { Translate } from "../i18n/I18nProvider.tsx";

// Stable source identities, scoped by the independent project, survive reopening.
export const GUIDE_IDS = {
  story: "601b22f4-d329-4bb5-91cb-5a1932200001",
  shots: "601b22f4-d329-4bb5-91cb-5a1932200002",
  reference: "601b22f4-d329-4bb5-91cb-5a1932200003",
  keyframe: "601b22f4-d329-4bb5-91cb-5a1932200004",
  alternative: "601b22f4-d329-4bb5-91cb-5a1932200005",
  timeline: "601b22f4-d329-4bb5-91cb-5a1932200006",
  original: "601b22f4-d329-4bb5-91cb-5a1932200007",
  generation: "601b22f4-d329-4bb5-91cb-5a1932200008",
} as const;
export const GUIDE_CLIPS = [
  "601b22f4-d329-4bb5-91cb-5a1932200011",
  "601b22f4-d329-4bb5-91cb-5a1932200012",
  "601b22f4-d329-4bb5-91cb-5a1932200013",
];
export const isStarterProject = (doc: CanvasDocument) =>
  doc.nodes.some((n) => n.id === GUIDE_IDS.story);
async function media(name: string, t: Translate) {
  const response = await fetch(
    `${import.meta.env?.BASE_URL ?? "/"}starter-guide/${name}`,
  );
  if (!response.ok)
    throw new Error(
      t("guide.assetUnavailable", { name, status: response.status }),
    );
  return fileDataUrl(
    new File([await response.blob()], name, {
      type: name.endsWith(".png")
        ? "image/png"
        : name.endsWith(".webm")
          ? "video/webm"
          : "video/mp4",
    }),
  );
}
export async function starterDocument(t: Translate): Promise<CanvasDocument> {
  const doc = createDocument(t("guide.project"));
  const story = createNode(
    "text",
    { x: 0, y: 0 },
    { title: t("guide.story"), text: t("guide.brief") },
  );
  story.id = GUIDE_IDS.story;
  const shots = createNode(
    "text",
    { x: 0, y: 380 },
    { title: t("guide.shots"), text: t("guide.shotBrief") },
  );
  shots.id = GUIDE_IDS.shots;
  const [reference, keyframe, alternative] = await Promise.all(
    ["character-reference.png", "shot-2.png", "shot-2-alternative.png"].map(
      (name) => media(name, t),
    ),
  );
  const images = [reference, keyframe, alternative, keyframe].map(
    (src, index) => {
      const node = createNode(
        "image",
        { x: 420 + index * 410, y: 0 },
        {
          title: t(
            (
              [
                "guide.reference",
                "guide.keyframe",
                "guide.alternative",
                "guide.original",
              ] as const
            )[index]!,
          ),
          src,
          mimeType: "image/png",
          assetState: "ready",
          generationProvenance: { source: "imported" },
          media: { width: 960, height: 540 },
        },
      );
      node.id = [
        GUIDE_IDS.reference,
        GUIDE_IDS.keyframe,
        GUIDE_IDS.alternative,
        GUIDE_IDS.original,
      ][index]!;
      return node;
    },
  );
  const clips = await Promise.all(
    [1, 2, 3].map(async (i) =>
      createNode(
        "video",
        { x: 420 + (i - 1) * 410, y: 420 },
        {
          title: t("guide.clip", { number: i }),
          src: await media(`shot-${i}.mp4`, t),
          mimeType: "video/mp4",
          assetState: "ready",
          generationProvenance: { source: "imported" },
          media: { width: 960, height: 540, durationSeconds: 4 },
        },
      ),
    ),
  );
  clips.forEach((clip, index) => {
    clip.id = GUIDE_CLIPS[index]!;
  });
  const timeline = createNode(
    "timeline",
    { x: 420, y: 850 },
    {
      title: t("guide.timeline"),
      timeline: {
        fps: 24,
        width: 960,
        height: 540,
        tracks: [
          {
            id: "visual",
            kind: "visual",
            title: t("guide.timeline"),
            muted: false,
            clips: [],
          },
        ],
      },
    },
  );
  timeline.id = GUIDE_IDS.timeline;
  const generation = createNode(
    "image",
    { x: 2050, y: 0 },
    { title: t("guide.futureGeneration"), prompt: t("guide.generationPrompt") },
  );
  generation.id = GUIDE_IDS.generation;
  doc.nodes = [story, shots, ...images, ...clips, timeline, generation];
  return doc;
}
export function assembleStarterTimeline(doc: CanvasDocument): CanvasDocument {
  const timeline = doc.nodes.find((n) => n.id === GUIDE_IDS.timeline);
  if (
    !timeline?.data.timeline ||
    timeline.data.timeline.tracks.some((t) => t.clips.length)
  )
    return doc;
  const videos = doc.nodes.filter(
    (n) => n.type === "video" && GUIDE_CLIPS.includes(n.id) && n.data.src,
  );
  const clips = videos.map((n) => ({
    id: crypto.randomUUID(),
    resource: {
      id: crypto.randomUUID(),
      nodeId: n.id,
      kind: "video" as const,
      title: n.data.title,
      src: n.data.src,
      mimeType: "video/mp4",
      width: 960,
      height: 540,
      durationSeconds: 4,
    },
    inPoint: 0,
    outPoint: 4,
    speed: 1,
    volume: 1,
    muted: true,
  }));
  return {
    ...doc,
    nodes: doc.nodes.map((n) =>
      n.id === timeline.id
        ? {
            ...n,
            data: {
              ...n.data,
              timeline: {
                ...timeline.data.timeline!,
                tracks: [{ ...timeline.data.timeline!.tracks[0]!, clips }],
              },
            },
          }
        : n,
    ),
    edges: [
      ...doc.edges,
      ...clips.map((c) => ({
        id: crypto.randomUUID(),
        source: c.resource.nodeId,
        target: timeline.id,
        intent: "assembly_input" as const,
        assemblySlotId: c.id,
      })),
    ],
  };
}
