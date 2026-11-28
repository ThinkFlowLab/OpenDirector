import assert from "node:assert/strict";
import test from "node:test";
import { captureClipboardMedia } from "../src/canvas/clipboardMedia.ts";
import { createNode } from "../src/canvas/model.ts";
import type { CanvasFragment } from "../src/canvas/operations.ts";
import {
  systemClipboardPayload,
  writeSystemClipboard,
} from "../src/canvas/systemClipboard.ts";
import { tNow } from "../src/i18n/messages.ts";

const capture = (fragment: CanvasFragment, blob = new Blob(["png"], { type: "image/png" })) =>
  captureClipboardMedia("project", fragment, { read: async () => blob });

test("a single text node offers its text with line breaks and Unicode", async () => {
  const text = "第一行\nSecond line";
  const fragment: CanvasFragment = {
    nodes: [createNode("text", undefined, { text })],
    edges: [],
  };
  const payload = systemClipboardPayload(fragment, capture(fragment));
  assert.deepEqual(payload, { kind: "text", text });
  let written = "";
  await writeSystemClipboard(payload!, {
    clipboard: {
      writeText: async (value: string) => {
        written = value;
      },
      write: async () => assert.fail("text must use writeText"),
    },
  });
  assert.equal(written, text);
});

test("a single image node writes PNG clipboard data from the captured bytes", async () => {
  const fragment: CanvasFragment = {
    nodes: [createNode("image", undefined, { src: "blob:image", mimeType: "image/jpeg" })],
    edges: [],
  };
  const jpeg = new Blob(["jpg"], { type: "image/jpeg" });
  const png = new Blob(["png"], { type: "image/png" });
  const payload = systemClipboardPayload(fragment, capture(fragment, jpeg));
  assert.equal(payload?.kind, "image");
  const items: Record<string, Promise<Blob>>[] = [];
  await writeSystemClipboard(payload!, {
    createItem: (item) => {
      items.push(item);
      return item as unknown as ClipboardItem;
    },
    toPng: async (blob) => {
      assert.equal(blob, jpeg);
      return png;
    },
    clipboard: {
      write: async ([item]) => {
        await (item as unknown as Record<string, Promise<Blob>>)["image/png"];
      },
      writeText: async () => assert.fail("images must use write"),
    },
  });
  assert.deepEqual(Object.keys(items[0]!), ["image/png"]);
  assert.equal(await items[0]!["image/png"], png);
});

test("multi-node and non-media selections stay in-app", () => {
  const several: CanvasFragment = {
    nodes: [createNode("text", undefined, { text: "a" }), createNode("text", undefined, { text: "b" })],
    edges: [],
  };
  assert.equal(systemClipboardPayload(several, capture(several)), null);
  const empty: CanvasFragment = { nodes: [createNode("text", undefined, { text: "" })], edges: [] };
  assert.equal(systemClipboardPayload(empty, capture(empty)), null);
});

test("missing media and rejected writes fail with localized reasons", async () => {
  const fragment: CanvasFragment = {
    nodes: [createNode("image", undefined, { src: "blob:gone", assetState: "missing" })],
    edges: [],
  };
  const payload = systemClipboardPayload(fragment, capture(fragment));
  const deps = {
    createItem: (item: Record<string, Promise<Blob>>) => item as unknown as ClipboardItem,
    toPng: async (blob: Blob) => blob,
  };
  await assert.rejects(
    writeSystemClipboard(payload!, {
      ...deps,
      clipboard: {
        write: async ([item]) => {
          await (item as unknown as Record<string, Promise<Blob>>)["image/png"];
        },
        writeText: async () => {},
      },
    }),
    { message: tNow("errors.files.clipboardRead") },
  );
  await assert.rejects(
    writeSystemClipboard(
      { kind: "text", text: "hello" },
      {
        clipboard: {
          write: async () => {},
          writeText: async () => {
            throw new DOMException("denied", "NotAllowedError");
          },
        },
      },
    ),
    { message: tNow("errors.files.clipboardWrite") },
  );
  await assert.rejects(
    writeSystemClipboard(
      { kind: "image", blob: Promise.resolve(new Blob()) },
      { ...deps, createItem: undefined, clipboard: { write: async () => {}, writeText: async () => {} } },
    ),
    { message: tNow("errors.files.clipboardUnavailable") },
  );
});
