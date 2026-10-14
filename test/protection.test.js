import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTECTION_PRICE, PROTECTION_DURATION_MS } from '../src/protection.js';
import { netPoints } from '../src/point-adjustments.js';
import { dayStart } from '../src/time.js';
import { fixture, at, user, other, actor, snowflake, request } from './helpers/shop-fixture.js';
import { auctionFixture } from './helpers/auction-fixture.js';

const channelId = '100000000000000060';
const buy = (patch = {}) => ({ id: snowflake(at, 700), userId: user, channelId, at, ...patch });
const robbery = (patch = {}) => ({ id: snowflake(at, 710), userId: other, targetId: user, channelId, at, ...patch });
const choice = (patch = {}) => ({ id: snowflake(at, 710), userId: other, resolutionId: snowflake(at, 711), channelId, move: 'paper', ...patch });
const dice = min => min === 0 ? 0 : min === 40 ? 60 : 30;
async function setup(tasks = 15000, attendance = 0) {
  const f = await fixture(); await f.store.robbery.initialize(at);
  await f.seed(user, tasks, attendance); await f.seed(other, 20000);
  return f;
}

test('protection costs exactly 10000 for three hours, updates all wallet views and preserves activity and earned points', async () => {
  assert.equal(PROTECTION_PRICE, 10000); assert.equal(PROTECTION_DURATION_MS, 10800000);
  const f = await setup(7000, 5000);
  const day = f.documents.days.find(d => d.userId === user);
  day.activity = { clanMessages: 18, voiceMs: 900000 };
  const original = structuredClone(day);
  const result = await f.service.buyProtection(buy());
  assert.equal(result.status, 'paid'); assert.equal(result.after, 2000);
  assert.deepEqual(result.debit, { tasks: 7000, attendance: 3000 });
  assert.deepEqual(result.protection, { userId: user, durationMs: 10800000, startedAt: at, expiresAt: at + 10800000 });
  const saved = await f.store.getDay(day._id);
  for (const field of ['points', 'tasks', 'activity', 'attendance']) assert.deepEqual(saved[field], original[field]);
  assert.equal(netPoints(saved).total, 2000);
  assert.equal((await f.service.balance(user, channelId)).total, 2000);
  assert.equal((await f.service.bankTop(user, channelId)).self.value, 2000);
  assert.equal((await f.store.resetPreview(user, 'bank')).attendance, 2000);
  assert.deepEqual(await f.store.robbery.activeProtection(user, at), result.protection);
  assert.equal((await f.store.robbery.get()).pending, null);
});

test('insufficient funds, invalid requests, wrong channels, lost membership and lease errors cannot purchase protection', async () => {
  const f = await setup(9999);
  await assert.rejects(f.service.buyProtection(buy()), /رصيدك غير كافٍ.*10,000/);
  for (const patch of [{ id: 'bad' }, { userId: 'bad' }, { channelId: 'bad' }, { at: at - 900001 }, { at: at + 5001 }, { at: 0 }]) {
    await assert.rejects(f.service.buyProtection(buy(patch)), /صلاحية/);
  }
  await assert.rejects(f.service.buyProtection(buy({ channelId: actor })), /فقط/);
  await assert.rejects(f.service.buyProtection(buy(), () => false), /سيرفر الكلان/);
  f.documents.days.find(d => d.userId === user).points.tasks = 15000;
  let checks = 0;
  await assert.rejects(f.service.buyProtection(buy(), () => ++checks === 1), /لم تعد عضوًا/);
  f.documents.leases[0].expiresAt = at;
  await assert.rejects(f.service.buyProtection(buy()), /قفل تشغيل/);
  assert.equal((await f.store.totals(user, 'all', at)).total, 15000);
  assert.equal(f.documents.protection_purchases.length, 0);
  assert.equal((await f.store.robbery.get()).pending, null);
  assert.equal(f.service.blocked, false);
});

