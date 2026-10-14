import test from 'node:test';
import assert from 'node:assert/strict';
import { newRobberyRound, robberyOutcome, resolveRobbery, ROBBERY_TTL_MS, ROBBERY_LOOTED_PROTECTION_MS, ROBBERY_FAILED_PROTECTION_MS, ROBBERY_COMMAND_COOLDOWN_MS } from '../src/robbery.js';
import { netPoints } from '../src/point-adjustments.js';
import { dayStart } from '../src/time.js';
import { fixture, at, user, other, actor, config, snowflake, request } from './helpers/shop-fixture.js';

const channelId = '100000000000000060';
const input = (patch = {}) => ({ id: snowflake(at, 200), userId: user, targetId: other, channelId, at, ...patch });
const choice = (patch = {}) => ({ id: snowflake(at, 200), userId: user, channelId,
  resolutionId: snowflake(at, 201), move: 'paper', ...patch });
const dice = (move = 0, percent = 30, lossPercent = 60) => (min, max) => max === 2 ? 0 : min === 0 ? move : min === 40 ? lossPercent : percent;
const balance = (total, attendance = 0) => ({ tasks: total - attendance, attendance, total });
async function setup(money = 1000, victim = 2000) {
  const f = await fixture(); await f.store.robbery.initialize(at);
  await f.seed(user, money); await f.seed(other, victim);
  return f;
}
async function balances(f, time = at) {
  return Promise.all([user, other].map(id => f.store.totals(id, 'all', time).then(b => b.total)));
}

test('all nine rock-paper-scissors outcomes and inclusive random limits are correct', () => {
  const moves = ['rock', 'paper', 'scissors'];
  const expected = [['tie', 'loss', 'win'], ['win', 'tie', 'loss'], ['loss', 'win', 'tie']];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) assert.equal(robberyOutcome(moves[i], moves[j]), expected[i][j]);
  const calls = [];
  const first = newRobberyRound(input(), at, (min, max) => { calls.push([min, max]); return min; });
  assert.deepEqual(calls, [[0, 2], [0, 3], [15, 41], [40, 61]]); assert.equal(first.percent, 15); assert.equal(first.botMove, 'rock');
  const last = newRobberyRound(input(), at, (min, max) => max === 2 ? 0 : max - 1);
  assert.equal(last.percent, 40); assert.equal(last.botMove, 'scissors'); assert.equal(last.tiePercent, 0);
  assert.throws(() => robberyOutcome('fake', 'rock'));
});

test('win, loss and both tie directions transfer a percentage of the actual paying balance', () => {
  const round = newRobberyRound(input(), at, dice());
  const win = resolveRobbery(round, 'paper', { user: balance(1000), target: balance(2000) });
  assert.equal(win.amount, 600); assert.equal(win.fromId, other); assert.deepEqual(win.after, { user: 1600, target: 1400 });
  const loss = resolveRobbery(round, 'scissors', { user: balance(1000), target: balance(2000) });
  assert.equal(loss.amount, 600); assert.equal(loss.fromId, user); assert.deepEqual(loss.after, { user: 400, target: 2600 });
  for (const [a, b, payer] of [[1000, 2000, user], [2000, 1000, other]]) {
    const tie = resolveRobbery(round, 'rock', { user: balance(a), target: balance(b) });
    assert.equal(tie.amount, 0); assert.equal(tie.percent, 0); assert.equal(tie.fromId, null);
    assert.deepEqual(tie.after, { user: a, target: b });
  }
  const equal = resolveRobbery(round, 'rock', { user: balance(1000), target: balance(1000) });
  assert.equal(equal.amount, 0); assert.equal(equal.fromId, null); assert.deepEqual(equal.after, { user: 1000, target: 1000 });
});

test('fractional amounts round down, zero wallets transfer zero and unsafe balances are rejected', () => {
  const round = newRobberyRound(input(), at, dice(0, 15));
  assert.equal(resolveRobbery(round, 'paper', { user: balance(0), target: balance(19) }).amount, 2);
  assert.equal(resolveRobbery(round, 'paper', { user: balance(1), target: balance(6) }).amount, 0);
  assert.equal(resolveRobbery(round, 'scissors', { user: balance(0), target: balance(1000) }).amount, 0);
  const large = resolveRobbery(round, 'paper', { user: balance(0), target: balance(Number.MAX_SAFE_INTEGER) });
  assert.equal(large.amount, Number(BigInt(Number.MAX_SAFE_INTEGER) * 15n / 100n));
  assert.throws(() => resolveRobbery(round, 'paper', { user: balance(Number.MAX_SAFE_INTEGER), target: balance(100) }), /الحد الرقمي/);
  assert.throws(() => resolveRobbery(round, 'paper', { user: balance(-1), target: balance(100) }));
});

