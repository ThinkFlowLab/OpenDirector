import { chooseGenerationModel } from "./model_picker.mjs";
/** Shared full-workflow prelude: genuine UI upload, reference, candidate and layers. */
import assert from "node:assert/strict";
export async function creationJourney(
  page,
  { pid, state, call, until, saved },
) {
  await page.getByLabel("Choose local asset files", { exact: true }).setInputFiles({
    name: "reference.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGNsYGhgIAUwkaR6VMOohiGlAQBCPQEgiSD+iQAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  const source = await until(async () =>
    (await state()).canvasItems.find((i) => i.kind === "image"),
  );
  await saved();
  await page
    .getByRole("toolbar", { name: "Canvas creation tools" })
    .getByRole("button", { name: "Add Image", exact: true })
    .click();
  const target = await until(async () =>
    (await state()).canvasItems.find(
      (i) => i.kind === "image" && i.id !== source.id,
    ),
  );
  // Layout alone uses the public command; the relationship is drawn by the user gesture below.
  await page.evaluate(
    async ({ pid, ids }) => {
      const { creationClient, objectVersion } =
        await import("/src/backend/creationClient.ts");
      const c = creationClient(pid);
      await c.refresh();
      await c.command(
        "canvas.move",
        {
          items: c.snapshot.canvasItems.map((item) => ({
            itemId: item.id,
            position: ids.includes(item.id)
              ? { x: 150 + ids.indexOf(item.id) * 550, y: 150 }
              : { x: 150, y: 650 },
          })),
        },
        c.snapshot.canvasItems.map((i) => objectVersion("canvas_item", i)),
      );
    },
    { pid, ids: [source.id, target.id] },
  );
  await page.locator(".cw-workspace").focus();
  await page.keyboard.press("Shift+1");
  await page.waitForTimeout(500);
  const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
  const a = await node(source.id).boundingBox(),
    b = await node(target.id).boundingBox();
  await page.mouse.move(a.x + a.width + 7, a.y + a.height / 2);
  const port = page.locator(".cw-reference-port");
  await port.waitFor();
  const p = await port.boundingBox();
  await page.mouse.move(p.x + p.width / 2, p.y + p.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 30, b.y + 40, { steps: 12 });
  await page.mouse.up();
  await until(async () =>
    (await state()).references.some(
      (r) => r.active && r.source.id === source.id,
    ),
  );
  await node(target.id).locator(".cw-node-title").click();
  await chooseGenerationModel(page, { label: "fixture-image" });
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true });
  await prompt.click();
  await prompt.press("Control+End");
  await page.keyboard.insertText(" Generate from the uploaded reference");
  await call("/api/creation-test-gate", { open: false });
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await until(async () => (await state()).jobs.length === 1);
  // The active UI deliberately disables its prompt during generation. Model a
  // concurrent writer through the shared command, without mutating the DOM.
  await page.evaluate(
    async ({ pid, itemId }) => {
      const { creationClient, objectVersion } =
        await import("/src/backend/creationClient.ts");
      const c = creationClient(pid);
      await c.refresh();
      const item = c.snapshot.canvasItems.find((i) => i.id === itemId);
      const spec = c.snapshot.generationSpecs.find(
        (s) => s.id === item.binding.objectRef.id,
      );
      await c.command(
        "generationSpec.setPrompt",
        {
          specId: spec.id,
          prompt: "Keep the concurrent next-attempt intent",
          promptContent: [
            { type: "text", text: "Keep the concurrent next-attempt intent" },
          ],
        },
        [objectVersion("generation_spec", spec)],
      );
    },
    { pid, itemId: target.id },
  );
  const timelineItem = (await state()).canvasItems.find(
    (i) => i.kind === "timeline",
  );
  const timelineBefore = (await state()).editorDocuments.find(
    (d) => d.id === timelineItem.binding.objectRef.id,
  );
  await page.locator(".cw-workspace").focus();
  await page.keyboard.press("Shift+1");
  await page.waitForTimeout(300);
  await node(timelineItem.id)
    .locator(".cw-node-title")
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open editor", exact: true }).click();
  const draftRate = page.getByLabel(/Frame rate/);
  await draftRate.selectOption("50");
  await draftRate.focus();
  await call("/api/creation-test-gate", { open: true });
  const finished = await until(async () => {
    const s = await state();
    return s.jobs[0]?.status === "succeeded" && s;
  });
  await until(
    async () =>
      await page.evaluate(
        async ({ pid, cursor }) => {
          const { creationClient } =
            await import("/src/backend/creationClient.ts");
          return creationClient(pid).snapshot.eventCursor >= cursor;
        },
        { pid, cursor: finished.eventCursor },
      ),
  );
  assert.equal(await draftRate.inputValue(), "50");
  assert.equal(
    await draftRate.evaluate((e) => document.activeElement === e),
    true,
  );
  assert.ok(
    (await node(timelineItem.id).getAttribute("class")).includes("selected"),
  );
  assert.deepEqual(
    finished.editorDocuments.find((d) => d.id === timelineBefore.id),
    timelineBefore,
  );
  await page.getByRole("button", { name: "Close editor", exact: true }).click();
  console.log(
    "PASS background task updates preserve selected node, focused editor control and unsaved timeline draft",
  );
  const specId = finished.jobs[0].inputSnapshot.spec.id;
  assert.equal(finished.jobs[0].adopted, false);
  assert.equal(
    finished.jobs[0].inputSnapshot.references[0].asset.assetId,
    source.binding.objectRef.assetId,
  );
  assert.match(
    finished.jobs[0].inputSnapshot.spec.prompt,
    /Generate from the uploaded reference/,
  );
  assert.equal(
    finished.generationSpecs.find((s) => s.id === specId).prompt,
    "Keep the concurrent next-attempt intent",
  );
  await page.getByRole("button", { name: "Generation history", exact: true }).click();
  await page.getByRole("button", { name: "Use result", exact: true }).click();
  await until(
    async () =>
      (await state()).generationSpecs.find((s) => s.id === specId)
        ?.currentResultId === finished.results[0].id,
  );
  await page.getByRole("button", { name: "Close sidebar", exact: true }).click();
  await node(target.id).locator(".cw-node-title").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit image", exact: true }).click();
  await page.getByRole("button", { name: "Layer studio", exact: true }).click();
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.getByLabel("Layer text content", { exact: true }).fill("Journey layer");
  await page.getByRole("button", { name: "Apply to canvas", exact: true }).click();
  const snapshot = await until(async () => {
    const s = await state();
    return s.editorDocuments.some((d) => d.kind === "layers") && s;
  });
  await saved();
  const edited = snapshot.canvasItems.find((i) => i.id === target.id).binding
    .materialOverride;
  assert.ok(edited);
  assert.deepEqual(snapshot.jobs, finished.jobs);
  const resource = await page.evaluate(
    async ({ pid, asset }) => {
      const { creationClient } = await import("/src/backend/creationClient.ts");
      return {
        id: asset.assetId,
        kind: "image",
        title: "Edited generated candidate",
        src: await creationClient(pid).mediaUrl(asset.assetId),
        mimeType: "image/png",
        width: 320,
        height: 240,
      };
    },
    { pid, asset: edited },
  );
  console.log(
    "PASS same-project UI upload, dragged reference, immutable generation input, concurrent next intent, explicit candidate adoption and editable layers",
  );
  return { resource, snapshot, targetId: target.id };
}
