import test from 'node:test';
import assert from 'node:assert/strict';
import { drawPrize, PRIZE_INTERVAL_MS } from '../src/prizes.js';
import { netPoints } from '../src/point-adjustments.js';
import { nextReset } from '../src/time.js';
import { fixture, config as base, at, user, other, actor, snowflake, request } from './helpers/shop-fixture.js';

const channelId = '100000000000000060';
const config = { ...base, clanChatChannelId: '100000000000000041', voiceChannelId: '100000000000000042' };
const prize = (time = at, sequence = 700, patch = {}) => ({ id: snowflake(time, sequence), userId: user, channelId, at: time, ...patch });
const dice = (type, value) => min => min === 0 ? type : value;
async function setup(start = at) {
  const f = await fixture(); let now = start;
  f.store.config = config; f.service.config = config; f.service.clock = () => now;
  f.documents.settings[0].bank.salaryAmount = 500;
  await f.store.initializeActivity(start);
  return { ...f, time: value => { now = value; } };
}

test('all three prize types have inclusive percentage and money limits', () => {
  for (const [type, name, min, max] of [[0, 'salary', 50, 70], [1, 'salary', 50, 70], [2, 'money', 500, 2000]]) {
    for (const value of [min, max]) {
      const calls = [];
      const p = drawPrize((lo, hi) => { calls.push([lo, hi]); return lo === 0 ? type : value; });
      assert.deepEqual(calls, [[0, 3], [min, max + 1]]);
      assert.equal(p.type, name); assert.equal(name === 'money' ? p.amount : p.percent, value);
    }
  }
  for (const choose of [() => 3, dice(0, 49), dice(1, 71), dice(2, 499), dice(2, 2001)]) assert.throws(() => drawPrize(choose));
  assert.equal(PRIZE_INTERVAL_MS, 7200000);
});

test('money prizes credit the wallet and rankings once and can be spent without changing quest or activity progress', async () => {
  const f = await setup();
  const first = await f.service.claimPrize(prize(), () => true, dice(2, 1000));
  assert.equal(first.amount, 1000); assert.equal(first.after, 1000);
  const dontDraw = () => { throw new Error('duplicate must not draw again'); };
  assert.equal((await f.service.claimPrize(prize(), () => true, dontDraw)).duplicate, true);
  const state = await f.service.day(user);
  assert.equal(state.prizeReceipts.length, 1); assert.equal(netPoints(state).total, 1000);
  assert.equal(state.points.tasks, 0); assert.equal(state.completionLog.length, 0);
  assert.equal((await f.store.ranking('all', 'total', at))[0].total, 1000);
  assert.equal((await f.store.resetPreview(user)).tasks, 1000);
  await f.service.purchase(request());
  assert.equal((await f.service.balance(user)).total, 850);
});

test('simultaneous prize requests pay once and preserve the same first draw', async () => {
  const f = await setup(); let draws = 0;
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => f.service.claimPrize(prize(at, 700 + i), () => true,
    (min, max) => { draws++; return min === 0 ? 2 : 2000; })));
  assert.equal(results.filter(r => r.status === 'claimed').length, 1);
  assert.equal(results.filter(r => r.status === 'cooldown').length, 11);
  assert.equal(draws, 2); assert.equal((await f.service.balance(user)).total, 2000);
});

test('two-hour prize cooldown survives midnight and restart and expires at the exact boundary', async () => {
  const midnight = nextReset(at), start = midnight - 1000;
  const f = await setup(start);
  const first = await f.service.claimPrize(prize(start), () => true, dice(2, 1000));
  const end = start + 7200000;
  for (const time of [midnight + 1000, end - 1]) {
    const response = await f.open(time).service.claimPrize(prize(time));
    assert.equal(response.status, 'cooldown'); assert.equal(response.nextAt, end);
  }
  const next = await f.open(end).service.claimPrize(prize(end), () => true, dice(2, 2000));
  assert.equal(next.amount, 2000); assert.equal(first.nextAt, end);
  assert.equal((await f.service.balance(user)).total, 3000);
});

test('invalid, stale, ineligible, wrong-channel and unsafe-balance requests never award a prize', async () => {
  const f = await setup();
  for (const patch of [{ channelId: other }, { id: 'bad' }, { at: at - 900001 }, { at: at + 5001 }]) {
    await assert.rejects(f.service.claimPrize(prize(at, 700, patch)));
  }
  await assert.rejects(f.service.claimPrize(prize(), () => false));
  assert.equal(f.documents.days.length, 0);
  await f.seed(user, Number.MAX_SAFE_INTEGER);
  await assert.rejects(f.service.claimPrize(prize(), () => true, dice(2, 1000)), /الحد الرقمي/);
  assert.equal(await f.store.latestPrize(user), null);
  f.documents.leases[0].expiresAt = at;
  await assert.rejects(f.service.claimPrize(prize()), /قفل تشغيل/);
});

