/** Run against tests/browser/creation_server.py; no real model calls. */
import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  const health = await (
    await page.request.get(base + "/api/creation-test-health", {
      headers: { "X-OpenDirector-Request": "1" },
    })
  ).json();
  assert.equal(health.isolated, true);
  {
    const unified = true;
    const mode = "";
    const bootstrap = (url) =>
      url.origin === new URL(base).origin && url.pathname === "/";
    await page.route(bootstrap, (route) =>
      route.fulfill({ contentType: "text/html", body: "<html></html>" }),
    );
    await page.goto(base + "/" + mode);
    const fixture = await page.evaluate(async () => {
      const { request, json } = await import("/src/backend/api.ts");
      const { createDocument, createNode } =
        await import("/src/canvas/model.ts");
      const { importWorkspaceDocument } =
        await import("/src/backend/workspace.ts");
      const { releaseBackendProject } =
        await import("/src/backend/projects.ts");
      const models = await request("/model-configs");
      const config =
        models.find((model) => model.modelId === "Video-reconnect-fixture") ??
        (await request(
          "/model-configs",
          json("POST", {
            kind: "video",
            modelId: "Video-reconnect-fixture",
            url: "http://127.0.0.1:12345/v1",
            apiKey: "",
            connectionType: "self_hosted",
            protocol: "vllm_omni",
            authMode: "none",
            videoAdapter: "fasth3",
          }),
        ));
      const image = document.createElement("canvas");
      image.width = 96;
      image.height = 64;
      const context = image.getContext("2d");
      context.fillStyle = "blue";
      context.fillRect(0, 0, 96, 64);
      const source = createNode(
        "image",
        { x: 150, y: 160 },
        {
          title: "Source",
          mediaRole: "asset",
          assetState: "ready",
          src: image.toDataURL(),
          mimeType: "image/png",
          media: { width: 96, height: 64 },
        },
      );
      const target = createNode(
        "video",
        { x: 800, y: 160 },
        {
          title: "Target",
          prompt: "Create a video",
          settings: {
            mode: "video",
            model: config.modelId,
            modelConfigId: config.id,
            aspectRatio: "16:9",
            durationSeconds: 5,
            resolution: "480P",
            videoMode: "reference",
            prompt: "",
            count: 1,
          },
        },
      );
      const saved = await importWorkspaceDocument({
        ...createDocument("Reconnect " + crypto.randomUUID().slice(0, 8)),
        nodes: [source, target],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 0.8 },
      });
      (await import("/src/backend/creationClient.ts"))
        .creationClient(saved.id)
        .close();
      await releaseBackendProject();
      return { id: saved.id, source: source.id, target: target.id };
    });
    await page.unroute(bootstrap);
    await page.goto(`${base}/ai-tool/ai-canvas/${fixture.id}${mode}`);
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    const source = page.locator(
      `.react-flow__node[data-id="${fixture.source}"]`,
    );
    const target = page.locator(
      `.react-flow__node[data-id="${fixture.target}"]`,
    );
    const connect = async (steps = 15) => {
      const sourceBox = await source.boundingBox(),
        targetBox = await target.boundingBox();
      assert.ok(sourceBox && targetBox);
      await page.mouse.move(
        sourceBox.x + sourceBox.width + 7,
        sourceBox.y + sourceBox.height / 2,
      );
      const port = page.getByRole("button", {
        name: "添加下游参考节点",
        exact: true,
      });
      await port.waitFor();
      const box = await port.boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        targetBox.x + targetBox.width / 2,
        targetBox.y + targetBox.height / 2,
        { steps },
      );
      await page.mouse.up();
    };
    const waitEdge = (count) =>
      page.waitForFunction(
        (n) => document.querySelectorAll(".react-flow__edge").length === n,
        count,
      );
    const get = async (path) => {
      const response = await page.request.get(base + "/api/" + path, {
        headers: { "X-OpenDirector-Request": "1" },
      });
      assert.ok(response.ok(), await response.text());
      return response.json();
    };
    const snapshot = () => get(`creation/projects/${fixture.id}`);
    const savedEdges = async () =>
      (await snapshot()).references.filter((ref) => ref.active);
    const until = async (read, predicate, label) => {
      for (let i = 0; i < 150; i++) {
        const value = await read();
        if (predicate(value)) return value;
        await page.waitForTimeout(100);
      }
      throw new Error(`${mode || "workspace"}: timeout waiting for ${label}`);
    };
    await connect();
    await waitEdge(1);
    const firstRefs = await until(
      savedEdges,
      (edges) => edges.length === 1,
      "initial reference",
    );
    // A second attempt on an existing connection must explain the rejection.
    await connect();
    await page.getByText("已经连接过", { exact: true }).waitFor();
    assert.equal(await page.locator(".react-flow__edge").count(), 1);
    await target.locator(".cw-node-title").click();
    await page.getByRole("button", { name: "提交生成", exact: true }).click();
    let state = await until(
      snapshot,
      (value) => value.jobs.some((task) => task.status === "succeeded"),
      "first generation",
    );
    const firstTask = state.jobs.find((task) => task.status === "succeeded");
    const sourceAssetId = state.canvasItems.find(
      (item) => item.id === fixture.source,
    ).binding.objectRef.assetId;
    assert.equal(
      firstTask.inputSnapshot.references[0].asset.assetId,
      sourceAssetId,
    );
    // Wait until the completed result is actually projected before editing it.
    await target.locator("video").waitFor();
    {
      const revision = state.canvasItems.find(
        (item) => item.id === fixture.target,
      ).revision;
      await page.waitForFunction(
        async ({ id, target, revision }) => {
          const { workspaceProjection } =
            await import("/src/backend/workspace.ts");
          return (
            workspaceProjection(id).basis?.canvasItems.find(
              (item) => item.id === target,
            )?.revision >= revision
          );
        },
        { id: fixture.id, target: fixture.target, revision },
      );
    }
    // Reconnect immediately, including before the next autosave can settle.
    await page
      .locator(".react-flow__edge-interaction")
      .first()
      .click({ force: true });
    await page.keyboard.press("Backspace");
    await waitEdge(0);
    await connect(3);
    await waitEdge(1);
    const rapidRefs = await until(
      savedEdges,
      (edges) => edges.length === 1 && edges[0].id !== firstRefs[0].id,
      "immediate reconnection",
    );
    await page
      .locator(".react-flow__edge-interaction")
      .first()
      .click({ force: true });
    await page.keyboard.press("Backspace");
    await waitEdge(0);
    await until(savedEdges, (edges) => edges.length === 0, "reference removal");
    await page.reload();
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    await waitEdge(0);
    await connect();
    await waitEdge(1);
    const secondRefs = await until(
      savedEdges,
      (edges) => edges.length === 1,
      "reconnection",
    );
    assert.notEqual(secondRefs[0].id, rapidRefs[0].id);
    await target.locator(".cw-node-title").click();
    await page.getByRole("button", { name: "提交生成", exact: true }).click();
    state = await until(
      snapshot,
      (value) =>
        value.jobs.filter((task) => task.status === "succeeded").length === 2,
      "generation after reconnection",
    );
    const secondTask = state.jobs.find((task) => task.id !== firstTask.id);
    {
      assert.equal(
        secondTask.inputSnapshot.references[0].asset.assetId,
        sourceAssetId,
      );
      assert.equal(
        secondTask.inputSnapshot.references[0].referenceId,
        secondRefs[0].id,
      );
      assert.deepEqual(
        state.jobs.find((job) => job.id === firstTask.id).inputSnapshot,
        firstTask.inputSnapshot,
      );
    }
    console.log(
      JSON.stringify({
        mode: "unified",
        passed: true,
        sourceAssetId,
      }),
    );
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
