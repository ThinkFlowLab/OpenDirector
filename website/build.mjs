import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveInstallers } from "./installers.mjs";
import { messages } from "./messages.mjs";

const siteUrl = "https://thinkflowlab.github.io/OpenDirector/";
const repository = "https://github.com/ThinkFlowLab/OpenDirector";
const pages = {
  "en-US": { path: "en/", hreflang: "en" },
  "zh-CN": { path: "zh-cn/", hreflang: "zh-CN" },
};

const alternates = [
  ...Object.values(pages).map(({ path, hreflang }) => [hreflang, siteUrl + path]),
  ["x-default", siteUrl],
].map(([lang, url]) => `<link rel="alternate" hreflang="${lang}" href="${url}">`).join("\n  ");

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function renderPage(template, values, html) {
  return template.replace(/{{(\w+)}}/g, (_, key) => {
    if (Object.hasOwn(html, key)) return html[key];
    if (Object.hasOwn(values, key)) return escapeHtml(values[key]);
    throw new Error(`Missing website template value ${key}`);
  });
}

export function renderDownloadPage(template, installers, locale = "en-US") {
  const copy = messages[locale];
  const page = pages[locale];
  const options = [];
  const notes = new Map();
  for (const [system, format] of [["mac", "DMG"], ["windows", "EXE"]]) {
    const name = `<span>${escapeHtml(copy[system])}</span>`;
    const installer = installers[system];
    if (!installer) {
      options.push(`<li><span>${name}<small>${escapeHtml(copy.unavailable)}</small></span></li>`);
      continue;
    }
    const test = installer.test ? ` · ${escapeHtml(copy.testBuild)}` : "";
    options.push(`<li><a data-system="${system}" href="${escapeHtml(installer.url)}">${name}<small>${escapeHtml(installer.version)} · ${format}${test}</small></a></li>`);
    notes.set(installer.notes, system);
  }

  const releaseNotes = [];
  for (const [url, system] of notes) {
    const key = notes.size === 1 ? "notes" : `${system}Notes`;
    releaseNotes.push(`<a href="${escapeHtml(url)}">${escapeHtml(copy[key])}</a>`);
  }

  const chinese = locale === "zh-CN";
  const values = {
    ...copy,
    locale,
    siteRoot: "../",
    englishHref: `../${pages["en-US"].path}`,
    chineseHref: `../${pages["zh-CN"].path}`,
    canonical: siteUrl + page.path,
    ogLocale: locale.replace("-", "_"),
    shareImage: `${siteUrl}canvas.jpg`,
    installHref: `${repository}/blob/main/docs/guides/installation${chinese ? ".zh-CN" : ""}.md`,
    aiInstallHref: chinese ? `${repository}/blob/main/README.zh-CN.md#一句话安装` : `${repository}#install-with-ai`,
  };
  const html = {
    alternates,
    englishCurrent: chinese ? "" : ' aria-current="page"',
    chineseCurrent: chinese ? ' aria-current="page"' : "",
    primaryHidden: notes.size ? " hidden" : "",
    menuHidden: notes.size ? "" : " hidden",
    desktopOptions: options.join("\n"),
    desktopNotes: releaseNotes.join("\n    "),
  };
  return renderPage(template, values, html);
}

if (import.meta.main) {
  const output = process.argv[2];
  const [template, entry] = await Promise.all([
    readFile(new URL("index.html", import.meta.url), "utf8"),
    readFile(new URL("entry.html", import.meta.url), "utf8"),
  ]);
  const installers = await resolveInstallers();
  for (const [locale, { path }] of Object.entries(pages)) {
    const pageDirectory = join(output, path);
    await mkdir(pageDirectory, { recursive: true });
    await writeFile(join(pageDirectory, "index.html"), renderDownloadPage(template, installers, locale));
  }
  await writeFile(join(output, "index.html"), renderPage(entry, {
    canonical: siteUrl,
    englishHref: `./${pages["en-US"].path}`,
    chineseHref: `./${pages["zh-CN"].path}`,
    englishLanguage: messages["en-US"].language,
    chineseLanguage: messages["zh-CN"].language,
  }, { alternates }));
  const urls = Object.values(pages).map(({ path }) => `  <url><loc>${siteUrl}${path}</loc></url>`);
  await writeFile(join(output, "sitemap.xml"), [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n"));
}
