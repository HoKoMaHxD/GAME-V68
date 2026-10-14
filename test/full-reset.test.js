import test from 'node:test';
import assert from 'node:assert/strict';
import { FullResetControl } from '../src/full-reset-control.js';
import { RuntimeControl } from '../src/runtime-control.js';
import { RESET_COLLECTIONS, RESET_GAMES, readFullReset } from '../src/full-reset-store.js';
import { fixture, at, user, other, actor, config, snowflake } from './helpers/shop-fixture.js';

const request = (id = 'full-reset-test') => ({ userId: null, target: 'all', actorId: actor, operationId: id });
async function setup(t, options = {}) {
  const f = await fixture(); let now = at;
  const runtime = new RuntimeControl({ store: f.store, service: f.service, clock: () => now });
  const control = new FullResetControl({ store: f.store, service: f.service, runtimeControl: runtime, clock: () => now, ...options });
  t.after(() => control.close());
  return { ...f, control, runtime, setTime: value => { now = value; f.service.clock = () => value; } };
}
const wait = () => Promise.withResolvers();

test('full reset bulk-clears all operational data, old journals and holds only in this clan, then resumes', async t => {
  const f = await setup(t), clanId = config.clanGuildId;
  await f.seed(user); await f.seed(other, 2000);
  const untouched = structuredClone({ shop: await f.store.shop.get(), settings: await f.store.settings() });
  for (const name of RESET_COLLECTIONS) {
    f.documents[name] ||= [];
    if (name !== 'days') f.documents[name].push({ _id: `${clanId}:old-${name}`, clanId, status: 'active', hold: 800 });
    f.documents[name].push({ _id: `other:${name}`, clanId: 'other-clan', value: 42 });
  }
  for (const prefix of RESET_GAMES) f.documents[`${prefix}_journals`].push({ _id: clanId, pending: { legs: ['old'] } });
  f.documents.game_rooms = [{ _id: `games:${clanId}:bot:old-channel`, current: { id: 'old' } }, { _id: 'games:other-clan:bot:channel' }];
  f.documents.game_events = [{ _id: 'ours', roomId: `games:${clanId}:bot:old-channel` }, { _id: 'theirs', roomId: 'games:other-clan:bot:channel' }];
  f.documents.resets.push({ _id: `reset:${clanId}:member`, clanId, userId: user, pending: true, cutoff: at - 1000 });
  // Bulk deletion must not replay the expensive historical per-day financial audit.
  f.store.financialAudit = true; f.store.mutateDay = () => { throw new Error('per-day rewrite forbidden'); };
  const result = await f.control.start(request());
  assert.equal(result.deletedDays, 2); assert.equal(f.service.paused, false); assert.equal(f.service.resetting, false);
  for (const name of RESET_COLLECTIONS) assert.deepEqual(f.documents[name], [{ _id: `other:${name}`, clanId: 'other-clan', value: 42 }], name);
  for (const prefix of RESET_GAMES) assert.equal(f.documents[`${prefix}_journals`].find(d => d._id === clanId).pending, null);
  assert.deepEqual(f.documents.game_rooms, [{ _id: 'games:other-clan:bot:channel' }]); assert.equal(f.documents.game_events[0]._id, 'theirs');
  assert.deepEqual(await f.store.shop.get(), untouched.shop);
  assert.deepEqual((await f.store.settings()).bank, untouched.settings.bank);
  assert.equal(f.store.resetCutoff(user), at); assert.equal((await f.store.settings()).runtimeControl.enabled, true);
  assert.equal((await readFullReset(f.store)).pending, false);
});

test('an active ship stake and cooldown are removed without waiting for players; new activity works', async t => {
  const f = await setup(t); await f.seed(user); await f.seed(other); await f.service.shipGame.initialize();
  let g = await f.service.shipGame.open({ id: snowflake(at, 30), x: user, o: other, amount: 300, channelId: '100000000000000060' }, async () => true);
  g = await f.service.shipGame.act({ id: g.id, revision: g.revision, userId: other, move: 'accept', channelId: g.channelId }, async () => true);
  assert.equal((await f.store.totals(user, 'all', at)).total, 700);
  await f.control.start(request());
  assert.equal(await f.service.shipGame.get(g.id), null); assert.equal((await f.store.totals(user, 'all', at)).total, 0);
  assert.equal((await f.service.shipGame.commandTime(user, at)).status, 'ready');
  f.setTime(at + 1000); const day = await f.service.day(user);
  assert.equal(day.points.tasks, 0); assert.equal(f.service.blocked, false);
});

test('only issued writes are drained; an old hung service queue cannot hang reset or subsequent commands', async t => {
  const f = await setup(t); await f.seed(user);
  const waiting = wait(), release = wait();
  const old = f.service.gate.exclusive(async () => { waiting.resolve(); await release.promise; f.service.assertActive(); });
  const rejected = assert.rejects(old, e => e.code === 'RESET_INTERRUPTED'); await waiting.promise;
  await f.control.start(request());
  await f.service.balance(user); // Uses the fresh gate even while the old lookup is outstanding.
  release.resolve(); await rejected;
});

