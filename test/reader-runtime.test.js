import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ReaderRuntime, readerConnectionHealthy } from '../src/reader-runtime.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const client = () => Object.assign(new EventEmitter(), { ready: true, destroyed: false, user: { id: '100000000000000010', bot: false },
  isReady() { return this.ready; }, destroy() { this.destroyed = true; this.ready = false; } });
function fixture(overrides = {}) {
  let current = client(), now = 1000000, created = [], saved = [], gaps = 0;
  const runtime = new ReaderRuntime({ token: 'old-token', botToken: 'official-token', getClient: () => current,
    clock: () => now, createClient: () => { const c = client(); created.push(c); return c; },
    connect: async () => {}, validate: async () => {}, credentials: { save: async token => saved.push(token) },
    activate: c => { current.destroy(); current = c; }, onGap: () => gaps++, ...overrides });
  return { runtime, get current() { return current; }, created, saved, get gaps() { return gaps; }, advance: ms => now += ms };
}
const metadata = { actorId: '100000000000000001', operationId: '100000000000000002' };

test('normal quiet connected reader is never replaced', async () => {
  const f = fixture(); for (let i = 0; i < 30; i++) { f.advance(60000); await f.runtime.tick(); }
  assert.equal(f.created.length, 0);
});
test('watchdog restores a stuck disconnected reader after SDK grace period', async () => {
  const f = fixture(); f.current.ready = false;
  await f.runtime.tick(); f.advance(44999); await f.runtime.tick(); assert.equal(f.created.length, 0);
  f.advance(1); assert.equal(await f.runtime.tick(), true); assert.equal(f.current.ready, true);
  assert.equal(f.created.length, 1); assert.equal(f.saved.length, 0); assert.equal(f.gaps, 1);
});
test('stale heartbeat is detected even when isReady is true; fresh heartbeat is healthy', () => {
  const c = client(); c.ws = { shards: new Map([[0, { lastPingTimestamp: 1000, lastHeartbeatAcked: true }]]) };
  assert.equal(readerConnectionHealthy(c, 100000), true);
  assert.equal(readerConnectionHealthy(c, 122000), false);
  c.ws.shards.get(0).lastHeartbeatAcked = false;
  assert.equal(readerConnectionHealthy(c, 92000), false);
});
test('SDK natural reconnection avoids a new client', async () => {
  const f = fixture(); f.current.ready = false; await f.runtime.tick();
  f.advance(30000); f.current.ready = true; await f.runtime.tick(); f.advance(30000); await f.runtime.tick();
  assert.equal(f.created.length, 0); assert.equal(f.runtime.downSince, null);
});
for (const stage of ['connect', 'validate', 'save']) test(`${stage} failure preserves old client and token`, async () => {
  const fail = async () => { throw new Error('failure containing a secret'); };
  const f = fixture(stage === 'save' ? { credentials: { save: fail } } : { [stage]: fail }); const old = f.current;
  await assert.rejects(f.runtime.update('new-token', metadata));
  assert.equal(f.current, old); assert.equal(old.destroyed, false); assert.equal(f.runtime.token, 'old-token');
  assert.equal(f.created[0].destroyed, true);
});
test('validated token is saved before swap; one candidate at a time', async () => {
  const wait = deferred(), f = fixture({ connect: () => wait.promise }); const old = f.current;
  const job = f.runtime.update('  "new-token"  ', metadata);
  await assert.rejects(f.runtime.update('other-token', metadata), /جارٍ/);
  await new Promise(r => setImmediate(r)); assert.equal(old.destroyed, false); assert.deepEqual(f.saved, []);
  wait.resolve(); await job;
  assert.deepEqual(f.saved, ['new-token']); assert.equal(old.destroyed, true); assert.equal(f.runtime.token, 'new-token');
});
test('invalid token stops automatic auth retries but manual replacement remains possible', async () => {
  const f = fixture(); f.current.ready = false; f.runtime.disconnected(4004); f.advance(600000);
  await f.runtime.tick(); assert.equal(f.created.length, 0); assert.equal(f.runtime.authFailed, true);
  await f.runtime.update('new-token', metadata); assert.equal(f.runtime.authFailed, false);
});
test('temporary login failures back off instead of opening concurrent sockets', async () => {
  const f = fixture({ connect: async () => { throw new Error('network'); } }); f.current.ready = false;
  await f.runtime.tick(); f.advance(45000); await f.runtime.tick(); assert.equal(f.created.length, 1);
  f.advance(29999); await f.runtime.tick(); assert.equal(f.created.length, 1);
  f.advance(1); await f.runtime.tick(); assert.equal(f.created.length, 2);
});
test('shutdown during candidate login prevents persistence and adoption', async () => {
  const wait = deferred(), f = fixture({ connect: () => wait.promise }); const old = f.current;
  const job = f.runtime.update('new-token', metadata); await new Promise(r => setImmediate(r));
  f.runtime.close(); wait.resolve(); await assert.rejects(job);
  assert.equal(f.current, old); assert.equal(f.created[0].destroyed, true); assert.deepEqual(f.saved, []);
});
test('bot token and bad token formatting are rejected before creating clients', async () => {
  const f = fixture(); await assert.rejects(f.runtime.update('official-token', metadata));
  assert.throws(() => f.runtime.update('not a token', metadata)); assert.equal(f.created.length, 0);
});
