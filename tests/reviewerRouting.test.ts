import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import routing from '../scripts/github/reviewer-routing.cjs';
const { selectReviewers, run } = routing;

test('reviewer workflow action references use full 40-character commit pins', () => {
  const workflow = readFileSync(new URL('../.github/workflows/reviewer-routing.yml', import.meta.url), 'utf8');
  const pins = [...workflow.matchAll(/uses:\s+actions\/[\w-]+@(\S+)/g)];
  assert.equal(pins.length, 3);
  for (const [, pin] of pins) assert.match(pin, /^[0-9a-f]{40}$/);
});

test('requests every matched label owner, with case-insensitive deduplication', () => {
  assert.deepEqual(selectReviewers({labels: ['area:canvas', 'area:timeline'], author: 'someone'}),
    ['allendyu', 'Probiotics5333']);
  assert.deepEqual(selectReviewers({labels: ['area:ci', 'area:desktop'], author: 'WANGTIANCE'}),
    ['yenuo26', 'david6666666']);
});
test('preserves existing requests and completed reviews', () => {
  assert.deepEqual(selectReviewers({labels: ['area:agent'], author: 'someone',
    requested: ['fayespica'], reviewed: ['WUZHF9']}), []);
});
test('uses all fallback owners only when no label matches', () => {
  assert.deepEqual(selectReviewers({labels: ['type:docs'], author: 'someone'}),
    ['hsliuustc0106', 'princepride']);
  assert.deepEqual(selectReviewers({labels: ['area:performance'], author: 'kunkunblueberry'}), []);
});
type FixturePr = {
  state?: string;
  draft?: boolean;
  user?: { login: string };
  requested_reviewers?: { login: string }[];
  labels?: { name: string }[];
};
function fixture(pr: FixturePr) {
  const calls: string[] = [];
  const summary = {addHeading(){return this;}, addRaw(){return this;}, addTable(){return this;}, async write(){}};
  return {calls, args: {context: {eventName: 'pull_request_target', repo: {owner:'o',repo:'r'},
    payload: {action: 'opened', pull_request:{number: 1}}}, core: {info(){}, warning(){}, summary}, github: {
      paginate: async () => [], rest: {
      issues: {
        getLabel: async (_request: {name: string}): Promise<void> => {},
        createLabel: async (_request: {name: string}): Promise<void> => {},
      }, pulls: {
        get: async () => ({data: pr}), listReviews: {},
        requestReviewers: async (request: {reviewers: string[]}) => { calls.push(request.reviewers[0]);
          if (request.reviewers[0] === 'yenuo26') throw Object.assign(new Error('unavailable'), {status:422}); },
      }},
    }}};
}
test('uses fresh labels and continues after an unavailable reviewer', async () => {
  const f = fixture({state:'open', draft:false, user:{login:'someone'}, requested_reviewers:[], labels:[{name:'area:ci'}]});
  await run(f.args);
  assert.deepEqual(f.calls, ['yenuo26', 'wangtiance']);
});
test('draft PRs do not send invitations', async () => {
  const f = fixture({state:'open', draft:true});
  await run(f.args);
  assert.deepEqual(f.calls, []);
});
test('label sync creates only missing labels and preserves existing ones', async () => {
  const f = fixture({});
  f.args.context.eventName = 'push';
  const created: string[] = [];
  f.args.github.rest.issues = {
    getLabel: async ({name}) => {
      if (name !== 'area:docs') throw Object.assign(new Error('missing'), {status:404});
    },
    createLabel: async ({name}) => { created.push(name); },
  };
  await run(f.args);
  assert.deepEqual(created, ['area:performance', 'area:desktop']);
  assert.deepEqual(f.calls, []);
});
test('permission errors remain failures instead of silently dropping reviewers', async () => {
  const f = fixture({state:'open', draft:false, user:{login:'someone'}, requested_reviewers:[], labels:[{name:'area:performance'}]});
  f.args.github.rest.pulls.requestReviewers = async () => { throw Object.assign(new Error('forbidden'), {status:403}); };
  await assert.rejects(run(f.args), /forbidden/);
});
test('removing the last mapped label does not invite fallback reviewers', async () => {
  const f = fixture({state:'open', draft:false, user:{login:'someone'}, requested_reviewers:[{login:'wangtiance'}], labels:[{name:'type:ci'}]});
  f.args.context.payload.action = 'unlabeled';
  await run(f.args);
  assert.deepEqual(f.calls, []);
});
test('label removal still routes remaining mapped labels', async () => {
  const f = fixture({state:'open', draft:false, user:{login:'someone'}, requested_reviewers:[], labels:[{name:'area:performance'}]});
  f.args.context.payload.action = 'unlabeled';
  await run(f.args);
  assert.deepEqual(f.calls, ['kunkunblueberry']);
});
test('opening an unmapped PR still invites all fallback reviewers', async () => {
  const f = fixture({state:'open', draft:false, user:{login:'someone'}, requested_reviewers:[], labels:[]});
  await run(f.args);
  assert.deepEqual(f.calls, ['hsliuustc0106', 'princepride']);
});
