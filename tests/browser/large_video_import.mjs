import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLargeVideo, guardLargeVideoDataUrl, largeVideoState, verifyLargeVideoBytes } from '../../apps/desktop/scripts/large-video.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core');
const web = process.env.CREATION_WEB_URL ?? 'http://127.0.0.1:5179';
const api = process.env.CREATION_API_URL ?? 'http://127.0.0.1:8019';
const projectId = crypto.randomUUID();
const base = '/api/creation/projects/' + projectId;
const headers = { 'X-OpenDirector-Request': '1', 'Content-Type': 'application/json' };
assert.equal((await fetch(api + '/api/creation-test-health', { headers }).then(r => r.json())).isolated, true);
const create = await fetch(api + base + '/commands', {
  method: 'POST', headers, body: JSON.stringify({
    projectId, commandId: crypto.randomUUID(), type: 'project.create', payload: { name: 'Large video ' + projectId },
  }),
});
assert.ok(create.ok, await create.text());
const folder = await mkdtemp(join(tmpdir(), 'od-large-video-'));
try {
  const name = 'large-video.mp4';
  const path = join(folder, name);
  const fixture = await createLargeVideo(path);
  const browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    await page.addInitScript(() => localStorage.setItem('opendirector.modelSetup.v1', 'dismissed'));
    await page.addInitScript(guardLargeVideoDataUrl, name);
    await page.goto(web + '/ai-tool/ai-canvas/' + projectId);
    await page.getByText('Saved on this device', { exact: true }).waitFor();
    await page.getByLabel('Choose local asset files', { exact: true }).setInputFiles(path);
    async function verify() {
      const expression = `(${largeVideoState})(${JSON.stringify(projectId)}, ${JSON.stringify(fixture)})`;
      let result;
      const deadline = Date.now() + 30_000;
      while (!result && Date.now() < deadline) {
        result = await page.evaluate(expression);
        if (!result) await new Promise(resolve => setTimeout(resolve, 200));
      }
      assert.ok(result, 'Large video did not bind to a saved canvas node');
      if (result.blocked) {
        const snapshot = await fetch(api + base, { headers }).then(r => r.json());
        assert.equal(snapshot.assets.length, 0);
        assert.fail('Large video import attempted FileReader.readAsDataURL');
      }
      await verifyLargeVideoBytes(await fetch(api + base + '/assets/' + result.assetId + '/content', { headers }), fixture);
      await page.locator(`.react-flow__node[data-id="${result.nodeId}"]`).waitFor();
      return result;
    }
    const imported = await verify();
    await page.reload();
    assert.deepEqual(await verify(), imported);
    console.log(JSON.stringify({ ...fixture, ...imported, reopened: true }));
  } finally {
    await browser.close();
  }
} finally {
  await rm(folder, { recursive: true, force: true });
}