for (const [name, money, victim, move, protectionMs] of [
  ['successful theft', 1000, 2000, 'paper', ROBBERY_LOOTED_PROTECTION_MS],
  ['initiator loses', 1000, 2000, 'scissors', ROBBERY_FAILED_PROTECTION_MS],
  ['tie with a poorer target', 2000, 1000, 'rock', 0],
  ['tie with a richer target', 1000, 2000, 'rock', 0],
  ['equal balances', 1000, 1000, 'rock', 0],
  ['empty target wallet', 1000, 0, 'paper', 0],
  ['rounded transfer is zero', 1000, 1, 'paper', 0]
]) test(`target protection: ${name}`, async () => {
  const f = await setup(money, victim);
  await f.service.openRobbery(input(), () => true, dice());
  const round = await f.service.settleRobbery(choice({ move }));
  assert.deepEqual(round.protection, protectionMs ? { userId: other, durationMs: protectionMs,
    startedAt: at, expiresAt: at + protectionMs } : null);
  assert.deepEqual(await f.store.robbery.activeProtection(other, at), round.protection);
  assert.equal(await f.store.robbery.activeProtection(user, at), null);
  const nextAt = at + ROBBERY_COMMAND_COOLDOWN_MS;
  if (protectionMs) {
    const next = f.open(nextAt);
    await assert.rejects(next.service.openRobbery(input({ id: snowflake(nextAt, 280), at: nextAt })), /تحت الحماية/);
    if (protectionMs < ROBBERY_COMMAND_COOLDOWN_MS) {
      const laterAt = at + ROBBERY_COMMAND_COOLDOWN_MS;
      assert.equal((await f.open(laterAt).store.robbery.activeProtection(other, laterAt)), null);
    }
  } else {
    assert.equal((await f.open(nextAt).service.openRobbery(input({ id: snowflake(nextAt, 280), at: nextAt }), () => true, dice())).status, 'open');
  }
  assert.equal(f.service.blocked, false);
});

test('one-hour shield starts at settlement, survives restart and expires at the exact boundary', async () => {
  const f = await setup(); await f.service.openRobbery(input(), () => true, dice());
  const settledAt = at + 5000;
  const round = await f.open(settledAt).service.settleRobbery(choice());
  const expiresAt = settledAt + 3600000;
  assert.equal(round.protection.expiresAt, expiresAt);
  const before = f.open(expiresAt - 1);
  await before.store.robbery.initialize(expiresAt - 1);
  await assert.rejects(before.service.openRobbery(input({ id: snowflake(expiresAt - 1), at: expiresAt - 1 })), /تحت الحماية/);
  assert.equal((await before.service.settleRobbery(choice({ move: 'rock' }))).protection.expiresAt, expiresAt);
  const expired = f.open(expiresAt);
  assert.equal(await expired.store.robbery.activeProtection(other, expiresAt), null);
  const next = await expired.service.openRobbery(input({ id: snowflake(expiresAt), at: expiresAt }), () => true, dice());
  assert.equal(next.status, 'open');
  assert.equal((await expired.service.settleRobbery(choice())).duplicate, true);
  assert.equal(await expired.store.robbery.activeProtection(other, expiresAt), null);
});

test('a protected target can initiate a challenge and unrelated targets remain available', async () => {
  const f = await setup(); await f.seed(actor, 1000);
  await f.service.openRobbery(input(), () => true, dice());
  await f.service.settleRobbery(choice());
  const original = await f.store.robbery.activeProtection(other, at);
  for (const [userId, sequence] of [[other, 280], [user, 281]]) {
    const nextAt = at + ROBBERY_COMMAND_COOLDOWN_MS;
    const next = await f.open(nextAt).service.openRobbery(input({ id: snowflake(nextAt, sequence), userId,
      targetId: userId === other ? actor : '100000000000000098', at: nextAt }));
    assert.equal(next.status, 'open');
  }
  assert.deepEqual(await f.store.robbery.activeProtection(other, at), original);
});

