import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { buildCommands, createHandler } from '../src/commands.js';
import { auctionPayload, auctionKey } from '../src/auction-views.js';
import { parseAuctionAction } from '../src/auction-commands.js';
import { auctionFixture, managerFixture, auctionId, liveId } from './helpers/auction-fixture.js';
import { at, user, other, actor, config, destination, snowflake } from './helpers/shop-fixture.js';

function interaction(f, { name, action, modal = false, admin = false, owner = user, channelId = destination.channelId,
  messageId = liveId, customId, options = {}, value = '750', guildId = config.clanGuildId, id = snowflake(f.now(), 900) } = {}) {
  const i = { commandName: name, customId: customId || (action ? auctionKey(auctionId, action) : undefined),
    id, createdTimestamp: f.now(), user: { id: owner }, guildId, channelId, message: { id: messageId }, replies: [],
    isChatInputCommand: () => !!name, isButton: () => !name && !modal, isModalSubmit: () => modal,
    memberPermissions: { has: () => admin }, fields: { getTextInputValue: () => value },
    options: Object.fromEntries(['getString', 'getInteger', 'getAttachment'].map(method => [method, key => options[key] ?? null])),
    deferReply: async p => { i.deferred = p; },
    reply: async p => { i.replied = true; i.replies.push(p); },
    editReply: async p => { i.replies.push(p); },
    showModal: async p => { i.modal = p.toJSON(); i.replied = true; } };
  return i;
}
function handler(f, overrides = {}) {
  const errors = [];
  return { errors, handle: createHandler({ config, store: f.store, service: f.service,
    isMember: id => [user, other].includes(id), bot: f.bot, onError: e => errors.push(e), ...overrides }) };
}

test('slash fields and realistic embeds fit Discord limits and only intended mentions are enabled', async () => {
  const commands = buildCommands(); const command = commands.find(c => c.name === 'مزاد');
  assert.deepEqual(command.options.map(o => o.name), ['الاسم', 'الوصف', 'الصورة', 'العدد', 'التاريخ', 'الوقت', 'مبلغ_البداية']);
  assert.ok(command.options.every(o => o.required)); assert.equal(command.options[2].type, 11);
  const f = await auctionFixture(); const a = await f.get();
  a.name = '*'.repeat(80); a.description = '*'.repeat(1000);
  for (const stage of ['upcoming', 'live']) {
    const payload = auctionPayload(a, stage, { name: 'ن'.repeat(50) }, { ping: true });
    const embed = payload.embeds[0]; const json = embed.toJSON();
    assert.ok(embed.length <= 6000); assert.ok(json.description.length <= 4096);
    for (const field of json.fields) assert.ok(field.value.length <= 1024);
    assert.equal(json.image.url, a.imageUrl);
    assert.deepEqual(payload.allowedMentions.users, []); assert.deepEqual(payload.allowedMentions.parse, []);
    for (const row of payload.components) {
      assert.ok(row.components.length <= 5);
      for (const button of row.components) assert.ok(parseAuctionAction(button.data.custom_id));
    }
  }
});

test('creation requires administration and uses the selected image, Saudi schedule and current channel', async () => {
  const f = await managerFixture(); const { handle, errors } = handler(f, { auctions: f.manager });
  const i = interaction(f, { name: 'مزاد', admin: true, owner: actor, options: {
    الاسم: 'منتج جديد', الوصف: 'تفاصيل', الصورة: { name: 'item.png', contentType: 'image/png', url: 'https://example.com/item.png' },
    العدد: 5, التاريخ: '2026-09-11', الوقت: '22:00', مبلغ_البداية: 500
  } });
  await handle(i); assert.equal(errors.length, 0); assert.equal(i.deferred.flags, MessageFlags.Ephemeral);
  const a = await f.store.auctions.get(i.id);
  assert.equal(a.quantity, 5); assert.equal(a.channelId, destination.channelId);
  assert.equal(a.startsAt, Date.parse('2026-09-11T19:00:00Z'));
  assert.equal(a.imageUrl, 'https://example.com/item.png'); assert.equal(f.sent.length, 1);
  const denied = interaction(f, { name: 'مزاد' }); await handle(denied);
  assert.match(denied.replies[0].content, /إدارة/); assert.equal(denied.deferred, undefined);
});

test('buttons and custom modal are routed through the main handler, respond privately and debit the submitted increment', async () => {
  const f = await auctionFixture(); const { handle, errors } = handler(f);
  const opening = interaction(f, { action: 'opening', id: snowflake(f.now(), 901) }); await handle(opening);
  assert.equal(opening.deferred.flags, MessageFlags.Ephemeral); assert.match(opening.replies[0].content, /1,000/);
  const custom = interaction(f, { action: 'custom' }); await handle(custom);
  assert.equal(custom.deferred, undefined); assert.ok(custom.modal.custom_id.length <= 100);
  assert.equal(custom.modal.components[0].components[0].custom_id, 'increment');
  const submitted = interaction(f, { modal: true, customId: custom.modal.custom_id, value: '٧٥٠' }); await handle(submitted);
  assert.equal(errors.length, 0); assert.equal((await f.get()).amount, 1750);
  assert.equal((await f.balance(user)).total, 8250); assert.match(submitted.replies[0].content, /750/);
  assert.equal(submitted.deferred.flags, MessageFlags.Ephemeral);
});

test('a changed sum while typing is rejected, and another user cannot submit the same modal', async () => {
  const f = await auctionFixture(); const { handle } = handler(f);
  const custom = interaction(f, { action: 'custom' }); await handle(custom);
  await f.service.bidAuction(f.bid({ userId: other }));
  const stale = interaction(f, { modal: true, customId: custom.modal.custom_id }); await handle(stale);
  assert.match(stale.replies[0].content, /تغير السوم/); assert.equal((await f.balance(user)).total, 10000);
  const wrongUser = interaction(f, { owner: other, modal: true, customId: custom.modal.custom_id }); await handle(wrongUser);
  assert.match(wrongUser.replies[0].content, /غير صالح/);
});

test('forged message, wrong guild, former members and invalid amounts cannot bid', async () => {
  const f = await auctionFixture();
  for (const options of [{ action: '500', messageId: other }, { action: '500', guildId: other },
    { action: '500', owner: actor }, { action: '500', channelId: other },
    { modal: true, customId: `${auctionKey(auctionId, 'submit')}:${user}:1000`, value: '-50' }]) {
    const i = interaction(f, options); await handler(f).handle(i); assert.ok(i.replies[0].content);
  }
  assert.equal((await f.get()).bidCount, 0); assert.equal((await f.balance(user)).total, 10000);
});

test('admin cancellation refunds while UI publication errors never claim a saved bid was rejected', async () => {
  const f = await auctionFixture(); const auctions = { refresh: async () => { throw new Error('Discord offline'); } };
  const { handle } = handler(f, { auctions });
  const bid = interaction(f, { action: '500' }); await handle(bid);
  assert.match(bid.replies.at(-1).content, /العملية محفوظة/); assert.equal((await f.balance(user)).total, 8500);
  const denied = interaction(f, { name: 'الغاء_مزاد', options: { المعرف: auctionId } }); await handle(denied);
  assert.equal((await f.get()).status, 'active');
  const cancel = interaction(f, { name: 'الغاء_مزاد', admin: true, owner: actor,
    id: snowflake(f.now(), 902), options: { المعرف: auctionId, السبب: 'اختبار' } });
  await handle(cancel); assert.equal((await f.get()).status, 'cancelled'); assert.equal((await f.balance(user)).total, 10000);
});
