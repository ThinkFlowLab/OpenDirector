import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";

import { CreationClient } from "../src/backend/creationClient.ts";
import { CreationProjection } from "../src/backend/creationProjection.ts";
import type { ProjectSnapshot } from "../src/contracts/generated.ts";

test("the placeholder badge follows the displayed asset, not the selected job", async () => {
  const source = JSON.parse(
    readFileSync(
      new URL("./fixtures/creation-project.json", import.meta.url),
      "utf8",
    ),
  ) as ProjectSnapshot;

  const job = source.jobs[0]!;
  const generated = source.assets.find((asset) => asset.kind === "image" && asset.provenance.source === "generated")!;
  const placeholderModel = {
    ...job.inputSnapshot.model,
    modelId: "placeholder",
    protocol: "placeholder" as const,
    connectionType: "builtin" as const,
    url: "builtin://placeholder",
  };
  const placeholderAsset = {
    ...generated,
    id: "00000000-0000-0000-0000-0000000000p1".replace("p1", "a1"),
    provenance: { ...generated.provenance, jobId: job.id, modelSnapshot: placeholderModel },
  };
  const uploadedAsset = {
    ...generated,
    id: "00000000-0000-0000-0000-0000000000a2",
    provenance: { ...generated.provenance, source: "upload" as const, jobId: null, modelSnapshot: null },
  };
  const spec = { ...source.generationSpecs[0]! };
  const jobWithPlaceholder = {
    ...job,
    id: job.id,
    status: "succeeded" as const,
    inputSnapshot: { ...job.inputSnapshot, model: placeholderModel, references: [] },
    asset: { ...job.asset!, assetId: placeholderAsset.id, fingerprint: placeholderAsset.fingerprint },
  };
  const result = {
    ...source.results[0]!,
    id: spec.currentResultId!,
    jobId: job.id,
    specId: spec.id,
    asset: { ...source.results[0]!.asset, assetId: placeholderAsset.id, fingerprint: placeholderAsset.fingerprint },
  };
  const generationItem = {
    ...source.canvasItems.find((item) => item.binding.role === "generation")!,
  };
  const replacedItem = {
    ...generationItem,
    id: "00000000-0000-0000-0000-0000000000b1",
    binding: {
      ...generationItem.binding,
      materialOverride: {
        assetId: uploadedAsset.id,
        revision: uploadedAsset.revision,
        fingerprint: uploadedAsset.fingerprint,
        kind: uploadedAsset.kind,
      },
    },
  };
  const materialItem = {
    ...source.canvasItems.find((item) => item.binding.role === "material")!,
    id: "00000000-0000-0000-0000-0000000000b2",
    binding: {
      role: "material" as const,
      objectRef: {
        assetId: placeholderAsset.id,
        revision: placeholderAsset.revision,
        fingerprint: placeholderAsset.fingerprint,
        kind: placeholderAsset.kind,
      },
    },
  };

  const snapshot: ProjectSnapshot = {
    ...source,
    assets: [placeholderAsset, uploadedAsset],
    generationSpecs: [spec],
    jobs: [jobWithPlaceholder],
    results: [result],
    canvasItems: [generationItem, replacedItem, materialItem],
  };
  const client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  client.mediaUrl = async (id) => `blob:${id}`;
  client.assetForSource = () => undefined;
  client.view = async () => ({
    projectId: client.id,
    clientId: crypto.randomUUID(),
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedItemIds: [],
    activeEditorId: null,
    playheads: [],
    generationCounts: {},
  });
  const projection = new CreationProjection(client);
  const document = await projection.read();

  const generationNode = document.nodes.find((node) => node.id === generationItem.id)!;
  const replacedNode = document.nodes.find((node) => node.id === replacedItem.id)!;
  const materialNode = document.nodes.find((node) => node.id === materialItem.id)!;
  // The generation node shows the placeholder result: badge on.
  assert.equal(generationNode.data.mediaPlaceholder, true);
  // An upload overriding the material shows no badge even though the
  // selected job is still the placeholder one.
  assert.equal(replacedNode.data.mediaPlaceholder, false);
  // A material node reusing the placeholder asset keeps the badge.
  assert.equal(materialNode.data.mediaPlaceholder, true);
});
