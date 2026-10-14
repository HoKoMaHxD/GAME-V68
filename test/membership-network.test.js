import test from 'node:test';
import assert from 'node:assert/strict';
import { ClanMembership } from '../src/membership.js';
import { MembershipRecovery, transientMembershipError } from '../src/membership-recovery.js';
import { membershipStatusText } from '../src/membership-status.js';

const config = { clanGuildId: 'clan', arenaGuildId: 'arena', memberRole: 'role' };
const member = (guildId, id, roles = []) => ({ id, guild: { id: guildId }, user: { bot: false },
  roles: { cache: new Map(roles.map(role => [role, {}])) } });
const reset = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };

function fixture(ids = ['alice'], options = {}) {
  const clan = new Map(ids.map(id => [id, member('clan', id)]));
  const arena = new Map(ids.map(id => [id, member('arena', id, ['role'])]));
  const waits = [], retries = [], warnings = [];
  const clanGuild = { members: { list: async () => new Map(clan) } };
  const guild = { roles: { cache: new Map([['role', {}]]) }, members: { fetch: async request => {
    if (Array.isArray(request.user)) return new Map(request.user.map(id => [id, arena.get(id)]));
    assert.equal(request.force, true); assert.equal(request.cache, false);
    if (!arena.has(request.user)) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
    return arena.get(request.user);
  } } };
  const bot = { guilds: { cache: new Map([['clan', clanGuild]]) } };
  const source = { guilds: { cache: new Map([['arena', guild]]) } };
  const membership = new ClanMembership({ bot, source, config, wait: async ms => { waits.push(ms); },
    onReadRetry: info => retries.push(info), onFallback: error => warnings.push(error), ...options });
  return { membership, clanGuild, guild, clan, arena, waits, retries, warnings };
}

test('one reset of the clan roster recovers within the same load', async () => {
  const f = fixture(); let calls = 0;
  f.clanGuild.members.list = async () => { if (++calls === 1) throw reset(); return new Map(f.clan); };
  assert.equal(await f.membership.load(), true);
  assert.equal(f.membership.has('alice'), true); assert.equal(calls, 2);
  assert.deepEqual(f.waits, [1000]);
  assert.equal(f.retries[0].operation, 'clan-page'); assert.equal(f.retries[0].code, 'ECONNRESET');
});

test('a failed second clan page retries its own cursor without fetching the completed first page again', async () => {
  const ids = Array.from({ length: 1002 }, (_, i) => String(900000000000000000n + BigInt(i)));
  const f = fixture(ids), cursors = []; let failed = false;
  f.clanGuild.members.list = async ({ after, limit }) => {
    cursors.push(after);
    if (after && !failed) { failed = true; throw reset(); }
    return new Map([...f.clan].filter(([id]) => !after || BigInt(id) > BigInt(after)).slice(0, limit));
  };
  assert.equal(await f.membership.load(), true);
  assert.deepEqual(cursors, [undefined, ids[999], ids[999]]);
  assert.equal(f.membership.members.size, 1002);
});

test('a role-list connection reset is retried before declaring the configured role unavailable', async () => {
  const f = fixture(); f.guild.roles.cache.clear(); let calls = 0;
  f.guild.roles.fetch = async () => { if (++calls === 1) throw reset(); f.guild.roles.cache.set('role', {}); };
  assert.equal(await f.membership.load(), true); assert.equal(calls, 2);
  assert.equal(f.retries[0].operation, 'arena-roles');
});

test('a direct member read retries just the failed member and retains other completed reads', async () => {
  const f = fixture(['alice', 'bob', 'carol', 'dan']); f.membership.preferRest = true;
  const calls = new Map(), fetch = f.guild.members.fetch;
  f.guild.members.fetch = async request => {
    const count = (calls.get(request.user) || 0) + 1; calls.set(request.user, count);
    if (request.user === 'bob' && count === 1) throw reset();
    return fetch(request);
  };
  assert.equal(await f.membership.load(), true);
  assert.deepEqual(Object.fromEntries(calls), { alice: 1, bob: 2, carol: 1, dan: 1 });
  assert.equal(f.membership.members.size, 4);
  assert.equal(f.retries[0].operation, 'arena-member');
});

