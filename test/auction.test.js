import test from 'node:test';
import assert from 'node:assert/strict';
import { auctionStartTime, auctionIncrement, newAuction, AUCTION_DURATION_MS, MAX_AUCTION_AMOUNT } from '../src/auction.js';
import { netPoints } from '../src/point-adjustments.js';
import { auctionFixture, auctionInput, auctionId } from './helpers/auction-fixture.js';
import { at, user, other, actor, request, snowflake } from './helpers/shop-fixture.js';

test('Saudi dates, Arabic digits and increments validate without host timezone dependence', () => {
  assert.equal(auctionStartTime('2026-09-25', '20:30'), Date.parse('2026-09-25T17:30:00Z'));
  assert.equal(auctionStartTime('٢٠٢٦-٠٩-٢٥', '۲۰:۳۰'), Date.parse('2026-09-25T17:30:00Z'));
  for (const [date, time] of [['2026-02-30', '20:00'], ['2026-09-25', '24:00'], ['26-09-25', '12:00'], ['2026-09-25', '3:00']]) assert.throws(() => auctionStartTime(date, time));
  assert.equal(auctionIncrement('٧٥٠'), 750);
  for (const amount of ['0', '-1', '1.5', '1e3', '1,000', '', 'Infinity', String(MAX_AUCTION_AMOUNT + 1)]) assert.throws(() => auctionIncrement(amount));
  for (const change of [{ quantity: 0 }, { startsAt: at }, { startPrice: 0 }, { imageUrl: 'http://example.com/a.png' }, { name: 'x\ny' }]) assert.throws(() => newAuction(auctionInput(change), at));
});

test('opening, outbid refund and own increments reserve exactly the current winning bid', async () => {
  const f = await auctionFixture({ tasks: 1200, attendance: 4000 });
  await f.service.bidAuction(f.bid({ opening: true }));
  assert.equal((await f.balance(user)).total, 4200);
  await f.service.bidAuction(f.bid());
  assert.equal((await f.balance(user)).total, 3700);
  assert.deepEqual((await f.get()).hold, { tasks: 1200, attendance: 300 });
  const result = await f.service.bidAuction(f.bid({ userId: other, increment: 1000 }));
  assert.equal(result.amount, 2500); assert.equal(result.refundedAmount, 1500);
  assert.deepEqual(await f.balance(user), { _id: user, tasks: 1200, attendance: 4000, total: 5200, milliseconds: 0 });
  assert.equal((await f.balance(other)).total, 2700);
  assert.equal((await f.get()).highestBidderId, other);
  for (const d of f.documents.days) assert.equal(netPoints(d).total, d.points.tasks + d.points.attendance + (d.auctionAdjustments?.tasks || 0) + (d.auctionAdjustments?.attendance || 0));
});

test('duplicate interactions are idempotent, low balances and ineligible users leave all money unchanged', async () => {
  const f = await auctionFixture({ tasks: 1500 }); const input = f.bid();
  await Promise.all([f.service.bidAuction(input), f.service.bidAuction(input)]);
  assert.equal((await f.balance(user)).total, 0); assert.equal(f.documents.auction_events.length, 1);
  const before = structuredClone(f.documents);
  await assert.rejects(f.service.bidAuction(f.bid({ userId: other })), /رصيدك المتاح/);
  await assert.rejects(f.service.bidAuction(f.bid()), /رصيدك المتاح/);
  await assert.rejects(f.service.bidAuction(f.bid(), () => false), /أعضاء الكلان/);
  await assert.rejects(f.service.bidAuction(f.bid({ messageId: other })), /الأصلية/);
  assert.deepEqual(f.documents, before);
  assert.equal((await f.service.bidAuction(input)).duplicate, true);
});

