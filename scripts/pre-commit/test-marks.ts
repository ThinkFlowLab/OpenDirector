/** Shared classification for Node unit files and browser journeys. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const LAYERS = ["ready", "merge", "nightly"] as const;
export const HARDWARE = ["cpu", "cuda", "rocm", "xpu", "npu"] as const;
export type Layer = (typeof LAYERS)[number];
export type Hardware = (typeof HARDWARE)[number];
export type Marks = { layer: Layer; hardware: Hardware };
export type Entry = Marks & {
  file: string;
  script: string;
  lanes?: string[];
  fixture?: boolean;
};
export type Selection = { layers?: Layer[]; hardware?: Hardware[]; lane?: string };

function fail(message: string): never {
  throw new Error(`Test marks: ${message}`);
}

export function marks(value: { layer?: unknown; hardware?: unknown }): Marks {
  const { layer, hardware } = value;
  if (!LAYERS.includes(layer as Layer)) fail(`unknown layer: ${layer}`);
  if (!HARDWARE.includes(hardware as Hardware)) fail(`unknown hardware: ${hardware}`);
  return { layer: layer as Layer, hardware: hardware as Hardware };
}

export function select(entries: Entry[], selection: Selection): Entry[] {
  return entries.filter((entry) =>
    (!selection.layers || selection.layers.includes(entry.layer)) &&
    (!selection.hardware || selection.hardware.includes(entry.hardware)) &&
    (!selection.lane || entry.lanes?.includes(selection.lane)),
  );
}

function unique(entries: Entry[]): Entry[] {
  const names = new Set<string>();
  for (const entry of entries) {
    if (names.has(entry.script)) fail(`duplicate script: ${entry.script}`);
    names.add(entry.script);
  }
  return entries;
}

export function unitCatalog(root = ROOT): Entry[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "tests/frontend-manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.tests)) fail("invalid unit manifest");
  const entries = unique(manifest.tests.map((entry: { file: string; layer?: unknown; hardware?: unknown }) => {
    if (typeof entry.file !== "string" || !/^[\w.-]+\.test\.ts$/.test(entry.file)) fail("invalid unit path");
    return { file: entry.file, script: `tests/${entry.file}`, ...marks(entry) };
  }));
  const actual = fs.readdirSync(path.join(root, "tests")).filter((file) => file.endsWith(".test.ts")).sort();
  const listed = entries.map((entry) => entry.file).sort();
  if (JSON.stringify(actual) !== JSON.stringify(listed)) fail("unit discovery differs from manifest");
  return entries.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
}

export function browserCatalog(root = ROOT): Entry[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "tests/browser/manifest.json"), "utf8"));
  const entries: Entry[] = [];
  const names = new Set<string>();
  for (const entry of [...manifest.scripts, ...(manifest.externalScripts ?? [])]) {
    if (typeof entry.file !== "string" || names.has(entry.file)) fail("invalid or duplicate browser path");
    names.add(entry.file);
    if (entry.helper) {
      if (entry.layer !== undefined || entry.hardware !== undefined) fail("helpers cannot carry marks");
      continue;
    }
    const external = manifest.externalScripts?.includes(entry);
    if (external ? entry.file !== "scripts/verify_creation_browser.mjs" : !/^[\w.-]+\.mjs$/.test(entry.file)) fail("invalid browser path");
    const script = external ? entry.file : `tests/browser/${entry.file}`;
    if (!fs.existsSync(path.join(root, script))) fail(`missing browser script: ${script}`);
    entries.push({ file: entry.file, script, lanes: entry.lanes,
      ...(entry.fixture === undefined ? {} : { fixture: entry.fixture }), ...marks(entry) });
  }
  return unique(entries);
}

export function options(args: string[], { passthrough = false } = {}) {
  const selection: Selection = {};
  const forwarded: string[] = [];
  let list = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--list") { list = true; continue; }
    if (arg === "--") { forwarded.push(...args.slice(i + 1)); break; }
    if (["--layer", "--hardware", "--lane"].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) fail(`missing value: ${arg}`);
      if (arg === "--lane") {
        if (!["gate", "extended", "extendedFixture", "production", "perf", "manual"].includes(value)) fail(`unknown lane: ${value}`);
        selection.lane = value;
      } else {
        const values = value.split(",");
        const known: readonly string[] = arg === "--layer" ? LAYERS : HARDWARE;
        if (values.some((v) => !known.includes(v))) fail(`invalid selection: ${arg} ${value}`);
        if (arg === "--layer") selection.layers = values as Layer[];
        else selection.hardware = values as Hardware[];
      }
    } else if (passthrough) forwarded.push(arg);
    else fail(`unknown argument: ${arg}`);
  }
  return { selection, list, forwarded };
}
