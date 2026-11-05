/** Tool placeholder/regression loop against the isolated fixture API.
 * Covers both project formats; all generation is simulated, with real files.
 */
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright-core"
);
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
// Skip the first-run model setup welcome; it covers the canvas.
await page.addInitScript(() =>
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
);
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const headers = { "X-OpenDirector-Request": "1" };
const json = async (response) => {
  assert.ok(response.ok(), await response.text());
  return response.json();
};
const until = async (read, predicate, label) => {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await page.waitForTimeout(100);
  }
  throw new Error("Timeout: " + label);
};
try {
  assert.equal(
    (
      await json(
        await page.request.get(base + "/api/creation-test-health", { headers }),
      )
    ).isolated,
    true,
  );
  // The legacy /api/projects workspace routes were removed; only the unified
  // creation project remains to verify.
  for (const unified of [true].filter(
    (value) =>
      !process.env.TOOL_PLACEHOLDER_MODE ||
      (value ? "unified" : "workspace") === process.env.TOOL_PLACEHOLDER_MODE,
  )) {
    const mode = unified ? "?creation=unified" : "";
    const api = unified ? "/api/creation" : "/api";
    const bootstrap = (url) =>
      url.origin === new URL(base).origin && url.pathname === "/";
    await page.route(bootstrap, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><head></head><body></body></html>",
      }),
    );
    await page.goto(base + "/" + mode);
    const fixture = await page.evaluate(async (unified) => {
      const { createDocument, createNode } =
        await import("/src/canvas/model.ts");
      const { importWorkspaceDocument } =
        await import("/src/backend/workspace.ts");
      const { releaseBackendProject } =
        await import("/src/backend/projects.ts");
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 48;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "blue";
      ctx.fillRect(0, 0, 64, 48);
      const source = createNode(
        "image",
        { x: 350, y: 250 },
        {
          title: "Tool source",
          src: canvas.toDataURL(),
          mimeType: "image/png",
          assetState: "ready",
          mediaRole: "asset",
        },
      );
      const value = {
        ...createDocument("Tool history " + crypto.randomUUID().slice(0, 8)),
        nodes: [source],
        viewport: { x: 0, y: 0, zoom: 0.8 },
      };
      const saved = await importWorkspaceDocument(value);
      if (unified)
        (await import("/src/backend/creationClient.ts"))
          .creationClient(saved.id)
          .close();
      await releaseBackendProject();
      return { id: saved.id, sourceId: source.id, name: saved.title };
    }, unified);
    await page.unroute(bootstrap);
    const url = `${base}/ai-tool/ai-canvas/${fixture.id}${mode}`;
    const tasks = async () =>
      (
        await json(
          await page.request.get(
            `${base}${api}/projects/${fixture.id}/tool-tasks`,
            { headers },
          ),
        )
      ).tasks;
    const gate = (open, outcome = "succeeded") =>
      page.request.post(base + "/api/creation-test-tool-gate", {
        headers,
        data: { open, outcome },
      });
    const source = () =>
      page.locator(`.react-flow__node[data-id="${fixture.sourceId}"]`);
    const load = async (hasSource = true) => {
      await page.goto(url);
      await page.getByText("已保存到本机", { exact: true }).waitFor();
      if (hasSource) await source().waitFor();
    };
    await load();
    const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
    const cases = [
      "success",
      "cancel",
      "failure",
      "multiple",
      "target-upload",
      "target-prompt",
      "target-lock",
      "target-hide",
      "source-replace",
      "source-delete",
    ];
    for (const action of cases.filter(
      (value) =>
        !process.env.TOOL_PLACEHOLDER_CASES ||
        process.env.TOOL_PLACEHOLDER_CASES.split(",").includes(value),
    )) {
      await load();
      const prior = await tasks();
      const before = await page.locator(".react-flow__node").count();
      const outcome =
        action === "failure"
          ? "failed"
          : action === "multiple"
            ? "multiple"
            : "succeeded";
      await gate(false, outcome);
      await page.locator(".cw-workspace").focus();
      await page.keyboard.press("Shift+1");
      await page.waitForTimeout(300);
      const rect = await source().boundingBox();
      await source().click({
        position: { x: rect.width * 0.4, y: rect.height * 0.4 },
      });
      await page.getByRole("button", { name: "扩图", exact: true }).click();
      await page.locator(".iae-generate").click();
      const accepted = await until(
        tasks,
        (rows) =>
          rows.length === prior.length + 1 &&
          rows.some((row) => row.status === "running"),
        "tool accepted",
      );
      const task = accepted.find(
        (row) => !prior.some((old) => old.id === row.id),
      );
      const targetId = task.canvas.targetNodeId;
      assert.ok(targetId);
      assert.equal(
        task.canvas.nodeId,
        fixture.sourceId,
        "source ownership remains separate",
      );
      assert.notEqual(targetId, task.id);
      await node(targetId).locator(".cw-generating").waitFor();
      assert.equal(await source().locator(".cw-generating").count(), 0);
      await node(targetId).locator(".cw-generating-ring-progress").waitFor();
      assert.equal(await page.locator(".react-flow__node").count(), before + 1);
      // Compare accepted execution on both sides of reload. The local upload
      // preparation row can still be visible just after the server accepts it.
      await page.waitForFunction(
        ({ targetId, createdAt }) =>
          document
            .querySelector(
              `.react-flow__node[data-id="${targetId}"] .cw-generating`,
            )
            ?.getAttribute("data-started-at") === String(Date.parse(createdAt)),
        { targetId, createdAt: task.createdAt },
      );
      const expectedMs = await node(targetId)
        .locator(".cw-generating")
        .getAttribute("data-expected-ms");
      const start = await node(targetId)
        .locator(".cw-generating-ring-progress")
        .getAttribute("stroke-dashoffset");
      await load();
      await node(targetId).locator(".cw-generating-ring-progress").waitFor();
      assert.equal(await page.locator(".react-flow__node").count(), before + 1);
      const restored = await node(targetId)
        .locator(".cw-generating-ring-progress")
        .getAttribute("stroke-dashoffset");
      assert.equal(
        await node(targetId)
          .locator(".cw-generating")
          .getAttribute("data-started-at"),
        String(Date.parse(task.createdAt)),
      );
      assert.equal(
        await node(targetId)
          .locator(".cw-generating")
          .getAttribute("data-expected-ms"),
        expectedMs,
      );
      assert.ok(
        Number(restored) <= Number(start) + 0.1,
        "refresh retains the server start time",
      );
      await page
        .locator('.cw-reference-edge[data-reference-state="provenance"]')
        .first()
        .waitFor({ state: "attached" });

      if (action === "cancel") {
        const r = await node(targetId).boundingBox();
        await node(targetId).click({
          position: { x: r.width * 0.4, y: r.height * 0.4 },
        });
        await page
          .getByRole("button", { name: "取消生成", exact: true })
          .click();
      } else {
        if (action.startsWith("target-") || action.startsWith("source-")) {
          // Edit from an isolated page so the mounted canvas cannot auto-save
          // an older snapshot over the public API mutation used by this fixture.
          await page.route(bootstrap, (route) =>
            route.fulfill({
              contentType: "text/html",
              body: "<!doctype html><html><body></body></html>",
            }),
          );
          await page.goto(base + "/" + mode, { waitUntil: "networkidle" });
          await page.evaluate(
            async ({ fixture, targetId, action }) => {
              const { readWorkspaceDocument, saveWorkspaceDocument } =
                await import("/src/backend/workspace.ts");
              await (
                await import("/src/backend/projects.ts")
              ).openBackendProject(fixture.id, fixture.name);
              const current = await readWorkspaceDocument({
                id: fixture.id,
                name: fixture.name,
              });
              const canvas = document.createElement("canvas");
              canvas.width = 64;
              canvas.height = 48;
              const ctx = canvas.getContext("2d");
              ctx.fillStyle = "red";
              ctx.fillRect(0, 0, 64, 48);
              const affected = action.startsWith("target-")
                ? targetId
                : fixture.sourceId;
              const removing =
                action === "target-hide" || action === "source-delete";
              const nodes = current.nodes.flatMap((node) => {
                if (node.id !== affected) return [node];
                if (removing) return [];
                if (action === "target-lock")
                  return [{ ...node, locked: true }];
                if (action === "target-prompt")
                  return [
                    {
                      ...node,
                      data: { ...node.data, prompt: "Keep my prompt" },
                    },
                  ];
                return [
                  {
                    ...node,
                    data: {
                      ...node.data,
                      src: canvas.toDataURL(),
                      mimeType: "image/png",
                      assetState: "ready",
                    },
                  },
                ];
              });
              await saveWorkspaceDocument({
                ...current,
                nodes,
                edges: removing
                  ? current.edges.filter(
                      (edge) =>
                        edge.source !== affected && edge.target !== affected,
                    )
                  : current.edges,
              });
            },
            { fixture, targetId, action },
          );
          await page.unroute(bootstrap);
          await load(action !== "source-delete");
        }
        await gate(true, outcome);
      }

      const success = ["success", "multiple"].includes(action);
      const terminal = action === "cancel" || action === "failure";
      const expected =
        action === "cancel"
          ? "cancelled"
          : action === "failure"
            ? "failed"
            : "succeeded";
      const final = (
        await until(
          tasks,
          (rows) =>
            rows.find((row) => row.id === task.id)?.status === expected &&
            (terminal ||
              rows.find((row) => row.id === task.id)?.placement ===
                (success ? "placed" : "unplaced")),
          "terminal placement",
        )
      ).find((row) => row.id === task.id);
      if (success) {
        assert.equal(final.outputs[0].canvasItemId, targetId);
        await node(targetId).locator("img").waitFor();
        const count = before + (action === "multiple" ? 2 : 1);
        await page.waitForFunction(
          (count) =>
            document.querySelectorAll(".react-flow__node").length === count,
          count,
        );
        await load();
        await page.waitForTimeout(2200);
        assert.equal(
          await page.locator(".react-flow__node").count(),
          count,
          "reload never repeats output placement",
        );
        assert.equal(
          (await tasks()).filter((row) => row.id === task.id).length,
          1,
        );
      } else {
        const preserveTarget = [
          "target-upload",
          "target-prompt",
          "target-lock",
        ].includes(action);
        const expectedCount =
          before +
          (preserveTarget ? 1 : 0) -
          (action === "source-delete" ? 1 : 0);
        await page.waitForFunction(
          (count) =>
            document.querySelectorAll(".react-flow__node").length === count,
          expectedCount,
        );
        if (preserveTarget) {
          await page.evaluate(
            async ({ fixture, targetId, action }) => {
              const { readWorkspaceDocument } =
                await import("/src/backend/workspace.ts");
              const current = await readWorkspaceDocument({
                id: fixture.id,
                name: fixture.name,
              });
              const node = current.nodes.find((node) => node.id === targetId);
              if (
                action === "target-prompt" &&
                node?.data.prompt !== "Keep my prompt"
              )
                throw new Error("Prompt was overwritten");
              if (action === "target-lock" && (!node?.locked || node.data.src))
                throw new Error("Locked target was overwritten");
              if (action === "target-upload" && !node?.data.src)
                throw new Error("Manual upload lost");
            },
            { fixture, targetId, action },
          );
        }
        if (!terminal) {
          await page
            .getByRole("button", { name: "生成历史", exact: true })
            .click();
          await page
            .locator(".cw-history-entry")
            .filter({ hasText: "来源已变化" })
            .getByRole("button", { name: "重新放置结果", exact: true })
            .click();
          await until(
            tasks,
            (rows) =>
              rows.find((row) => row.id === task.id)?.placement === "placed",
            "manual restore",
          );
          assert.equal(
            await page.locator(".react-flow__node").count(),
            expectedCount + 1,
          );
        }
      }
      console.log(
        `PASS ${unified ? "unified" : "workspace"}: ${action}; stable target, progress restoration, safe placement and cleanup.`,
      );
    }
    await page.evaluate(async () => {
      await (await import("/src/backend/projects.ts")).releaseBackendProject();
    });
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS both project formats: placeholder identity, recovery, cancellation, failure, multiple outputs, user edits, hidden targets and stale sources. No model calls.",
  );
} catch (error) {
  await page.screenshot({
    path: "/tmp/opendirector-tool-placeholder-failure.png",
  });
  console.error((await page.locator("body").innerText()).slice(-2400));
  console.error(errors);
  throw error;
} finally {
  await page.request
    .post(base + "/api/creation-test-tool-gate", {
      headers,
      data: { open: true, outcome: "succeeded" },
    })
    .catch(() => {});
  await browser.close();
}
