import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, at, user, other, actor, config, snowflake, request } from './helpers/shop-fixture.js';
import { netPoints } from '../src/point-adjustments.js';
import { dayNotices } from '../src/notification-events.js';
import { memberNotification } from '../src/notification-views.js';

const penalty = (seq = 1, time = at) => ({ userId: user, actorId: actor,
  operationId: snowflake(time, seq), at: time, reason: 'سبام' });
const balanceOf = f => f.store.totals(user, 'all', f.service.clock());

for (const [tasks, attendance] of [[0, 0], [1, 0], [499, 0], [500, 0], [501, 0], [100, 150], [200, 700], [0, 200]]) {
  test(`spam floors ${tasks} task funds + ${attendance} attendance funds without hidden debt`, async () => {
    const f = await fixture(); await f.seed(user, tasks, attendance); f.store.financialAudit = true;
    const result = await f.service.penalizeSpam(penalty());
    const charged = Math.min(500, tasks + attendance), balance = await balanceOf(f);
    assert.equal(result.amount, charged); assert.equal(result.requestedAmount, 500);
    assert.equal(result.delta, charged ? -charged : 0);
    assert.equal(result.totalAfter, tasks + attendance - charged);
    assert.equal(balance.total, tasks + attendance - charged);
    assert.ok(balance.tasks >= 0 && balance.attendance >= 0);
    const day = await f.service.day(user);
    assert.deepEqual(day.points, { tasks, attendance });
    const audit = day.financialPending.at(-1);
    assert.equal(audit.delta, charged ? -charged : 0); assert.equal(audit.after, balance.total);
    const event = dayNotices({}, day).find(n => n.kind === 'spam_penalty');
    assert.equal(event.data.amount, charged);
    const embed = memberNotification(event, {}, config.clanGuildId).embeds[0].toJSON();
    if (!charged) assert.match(embed.description, /لم يُخصم أي مبلغ/);
    else assert.ok(embed.description.includes(`**${charged} نقطة**`));
  });
}

test('many concurrent penalties share the available balance exactly once', async () => {
  const f = await fixture(); await f.seed(user, 650, 600);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => f.service.penalizeSpam(penalty(i + 1))));
  assert.equal(results.reduce((sum, r) => sum + r.amount, 0), 1250);
  assert.ok(results.every(r => r.totalAfter >= 0)); assert.equal((await balanceOf(f)).total, 0);
  assert.equal((await f.service.day(user)).adjustmentLog.length, 12);
});

test('a zero penalty stays settled after a later credit, midnight and restart', async () => {
  const f = await fixture(); const original = penalty();
  await f.service.penalizeSpam(original);
  const restarted = f.open(at + 86400000);
  await restarted.service.adjustPoints({ ...penalty(20, at + 86400000), category: 'total', mode: 'add', amount: 800 });
  const duplicate = await restarted.service.penalizeSpam(original);
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.amount, 0);
  assert.equal((await restarted.store.totals(user, 'all', at + 86400000)).total, 800);
  const next = await restarted.service.penalizeSpam(penalty(21, at + 86400000));
  assert.equal(next.amount, 500); assert.equal(next.totalAfter, 300);
});

test('spending yesterday funds keeps a legitimate negative daily entry without creating money', async () => {
  const f = await fixture(); await f.seed(user, 600, 0, at - 86400000);
  assert.equal((await f.service.penalizeSpam(penalty())).totalAfter, 100);
  assert.equal(netPoints(await f.service.day(user)).total, -500);
  assert.equal(await f.store.repairNegativeBalances(at), 0);
  assert.equal((await balanceOf(f)).total, 100);
});

test('a purchase and simultaneous penalties cannot overspend the same funds', async () => {
  const f = await fixture({ price: 150 }); await f.seed(user, 550);
  const [order, first, second] = await Promise.all([
    f.service.purchase(request()), f.service.penalizeSpam(penalty(2)), f.service.penalizeSpam(penalty(3))
  ]);
  assert.equal(order.product.price + first.amount + second.amount, 550);
  assert.equal((await balanceOf(f)).total, 0);
});

test('spam cannot spend challenge escrow or charge the loser a second time', async () => {
  const f = await fixture(); await f.seed(user, 300); await f.seed(other, 300);
  const game = f.service.xo, channelId = '100000000000000060'; await game.initialize();
  let round = await game.open({ id: snowflake(at, 90), x: user, o: other, amount: 300, channelId }, async () => true);
  round = await game.act({ id: round.id, userId: other, revision: round.revision, move: 'accept', channelId }, async () => true);
  assert.equal((await f.service.penalizeSpam(penalty())).amount, 0);
  await game.run(() => game.finish(round, 'won', other));
  assert.equal((await balanceOf(f)).total, 0);
  assert.equal((await f.store.totals(other, 'all', at)).total, 600);
});

