import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
  CanvasItem,
  CanvasItemBase,
  CommandInput,
  ImageCanvasItemInput,
  ProjectSnapshot,
  TimelineDocument,
} from "../src/contracts/index.ts";

// Compile-time checks exercise the generated inheritance and both discriminators.
const emptyImage: ImageCanvasItemInput = {
  id: "00000000-0000-0000-0000-000000000053",
  projectId: "00000000-0000-0000-0000-000000000001",
  kind: "image",
  binding: { role: "empty" },
};
const invalidImage: ImageCanvasItemInput = {
  ...emptyImage,
  // @ts-expect-error Image nodes cannot directly bind an editor document.
  binding: { role: "editor", objectRef: { id: "editor", kind: "timeline" } },
};
const invalidCommand: CommandInput = {
  commandId: "command",
  projectId: "project",
  type: "canvas.update",
  // @ts-expect-error Role changes are not presentation updates.
  payload: { itemId: "item", role: "generation" },
};
void invalidImage;
void invalidCommand;

function label(item: CanvasItem): string {
  const base: CanvasItemBase = item;
  if (item.kind === "timeline") {
    return `${base.title}:${item.binding.objectRef.kind}`;
  }
  if (item.kind === "image" && item.binding.role === "material") {
    return item.binding.objectRef.assetId;
  }
  return base.kind;
}

test("Python-normalized project retains typed editor and media relationships", () => {
  // This fixture is parsed and compared to its Python source in test_creation_contracts.py.
  // TypeScript alone does not validate untrusted JSON; the Python boundary does.
  const project = JSON.parse(
    readFileSync(
      new URL("./fixtures/creation-project.json", import.meta.url),
      "utf8",
    ),
  ) as ProjectSnapshot;
  assert.equal(new Set(project.canvasItems.map((item) => item.kind)).size, 11);
  const timeline = project.editorDocuments.find(
    (doc): doc is TimelineDocument => doc.kind === "timeline",
  );
  assert.ok(timeline);
  assert.equal(timeline.data.tracks[1].clips[0].start, 1);
  assert.equal(timeline.data.tracks[1].clips[0].outPoint, 4);
  assert.ok(project.canvasItems.map(label).includes(":timeline"));
  assert.equal(project.jobs[0].inputSnapshot.spec.currentResultId, null);
  assert.equal(
    project.generationSpecs[0].currentResultId,
    project.results[0].id,
  );
});

test("schema publishes the same command for HTTP and Agent adapters", () => {
  const schema = JSON.parse(
    readFileSync(
      new URL("../src/contracts/creation.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const input = schema.input.$defs;
  assert.equal(
    input.GenerationSubmitCommand.properties.type.const,
    "generation.submit",
  );
  assert.equal(input.GenerationSubmit.properties.specId.format, "uuid");
  assert.equal(
    input.CanvasShow.properties.item.discriminator.propertyName,
    "kind",
  );
  assert.equal(
    input.ImageCanvasItem.properties.binding.discriminator.propertyName,
    "role",
  );
  assert.equal(input.ModelSnapshot.additionalProperties, false);
  assert.equal(input.ModelSnapshot.properties.apiKey, undefined);
  assert.equal(
    input.ModelConfigWrite.properties.apiKey.anyOf[0].writeOnly,
    true,
  );
});

test("text output fields stay optional for pre-text commits and reference immutable file assets", () => {
  const schema = JSON.parse(
    readFileSync(
      new URL("../src/contracts/creation.schema.json", import.meta.url),
      "utf8",
    ),
  );
  for (const mode of ["input", "output"]) {
    const defs = schema[mode].$defs;
    assert.ok(!defs.TimelineData.required.includes("fonts"));
    assert.ok(!defs.TimelineData.required.includes("overlays"));
    assert.equal(
      defs.TimelineTextOverlay.properties.sourceAsset.anyOf[0].$ref,
      "#/$defs/AssetRef",
    );
    assert.equal(
      defs.TimelineFontResource.properties.asset.$ref,
      "#/$defs/AssetRef",
    );
    assert.equal(defs.TimelineTextOverlay.properties.src, undefined);
  }
});
