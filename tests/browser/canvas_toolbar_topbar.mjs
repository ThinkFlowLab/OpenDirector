/** #513: a selected node's toolbar must never cover the top bar's project switcher.
 * Real pointer input only: drag near the top, manual pan and several zoom levels. */
import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const headers = { "X-OpenDirector-Request": "1" };
const health = await fetch(`${base}/api/creation-test-health`, { headers });
assert.ok(health.ok && (await health.json()).isolated, "Requires an isolated creation API");

const copy = {
  "en-US": { picker: "Switch project", presets: "Presets" },
  "zh-CN": { picker: "切换项目", presets: "预设" },
};

async function seed(browser, zoom) {
  const page = await browser.newPage({ locale: "en-US" });
  await page.route((url) => url.pathname === "/", (route) =>
    route.fulfill({ contentType: "text/html", body: "<html><body></body></html>" }));
  await page.goto(`${base}/`);
  const fixture = await page.evaluate(async (zoom) => {
    const { createDocument, createNode } = await import("/src/canvas/model.ts");
    const { importWorkspaceDocument } = await import("/src/backend/workspace.ts");
    const { releaseBackendProject } = await import("/src/backend/projects.ts");
    const { creationClient } = await import("/src/backend/creationClient.ts");
    const picture = (hue) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 96;
      const context = canvas.getContext("2d");
      context.fillStyle = `hsl(${hue},60%,45%)`;
      context.fillRect(0, 0, 96, 96);
      return canvas.toDataURL("image/png");
    };
    const image = (title, x, hue) => createNode("image", { x, y: 80 }, {
      title, mediaRole: "asset", src: picture(hue), mimeType: "image/png", assetState: "ready",
    });
    const suffix = crypto.randomUUID().slice(0, 8);
    const first = createDocument(`Toolbar A ${suffix}`);
    // The same top-left placement as canvas_progressive_load's Delayed node.
    const top = image("Top", 40, 20);
    const second = image("Second", 460, 120);
    first.nodes = [top, second];
    const other = createDocument(`Toolbar B ${suffix}`);
    other.nodes = [image("Other", 40, 220)];
    const a = await importWorkspaceDocument(first);
    await creationClient(a.id).view({ viewport: { x: 0, y: 0, zoom } });
    const b = await importWorkspaceDocument(other);
    await releaseBackendProject();
    return {
      viewClientId: sessionStorage.getItem("opendirector.creation.viewClientId"),
      a: { id: a.id, name: a.title }, b: { id: b.id, name: b.title }, top: top.id, second: second.id,
    };
  }, zoom);
  await page.close();
  return fixture;
}

