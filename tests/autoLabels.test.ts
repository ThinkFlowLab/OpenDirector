import assert from 'node:assert/strict';
import { test } from 'node:test';
import classifier from '../scripts/github/auto-labels.cjs';
const { validate, fallback, inputFor, run } = classifier;
const catalog = [{name:'area:ci'}, {name:'type:ci'}, {name:'type:bug'}, {name:'priority:p0'}];
test('only existing permitted confident labels are applied, preserving manual type', () => {
  assert.deepEqual(validate(JSON.stringify({labels:[{name:'area:ci',confidence:0.9},{name:'type:ci',confidence:0.9}]}), catalog, ['type:bug']), ['area:ci']);
  assert.deepEqual(validate('{"labels":[{"name":"area:ci","confidence":0.7}]}', catalog, []), []);
  for (const name of ['ready', 'priority:p0', 'area:invented']) {
    assert.throws(() => validate(JSON.stringify({labels:[{name,confidence:1}]}), catalog, []));
  }
  assert.throws(() => validate('{"labels":[{"name":"type:ci","confidence":1},{"name":"type:bug","confidence":1}]}', catalog, []));
});
test('input is bounded and sensitive file patches are excluded', () => {
  const input = inputFor({}, [{filename:'.env',patch:'secret'}, ...Array.from({length:300}, () => ({filename:'x',patch:'a'.repeat(5000)}))]);
  assert.equal(input.files.length, 200);
  assert.equal(input.files[0].patch, '');
  assert.ok(input.files.reduce((sum, file) => sum + (file.patch?.length ?? 0), 0) <= 32000);
});
test('path fallback only uses known labels and does not duplicate existing labels', () => {
  assert.deepEqual(fallback([{filename:'.github/workflows/x.yml'}], catalog, []), ['area:ci']);
  assert.deepEqual(fallback([{filename:'.github/workflows/x.yml'}], catalog, ['area:ci']), []);
});
function fixture(key = 'test-only', draft = false) {
  const added: string[][] = [];
  let stale = false;
  const summary = { addHeading(){return this;}, addRaw(){return this;}, async write(){} };
  const args = {
    context: {eventName:'pull_request_target',payload:{action:'opened',pull_request:{number:1}},repo:{owner:'o',repo:'r'}},
    core:{warning(){},info(){},summary}, apiKey:key,
    fetchImpl: async () => new Response(JSON.stringify({choices:[{message:{content:'{"labels":[{"name":"area:ci","confidence":0.95}]}'}}]})),
    github:{paginate:async (method:string) => method === 'labels' ? catalog : [{filename:'.github/x.yml'}],
      rest:{pulls:{get:async () => ({data:{state:'open',draft,head:{sha:stale?'new':'old'},labels:[]}}),listFiles:'files'},
        issues:{listLabelsForRepo:'labels',addLabels:async ({labels}:{labels:string[]}) => {added.push(labels);}}}},
  };
  return {args, added, changeHead(){stale=true;}};
}
test('model success applies validated labels', async () => {
  const f=fixture(); await run(f.args); assert.deepEqual(f.added,[['area:ci']]);
});
test('missing key falls back without making a provider call', async () => {
  const f=fixture(''); f.args.fetchImpl=async () => {throw new Error('must not call');};
  await run(f.args); assert.deepEqual(f.added,[['area:ci']]);
});
test('provider failure falls back and stale heads never mutate labels', async () => {
  const f=fixture(); f.args.fetchImpl=async () => new Response('',{status:500});
  await run(f.args); assert.deepEqual(f.added,[['area:ci']]);
  const stale=fixture(); stale.args.fetchImpl=async () => {stale.changeHead();return new Response('{}');};
  await run(stale.args); assert.deepEqual(stale.added,[]);
});
test('drafts and label events do not call the model', async () => {
  const f=fixture(); f.args.context.payload.action='labeled';
  f.args.fetchImpl=async () => {throw new Error('must not call');};
  await run(f.args); assert.deepEqual(f.added,[]);
  const draft = fixture('test-only', true);
  draft.args.fetchImpl = async () => { throw new Error('must not call'); };
  await run(draft.args); assert.deepEqual(draft.added, []);
});
