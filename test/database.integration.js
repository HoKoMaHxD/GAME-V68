import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoStore } from '../src/store.js';
import { QuestService } from '../src/service.js';
import { createDay, applyMessage } from '../src/domain.js';
import { CHAT_TASK_IDS } from '../src/split-chat-tasks.js';
import { dayStart } from '../src/time.js';

test('real local MongoDB: atomic credits, duplicate events, leases, restart and rankings', async t => {
  // Deliberately no MONGODB_URI read: tests cannot touch the user's real database.
  const mongod = await MongoMemoryServer.create();
  const now = dayStart('2026-09-06') + 3600000;
  const config = {
    mongoUri: mongod.getUri(), dbName: `clan_quests_test_${randomUUID().replaceAll('-', '')}`,
    clanGuildId: '100000000000000001', arenaGuildId: '100000000000000002',
    generalChannelId: '100000000000000003', voiceChannelId: '100000000000000004',
    clanChatChannelId: '100000000000000009',
    feelingChannelId: '100000000000000006', lookChannelId: '100000000000000007', memberRole: '100000000000000008',
    cooldownMs: 10000, minMessageLength: 3, weekStart: 0,
    attendance: { enabled: true, channelId: '100000000000000004', intervalMs: 60000, points: 10, dailyCap: 500, version: 1 }
  };
  const store = new MongoStore(config);
  const competitor = new MongoStore(config);
  try {
    await store.connect();
    await competitor.client.connect();
    await t.test('singleton lease excludes concurrent workers and releases cleanly', async () => {
      assert.equal(await store.acquireLease(now), true);
      assert.equal(await competitor.acquireLease(now), false);
      assert.equal(await store.acquireLease(now + 1000), true);
      await store.releaseLease();
      assert.equal(await competitor.acquireLease(now + 2000), true);
      await competitor.releaseLease();
    });
    await t.test('bootstrap never overwrites database settings or duplicates seeds', async () => {
      await store.acquireLease(now);
      await store.initializeTasks(now);
      assert.equal((await store.templates()).length, 4);
      await store.setAttendance({ points: 77 });
      await store.connect();
      await store.initializeTasks(now);
      assert.equal((await store.settings()).attendance.points, 77);
      assert.equal((await store.templates()).length, 4);
    });
    const user = '100000000000000005';
    const initial = createDay(config.clanGuildId, user, '2026-09-06', [{
      id: 'test', title: 'test', type: 'messages', channelId: config.generalChannelId,
      target: 1, repeat: 1, reward: 100, enabled: true
    }], now);
    await t.test('concurrent first-use creates one daily snapshot', async () => {
      await Promise.all(Array.from({ length: 10 }, () => store.ensureDay(structuredClone(initial))));
      assert.equal(await store.db.collection('days').countDocuments({ _id: initial._id }), 1);
    });
    await t.test('concurrent duplicate completions credit a reward exactly once', async () => {
      const event = { id: '200000000000000001', channelId: config.generalChannelId, at: now, content: 'اختبار المهمة' };
      await Promise.all(Array.from({ length: 20 }, () => store.mutateDay(initial._id, draft => applyMessage(draft, event, config))));
      const saved = await store.getDay(initial._id);
      assert.equal(saved.points.tasks, 100);
      assert.equal(saved.completionLog.length, 1);
      assert.equal(saved.tasks[0].completed, 1);
    });
    await t.test('concurrent independent document changes survive revision retries', async () => {
      await Promise.all(Array.from({ length: 10 }, () => store.mutateDay(initial._id, draft => {
        draft.points.attendance++; return true;
      })));
      const saved = await store.getDay(initial._id);
      assert.equal(saved.points.attendance, 10);
      assert.equal(saved.points.tasks, 100);
    });
    await t.test('reopening storage preserves progress and points', async () => {
      const reopened = new QuestService(competitor, config, () => now);
      assert.equal((await reopened.day(user)).points.tasks, 100);
    });
    await t.test('leaderboards separate calendar periods and point categories', async () => {
      const previous = createDay(config.clanGuildId, user, '2026-09-05', [], now - 86400000);
      previous.points = { tasks: 50, attendance: 5 };
      await store.ensureDay(previous);
      const lastMonth = createDay(config.clanGuildId, user, '2026-08-31', [], now - 6 * 86400000);
      lastMonth.points = { tasks: 500, attendance: 0 };
      await store.ensureDay(lastMonth);
      const another = createDay(config.clanGuildId, '100000000000000099', '2026-09-06', [], now);
      another.points = { tasks: 1, attendance: 30 };
      await store.ensureDay(another);
      assert.equal((await store.totals(user, 'daily', now)).total, 110);
      assert.equal((await store.totals(user, 'weekly', now)).total, 110);
      assert.equal((await store.totals(user, 'monthly', now)).total, 165);
      assert.equal((await store.totals(user, 'all', now)).total, 665);
      assert.equal((await store.ranking('daily', 'tasks', now))[0]._id, user);
      assert.equal((await store.ranking('daily', 'attendance', now))[0]._id, another.userId);
      assert.equal((await store.ranking('daily', 'total', now, { skip: 1 }))[0]._id, another.userId);
    });
    await t.test('rapid out-of-order messages persist as independent 50-message quests without duplicate credits', async () => {
      const chatUser = '100000000000000077';
      assert.equal(await store.initializeChatTasks(now + 300), true);
      const service = new QuestService(store, config, () => now + 400);
      service.templateCache = await store.templates();
      const messages = Array.from({ length: 100 }, (_, i) => ({
        id: String(400000000000000100n - BigInt(i)), at: now + 400, userId: chatUser,
        guildId: config.arenaGuildId, channelId: i % 2 ? config.generalChannelId : config.clanChatChannelId,
        eligible: true, content: '.'
      }));
      await Promise.all(messages.slice(0, 99).map(event => service.message(event)));
      await service.message(messages[0]);
      const partial = await service.day(chatUser);
      assert.deepEqual(CHAT_TASK_IDS.map(id => partial.tasks.find(t => t.id === id).progress), [49, 50]);
      assert.equal(partial.points.tasks, 50);
      await service.message(messages[99]);
      const saved = await service.day(chatUser);
      assert.deepEqual(CHAT_TASK_IDS.map(id => saved.tasks.find(t => t.id === id).progress), [50, 50]);
      assert.equal(saved.points.tasks, 100);
      assert.equal(saved.completionLog.length, 2);
      assert.equal(saved.messageReceipts.length, 100);
      const reopened = new QuestService(store, config, () => now + 400);
      await reopened.message(messages[50]);
      assert.equal((await reopened.day(chatUser)).points.tasks, 100);
      await service.reset({ userId: chatUser, actorId: user, operationId: 'integration-chat-reset' });
    });
    await t.test('manual credits/debits use atomic audit entries and aggregate correctly with missing legacy adjustment fields', async () => {
      const manualUser = '100000000000000088';
      const service = new QuestService(store, config, () => now + 500);
      const request = { userId: manualUser, actorId: user, operationId: '300000000000000001',
        at: now + 500, mode: 'add', category: 'tasks', amount: 100, reason: 'اختبار النقاط' };
      await Promise.all(Array.from({ length: 3 }, () => service.adjustPoints(request)));
      assert.equal((await service.day(manualUser)).adjustmentLog.length, 1);
      await assert.rejects(service.adjustPoints({ ...request, operationId: '300000000000000002', mode: 'remove', amount: 101 }), /الرصيد المتاح/);
      await service.adjustPoints({ ...request, operationId: '300000000000000003', category: 'attendance', amount: 60 });
      await service.adjustPoints({ ...request, operationId: '300000000000000004', mode: 'remove', amount: 50 });
      for (const period of ['daily', 'weekly', 'monthly', 'all']) {
        const totals = await store.totals(manualUser, period, now + 500);
        assert.equal(totals.tasks, 50); assert.equal(totals.attendance, 60); assert.equal(totals.total, 110);
      }
      const state = await service.day(manualUser);
      assert.deepEqual(state.points, { tasks: 0, attendance: 0 });
      assert.ok(state.tasks.every(task => task.progress === 0 && task.completed === 0));
      assert.equal(state.attendance.milliseconds, 0);
      assert.equal((await store.resetPreview(manualUser)).attendance, 60);
      await service.reset({ userId: manualUser, actorId: user, operationId: 'integration-adjustment-reset' });
      assert.equal((await store.totals(manualUser, 'all', now + 500)).total, 0);
    });
    await t.test('delegated administration settings persist without replacing other fields or replaying an older command', async () => {
      const before = await store.settings();
      const input = { roleId: '100000000000000067', actorId: user, operationId: '300000000000000050' };
      const saved = await store.setBotPermissions(input, now + 700);
      assert.equal(saved.botPermissions.roleId, input.roleId);
      assert.deepEqual(saved.attendance, before.attendance);
      assert.deepEqual((await competitor.settings()).botPermissions, saved.botPermissions);
      await store.setBotPermissions({ ...input, roleId: null, operationId: '300000000000000051' }, now + 701);
      await assert.rejects(store.setBotPermissions(input, now + 702), /أقدم/);
      assert.equal((await store.settings()).botPermissions.roleId, null);
    });
    await t.test('shop reservation, debit, receipt and reset work on standalone MongoDB without transactions', async () => {
      const shopUser = '100000000000000066';
      const stamp = now + 750;
      const service = new QuestService(store, config, () => stamp);
      await store.shop.initialize(stamp);
      await service.manageShop((shop, clock) => shop.configure({ channelId: config.generalChannelId, roleId: config.memberRole }, clock));
      const id = String(BigInt(stamp - 1420070400000) << 22n);
      await service.manageShop((shop, clock) => shop.add({ id, name: 'منتج اختبار', price: 150, stock: 1, createdBy: user }, clock));
      const day = createDay(config.clanGuildId, shopUser, '2026-09-06', [], stamp);
      day.points = { tasks: 200, attendance: 50 };
      await store.ensureDay(day);
      const purchase = { checkoutId: String(BigInt(id) + 1n), userId: shopUser, productId: id, at: stamp };
      const results = await Promise.all(Array.from({ length: 5 }, () => service.purchase(purchase)));
      assert.equal(results.filter(order => !order.duplicate).length, 1);
      assert.equal((await store.totals(shopUser, 'all', stamp)).total, 100);
      assert.deepEqual((await store.getDay(day._id)).points, { tasks: 200, attendance: 50 });
      assert.equal((await store.getDay(day._id)).shopReceipts.length, 1);
      assert.equal((await store.shop.get()).products[0].stock, 0);
      assert.equal((await store.shop.get()).pending, null);
      assert.equal((await competitor.shop.order(purchase.checkoutId)).product.name, 'منتج اختبار');
      assert.equal((await store.shop.notifications(stamp)).length, 1);
      await service.reset({ userId: shopUser, actorId: user, operationId: 'integration-shop-reset' });
      assert.equal((await store.totals(shopUser, 'all', stamp)).total, 0);
      assert.equal((await store.shop.order(purchase.checkoutId)).balanceAfter, 100);
      assert.equal((await store.shop.get()).products[0].stock, 0);
    });
    await t.test('member and clan resets preserve configuration, isolate other clans and survive reopening', async () => {
      const templates = await store.templates();
      const settings = await store.settings();
      const foreign = createDay('other-clan', user, '2026-09-06', [], now);
      foreign.points.tasks = 999;
      await store.ensureDay(foreign);
      assert.equal((await store.resetPreview(user)).tasks, 650);
      const result = await store.resetProgress({ userId: user, actorId: user, operationId: 'integration-member' }, now + 1000);
      assert.equal(result.deletedDays, 3);
      for (const period of ['daily', 'weekly', 'monthly', 'all']) assert.equal((await store.totals(user, period, now)).total, 0);
      assert.equal((await store.totals('100000000000000099', 'all', now)).total, 31);
      assert.deepEqual(await store.getDay(foreign._id), foreign);
      assert.deepEqual(await store.settings(), settings);
      assert.deepEqual(await store.templates(), templates);
      await store.releaseLease();
      assert.equal(await competitor.acquireLease(now + 2000), true);
      assert.equal(await competitor.initializeResets(now + 2000), 0);
      const service = new QuestService(competitor, config, () => now + 2000);
      const event = { userId: user, guildId: config.arenaGuildId, eligible: true, channelId: config.feelingChannelId,
        content: `<@&${config.memberRole}>`, mentionedRoleIds: [config.memberRole], id: '200000000000000010', at: now };
      assert.equal(await service.message(event), null);
      assert.equal((await service.message({ ...event, at: now + 2000 })).points.tasks, 150);
      await service.reset({ userId: null, actorId: user, operationId: 'integration-everyone' });
      assert.deepEqual(await competitor.ranking('all', 'total', now), []);
      assert.deepEqual(await competitor.getDay(foreign._id), foreign);
      assert.deepEqual(await competitor.settings(), settings);
    });
  } finally {
    await store.close(); await competitor.close(); await mongod.stop();
  }
});
