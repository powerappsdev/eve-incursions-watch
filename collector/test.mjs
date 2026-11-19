import assert from 'node:assert/strict';
import { transition, collect } from './worker.mjs';
const before = { incursions: { '1': { active: true, state: 'established', constellation_id: 1, last_seen_at: '2026-11-19T10:00:00Z', first_seen_at: 'original', state_changed_at: 'original' } } };
const ended = transition(before, [], '2026-11-19T10:05:00Z');
assert.equal(ended.incursions['1'].end_after, '2026-11-19T10:00:00Z');
assert.equal(ended.incursions['1'].ended_at, '2026-11-19T10:05:00Z');
assert.equal(before.incursions['1'].active, true);
const live = [{constellation_id: 1, staging_solar_system_id: 123, state: 'established'}];
assert.equal(transition(before, live, 'now').incursions['1'].state_changed_at, 'original');
const restarted = transition(ended, live, 'later').incursions['1'];
assert.equal(restarted.first_seen_at, 'later');
assert.equal(restarted.ended_at, undefined);
console.log('PASS: end-time interval, immutable history, continuing state, and repeat spawn.');
let persisted;
const seeded = { ...before, last_success_at: '2026-11-19T10:00:00Z', etag: 'etag' };
const env = { DB: { prepare(sql) {
  return {
    async first() { return {revision: 1, payload: JSON.stringify(seeded)}; },
    bind(value) { persisted = JSON.parse(value); return {async run() { return {meta: {changes: 1}}; }}; },
  };
} } };
globalThis.fetch = async () => new Response(null, {status: 304});
await collect(env);
assert.ok(persisted.last_success_at > seeded.last_success_at);
assert.equal(persisted.incursions['1'].active, true);
assert.equal(persisted.incursions['1'].state_changed_at, 'original');
persisted = undefined;
globalThis.fetch = async () => new Response('{}', {status: 503});
await assert.rejects(() => collect(env), /503/);
assert.equal(persisted, undefined);
globalThis.fetch = async () => new Response('{}', {status: 200});
await assert.rejects(() => collect(env), /Invalid ESI/);
assert.equal(persisted, undefined);
console.log('PASS: cached ESI heartbeat and safe retention on network/schema failures.');
