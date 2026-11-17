import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyImportFile,
  readEditorResource,
  withMediaDuration,
} from "../src/canvas/editorMedia.ts";
import type { CanvasResource } from "../src/canvas/model.ts";

const resource: CanvasResource = {
  id: "recorded",
  kind: "video",
  title: "Recorded WebM",
  src: "data:video/webm;base64,fixture",
  mimeType: "video/webm",
};

test("imports fall back only for missing or generic MIME and preserve explicit types", () => {
  for (const type of ["", "application/octet-stream"]) {
    for (const [name, kind, mimeType] of [
      ["portrait.JPG", "image", "image/jpeg"],
      ["portrait.HEIC", "image", "image/heic"],
      ["portrait.heif", "image", "image/heif"],
      ["clip.MOV", "video", "video/quicktime"],
      ["voice.wav", "audio", "audio/wav"],
    ])
      assert.deepEqual(classifyImportFile({ name: name!, type }), {
        kind,
        mimeType,
      });
  }
  assert.deepEqual(
    classifyImportFile({ name: "photo.jpg", type: "application/pdf" }),
    { kind: "file", mimeType: "application/pdf" },
  );
  assert.deepEqual(
    classifyImportFile({ name: "photo.bin", type: " IMAGE/PNG " }),
    { kind: "image", mimeType: "image/png" },
  );
  assert.deepEqual(classifyImportFile({ name: "unknown.xyz", type: "" }), {
    kind: "file",
    mimeType: "",
  });
  assert.deepEqual(classifyImportFile({ name: "png", type: "" }), {
    kind: "file",
    mimeType: "",
  });
});

test("normalized import MIME reaches both the data URL reader and retained media metadata", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
  class Reader {
    onload: (() => void) | null = null;
    onerror = null;
    onabort = null;
    result = "";
    readAsDataURL(blob: Blob) {
      assert.equal(blob.type, "video/quicktime");
      this.result = `data:${blob.type};base64,fixture`;
      queueMicrotask(() => this.onload?.());
    }
  }
  Object.defineProperty(globalThis, "FileReader", {
    value: Reader,
    configurable: true,
  });
  try {
    await loaderFixture(2, async () => {
      const imported = await readEditorResource(
        new File(["fixture"], "clip.MOV", { type: "application/octet-stream" }),
      );
      assert.equal(imported.kind, "video");
      assert.equal(imported.mimeType, "video/quicktime");
      assert.match(imported.src!, /^data:video\/quicktime;/);
      assert.equal(imported.durationSeconds, 2);
    });
  } finally {
    if (previous) Object.defineProperty(globalThis, "FileReader", previous);
    else Reflect.deleteProperty(globalThis, "FileReader");
  }
});
async function loaderFixture(
  initialDuration: number,
  run: (getElement: () => Video) => Promise<void>,
) {
  class Media {
    duration = initialDuration;
    currentTime = 0;
    preload = "";
    muted = false;
    pauses = 0;
    releases = 0;
    loads = 0;
    onloadedmetadata: (() => void) | null = null;
    ondurationchange: (() => void) | null = null;
    onseeked: (() => void) | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      queueMicrotask(() => this.onloadedmetadata?.());
    }
    pause() {
      this.pauses++;
    }
    removeAttribute(name: string) {
      assert.equal(name, "src");
      this.releases++;
    }
    load() {
      this.loads++;
    }
  }
  class Video extends Media {
    videoWidth = 360;
    videoHeight = 360;
  }
  class Image {}
  let element: Video;
  const replacements: Record<string, unknown> = {
    HTMLMediaElement: Media,
    HTMLVideoElement: Video,
    HTMLImageElement: Image,
    Image,
    document: {
      createElement: (kind: string) => {
        assert.equal(kind, "video");
        element = new Video();
        return element;
      },
    },
  };
  const previous = new Map(
    Object.keys(replacements).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(replacements))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  try {
    await run(() => element!);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}
// The fixture exposes the browser-produced duration separately from currentTime.
type Video = {
  duration: number;
  currentTime: number;
  preload: string;
  muted: boolean;
  pauses: number;
  releases: number;
  loads: number;
  onloadedmetadata: (() => void) | null;
  ondurationchange: (() => void) | null;
  onseeked: (() => void) | null;
  onerror: (() => void) | null;
};

test("finite browser duration is retained with actual output dimensions", async () => {
  await loaderFixture(3.137, async (get) => {
    const result = await withMediaDuration(resource);
    assert.equal(result.durationSeconds, 3.137);
    assert.equal(result.width, 360);
    assert.equal(result.height, 360);
    assert.equal(get().currentTime, 0);
    assert.equal(get().releases, 1);
  });
});

test("unindexed WebM waits for browser duration after tail seeking, not the selected range or seek position", async () => {
  await loaderFixture(Infinity, async (get) => {
    let settled = false;
    const pending = withMediaDuration({
      ...resource,
      durationSeconds: Infinity,
      width: 360,
      height: 360,
    });
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    const element = get();
    assert.equal(element.currentTime, Number.MAX_SAFE_INTEGER);
    assert.equal(element.preload, "auto");
    element.currentTime = 3;
    element.onseeked?.();
    await Promise.resolve();
    assert.equal(settled, false);
    element.duration = 3.027;
    element.ondurationchange?.();
    const actual = await pending;
    assert.equal(actual.durationSeconds, 3.027);
    assert.equal(element.onloadedmetadata, null);
    assert.equal(element.ondurationchange, null);
    assert.equal(element.onseeked, null);
    assert.equal(element.releases, 1);
    assert.equal(element.pauses, 1);
  });
});

test("cancelling duration discovery releases the loader and prevents a late measured result", async () => {
  await loaderFixture(Infinity, async (get) => {
    const controller = new AbortController();
    const pending = withMediaDuration(resource, controller.signal);
    await Promise.resolve();
    const element = get();
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    element.duration = 3;
    assert.equal(element.ondurationchange, null);
    assert.equal(element.onseeked, null);
    assert.equal(element.onerror, null);
    assert.equal(element.releases, 1);
    assert.equal(element.loads, 1);
  });
});

test("a decode error during tail discovery rejects instead of inventing a duration", async () => {
  await loaderFixture(Infinity, async (get) => {
    const pending = withMediaDuration(resource);
    await Promise.resolve();
    get().onerror?.();
    await assert.rejects(pending, /元数据/);
    assert.equal(get().onseeked, null);
    assert.equal(get().releases, 1);
  });
});
