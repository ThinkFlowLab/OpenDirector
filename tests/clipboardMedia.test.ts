import assert from "node:assert/strict";
import test from "node:test";
import {
  captureClipboardMedia,
  transferClipboardMedia,
  type MediaSource,
  type RegisteredMedia,
} from "../src/canvas/clipboardMedia.ts";
import { createNode } from "../src/canvas/model.ts";
import type { CanvasFragment } from "../src/canvas/operations.ts";

test("clipboard reads carry the original MIME type instead of the preview's type", async () => {
  const node = createNode("image", undefined, { src: "blob:preview", mimeType: "image/heic" });
  const fragment: CanvasFragment = { nodes: [node], edges: [] };
  const media = captureClipboardMedia("project", fragment, {
    read: async (src, mimeType) => {
      assert.equal(src, "blob:preview");
      assert.equal(mimeType, "image/heic");
      throw Error("original unavailable");
    },
  });
  await assert.rejects(transferClipboardMedia(fragment, media, "target", async () => {
    assert.fail("a preview must not be registered as the original");
  }), /original unavailable/);
});

function fixture() {
  const image = URL.createObjectURL(new Blob(["png"], { type: "image/png" }));
  const video = URL.createObjectURL(new Blob(["mp4"], { type: "video/mp4" }));
  const portrait = URL.createObjectURL(
    new Blob(["jpg"], { type: "image/jpeg" }),
  );
  const generated = createNode(
    "image",
    { x: 0, y: 0 },
    {
      title: "生成图片",
      src: image,
      backendAssetId: "source-image",
      copiedSourceId: "source-item",
      mediaRole: "generation",
      prompt: "雨夜街道",
      taskDraft: undefined,
    },
  );
  const clip = createNode(
    "video",
    { x: 400, y: 0 },
    {
      title: "镜头",
      src: video,
      backendAssetId: "source-video",
      mediaRole: "generation",
      prompt: "推镜",
    },
  );
  const subject = createNode(
    "subject",
    { x: 800, y: 0 },
    {
      title: "主角",
      subject: {
        description: "",
        category: "人物",
        main: {
          id: "main",
          assetId: "source-portrait",
          kind: "image",
          title: "正脸",
          src: portrait,
        },
        auxiliaries: [],
      },
    },
  );
  const fragment: CanvasFragment = {
    nodes: [generated, clip, subject],
    edges: [
      { id: "into-image", source: subject.id, target: generated.id },
      { id: "into-video", source: generated.id, target: clip.id },
    ],
  };
  return { fragment, urls: [image, video, portrait], generated, clip, subject };
}

function registrar() {
  const calls: { title: string; kind: string; type: string }[] = [];
  const register = async (
    blob: Blob,
    title: string,
    kind: string,
  ): Promise<RegisteredMedia> => {
    calls.push({ title, kind, type: blob.type });
    return {
      assetId: `target-${calls.length}`,
      src: `blob:target/${calls.length}`,
    };
  };
  return { calls, register };
}

test("copied media survives the source project revoking its object URLs", async () => {
  const { fragment, urls, generated, clip, subject } = fixture();
  const media = captureClipboardMedia("project-a", fragment);
  // Switching canvases closes the source client, which revokes every preview URL.
  for (const url of urls) URL.revokeObjectURL(url);
  const { calls, register } = registrar();
  const pasted = await transferClipboardMedia(
    fragment,
    media,
    "project-b",
    register,
  );
  assert.deepEqual(calls, [
    { title: "生成图片", kind: "image", type: "image/png" },
    { title: "镜头", kind: "video", type: "video/mp4" },
    { title: "正脸", kind: "image", type: "image/jpeg" },
  ]);
  const [image, video, person] = pasted.nodes;
  assert.equal(image!.data.src, "blob:target/1");
  assert.equal(image!.data.backendAssetId, "target-1");
  assert.equal(image!.data.copiedSourceId, undefined);
  assert.equal(video!.data.src, "blob:target/2");
  assert.equal(video!.data.backendAssetId, "target-2");
  assert.deepEqual(
    [person!.data.subject!.main!.src, person!.data.subject!.main!.assetId],
    ["blob:target/3", "target-3"],
  );
  // The clipboard itself stays untouched for later pastes.
  assert.equal(generated.data.backendAssetId, "source-image");
  assert.equal(subject.data.subject!.main!.assetId, "source-portrait");
  assert.equal(clip.data.src, urls[1]);
});

