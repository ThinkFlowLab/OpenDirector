import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  buildCanvasArchive,
  readCanvasArchive,
} from "../src/canvas/canvasArchive.ts";
import { createDocument, createNode } from "../src/canvas/model.ts";
import { crc32, createZip, readZip } from "../src/canvas/zipArchive.ts";

interface Entry {
  name: string;
  method: number;
  bytes: Uint8Array;
  storedCrc: number;
}

/** Reads a stored-or-deflated ZIP through its central directory. */
async function openEntries(blob: Blob): Promise<Entry[]> {
  const buffer = await blob.arrayBuffer();
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let end = -1;
  for (let index = bytes.length - 22; index >= 0; index--)
    if (view.getUint32(index, true) === 0x06054b50) {
      end = index;
      break;
    }
  assert.notEqual(end, -1, "archive has no end-of-central-directory record");
  const count = view.getUint16(end + 10, true);
  assert.equal(view.getUint16(end + 8, true), count);
  let offset = view.getUint32(end + 16, true);
  const entries: Entry[] = [];
  for (let index = 0; index < count; index++) {
    assert.equal(
      view.getUint32(offset, true),
      0x02014b50,
      "bad central header",
    );
    const method = view.getUint16(offset + 10, true);
    const storedCrc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    assert.equal(view.getUint32(local, true), 0x04034b50, "bad local header");
    const start =
      local +
      30 +
      view.getUint16(local + 26, true) +
      view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + compressedSize);
    const payload =
      method === 0
        ? raw
        : new Uint8Array(
            await new Response(
              new Blob([raw as BlobPart])
                .stream()
                .pipeThrough(new DecompressionStream("deflate-raw")),
            ).arrayBuffer(),
          );
    entries.push({ name, method, bytes: payload, storedCrc });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const decode = (entry: Entry) => new TextDecoder().decode(entry.bytes);

test("canvas archive separates media files from the document and names itself .canvas", async () => {
  const document = createDocument("断不了情根");
  const image = createNode(
    "image",
    { x: 10, y: 20 },
    {
      src: "data:image/jpeg;base64,aGVsbG8=",
      mimeType: "image/jpeg",
      title: "女王1.jpg",
    },
  );
  const video = createNode(
    "video",
    { x: 400, y: 20 },
    {
      src: "data:video/mp4;base64,dmlkZW8=",
      mimeType: "video/mp4",
      title: "原版_时长裁剪.mp4",
    },
  );
  document.nodes = [image, video];
  const now = new Date("2026-11-02T01:30:18.000Z");
  const archive = await buildCanvasArchive(document, {
    read: async (src) =>
      new Blob(
        [Uint8Array.from(atob(src.split(",")[1]!), (c) => c.charCodeAt(0))],
        {
          type: /^data:([^;]+)/.exec(src)![1],
        },
      ),
    now,
  });
  assert.equal(archive.filename, "断不了情根.canvas");
  assert.equal(archive.blob.type, "application/zip");
  const entries = await openEntries(archive.blob);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    [
      "manifest.json",
      "canvas.json",
      "assets/女王1.jpg",
      "assets/原版_时长裁剪.mp4",
    ],
  );
  const manifest = JSON.parse(decode(entries[0]!));
  assert.deepEqual(manifest, {
    magic: "opendirector-canvas",
    formatVersion: 2,
    name: "断不了情根",
    exportedAt: "2026-11-02T01:30:18.000Z",
    document: "canvas.json",
    assets: manifest.assets,
  });
  assert.deepEqual(
    manifest.assets.map(
      (asset: { path: string; mimeType: string; byteSize: number }) => [
        asset.path,
        asset.mimeType,
        asset.byteSize,
      ],
    ),
    [
      ["assets/女王1.jpg", "image/jpeg", 5],
      ["assets/原版_时长裁剪.mp4", "video/mp4", 5],
    ],
  );
  const contents: Record<string, string> = {
    "assets/女王1.jpg": "hello",
    "assets/原版_时长裁剪.mp4": "video",
  };
  for (const asset of manifest.assets as { path: string; sha256: string }[])
    assert.equal(
      asset.sha256,
      createHash("sha256")
        .update(Buffer.from(contents[asset.path]!))
        .digest("hex"),
      asset.path,
    );
  const saved = JSON.parse(decode(entries[1]!));
  assert.equal(saved.nodes[0].data.src, "assets/女王1.jpg");
  assert.equal(saved.nodes[1].data.src, "assets/原版_时长裁剪.mp4");
  assert.equal(saved.title, "断不了情根");
  assert.doesNotMatch(decode(entries[1]!), /data:(image|video)\//);
  assert.deepEqual(
    [...entries[2]!.bytes],
    [...new TextEncoder().encode("hello")],
  );
  for (const entry of entries)
    assert.equal(entry.storedCrc, crc32(entry.bytes), `${entry.name} checksum`);
  const compressed = entries
    .filter((entry) => entry.method === 8)
    .map((entry) => entry.name);
  assert.deepEqual(compressed, ["manifest.json", "canvas.json"]);
});

test("identical media bytes are stored once even under different references", async () => {
  const document = createDocument("去重");
  document.nodes = [
    createNode(
      "image",
      { x: 0, y: 0 },
      {
        src: "data:image/jpeg;base64,aGVsbG8=",
        mimeType: "image/jpeg",
        title: "女王1.jpg",
      },
    ),
    createNode(
      "image",
      { x: 300, y: 0 },
      {
        src: "data:image/webp;base64,aGVsbG8=",
        mimeType: "image/webp",
        title: "女王2.webp",
      },
    ),
  ];
  const archive = await buildCanvasArchive(document, {
    read: async (src) =>
      new Blob([
        Uint8Array.from(atob(src.split(",")[1]!), (c) => c.charCodeAt(0)),
      ]),
  });
  const entries = await openEntries(archive.blob);
  assert.deepEqual(archive.assets, ["assets/女王1.jpg"]);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["manifest.json", "canvas.json", "assets/女王1.jpg"],
  );
  const saved = JSON.parse(decode(entries[1]!));
  assert.deepEqual(
    saved.nodes.map((node: { data: { src: string } }) => node.data.src),
    ["assets/女王1.jpg", "assets/女王1.jpg"],
  );
});

