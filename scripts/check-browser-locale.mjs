#!/usr/bin/env node
/**
 * Guards the UI language of the isolated browser workflows.
 *
 * Chromium starts in the language of the machine that runs it, and the app
 * follows the browser language while no preference is stored. A script that
 * asserts localized text without pinning `locale` therefore passes on one
 * machine and times out on another (issue #160). Every page states its
 * language — through `newPage({ locale })` or through a stored
 * `opendirector.locale.v1` preference that the app applies before first
 * paint — and that language must match the selectors the script asserts.
 *
 * Usage:
 *   node scripts/check-browser-locale.mjs
 */
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const browserDir = join(root, "tests", "browser");
const extraScripts = [join(root, "scripts", "verify_creation_browser.mjs")];
const locales = ["en-US", "zh-CN"];
// locale.mjs switches languages on one page: it starts in English, stores a
// Chinese preference, and asserts both.
const switching = new Set(["locale.mjs"]);
const cjk = /[\u3400-\u9fff]/;
const selector = /\bgetBy[A-Za-z]*\(|hasText\s*:|\btext=/;

/** Skip the string literal starting at `start`; return the index after it. */
function skipString(text, start) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i += 1;
  }
  return text.length;
}

/** Return the index of the parenthesis closing the call opened at `open`. */
function matchingParen(text, open) {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(text, i);
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return text.length;
}

/** Collect every `browser.newPage(...)` call with its line and arguments. */
function newPageCalls(text) {
  const calls = [];
  let index = 0;
  for (;;) {
    const start = text.indexOf("browser.newPage(", index);
    if (start === -1) return calls;
    const open = start + "browser.newPage".length;
    const close = matchingParen(text, open);
    calls.push({
      line: text.slice(0, start).split("\n").length,
      args: text.slice(open + 1, close),
    });
    index = close;
  }
}

const names = (await readdir(browserDir)).filter((name) => name.endsWith(".mjs"));
const files = [...names.map((name) => join(browserDir, name)), ...extraScripts];
const problems = [];
let checked = 0;

for (const file of files) {
  const name = file.slice(file.lastIndexOf("\\") + 1).split("/").pop();
  const text = await readFile(file, "utf8");
  const rel = relative(root, file).replaceAll("\\", "/");
  const calls = newPageCalls(text);
  // A stored preference wins over the browser language, so a script that sets
  // it before first paint is deterministic without a page locale.
  const storesLocale =
    /localStorage\.setItem\(\s*["']opendirector\.locale\.v1["']/.test(text);
  if (calls.length === 0) continue;
  const assertsChinese = text
    .split(/\r?\n/)
    .some((line) => cjk.test(line) && selector.test(line));
  const expected = assertsChinese ? "zh-CN" : "en-US";
  for (const call of calls) {
    checked += 1;
    const found = /locale:\s*"([^"]+)"/.exec(call.args)?.[1];
    if (!found) {
      if (storesLocale) continue;
      problems.push(
        `${rel}:${call.line}: browser.newPage() must pin locale: "${expected}" (the page asserts ${expected === "zh-CN" ? "Chinese" : "English"} text)`,
      );
      continue;
    }
    if (!locales.includes(found)) {
      problems.push(
        `${rel}:${call.line}: unsupported locale "${found}"; use ${locales.join(" or ")}`,
      );
      continue;
    }
    if (!switching.has(name) && !storesLocale && found !== expected) {
      problems.push(
        `${rel}:${call.line}: pins locale "${found}" but the script asserts ${expected === "zh-CN" ? "Chinese" : "English"} text`,
      );
    }
  }
}

console.log(
  `browser locale: ${checked} page(s), ${problems.length} problem(s), ${files.length} script(s)`,
);
for (const problem of problems) console.error(`- ${problem}`);
process.exit(problems.length ? 1 : 0);