test('competing simultaneous bids serialize and cannot overspend through the shop or another auction', async () => {
  const f = await auctionFixture({ tasks: 1800 });
  const results = await Promise.allSettled([f.service.bidAuction(f.bid()), f.service.bidAuction(f.bid({ userId: other }))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(f.service.purchase(request({ at: f.now(), checkoutId: snowflake(f.now(), 300), productId: '100000000000000051' })), /نفدت/);
  await f.service.manageShop((shop, now) => shop.add({ id: '100000000000000051', createdBy: actor, name: 'منتج', price: 400, stock: 1 }, now));
  await assert.rejects(f.service.purchase(request({ at: f.now(), checkoutId: snowflake(f.now(), 301), productId: '100000000000000051' })), /رصيدك/);
  const second = auctionInput({ id: snowflake(at, 90), startsAt: f.now() + 1000 });
  await f.service.createAuction(second);
  await f.service.auctionChange(second.id, a => { a.status = 'active'; a.startedAt = f.now(); a.endsAt = f.now() + AUCTION_DURATION_MS; a.delivery.live.messageId = other; return true; });
  await assert.rejects(f.service.bidAuction(f.bid({ auctionId: second.id, messageId: other })), /رصيدك/);
  assert.equal((await f.balance(user)).total, 300);
});

test('last 15 seconds add 30 seconds per accepted late bid and reject every expired or stale custom bid', async () => {
  const f = await auctionFixture(); const end = (await f.get()).endsAt;
  f.set(end - 15001); await f.service.bidAuction(f.bid()); assert.equal((await f.get()).endsAt, end);
  f.set(end - 15000); await f.service.bidAuction(f.bid()); assert.equal((await f.get()).endsAt, end + 30000);
  f.set(end + 29999); await f.service.bidAuction(f.bid({ userId: other })); assert.equal((await f.get()).endsAt, end + 60000);
  await assert.rejects(f.service.bidAuction(f.bid({ expectedAmount: 1000 })), /تغير السوم/);
  f.set(end + 60000); await assert.rejects(f.service.bidAuction(f.bid()), /انتهى/);
  await assert.rejects(f.service.settleAuction(auctionId, { actorId: actor, operationId: snowflake(f.now(), 999) }), /انتهى/);
  assert.equal((await f.get()).extensions, 2);
});

test('deadline is rechecked after a slow balance query, with no late charge', async () => {
  const f = await auctionFixture(); const end = (await f.get()).endsAt;
  f.set(end - 100); const original = f.store.totals.bind(f.store);
  f.store.totals = async (...args) => { const balance = await original(...args); f.set(end); return balance; };
  await assert.rejects(f.service.bidAuction(f.bid()), /انتهى/);
  assert.equal(f.documents.auction_events.length, 0); assert.equal((await f.get()).highestBidderId, null);
});

test('rejected bids never extend the deadline or exceed the amount limit', async () => {
  const f = await auctionFixture({ tasks: 1000 }); const end = (await f.get()).endsAt;
  f.set(end - 1000);
  await assert.rejects(f.service.bidAuction(f.bid()), /رصيدك المتاح/);
  assert.equal((await f.get()).endsAt, end); assert.equal((await f.get()).extensions, 0);
  await assert.rejects(f.service.bidAuction(f.bid({ increment: MAX_AUCTION_AMOUNT })), /الحد الأعلى/);
  assert.equal((await f.balance(user)).total, 1000);
});

test('settlement after restart permanently consumes the hold exactly once and preserves winner/quantity', async () => {
  const f = await auctionFixture(); await f.service.bidAuction(f.bid());
  f.set((await f.get()).endsAt + 60000);
  const restarted = f.restart(); await restarted.store.auctions.recover(f.now());
  await Promise.all([restarted.service.settleAuction(auctionId), restarted.service.settleAuction(auctionId)]);
  const a = await f.get(); assert.equal(a.status, 'ended'); assert.equal(a.hold, null);
  assert.equal(a.settlement.winnerId, user); assert.equal(a.settlement.amount, 1500); assert.equal(a.settlement.quantity, 3);
  assert.equal((await f.balance(user)).total, 8500);
  assert.equal(f.documents.auction_events.filter(e => e.type === 'ended').length, 1);
});

test('cancellation refunds, no-bid ending charges nobody, and resets cannot erase live holds', async () => {
  const f = await auctionFixture(); await f.service.bidAuction(f.bid());
  for (const userId of [user, null]) await assert.rejects(f.service.reset({ userId, actorId: actor, operationId: 'reset-auction' }), /حجز مزاد/);
  assert.equal(f.service.blocked, false);
  await f.service.reset({ userId: other, actorId: actor, operationId: 'unrelated-reset' });
  await f.service.settleAuction(auctionId, { actorId: actor, operationId: snowflake(f.now(), 700), reason: 'تغيير المنتج' });
  assert.equal((await f.balance(user)).total, 10000);
  assert.equal((await f.get()).status, 'cancelled');
  await f.service.reset({ userId: user, actorId: actor, operationId: 'after-refund' });
  assert.equal((await f.balance(user)).total, 0);
  const empty = await auctionFixture(); empty.set((await empty.get()).endsAt);
  const ended = await empty.service.settleAuction(auctionId);
  assert.equal(ended.settlement.winnerId, null); assert.equal(ended.settlement.amount, 0);
  assert.equal((await empty.balance(user)).total, 10000);
});

test('midnight does not lose holds or repeat the debit; refund keeps the original currency categories', async () => {
  const f = await auctionFixture({ tasks: 700, attendance: 2000 });
  const midnight = Date.parse('2026-09-12T00:00:00+03:00');
  f.set(midnight - 1000);
  await f.service.auctionChange(auctionId, a => { a.endsAt = midnight + 60000; return true; });
  const input = f.bid(); await f.service.bidAuction(input);
  f.set(midnight + 1000); await f.service.bidAuction(f.bid({ userId: other }));
  assert.equal((await f.balance(user)).total, 2700);
  assert.equal((await f.balance(user)).tasks, 700); assert.equal((await f.balance(user)).attendance, 2000);
  assert.equal((await f.service.bidAuction(input)).duplicate, true);
  assert.equal((await f.balance(other)).total, 700);
});

for (const [name, method, index] of [
  ['auction_journals', 'replaceOne', 1], ['days', 'replaceOne', 1], ['days', 'replaceOne', 2],
  ['auction_events', 'updateOne', 1], ['auctions', 'replaceOne', 1], ['auction_journals', 'replaceOne', 2]
]) for (const phase of ['before', 'after']) test(`outbid recovers money after ${phase} ${name}.${method} #${index}`, async () => {
  const f = await auctionFixture(); await f.service.bidAuction(f.bid());
  let calls = 0; let failed = false;
  f.intercept(event => {
    if (event.name === name && event.method === method && event.phase === phase && ++calls === index) {
      failed = true; throw new Error('injected crash');
    }
  });
  await assert.rejects(f.service.bidAuction(f.bid({ userId: other, increment: 1000 })), /تلقائيًا/);
  assert.ok(failed); assert.equal(f.service.blocked, true);
  await assert.rejects(f.service.balance(user), /الاحتساب متوقف/);
  f.intercept(() => {});
  const reopened = f.restart(); await reopened.store.auctions.recover(f.now()); await reopened.store.auctions.recover(f.now());
  const committed = !(name === 'auction_journals' && index === 1 && phase === 'before');
  assert.equal((await f.get()).highestBidderId, committed ? other : user);
  assert.equal((await f.balance(user)).total, committed ? 10000 : 8500);
  assert.equal((await f.balance(other)).total, committed ? 7500 : 10000);
  assert.equal((await reopened.store.auctions.pending()).pending, null);
});