test('two completed network failures recover on the third bounded read', async () => {
  const f = fixture(); let calls = 0;
  f.clanGuild.members.list = async () => { if (++calls < 3) throw reset(); return new Map(f.clan); };
  assert.equal(await f.membership.load(), true);
  assert.deepEqual(f.waits, [1000, 3000]); assert.equal(calls, 3);
});

test('persistent resets exhaust three reads, release the attempt, and use the existing outer backoff', async () => {
  const f = fixture(); let calls = 0; const errors = [];
  f.clanGuild.members.list = async () => { calls++; throw reset(); };
  const recovery = new MembershipRecovery({ membership: f.membership, clock: () => 100,
    onError: (error, delay) => errors.push([error.code, delay]) });
  assert.equal(await recovery.run({ required: true }), false);
  assert.equal(calls, 3); assert.deepEqual(errors, [['ECONNRESET', 30000]]);
  assert.equal(recovery.retryAt, 30100); assert.equal(recovery.pending, null);
  assert.equal(f.membership.loading, null); assert.equal(f.membership.has('alice'), false);
  assert.deepEqual(f.membership.diagnostics().failure, { stage: 'clan', code: 'ECONNRESET' });
});

test('wrapped socket errors retain their actual code in diagnosis', async () => {
  const f = fixture();
  f.clanGuild.members.list = async () => { throw new Error('fetch failed', { cause: reset() }); };
  await assert.rejects(f.membership.load(), /fetch failed/);
  assert.equal(f.membership.diagnostics().failure.code, 'ECONNRESET');
  assert.match(membershipStatusText(f.membership.diagnostics()), /انقطع.*اتصال/);
});

test('a pending retry yields to the event loop and overlapping loads share the same work', async () => {
  const gate = deferred(), f = fixture(['alice'], { wait: () => gate.promise }); let calls = 0;
  f.clanGuild.members.list = async () => { if (++calls === 1) throw reset(); return new Map(f.clan); };
  const load = f.membership.load(); load.catch(() => {});
  try {
    await turn(); assert.equal(calls, 1); assert.equal(f.membership.loading, load);
    assert.equal(f.membership.load(), load); assert.equal(f.membership.has('alice'), false);
    let otherWorkRan = false; await new Promise(resolve => setImmediate(() => { otherWorkRan = true; resolve(); }));
    assert.equal(otherWorkRan, true);
  } finally { gate.resolve(); }
  assert.equal(await load, true);
});

test('a disconnect while waiting cancels the retry before a new outbound read', async () => {
  const gate = deferred(), f = fixture(['alice'], { wait: () => gate.promise }); let calls = 0;
  f.clanGuild.members.list = async () => { if (++calls === 1) throw reset(); return new Map(f.clan); };
  const load = f.membership.load(); load.catch(() => {}); await turn();
  f.membership.invalidate(); gate.resolve();
  assert.equal(await load, false); assert.equal(calls, 1); assert.equal(f.membership.ready, false);
});

test('a role removal received during a network retry overrides the older response', async () => {
  const f = fixture(); f.membership.preferRest = true; let calls = 0;
  f.guild.members.fetch = async () => {
    if (++calls === 1) { f.membership.updateArena(member('arena', 'alice')); throw reset(); }
    return f.arena.get('alice');
  };
  assert.equal(await f.membership.load(), true); assert.equal(f.membership.has('alice'), false);
});

test('a new clan member can recover their targeted read without pausing verified members', async () => {
  const f = fixture(); await f.membership.load();
  f.membership.updateClan(member('clan', 'new')); f.arena.set('new', member('arena', 'new', ['role']));
  const fetch = f.guild.members.fetch; let calls = 0;
  f.guild.members.fetch = async request => {
    assert.equal(f.membership.has('alice'), true);
    if (++calls === 1) throw reset(); return fetch(request);
  };
  assert.equal(await f.membership.loadArenaMember('new'), true);
  assert.equal(f.membership.has('new'), true); assert.equal(f.membership.has('alice'), true);
});

test('hanging direct reads are not retried while their original operations remain unresolved', async () => {
  const f = fixture(['alice'], { requestTimeoutMs: 10 }); f.membership.preferRest = true; let calls = 0;
  f.guild.members.fetch = () => { calls++; return new Promise(() => {}); };
  await assert.rejects(f.membership.load(), { code: 'MEMBERSHIP_REQUEST_TIMEOUT' });
  assert.equal(calls, 1); assert.equal(f.waits.length, 0); assert.equal(f.membership.has('alice'), false);
});