async function verify(browser, locale, zoom) {
  const text = copy[locale];
  const fixture = await seed(browser, zoom);
  const context = await browser.newContext({ locale, viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((id) => {
    localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
    sessionStorage.setItem("opendirector.creation.viewClientId", id);
  }, fixture.viewClientId);
  const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
  const picker = page.getByRole("button", { name: text.picker, exact: true });
  const toolbar = page.locator(".cw-node-toolbar-anchor");
  const transform = () => page.locator(".react-flow__viewport").evaluate((element) => element.style.transform);
  // What a real pointer at the switcher's center would hit.
  const switcherHit = () => page.evaluate(() => {
    const switcher = document.querySelector(".cw-project-chevron");
    const box = switcher.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return switcher.contains(hit) ? "switcher" : hit?.closest("[aria-label]")?.getAttribute("aria-label") ?? hit?.className;
  });
  // The viewport must hold still over several frames, not jump or oscillate.
  const steadyViewport = () => page.evaluate(() => new Promise((resolve) => {
    const seen = new Set();
    const started = performance.now();
    const frame = () => {
      seen.add(document.querySelector(".react-flow__viewport").style.transform);
      if (performance.now() - started < 400) requestAnimationFrame(frame);
      else resolve([...seen]);
    };
    requestAnimationFrame(frame);
  }));
  const expectClear = async (label) => {
    const [bar, topbar] = [await toolbar.boundingBox(), await page.locator(".cw-topbar").boundingBox()];
    assert.ok(bar && topbar, `${label}: toolbar and top bar are rendered`);
    // Every global control lives in the top bar, not only the switcher.
    assert.ok(bar.y >= topbar.y + topbar.height,
      `${label}: toolbar top ${bar.y} must stay below the top bar (bottom ${topbar.y + topbar.height})`);
    assert.equal(await switcherHit(), "switcher", `${label}: the switcher receives the pointer`);
  };
  const openAndCloseMenu = async (label) => {
    // A real click with Playwright's actionability checks (no force).
    await picker.click({ timeout: 5000 });
    await page.getByRole("menuitemradio", { name: fixture.b.name, exact: true }).waitFor();
    assert.equal(await picker.getAttribute("aria-expanded"), "true", `${label}: project menu opens`);
    await page.keyboard.press("Escape");
    await page.getByRole("menuitemradio", { name: fixture.b.name, exact: true }).waitFor({ state: "detached" });
  };

  await page.goto(`${base}/ai-tool/ai-canvas/${fixture.a.id}`);
  await page.waitForFunction(() => {
    const element = document.querySelector(".cw-workspace");
    return element?.getAttribute("aria-busy") === "false" && !element.inert;
  });
  await node(fixture.top).locator("img").waitFor();
  await node(fixture.second).locator("img").waitFor();

  // 1. Drag an unselected node near the top; release; touch nothing else.
  const box = await node(fixture.top).boundingBox();
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const beforeDrag = await transform();
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 30, start.y + 24, { steps: 5 });
  await page.mouse.up();
  await toolbar.locator("button").first().waitFor();
  assert.match(await node(fixture.top).getAttribute("class"), /\bselected\b/, "The dragged node stays selected");
  await expectClear("after drag");
  assert.deepEqual(await steadyViewport(), [beforeDrag], "Releasing a drag does not move the viewport");
  await openAndCloseMenu("after drag");
  assert.match(await node(fixture.top).getAttribute("class"), /\bselected\b/, "Opening the menu keeps the selection");

  // 2. The toolbar still works: a real click on one of its menus.
  const presets = toolbar.getByRole("button", { name: text.presets, exact: true });
  await presets.click({ timeout: 5000 });
  assert.equal(await presets.getAttribute("aria-expanded"), "true", "Toolbar controls remain operable");
  await page.keyboard.press("Escape");
  await expectClear("after toolbar use");

  // 3. Drag a second node, then pan the canvas upward by hand (user navigation is respected).
  const secondBox = await node(fixture.second).boundingBox();
  await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(secondBox.x + secondBox.width / 2 - 20, secondBox.y + secondBox.height / 2 + 10, { steps: 5 });
  await page.mouse.up();
  assert.match(await node(fixture.second).getAttribute("class"), /\bselected\b/);
  await expectClear("after second drag");
  await page.mouse.move(750, 700);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(750, 640, { steps: 6 });
  await page.mouse.up({ button: "middle" });
  const afterPan = await transform();
  assert.notEqual(afterPan, beforeDrag, "The manual pan moved the canvas");
  assert.deepEqual(await steadyViewport(), [afterPan], "The pan is not undone by automatic fitting");
  await expectClear("after manual pan");

  // 4. Switching away and back restores the canvas.
  await picker.click({ timeout: 5000 });
  await page.getByRole("menuitemradio", { name: fixture.b.name, exact: true }).click();
  await page.locator(".cw-project-name").getByText(fixture.b.name, { exact: true }).waitFor();
  await picker.click({ timeout: 5000 });
  await page.getByRole("menuitemradio", { name: fixture.a.name, exact: true }).click();
  await page.locator(".cw-project-name").getByText(fixture.a.name, { exact: true }).waitFor();
  await node(fixture.top).locator("img").waitFor();
  await node(fixture.second).locator("img").waitFor();
  assert.deepEqual(errors, []);
  await context.close();
}

const browser = await launchBrowser();
try {
  for (const [locale, zoom] of [["en-US", 1], ["zh-CN", 1], ["en-US", 0.5], ["zh-CN", 1.5]]) {
    await verify(browser, locale, zoom);
    console.log(`canvas toolbar topbar: ${locale} zoom ${zoom} ok`);
  }
} finally {
  await browser.close();
}
