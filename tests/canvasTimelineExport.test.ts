import assert from "node:assert/strict";
import test from "node:test";
import { crc32 } from "node:zlib";
import { readFileSync } from "node:fs";
import { createNode } from "../src/canvas/model.ts";
import { addTimelineClip, updateTimelineClip } from "../src/canvas/timeline.ts";
import {
  createTimelineZip,
  exportTimelineFcpxml,
  exportTimelinePackage,
  fcpxmlTime,
  timelineExportAssets,
} from "../src/canvas/timelineExport.ts";

function timeline() {
  let data = createNode("timeline").data.timeline!;
  data = addTimelineClip(data, {
    id: "video",
    title: 'A & <B> "shot".mp4',
    kind: "video",
    src: "data:video/mp4;base64,AQID",
    mimeType: "video/mp4",
    durationSeconds: 12,
    width: 640,
    height: 360,
  });
  data = updateTimelineClip(data, data.tracks[0]!.clips[0]!.id, {
    inPoint: 2,
    outPoint: 10,
    speed: 2,
    volume: 0.5,
  });
  data = addTimelineClip(data, {
    id: "audio",
    title: "声音.wav",
    kind: "audio",
    src: "data:audio/wav;base64,BAUG",
    durationSeconds: 3,
  });
  data = updateTimelineClip(data, data.tracks[1]!.clips[0]!.id, {
    start: 2,
    muted: true,
  });
  return data;
}

test("HEIF timeline packages keep original bytes and matching file extensions", async () => {
  for (const suffix of ["heic", "heif"]) {
    const bytes = readFileSync(new URL(`./fixtures/heif/oriented.${suffix}`, import.meta.url));
    const data = addTimelineClip(createNode("timeline").data.timeline!, {
      id: "photo", title: "Photo", kind: "image", width: 192, height: 320,
      mimeType: `image/${suffix}`, src: `data:image/${suffix};base64,${bytes.toString("base64")}`,
    });
    const [asset] = timelineExportAssets(data);
    assert.ok(asset!.path.endsWith(`.${suffix}`));
    const blob = await exportTimelinePackage(data, "Photo", new AbortController().signal);
    const files = unzipStored(new Uint8Array(await blob.arrayBuffer()));
    assert.deepEqual(Buffer.from(files.get(asset!.path)!), bytes);
  }
});
function unzipStored(bytes: Uint8Array) {
  const result = new Map<string, Uint8Array>();
  let cursor = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (view.getUint32(cursor, true) === 0x04034b50) {
    assert.equal(view.getUint16(cursor + 8, true), 0);
    assert.equal(view.getUint16(cursor + 6, true) & 0x800, 0x800);
    const size = view.getUint32(cursor + 18, true),
      nameLength = view.getUint16(cursor + 26, true),
      extra = view.getUint16(cursor + 28, true);
    const name = new TextDecoder().decode(
      bytes.subarray(cursor + 30, cursor + 30 + nameLength),
    );
    const start = cursor + 30 + nameLength + extra,
      content = bytes.subarray(start, start + size);
    assert.equal(crc32(content), view.getUint32(cursor + 14, true));
    result.set(name, content);
    cursor = start + size;
  }
  assert.equal(view.getUint32(cursor, true), 0x02014b50);
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50);
  assert.equal(view.getUint16(bytes.length - 12, true), result.size);
  assert.equal(view.getUint32(bytes.length - 6, true), cursor);
  return result;
}

test("FCPXML describes source trim, retiming, explicit audio placement, mute and escaped names", () => {
  const xml = exportTimelineFcpxml(timeline(), '项目 & "一"');
  assert.match(xml, /<fcpxml version="1.10">/);
  assert.match(xml, /name="项目 &amp; &quot;一&quot;"/);
  assert.match(xml, /start="1s" duration="4s"/);
  assert.match(xml, /<timept time="6s" value="12s" interp="linear"/);
  assert.match(xml, /adjust-volume amount="-6.020600dB"/);
  assert.match(
    xml,
    /lane="-1" offset="2s" start="0s" duration="3s" enabled="0"/,
  );
  assert.match(
    xml,
    /<gap name="Timeline" offset="0s" start="0s" duration="5s"/,
  );
  assert.doesNotMatch(xml, /data:video/);
  assert.equal(fcpxmlTime(1.25), "5/4s");
  assert.throws(() => fcpxmlTime(Infinity), /范围/);
});

test("ZIP package contains matching relative XML paths and unchanged media bytes", async () => {
  const data = timeline(),
    assets = timelineExportAssets(data);
  const packageBlob = await exportTimelinePackage(
    data,
    "Portable",
    new AbortController().signal,
  );
  const files = unzipStored(new Uint8Array(await packageBlob.arrayBuffer()));
  assert.deepEqual(files.get(assets[0]!.path), new Uint8Array([1, 2, 3]));
  assert.deepEqual(files.get(assets[1]!.path), new Uint8Array([4, 5, 6]));
  const xml = new TextDecoder().decode(files.get("project.fcpxml"));
  for (const asset of assets)
    assert.ok(
      xml.includes(asset.path.split("/").map(encodeURIComponent).join("/")),
    );
  assert.ok(files.has("README.txt"));
});

test("package failures and cancellation never yield a partially successful download", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    exportTimelinePackage(timeline(), "Cancelled", controller.signal),
    { name: "AbortError" },
  );
  const second = new AbortController();
  await assert.rejects(
    exportTimelinePackage(
      timeline(),
      "Late",
      second.signal,
      () => {},
      async () => {
        second.abort();
        return new Blob(["media"]);
      },
    ),
    { name: "AbortError" },
  );
  await assert.rejects(
    exportTimelinePackage(
      timeline(),
      "Empty",
      new AbortController().signal,
      () => {},
      async () => new Blob(),
    ),
    /空文件/,
  );
  const missing = timeline();
  delete missing.tracks[0]!.clips[0]!.resource.src;
  assert.throws(() => exportTimelineFcpxml(missing, "Missing"), /缺少媒体/);
  await assert.rejects(
    createTimelineZip(
      [{ path: "../escape", content: new Blob(["bad"]) }],
      new AbortController().signal,
    ),
    /文件名/,
  );
});

test("package deduplicates shared sources and protects colliding Unicode filenames", () => {
  const data = timeline();
  data.importedAssets!.push({ ...data.importedAssets![0]!, id: "duplicate" });
  data.importedAssets!.push({
    ...data.importedAssets![0]!,
    id: "distinct",
    src: "data:video/mp4;base64,Bw==",
  });
  const assets = timelineExportAssets(data);
  assert.equal(assets.length, 3);
  assert.equal(new Set(assets.map((asset) => asset.path)).size, 3);
});

test("FCPXML sequence boundaries use exact project frames and reject sub-frame clips", () => {
  let data = addTimelineClip(createNode("timeline").data.timeline!, {
    id: "i",
    kind: "image",
    title: "image.png",
    src: "data:image/png;base64,AA==",
  });
  data = updateTimelineClip(data, data.tracks[0]!.clips[0]!.id, {
    outPoint: 1 / 30,
  });
  assert.match(exportTimelineFcpxml(data, "One frame"), /duration="1\/30s"/);
  data = updateTimelineClip(data, data.tracks[0]!.clips[0]!.id, {
    outPoint: 0.001,
  });
  assert.throws(
    () => exportTimelineFcpxml(data, "Too short"),
    /短于项目的一帧/,
  );
});
