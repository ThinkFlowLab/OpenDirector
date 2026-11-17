import type { ProjectSnapshot } from "../contracts/generated.ts";
import type { LinkedMediaResult } from "../canvas/linkedResults.ts";
import { CreationClient, objectVersion } from "./creationClient.ts";
import { CreationProjection } from "./creationProjection.ts";
import { tNow } from "../i18n/messages.ts";

export function timelineOutputItem(snapshot: ProjectSnapshot, itemId: string) {
  const source = snapshot.canvasItems.find((item) => item.id === itemId);
  if (source?.binding.role !== "editor") return undefined;
  const editorId = source.binding.objectRef.id;
  return [...snapshot.canvasItems].reverse().find((item) => {
    if (item.kind !== "video" || item.binding.role !== "material" || !item.visible) return false;
    const assetId = item.binding.objectRef.assetId;
    const origin = snapshot.assets.find((asset) => asset.id === assetId)?.provenance;
    return origin?.source === "rendered" && origin.editorDocumentId === editorId &&
      (!origin.sourceItemId || origin.sourceItemId === itemId);
  });
}

/** Captured when rendering starts, independent of subsequent editor changes. */
export function timelinePublication(
  client: CreationClient,
  snapshot: ProjectSnapshot,
  itemId: string,
  position?: { x: number; y: number },
  outputId?: string,
) {
  const item = snapshot.canvasItems.find((item) => item.id === itemId)!;
  if (item.binding.role !== "editor")
    throw new Error(tNow("errors.backend.timelineSourceMissing"));
  const editorId = item.binding.objectRef.id;
  const editor = snapshot.editorDocuments.find((doc) => doc.id === editorId)!;
  const existing = timelineOutputItem(snapshot, itemId);
  outputId ??= existing?.id ?? crypto.randomUUID();
  const target = snapshot.canvasItems.find((item) => item.id === outputId);
  const projection = new CreationProjection(client);
  const commandId = crypto.randomUUID();
  let delivery:
    | {
        payload: {
          itemId: string;
          editorId: string;
          asset: Awaited<ReturnType<CreationProjection["importResource"]>>;
          outputId: string;
          expectedOutputRevision?: number;
          title: string;
          position: { x: number; y: number };
        };
        versions: ReturnType<typeof objectVersion>[];
      }
    | undefined;
  return async (result: LinkedMediaResult) => {
    if (!delivery) {
      const asset = await projection.importResource({ ...result, fresh: true, identity: commandId });
      delivery = {
        payload: {
          itemId,
          editorId,
          asset,
          outputId,
          ...(target ? { expectedOutputRevision: target.revision } : {}),
          title: result.title,
          position: position ?? {
            x: item.position.x + item.width + 80,
            y: item.position.y,
          },
        },
        versions: [
          objectVersion("canvas_item", item),
          ...(target ? [objectVersion("canvas_item", target)] : []),
          objectVersion("editor_document", editor),
          objectVersion("asset", {
            id: asset.assetId,
            revision: asset.revision,
          }),
        ],
      };
    }
    await client.command(
      "timeline.publishRender",
      delivery.payload,
      delivery.versions,
      undefined,
      commandId,
    );
    return true;
  };
}