test('legacy settled rounds remain replayable without creating a retroactive shield', async () => {
  const f = await setup(); await f.service.openRobbery(input(), () => true, dice());
  await f.service.settleRobbery(choice());
  delete f.documents.robbery_rounds[0].protection;
  assert.equal((await f.service.settleRobbery(choice())).duplicate, true);
  assert.equal(await f.store.robbery.activeProtection(other, at), null);
  assert.equal((await f.open(at + ROBBERY_COMMAND_COOLDOWN_MS).service.openRobbery(input({ id: snowflake(at + ROBBERY_COMMAND_COOLDOWN_MS), at: at + ROBBERY_COMMAND_COOLDOWN_MS }))).status, 'open');
  assert.deepEqual(await balances(f), [1600, 1400]);
});

test('hidden choice and percent are stored before rendering and survive repeat commands and restart', async () => {
  const f = await setup();
  const original = await f.service.openRobbery(input(), () => true, dice(2, 37));
  assert.equal(original.botMove, 'scissors'); assert.equal(original.percent, 37);
  assert.equal(original.expiresAt, at + ROBBERY_TTL_MS); assert.equal(f.documents.robbery_rounds.length, 1);
  const restarted = f.open(at + 1000);
  const dontReroll = () => { throw new Error('must not reroll'); };
  assert.deepEqual(await restarted.service.openRobbery(input(), () => true, dontReroll), original);
  await assert.rejects(restarted.service.openRobbery(input({ id: snowflake(at, 210) }), () => true, dontReroll), /تحدي نهب مفتوح/);
  assert.deepEqual(await balances(f), [1000, 2000]);
  await assert.rejects(restarted.service.openRobbery(input({ id: snowflake(at, 211), targetId: actor })), /تحدي نهب مفتوح/);
});

test('same member must wait a full minute after finishing a robbery before starting another, and the wait survives restart', async () => {
  const f = await setup();
  await f.service.openRobbery(input(), () => true, dice());
  await f.service.settleRobbery(choice());
  const before = f.open(at + ROBBERY_COMMAND_COOLDOWN_MS - 1);
  await assert.rejects(before.service.openRobbery(input({ id: snowflake(at + ROBBERY_COMMAND_COOLDOWN_MS - 1), at: at + ROBBERY_COMMAND_COOLDOWN_MS - 1, targetId: actor })), /لازم تنتظر 1 ثانية كاملة/);
  const after = f.open(at + ROBBERY_COMMAND_COOLDOWN_MS);
  const next = await after.service.openRobbery(input({ id: snowflake(at + ROBBERY_COMMAND_COOLDOWN_MS), at: at + ROBBERY_COMMAND_COOLDOWN_MS, targetId: actor }), () => true, dice());
  assert.equal(next.status, 'open');
});

test('bad participants, membership, request age, lease and forged round ownership cannot transfer money', async () => {
  const f = await setup();
  for (const patch of [{ targetId: user }, { targetBot: true }, { channelId: 'bad' }, { at: at - 900001 }, { at: at + 6000 }]) {
    await assert.rejects(f.service.openRobbery(input(patch)));
  }
  await assert.rejects(f.service.openRobbery(input(), id => id === user), /سيرفر الكلان/);
  await f.service.openRobbery(input(), () => true, dice());
  for (const patch of [{ userId: other }, { channelId: actor }, { move: 'fake' }, { id: snowflake(at, 300) }]) {
    await assert.rejects(f.service.settleRobbery(choice(patch)));
  }
  await assert.rejects(f.service.settleRobbery(choice(), () => false), /عضوية/);
  f.documents.leases[0].expiresAt = at;
  await assert.rejects(f.service.settleRobbery(choice()), /قفل تشغيل/);
  assert.deepEqual(await balances(f), [1000, 2000]);
});

test('payment uses balances at the click, credits immediately and cannot alter activity or earned rewards', async () => {
  const f = await setup();
  f.documents.days.forEach(day => { day.activity = { clanMessages: 12, voiceMs: 3600000 }; });
  const original = f.documents.days.map(day => ({ points: structuredClone(day.points), activity: structuredClone(day.activity), attendance: structuredClone(day.attendance), tasks: structuredClone(day.tasks) }));
  await f.service.openRobbery(input(), () => true, dice());
  await f.service.adjustPoints({ userId: other, actorId: actor, operationId: snowflake(at, 205), at,
    category: 'total', mode: 'remove', amount: 1000 });
  const result = await f.service.settleRobbery(choice());
  assert.equal(result.result.amount, 300); assert.deepEqual(await balances(f), [1300, 700]);
  assert.equal((await f.store.resetPreview()).tasks, 2000);
  assert.deepEqual(f.documents.days.map(day => ({ points: day.points, activity: day.activity, attendance: day.attendance, tasks: day.tasks })), original);
  assert.equal(netPoints(f.documents.days[0]).total, 1300);
  assert.equal((await f.store.robbery.get()).pending, null);
});

