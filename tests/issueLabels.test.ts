import assert from 'node:assert/strict';
import { test } from 'node:test';
import classifier from '../scripts/github/issue-labels.cjs';
import { validate } from '../scripts/github/auto-labels.cjs';
const { allowed, inputFor, fallback, run } = classifier;
const catalog = ['area:ci', 'area:harness', 'priority:p0', 'priority:p1', 'priority:p2', 'type:bug', 'ready'].map(name => ({name}));
const content = (names: string[], confidence = 0.95) => JSON.stringify({labels:names.map(name => ({name, confidence}))});
test('issue policy accepts only catalog areas and one priority, preserving manual priority', () => {
  assert.deepEqual(validate(content(['area:ci','priority:p1']),catalog,[],allowed),['area:ci','priority:p1']);
  assert.deepEqual(validate(content(['priority:p0']),catalog,['priority:p2'],allowed),[]);
  assert.deepEqual(validate(content(['area:ci'],0.5),catalog,[],allowed),[]);
  for (const names of [['ready'],['type:bug'],['area:invented'],['priority:p3'],['priority:p0','priority:p1']])
    assert.throws(() => validate(content(names),catalog,[],allowed));
});
test('bounded bilingual fallback never assigns priority or invents labels', () => {
  assert.equal(inputFor({body:'a'.repeat(20000)}).body.length,12000);
  assert.deepEqual(fallback({title:'Codex installation / 安装'},catalog,[]),['area:harness']);
  assert.deepEqual(fallback({title:'GitHub Actions urgent priority:p0'},catalog,[]),['area:ci']);
  assert.deepEqual(fallback({title:'GitHub Actions'},catalog,['area:ci']),[]);
});
function fixture() {
  const added: string[][] = [];
  const initial = {title:'GitHub Actions failure',body:'Report',state:'open',updated_at:'old',labels:[] as {name:string}[]};
  let latest = structuredClone(initial), reads = 0, calls = 0;
  const summary = {addHeading(){return this;},addRaw(){return this;},async write(){}};
  const args = {
    context:{eventName:'issues',payload:{action:'opened',issue:{number:1}},repo:{owner:'o',repo:'r'}},
    core:{warning(){},info(){},summary}, apiKey:'fixture-only',
    fetchImpl:async () => {calls++; return new Response(JSON.stringify({choices:[{message:{content:content(['area:ci','priority:p1'])}}]}));},
    github:{paginate:async () => catalog,rest:{issues:{listLabelsForRepo:'labels',
      get:async () => ({data:structuredClone(reads++ === 0 ? initial : latest)}),
      addLabels:async ({labels}:{labels:string[]}) => {added.push(labels);},
    }}},
  };
  return {args,added,initial,latest, calls:() => calls};
}
test('opened, edited and reopened classify areas and priority', async () => {
  for (const action of ['opened','edited','reopened']) {
    const f=fixture(); f.args.context.payload.action=action; await run(f.args);
    assert.deepEqual(f.added,[['area:ci','priority:p1']]); assert.equal(f.calls(),1);
  }
});
test('manual priority remains authoritative', async () => {
  const f=fixture(); f.initial.labels=[{name:'priority:p2'}]; f.latest.labels=[{name:'priority:p2'}];
  await run(f.args); assert.deepEqual(f.added,[['area:ci']]);
});
test('missing key, invalid output and provider failures use area-only fallback', async () => {
  for (const mode of ['key','network','malformed','forbidden','oversized']) {
    const f=fixture();
    if (mode === 'key') f.args.apiKey='';
    else f.args.fetchImpl=async () => {
      if (mode === 'network') throw new Error('secret must not be logged');
      if (mode === 'oversized') return new Response('x'.repeat(64001));
      return new Response(mode === 'malformed' ? '{}' : JSON.stringify({choices:[{message:{content:content(['ready'])}}]}));
    };
    await run(f.args); assert.deepEqual(f.added,[['area:ci']]);
    if (mode === 'key') assert.equal(f.calls(),0);
  }
});
test('changed issue content, labels, timestamps or state suppress stale results', async () => {
  for (const field of ['title','body','labels','updated_at','state'] as const) {
    const f=fixture();
    if (field === 'labels') f.latest.labels=[{name:'priority:p0'}];
    else f.latest[field]=field === 'state' ? 'closed' : 'changed';
    await run(f.args); assert.deepEqual(f.added,[]);
  }
});
test('closed issues, PRs and manual label events never classify', async () => {
  for (const mode of ['closed','pr','labeled','unlabeled','wrong-event']) {
    const f=fixture();
    if (mode === 'closed') f.initial.state='closed';
    else if (mode === 'pr') Object.assign(f.initial,{pull_request:{}});
    else if (mode === 'wrong-event') f.args.context.eventName='pull_request_target';
    else f.args.context.payload.action=mode;
    await run(f.args); assert.equal(f.calls(),0); assert.deepEqual(f.added,[]);
  }
});
test('label write errors are surfaced rather than reported as success', async () => {
  const f=fixture(); f.args.github.rest.issues.addLabels=async () => {throw new Error('permission denied');};
  await assert.rejects(run(f.args),/permission denied/);
});
