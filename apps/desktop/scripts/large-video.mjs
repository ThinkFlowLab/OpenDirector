import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile } from 'node:fs/promises';

export async function createLargeVideo(path) {
  const seed = await readFile(new URL('../../../tests/fixtures/timeline-text/visual-a.mp4', import.meta.url));
  const padding = 128 * 1024 * 1024;
  const box = Buffer.alloc(8);
  box.writeUInt32BE(padding);
  box.write('free', 4);
  const file = await open(path, 'wx');
  try {
    await file.writeFile(Buffer.concat([seed, box]));
    await file.truncate(seed.length + padding);
  } finally {
    await file.close();
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { size: seed.length + padding, fingerprint: 'sha256:' + hash.digest('hex') };
}

export function guardLargeVideoDataUrl(name) {
  const original = FileReader.prototype.readAsDataURL;
  FileReader.prototype.readAsDataURL = function (file) {
    if (file.name === name) {
      window.largeVideoBase64Attempt = true;
      throw new Error('Large video import attempted FileReader.readAsDataURL');
    }
    return original.call(this, file);
  };
}

export async function largeVideoState(projectId, fixture) {
  if (window.largeVideoBase64Attempt) return { blocked: true };
  const base = '/api/creation/projects/' + projectId;
  const headers = { 'X-OpenDirector-Request': '1' };
  const response = await fetch(base, { headers });
  if (!response.ok) throw new Error('Project read failed: ' + response.status);
  const { assets, canvasItems } = await response.json();
  const asset = assets.find(a => a.kind === 'video' && a.fingerprint === fixture.fingerprint &&
    a.metadata.size === fixture.size);
  const node = canvasItems.find(n => n.kind === 'video' && n.binding.role === 'material' &&
    n.binding.objectRef.assetId === asset?.id);
  if (!node || !asset) return null;
  return { nodeId: node.id, assetId: asset.id };
}

export async function verifyLargeVideoBytes(response, fixture) {
  if (!response.ok) throw new Error('Stored video read failed: ' + response.status);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    hash.update(chunk);
  }
  if (size !== fixture.size || 'sha256:' + hash.digest('hex') !== fixture.fingerprint)
    throw new Error('Stored video bytes differ from the selected file');
}
