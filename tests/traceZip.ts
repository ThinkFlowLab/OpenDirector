/** Independent ZIP reader for tests: walks EOCD and the central directory the way unzip and
 * Python zipfile do. It shares no code with the writer under test. */
import { Buffer } from "node:buffer";

export type CentralEntry = {
  name: string; method: number; crc: number; compressedSize: number; size: number;
  localOffset: number; data: Uint8Array;
};

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) {
    crc ^= bytes[index]!;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function parseZip(zip: Uint8Array): { entries: CentralEntry[]; cdOffset: number; cdSize: number } {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const fail = (message: string): never => { throw new Error("invalid ZIP: " + message); };
  const eocd = zip.byteLength - 22;
  if (eocd < 0 || view.getUint32(eocd, true) !== 0x06054b50) fail("no EOCD at end of file");
  const count = view.getUint16(eocd + 10, true);
  if (view.getUint16(eocd + 8, true) !== count) fail("entry counts differ");
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (view.getUint16(eocd + 20, true) !== 0) fail("unexpected comment");
  if (cdOffset + cdSize !== eocd) fail(`central directory ${cdOffset}+${cdSize} does not end at EOCD ${eocd}`);
  const entries: CentralEntry[] = [];
  let at = cdOffset;
  for (let index = 0; index < count; index++) {
    if (view.getUint32(at, true) !== 0x02014b50) fail("bad central header " + index);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const entry = {
      name: Buffer.from(zip.subarray(at + 46, at + 46 + nameLength)).toString("utf8"),
      method: view.getUint16(at + 10, true), crc: view.getUint32(at + 16, true),
      compressedSize: view.getUint32(at + 20, true), size: view.getUint32(at + 24, true),
      localOffset: view.getUint32(at + 42, true),
    };
    const local = entry.localOffset;
    if (view.getUint32(local, true) !== 0x04034b50) fail("central offset misses local header: " + entry.name);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = zip.subarray(start, start + entry.compressedSize);
    if (start + entry.compressedSize > cdOffset) fail("entry data overlaps central directory: " + entry.name);
    if (entry.method !== 0 || entry.compressedSize !== entry.size) fail("not STORE: " + entry.name);
    if (crc32(data) !== entry.crc) fail("CRC mismatch: " + entry.name);
    entries.push({ ...entry, data });
    at += 46 + nameLength + extra;
  }
  if (at !== eocd) fail("central directory size does not match its entries");
  return { entries, cdOffset, cdSize };
}
