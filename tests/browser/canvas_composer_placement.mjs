/** Verify the real canvas and composer share coordinates with the Windows chrome. */
import assert from "node:assert/strict";
import { launchBrowser } from "./engine.mjs";

const base = process.env.CREATION_WEB_URL ?? "http://127.0.0.1:5179";
const api = process.env.CREATION_API_URL ?? "http://127.0.0.1:8019";
const headers = { "X-OpenDirector-Request": "1", "Content-Type": "application/json" };

async function call(path, body, session) {
  const response = await fetch(api + path, {
    headers: { ...headers, ...(session ? { "X-OpenDirector-Session": session } : {}) },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}

assert.equal((await call("/api/creation-test-health")).isolated, true);
const browser = await launchBrowser();
try {
  for (const desktop of [false, true]) {
    const projectId = crypto.randomUUID();
    const path = `/api/creation/projects/${projectId}`;
    const command = (type, payload, session) => call(`${path}/commands`, {
      commandId: crypto.randomUUID(), projectId, type, payload,
    }, session);
    await command("project.create", { name: `Composer placement ${projectId}` });
    const page = await browser.newPage({
      viewport: { width: 1400, height: 880 },
      deviceScaleFactor: desktop ? 1.5 : 1,
    });
    try {
      page.setDefaultTimeout(10000);
      await page.addInitScript((desktop) => {
        localStorage.setItem("opendirector.locale.v1", desktop ? "zh-CN" : "en-US");
        localStorage.setItem("opendirector.modelSetup.v1", "dismissed");
        if (desktop) {
          window.opendirectorDesktop = { registerSession() {}, setLocale() {} };
          const markDesktop = () => {
            document.documentElement.dataset.desktopPlatform = "win32";
            document.documentElement.dataset.desktopChrome = "";
          };
          if (document.documentElement) markDesktop();
          else window.addEventListener("DOMContentLoaded", markDesktop, { once: true });
        }
      }, desktop);
      await page.goto(`${base}/ai-tool/ai-canvas/${projectId}?creation=unified`);
      await page.getByText(desktop ? "已保存到本机" : "Saved on this device", { exact: true }).waitFor();
      const canvasTop = await page.locator(".cw-workspace .react-flow").evaluate((canvas) =>
        canvas.getBoundingClientRect().top - canvas.closest(".cw-workspace").getBoundingClientRect().top,
      );
      assert.equal(canvasTop, desktop ? 48 : 0);
      const session = await page.evaluate(async () => (await import("/src/backend/api.ts")).sessionId);
      const positions = { image: { x: 300, y: 220 }, video: { x: 940, y: 220 } };
      const checkPlacement = (id) => page.waitForFunction((id) => {
        const node = document.querySelector(`.react-flow__node.selected[data-id="${id}"]`);
        const dock = document.querySelector('.cw-composer-dock[data-expanded="false"][data-interacting="false"]');
        const canvas = document.querySelector(".cw-workspace .react-flow");
        if (!node || !dock || !canvas) return false;
        const media = node.getBoundingClientRect(), panel = dock.getBoundingClientRect();
        const usable = canvas.getBoundingClientRect();
        return Math.abs(panel.top - media.bottom - 16) < 1 &&
          panel.left >= usable.left && panel.right <= innerWidth &&
          panel.bottom <= innerHeight && panel.height > 0;
      }, id, { timeout: 8000 });
      for (const kind of ["image", "video"]) {
        const id = crypto.randomUUID();
        const receipt = await command("canvas.show", {
          item: { id, projectId, kind, position: positions[kind],
            width: 420, height: 280, title: `Layout ${kind}`, binding: { role: "empty" } },
        }, session);
        assert.equal(receipt.status, "applied");
        await page.locator(`.react-flow__node[data-id="${id}"] .cw-node-placeholder`).click({ position: { x: 8, y: 8 } });
        await checkPlacement(id);
        if (desktop && kind === "video") {
          await page.locator('button[aria-controls="od-project-sidebar"]').click();
          await page.waitForFunction(() => document.querySelector(".cw-workspace .react-flow").getBoundingClientRect().left > 200);
          await checkPlacement(id);
          await page.setViewportSize({ width: 1000, height: 680 });
          await checkPlacement(id);
        }
      }
      const snapshot = await call(path);
      assert.equal(snapshot.canvasItems.length, 2);
      for (const item of snapshot.canvasItems) assert.deepEqual(item.position, positions[item.kind]);
    } finally {
      await page.close();
    }
  }
  console.log("Canvas composer stays below the selected image or video in web and Windows chrome");
} finally {
  await browser.close();
}
