import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { launchBrowser } from "../tests/browser/engine.mjs";
import { renderDownloadPage } from "./build.mjs";

const entryUrl = process.env.WEBSITE_URL ?? "http://127.0.0.1:8780/OpenDirector/";
const repository = "https://github.com/ThinkFlowLab/OpenDirector";
const canonicalRoot = "https://thinkflowlab.github.io/OpenDirector/";
const preferenceKey = "opendirector.website.locale";
const locales = [
  {
    lang: "en-US",
    url: new URL("en/", entryUrl).href,
    canonical: new URL("en/", canonicalRoot).href,
    title: "OpenDirector — Open-source AI Video Editor",
    tagline: /open-source AI video editor/i,
    intro: /canvas.*timeline/i,
    downloadLabel: "Download OpenDirector",
    guide: "installation.md",
    notesLabel: "release notes",
    testLabel: "Test build",
    shot: /Bedtime/,
  },
  {
    lang: "zh-CN",
    url: new URL("zh-cn/", entryUrl).href,
    canonical: new URL("zh-cn/", canonicalRoot).href,
    title: "OpenDirector — 开源 AI 视频创作与剪辑工具",
    tagline: /开源.*AI.*视频/,
    intro: /画布.*时间线/,
    downloadLabel: "下载 OpenDirector",
    guide: "installation.zh-CN.md",
    notesLabel: "发布说明",
    testLabel: "测试版",
    shot: /哄孩子入睡/,
  },
];
const [english, chinese] = locales;
const alternateUrls = { en: english.canonical, "zh-CN": chinese.canonical, "x-default": canonicalRoot };
const filmUrl = new URL("film/we-can-still-win.mp4", entryUrl).href;

async function assertPageLanguage(page, locale, expectedUrl = locale.url) {
  assert.equal(page.url(), expectedUrl);
  assert.equal(await page.locator("html").getAttribute("lang"), locale.lang);
  assert.equal(await page.title(), locale.title);
  assert.match(await page.locator(".hero .tagline").innerText(), locale.tagline);
}

async function assertPageMetadata(page, canonical) {
  assert.equal(await page.locator('head link[rel="canonical"]').getAttribute("href"), canonical);
  const alternates = await page.locator('head link[rel="alternate"][hreflang]').evaluateAll(links =>
    links.map(link => [link.hreflang, link.getAttribute("href")]),
  );
  assert.equal(alternates.length, Object.keys(alternateUrls).length);
  assert.deepEqual(Object.fromEntries(alternates), alternateUrls);
}

function languageLink(page, locale) {
  return page.locator(`a[data-lang="${locale.lang}"]`);
}

async function assertPreference(page, expected) {
  assert.equal(await page.evaluate(key => localStorage.getItem(key), preferenceKey), expected);
}

async function setPreference(page, value) {
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: preferenceKey, value });
}

async function checkStaticDownloads(page) {
  const links = await page.locator(".hero details a[data-system]").all();
  const notes = new Set();
  const downloads = [];
  if (links.length) {
    await page.locator(".hero summary").click();
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
    assert.equal(await page.locator(".hero summary").isVisible(), false);
    assert.equal(await page.locator(".hero .actions > a").getAttribute("href"), "#install-heading");
  }
  const footnotes = await page.locator(".footer a[href*='/releases/']").evaluateAll(anchors => anchors.map(a => a.href));
  assert.deepEqual(new Set(footnotes), notes);
  return downloads;
}

