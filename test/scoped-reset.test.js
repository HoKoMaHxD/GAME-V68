import test from 'node:test';
import assert from 'node:assert/strict';
import { createDay } from '../src/domain.js';
import { netPoints } from '../src/point-adjustments.js';
import { dayKey, dayStart } from '../src/time.js';
import { fixture, config, at, user, other, actor, snowflake, request } from './helpers/shop-fixture.js';
import { auctionFixture, auctionId } from './helpers/auction-fixture.js';

const clanChatChannelId = '100000000000000041';
const voiceChannelId = '100000000000000042';
const bankChannelId = '100000000000000060';
const reset = (target, operationId = `reset-${target}`) => ({ userId: null, actorId: actor, operationId, target });
const message = (time, id = 900) => ({ id: snowflake(time, id), at: time, userId: user,
  guildId: config.arenaGuildId, channelId: clanChatChannelId, eligible: true });

async function setup() {
  const f = await fixture(); let now = at + 60000;
  const settings = { ...config, clanChatChannelId, voiceChannelId, activityStartedAt: at - 86400000 };
  f.store.config = settings; f.service.config = settings; f.service.clock = () => now;
  await f.seed(user, 1000, 200); await f.seed(other, 500, 50);
  await f.seed(user, 300, 100, at - 86400000);
  const foreign = createDay('other-clan', user, dayKey(at), [], at);
  foreign.points.tasks = 999; foreign.activity = { clanMessages: 77, voiceMs: 888 };
  await f.store.ensureDay(foreign);
  const dayId = `${config.clanGuildId}:${dayKey(at)}:${user}`;
  for (const d of f.documents.days.filter(d => d.clanId === config.clanGuildId)) {
    d.activity = { clanMessages: 80, voiceMs: 180000, voiceUntil: at,
      messageFloor: at - 10000, messageReceipts: [{ id: snowflake(at, 30), at }] };
    d.completionLog = [{ taskId: 'old-task', points: 100, at }];
  }
  await f.store.mutateDay(dayId, d => {
    d.pointAdjustments = { tasks: 50, attendance: 10 };
    d.shopAdjustments = { tasks: -150, attendance: 0 };
    d.robberyAdjustments = { tasks: -20, attendance: 20 };
    d.auctionAdjustments = { tasks: -100, attendance: -10 };
    d.salaryCredits = 500; d.salaryLastAt = at;
    d.salaryReceipts = [{ id: snowflake(at, 40), amount: 500, claimedAt: at }];
    d.prizeCredits = 750; d.prizeLastAt = at;
    d.prizeReceipts = [{ id: snowflake(at, 41), type: 'money', amount: 750, claimedAt: at }];
    d.tasks = [{ id: 'daily-test', title: 'daily', type: 'messages', channelId: clanChatChannelId, target: 2, progress: 1, reward: 200, repeat: 1, completed: 0 }];
    return true;
  });
  return { ...f, dayId, now: () => now, time: time => { now = time; },
    reopen: () => {
      const result = f.open(now); result.store.config = settings; result.service.config = settings;
      result.service.clock = () => now; return result;
    } };
}

test('bank reset zeroes all wallet sources and periods without changing activity, quests, cooldowns or other clans', async () => {
  const f = await setup(); const before = structuredClone(f.documents);
  await f.service.reset(reset('bank'));
  assert.equal(f.documents.days.length, before.days.length);
  for (const member of [user, other]) for (const period of ['daily', 'weekly', 'monthly', 'all']) {
    assert.equal((await f.store.totals(member, period, f.now())).total, 0);
  }
  for (const d of f.documents.days) {
    const original = before.days.find(row => row._id === d._id);
    if (d.clanId !== config.clanGuildId) { assert.deepEqual(d, original); continue; }
    assert.equal(netPoints(d).total, 0);
    for (const [key, value] of Object.entries(original)) if (key !== 'revision') assert.deepEqual(d[key], value, key);
  }
  assert.deepEqual(f.documents.settings, before.settings); assert.deepEqual(f.documents.shops, before.shops);
  assert.equal((await f.store.activityRanking('all', 'chat', f.now()))[0].chat, 160);
  assert.equal(f.store.resetCutoff(user), 0);
  assert.equal(f.store.scopedResetCutoff(user, 'activity'), 0);
  assert.equal(f.store.scopedResetCutoff(user, 'bank'), f.now());
  f.time(f.now() + 1000);
  const claim = { id: snowflake(f.now(), 55), userId: user, channelId: bankChannelId, at: f.now() };
  f.documents.settings[0].bank.salaryAmount = 500;
  assert.equal((await f.service.claimSalary(claim)).status, 'cooldown');
  assert.equal((await f.service.claimPrize(claim)).status, 'cooldown');
});

