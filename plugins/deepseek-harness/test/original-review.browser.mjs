// From the repository root: node plugins/deepseek-harness/test/original-review.browser.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../../../tests/browser/engine.mjs";

const root = new URL("../../../", import.meta.url);
const requireFromRoot = createRequire(new URL("package.json", root));
const { build } = createRequire(requireFromRoot.resolve("vite/package.json"))("esbuild");
const plugin = createRequire(import.meta.url).resolve("@opendirector/dsh-plugin/client");
const locale = process.argv[2] ?? "en";
assert.ok(["en", "zh"].includes(locale), "Expected en or zh");

// Mount the plugin's real chat slot with two saved results and a composer draft.
const host = await build({
  stdin: { resolveDir: fileURLToPath(root), contents: `
    import * as React from "react";
    import {createRoot} from "react-dom/client";
    let tail, inject, strings;
    const binding = { ctx: {} };
    const input = {
      requestDraftInitialization(_binding, { prompt }) {
        document.querySelector("#draft").textContent += "\\n" + prompt;
        return "applied";
      },
      for(ctx) {
        if (ctx !== binding.ctx) throw new Error("Wrong session");
        return {focus() {
          const editor = document.querySelector("#draft");
          editor.focus();
          window.getSelection().collapse(editor, 0);
        }};
      }
    };
    window.__ModuleLoader__ = {load({factory}) {
      factory(() => React).apply({
        effect: run => run(), get: name => ({sessions: {binding: () => binding}, conversation: {input}})[name],
        locale: {register: (_, locales) => { window.reviewLabels = strings = locales[window.reviewLocale]; }},
        slots: {inject: (_, register) => register(), register(slot, render) {
          if (slot.name === "conversation.chat.turnTail") { tail = render; inject = slot.inject; }
        }}
      });
    }};
    window.showSaved = results => {
      const calls = [{root: {callId: "show", name: "opendirector_results", meta: {
        projectId: "coast", canvasUrl: "/canvas", savedResults: {projectName: "Coast", results}
      }}}];
      const source = {subscribe: () => () => {}, getSnapshot: () => calls};
      createRoot(document.querySelector("main")).render(tail({
        turn: {turn: 1}, t: key => strings[key],
        useChat: select => select({nodes: {turnDataSource: () => source}}),
        ...inject("session")
      }));
    };` },
  bundle: true, write: false, define: { "process.env.NODE_ENV": '"production"' },
});

const images = ["first-take", "second-take"].map((resultId, i) => ({
  resultId, assetId: "asset-" + resultId, kind: "image", title: "Coast", version: i + 1,
}));
const writes = [];
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.addInitScript(lang => { window.reviewLocale = lang; }, locale);
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    const json = value => route.fulfill({ json: value });
    if (route.request().method() === "POST") {
      writes.push({ path: url.pathname, body: route.request().postDataJSON() });
      return json(url.pathname.endsWith("/adopt") ? { status: "applied" } : { status: "accepted", jobId: "edit" });
    }
    switch (url.pathname) {
      case "/": return route.fulfill({ contentType: "text/html", body: '<div id="draft" contenteditable="true" role="textbox">Keep the coast.</div><main></main>' });
      case "/api/opendirector/media": return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' });
      case "/api/opendirector/library": return json({ results: [{ ...images[1], selected: true }, images[0]] });
      case "/api/opendirector/creation": return json(url.searchParams.has("job") ? { status: "succeeded", results: [] }
        : { models: [{ id: "image", modelId: "image", kind: "image", maxImages: 1, imageOutputs: [] }] });
      default: return route.abort();
    }
  });
  await page.goto("http://127.0.0.1/");
  await page.addScriptTag({ content: host.outputFiles[0].text });
  await page.addScriptTag({ path: plugin });
  await page.evaluate(results => window.showSaved(results), images);
  const labels = await page.evaluate(() => window.reviewLabels);
  assert.equal(labels.adoptImage, locale === "en" ? "Adopt this image" : "采用这张图");
  const button = (parent, name) => parent.getByRole("button", { name, exact: true });
  const card = id => page.locator(`figure[data-opendirector-result="${id}"]`);
  const viewer = page.getByRole("dialog", { name: labels.viewOriginal });
  await button(card("first-take"), labels.viewOriginal).click();
  await button(viewer, labels.nextImage).click();
  await button(viewer, labels.adoptImage).click();
  await button(viewer, labels.selected).waitFor();
  assert.ok(await button(viewer, labels.previousImage).isDisabled(), "adopted image moved to the first position");
  assert.equal(new URL(await viewer.locator("img").evaluate(img => img.src)).searchParams.get("asset"), images[1].assetId);
  await button(viewer, labels.edit).click();
  const edit = page.getByRole("dialog", { name: labels.edit, exact: true });
  await edit.getByLabel(labels.brief).fill("Keep the scarf.");
  await Promise.all([page.waitForResponse(res => res.request().method() === "POST"), button(edit, labels.generate).click()]);
  await button(edit, labels.close).click();
  await button(card("first-take"), labels.viewOriginal).click();
  await button(viewer, labels.previousImage).click();
  await button(viewer, labels.referenceInChat).click();
  await page.waitForFunction(() => document.activeElement === document.querySelector("#draft"));
  const before = await page.locator("#draft").textContent();
  await page.keyboard.type(" Continue.");
  const draft = await page.locator("#draft").textContent();
  assert.equal(draft.replaceAll("\u00a0", " "), before.replaceAll("\u00a0", " ") + " Continue.");
  assert.ok(draft.startsWith("Keep the coast.\n"));
  assert.equal(draft.match(/second-take/g)?.length, 1);
  assert.doesNotMatch(draft, /first-take/);
  assert.deepEqual(writes.map(({ path, body }) => [path, body.projectId, body.resultId ?? body.sourceResultIds]), [
    ["/api/opendirector/adopt", "coast", "second-take"],
    ["/api/opendirector/creation", "coast", ["second-take"]],
  ]);
  console.log("Reviewed, adopted, edited, and referenced the same result after reordering.");
} finally {
  await browser.close();
}