test("temporary object URLs are read once per source and never leave blob references behind", async () => {
  const document = createDocument("临时素材");
  const source = "blob:http://127.0.0.1:8000/7c1f0f6e";
  document.nodes = [
    createNode(
      "image",
      { x: 0, y: 0 },
      { src: source, mimeType: "image/png", title: "原版.png" },
    ),
    createNode(
      "image",
      { x: 300, y: 0 },
      { src: source, mimeType: "image/png", title: "副本.png" },
    ),
  ];
  const reads: string[] = [];
  const archive = await buildCanvasArchive(document, {
    read: async (src) => {
      reads.push(src);
      return new Blob([new TextEncoder().encode("bytes")], {
        type: "image/png",
      });
    },
  });
  assert.deepEqual(reads, [source]);
  const entries = await openEntries(archive.blob);
  const saved = decode(entries[1]!);
  assert.doesNotMatch(saved, /blob:/);
  assert.deepEqual(
    JSON.parse(saved).nodes.map(
      (node: { data: { src: string } }) => node.data.src,
    ),
    ["assets/原版.png", "assets/原版.png"],
  );
});

test("an unreadable asset aborts the export instead of writing an incomplete archive", async () => {
  const document = createDocument("失败");
  document.nodes = [
    createNode(
      "image",
      { x: 0, y: 0 },
      {
        src: "blob:http://127.0.0.1:8000/missing",
        mimeType: "image/png",
        title: "丢失.png",
      },
    ),
  ];
  await assert.rejects(
    buildCanvasArchive(document, {
      read: async () => {
        throw new Error("无法读取画布素材，未导出不完整的副本。");
      },
    }),
    /未导出不完整的副本/,
  );
});

test("adopted generation outputs are exported as asset files too", async () => {
  const document = createDocument("证据");
  const output = "data:video/mp4;base64,b3V0cHV0";
  document.nodes = [
    createNode(
      "video",
      { x: 0, y: 0 },
      {
        src: "data:video/mp4;base64,c291cmNl",
        mimeType: "video/mp4",
        title: "视频 2",
        generationEvidence: {
          output,
          references: { "reference-1": "asset-1" },
        },
      },
    ),
  ];
  const archive = await buildCanvasArchive(document, {
    read: async (src) =>
      new Blob(
        [Uint8Array.from(atob(src.split(",")[1]!), (c) => c.charCodeAt(0))],
        {
          type: "video/mp4",
        },
      ),
  });
  const entries = await openEntries(archive.blob);
  assert.deepEqual(archive.assets, [
    "assets/视频_2.mp4",
    "assets/视频_2-2.mp4",
  ]);
  const saved = JSON.parse(decode(entries[1]!));
  assert.equal(saved.nodes[0].data.src, "assets/视频_2.mp4");
  assert.equal(
    saved.nodes[0].data.generationEvidence.output,
    "assets/视频_2-2.mp4",
  );
  assert.deepEqual(saved.nodes[0].data.generationEvidence.references, {
    "reference-1": "asset-1",
  });
});

