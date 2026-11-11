import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { prepareTimelineFonts } from "../src/canvas/timelineTextRenderer.ts";
import { createNode } from "../src/canvas/model.ts";
import { RULE_FACTS } from "../src/contracts/ruleFacts.generated.ts";

for (const [name, sizes, identical, rejected] of [
  ["exactly at the aggregate limit", [32, 32], false, false],
  ["distinct bytes over the aggregate limit", [23, 23, 23], false, true],
  ["identical bytes in different font slots", [32, 32, 32], true, false],
] as const) {
  test(`font preparation counts actual distinct bytes: ${name}`, async (t) => {
    const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const oldFontFace = Object.getOwnPropertyDescriptor(globalThis, "FontFace");
    const faces = new Set();
    let loads = 0;
    Object.defineProperty(globalThis, "document", { configurable: true, value: { fonts: faces } });
    Object.defineProperty(globalThis, "FontFace", { configurable: true, value: class {
      async load() { loads++; return this; }
    } });
    t.after(() => {
      if (oldDocument) Object.defineProperty(globalThis, "document", oldDocument);
      else Reflect.deleteProperty(globalThis, "document");
      if (oldFontFace) Object.defineProperty(globalThis, "FontFace", oldFontFace);
      else Reflect.deleteProperty(globalThis, "FontFace");
    });
    t.mock.method(globalThis, "fetch", async (url: string, options?: RequestInit) => {
      if (url === "/api/creation/fonts/inspect") {
        return Response.json({ fingerprint: "sha256:" + createHash("sha256")
          .update(new Uint8Array(options!.body as ArrayBuffer)).digest("hex"),
          coverage: Buffer.alloc(0x110000 / 8, 255).toString("base64") });
      }
      const index = Number(url.split(":")[1]);
      return new Response(new Uint8Array(sizes[index]! * 1024 ** 2).fill(identical ? 1 : index + 1));
    });
    const timeline = createNode("timeline").data.timeline!;
    timeline.fonts = sizes.map((_, index) => ({ id: `font-${index}`, title: "Fixture", src: `fixture:${index}`, mimeType: "font/ttf" }));
    timeline.overlays = sizes.map((_, index) => ({ id: `text-${index}`, fontId: `font-${index}`, text: "A", start: 0, end: 1, x: 0, y: 0, maxWidth: 1, style: { fontSize: 18, color: "#FFFFFF", align: "left", lineHeight: 1 } }));
    assert.equal(RULE_FACTS.timelineFontTotalBytes, 64 * 1024 ** 2);
    if (rejected) {
      await assert.rejects(prepareTimelineFonts(timeline, new AbortController().signal));
      assert.equal(loads, 2, "reject before loading the over-budget face");
      assert.equal(faces.size, 0, "failed preparation disposes its earlier faces");
    } else {
      const session = await prepareTimelineFonts(timeline, new AbortController().signal);
      assert.equal(loads, sizes.length);
      if (identical) assert.equal(session.family("font-0"), session.family("font-2"));
      session.dispose();
      assert.equal(faces.size, 0);
    }
  });
}
