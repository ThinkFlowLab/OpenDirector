import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';

const base = (process.env.OPENDIRECTOR_FIXTURE_URL ?? 'http://127.0.0.1:8019').replace(/\/+$/, '');
const evidence = { backend: 'real OpenDirector application + isolated image provider fixture', host: 'published DSH 0.2.2-rc.1 Cordis Loader + Tools + Native executor', model: 'fixture only; no real model service', checks: [] };
const ctx = new Context();
ctx.baseUrl = pathToFileURL(process.cwd() + '/').href;
const headers = { 'X-OpenDirector-Request': '1', 'Content-Type': 'application/json' };
async function api(method, path, body, session) {
  const response = await fetch(base + path, { method, headers: { ...headers, ...(session ? { 'X-OpenDirector-Session': session } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  return value;
}
async function call(name, args, { error = false } = {}) {
  const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) }], signal: new AbortController().signal });
  const result = batch.results[0].result;
  if (error) { assert.equal(result.isError, true, JSON.stringify(result)); return result; }
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.ok(result.value && typeof result.value === 'object');
  if (['opendirector_submit', 'opendirector_adopt_result'].includes(name) || name === 'opendirector_job' && result.value.job.status === 'succeeded') {
    evidence.toolOutputSamples ??= [];
    if (!evidence.toolOutputSamples.some(value => value.name === name)) evidence.toolOutputSamples.push({ name, text: result.content[0].text });
  }
  return result.value;
}
async function waitForJob(projectId, jobId, native = true) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = native ? await call('opendirector_job', { projectId, jobId }) : { job: (await api('GET', `/api/creation/projects/${projectId}`)).jobs.find(job => job.id === jobId) };
    if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(value.job.status)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('fixture job did not settle');
}
async function createNode(projectId, modelConfigId, x) {
  const args = { projectId, operationId: randomUUID(), kind: 'image', modelConfigId, prompt: 'Isolated purple image fixture', parameters: { size: 'auto' }, position: { x, y: 40 } };
  const node = await call('opendirector_create_generation', args);
  assert.equal(node.receipt.status, 'applied');
  const replay = await call('opendirector_create_generation', args);
  assert.equal(replay.receipt.inputFingerprint, node.receipt.inputFingerprint);
  assert.equal(replay.specId, node.specId);
  return node;
}
async function submit(projectId, node) {
  const revision = kind => node.receipt.changed.find(value => value.objectType === kind).revision;
  return call('opendirector_submit', { projectId, operationId: randomUUID(), specId: node.specId, expectedSpecRevision: revision('generation_spec'), originItemId: node.itemId, expectedItemRevision: revision('canvas_item') });
}
try {
  const fixture = await api('GET', '/api/creation-test-health');
  assert.equal(fixture.isolated, true, 'Use tests/browser/creation_server.py, not a production project server.');
  assert.equal(fixture.provider, 'fixture');
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(NativeToolExecutor);
  await ctx.plugin(Loader);
  await ctx.loader.create({ id: 'opendirector', name: new URL('../index.js', import.meta.url).href, config: { baseUrl: base, canvasBaseUrl: base, locale: 'en-US', requestTimeoutMs: 3000 } });
  await ctx.loader.await();
  const entry = [...ctx.loader.entries()].find(value => value.options.id === 'opendirector');
  assert.ok(entry);
  assert.equal(ctx.tools.schemas().filter(tool => tool.name.startsWith('opendirector_')).length, 8);
  evidence.checks.push('real Cordis Loader registered 8 native tools');
  const projectId = randomUUID();
  const name = `DSH 148 isolated project ${projectId.slice(0, 8)}`;
  const created = await call('opendirector_projects', { action: 'create', name, projectId, operationId: randomUUID() });
  assert.equal(created.receipt.status, 'applied');
  const project = await call('opendirector_project', { projectId });
  assert.equal(project.snapshot.project.name, name);
  const model = project.models.find(value => value.kind === 'image');
  assert.ok(model);
  const node = await createNode(projectId, model.id, 40);
  const accepted = await submit(projectId, node);
  assert.equal(accepted.receipt.status, 'accepted');
  const completed = await waitForJob(projectId, accepted.jobIds[0]);
  assert.equal(completed.job.status, 'succeeded');
  assert.equal(completed.job.cancelRequested, false);
  const beforeAdopt = await call('opendirector_project', { projectId });
  assert.ok(beforeAdopt.snapshot.assets.some(value => value.id === completed.job.asset.assetId));
  const result = beforeAdopt.snapshot.results.find(value => value.jobId === completed.job.id);
  assert.ok(result);
  const spec = beforeAdopt.snapshot.generationSpecs.find(value => value.id === node.specId);
  assert.equal(spec.currentResultId, null);
  const mediaResponse = await fetch(`${base}/api/creation/projects/${projectId}/assets/${completed.job.asset.assetId}/content`, { headers });
  assert.ok(mediaResponse.ok);
  const media = Buffer.from(await mediaResponse.arrayBuffer());
  assert.deepEqual([...media.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  evidence.media = { format: 'PNG', bytes: media.length, width: media.readUInt32BE(16), height: media.readUInt32BE(20), assetId: completed.job.asset.assetId };
  const adoptArgs = { projectId, operationId: randomUUID(), specId: node.specId, resultId: result.id, expectedSpecRevision: spec.revision, expectedCanvasVersions: beforeAdopt.snapshot.canvasItems.filter(value => value.binding.objectRef?.id === node.specId).map(value => ({ id: value.id, revision: value.revision })) };
  const adopted = await call('opendirector_adopt_result', adoptArgs);
  assert.equal(adopted.receipt.status, 'applied');
  const afterAdopt = await call('opendirector_project', { projectId });
  assert.equal(afterAdopt.snapshot.generationSpecs.find(value => value.id === node.specId).currentResultId, result.id);
  const adoptReplay = await call('opendirector_adopt_result', adoptArgs);
  assert.equal(adoptReplay.receipt.inputFingerprint, adopted.receipt.inputFingerprint);
  evidence.checks.push('project -> editable generation -> accepted job -> registered real PNG candidate -> explicit adoption -> replay');
  const ownUiSession = randomUUID();
  await api('POST', `/api/creation/projects/${projectId}/open`, undefined, ownUiSession);
  await call('opendirector_project', { projectId });
  await call('opendirector_create_generation', { projectId, operationId: randomUUID(), kind: 'image', modelConfigId: model.id, prompt: 'blocked', parameters: {}, position: { x: 0, y: 0 } }, { error: true });
  await api('PUT', `/api/creation/sessions/${ownUiSession}`, { projectId }, ownUiSession);
  await api('DELETE', `/api/creation/sessions/${ownUiSession}`, undefined, ownUiSession);
  evidence.checks.push('read-only query works while another session owns edit lease; rejected write preserves owner');
  const second = await createNode(projectId, model.id, 450);
  await api('POST', '/api/creation-test-gate', { open: false });
  const pending = await submit(projectId, second);
  await entry.update({ disabled: true });
  await ctx.loader.await();
  assert.ok(entry);
  assert.equal(ctx.tools.schemas().filter(tool => tool.name.startsWith('opendirector_')).length, 0);
  await api('POST', '/api/creation-test-gate', { open: true });
  const whileDisabled = await waitForJob(projectId, pending.jobIds[0], false);
  assert.equal(whileDisabled.job.status, 'succeeded');
  assert.equal(whileDisabled.job.cancelRequested, false);
  await entry.update({ disabled: false });
  await ctx.loader.await();
  assert.ok(entry);
  assert.equal(ctx.tools.schemas().filter(tool => tool.name.startsWith('opendirector_')).length, 8);
  const resumed = await call('opendirector_job', { projectId, jobId: pending.jobIds[0] });
  assert.equal(resumed.job.status, 'succeeded');
  evidence.checks.push('real loader disable unregisters tools; accepted OD job completes; enable restores persisted result query');
  const receipt = await call('opendirector_operation', { projectId, operationId: accepted.operationId });
  assert.equal(receipt.found, true);
  evidence.projectId = projectId;
  evidence.canvasUrl = afterAdopt.canvasUrl;
  console.log(JSON.stringify(evidence, null, 2));
  if (process.env.EVIDENCE_PATH) await writeFile(process.env.EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + '\n');
} finally {
  await ctx.fiber.dispose();
}
