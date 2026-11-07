/** Isolated fixture + Vite: selection geometry and real batch reference writes. */
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
});
try {
  const page = await browser.newPage({
    locale: "zh-CN",
    viewport: { width: 1800, height: 1100 },
  });
  // Skip the first-run model setup welcome; it covers the canvas.
  await page.addInitScript(() =>
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
  );
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  assert.equal(
    (
      await (
        await page.request.get(base + "/api/creation-test-health", {
          headers: { "X-OpenDirector-Request": "1" },
        })
      ).json()
    ).isolated,
    true,
  );
  const bootstrap = (url) =>
    url.origin === new URL(base).origin && url.pathname === "/";
  await page.route(bootstrap, (route) =>
    route.fulfill({ contentType: "text/html", body: "<html></html>" }),
  );
  await page.goto(base);
  const f = await page.evaluate(async (vertical) => {
    const { createDocument, createNode } = await import("/src/canvas/model.ts");
    const { importWorkspaceDocument } =
      await import("/src/backend/workspace.ts");
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 120;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#8766b6";
    ctx.fillRect(0, 0, 160, 120);
    const sources = [0, 1, 2].map((i) => {
      const node = createNode(
        "image",
        {
          x: vertical ? 130 : 130 + i * 280,
          y: vertical ? 160 + i * 240 : 240,
        },
        {
          title: `参考图片 ${i + 1}`,
          src: canvas.toDataURL(),
          mediaRole: "asset",
          assetState: "ready",
          mimeType: "image/png",
          media: { width: 160, height: 120 },
        },
      );
      node.width = 220;
      node.height = 165;
      return node;
    });
    const target = createNode(
      "video",
      { x: 1100, y: vertical ? 400 : 240 },
      { title: "批量参考目标", settings: { videoMode: "reference" } },
    );
    target.width = 240;
    target.height = 180;
    const saved = await importWorkspaceDocument({
      ...createDocument("Multi-selection reference fixture"),
      nodes: [...sources, target],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    });
    (await import("/src/backend/creationClient.ts"))
      .creationClient(saved.id)
      .close();
    await (await import("/src/backend/projects.ts")).releaseBackendProject();
    return {
      id: saved.id,
      sources: sources.map((node) => node.id),
      target: target.id,
    };
  }, process.env.MULTI_SELECTION_LAYOUT === "vertical");
  await page.unroute(bootstrap);
  await page.goto(`${base}/ai-tool/ai-canvas/${f.id}`);
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
  const plus = page.getByRole("button", {
    name: "批量连接所选节点",
    exact: true,
  });
  const select = async () => {
    await node(f.sources[0]).click({ position: { x: 40, y: 55 } });
    await page.keyboard.down("Control");
    try {
      for (const id of f.sources.slice(1))
        await node(id).click({ position: { x: 40, y: 55 } });
    } finally {
      await page.keyboard.up("Control");
    }
    await plus.waitFor();
  };
  const state = () =>
    page.evaluate(async (id) => {
      const { creationClient } = await import("/src/backend/creationClient.ts");
      return creationClient(id).snapshot;
    }, f.id);
  const until = async (predicate) => {
    const deadline = Date.now() + 10000;
    do {
      const snapshot = await state();
      if (predicate(snapshot)) return snapshot;
      await page.waitForTimeout(80);
    } while (Date.now() < deadline);
    console.error(
      JSON.stringify({
        errors,
        snapshot: (await state()).references,
        notices: await page
          .locator(".cw-toast,.cw-save-status")
          .allTextContents(),
      }),
    );
    await page.screenshot({
      path: ".opendirector/multi-selection-failure.png",
    });
    throw new Error("Project acknowledgement timed out");
  };
  await select();
  const geometry = async () => {
    const frame = await page.locator(".cw-multi-selection-frame").boundingBox();
    assert.ok(frame);
    for (const id of f.sources) {
      const heading = await node(id).locator(".cw-node-heading").boundingBox();
      const media = await node(id).boundingBox();
      assert.ok(
        heading.y > frame.y && heading.x >= frame.x,
        JSON.stringify({ frame, heading }),
      );
      assert.ok(media.x + media.width < frame.x + frame.width + 1);
      assert.ok(media.y + media.height < frame.y + frame.height + 1);
    }
    const p = await plus.boundingBox();
    assert.ok(p.x > frame.x + frame.width);
    assert.ok(Math.abs(p.width - 20) < 0.5 && Math.abs(p.height - 20) < 0.5);
    return frame;
  };
  for (const percent of [60, 100, 150, 100]) {
    await page.getByRole("button", { name: "缩放选项", exact: true }).click();
    await page
      .getByRole("spinbutton", { name: "缩放百分比" })
      .fill(String(percent));
    await page.getByRole("button", { name: "缩放选项", exact: true }).click();
    await geometry();
  }
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const colors = await plus.evaluate((element) => {
      const css = getComputedStyle(element);
      return { background: css.backgroundColor, color: css.color };
    });
    assert.notEqual(colors.background, "rgba(0, 0, 0, 0)");
    assert.notEqual(colors.background, colors.color);
  }
  // The expanded padding remains part of native group dragging.
  const before = await state();
  const rect = await geometry();
  // A marquee activates XYFlow's native group-drag surface. The visible frame
  // also persists for modifier-click selection and after using the zoom menu.
  await page.mouse.move(rect.x - 5, rect.y - 5);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width + 5, rect.y + rect.height + 5, {
    steps: 12,
  });
  await page.mouse.up();
  await page.locator(".react-flow__nodesselection-rect").waitFor();
  await page.mouse.move(rect.x + 5, rect.y + rect.height - 5);
  await page.mouse.down();
  await page.mouse.move(rect.x + 45, rect.y + rect.height + 15, { steps: 8 });
  await page.mouse.up();
  await until((s) =>
    f.sources.every((id) => {
      const old = before.canvasItems.find((item) => item.id === id);
      const current = s.canvasItems.find((item) => item.id === id);
      return current.position.x > old.position.x + 20;
    }),
  );
  await geometry();
  const restBox = await plus.boundingBox();
  const rest = {
    x: restBox.x + restBox.width / 2,
    y: restBox.y + restBox.height / 2,
  };
  await page.mouse.move(rest.x + 24, rest.y + 8);
  await page.waitForFunction(({ x }) => {
    const rect = document
      .querySelector(".cw-selection-reference-port")
      .getBoundingClientRect();
    return rect.x + rect.width / 2 > x + 3;
  }, rest);
  const sticky = await plus.boundingBox();
  const stickyTravel = Math.hypot(
    sticky.x + sticky.width / 2 - rest.x,
    sticky.y + sticky.height / 2 - rest.y,
  );
  assert.ok(stickyTravel > 3 && stickyTravel <= 12.5);
  await page.mouse.move(rest.x + 100, rest.y + 100);
  await page.waitForFunction(({ x, y }) => {
    const rect = document
      .querySelector(".cw-selection-reference-port")
      .getBoundingClientRect();
    return (
      Math.abs(rect.x + rect.width / 2 - x) < 0.5 &&
      Math.abs(rect.y + rect.height / 2 - y) < 0.5
    );
  }, rest);
  await page.screenshot({
    path:
      process.env.MULTI_SELECTION_SCREENSHOT ??
      ".opendirector/multi-selection.png",
  });
  const p = await plus.boundingBox(),
    target = await node(f.target).boundingBox();
  await page.mouse.move(p.x + p.width / 2, p.y + p.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    target.x + target.width / 2,
    target.y + target.height / 2,
    { steps: 15 },
  );
  await page.locator(".cw-connection-preview").first().waitFor();
  const checkFan = async () => {
    const paths = await page
      .locator("[data-reference-preview-source]")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const path = element.querySelector(".cw-connection-preview");
          const start = path
            .getPointAtLength(0)
            .matrixTransform(path.getScreenCTM());
          const end = path
            .getPointAtLength(path.getTotalLength())
            .matrixTransform(path.getScreenCTM());
          const id = element.getAttribute("data-reference-preview-source");
          const rect = document
            .querySelector(`.react-flow__node[data-id="${id}"]`)
            .getBoundingClientRect();
          return {
            id,
            start: { x: start.x, y: start.y },
            end: { x: end.x, y: end.y },
            right: rect.right,
            middle: rect.y + rect.height / 2,
          };
        }),
      );
    assert.equal(paths.length, 3);
    assert.deepEqual(
      paths.map((item) => item.id).sort(),
      [...f.sources].sort(),
    );
    for (const path of paths) {
      assert.ok(
        Math.abs(path.start.x - path.right) < 1 &&
          Math.abs(path.start.y - path.middle) < 1,
      );
      assert.ok(
        Math.hypot(path.end.x - paths[0].end.x, path.end.y - paths[0].end.y) <
          1,
      );
    }
  };
  await checkFan();
  await page.screenshot({
    path:
      process.env.MULTI_SELECTION_FAN_SCREENSHOT ??
      ".opendirector/multi-selection-fan.png",
  });
  assert.equal(
    await page.evaluate(
      ({ x, y }) =>
        document
          .elementFromPoint(x, y)
          ?.closest(".react-flow__node")
          ?.getAttribute("data-id"),
      { x: target.x + target.width / 2, y: target.y + target.height / 2 },
    ),
    f.target,
  );
  await page.mouse.up();
  const connected = await until(
    (s) => s.references.filter((ref) => ref.active).length === 3,
  );
  assert.deepEqual(
    connected.references
      .filter((ref) => ref.active)
      .map((ref) => ref.source.id)
      .sort(),
    [...f.sources].sort(),
  );
  assert.equal(
    new Set(
      connected.references
        .filter((ref) => ref.active)
        .map((ref) => ref.targetSpecId),
    ).size,
    1,
  );
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await until((s) => !s.references.some((ref) => ref.active));
  await select();
  await plus.click();
  await checkFan();
  await page.getByRole("menuitem", { name: "视频", exact: true }).click();
  const created = await until(
    (s) =>
      s.canvasItems.length === 5 &&
      s.references.filter((ref) => ref.active).length === 3,
  );
  assert.deepEqual(
    created.references
      .filter((ref) => ref.active)
      .map((ref) => ref.source.id)
      .sort(),
    [...f.sources].sort(),
  );
  await page.reload();
  await page.getByText("已保存到本机", { exact: true }).waitFor();
  assert.equal(
    (await state()).references.filter((ref) => ref.active).length,
    3,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      isolated: true,
      headingsInside: true,
      zooms: [60, 100, 150],
      fixedSizePort: true,
      magneticPort: true,
      perSourceFanPreview: true,
      nativeGroupDrag: true,
      persistedBatch: true,
      atomicUndo: true,
      clickCreatesDownstream: true,
      reopened: true,
      errors,
    }),
  );
} finally {
  await browser.close();
}
