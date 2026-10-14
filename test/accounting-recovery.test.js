import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountingRecovery } from '../src/accounting-recovery.js';
import { VoiceTracker } from '../src/voice.js';
import { fixture as baseFixture, at, user, other, config, snowflake } from './helpers/shop-fixture.js';

async function fixture() {
  const f = await baseFixture();
  await f.store.robbery.initialize(at); await f.store.auctions.initialize(at);
  return f;
}

const channelId = '100000000000000060';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const recovery = (f, extra = {}) => new AccountingRecovery({ service: f.service, store: f.store, clock: () => at, ...extra });

for (const phase of ['before', 'after']) for (const collection of ['xo_journals', 'days', 'xo_games']) {
  test(`live recovery after ${collection} ${phase} failure unlocks accounting without restart or duplicate debit`, async () => {
    const f = await fixture(); await f.seed(user, 1000); await f.seed(other, 1000); await f.service.xo.initialize();
    const g = await f.service.xo.open({ id: snowflake(at, 500), x: user, o: other, amount: 300, channelId }, async () => true);
    let failed = false;
    f.intercept(e => { if (!failed && e.name === collection && e.phase === phase && ['updateOne', 'replaceOne'].includes(e.method)) {
      failed = true; throw new Error('transient database fault');
    } });
    await assert.rejects(f.service.xo.act({ id: g.id, userId: other, revision: g.revision, move: 'accept', channelId }, async () => true));
    assert.equal(f.service.blocked, true);
    f.intercept(() => {});
    const runner = recovery(f);
    assert.equal(await runner.run(), true);
    assert.equal(f.service.blocked, false);
    const saved = await f.service.xo.get(g.id);
    const balances = await Promise.all([user, other].map(id => f.service.balance(id)));
    assert.deepEqual(balances.map(b => b.total), saved.status === 'active' ? [700, 700] : [1000, 1000]);
    assert.equal(await runner.run(), false);
  });
}

test('recovery waits behind active writes and parallel ticks share one recovery', async () => {
  const f = await fixture(), gate = deferred(); f.service.blocked = true;
  const old = f.service.gate.run(() => gate.promise);
  const runner = recovery(f); const a = runner.run(), b = runner.run();
  assert.equal(a, b); await new Promise(r => setImmediate(r)); assert.equal(f.service.blocked, true);
  gate.resolve(); await old; assert.equal(await a, true);
});

test('database failure keeps the lock, backs off, then restores the same process', async () => {
  const f = await fixture(); f.service.blocked = true; let now = at, reports = 0;
  f.intercept(e => { if (e.name === 'shops') throw new Error('database down'); });
  const runner = recovery(f, { clock: () => now, onError: () => reports++ });
  assert.equal(await runner.run(), false); assert.equal(f.service.blocked, true); assert.equal(reports, 1);
  assert.equal(await runner.run(), false); assert.equal(reports, 1);
  f.intercept(() => {}); now += 10000;
  assert.equal(await runner.run(), true); assert.equal(f.service.blocked, false);
});

test('lost lease and manual pause never unlock accounting', async () => {
  const f = await fixture(); f.service.blocked = true;
  assert.equal(await recovery(f, { canRun: () => false }).run(), false);
  f.store.requireLease = async () => { throw new Error('lease lost'); };
  assert.equal(await recovery(f).run(), false); assert.equal(f.service.blocked, true);
});

test('observed voice retries after automatic recovery, without counting the disconnected gap', async () => {
  const f = await fixture(); await f.seed(user, 1000);
  let now = at; f.service.clock = () => now; f.service.config = { ...config, voiceChannelId: channelId, activityStartedAt: at - 1000 };
  const tracker = new VoiceTracker({ service: f.service, guildId: config.arenaGuildId });
  const people = [{ userId: user, channelId, bot: false }], rule = { minPeople: 1, ignoreMuted: false, ignoreDeafened: false };
  await tracker.transition(people, rule, new Set([user]), now);
  f.service.blocked = true; now += 15000;
  await assert.rejects(tracker.tick(now)); tracker.drop();
  assert.equal(await recovery(f).run(), true);
  now += 30000; await tracker.transition(people, rule, new Set([user]), now);
  now += 15000; await tracker.tick(now);
  const day = await f.service.day(user);
  assert.equal(day.activity.voiceMs, 30000);
  assert.equal(tracker.pending.size, 0);
});

test('connected voice observations survive a financial lock including a mid-lock departure', async () => {
  const f = await fixture(); await f.seed(user, 1000);
  let now = at; f.service.clock = () => now;
  f.service.config = { ...config, voiceChannelId: channelId, activityStartedAt: at - 1000 };
  const tracker = new VoiceTracker({ service: f.service, guildId: config.arenaGuildId });
  const people = [{ userId: user, channelId, bot: false }], rule = { minPeople: 1, ignoreMuted: false, ignoreDeafened: false };
  await tracker.transition(people, rule, new Set([user]), now);
  f.service.blocked = true;
  for (let i = 1; i <= 8; i++) {
    now = at + i * 15000;
    tracker.observe(i >= 5 ? [] : people, rule, new Set([user]), now);
  }
  assert.equal(await recovery(f).run(), true); await tracker.persist();
  assert.equal((await f.service.day(user)).activity.voiceMs, 75000);
  await tracker.persist(); assert.equal((await f.service.day(user)).activity.voiceMs, 75000);
});

test('a reset or pause arriving during recovery prevents the unlock', async () => {
  const f = await fixture(); f.service.blocked = true; let active = true;
  const original = f.store.shop.recover.bind(f.store.shop);
  f.store.shop.recover = async (...args) => { await original(...args); active = false; };
  assert.equal(await recovery(f, { canRun: () => active }).run(), false);
  assert.equal(f.service.blocked, true);
});
