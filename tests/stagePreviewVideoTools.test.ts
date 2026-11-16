import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isGenerationProvenance } from "../src/canvas/dataBoundary.ts";
import {
  CANVAS_TOOLS,
  isStagePreviewOutput,
  STAGE_PREVIEW_EXCLUDED_VIDEO_TOOLS,
} from "../src/canvas/toolCatalog.ts";
import { CreationProjection } from "../src/backend/creationProjection.ts";
import { CreationClient } from "../src/backend/creationClient.ts";
import type { ProjectSnapshot } from "../src/contracts/generated.ts";

const VIDEO_ASSET_ID = "00000000-0000-0000-0000-00000000000c";
const VIDEO_ITEM_ID = "00000000-0000-0000-0000-00000000002a";
const DIRECTOR_DOC_ID = "00000000-0000-0000-0000-000000000022";
// The fixture already carries a timeline-kind editor document, so the
// timeline case points at it instead of synthesizing one.
const TIMELINE_DOC_ID = "00000000-0000-0000-0000-00000000001f";

test("stage preview excluded tool ids stay catalog members without the kept editors", () => {
  for (const id of STAGE_PREVIEW_EXCLUDED_VIDEO_TOOLS)
    assert.ok(
      CANVAS_TOOLS.some((tool) => tool.id === id),
      `${id} is not a catalog tool`,
    );
  for (const id of ["video-frame-capture", "video-trim", "video-crop"] as const)
    assert.equal(STAGE_PREVIEW_EXCLUDED_VIDEO_TOOLS.has(id), false, id);
});

test("isStagePreviewOutput requires a video node carrying the flag", () => {
  assert.equal(
    isStagePreviewOutput({
      type: "video",
      data: { generationProvenance: { stagePreview: true } },
    }),
    true,
  );
  assert.equal(
    isStagePreviewOutput({
      type: "video",
      data: { generationProvenance: {} },
    }),
    false,
  );
  assert.equal(
    isStagePreviewOutput({
      type: "image",
      data: { generationProvenance: { stagePreview: true } },
    }),
    false,
  );
  assert.equal(isStagePreviewOutput({ type: "video", data: {} }), false);
});

test("projection stamps stagePreview only for director execution documents", async () => {
  // An 'edited' source keeps the director document id to prove the source,
  // not just the lookup, gates the flag.
  const cases = [
    { source: "rendered", editorDocumentId: DIRECTOR_DOC_ID, expected: true },
    { source: "rendered", editorDocumentId: TIMELINE_DOC_ID, expected: undefined },
    { source: "edited", editorDocumentId: DIRECTOR_DOC_ID, expected: undefined },
  ] as const;
  const base = JSON.parse(
    readFileSync(
      new URL("./fixtures/creation-project.json", import.meta.url),
      "utf8",
    ),
  ) as ProjectSnapshot;
  for (const { source, editorDocumentId, expected } of cases) {
    const snapshot: ProjectSnapshot = {
      ...base,
      assets: base.assets.map((asset) =>
        asset.id === VIDEO_ASSET_ID
          ? {
              ...asset,
              provenance: { ...asset.provenance, source, editorDocumentId },
            }
          : asset,
      ),
    };
    const client = new CreationClient(snapshot.project.id);
    client.install(snapshot);
    client.mediaUrl = async (id) => `blob:${id}`;
    client.view = async () => ({
      projectId: client.id,
      clientId: crypto.randomUUID(),
      viewport: { x: 0, y: 0, zoom: 1 },
      selectedItemIds: [],
      activeEditorId: null,
      playheads: [],
      generationCounts: {},
    });
    const document = await new CreationProjection(client).read();
    const node = document.nodes.find((n) => n.id === VIDEO_ITEM_ID);
    assert.ok(node, "video canvas item missing from projection");
    assert.deepEqual(
      node.data.generationProvenance?.stagePreview,
      expected,
      `${source} -> ${editorDocumentId}`,
    );
  }
});

test("isGenerationProvenance accepts a boolean stagePreview and rejects other values", () => {
  assert.equal(
    isGenerationProvenance({ source: "rendered", stagePreview: true }),
    true,
  );
  assert.equal(
    isGenerationProvenance({ source: "rendered" }),
    true,
  );
  assert.equal(
    isGenerationProvenance({ source: "rendered", stagePreview: "yes" }),
    false,
  );
});