test("an exported archive imports back with its media, settings and edges", async () => {
  const document = createDocument("往返");
  const image = createNode(
    "image",
    { x: 0, y: 0 },
    {
      src: "data:image/jpeg;base64,aGVsbG8=",
      mimeType: "image/jpeg",
      title: "女王1.jpg",
    },
  );
  const video = createNode(
    "video",
    { x: 400, y: 0 },
    {
      src: "data:video/mp4;base64,dmlkZW8=",
      mimeType: "video/mp4",
      title: "原版.mp4",
    },
  );
  document.nodes = [image, video];
  document.edges = [
    {
      id: "edge-1",
      source: image.id,
      target: video.id,
      sourceHandle: null,
      targetHandle: "reference",
    },
  ];
  const archive = await buildCanvasArchive(document, {
    read: async (src) =>
      new Blob(
        [Uint8Array.from(atob(src.split(",")[1]!), (c) => c.charCodeAt(0))],
        { type: /^data:([^;]+)/.exec(src)![1] },
      ),
  });
  const contents = await readCanvasArchive(archive.blob);
  assert.equal(contents.assets, 2);
  assert.deepEqual(contents.document, document);
});

test("a generation node keeps the provenance its picture was exported with", async () => {
  const document = createDocument("生成节点往返");
  // The node the importer used to fabricate a materialOverride for.
  const generated = createNode(
    "image",
    { x: 0, y: 0 },
    {
      src: "data:image/png;base64,aGVsbG8=",
      mimeType: "image/png",
      title: "图片生成.png",
      mediaRole: "generation",
      generationProvenance: {
        source: "generated",
        jobId: "6f1d1f3e-0000-4000-8000-000000000000",
        inputFingerprint: "a".repeat(64),
      },
    },
  );
  // A plain upload must not pick up someone else's provenance.
  const uploaded = createNode(
    "image",
    { x: 400, y: 0 },
    {
      src: "data:image/jpeg;base64,d29ybGQ=",
      mimeType: "image/jpeg",
      title: "素材.jpg",
      mediaRole: "asset",
    },
  );
  document.nodes = [generated, uploaded];
  const archive = await buildCanvasArchive(document, {
    read: async (src) =>
      new Blob(
        [Uint8Array.from(atob(src.split(",")[1]!), (c) => c.charCodeAt(0))],
        { type: /^data:([^;]+)/.exec(src)![1] },
      ),
  });
  const contents = await readCanvasArchive(archive.blob);

  const generatedUrl = (contents.document.nodes[0]!.data as { src: string })
    .src;
  const uploadedUrl = (contents.document.nodes[1]!.data as { src: string }).src;
  assert.deepEqual(contents.provenance.get(generatedUrl), {
    source: "generated",
    jobId: "6f1d1f3e-0000-4000-8000-000000000000",
    inputFingerprint: "a".repeat(64),
  });
  assert.equal(contents.provenance.has(uploadedUrl), false);
});

test("a version 1 archive still imports, without inventing provenance", async () => {
  const document = createDocument("旧包");
  document.nodes = [
    createNode(
      "image",
      { x: 0, y: 0 },
      {
        src: "data:image/png;base64,aGVsbG8=",
        mimeType: "image/png",
        title: "旧图.png",
        mediaRole: "generation",
      },
    ),
  ];
  const archive = await buildCanvasArchive(document, {
    read: async (src) =>
      new Blob(
        [Uint8Array.from(atob(src.split(",")[1]!), (c) => c.charCodeAt(0))],
        { type: /^data:([^;]+)/.exec(src)![1] },
      ),
  });
  // Rewrite the manifest the way a v1 exporter would have written it.
  const files = await readZip(archive.blob);
  const manifest = JSON.parse(
    new TextDecoder().decode(files.get("manifest.json")!),
  );
  manifest.formatVersion = 1;
  for (const asset of manifest.assets) delete asset.provenance;
  const rebuilt = await createZip(
    [
      {
        path: "manifest.json",
        data: new TextEncoder().encode(JSON.stringify(manifest)),
        compress: true,
      },
      { path: "canvas.json", data: files.get("canvas.json")! },
      ...[...files.entries()]
        .filter(([path]) => path.startsWith("assets/"))
        .map(([path, data]) => ({ path, data })),
    ],
    new Date(),
  );
  const contents = await readCanvasArchive(rebuilt);
  assert.equal(contents.assets, 1);
  assert.equal(contents.provenance.size, 0);
});

