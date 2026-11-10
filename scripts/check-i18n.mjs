#!/usr/bin/env node
/**
 * Guards the bilingual catalogs and the remaining translation backlog.
 *
 * - zh-CN is canonical: every key must exist in en-US, and vice versa.
 * - A source file may not gain new Chinese UI lines. Existing counts live in
 *   scripts/i18n-baseline.json and should only go down.
 *
 * Usage:
 *   node scripts/check-i18n.mjs            check
 *   node scripts/check-i18n.mjs --update   refresh the backlog baseline
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const catalogRoot = join(root, "src", "i18n", "messages");
const baselineFile = join(root, "scripts", "i18n-baseline.json");
const sourceRoots = [join(root, "src")];
// toolText.ts, toolTaskText.ts, toolReasonText.ts, providerPresets.ts,
// modelDescriptions.ts, creationPreviewText.ts, assistantToolText.ts and
// generationFailureText.ts are translation tables for data, not UI copy.
const skip = [
  /[\\/]i18n[\\/]messages[\\/]/,
  /[\\/]toolText\.ts$/,
  /[\\/]toolTaskText\.ts$/,
  /[\\/]toolReasonText\.ts$/,
  /[\\/]providerPresets\.ts$/,
  /[\\/]modelDescriptions\.ts$/,
  /[\\/]creationPreviewText\.ts$/,
  /[\\/]assistantToolText\.ts$/,
  /[\\/]capabilityErrorText\.ts$/,
  /[\\/]generationFailureText\.ts$/,
  /\.test\./,
];
const cjk = /[\u3400-\u9fff]/;

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      await walk(path, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

function keysOf(text) {
  const keys = new Set();
  for (const match of text.matchAll(/^\s*"([^"]+)"\s*:/gm)) keys.add(match[1]);
  return keys;
}

const zhDir = join(catalogRoot, "zh-CN");
const enDir = join(catalogRoot, "en-US");
const zhFiles = (await readdir(zhDir)).filter((name) => name.endsWith(".ts"));
const enFiles = new Set(
  (await readdir(enDir)).filter((name) => name.endsWith(".ts")),
);
const problems = [];
let keyCount = 0;

for (const file of zhFiles) {
  if (!enFiles.has(file)) {
    problems.push(`missing English catalog: en-US/${file}`);
    continue;
  }
  const zh = keysOf(await readFile(join(zhDir, file), "utf8"));
  const en = keysOf(await readFile(join(enDir, file), "utf8"));
  keyCount += zh.size;
  for (const key of zh) {
    if (!en.has(key)) problems.push(`en-US/${file}: missing key ${key}`);
  }
  for (const key of en) {
    if (!zh.has(key)) problems.push(`zh-CN/${file}: missing key ${key}`);
  }
}
for (const file of enFiles) {
  if (!zhFiles.includes(file))
    problems.push(`missing Chinese catalog: zh-CN/${file}`);
}

const counts = {};
let total = 0;
for (const dir of sourceRoots) {
  for (const file of await walk(dir)) {
    if (skip.some((pattern) => pattern.test(file))) continue;
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    const count = lines.filter((line) => cjk.test(line)).length;
    if (!count) continue;
    counts[relative(root, file).replaceAll("\\", "/")] = count;
    total += count;
  }
}

if (process.argv.includes("--update")) {
  await writeFile(
    baselineFile,
    `${JSON.stringify({ total, counts }, null, 2)}\n`,
    "utf8",
  );
  console.log(`baseline updated: ${total} Chinese lines in ${Object.keys(counts).length} files`);
  process.exit(problems.length ? 1 : 0);
}

let baseline = { total: 0, counts: {} };
try {
  baseline = JSON.parse(await readFile(baselineFile, "utf8"));
} catch {
  problems.push("scripts/i18n-baseline.json is missing; run with --update");
}

for (const [file, count] of Object.entries(counts)) {
  const allowed = baseline.counts?.[file] ?? 0;
  if (count > allowed)
    problems.push(`${file}: ${allowed} -> ${count} Chinese lines (translate them or update deliberately)`);
}

console.log(
  `i18n: ${keyCount} keys, ${problems.length} problem(s), ${total} Chinese source lines (baseline ${baseline.total ?? 0})`,
);
for (const problem of problems) console.error(`- ${problem}`);
process.exit(problems.length ? 1 : 0);
