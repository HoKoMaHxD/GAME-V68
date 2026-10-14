import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProduct, MAX_PRODUCTS } from '../src/shop.js';
import { netPoints } from '../src/point-adjustments.js';
import { pointsEmbed, tasksEmbed } from '../src/presentation.js';
import { fixture, request, snowflake, at, user, other, actor, productId, config } from './helpers/shop-fixture.js';

test('shop accepts optional descriptions and rejects invalid product fields without changing catalog', async () => {
  assert.deepEqual(validateProduct({ name: ' منتج ', price: 10, stock: 0 }), { name: 'منتج', description: '', price: 10, stock: 0 });
  for (const patch of [{ name: '' }, { name: 'س'.repeat(81) }, { description: 'س'.repeat(301) }, { description: 3 },
    { price: 0 }, { price: -1 }, { price: 1.5 }, { price: 1000001 }, { stock: -1 }, { stock: 0.5 }, { stock: 100001 }]) {
    assert.throws(() => validateProduct({ name: 'منتج', price: 10, stock: 1, ...patch }));
  }
  const f = await fixture();
  const original = structuredClone(f.documents.shops);
  await assert.rejects(f.service.manageShop((shop, now) => shop.add({ id: snowflake(), createdBy: actor, name: 'بطاقة هدية', price: 5, stock: 2 }, now)), /يوجد منتج/);
  assert.deepEqual(f.documents.shops, original);
});

test('purchase spends tasks first then legacy attendance currency while quest progress stays intact', async () => {
  const f = await fixture(); const initial = await f.seed(user, 100, 90);
  const result = await f.service.purchase(request());
  assert.deepEqual(result.debit, { tasks: 100, attendance: 50 }); assert.equal(result.balanceAfter, 40);
  const saved = await f.store.getDay(initial._id);
  assert.deepEqual(saved.points, initial.points); assert.deepEqual(saved.tasks, initial.tasks);
  assert.deepEqual(saved.attendance, initial.attendance);
  assert.deepEqual(netPoints(saved), { tasks: 0, attendance: 40, total: 40 });
  for (const period of ['daily', 'weekly', 'monthly', 'all']) assert.equal((await f.store.totals(user, period, at)).total, 40);
  assert.equal((await f.store.resetPreview(user)).attendance, 40);
  assert.equal((await f.store.shop.get()).products[0].stock, 2);
  assert.equal(f.documents.shop_orders.length, 1); assert.equal(f.documents.shop_orders[0].notification.sent, false);
  assert.equal((await f.store.shop.get()).pending, null);
  const rule = { enabled: true, version: 1, points: 10, intervalMs: 60000, dailyCap: 90 };
  for (const embed of [pointsEmbed({ all: await f.store.totals(user, 'all', at) }, saved, rule, {}, at), tasksEmbed(saved, at, true, config, {}, rule)]) {
    const fields = embed.toJSON().fields;
    assert.equal(fields.some(field => /حد مكافآت الحضور|حضور الفويس اليوم/.test(field.name)), false);
    assert.match(fields.find(field => field.name.includes('مشتريات')).value, /150/);
  }
});

test('concurrent selection retries and different selections on the same menu make one order', async () => {
  const f = await fixture(); await f.seed();
  const results = await Promise.all(Array.from({ length: 12 }, () => f.service.purchase(request())));
  assert.equal(results.filter(r => !r.duplicate).length, 1);
  assert.equal((await f.service.purchase(request({ productId: other }))).duplicate, true);
  assert.equal((await f.store.shop.get()).products[0].stock, 2);
  assert.equal((await f.store.totals(user, 'all', at)).total, 850);
  assert.equal(f.documents.shop_orders.length, 1);
  await assert.rejects(f.service.purchase(request({ userId: other })), /عضوًا آخر/);
});