test('concurrent presses with different moves settle exactly once and later presses return the saved result', async () => {
  const f = await setup(); await f.service.openRobbery(input(), () => true, dice());
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => f.service.settleRobbery(choice({
    resolutionId: snowflake(at, 220 + index), move: index % 2 ? 'scissors' : 'paper' }))));
  assert.equal(results.filter(r => !r.duplicate).length, 1);
  assert.ok(results.every(r => r.playerMove === 'paper' && r.result.amount === 600));
  assert.deepEqual(await balances(f), [1600, 1400]);
  assert.ok(f.documents.days.every(day => day.robberyReceipts.length === 1));
  const restarted = f.open(at + 86400000);
  assert.equal((await restarted.service.settleRobbery(choice({ move: 'rock' }))).duplicate, true);
  assert.deepEqual(await balances(f), [1600, 1400]);
});

test('loss can debit both wallet buckets while recipient earns currency without consuming voice cap', async () => {
  const f = await fixture(); await f.store.robbery.initialize(at);
  await f.seed(user, 10, 990); await f.seed(other, 100);
  await f.service.openRobbery(input(), () => true, dice(0, 40, 50));
  const result = await f.service.settleRobbery(choice({ move: 'scissors' }));
  assert.deepEqual(result.result.debit, { tasks: 10, attendance: 490 });
  assert.deepEqual(await balances(f), [500, 600]);
  assert.equal((await f.store.totals(user, 'all', at)).tasks, 0);
  assert.equal(f.documents.days[0].points.attendance, 990);
  assert.equal(f.documents.days[1].points.tasks, 100);
});

test('equal-money and sub-unit results persist as completed without fabricating a transfer', async () => {
  for (const [a, b, move] of [[1000, 1000, 'rock'], [5, 6, 'paper']]) {
    const f = await setup(a, b); await f.service.openRobbery(input(), () => true, dice(0, 15));
    const result = await f.service.settleRobbery(choice({ move }));
    assert.equal(result.status, 'settled'); assert.equal(result.result.amount, 0);
    assert.deepEqual(await balances(f), [a, b]);
    assert.equal(f.documents.days.some(day => day.robberyReceipts?.length), false);
  }
});

test('an expired challenge is a loss, and a later challenge has its own hidden draw', async () => {
  const f = await setup(); await f.service.openRobbery(input(), () => true, dice());
  const expired = f.open(at + ROBBERY_TTL_MS);
  const result = await expired.service.settleRobbery(choice());
  assert.equal(result.status, 'settled'); assert.equal(result.endReason, 'timeout'); assert.equal(result.result.outcome, 'loss');
  assert.equal((await expired.store.robbery.activeProtection(other, at + ROBBERY_TTL_MS)).durationMs, ROBBERY_FAILED_PROTECTION_MS);
  assert.deepEqual(await balances(f), [400, 2600]);
  const later = at + ROBBERY_TTL_MS + ROBBERY_FAILED_PROTECTION_MS;
  const round = await f.open(later).service.openRobbery(input({ id: snowflake(later), at: later }), () => true, dice(1, 17));
  assert.equal(round.botMove, 'paper'); assert.equal(round.percent, 17);
});

test('robbery, shop purchase and administrative debit share one gate and conserve the remaining wallets', async () => {
  const f = await setup(200, 1000); await f.service.openRobbery(input(), () => true, dice(0, 40, 50));
  const results = await Promise.allSettled([f.service.settleRobbery(choice({ move: 'scissors' })),
    f.service.purchase(request()), f.service.adjustPoints({ userId: user, actorId: actor, operationId: snowflake(at, 250),
      at, category: 'total', mode: 'remove', amount: 100 })]);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.deepEqual(await balances(f), [0, 1100]); assert.equal(f.documents.shop_orders.length, 0);
});