test('lost penalty write acknowledgement does not repeat a partial debit', async () => {
  const f = await fixture(); await f.seed(user, 120); let lost = false;
  f.intercept(({ name, method, phase }) => {
    if (!lost && name === 'days' && method === 'replaceOne' && phase === 'after') {
      lost = true; throw new Error('lost acknowledgement');
    }
  });
  assert.equal((await f.service.penalizeSpam(penalty())).amount, 120);
  assert.equal((await f.open().service.penalizeSpam(penalty())).duplicate, true);
  assert.equal((await balanceOf(f)).total, 0);
  assert.equal((await f.service.day(user)).adjustmentLog.length, 1);
});

for (const [tasks, attendance, expected] of [[-700, 0, 0], [-700, 200, 0], [-100, 500, 400], [600, -100, 500]]) {
  test(`legacy correction normalizes ${tasks} + ${attendance}, preserving the net positive balance`, async () => {
    const f = await fixture(); await f.seed(user, tasks, attendance); await f.seed(other, 1000);
    f.store.financialAudit = true;
    const original = structuredClone(f.documents.days[0]);
    assert.equal(await f.store.repairNegativeBalances(at), 1);
    const balance = await balanceOf(f), day = await f.service.day(user);
    assert.equal(balance.total, expected); assert.ok(balance.tasks >= 0 && balance.attendance >= 0);
    assert.deepEqual(day.points, original.points); assert.deepEqual(day.tasks, original.tasks);
    assert.deepEqual(day.attendance, original.attendance);
    assert.equal(day.balanceFloorReceipts.length, 1);
    assert.equal(day.financialPending.at(-1).after, expected);
    assert.equal((await f.store.totals(other, 'all', at)).total, 1000);
    assert.equal(await f.open().store.repairNegativeBalances(at), 0);
    await f.service.adjustPoints({ ...penalty(20), category: 'total', mode: 'add', amount: 100 });
    assert.equal((await balanceOf(f)).total, expected + 100);
  });
}

test('legacy correction is scoped to the clan and bank reset includes the correction', async () => {
  const f = await fixture(); await f.seed(user, -400);
  const foreign = structuredClone(f.documents.days[0]); foreign.clanId = '100000000000000005'; foreign._id += ':foreign';
  f.documents.days.push(foreign);
  assert.equal(await f.store.repairNegativeBalances(at), 1);
  assert.deepEqual(f.documents.days.find(d => d._id === foreign._id), foreign);
  await f.service.adjustPoints({ ...penalty(30), category: 'total', mode: 'add', amount: 200 });
  await f.store.resetProgress({ userId: user, actorId: actor, operationId: 'floor-reset', target: 'bank' }, at + 1);
  assert.equal((await balanceOf(f)).total, 0);
  assert.equal(await f.store.repairNegativeBalances(at + 1), 0);
});

for (const phase of ['before', 'after']) {
  test(`interrupted legacy correction ${phase} commit resumes without duplicate credit`, async () => {
    const f = await fixture(); await f.seed(user, -500); await f.seed(other, -100);
    let lost = false;
    f.intercept(event => {
      if (!lost && event.name === 'days' && event.method === 'replaceOne' && event.phase === phase) {
        lost = true; throw new Error('interrupted correction');
      }
    });
    await assert.rejects(f.store.repairNegativeBalances(at), /interrupted correction/);
    f.intercept(() => {}); const restarted = f.open();
    await restarted.store.repairNegativeBalances(at);
    assert.equal(await restarted.store.repairNegativeBalances(at), 0);
    for (const id of [user, other]) {
      assert.equal((await restarted.store.totals(id, 'all', at)).total, 0);
      assert.equal(f.documents.days.find(d => d.userId === id).balanceFloorReceipts.length, 1);
    }
  });
}

test('ordinary administrative debit still refuses insufficient funds without changing the wallet', async () => {
  const f = await fixture(); await f.seed(user, 100);
  await assert.rejects(f.service.adjustPoints({ ...penalty(), category: 'total', mode: 'remove', amount: 101 }), /الرصيد المتاح/);
  assert.equal((await balanceOf(f)).total, 100);
});
