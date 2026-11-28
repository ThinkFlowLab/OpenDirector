import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Host } from '../src/host.mjs';

const runtime = process.env.OPENDIRECTOR_DESKTOP_RUNTIME;
test('Packaged Python starts privately, inspects work, rejects unauthenticated media and stops on EOF', { skip: !runtime }, async () => {
  const root = resolve(runtime);
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  const directory = await mkdtemp(join(tmpdir(), 'od-host-'));
  const file = await open(join(directory, 'host.log'), 'w');
  const log = file.createWriteStream({ autoClose: false });
  let host;
  try {
    host = new Host({ python: join(root, manifest.python), directory,
      env: { ...process.env, OPENDIRECTOR_ROOT: directory, PATH: join(root, 'bin') }, log,
      onExit: () => {} });
    const ready = await host.ready;
    assert.equal(ready.runtime.agent, '1.19.5');
    for (const path of ['/', '/api/health']) assert.equal((await fetch(host.url + path)).status, 403);
    const response = await fetch(host.url + '/api/health', { headers: {
      'X-OpenDirector-Desktop': host.token, 'X-OpenDirector-Request': '1' } });
    assert.deepEqual(await response.json(), { status: 'ok' });
    const ownSession = randomUUID();
    const otherSession = randomUUID();
    host.registerSession(ownSession);
    for (const [session, name] of [[ownSession, 'Owned'], [otherSession, 'Other']]) {
      const projectId = randomUUID();
      const headers = { 'X-OpenDirector-Desktop': host.token, 'X-OpenDirector-Request': '1',
        'X-OpenDirector-Session': session, 'Content-Type': 'application/json' };
      const response = await fetch(host.url + `/api/creation/projects/${projectId}/commands`, {
        method: 'POST', headers, body: JSON.stringify({ commandId: randomUUID(), projectId,
          type: 'project.create', expectedVersions: [], payload: { name } }),
      });
      assert.equal(response.status, 200, await response.text());
      assert.equal((await fetch(host.url + `/api/creation/projects/${projectId}/open`, { method: 'POST', headers })).status, 200);
    }
    const work = await host.inspect();
    assert.equal(work.agents + work.generations + work.tools, 0);
    host.stopping = true;
    host.child.stdin.end();
    const deadline = setTimeout(() => host.child.kill('SIGKILL'), 20_000);
    try { assert.equal(await host.closed, 0); } finally { clearTimeout(deadline); }
    const inspection = spawnSync(join(root, manifest.python), ['-I', '-c', "import sqlite3,sys,json; db=sqlite3.connect(sys.argv[1]); print(json.dumps([r[0] for r in db.execute('SELECT id FROM sessions')]))", join(directory, '.opendirector/catalog.sqlite3')], { encoding: 'utf8' });
    assert.equal(inspection.status, 0, inspection.stderr);
    const sessions = JSON.parse(inspection.stdout);
    assert.equal(sessions.includes(ownSession), false);
    assert.equal(sessions.includes(otherSession), true);
  } finally {
    await host?.stop();
    log.end();
    await file.close();
    await rm(directory, { force: true, recursive: true });
  }
});