test('a second attacker is refused before play and still cannot bypass the first target shield', async () => {
  const f = await setup(1000, 2000); await f.seed(actor, 1000);
  await f.service.openRobbery(input(), () => true, dice(0, 40, 50));
  const secondId = snowflake(at, 260);
  await assert.rejects(f.service.openRobbery(input({ id: secondId, userId: actor }), () => true, dice(0, 40, 50)), /تحدي نهب قائم/);
  assert.equal(f.documents.robbery_rounds.length, 1);
  assert.equal((await f.service.settleRobbery(choice())).result.amount, 800);
  assert.deepEqual(await balances(f), [1800, 1200]);
  assert.equal((await f.store.totals(actor, 'all', at)).total, 1000);
  const restarted = f.open(at + 1000);
  await assert.rejects(restarted.service.openRobbery(input({ id: secondId, userId: actor })), /تحت الحماية/);
  await assert.rejects(restarted.service.openRobbery(input({ id: snowflake(at, 262), userId: actor })), /تحت الحماية/);
  await assert.rejects(restarted.service.settleRobbery(choice({ id: secondId, userId: actor })), /لا يخصك/);
  assert.equal((await restarted.service.openRobbery(input())).status, 'settled');
  assert.equal(restarted.service.blocked, false);
});

for (const [name, collection, phase, stage, committed] of [
  ['intent before commit', 'robberies', 'before', 'reserve', false],
  ['intent acknowledgement lost', 'robberies', 'after', 'reserve', true],
  ['debit before commit', 'days', 'before', 'debit', true],
  ['debit acknowledgement lost', 'days', 'after', 'debit', true],
  ['credit before commit', 'days', 'before', 'credit', true],
  ['credit acknowledgement lost', 'days', 'after', 'credit', true],
  ['result before commit', 'robbery_rounds', 'before', 'result', true],
  ['result acknowledgement lost', 'robbery_rounds', 'after', 'result', true],
  ['clear before commit', 'robberies', 'before', 'clear', true],
  ['clear acknowledgement lost', 'robberies', 'after', 'clear', true]
]) test(`robbery interruption recovery: ${name}`, async () => {
  const f = await setup(); await f.service.openRobbery(input(), () => true, dice()); let failed = false;
  f.intercept(event => {
    const document = event.args[1];
    const matchStage = stage === 'reserve' ? !!document?.pending : stage === 'clear' ? document?.pending === null
      : stage === 'result' ? document?.status === 'settled'
        : document?.robberyReceipts?.includes(input().id) && document.userId === (stage === 'debit' ? other : user);
    if (!failed && event.name === collection && event.method === 'replaceOne' && event.phase === phase && matchStage) {
      failed = true; throw new Error('simulated database interruption');
    }
  });
  await assert.rejects(f.service.settleRobbery(choice()), /لم يتأكد/); assert.equal(failed, true); assert.equal(f.service.blocked, true);
  await assert.rejects(f.service.reset({ actorId: actor, operationId: 'blocked' }), /الاحتساب متوقف/);
  await assert.rejects(f.service.purchase(request()), /الاحتساب متوقف/);
  await assert.rejects(f.service.adjustPoints({}), /الاحتساب متوقف/);
  await assert.rejects(f.service.walletView(user, ['all']), /الاحتساب متوقف/);
  await assert.rejects(f.service.balance(user), /الاحتساب متوقف/);
  f.intercept(() => {});
  const restarted = f.open(at + 1000);
  await restarted.store.robbery.initialize(at + 1000);
  await restarted.store.robbery.recover(at + 1000);
  await restarted.store.initializeResets(at + 1000);
  assert.deepEqual(await balances(f), committed ? [1600, 1400] : [1000, 2000]);
  assert.equal((await restarted.store.robbery.get()).pending, null);
  assert.equal((await restarted.store.robbery.activeProtection(other, at + 1000))?.expiresAt ?? null,
    committed ? at + 3600000 : null);
  const retry = await restarted.service.settleRobbery(choice());
  assert.equal(retry.duplicate, committed); assert.deepEqual(await balances(f), [1600, 1400]);
  assert.equal(retry.protection.expiresAt, (committed ? at : at + 1000) + 3600000);
  assert.ok(f.documents.days.every(day => day.robberyReceipts.length === 1));
});

