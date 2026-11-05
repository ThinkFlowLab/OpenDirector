/** Run against tests/browser/creation_server.py; exercise real canvas gestures. */
import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";
const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
// Skip the first-run model setup welcome; it covers the canvas.
await page.addInitScript(() =>
  localStorage.setItem("opendirector.modelSetup.v1", "dismissed"),
);
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
      const { createDocument, createNode } =
        await import("/src/canvas/model.ts");
      const { importWorkspaceDocument } =
        await import("/src/backend/workspace.ts");
      const { releaseBackendProject } =
        await import("/src/backend/projects.ts");
      const node = createNode(
        "text",
        { x: 200, y: 160 },
        { title: "Menu source", text: "content" },
      );
      const saved = await importWorkspaceDocument({
        ...createDocument("Menu " + crypto.randomUUID().slice(0, 8)),
        nodes: [node],
        viewport: { x: 0, y: 0, zoom: 0.8 },
      });
      (await import("/src/backend/creationClient.ts"))
        .creationClient(saved.id)
        .close();
      await releaseBackendProject();
      return { id: saved.id, node: node.id };
    });
    await page.unroute(bootstrap);
    await page.goto(`${base}/ai-tool/ai-canvas/${fixture.id}${mode}`);
    await page.getByText("已保存到本机", { exact: true }).waitFor();
    const node = page.locator(`.react-flow__node[data-id="${fixture.node}"]`);
    const menu = page.locator(".cw-context-menu");
    const openNodeMenu = async () => {
      await node.click({ button: "right" });
      await menu.waitFor();
    };
    await node.click();
    await page
      .getByRole("button", { name: "切换到抓手工具", exact: true })
      .click();
    await openNodeMenu();
    const before = await page
      .locator(".react-flow__viewport")
      .getAttribute("style");
    await page.mouse.move(1100, 750);
    await page.mouse.down();
    await menu.waitFor({ state: "detached" });
    await page.mouse.move(1170, 800, { steps: 10 });
    await page.mouse.up();
    assert.notEqual(
      await page.locator(".react-flow__viewport").getAttribute("style"),
      before,
    );
    assert.ok(
      (await node.getAttribute("class")).split(" ").includes("selected"),
    );
    await openNodeMenu();
    await page.mouse.click(1100, 750);
    await menu.waitFor({ state: "detached" });
    await openNodeMenu();
    const menuItem = menu.getByRole("menuitem").first();
    await menuItem.focus();
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    assert.ok(
      (await node.getAttribute("class")).split(" ").includes("selected"),
    );
    // The node composer stops pointerdown propagation; clicking it must still
    // dismiss the menu instead of leaving it stuck open over the canvas. The
    // menu can cover the composer, so send the pointerdown straight at it.
    await openNodeMenu();
    await page.evaluate(() => {
      const composer = document.querySelector(
        '[aria-label="文本生成提示词"]',
      );
      composer?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true }),
      );
    });
    await menu.waitFor({ state: "detached" });
    // Reference-port menu retains focus navigation and both dismissal methods.
    const openPortMenu = async () => {
      const box = await node.boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + box.width + 7, box.y + box.height / 2);
      await page
        .getByRole("button", { name: "添加下游参考节点", exact: true })
        .click();
      await page.locator(".cw-canvas-menu").waitFor();
    };
    await openPortMenu();
    const initial = await page.evaluate(
      () => document.activeElement?.textContent,
    );
    await page.keyboard.press("ArrowDown");
    assert.notEqual(
      await page.evaluate(() => document.activeElement?.textContent),
      initial,
    );
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    await openPortMenu();
    await page.mouse.click(1100, 750);
    await menu.waitFor({ state: "detached" });
    console.log(JSON.stringify({ mode: "unified", passed: true }));
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
