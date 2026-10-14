import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoStore } from '../src/store.js';
import { QuestService } from '../src/service.js';
import { createDay } from '../src/domain.js';
import { dayKey } from '../src/time.js';
import { AUCTION_DURATION_MS } from '../src/auction.js';
import { auctionInput, auctionId, liveId } from './helpers/auction-fixture.js';
import { config as baseConfig, at, user, other, actor, destination, snowflake } from './helpers/shop-fixture.js';

test('real standalone MongoDB: auction holds, partial transfer recovery, settlement and audit', async () => {
  // This test uses a disposable local database; it never reads MONGODB_URI.
  const mongo = await MongoMemoryServer.create();
  const config = { ...baseConfig, mongoUri: mongo.getUri(), dbName: `auction_test_${randomUUID().replaceAll('-', '')}`, attendance: {} };
  const store = new MongoStore(config), reopened = new MongoStore(config);
  let now = at;
  try {
    await store.connect(); await store.acquireLease(now); await store.auctions.initialize(now);
    const service = new QuestService(store, config, () => now);
    for (const id of [user, other]) {
      const day = createDay(config.clanGuildId, id, dayKey(now), [], now);
      day.points.tasks = 3000; await store.ensureDay(day);
    }
    await service.createAuction(auctionInput()); now += 60000; await store.acquireLease(now);
    await service.auctionChange(auctionId, a => {
      a.status = 'active'; a.startedAt = now; a.endsAt = now + AUCTION_DURATION_MS;
      a.delivery.live.messageId = liveId; return true;
    });
    const bid = { auctionId, userId: user, operationId: snowflake(now, 501), at: now,
      channelId: destination.channelId, messageId: liveId, increment: 500 };
    await Promise.all([service.bidAuction(bid), service.bidAuction(bid)]);
    assert.equal((await store.totals(user, 'all', now)).total, 1500);
    const mutate = store.mutateDay.bind(store); let lost = false;
    store.mutateDay = async (...args) => {
      const result = await mutate(...args);
      if (!lost) { lost = true; throw new Error('Simulated process loss after atomic debit'); }
      return result;
    };
    await assert.rejects(service.bidAuction({ ...bid, userId: other, increment: 1000, operationId: snowflake(now, 502) }), /أعد تشغيل/);
    assert.equal(service.blocked, true);
    await store.releaseLease();
    await reopened.connect(); assert.equal(await reopened.acquireLease(now), true);
    await reopened.auctions.initialize(now); await reopened.auctions.recover(now); await reopened.auctions.recover(now);
    assert.equal((await reopened.totals(user, 'all', now)).total, 3000);
    assert.equal((await reopened.totals(other, 'all', now)).total, 500);
    const resumed = new QuestService(reopened, config, () => now);
    await assert.rejects(resumed.reset({ userId: other, actorId: actor, operationId: 'held-reset' }), /حجز مزاد/);
    now = (await reopened.auctions.get(auctionId)).endsAt; await reopened.acquireLease(now);
    await Promise.all([resumed.settleAuction(auctionId), resumed.settleAuction(auctionId)]);
    const ended = await reopened.auctions.get(auctionId);
    assert.equal(ended.settlement.winnerId, other); assert.equal(ended.settlement.amount, 2500);
    assert.equal((await reopened.totals(other, 'all', now)).total, 500);
    assert.equal(await reopened.db.collection('auction_events').countDocuments({ auctionId }), 3);
    assert.equal((await reopened.auctions.pending()).pending, null);
  } finally {
    await store.close(); await reopened.close(); await mongo.stop();
  }
});