test('lost creation acknowledgement cannot reroll the hidden bot choice after restart', async () => {
  const f = await setup(); let failed = false;
  f.intercept(event => {
    if (!failed && event.name === 'robbery_rounds' && event.method === 'updateOne' && event.phase === 'after') {
      failed = true; throw new Error('lost creation acknowledgement');
    }
  });
  await assert.rejects(f.service.openRobbery(input(), () => true, dice(2, 39)), /حفظ التحدي/);
  f.intercept(() => {});
  const restarted = f.open(at + 1000);
  const restored = await restarted.service.openRobbery(input(), () => true, () => { throw new Error('reroll'); });
  assert.equal(restored.botMove, 'scissors'); assert.equal(restored.percent, 39);
  assert.equal((await restarted.service.settleRobbery(choice({ move: 'rock' }))).result.amount, 780);
});

test('resetting either participant invalidates an open round; settled rounds never replay after resets', async () => {
  for (const id of [user, other, null]) {
    const f = await setup(); await f.service.openRobbery(input(), () => true, dice());
    const next = f.open(at + 1000); await next.service.reset({ userId: id, actorId: actor, operationId: 'reset-open' });
    const before = await balances(f);
    assert.equal((await next.service.settleRobbery(choice())).status, 'cancelled'); assert.deepEqual(await balances(f), before);
    assert.equal(await next.store.robbery.activeProtection(other, at + 1000), null);
  }
  const f = await setup(); await f.service.openRobbery(input(), () => true, dice()); await f.service.settleRobbery(choice());
  const next = f.open(at + 1000); await next.service.reset({ actorId: actor, operationId: 'reset-settled' });
  assert.equal((await next.service.settleRobbery(choice())).duplicate, true);
  assert.deepEqual(await balances(f), [0, 0]);
  assert.equal(f.documents.robbery_rounds[0].status, 'settled');
  assert.equal((await next.store.robbery.activeProtection(other, at + 1000)).expiresAt, at + 3600000);
});

test('a challenge crossing Saudi midnight debits and credits the settlement day only', async () => {
  const f = await setup(); const midnight = dayStart('2026-09-12'); const openedAt = midnight - 1000;
  const opening = f.open(openedAt); const id = snowflake(openedAt);
  await opening.service.openRobbery(input({ id, at: openedAt }), () => true, dice());
  const next = f.open(midnight + 1000);
  const result = await next.service.settleRobbery(choice({ id, resolutionId: snowflake(midnight + 1000) }));
  assert.ok(result.fromDayId.includes('2026-09-12')); assert.ok(result.toDayId.includes('2026-09-12'));
  assert.deepEqual(await balances(f, midnight), [1600, 1400]);
  assert.equal((await f.store.totals(user, 'daily', midnight)).total, 600);
  assert.equal((await f.store.totals(other, 'daily', midnight)).total, -600);
  assert.equal((await next.store.robbery.activeProtection(other, midnight + 1000)).expiresAt, midnight + 1000 + 3600000);
});

