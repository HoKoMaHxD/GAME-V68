import test from 'node:test';
import assert from 'node:assert/strict';
import { MembershipRecovery, transientMembershipError } from '../src/membership-recovery.js';

const timeout = () => Object.assign(new Error('Members did not arrive in time'), { code: 'GuildMembersTimeout' });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('reconnect and voice tick share one failing load and one error report', async () => {
  const gate = deferred(), errors = [];
  let loads = 0, drops = 0;
  const membership = { ready: false, load: async () => { loads++; await gate.promise; throw timeout(); } };
  const recovery = new MembershipRecovery({ membership, beforeLoad: () => drops++, onError: e => errors.push(e) });
  const reconnect = recovery.run(), tick = recovery.run();
  assert.equal(reconnect, tick);
  gate.resolve();
  assert.deepEqual(await Promise.all([reconnect, tick]), [false, false]);
  assert.equal(loads, 1); assert.equal(drops, 1); assert.equal(errors.length, 1);
});

test('failed recovery backs off across invalidations, caps at five minutes and resets after success', async () => {
  let now = 0, loads = 0, failed = true;
  const delays = [];
  const membership = { ready: false, load: async () => { loads++; if (failed) throw timeout(); return membership.ready = true; } };
  const recovery = new MembershipRecovery({ membership, clock: () => now, onError: (_, delay) => delays.push(delay) });
  for (const delay of [30000, 60000, 120000, 240000, 300000, 300000]) {
    assert.equal(await recovery.run(), false);
    const attempts = loads;
    membership.ready = false;
    now += delay - 1;
    assert.equal(await recovery.run(), false);
    assert.equal(loads, attempts);
    now++;
  }
  assert.deepEqual(delays, [30000, 60000, 120000, 240000, 300000, 300000]);
  failed = false;
  assert.equal(await recovery.run(), true);
  assert.equal(recovery.retryAt, 0);
  membership.ready = false; failed = true;
  await recovery.run();
  assert.equal(delays.at(-1), 30000);
});

test('a ready roster and disconnected clients cause no reload or voice reset', async () => {
  let loads = 0, drops = 0, online = true;
  const membership = { ready: true, load: async () => { loads++; return true; } };
  const recovery = new MembershipRecovery({ membership, canRun: () => online, beforeLoad: () => drops++ });
  assert.equal(await recovery.run(), true);
  membership.ready = false; online = false;
  assert.equal(await recovery.run(), false);
  assert.equal(loads, 0); assert.equal(drops, 0);
});

test('startup continues on transient load failures but still rejects invalid permissions', async () => {
  const membership = { ready: false, load: async () => { throw timeout(); } };
  const recovery = new MembershipRecovery({ membership });
  assert.equal(await recovery.run({ required: true }), false);
  const denied = Object.assign(new Error('Missing Access'), { code: 50001, status: 403 });
  const invalid = new MembershipRecovery({ membership: { ready: false, load: async () => { throw denied; } } });
  await assert.rejects(invalid.run({ required: true }), error => error === denied);
});

test('an invalidated in-flight load can be retried without waiting for an error cooldown', async () => {
  let attempts = 0;
  const membership = { ready: false, load: async () => ++attempts > 1 };
  const recovery = new MembershipRecovery({ membership, clock: () => 0 });
  assert.equal(await recovery.run(), false);
  assert.equal(await recovery.run(), true);
  assert.equal(attempts, 2);
});

test('a full reset cancellation is not logged as a network failure or delayed', async () => {
  let errors = 0;
  const recovery = new MembershipRecovery({ onError: () => errors++, membership: {
    ready: false, load: async () => { throw Object.assign(new Error('reset'), { code: 'RESET_INTERRUPTED' }); }
  } });
  assert.equal(await recovery.run(), false);
  assert.equal(errors, 0); assert.equal(recovery.retryAt, 0);
});

test('client state is checked again before a queued recovery starts', async () => {
  let online = true, loads = 0;
  const recovery = new MembershipRecovery({ canRun: () => online, membership: {
    ready: false, load: async () => { loads++; return true; }
  } });
  const job = recovery.run(); online = false;
  assert.equal(await job, false);
  assert.equal(loads, 0);
});

test('transient detection follows causes and never treats access denial as a timeout', () => {
  assert.equal(transientMembershipError(new Error('request failed', { cause: Object.assign(new Error('socket'), { code: 'ECONNABORTED' }) })), true);
  assert.equal(transientMembershipError({ code: 'GUILD_MEMBERS_TIMEOUT' }), true);
  assert.equal(transientMembershipError({ status: 503 }), true);
  assert.equal(transientMembershipError({ code: 50013, status: 403 }), false);
  const cyclic = new Error('unknown'); cyclic.cause = cyclic;
  assert.equal(transientMembershipError(cyclic), false);
});
