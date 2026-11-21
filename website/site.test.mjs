import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { launchBrowser } from "../tests/browser/engine.mjs";
import { renderDownloadPage } from "./build.mjs";

const url = process.env.WEBSITE_URL ?? "http://127.0.0.1:8780/OpenDirector/";
const browser = await launchBrowser();
try {
  const staticPage = await browser.newPage({ javaScriptEnabled: false, locale: "en-US" });
  await staticPage.goto(url);
  const links = await staticPage.locator(".hero details a[data-system]").all();
  const downloads = [];
  const notes = new Set();
  if (links.length) {
    await staticPage.locator(".hero summary").click();
    for (const link of links) {
      assert.ok(await link.isVisible());
      const href = await link.getAttribute("href");
      const asset = new URL(href);
      assert.equal(asset.origin, "https://github.com");
      const parts = asset.pathname.match(/^(.+\/releases)\/download\/([^/]+)\/.+\.(dmg|exe)$/);
      assert.ok(parts, href);
      assert.ok((await link.locator("small").innerText()).includes(decodeURIComponent(parts[2])));
      notes.add(`${asset.origin}${parts[1]}/tag/${parts[2]}`);
      downloads.push(href);
    }
  } else {
    assert.equal(await staticPage.locator(".hero summary").isVisible(), false);
    assert.equal(await staticPage.locator(".hero .actions > a").getAttribute("href"), "#install-heading");
  }
  const footnotes = await staticPage.locator(".footer a[href*='/releases/']").evaluateAll(anchors => anchors.map(a => a.href));
  assert.deepEqual(new Set(footnotes), notes);
  await staticPage.close();

  const page = await browser.newPage({ locale: "zh-CN", reducedMotion: "reduce" });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgentData", {
      value: { platform: "macOS", getHighEntropyValues: async () => ({ architecture: "x86", bitness: "64" }) },
    });
  });
  await page.goto(url);
  const menu = page.locator(".hero summary");
  if (downloads.length) {
    await menu.click();
    assert.equal(await menu.getAttribute("aria-label"), "下载 OpenDirector");
    assert.equal(await page.locator(".hero .actions > a").isVisible(), false);
    for (const downloadUrl of downloads) {
      assert.equal(await page.locator(`.hero details a[href="${downloadUrl}"]`).isVisible(), true);
    }
    await menu.press("Escape");
  } else {
    assert.equal(await page.locator(".hero .actions").getByRole("link").getAttribute("href"), "#install-heading");
  }
  await page.getByRole("button", { name: "EN", exact: true }).click();
  assert.equal(await page.locator("html").getAttribute("lang"), "en-US");

  await page.route("**/film/we-can-still-win.mp4", route => route.fulfill({ status: 404 }));
  const film = page.locator(".film-player video");
  const requestedFilm = page.waitForRequest("**/film/we-can-still-win.mp4");
  await page.getByRole("button", { name: /Bedtime/ }).click();
  await requestedFilm;
  await page.waitForFunction(() => document.querySelector(".film-player video").error !== null);
  assert.equal(await film.evaluate(video => video.paused), true);
  await page.close();

  const template = await readFile(new URL("index.html", import.meta.url), "utf8");
  const releases = {
    mac: {
      version: "v1.2.1-test.3", test: true,
      url: "https://github.com/example/test/releases/download/v1.2.1-test.3/preview.dmg",
      notes: "https://github.com/example/test/releases/tag/v1.2.1-test.3",
    },
    windows: {
      version: "v1.3.0", test: false,
      url: "https://github.com/example/official/releases/download/v1.3.0/installer.exe",
      notes: "https://github.com/example/official/releases/tag/v1.3.0",
    },
  };
  for (const [system, platform, architecture] of [["mac", "macOS", "arm"], ["windows", "Windows", "x86"]]) {
    const release = releases[system];
    const client = await browser.newPage({ locale: "zh-CN", reducedMotion: "reduce" });
    await client.addInitScript(({ platform, architecture }) => {
      Object.defineProperty(navigator, "userAgentData", {
        value: { platform, getHighEntropyValues: async () => ({ architecture, bitness: "64" }) },
      });
    }, { platform, architecture });
    await client.route(url, route => route.fulfill({ contentType: "text/html", body: renderDownloadPage(template, releases) }));
    await client.goto(url);
    const recommended = client.locator(".hero .actions > a");
    await recommended.waitFor({ state: "visible" });
    assert.equal(await recommended.getAttribute("href"), release.url);
    assert.equal(await client.locator(".scroll-actions .actions > a").getAttribute("href"), release.url);
    for (const [lang, notesLabel, testLabel] of [["zh-CN", "发布说明", "测试版"], ["en-US", "release notes", "Test build"]]) {
      await client.locator(`button[data-lang="${lang}"]`).click();
      await client.locator(".hero summary").click();
      const detail = await client.locator(`.hero details [data-system="${system}"] small`).innerText();
      assert.ok(detail.includes(release.version));
      assert.equal(detail.includes(testLabel), release.test);
      const note = client.getByRole("link", { name: `${platform} ${notesLabel}`, exact: true });
      assert.equal(await note.getAttribute("href"), release.notes);
      await client.locator(".hero summary").press("Escape");
    }
    await client.close();
  }
} finally {
  await browser.close();
}