test('distinct simultaneous purchases stack three hours each until funds run out and replays never extend again', async () => {
  const f = await setup(30000);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => f.service.buyProtection(buy({ id: snowflake(at, 700 + i) }))));
  const paid = results.filter(x => x.status === 'fulfilled').map(x => x.value);
  assert.equal(paid.length, 3);
  assert.ok(results.filter(x => x.status === 'rejected').every(x => /رصيدك غير كافٍ/.test(x.reason.message)));
  assert.deepEqual(paid.map(x => x.protection.expiresAt), [at + 10800000, at + 21600000, at + 32400000]);
  const repeat = await f.service.buyProtection(buy());
  assert.equal(repeat.duplicate, true); assert.equal(repeat.protection.expiresAt, at + 10800000);
  assert.equal((await f.store.robbery.activeProtection(user, at)).expiresAt, at + 32400000);
  assert.equal((await f.store.totals(user, 'all', at)).total, 0);
  assert.equal(f.documents.protection_purchases.length, 3);
  assert.equal(f.documents.days[0].protectionReceipts.length, 3);
  await assert.rejects(f.service.buyProtection(buy({ userId: other })), /عملية حماية أخرى/);
});

test('simultaneous retries of the same purchase charge and extend exactly once', async () => {
  const f = await setup(30000);
  const first = await f.service.buyProtection(buy());
  const request = buy({ id: snowflake(at, 701) });
  const results = await Promise.all(Array.from({ length: 12 }, () => f.service.buyProtection(request)));
  assert.equal(results.filter(x => !x.duplicate).length, 1);
  assert.ok(results.every(x => x.protection.expiresAt === first.protection.expiresAt + 10800000));
  assert.equal((await f.store.totals(user, 'all', at)).total, 10000);
  assert.equal(f.documents.protection_purchases.length, 2);
});

test('buying adds three hours to an existing automatic one-hour shield and deducts its price', async () => {
  const f = await setup(30000);
  await f.service.openRobbery(robbery(), () => true, dice);
  const round = await f.service.settleRobbery(choice());
  assert.equal(round.protection.durationMs, 3600000);
  const before = (await f.store.totals(user, 'all', at)).total;
  const result = await f.service.buyProtection(buy());
  assert.equal(result.status, 'paid'); assert.equal(result.previousExpiresAt, round.protection.expiresAt);
  assert.equal(result.protection.expiresAt, at + 14400000);
  assert.equal(result.protection.durationMs, 14400000); assert.equal(result.addedDurationMs, 10800000);
  assert.equal((await f.store.totals(user, 'all', at)).total, before - 10000);
  assert.equal(f.documents.protection_purchases.length, 1);
  assert.deepEqual(await f.store.robbery.activeProtection(user, at), result.protection);
});

test('buying protection blocks already-open robbery buttons and new attackers without any transfer', async () => {
  const f = await setup();
  await f.service.openRobbery(robbery(), () => true, dice);
  const result = await f.service.buyProtection(buy());
  for (const move of ['rock', 'paper', 'scissors']) {
    const closed = await f.service.settleRobbery(choice({ move }));
    assert.equal(closed.status, 'cancelled'); assert.equal(closed.endReason, 'protection');
  }
  assert.equal((await f.service.openRobbery(robbery())).status, 'cancelled');
  await f.seed(actor, 1000);
  await assert.rejects(f.service.openRobbery(robbery({ id: snowflake(at, 720), userId: actor })), { code: 'ROBBERY_PROTECTED' });
  assert.equal((await f.store.totals(user, 'all', at)).total, result.after);
  assert.equal((await f.store.totals(other, 'all', at)).total, 20000);
  assert.equal(f.service.blocked, false);
});

test('simultaneous robbery and protection respect whichever operation commits first', async () => {
  for (const buyFirst of [true, false]) {
    const f = await setup(30000);
    await f.service.openRobbery(robbery(), () => true, dice);
    const results = await Promise.allSettled(buyFirst
      ? [f.service.buyProtection(buy()), f.service.settleRobbery(choice())]
      : [f.service.settleRobbery(choice()), f.service.buyProtection(buy())]);
    assert.equal(results[0].status, 'fulfilled');
    if (buyFirst) {
      assert.equal(results[1].status, 'fulfilled');
      assert.equal(results[1].value.status, 'cancelled'); assert.equal(results[1].value.endReason, 'protection');
      assert.equal((await f.store.totals(user, 'all', at)).total, 20000);
    } else {
      assert.equal(results[1].value.status, 'paid');
      assert.equal(results[1].value.protection.expiresAt, at + 14400000);
      assert.equal((await f.store.totals(user, 'all', at)).total, 11000);
      assert.equal(f.documents.protection_purchases.length, 1);
    }
  }
});