test('two members competing for the final item cannot oversell stock', async () => {
  const f = await fixture({ stock: 1 }); await f.seed(); await f.seed(other);
  const results = await Promise.allSettled([f.service.purchase(request()), f.service.purchase(request({ userId: other, checkoutId: snowflake(at, 1) }))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /نفدت/);
  assert.equal((await f.store.totals(user, 'all', at)).total + (await f.store.totals(other, 'all', at)).total, 1850);
  assert.equal((await f.store.shop.get()).products[0].stock, 0);
});

test('purchase and manual debit share a gate and cannot spend the same points twice', async () => {
  const f = await fixture(); await f.seed(user, 200);
  const results = await Promise.allSettled([f.service.purchase(request()), f.service.adjustPoints({ userId: user, actorId: actor,
    operationId: snowflake(at, 1), at, category: 'tasks', mode: 'remove', amount: 100 }),
  f.service.purchase(request({ checkoutId: snowflake(at, 2) }))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await f.store.totals(user, 'all', at)).total, 50);
});

test('insufficient funds, missing configuration, stale checkout and removed products do not debit', async () => {
  const f = await fixture(); await f.seed(user, 100);
  await assert.rejects(f.service.purchase(request()), /تحتاج 50/);
  await assert.rejects(f.service.purchase(request({ checkoutId: snowflake(at - 900001) })), /صلاحية/);
  await assert.rejects(f.service.purchase(request({ checkoutId: snowflake(at + 6000) })), /صلاحية/);
  await assert.rejects(f.service.purchase(request({ productId: 'bad' })), /معرف/);
  f.documents.shops[0].destination = null;
  await assert.rejects(f.service.purchase(request()), /اعدادات_المتجر/);
  await f.service.manageShop((shop, now) => shop.remove(productId, now));
  f.documents.shops[0].destination = { channelId: other, roleId: actor };
  await assert.rejects(f.service.purchase(request()), /أزيل/);
  assert.equal(f.documents.shop_orders.length, 0); assert.equal((await f.store.totals(user, 'all', at)).total, 100);
});

for (const [name, collection, phase, stage, committed] of [
  ['reservation not saved', 'shops', 'before', 'reserve', false],
  ['reservation acknowledgement lost', 'shops', 'after', 'reserve', true],
  ['debit not saved', 'days', 'before', null, true],
  ['debit acknowledgement lost', 'days', 'after', null, true],
  ['order not saved', 'shop_orders', 'before', null, true],
  ['order acknowledgement lost', 'shop_orders', 'after', null, true],
  ['completion not saved', 'shops', 'before', 'clear', true],
  ['completion acknowledgement lost', 'shops', 'after', 'clear', true]
]) test(`restart recovery: ${name}`, async () => {
  const f = await fixture({ stock: 1 }); await f.seed(); let failed = false;
  f.intercept(event => {
    const write = event.method === (collection === 'shop_orders' ? 'updateOne' : 'replaceOne');
    const matchingStage = stage === null || (stage === 'reserve' ? !!event.args[1]?.pending : event.args[1]?.pending === null);
    if (!failed && event.name === collection && event.phase === phase && write && matchingStage) {
      failed = true; throw new Error('simulated interruption');
    }
  });
  await assert.rejects(f.service.purchase(request()), /لم يتأكد/); assert.equal(failed, true); assert.equal(f.service.blocked, true);
  await assert.rejects(f.service.reset({ actorId: actor, operationId: 'reset-blocked' }), /الاحتساب متوقف/);
  await assert.rejects(f.service.adjustPoints({}), /الاحتساب متوقف/);
  f.intercept(() => {});
  const restarted = f.open(at + 1000);
  await restarted.store.shop.initialize(at + 1000);
  await restarted.store.shop.recover(at + 1000);
  await restarted.store.initializeResets(at + 1000);
  assert.equal(f.documents.shop_orders.length, committed ? 1 : 0);
  assert.equal((await restarted.store.totals(user, 'all', at)).total, committed ? 850 : 1000);
  assert.equal((await restarted.store.shop.get()).products[0].stock, committed ? 0 : 1);
  assert.equal((await restarted.store.shop.get()).pending, null);
  const retry = await restarted.service.purchase(request()); assert.equal(retry.duplicate, committed);
  assert.equal((await restarted.store.totals(user, 'all', at)).total, 850);
  assert.equal(f.documents.shop_orders.length, 1);
});

test('reset after purchase keeps orders and inventory; old menus cannot debit the new balance', async () => {
  const f = await fixture(); await f.seed(); await f.seed(other); await f.service.purchase(request());
  const next = f.open(at + 1000);
  await next.service.reset({ userId: user, actorId: actor, operationId: 'after-purchase' });
  assert.equal(f.documents.shop_orders.length, 1); assert.equal((await f.store.shop.get()).products[0].stock, 2);
  assert.equal((await f.store.totals(user, 'all', at)).total, 0);
  assert.equal((await f.store.totals(other, 'all', at)).total, 1000);
  await assert.rejects(next.service.purchase(request({ checkoutId: snowflake(at, 2) })), /آخر ريست/);
  assert.equal((await next.service.purchase(request())).duplicate, true);
  assert.equal((await f.store.totals(user, 'all', at)).total, 0);
  await next.service.reset({ userId: null, actorId: actor, operationId: 'all-after-purchase' });
  assert.equal(f.documents.shop_orders.length, 1); assert.equal((await f.store.shop.get()).products[0].stock, 2);
});

test('midnight preserves total wallet and records a purchase in its actual Saudi day', async () => {
  const f = await fixture(); await f.seed(user, 200, 0, at - 86400000);
  await f.service.purchase(request());
  assert.equal((await f.store.totals(user, 'daily', at)).total, -150);
  assert.equal((await f.store.totals(user, 'all', at)).total, 50);
  const tomorrow = f.open(at + 86400000);
  assert.equal((await tomorrow.service.purchase(request())).duplicate, true);
  assert.equal((await tomorrow.store.totals(user, 'all', at + 86400000)).total, 50);
});

test('accepted Discord clock skew across midnight cannot hide a debit from the spendable total', async () => {
  const f = await fixture(); await f.seed(user, 200);
  const beforeMidnight = at + 23 * 3600000 - 1000;
  const { service, store } = f.open(beforeMidnight);
  const first = request({ checkoutId: snowflake(beforeMidnight), at: beforeMidnight + 2000 });
  await service.purchase(first);
  await assert.rejects(service.purchase({ ...first, checkoutId: snowflake(beforeMidnight, 1) }), /تحتاج/);
  await assert.rejects(service.adjustPoints({ userId: user, actorId: actor, operationId: snowflake(beforeMidnight, 2),
    at: beforeMidnight, category: 'tasks', mode: 'remove', amount: 100 }), /الرصيد المتاح/);
  assert.equal((await store.totals(user, 'all', beforeMidnight)).total, 50);
  assert.equal((await store.totals(user, 'all', beforeMidnight + 3000)).total, 50);
  assert.equal((await store.shop.get()).products[0].stock, 2);
});

test('catalog survives initialization, can be removed by exact name and enforces capacity', async () => {
  const f = await fixture(); const original = structuredClone(f.documents.shops);
  await f.store.shop.initialize(at); assert.deepEqual(f.documents.shops, original);
  for (let i = 1; i < MAX_PRODUCTS; i++) await f.service.manageShop((shop, now) => shop.add({ id: snowflake(at, i),
    createdBy: actor, name: `منتج ${i}`, price: i, stock: 1 }, now));
  await assert.rejects(f.service.manageShop((shop, now) => shop.add({ id: snowflake(at, 101), createdBy: actor, name: 'زائد', price: 1, stock: 1 }, now)), /الحد الأقصى/);
  assert.equal((await f.service.manageShop((shop, now) => shop.remove('بطاقة هدية', now))).id, productId);
  await assert.rejects(f.service.manageShop((shop, now) => shop.remove('غير موجود', now)), /لم أجد/);
  assert.equal((await f.store.shop.get()).products.length, 99);
});