test("import reports missing assets, foreign archives and newer formats", async () => {
  const document = createDocument("损坏");
  document.nodes = [
    createNode(
      "image",
      { x: 0, y: 0 },
      {
        src: "data:image/png;base64,aGVsbG8=",
        mimeType: "image/png",
        title: "女王1.png",
      },
    ),
  ];
  const archive = await buildCanvasArchive(document, {
    read: async () =>
      new Blob([Uint8Array.from(atob("aGVsbG8="), (c) => c.charCodeAt(0))], {
        type: "image/png",
      }),
  });
  const entries = await openEntries(archive.blob);
  const manifest = JSON.parse(decode(entries[0]!));
  const saved = JSON.parse(decode(entries[1]!));
  const build = (next: Record<string, unknown>, media: [string, string][]) =>
    createZip([
      {
        path: "manifest.json",
        data: new TextEncoder().encode(
          JSON.stringify({ ...manifest, ...next }),
        ),
        compress: true,
      },
      {
        path: "canvas.json",
        data: new TextEncoder().encode(JSON.stringify(saved)),
        compress: true,
      },
      ...media.map(([path, text]) => ({
        path,
        data: new TextEncoder().encode(text),
      })),
    ]);

  await assert.rejects(
    readCanvasArchive(await build({}, [])),
    /画布引用的素材缺失：assets\/女王1\.png/,
  );
  await assert.rejects(
    readCanvasArchive(await build({ magic: "minimax-hub-project" }, [])),
    /这不是 OpenDirector 画布压缩包/,
  );
  await assert.rejects(
    readCanvasArchive(await build({ formatVersion: 99 }, [])),
    /更新版本的 OpenDirector 导出/,
  );
  await assert.rejects(
    readCanvasArchive(new Blob([new TextEncoder().encode("not a zip")])),
    /不是有效的 \.canvas 压缩包/,
  );
});

test("zip reading verifies checksums and rejects damaged entries", async () => {
  const blob = await createZip([
    {
      path: "canvas.json",
      data: new TextEncoder().encode('{"version":1}'),
      compress: true,
    },
    { path: "assets/a.bin", data: new Uint8Array([1, 2, 3]) },
  ]);
  const files = await readZip(blob);
  assert.deepEqual([...files.keys()], ["canvas.json", "assets/a.bin"]);
  assert.equal(
    new TextDecoder().decode(files.get("canvas.json")!),
    '{"version":1}',
  );
  assert.deepEqual([...files.get("assets/a.bin")!], [1, 2, 3]);

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const text = new TextDecoder("latin1").decode(bytes);
  const start = text.indexOf("assets/a.bin") + "assets/a.bin".length;
  bytes[start] = bytes[start]! ^ 0xff;
  await assert.rejects(readZip(bytes), /校验失败|已损坏/);
});

function textDocument() {
  const document = createDocument("Text archive");
  const node = createNode("timeline");
  const asset = (id: string, kind: "file" | "text") => ({
    assetId: id,
    revision: 1,
    fingerprint: `sha256:${"a".repeat(64)}`,
    kind,
  });
  node.data.timeline!.fonts = [
    {
      id: "font-a",
      title: "Font.otf",
      src: "data:font/otf;base64,AQID",
      mimeType: "font/otf",
      asset: asset("00000000-0000-0000-0000-000000087601", "file"),
    },
    {
      id: "font-b",
      title: "Font.otf",
      src: "data:font/otf;base64,AQID",
      mimeType: "font/otf",
      asset: asset("00000000-0000-0000-0000-000000087602", "file"),
    },
  ];
  node.data.timeline!.overlays = ["a", "b"].map((id, index) => ({
    id,
    text: "中 English",
    start: 0,
    end: 1,
    x: 0,
    y: 0,
    maxWidth: 1,
    fontId: `font-${id}`,
    style: {
      fontSize: 24,
      color: "#FFFFFF",
      align: "left" as const,
      lineHeight: 1,
    },
    source: {
      title: "Source.txt",
      src: "data:text/plain;base64,5Y6f5aeL5q2j5paH",
      mimeType: "text/plain",
      asset: asset(`00000000-0000-0000-0000-00000008760${index + 3}`, "text"),
    },
  }));
  document.nodes = [node];
  return document;
}