test('paid protection survives Saudi midnight and restart, expires exactly at three hours and can then be purchased again', async () => {
  const f = await setup(30000);
  const start = dayStart('2026-09-12') - 60000;
  const first = f.open(start);
  const paid = await first.service.buyProtection(buy({ at: start, id: snowflake(start, 700) }));
  const expiresAt = start + 10800000;
  for (const time of [start + 120000, expiresAt - 1]) {
    const restarted = f.open(time);
    await restarted.store.robbery.initialize(time); await restarted.store.robbery.recover(time);
    assert.deepEqual(await restarted.store.robbery.activeProtection(user, time), paid.protection);
    await assert.rejects(restarted.service.openRobbery(robbery({ at: time, id: snowflake(time, 710) })), { code: 'ROBBERY_PROTECTED' });
  }
  const next = f.open(expiresAt);
  assert.equal(await next.store.robbery.activeProtection(user, expiresAt), null);
  assert.equal((await next.service.openRobbery(robbery({ at: expiresAt, id: snowflake(expiresAt, 710) }), () => true, dice)).status, 'open');
  const renewed = await next.service.buyProtection(buy({ at: expiresAt, id: snowflake(expiresAt, 700) }));
  assert.equal(renewed.protection.expiresAt, expiresAt + 10800000);
  assert.equal((await next.store.totals(user, 'all', expiresAt)).total, 10000);
  assert.equal(f.documents.protection_purchases.length, 2);
});

for (const target of ['bank', 'activity', 'all']) test(`paid protection survives ${target} reset and replay cannot restore a debit or renew the shield`, async () => {
  const f = await setup(); const paid = await f.service.buyProtection(buy());
  const next = f.open(at + 1000);
  await next.service.reset({ userId: target === 'all' ? user : null, target, actorId: actor, operationId: `reset-${target}` });
  const reopened = f.open(at + 2000);
  await reopened.store.initializeResets(at + 2000);
  assert.deepEqual(await reopened.store.robbery.activeProtection(user, at + 2000), paid.protection);
  const replay = await reopened.service.buyProtection(buy());
  assert.equal(replay.duplicate, true);
  assert.equal((await reopened.store.totals(user, 'all', at + 2000)).total, target === 'activity' ? 5000 : 0);
  assert.equal(f.documents.protection_purchases.length, 1);
  if (target !== 'activity') await assert.rejects(reopened.service.buyProtection(buy({ id: snowflake(at, 701) })), /أقدم من آخر ريست/);
});

test('protection and shop purchases share the same available money and cannot overspend concurrently', async () => {
  for (const buyFirst of [true, false]) {
    const f = await setup(10100);
    const results = await Promise.allSettled(buyFirst
      ? [f.service.buyProtection(buy()), f.service.purchase(request())]
      : [f.service.purchase(request()), f.service.buyProtection(buy())]);
    assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected']);
    assert.equal((await f.store.totals(user, 'all', at)).total, buyFirst ? 100 : 9950);
    assert.equal(f.documents.protection_purchases.length, buyFirst ? 1 : 0);
  }
});

test('auction escrow is unavailable for buying protection', async () => {
  const f = await auctionFixture({ tasks: 10000 });
  await f.store.robbery.initialize(f.now());
  await f.service.bidAuction(f.bid({ opening: true }));
  await assert.rejects(f.service.buyProtection(buy({ at: f.now(), id: snowflake(f.now(), 700) })), /رصيدك غير كافٍ/);
  assert.equal((await f.balance(user)).total, 9000);
  assert.equal(f.documents.protection_purchases.length, 0);
});

