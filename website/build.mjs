import { readFile, writeFile } from "node:fs/promises";
import { resolveInstallers } from "./installers.mjs";

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export function renderDownloadPage(template, installers) {
  const options = [];
  const notes = new Map();
  for (const [system, label, format] of [["mac", "macOS (Apple silicon)", "DMG"], ["windows", "Windows (x64)", "EXE"]]) {
    const name = `<span data-text="${system}">${label}</span>`;
    const installer = installers[system];
    if (!installer) {
      options.push(`<li><span>${name}<small data-text="unavailable">Installer unavailable</small></span></li>`);
      continue;
    }
    const test = installer.test ? ' · <span data-text="testBuild">Test build</span>' : "";
    options.push(`<li><a data-system="${system}" href="${escapeHtml(installer.url)}">${name}<small>${escapeHtml(installer.version)} · ${format}${test}</small></a></li>`);
    notes.set(installer.notes, system);
  }

  const releaseNotes = [];
  for (const [url, system] of notes) {
    const platform = system === "mac" ? "macOS" : "Windows";
    const label = notes.size === 1 ? "Release notes" : `${platform} release notes`;
    const key = notes.size === 1 ? "notes" : `${system}Notes`;
    releaseNotes.push(`<a data-text="${key}" href="${escapeHtml(url)}">${label}</a>`);
  }
  return template
    .replace("{{primary-hidden}}", notes.size ? "hidden" : "")
    .replace("{{menu-hidden}}", notes.size ? "" : "hidden")
    .replace("{{desktop-options}}", () => options.join("\n"))
    .replace("{{desktop-notes}}", () => releaseNotes.join("\n"));
}

if (import.meta.main) {
  const template = await readFile(new URL("index.html", import.meta.url), "utf8");
  const installers = await resolveInstallers();
  await writeFile(process.argv[2], renderDownloadPage(template, installers));
}
