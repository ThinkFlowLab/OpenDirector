import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

// An existing dependency tree may be supplied on machines with partial installs.
const modules = resolve(process.env.CANVAS_LINK_UI_MODULES ?? "node_modules");
const requireUI = createRequire(join(modules, "../package.json"));
const { build } = requireUI("esbuild");
const { JSDOM } = requireUI("jsdom");
const React = requireUI("react");
const { act } = React;
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
const { createRoot } = requireUI("react-dom/client");
const directory = await mkdtemp(join(tmpdir(), "canvas-links-"));
await symlink(modules, join(directory, "node_modules"));
await build({ entryPoints: [resolve("src/canvas/AssistantReply.tsx")],
  outfile: join(directory, "reply.mjs"), bundle: true, platform: "node",
  format: "esm", jsx: "automatic", packages: "external",
  plugins: [{ name: "review-mutation", setup(builder) {
    if (!process.env.CANVAS_LINK_UI_MUTATION) return;
    builder.onLoad({ filter: /AssistantReply\.tsx$/ }, async ({ path }) => {
      const mutations = {
        U1: ['components={projectLinks.components}', 'components={{}}'],
        U2: ['(link.status === "focused" || link.status === "hidden")', '(link.status !== "external")'],
      };
      const [before, after] = mutations[process.env.CANVAS_LINK_UI_MUTATION];
      const source = await readFile(path, "utf8");
      assert.ok(source.includes(before), "mutation source must exist");
      return { contents: source.replace(before, after), loader: "tsx" };
    });
  } }],
});
const { AssistantReply } = await import(pathToFileURL(join(directory, "reply.mjs")));
const { translate } = await import("../src/i18n/messages.ts");
const id = "11111111-1111-4111-8111-111111111111";

async function renderLink(link, locale, status, check) {
  const root = createRoot(document.getElementById("root"));
  const calls = [];
  try {
    await act(async () => root.render(React.createElement(AssistantReply, {
      message: { id: "reply", role: "assistant", status,
        text: `[Finished note](${link.target})`, canvasLinks: [link] },
      thinking: false, t: (key, params) => translate(locale, key, params),
      onCanvasLink: (nodeId) => calls.push(nodeId),
    })));
    await check(calls);
  } finally {
    await act(async () => root.unmount());
  }
}

test("resolved project links render real anchors and invoke local focus", async () => {
  for (const locale of ["en-US", "zh-CN"]) {
    for (const status of ["streaming", "complete"]) {
      for (const [target, linkStatus] of [["notes.md", "focused"], [`canvas:${id}`, "focused"], [`canvas:${id}`, "hidden"]]) {
        await renderLink({ target, status: linkStatus, nodeId: id }, locale, status, async (calls) => {
          const anchor = document.querySelector(".cw-chat-markdown a[href]");
          assert.ok(anchor, `resolved project reference must be an anchor: ${document.body.innerHTML}`);
          assert.equal(anchor.textContent, "Finished note");
          assert.ok(!document.body.textContent.includes("[blocked]"));
          await act(async () => anchor.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true })));
          assert.deepEqual(calls, [id]);
        });
      }
    }
  }
});

test("cross-project links show a translated destination hint and never focus a colliding local ID", async () => {
  const projectId = "22222222-2222-4222-8222-222222222222";
  for (const locale of ["en-US", "zh-CN"]) {
    await renderLink({ target: `project:${projectId}/canvas:${id}`, status: "cross-project", projectId, nodeId: id }, locale, "complete", async (calls) => {
      const link = document.querySelector(".cw-chat-markdown a[href]");
      assert.ok(link);
      await act(async () => link.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true })));
      assert.deepEqual(calls, []);
      assert.ok(document.body.textContent.includes(translate(locale, "assistant.reply.canvasLink.crossProject")));
      assert.ok(document.body.textContent.includes(projectId));
    });
  }
});

test("plain @mentions render as clickable canvas links", async () => {
  const root = createRoot(document.getElementById("root"));
  const calls = [];
  try {
    await act(async () => root.render(React.createElement(AssistantReply, {
      message: { id: "mention", role: "assistant", status: "complete",
        text: "Look at @Finished note for the result.",
        canvasLinks: [{ target: "@Finished note", status: "focused", nodeId: id }] },
      thinking: false, t: (key, params) => translate("en-US", key, params),
      onCanvasLink: (nodeId) => calls.push(nodeId),
    })));
    const anchor = document.querySelector(".cw-chat-markdown a[href]");
    assert.ok(anchor, `@mention must render as an anchor: ${document.body.innerHTML}`);
    assert.equal(anchor.textContent, "@Finished note");
    assert.equal(document.body.textContent.includes("[blocked]"), false);
    await act(async () => anchor.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true })));
    assert.deepEqual(calls, [id]);
  } finally {
    await act(async () => root.unmount());
  }
});

test.after(async () => { dom.window.close(); await rm(directory, { recursive: true, force: true }); });