for (const extending of [false, true]) for (const [stage, name, method, pending] of [
  ['intent', 'robberies', 'replaceOne', true],
  ['debit', 'days', 'replaceOne', null],
  ['receipt', 'protection_purchases', 'updateOne', null],
  ['completion', 'robberies', 'replaceOne', false]
]) for (const phase of ['before', 'after']) test(`protection ${extending ? 'extension' : 'purchase'} recovery handles ${stage} ${phase} write exactly once`, async () => {
  const f = await setup(extending ? 35000 : 15000); let failed = false;
  const first = extending ? await f.service.buyProtection(buy({ id: snowflake(at, 699) })) : null;
  const beforeBalance = extending ? 25000 : 15000;
  const originalExpiry = first?.protection.expiresAt ?? null;
  const finalExpiry = (originalExpiry ?? at) + 10800000;
  f.intercept(event => {
    if (!failed && event.name === name && event.method === method && event.phase === phase
      && (pending === null || !!event.args[1].pending === pending)) {
      failed = true; throw new Error('injected database interruption');
    }
  });
  await assert.rejects(f.service.buyProtection(buy()), /لم يتأكد اكتمال شراء الحماية/);
  assert.equal(failed, true); assert.equal(f.service.blocked, true);
  await assert.rejects(f.service.purchase(request()), /الاحتساب متوقف/);
  await assert.rejects(f.service.reset({ actorId: actor, operationId: 'blocked' }), /الاحتساب متوقف/);
  f.intercept(() => {});
  const reopened = f.open(at + 1000);
  await reopened.store.robbery.initialize(at + 1000);
  await reopened.store.robbery.recover(at + 1000);
  const committed = stage !== 'intent' || phase !== 'before';
  assert.equal((await reopened.store.totals(user, 'all', at + 1000)).total, beforeBalance - (committed ? 10000 : 0));
  assert.equal((await reopened.store.robbery.activeProtection(user, at + 1000))?.expiresAt ?? null, committed ? finalExpiry : originalExpiry);
  const result = await reopened.service.buyProtection(buy());
  assert.equal(result.duplicate, committed);
  assert.equal(result.protection.expiresAt, finalExpiry + (!committed && !extending ? 1000 : 0));
  assert.equal((await reopened.store.totals(user, 'all', at + 1000)).total, beforeBalance - 10000);
  assert.equal(f.documents.protection_purchases.length, extending ? 2 : 1);
  assert.equal(f.documents.days[0].protectionReceipts.length, extending ? 2 : 1);
  assert.equal((await reopened.store.robbery.get()).pending, null);
  assert.equal(await reopened.store.robbery.recover(at + 1000), null);
});

test('initiator losses create a 15-minute target shield while ties create none and paid protection is preserved', async () => {
  const f = await setup(30000);
  const bought = await f.service.buyProtection(buy());
  await f.service.openRobbery(robbery({ userId: user, targetId: other }), () => true, dice);
  const loss = await f.service.settleRobbery(choice({ userId: user, move: 'scissors' }));
  assert.deepEqual(loss.protection, { userId: other, durationMs: 15 * 60000, startedAt: at, expiresAt: at + 15 * 60000 });
  assert.deepEqual(await f.store.robbery.activeProtection(other, at), loss.protection);
  assert.deepEqual(await f.store.robbery.activeProtection(user, at), bought.protection);

  const later = at + 60000;
  const reopened = f.open(later);
  const tieRound = await reopened.service.openRobbery(robbery({ id: snowflake(later), userId: user, targetId: actor, channelId, at: later }), () => true, dice);
  const tie = await reopened.service.settleRobbery(choice({ id: tieRound.id, userId: user, targetId: actor, resolutionId: snowflake(later + 1), channelId, move: 'rock' }));
  assert.equal(tie.protection, null);
  assert.equal(await reopened.store.robbery.activeProtection(actor, later), null);
  assert.deepEqual(await reopened.store.robbery.activeProtection(user, later), bought.protection);
  assert.equal(f.documents.protection_purchases.length, 1);
});