test('activity reset clears only chat and voice in every period and preserves every wallet and quest record', async () => {
  const f = await setup(); const before = structuredClone(f.documents.days);
  assert.deepEqual(await f.service.resetPreview(null, 'activity'), { _id: null, members: 2, days: 3, chat: 240, voice: 540000 });
  const result = await f.service.reset(reset('activity'));
  assert.equal(result.deletedDays, 0); assert.equal(result.changedDays, 3);
  for (const period of ['daily', 'weekly', 'monthly', 'all']) for (const metric of ['chat', 'voice']) {
    assert.deepEqual(await f.store.activityRanking(period, metric, f.now()), []);
  }
  for (const d of f.documents.days) {
    const original = before.find(row => row._id === d._id);
    if (d.clanId !== config.clanGuildId) { assert.deepEqual(d, original); continue; }
    assert.equal(netPoints(d).total, netPoints(original).total);
    for (const [key, value] of Object.entries(original)) if (!['revision', 'activity'].includes(key)) assert.deepEqual(d[key], value, key);
    assert.deepEqual(d.activity, { ...original.activity, clanMessages: 0, voiceMs: 0 });
  }
  assert.equal(f.store.scopedResetCutoff(user, 'bank'), 0);
  assert.equal(f.store.scopedResetCutoff(user, 'activity'), f.now());
});

test('activity cutoff survives restart, ignores late old messages and counts only the new part of voice', async () => {
  const f = await setup(); const cutoff = f.now();
  await f.service.reset(reset('activity'));
  f.time(cutoff + 15000); const reopened = f.reopen(); await reopened.store.initializeResets(f.now());
  await reopened.service.message(message(cutoff - 1)); await reopened.service.message(message(cutoff));
  await reopened.service.message(message(cutoff + 1000));
  await reopened.service.message(message(cutoff + 1000));
  await reopened.service.voice({ guildId: config.arenaGuildId, userId: user, channelId: voiceChannelId,
    eligible: true, from: cutoff - 15000, to: cutoff + 15000 }, {});
  const day = await reopened.store.getDay(f.dayId);
  assert.equal(day.activity.clanMessages, 1); assert.equal(day.activity.voiceMs, 15000);
  assert.equal(day.salaryLastAt, at); assert.equal(day.prizeLastAt, at);
});

for (const target of ['bank', 'activity']) test(`${target} reset preserves a daily quest and awards its later completion exactly once`, async () => {
  const f = await setup();
  await f.store.mutateDay(f.dayId, d => {
    d.timedQuest = { id: snowflake(at, 60), createdAt: at, acceptedAt: at, expiresAt: at + 3600000,
      status: 'active', type: 'messages', channelIds: [clanChatChannelId], target: 2, progress: 1, reward: 200 };
    return true;
  });
  await f.service.reset(reset(target)); const before = (await f.service.balance(user)).total;
  f.time(f.now() + 1000); const event = message(f.now());
  await f.service.message(event); await f.service.message(event);
  assert.equal((await f.service.balance(user)).total, before + 200);
  assert.equal((await f.store.getDay(f.dayId)).tasks[0].completed, 1);
});

test('bank reset preserves cooldowns, rejects old financial requests and allows fresh credits and later resets', async () => {
  const f = await setup(); const cutoff = f.now();
  await f.service.reset(reset('bank'));
  const credit = { userId: user, actorId: actor, operationId: snowflake(cutoff, 80), at: cutoff,
    mode: 'add', category: 'total', amount: 300 };
  await assert.rejects(f.service.adjustPoints(credit), /أقدم من آخر ريست/);
  f.time(cutoff + 1000);
  await f.service.adjustPoints({ ...credit, operationId: snowflake(f.now(), 80), at: f.now() });
  assert.equal((await f.service.balance(user)).total, 300);
  await f.service.reset(reset('bank')); // Same operation must not zero this new credit.
  assert.equal((await f.service.balance(user)).total, 300);
  await assert.rejects(f.service.purchase(request({ checkoutId: snowflake(cutoff - 1), at: f.now() })), /أقدم من آخر ريست/);
  await f.service.reset(reset('activity'));
  assert.equal((await f.service.balance(user)).total, 300);
  await f.service.reset(reset('bank', 'second-bank-reset'));
  assert.equal((await f.service.balance(user)).total, 0);
});

