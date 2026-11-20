import assert from "node:assert/strict";
import { join } from "node:path";

/** Runs inside the bilingual HTTP video workflow and shares its local model. */
export async function fastH3CapabilityFlow({ page, call, until, projectId, sourceAsset, url, posts, setLimit, locale }) {
  const config = await call("/api/model-configs", {
    kind: "video", url, modelId: "FastH3-Omni-INT8", apiKey: "",
    protocol: "vllm_omni", connectionType: "self_hosted", authMode: "none", videoAdapter: "fasth3_dual",
  });
  try {
    const target = await page.evaluate(async ({ projectId, configId, asset }) => {
      const { creationClient } = await import("/src/backend/creationClient.ts");
      const client = creationClient(projectId);
      await client.refresh();
      const sources = [crypto.randomUUID(), crypto.randomUUID()];
      for (const [index, id] of sources.entries()) {
        const receipt = await client.command("canvas.show", { item: {
          id, projectId, kind: "image", title: index ? "Tail anchor" : "First anchor",
          position: { x: 1000 + index * 450, y: 0 }, binding: { role: "material", objectRef: {
            assetId: asset.id, revision: asset.revision, fingerprint: asset.fingerprint, kind: "image",
          } },
        } });
        if (receipt.status !== "applied") throw Error(JSON.stringify(receipt));
      }
      const specId = crypto.randomUUID(), itemId = crypto.randomUUID();
      const receipt = await client.command("canvas.createGeneration", {
        spec: { id: specId, projectId, kind: "video", purpose: "generation", modelConfigId: configId,
          prompt: "Animate the same image between two keyframes", parameters: { videoMode: "first_frame", durationSeconds: 5 } },
        item: { id: itemId, projectId, kind: "video", position: { x: 1000, y: 400 },
          binding: { role: "generation", objectRef: { id: specId } } },
        references: sources.map((id, index) => ({ id: crypto.randomUUID(), projectId, targetSpecId: specId,
          binding: "follow_current", source: { id }, role: index ? "last_frame" : "first_frame", order: 1 - index })),
      });
      if (receipt.status !== "applied") throw Error(JSON.stringify(receipt));
      return { itemId, specId };
    }, { projectId, configId: config.id, asset: sourceAsset });
    const path = `/api/creation/projects/${projectId}`;
    const composer = page.locator(".cw-generation-composer");
    const select = async () => {
      await page.locator(".cw-workspace").focus();
      await page.keyboard.press("Shift+1");
      await page.locator(`.react-flow__node[data-id="${target.itemId}"]`).click();
      await composer.waitFor();
    };
    const refresh = () => call("/api/model-configs/availability", { configIds: [config.id], manual: true });
    setLimit(10);
    await refresh();
    await page.reload();
    await select();
    const before = await call(path), start = posts.length;
    const response = page.waitForResponse((r) => r.url().endsWith("/commands") &&
      r.request().method() === "POST" && r.request().postDataJSON()?.type === "generation.submit");
    await composer.locator("button.cw-run-button").click();
    const refusal = await (await response).json();
    assert.equal(refusal.status, "rejected", JSON.stringify(refusal));
    assert.equal(refusal.issues[0].code, "capability_unavailable");
    const after = await call(path);
    assert.deepEqual(after.jobs, before.jobs);
    assert.deepEqual(after.references, before.references);
    assert.deepEqual(after.generationSpecs, before.generationSpecs);
    assert.equal(posts.length, start);
    assert.match(await composer.innerText(), /Animate the same image between two keyframes/);
    await page.getByText(locale === "en-US" ? /The selected parameter.*service/ : /所选参数不符合服务要求/).first().waitFor();
    if (process.env.CREATION_SCREENSHOTS) await page.screenshot({
      path: join(process.env.CREATION_SCREENSHOTS, `fasth3-refused-${locale}.png`), fullPage: true,
    });
    setLimit(20);
    await refresh();
    await page.reload();
    await select();
    assert.match(await composer.innerText(), /Animate the same image between two keyframes/);
    await composer.locator("button.cw-run-button").click();
    const complete = await until(() => call(path),
      (s) => s.jobs.some((j) => j.inputSnapshot.spec.id === target.specId && j.status === "succeeded"), "FastH3 keyframes");
    const job = complete.jobs.find((j) => j.inputSnapshot.spec.id === target.specId);
    assert.equal(posts.length, start + 1);
    const sent = posts.at(-1), extra = JSON.parse(sent.fields.extra_params);
    assert.equal(extra.task, "fl2va");
    assert.equal(extra.sampler, "res_multistep");
    assert.deepEqual(extra.frame_indices, [0, -1]);
    assert.equal(sent.fields.num_inference_steps, "20");
    assert.equal(job.adapterParameters.num_inference_steps, 20);
    assert.equal(job.execution.numInferenceSteps, 20);
    assert.equal(sent.fields.seed, String(job.adapterParameters.seed));
    assert.equal(sent.fields.num_frames, "120");
    assert.deepEqual(sent.files.map((f) => [f.key, f.name, f.size]), [
      ["input_references", "first_frame.png", sourceAsset.metadata.size],
      ["input_references", "last_frame.png", sourceAsset.metadata.size],
    ]);
    assert.deepEqual(job.inputSnapshot.references.map((r) => r.asset.assetId), [sourceAsset.id, sourceAsset.id]);
    assert.equal(job.inputSnapshot.model.videoAdapter, "fasth3_dual");
    assert.equal(job.technicalCheck.status, "passed");
    await page.reload();
    await select();
    assert.match(await composer.innerText(), /Animate the same image between two keyframes/);
    assert.deepEqual((await call(path)).jobs, complete.jobs);
    await page.waitForFunction((id) => {
      const video = document.querySelector(`.react-flow__node[data-id="${id}"] video.cw-video-preview`);
      return video?.videoWidth === 64 && video.videoHeight === 48 && video.duration > 0;
    }, target.itemId);
    if (process.env.CREATION_SCREENSHOTS) await page.screenshot({
      path: join(process.env.CREATION_SCREENSHOTS, `fasth3-complete-${locale}.png`), fullPage: true,
    });
    return { steps: job.execution.numInferenceSteps, frames: job.execution.numFrames, uploads: sent.files.length,
      sameAsset: sourceAsset.id, rejectedJobs: 0, rejectedRequests: 0, reopenedJob: job.id };
  } finally {
    await call(`/api/model-configs/${config.id}`, undefined, "DELETE");
  }
}