const browser = await launchBrowser();
try {
  const staticPage = await browser.newPage({ javaScriptEnabled: false, reducedMotion: "reduce" });
  const entryResponse = await staticPage.goto(entryUrl);
  assert.equal(entryResponse.status(), 200);
  assert.equal(staticPage.url(), entryUrl);
  await assertPageMetadata(staticPage, canonicalRoot);
  for (const locale of locales) {
    const link = languageLink(staticPage, locale);
    assert.ok(await link.isVisible());
    assert.equal(await link.evaluate(anchor => anchor.href), locale.url);
  }
  await languageLink(staticPage, chinese).click();
  await assertPageLanguage(staticPage, chinese);

  const staticDownloads = new Map();
  const descriptions = new Set();
  for (const locale of locales) {
    const otherLocale = locales.find(other => other !== locale);
    const response = await staticPage.goto(locale.url);
    assert.equal(response.status(), 200);
    assert.doesNotMatch(await response.text(), /\{\{[^{}]+\}\}/);
    await assertPageLanguage(staticPage, locale);
    assert.equal(await staticPage.locator("h1").innerText(), "OpenDirector");
    assert.match(await staticPage.locator(".hero .intro").innerText(), locale.intro);
    const description = await staticPage.locator('head meta[name="description"]').getAttribute("content");
    assert.match(description ?? "", locale.tagline);
    descriptions.add(description);
    await assertPageMetadata(staticPage, locale.canonical);
    for (const target of ["download", "film"]) {
      assert.equal(await staticPage.locator(`#${target}`).count(), 1);
    }
    assert.equal(await staticPage.locator('a[href="#film"]').count(), 1);
    assert.equal(await staticPage.locator(".film-player video").evaluate(video => video.src), filmUrl);
    assert.equal(
      await staticPage.locator(".install a").getAttribute("href"),
      `${repository}/blob/main/docs/guides/${locale.guide}`,
    );
    staticDownloads.set(locale.lang, await checkStaticDownloads(staticPage));
    const switchLink = languageLink(staticPage, otherLocale);
    assert.equal(await switchLink.evaluate(link => link.href), otherLocale.url);
    const currentLink = staticPage.locator('a[aria-current="page"][data-lang]');
    assert.equal(await currentLink.getAttribute("data-lang"), locale.lang);
    assert.equal(await currentLink.evaluate(link => link.href), locale.url);
    await switchLink.click();
    await assertPageLanguage(staticPage, otherLocale);
  }
  assert.equal(descriptions.size, locales.length);
  assert.deepEqual(staticDownloads.get("en-US"), staticDownloads.get("zh-CN"));

  const sitemap = await staticPage.request.get(new URL("sitemap.xml", entryUrl).href);
  assert.equal(sitemap.status(), 200);
  const listedUrls = await staticPage.evaluate(xml => {
    const document = new DOMParser().parseFromString(xml, "application/xml");
    const namespace = "http://www.sitemaps.org/schemas/sitemap/0.9";
    if (document.documentElement.localName !== "urlset" || document.documentElement.namespaceURI !== namespace) {
      throw new Error("Expected a valid sitemap URL set");
    }
    return Array.from(document.getElementsByTagNameNS(namespace, "loc"), element => element.textContent);
  }, await sitemap.text());
  assert.deepEqual(listedUrls.sort(), locales.map(locale => locale.canonical).sort());
  await staticPage.close();

  const routingCases = [
    { browserLocale: "en-US", preference: null, destination: english },
    { browserLocale: "zh-TW", preference: null, destination: chinese },
    { browserLocale: "fr-FR", preference: null, destination: english },
    { browserLocale: "zh-CN", preference: "en-US", destination: english },
    { browserLocale: "en-US", preference: "zh-CN", destination: chinese },
    { browserLocale: "zh-SG", preference: "invalid", destination: chinese },
  ];
  const entrySuffix = "?utm_source=website-test#download";
  for (const { browserLocale, preference, destination } of routingCases) {
    const page = await browser.newPage({ locale: browserLocale, reducedMotion: "reduce" });
    const previousUrl = new URL("?from=previous-page", english.url).href;
    await page.goto(previousUrl);
    if (preference !== null) await setPreference(page, preference);
    await page.goto(new URL(entrySuffix, entryUrl).href, { waitUntil: "commit" });
    const destinationUrl = new URL(entrySuffix, destination.url).href;
    await page.waitForURL(destinationUrl);
    await assertPageLanguage(page, destination, destinationUrl);
    await assertPreference(page, preference);
    await page.goBack();
    await assertPageLanguage(page, english, previousUrl);
    await page.close();
  }

  for (const locale of locales) {
    const otherLocale = locales.find(other => other !== locale);
    const page = await browser.newPage({ locale: otherLocale.lang, reducedMotion: "reduce" });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "userAgentData", {
        value: { platform: "macOS", getHighEntropyValues: async () => ({ architecture: "x86", bitness: "64" }) },
      });
    });
    await page.goto(locale.url);
    await assertPageLanguage(page, locale);
    await assertPreference(page, null);
    await setPreference(page, otherLocale.lang);
    const directUrl = new URL("?utm_source=website-test#film", locale.url).href;
    await page.goto(directUrl);
    await assertPageLanguage(page, locale, directUrl);
    await assertPageMetadata(page, locale.canonical);
    await assertPreference(page, otherLocale.lang);
    await page.goto(locale.url);
    const downloads = staticDownloads.get(locale.lang);
    const menu = page.locator(".hero summary");
    if (downloads.length) {
      await menu.click();
      assert.equal(await menu.getAttribute("aria-label"), locale.downloadLabel);
      assert.equal(await page.locator(".hero .actions > a").isVisible(), false);
      for (const downloadUrl of downloads) {
        assert.equal(await page.locator(`.hero details a[href="${downloadUrl}"]`).isVisible(), true);
      }
      await menu.press("Escape");
      assert.equal(await page.locator(".hero details").getAttribute("open"), null);
    } else {
      assert.equal(await page.locator(".hero .actions").getByRole("link").getAttribute("href"), "#install-heading");
    }

    await languageLink(page, locale).click();
    await assertPageLanguage(page, locale);
    await assertPreference(page, locale.lang);
    await page.goto(entryUrl, { waitUntil: "commit" });
    await page.waitForURL(locale.url);
    await assertPageLanguage(page, locale);

    await languageLink(page, otherLocale).click();
    await assertPageLanguage(page, otherLocale);
    await assertPreference(page, otherLocale.lang);
    await page.route(filmUrl, route => route.fulfill({ status: 404 }));
    const film = page.locator(".film-player video");
    await Promise.all([
      page.waitForRequest(filmUrl),
      page.getByRole("button", { name: otherLocale.shot }).click(),
    ]);
    await page.waitForFunction(() => document.querySelector(".film-player video").error !== null);
    assert.equal(await film.evaluate(video => video.paused), true);
    await page.close();
  }

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
    for (const locale of locales) {
      await client.route(locale.url, route => route.fulfill({
        contentType: "text/html",
        body: renderDownloadPage(template, releases, locale.lang),
      }));
      await client.goto(locale.url);
      const recommended = client.locator(".hero .actions > a");
      await recommended.waitFor({ state: "visible" });
      assert.equal(await recommended.getAttribute("href"), release.url);
      assert.equal(await client.locator(".scroll-actions .actions > a").getAttribute("href"), release.url);
      assert.equal(await client.locator("#download").count(), 1);
      await client.locator(".hero summary").click();
      const detail = await client.locator(`.hero details [data-system="${system}"] small`).innerText();
      assert.ok(detail.includes(release.version));
      assert.equal(detail.includes(locale.testLabel), release.test);
      const note = client.getByRole("link", { name: `${platform} ${locale.notesLabel}`, exact: true });
      assert.equal(await note.getAttribute("href"), release.notes);
      await client.locator(".hero summary").press("Escape");
    }
    await client.close();
  }
} finally {
  await browser.close();
}