test("a generated image pastes into another project as material without its task", async () => {
  const { fragment } = fixture();
  const media = captureClipboardMedia("project-a", fragment);
  const pasted = await transferClipboardMedia(
    fragment,
    media,
    "project-b",
    registrar().register,
  );
  const [image, video] = pasted.nodes;
  assert.equal(image!.data.mediaRole, "asset");
  assert.equal(image!.data.prompt, "");
  assert.equal(image!.data.settings, undefined);
  // Generated videos may keep their configuration over imported media.
  assert.equal(video!.data.mediaRole, "generation");
  assert.equal(video!.data.prompt, "推镜");
  // A material image cannot receive references; its outgoing reference stays.
  assert.deepEqual(
    pasted.edges.map((edge) => edge.id),
    ["into-video"],
  );
});

test("repeated pastes reuse registrations and a failed one can be retried", async () => {
  const { fragment } = fixture();
  const media = captureClipboardMedia("project-a", fragment);
  let fail = true;
  const { calls, register } = registrar();
  const flaky = (blob: Blob, title: string, kind: string) => {
    if (kind === "video" && fail) return Promise.reject(new Error("上传失败"));
    return register(blob, title, kind);
  };
  await assert.rejects(
    transferClipboardMedia(fragment, media, "project-b", flaky),
    /上传失败/,
  );
  assert.equal(calls.length, 2);
  fail = false;
  const pasted = await transferClipboardMedia(
    fragment,
    media,
    "project-b",
    flaky,
  );
  assert.deepEqual(
    calls.map((call) => call.kind),
    ["image", "image", "video"],
  );
  assert.equal(pasted.nodes[1]!.data.backendAssetId, "target-3");
  await transferClipboardMedia(fragment, media, "project-b", flaky);
  assert.equal(calls.length, 3);
  await transferClipboardMedia(fragment, media, "project-c", flaky);
  assert.equal(calls.length, 6);
});

test("an unreadable copy fails the paste instead of inserting broken nodes", async () => {
  const { fragment } = fixture();
  const media = captureClipboardMedia("project-a", fragment, {
    read: async (src) => {
      if (src === fragment.nodes[1]!.data.src)
        throw new Error("素材读取失败。");
      return new Blob(["x"], { type: "image/png" });
    },
  });
  await assert.rejects(
    transferClipboardMedia(fragment, media, "project-b", registrar().register),
    /素材读取失败/,
  );
});

test("saved source assets are offered for a server-side copy", async () => {
  const { fragment, clip } = fixture();
  // A just-imported node shows its upload before it records the asset.
  delete clip.data.backendAssetId;
  const byId = new Map([["source-image", "sha256:image"]]);
  const bySource = new Map([[clip.data.src!, "source-video"]]);
  const resolved: [string, string | undefined][] = [];
  const media = captureClipboardMedia("project-a", fragment, {
    resolve: (src, assetId) => {
      resolved.push([src, assetId]);
      const id = assetId ?? bySource.get(src);
      if (id === "source-image")
        return { assetId: id, fingerprint: byId.get(id)! };
      if (id === "source-video")
        return { assetId: id, fingerprint: "sha256:video" };
      // The portrait is unknown to the project, so it can only be uploaded.
      return undefined;
    },
  });
  assert.deepEqual(
    resolved.map(([, assetId]) => assetId),
    ["source-image", undefined, "source-portrait"],
  );
  const sources: (MediaSource | undefined)[] = [];
  const pasted = await transferClipboardMedia(
    fragment,
    media,
    "project-b",
    async (_blob, title, _kind, source) => {
      sources.push(source);
      return { assetId: `copy-of-${title}`, src: `blob:target/${title}` };
    },
  );
  assert.deepEqual(sources, [
    {
      projectId: "project-a",
      assetId: "source-image",
      fingerprint: "sha256:image",
    },
    {
      projectId: "project-a",
      assetId: "source-video",
      fingerprint: "sha256:video",
    },
    undefined,
  ]);
  assert.equal(pasted.nodes[1]!.data.backendAssetId, "copy-of-镜头");
  assert.equal(pasted.nodes[2]!.data.subject!.main!.assetId, "copy-of-正脸");
});