for (const status of [401, 403, 404, 429]) test(`HTTP ${status} with a nested reset is not retried or bypassed`, async () => {
  const f = fixture(); let calls = 0;
  const error = Object.assign(new Error('HTTP error', { cause: reset() }), { status });
  f.guild.members.fetch = async () => { calls++; throw error; };
  await assert.rejects(f.membership.load(), e => e === error);
  assert.equal(calls, 1); assert.equal(f.waits.length, 0); assert.equal(f.warnings.length, 0);
  assert.equal(f.membership.has('alice'), false);
  assert.equal(transientMembershipError(error), status === 429);
});

test('an explicit Unknown Member remains confirmed absence without retry', async () => {
  const f = fixture(); f.membership.preferRest = true; f.arena.clear();
  assert.equal(await f.membership.load(), true);
  assert.equal(f.membership.has('alice'), false); assert.equal(f.waits.length, 0);
});

test('a wrapped rate limit never switches to another member endpoint', async () => {
  const f = fixture(); let calls = 0;
  const error = new Error('request failed', { cause: Object.assign(new Error('rate limited'), { status: 429 }) });
  f.guild.members.fetch = async () => { calls++; throw error; };
  await assert.rejects(f.membership.load(), e => e === error);
  assert.equal(calls, 1); assert.equal(f.warnings.length, 0); assert.equal(f.waits.length, 0);
  assert.equal(f.membership.diagnostics().failure.code, 429);
});

test('retries stay inside the three member workers and never overlap their failed request', async () => {
  const gate = deferred(), f = fixture(Array.from({ length: 8 }, (_, i) => `user-${i}`), { wait: () => gate.promise });
  f.membership.preferRest = true;
  const fetch = f.guild.members.fetch, attempts = new Map(); let active = 0, peak = 0;
  f.guild.members.fetch = async request => {
    active++; peak = Math.max(peak, active);
    const count = (attempts.get(request.user) || 0) + 1; attempts.set(request.user, count);
    try { await turn(); if (count === 1) throw reset(); return await fetch(request); }
    finally { active--; }
  };
  const load = f.membership.load();
  try { await turn(); await turn(); assert.equal(attempts.size, 3); assert.equal(active, 0); }
  finally { gate.resolve(); }
  assert.equal(await load, true); assert.equal(peak, 3);
  assert.deepEqual([...attempts.values()], Array(8).fill(2));
});

test('progress advances inside a direct batch while another member is still waiting', async () => {
  const gate = deferred(), f = fixture(['alice', 'bob']); f.membership.preferRest = true;
  const fetch = f.guild.members.fetch;
  f.guild.members.fetch = async request => { if (request.user === 'bob') await gate.promise; return fetch(request); };
  const load = f.membership.load();
  try {
    await turn(); assert.equal(f.membership.diagnostics().checked, 1);
    assert.equal(f.membership.diagnostics().total, 2); assert.equal(f.membership.has('alice'), false);
  } finally { gate.resolve(); }
  assert.equal(await load, true);
});

test('status before the roster is known shows its phase rather than a false zero-of-zero total', () => {
  const loading = membershipStatusText({ ready: false, loading: true, stage: 'clan', clanLoaded: 1000,
    checked: 0, total: 0, failure: { stage: 'clan', code: 'ECONNRESET' } });
  assert.match(loading, /تحميل أعضاء سيرفر الكلان/); assert.match(loading, /1000/);
  assert.doesNotMatch(loading, /0 من 0/); assert.match(loading, /آخر تعذر/);
  const failed = membershipStatusText({ ready: false, loading: false, stage: 'failed',
    failure: { stage: 'clan', code: 'ECONNRESET' } });
  assert.match(failed, /تحميل أعضاء سيرفر الكلان/); assert.match(failed, /انقطع.*اتصال/);
});

test('successful recovery reports completion once and does not repeat for ready calls', async () => {
  let notifications = 0;
  const membership = { ready: false, load: async () => membership.ready = true };
  const recovery = new MembershipRecovery({ membership, onReady: () => notifications++ });
  assert.equal(await recovery.run(), true); assert.equal(await recovery.run(), true);
  assert.equal(notifications, 1);
});
