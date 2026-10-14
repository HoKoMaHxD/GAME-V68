import test from 'node:test';
import assert from 'node:assert/strict';
import { managerFixture, auctionId } from './helpers/auction-fixture.js';
import { at, user, other } from './helpers/shop-fixture.js';
import { AUCTION_DURATION_MS, AUCTION_ROLE_ID } from '../src/auction.js';
import { checkAuctionChannel } from '../src/auction-manager.js';

test('scheduled announcement is replaced at due time, exact role is pinged twice and winner is announced once', async () => {
  const f = await managerFixture();
  await Promise.all([f.manager.tick(), f.manager.tick()]);
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].embeds[0].toJSON().title, /قادم/);
  assert.deepEqual(f.sent[0].allowedMentions.roles, [AUCTION_ROLE_ID]);
  const upcomingId = (await f.get()).delivery.upcoming.messageId;
  f.set(at + 60000); await f.manager.tick();
  assert.deepEqual(f.deleted, [upcomingId]); assert.equal(f.sent.length, 2);
  let a = await f.get(); const message = f.messages.get(a.delivery.live.messageId);
  assert.equal(a.endsAt - a.startedAt, AUCTION_DURATION_MS);
  assert.deepEqual(f.sent[1].allowedMentions.roles, [AUCTION_ROLE_ID]);
  assert.match(message.content, new RegExp(AUCTION_ROLE_ID));
  assert.deepEqual(message.allowedMentions.roles, []);
  await f.service.bidAuction(f.bid({ messageId: message.id }));
  await f.manager.refresh(auctionId);
  assert.ok(message.embeds[0].fields.some(field => field.value.includes(`<@${user}>`)));
  assert.ok(message.embeds[0].fields.some(field => field.value.includes('1,500')));
  f.set((await f.get()).endsAt); await f.openManager().tick();
  a = await f.get(); assert.equal(a.status, 'ended'); assert.equal(a.delivery.complete, true);
  assert.match(message.embeds[0].title, /منتهي/);
  assert.ok(message.components[0].components.every(b => b.disabled));
  assert.equal(f.sent.length, 3); assert.deepEqual(f.sent[2].allowedMentions.users, [user]);
  assert.deepEqual(f.sent[2].allowedMentions.roles, []);
  await f.openManager().tick(); assert.equal(f.sent.length, 3);
  assert.equal((await f.balance(user)).total, 8500); assert.deepEqual(f.errors, []);
});

test('overdue scheduled auction after downtime receives a full five minutes from actual announcement', async () => {
  const f = await managerFixture(); await f.manager.tick();
  f.set(at + 3600000); await f.openManager().tick();
  const a = await f.get(); assert.equal(a.status, 'active'); assert.equal(a.startedAt, f.now());
  assert.equal(a.endsAt, f.now() + AUCTION_DURATION_MS); assert.equal(f.sent.length, 2);
});

test('failed start send retries without an invisible auction clock or accepting a bid', async () => {
  const f = await managerFixture(); await f.manager.tick(); f.state.failSend = true;
  f.set(at + 60000); await f.manager.tick();
  assert.equal((await f.get()).status, 'starting'); assert.equal((await f.get()).endsAt, null);
  await assert.rejects(f.service.bidAuction(f.bid()), /الأصلية/);
  f.state.failSend = false; f.set(at + 180000); await f.openManager().tick();
  assert.equal((await f.get()).endsAt, f.now() + AUCTION_DURATION_MS);
});

test('recovery after a lost live send uses its original timestamp and does not reopen an expired auction', async () => {
  const f = await managerFixture(); await f.manager.tick();
  f.set(at + 60000); f.state.loseSendAck = true; await f.manager.tick();
  assert.equal((await f.get()).status, 'starting');
  f.set(at + 3600000); await f.openManager().tick();
  const a = await f.get(); assert.equal(a.status, 'ended'); assert.equal(a.startedAt, at + 60000);
  assert.equal(a.endsAt, at + 60000 + AUCTION_DURATION_MS); assert.equal(f.sent.length, 3);
});

for (const stage of ['upcoming', 'live', 'result']) test(`lost Discord ${stage} acknowledgement recovers the same announcement after restart`, async () => {
  const f = await managerFixture();
  if (stage !== 'upcoming') { await f.manager.tick(); f.set(at + 60000); }
  if (stage === 'result') { await f.manager.tick(); f.set((await f.get()).endsAt); }
  f.state.loseSendAck = true; await f.manager.tick();
  const count = f.sent.length;
  await f.openManager().tick();
  assert.equal(f.sent.length, count);
  if (stage === 'result') assert.equal((await f.get()).delivery.complete, true);
  else assert.ok((await f.get()).delivery[stage].messageId);
});

test('lost database message-ID write recovers by footer without posting twice', async () => {
  const f = await managerFixture(); let failed = false;
  f.intercept(e => {
    if (!failed && e.name === 'auctions' && e.method === 'updateOne' && e.phase === 'before'
      && e.args[1].$set?.['delivery.upcoming.messageId']) { failed = true; throw new Error('lost database write'); }
  });
  await f.manager.tick(); assert.equal(f.sent.length, 1);
  await f.openManager().tick(); assert.equal(f.sent.length, 1);
  assert.ok((await f.get()).delivery.upcoming.messageId);
});

test('due startup deletes an upcoming message even when its send acknowledgement was lost', async () => {
  const f = await managerFixture(); f.state.loseSendAck = true; await f.manager.tick();
  const original = [...f.messages.keys()][0];
  assert.equal((await f.get()).delivery.upcoming.messageId, undefined);
  f.set(at + 60000); await f.openManager().tick();
  assert.deepEqual(f.deleted, [original]); assert.equal(f.sent.length, 2);
  assert.equal((await f.get()).status, 'active');
});

test('ending commits despite Discord errors and retries publishing without recharging', async () => {
  const f = await managerFixture(); f.set(at + 60000); await f.manager.tick();
  const messageId = (await f.get()).delivery.live.messageId;
  await f.service.bidAuction(f.bid({ messageId }));
  f.set((await f.get()).endsAt); f.state.permission = false;
  await f.manager.tick(); assert.equal((await f.get()).status, 'ended'); assert.equal((await f.get()).delivery.complete, false);
  assert.equal((await f.balance(user)).total, 8500);
  f.state.permission = true; await f.openManager().tick();
  assert.equal((await f.get()).delivery.complete, true); assert.equal((await f.balance(user)).total, 8500);
});

test('role permissions, shutdown and scheduled cancellation behave before any bid is accepted', async () => {
  const f = await managerFixture(); f.state.mentionable = false;
  await assert.rejects(checkAuctionChannel(f.bot, f.store.config.clanGuildId, f.channel.id, AUCTION_ROLE_ID), /منشن/);
  f.state.canMention = true;
  await checkAuctionChannel(f.bot, f.store.config.clanGuildId, f.channel.id, AUCTION_ROLE_ID);
  f.state.live = false; await f.manager.tick(); assert.equal(f.sent.length, 0);
  f.state.live = true; await f.manager.tick();
  const message = f.messages.get((await f.get()).delivery.upcoming.messageId);
  await f.service.settleAuction(auctionId, { actorId: other, operationId: other, reason: 'تأجيل' });
  await f.manager.refresh(auctionId);
  assert.match(message.embeds[0].title, /ملغى/); assert.equal((await f.get()).delivery.complete, true);
  assert.equal((await f.balance(user)).total, 10000);
});