test('wallet display waits for both legs and never combines a pending debit with stale totals', { timeout: 3000 }, async () => {
  const f = await setup(); await f.service.openRobbery(input(), () => true, dice());
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.intercept(async event => {
    if (event.name === 'days' && event.method === 'replaceOne' && event.phase === 'after'
      && event.args[1].userId === other && event.args[1].robberyReceipts?.length) {
      await new Promise(resolve => { release = resolve; entered(); });
    }
  });
  const payment = f.service.settleRobbery(choice()); await waiting;
  let displayed = false, balanceDisplayed = false;
  const wallet = f.service.walletView(user, ['all', 'weekly']).then(result => { displayed = true; return result; });
  const balance = f.service.balance(user).then(result => { balanceDisplayed = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  try { assert.equal(displayed, false); assert.equal(balanceDisplayed, false); } finally { release(); }
  await payment;
  const snapshot = await wallet;
  assert.equal(snapshot.totals.all.total, 1600); assert.equal(netPoints(snapshot.state).total, 1600);
  assert.equal((await balance).total, 1600);
});

test('upgrade caps an existing twelve-hour theft shield at one hour from its original start without rewriting money', async () => {
  const f = await setup(); await f.service.openRobbery(input(), () => true, dice());
  await f.service.settleRobbery(choice());
  const record = f.documents.robbery_rounds[0];
  record.protection.durationMs = 12 * 3600000; record.protection.expiresAt = at + 12 * 3600000;
  const saved = structuredClone(f.documents);
  const restarted = f.open(at + 1800000);
  assert.equal((await restarted.store.robbery.activeProtection(other, at + 1800000)).expiresAt, at + 3600000);
  assert.equal((await restarted.service.settleRobbery(choice())).protection.durationMs, 3600000);
  assert.equal(await restarted.store.robbery.activeProtection(other, at + 3600000), null);
  assert.deepEqual(f.documents, saved);
  const expired = f.open(at + 3600000);
  assert.equal((await expired.service.openRobbery(input({ id: snowflake(at + 3600000), at: at + 3600000 }), () => true, dice())).status, 'open');
  assert.deepEqual(await balances(f), [1600, 1400]);
});

for (const [name, money, victim, move, oldHours, effectiveMs] of [
  ['loss', 1000, 2000, 'scissors', 3, ROBBERY_FAILED_PROTECTION_MS],
  ['tie debiting the target', 2000, 1000, 'rock', 12, 0],
  ['equal tie', 1000, 1000, 'rock', 3, 0]
]) test(`upgrade applies the current automatic shield rule to ${name} without changing its settled transfer`, async () => {
  const f = await setup(money, victim); await f.service.openRobbery(input(), () => true, dice());
  const result = await f.service.settleRobbery(choice({ move }));
  f.documents.robbery_rounds[0].protection = { userId: other, durationMs: oldHours * 3600000, startedAt: at, expiresAt: at + oldHours * 3600000 };
  const restarted = f.open(at + 1000);
  assert.equal((await restarted.store.robbery.activeProtection(other, at + 1000))?.expiresAt ?? null, effectiveMs ? at + effectiveMs : null);
  const replay = await restarted.service.settleRobbery(choice());
  assert.equal(replay.protection?.expiresAt ?? null, effectiveMs ? at + effectiveMs : null); assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.result, result.result);
  assert.deepEqual(await balances(f), [result.result.after.user, result.result.after.target]);
  const nextAt = at + Math.max(effectiveMs, ROBBERY_COMMAND_COOLDOWN_MS);
  assert.equal((await f.open(nextAt).service.openRobbery(input({ id: snowflake(nextAt), at: nextAt }), () => true, dice())).status, 'open');
});

test('an obsolete tie shield cannot hide the latest effective winning shield', async () => {
  const f = await setup(); await f.service.openRobbery(input(), () => true, dice());
  const settled = await f.service.settleRobbery(choice());
  const oldTie = structuredClone(f.documents.robbery_rounds[0]);
  oldTie._id += ':old-tie'; oldTie.id = snowflake(at, 298);
  oldTie.result.outcome = 'tie';
  oldTie.protection = { userId: other, durationMs: 12 * 3600000, startedAt: at + 1000, expiresAt: at + 1000 + 12 * 3600000 };
  f.documents.robbery_rounds.push(oldTie);
  assert.deepEqual(await f.store.robbery.activeProtection(other, at + 2000), settled.protection);
  assert.equal(await f.store.robbery.activeProtection(other, at + 3600000), null);
});

for (const move of ['paper', 'scissors', 'rock']) test(`upgrade recovery applies the current shield rule to an old pending ${move} result`, async () => {
  const f = await setup(); await f.service.openRobbery(input(), () => true, dice());
  let failed = false;
  f.intercept(event => {
    if (!failed && event.name === 'robberies' && event.method === 'replaceOne' && event.phase === 'after' && event.args[1].pending) {
      failed = true; throw new Error('interrupted after old intent');
    }
  });
  await assert.rejects(f.service.settleRobbery(choice({ move })), /لم يتأكد/);
  const pending = f.documents.robberies[0].pending;
  pending.protection = { userId: other, startedAt: at, durationMs: 12 * 3600000, expiresAt: at + 12 * 3600000 };
  f.intercept(() => {});
  const reopened = f.open(at + 1000);
  const recovered = await reopened.store.robbery.recover(at + 1000);
  assert.deepEqual(await balances(f), [recovered.result.after.user, recovered.result.after.target]);
  assert.equal((await reopened.store.robbery.activeProtection(other, at + 1000))?.expiresAt ?? null,
    move === 'paper' ? at + 3600000 : move === 'scissors' ? at + ROBBERY_FAILED_PROTECTION_MS : null);
  assert.equal((await reopened.service.settleRobbery(choice())).duplicate, true);
  assert.equal(await reopened.store.robbery.recover(at + 1000), null);
});