test('an issued write finishes before deletion and old continuations cannot recreate money or block the new bot', async t => {
  const f = await setup(t); const entered = wait(), release = wait();
  f.intercept(async e => { if (e.name === 'days' && e.method === 'insertOne' && e.phase === 'before') { entered.resolve(); await release.promise; } });
  const old = f.store.fence.run(async () => {
    await f.seed(user);
    try { await f.store.db.collection('financial_logs').insertOne({ _id: 'late', clanId: config.clanGuildId }); }
    catch (e) { f.service.blocked = true; throw e; }
  });
  const rejected = assert.rejects(old, e => e.code === 'RESET_INTERRUPTED'); await entered.promise;
  const resetting = f.control.start(request());
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.service.paused, true); assert.equal(f.documents.full_resets?.length || 0, 0);
  release.resolve(); await resetting; await rejected;
  assert.equal(f.documents.days.length, 0); assert.equal(f.documents.financial_logs.length, 0); assert.equal(f.service.blocked, false);
});

test('a late Discord response after successful reset cannot create documents through the old work context', async t => {
  const f = await setup(t); const release = wait();
  const old = f.store.fence.run(async () => { await release.promise;
    await f.store.db.collection('shop_orders').updateOne({ _id: 'late' }, { $set: { clanId: config.clanGuildId } }, { upsert: true }); });
  const rejected = assert.rejects(old, e => e.code === 'RESET_INTERRUPTED');
  await f.control.start(request()); release.resolve(); await rejected; assert.equal(f.documents.shop_orders.length, 0);
});

test('partial deletion stays stopped; restart completes saved scope before financial recovery and includes downtime in cutoff', async t => {
  const f = await setup(t); await f.seed(user); let fail = true;
  f.intercept(e => { if (fail && e.name === 'days' && e.method === 'deleteMany' && e.phase === 'after') { fail = false; throw new Error('lost delete acknowledgement'); } });
  await assert.rejects(f.control.start(request()), /تلقائيًا/); f.control.close();
  assert.equal(f.service.paused, true); assert.equal((await readFullReset(f.store)).pending, true);
  await assert.rejects(f.runtime.change({ enabled: true, actorId: actor, operationId: snowflake(at, 40) }), /الريست/);
  f.intercept(() => {}); const next = f.open(at + 9000);
  const control = new FullResetControl({ ...next, clock: () => at + 9000 }); t.after(() => control.close());
  assert.equal(await control.recover(), true); assert.equal(next.service.paused, false);
  assert.equal(next.store.resetCutoff(user), at + 9000); assert.equal(next.service.resumedAt, at + 9000);
  assert.equal(f.documents.days.length, 0); assert.equal(await control.recover(), false);
});

test('a failed deletion retries automatically then resumes and calls completion exactly once', async t => {
  const done = wait(); const f = await setup(t, { retryMs: 1 }); await f.seed(user); let fail = true, completions = 0;
  f.intercept(e => { if (fail && e.name === 'days' && e.method === 'deleteMany') { fail = false; throw new Error('temporary outage'); } });
  await assert.rejects(f.control.start(request(), result => { completions++; done.resolve(result); }));
  // Keep the test alive independently of the production retry timer, which is intentionally unref'ed.
  const watchdog = setTimeout(() => done.reject(new Error('retry did not complete')), 2000); t.after(() => clearTimeout(watchdog));
  await done.promise; assert.equal(completions, 1); assert.equal(f.service.paused, false); assert.equal(f.documents.days.length, 0);
});

test('lost final acknowledgement is verified without deleting post-reset activity on duplicate requests', async t => {
  const f = await setup(t); await f.seed(user); let fail = true;
  f.intercept(e => { if (fail && e.name === 'full_resets' && e.method === 'updateOne' && e.phase === 'after' && e.args[1].$set.pending === false) { fail = false; throw new Error('lost final ack'); } });
  await assert.rejects(f.control.start(request())); f.control.close();
  f.intercept(() => {}); await f.control.attempt();
  await f.seed(user, 777);
  f.store.rememberReset({ userId: user, target: 'bank', cutoff: at + 1000 });
  f.service.resumedAt = at + 1000;
  await f.control.start(request());
  assert.equal((await f.store.totals(user, 'all', at)).total, 777);
  assert.equal(f.store.scopedResetCutoff(user, 'bank'), at + 1000);
  assert.equal(f.service.resumedAt, at + 1000);
});

test('an unfinished stock reservation is returned once while products and preferences stay configured', async t => {
  const f = await setup(t); const shop = await f.store.shop.get();
  shop.products[0].stock--; shop.pending = { product: { id: shop.products[0].id } };
  await f.store.db.collection('shops').replaceOne({ _id: shop._id }, shop);
  f.documents.notification_preferences.push({ _id: 'pref', clanId: config.clanGuildId, userId: user, enabled: false });
  let fail = true; f.intercept(e => { if (fail && e.name === 'shops' && e.method === 'replaceOne' && e.phase === 'after') { fail = false; throw new Error('lost stock ack'); } });
  await assert.rejects(f.control.start(request())); f.control.close(); f.intercept(() => {}); await f.control.attempt();
  assert.equal((await f.store.shop.get()).products[0].stock, 3); assert.equal((await f.store.shop.get()).pending, null);
  assert.equal(f.documents.notification_preferences[0].enabled, false);
});

test('invalid reset scope cannot pause or erase anyone, and lease ownership is mandatory', async t => {
  const f = await setup(t); await f.seed(user);
  for (const patch of [{userId: user}, {target:'bank'}, {actorId:'x'}, {operationId:'*'}]) assert.throws(() => f.control.start({...request(),...patch}), /غير صالح/);
  assert.equal(f.service.paused, false); f.documents.leases[0].owner = 'other-worker';
  await assert.rejects(f.control.start(request())); assert.equal(f.documents.days.length, 1); assert.equal(f.documents.full_resets?.length || 0, 0);
});