for (const [type, value] of [[0, 50], [1, 70], [2, 2000]]) {
  test(`lost prize acknowledgement preserves type ${type} and its value without rerolling or duplicating`, async () => {
    const f = await setup(); let failed = false;
    f.intercept(e => {
      if (!failed && e.name === 'days' && e.method === 'replaceOne' && e.phase === 'after' && e.args[1].prizeReceipts?.length) {
        failed = true; throw new Error('lost acknowledgement');
      }
    });
    const saved = await f.service.claimPrize(prize(), () => true, dice(type, value));
    assert.equal(failed, true); assert.equal(f.service.blocked, false);
    const again = await f.open(at + 1000).service.claimPrize(prize(), () => true, () => { throw new Error('reroll'); });
    assert.equal(again.duplicate, true); assert.equal(again.type, saved.type);
    assert.equal(again.amount, saved.amount); assert.equal(again.percent, saved.percent);
    assert.equal((await f.store.latestPrize(user)).prizeReceipts.length, 1);
  });
}

test('an unconfirmed prize write blocks further awards until restart and never creates hidden money', async () => {
  const f = await setup();
  f.intercept(e => {
    if (e.name === 'days' && e.method === 'replaceOne' && e.phase === 'before' && e.args[1].prizeReceipts?.length) throw new Error('write failed');
  });
  await assert.rejects(f.service.claimPrize(prize(), () => true, dice(2, 1500)), /لم يتأكد/);
  await assert.rejects(f.service.claimPrize(prize(at, 701)), /الاحتساب متوقف/);
  f.intercept(() => {});
  assert.equal((await f.store.totals(user, 'all', at)).total, 0);
  assert.equal((await f.open(at + 1000).service.claimPrize(prize(), () => true, dice(2, 1500))).amount, 1500);
});

test('salary boost is consumed atomically once, does not shorten one hour and returns to the base amount', async () => {
  const f = await setup(); await f.service.claimPrize(prize(), () => true, dice(1, 60));
  const paid = await f.service.claimSalary(prize(at, 710));
  assert.equal(paid.baseAmount, 500); assert.equal(paid.bonusAmount, 300); assert.equal(paid.amount, 800);
  assert.equal(paid.nextAt, at + 3600000);
  assert.equal((await f.service.claimSalary(prize(at, 710))).duplicate, true);
  assert.equal(await f.store.nextPrizeBonus(user, 'salary'), null);
  assert.equal((await f.open(at + 3600000 - 1).service.claimSalary(prize(at + 3600000 - 1))).status, 'cooldown');
  const next = await f.open(at + 3600000).service.claimSalary(prize(at + 3600000));
  assert.equal(next.amount, 500); assert.equal(next.bonusId, undefined);
  assert.equal((await f.service.balance(user)).total, 1300);
});

test('a salary bonus survives a blocked salary request and midnight until a successful payout', async () => {
  const start = nextReset(at) - 1000;
  const f = await setup(start); await f.service.claimSalary(prize(start, 710));
  const bonus = await f.service.claimPrize(prize(start), () => true, dice(1, 70));
  f.time(start + 1000);
  assert.equal((await f.service.claimSalary(prize(start + 1000))).status, 'cooldown');
  assert.equal((await f.store.nextPrizeBonus(user, 'salary')).id, bonus.id);
  let failed = false;
  f.intercept(e => {
    if (!failed && e.name === 'days' && e.method === 'replaceOne' && e.phase === 'after' && e.args[1].salaryReceipts?.some(r => r.bonusId)) {
      failed = true; throw new Error('salary acknowledgement lost');
    }
  });
  const reopened = f.open(start + 7200000);
  const paid = await reopened.service.claimSalary(prize(start + 7200000));
  assert.equal(failed, true); assert.equal(paid.amount, 850);
  assert.equal(await reopened.store.nextPrizeBonus(user, 'salary'), null);
  assert.equal((await reopened.service.claimSalary(prize(start + 7200000))).amount, 850);
  assert.equal((await reopened.service.balance(user)).total, 1350);
});

test('multiple salary bonuses queue for separate salaries instead of stacking or replacing a win', async () => {
  const f = await setup(); const first = await f.service.claimPrize(prize(), () => true, dice(1, 50));
  f.time(at + 7200000);
  const second = await f.service.claimPrize(prize(at + 7200000), () => true, dice(1, 70));
  const paid = await f.service.claimSalary(prize(at + 7200000, 710));
  assert.equal(paid.amount, 750); assert.equal(paid.bonusId, first.id);
  assert.equal((await f.store.nextPrizeBonus(user, 'salary')).id, second.id);
  const later = f.open(at + 43200000);
  assert.equal((await later.service.claimSalary(prize(at + 43200000))).amount, 850);
  assert.equal(await later.store.nextPrizeBonus(user, 'salary'), null);
});

test('reset clears prize credits and unspent bonuses together while refusing pre-reset requests', async () => {
  const f = await setup(); await f.service.claimPrize(prize(), () => true, dice(1, 50));
  f.time(at + 1000);
  await f.service.reset({ userId: user, actorId: actor, operationId: 'reset-prizes' });
  assert.equal(await f.store.nextPrizeBonus(user, 'salary'), null);
  await assert.rejects(f.service.claimPrize(prize()), /صلاحية/);
});