test('activity reset remains available with an auction hold, while bank reset cannot erase the reserved funds', async () => {
  const f = await auctionFixture(); await f.service.bidAuction(f.bid());
  const before = await f.get(); const balance = (await f.balance(user)).total;
  await assert.rejects(f.service.reset(reset('bank')), /حجز مزاد/);
  assert.equal(f.service.blocked, false);
  await f.service.reset(reset('activity'));
  assert.deepEqual(await f.get(), before); assert.equal((await f.balance(user)).total, balance);
  await f.service.settleAuction(auctionId, { actorId: actor, operationId: snowflake(f.now(), 950) });
  assert.equal((await f.balance(user)).total, 10000);
});

test('activity-only reset across Saudi midnight does not resurrect the old day or erase a new-day wallet', async () => {
  const f = await setup(); const midnight = dayStart('2026-09-12');
  f.time(midnight); await f.service.reset(reset('activity'));
  f.time(midnight + 10000);
  await f.service.voice({ guildId: config.arenaGuildId, userId: user, channelId: voiceChannelId,
    eligible: true, from: midnight - 10000, to: midnight + 10000 }, {});
  assert.equal((await f.store.activityRanking('all', 'voice', f.now()))[0].voice, 10000);
  assert.equal((await f.store.activityRanking('daily', 'voice', f.now()))[0].voice, 10000);
  assert.ok((await f.service.balance(user)).total > 0);
});

for (const target of ['bank', 'activity']) for (const [collection, method, phase, nth] of [
  ['days', 'replaceOne', 'before', 2], ['days', 'replaceOne', 'after', 2],
  ['resets', 'updateOne', 'before', 1], ['resets', 'updateOne', 'after', 1]
]) test(`${target} reset recovers ${phase} ${collection}.${method} without changing the other section or repeating`, async () => {
  const f = await setup(); const balances = new Map(f.documents.days.map(d => [d._id, netPoints(d).total]));
  const activities = new Map(f.documents.days.map(d => [d._id, structuredClone(d.activity)]));
  let count = 0, failed = false;
  f.intercept(e => {
    if (e.name === collection && e.method === method && e.phase === phase && ++count === nth) {
      failed = true; throw new Error('simulated process loss');
    }
  });
  await assert.rejects(f.service.reset(reset(target)), /لم يتأكد/); assert.ok(failed);
  await assert.rejects(f.service.balance(user), /الاحتساب متوقف/);
  f.intercept(() => {}); f.time(f.now() + 1000);
  const next = f.reopen(); await next.store.initializeResets(f.now());
  for (const d of f.documents.days.filter(d => d.clanId === config.clanGuildId)) {
    assert.equal(netPoints(d).total, target === 'bank' ? 0 : balances.get(d._id));
    assert.equal(d.activity.clanMessages, target === 'activity' ? 0 : activities.get(d._id).clanMessages);
    assert.equal(d.activity.voiceMs, target === 'activity' ? 0 : activities.get(d._id).voiceMs);
  }
  const before = (await next.service.balance(user)).total;
  await next.service.adjustPoints({ userId: user, actorId: actor, operationId: snowflake(f.now(), 98), at: f.now(),
    mode: 'add', category: 'total', amount: 100 });
  await next.store.initializeResets(f.now());
  await next.service.reset(reset(target));
  assert.equal((await next.service.balance(user)).total, before + 100);
});

test('invalid target refuses the reset before touching data or blocking the service', async () => {
  const f = await setup(); const before = structuredClone(f.documents);
  await assert.rejects(f.service.reset(reset('wrong')), /اختر قسم الريست/);
  assert.equal(f.service.blocked, false); assert.deepEqual(f.documents, before);
});

test('second bank reset with zero balances completes without per-day reads or writes and later credits still reset', async () => {
  const f = await setup(); await f.service.reset(reset('bank', 'first-zero-reset'));
  let reads = 0, writes = 0;
  f.intercept(({ name, method, phase }) => {
    if (name === 'days' && phase === 'before') {
      if (method === 'findOne') reads++;
      if (method === 'replaceOne') writes++;
    }
  });
  f.time(f.now() + 1000);
  const result = await f.service.reset(reset('bank', 'second-zero-reset'));
  assert.equal(result.pending, false); assert.equal(f.service.blocked, false);
  assert.equal(reads, 0); assert.equal(writes, 0);
  assert.equal((await f.service.balance(user)).total, 0);
  assert.equal((await f.service.balance(other)).total, 0);
  f.time(f.now() + 1000);
  await f.service.adjustPoints({ userId: user, actorId: actor, operationId: snowflake(f.now(), 99), at: f.now(), mode: 'add', category: 'total', amount: 500 });
  await f.service.reset(reset('bank', 'third-zero-reset'));
  assert.equal((await f.service.balance(user)).total, 0);
  assert.equal(f.service.blocked, false);
});