async function rebuildArchive(
  blob: Blob,
  change: (files: Map<string, Uint8Array>) => void,
) {
  const files = await readZip(blob);
  change(files);
  return createZip([...files].map(([path, data]) => ({ path, data })));
}

test("text canvas v3 preserves bytes, font slots and source identities while removing only restored foreign View refs", async () => {
  const document = textDocument();
  const sourceBlob = URL.createObjectURL(
    new Blob(["原始正文"], { type: "text/plain" }),
  );
  const fontBlob = URL.createObjectURL(
    new Blob([new Uint8Array([1, 2, 3])], { type: "font/otf" }),
  );
  document.nodes[0]!.data.timeline!.fonts![1]!.src = fontBlob;
  document.nodes[0]!.data.timeline!.overlays![1]!.source!.src = sourceBlob;
  try {
    const archive = await buildCanvasArchive(document);
    const files = await readZip(archive.blob);
    const manifest = JSON.parse(
      new TextDecoder().decode(files.get("manifest.json")),
    );
    assert.equal(manifest.formatVersion, 3);
    assert.deepEqual(manifest.requiredCapabilities, ["timeline.text.v1"]);
    assert.equal(archive.assets.length, 2, "same bytes share physical files");
    const restored = (await readCanvasArchive(archive.blob)).document.nodes[0]!
      .data.timeline!;
    assert.deepEqual(
      restored.fonts!.map((font) => font.id),
      ["font-a", "font-b"],
    );
    for (const font of restored.fonts!) {
      assert.equal(font.asset, undefined);
      assert.deepEqual(
        new Uint8Array(await (await fetch(font.src!)).arrayBuffer()),
        new Uint8Array([1, 2, 3]),
      );
    }
    for (const overlay of restored.overlays!) {
      assert.equal(overlay.source!.asset, undefined);
      assert.equal(
        await (await fetch(overlay.source!.src!)).text(),
        "原始正文",
      );
      assert.equal(overlay.text, "中 English");
    }
    assert.equal(
      document.nodes[0]!.data.timeline!.fonts![0]!.asset!.assetId,
      "00000000-0000-0000-0000-000000087601",
    );
  } finally {
    URL.revokeObjectURL(sourceBlob);
    URL.revokeObjectURL(fontBlob);
  }
});

test("canvas rejects unsupported text capabilities before document parsing and rejects unmarked text", async () => {
  const archive = await buildCanvasArchive(textDocument());
  const editManifest = (patch: object, invalidDocument = false) =>
    rebuildArchive(archive.blob, (files) => {
      const manifest = JSON.parse(
        new TextDecoder().decode(files.get("manifest.json")),
      );
      files.set(
        "manifest.json",
        new TextEncoder().encode(JSON.stringify({ ...manifest, ...patch })),
      );
      if (invalidDocument)
        files.set("canvas.json", new TextEncoder().encode("invalid JSON"));
    });
  await assert.rejects(
    readCanvasArchive(
      await editManifest(
        { requiredCapabilities: ["timeline.future.v9"] },
        true,
      ),
    ),
    /能力|capability/,
  );
  for (const patch of [
    { requiredCapabilities: [] },
    { requiredCapabilities: "timeline.text.v1" },
    { formatVersion: 2, requiredCapabilities: undefined },
  ])
    await assert.rejects(readCanvasArchive(await editManifest(patch)));
});

test("canvas text resources must have bytes and fail on missing or damaged bundled files", async () => {
  const document = textDocument();
  delete document.nodes[0]!.data.timeline!.fonts![0]!.src;
  await assert.rejects(buildCanvasArchive(document), /字体|font/);
  const archive = await buildCanvasArchive(textDocument());
  const missing = await rebuildArchive(archive.blob, (files) => {
    files.delete(archive.assets[0]!);
  });
  await assert.rejects(readCanvasArchive(missing), /素材缺失|missing/);
  const damaged = await rebuildArchive(archive.blob, (files) => {
    files.set(archive.assets[0]!, new Uint8Array([9, 8, 7]));
  });
  await assert.rejects(readCanvasArchive(damaged), /校验|integrity/);
});

