import assert from 'node:assert/strict';
import { createWorkspaceRefresh } from '../lib/workspace-refresh.ts';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise(resolve => setImmediate(resolve));
const state = deferred(), jobs = deferred(), settings = deferred(), prepare = deferred();
let states = 0, ready = 0, preparations = 0;
const failures: boolean[] = [];
const signals: AbortSignal[] = [];
const reader = createWorkspaceRefresh({
  prepare: async () => { preparations++; await prepare.promise; },
  state: async signal => { states++; signals.push(signal); await state.promise; },
  jobs: () => jobs.promise, settings: () => settings.promise,
  ready: () => { ready++; }, failed: (_, initial) => failures.push(initial),
});
const first = reader.refresh();
assert.equal(reader.refresh(), first, 'focus during migration must share initial load');
prepare.resolve(); await turn();
assert.equal(states, 1);
assert.equal(reader.refresh(), first, 'timer must not duplicate a slow initial transfer');
state.resolve(); await turn();
assert.equal(ready, 1, 'complete history must display while auxiliary reads are pending');
assert.equal(reader.refresh(), first, 'pending auxiliary reads must not overlap');
jobs.reject(new Error('task status unavailable')); settings.resolve(); await first;
assert.equal(failures.length, 0, 'auxiliary failure must not discard the loaded workspace');
await reader.refresh();
assert.equal(states, 2); assert.equal(preparations, 1);
reader.stop(); await reader.refresh();
assert.equal(states, 2); assert.equal(signals[0].aborted, true);

let attempt = 0;
const recovery = createWorkspaceRefresh({
  prepare: async () => {},
  state: async () => { if (++attempt !== 2) throw new Error('offline'); },
  jobs: async () => {}, settings: async () => {}, ready: () => {},
  failed: (_, initial) => failures.push(initial),
});
await recovery.refresh(); await recovery.refresh(); await recovery.refresh();
assert.deepEqual(failures, [true, false], 'initial failure and later outage need different UI handling');
recovery.stop();
const pending = deferred();
const cancelled = createWorkspaceRefresh({
  prepare: async () => {}, state: () => pending.promise, jobs: async () => {}, settings: async () => {},
  ready: () => assert.fail('late response after logout'), failed: () => assert.fail('error after logout'),
});
const cancelledRead = cancelled.refresh(); await turn(); cancelled.stop(); pending.resolve(); await cancelledRead;
console.log('Workspace startup passed: slow startup deduplication, independent readiness, auxiliary failure, recovery, cancellation.');