test('stacked protection keeps the remaining time across midnight and restart and expires at the final boundary', async () => {
  const f = await setup(30000), start = dayStart('2026-09-12') - 60000;
  const first = await f.open(start).service.buyProtection(buy({ at: start, id: snowflake(start, 700) }));
  const later = start + 120000;
  const stacked = await f.open(later).service.buyProtection(buy({ at: later, id: snowflake(later, 701) }));
  assert.equal(stacked.previousExpiresAt, first.protection.expiresAt);
  assert.equal(stacked.protection.expiresAt, start + 21600000);
  assert.equal(stacked.protection.durationMs, 21600000 - 120000);
  assert.equal(stacked.addedDurationMs, 10800000);
  assert.equal((await f.store.totals(user, 'all', later)).total, 10000);
  const restarted = f.open(start + 21600000 - 1);
  await restarted.store.robbery.initialize(start + 21600000 - 1);
  await restarted.store.robbery.recover(start + 21600000 - 1);
  assert.deepEqual(await restarted.store.robbery.activeProtection(user, start + 21600000 - 1), stacked.protection);
  await assert.rejects(restarted.service.openRobbery(robbery({ at: start + 21600000 - 1, id: snowflake(start + 21600000 - 1) })), { code: 'ROBBERY_PROTECTED' });
  assert.equal(await restarted.store.robbery.activeProtection(user, start + 21600000), null);
});

test('a shield expiring while eligibility is checked starts the new three hours at purchase time', async () => {
  const f = await setup(30000);
  const first = await f.service.buyProtection(buy());
  let time = first.protection.expiresAt - 1;
  const next = f.open(time); next.service.clock = () => time;
  let checks = 0;
  const result = await next.service.buyProtection(buy({ at: time, id: snowflake(time, 701) }), () => {
    if (++checks === 2) time += 1001;
    return true;
  });
  assert.equal(result.previousExpiresAt, null);
  assert.equal(result.protection.expiresAt, time + 10800000);
  assert.equal(result.protection.durationMs, 10800000);
});


test('configured price and duration survive restart and renewal is blocked until the exact last minute', async () => {
  const f = await setup(20000);
  await f.service.configureBank({ actorId: actor, operationId: snowflake(at, 901), protectionPrice: 2500, protectionMinutes: 60, protectionStack: false });
  const first = await f.service.buyProtection(buy());
  assert.equal(first.price, 2500); assert.equal(first.addedDurationMs, 3600000);
  const end = first.protection.expiresAt;
  const early = f.open(end - 60001);
  await assert.rejects(early.service.buyProtection(buy({ id: snowflake(end - 60001, 701), at: end - 60001 })), /آخر دقيقة/);
  assert.equal((await f.service.balance(user)).total, 17500);
  const ready = f.open(end - 60000);
  const requests = [701, 702].map(n => buy({ id: snowflake(end - 60000, n), at: end - 60000 }));
  const results = await Promise.allSettled(requests.map(input => ready.service.buyProtection(input)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await ready.store.robbery.activeProtection(user, end - 60000)).expiresAt, end + 3600000);
  assert.equal((await ready.service.balance(user)).total, 15000);
});

test('changed quote or invalid settings cannot debit; configured stacking uses the remaining time', async () => {
  const f = await setup(20000);
  for (const fields of [{ protectionPrice: 0 }, { protectionMinutes: 0 }, { protectionStack: 'false' }]) {
    await assert.rejects(f.service.configureBank({ actorId: actor, operationId: snowflake(at, 903), ...fields }));
  }
  const quote = { protectionPrice: 10000, protectionMinutes: 180, protectionStack: true };
  await f.service.configureBank({ actorId: actor, operationId: snowflake(at, 904), protectionPrice: 2000, protectionMinutes: 10, protectionStack: true });
  await assert.rejects(f.service.buyProtection(buy({ quote })), /تغيرت إعدادات/);
  assert.equal((await f.service.balance(user)).total, 20000);
  const one = await f.service.buyProtection(buy());
  const two = await f.service.buyProtection(buy({ id: snowflake(at, 705) }));
  assert.equal(two.protection.expiresAt, one.protection.expiresAt + 600000);
  assert.equal((await f.service.balance(user)).total, 16000);
});