test("restored same-byte logical sources register distinct target identities and reuse them on repeated projection", async () => {
  const { readFileSync } = await import("node:fs");
  const { CreationClient } = await import("../src/backend/creationClient.ts");
  const { CreationProjection } =
    await import("../src/backend/creationProjection.ts");
  const source = textDocument();
  // A third slot intentionally shares the first logical resource.
  source.nodes[0]!.data.timeline!.fonts!.push({
    ...source.nodes[0]!.data.timeline!.fonts![0]!,
    id: "font-shared",
  });
  const restored = (
    await readCanvasArchive((await buildCanvasArchive(source)).blob)
  ).document;
  const snapshot = JSON.parse(
    readFileSync(
      new URL("./fixtures/creation-project.json", import.meta.url),
      "utf8",
    ),
  );
  for (const key of [
    "assets",
    "canvasItems",
    "editorDocuments",
    "generationSpecs",
    "references",
    "jobs",
    "results",
  ])
    snapshot[key] = [];
  const client = new CreationClient(snapshot.project.id);
  client.install(snapshot);
  const projection = new CreationProjection(client);
  const baseline = createDocument();
  baseline.id = client.id;
  projection.baseline = baseline;
  projection.basis = snapshot;
  restored.id = client.id;
  const uploads: { id: string; body: Uint8Array; kind: string }[] = [];
  let nextId = 1;
  client.importBlob = async (blob, _name, kind) => {
    const id = `00000000-0000-0000-0000-${String(nextId++).padStart(12, "0")}`;
    const body = new Uint8Array(await blob.arrayBuffer());
    uploads.push({ id, body, kind });
    const fingerprint = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    return { assetId: id, revision: 1, fingerprint, kind };
  };
  const first = await projection.prepare(restored);
  const created = first.operations.find((op) => op.type === "editor.create")!;
  assert.equal(created.type, "editor.create");
  const timeline = created.payload.document;
  assert.equal(timeline.kind, "timeline");
  if (timeline.kind !== "timeline") throw new Error("Missing timeline");
  const fonts = timeline.data.fonts!;
  assert.notEqual(fonts[0]!.asset.assetId, fonts[1]!.asset.assetId);
  assert.equal(fonts[0]!.asset.assetId, fonts[2]!.asset.assetId);
  assert.notEqual(
    timeline.data.overlays![0]!.sourceAsset!.assetId,
    timeline.data.overlays![1]!.sourceAsset!.assetId,
  );
  assert.equal(uploads.length, 4);
  assert.deepEqual(
    uploads
      .filter((entry) => entry.kind === "file")
      .map((entry) => [...entry.body]),
    [
      [1, 2, 3],
      [1, 2, 3],
    ],
  );
  assert.doesNotMatch(JSON.stringify(timeline), /importIdentity|00000008760/);
  await projection.prepare(restored);
  assert.equal(
    uploads.length,
    4,
    "repeated save preparation reuses registered target refs",
  );
  const conflict = structuredClone(restored);
  conflict.nodes[0]!.data.timeline!.fonts![0]!.src =
    "data:font/otf;base64,CQgH";
  await assert.rejects(projection.prepare(conflict), /冲突|conflicting/);
  assert.equal(
    uploads.length,
    4,
    "conflicting immutable source input never registers another target",
  );
});

test("imported media is byte-identical at every padding and chunk boundary", async () => {
  // Sizes that end mid-group (padding), land on a group, and cross the 32 KB
  // blocks the encoder used to concatenate. `Buffer` is a separate decoder,
  // so it can only agree with the archive if the encoder wrote valid base64.
  const sizes = [0, 1, 2, 3, 4, 5, 6, 7, 32767, 32768, 32769, 65537, 200003];
  for (const size of sizes) {
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index++)
      bytes[index] = (index * 31 + 7) % 256;
    const document = createDocument(`边界 ${size}`);
    document.nodes = [
      createNode("image", { x: 0, y: 0 }, {
        src: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
        mimeType: "image/png",
        title: "边界.png",
      }),
    ];
    const archive = await buildCanvasArchive(document, {
      read: async () => new Blob([bytes as BlobPart], { type: "image/png" }),
    });
    const contents = await readCanvasArchive(archive.blob);
    const restored = (contents.document.nodes[0]!.data as { src: string }).src;
    assert.ok(
      restored.startsWith("data:image/png;base64,"),
      `${size} bytes keep their media type`,
    );
    const payload = restored.slice(restored.indexOf(",") + 1);
    assert.equal(
      Buffer.from(payload, "base64").toString("hex"),
      Buffer.from(bytes).toString("hex"),
      `${size} bytes round trip unchanged`,
    );
  }
});
