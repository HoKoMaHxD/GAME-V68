import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { ShopNotifier, checkShopDestination, orderFooter } from '../src/shop-notifications.js';
import { fixture, request, at, actor, user, config, destination } from './helpers/shop-fixture.js';

async function notificationFixture() {
  const f = await fixture(); await f.seed(); await f.service.purchase(request());
  let time = at, live = true;
  const sent = [], errors = [], messages = new Map();
  const state = { failSend: false, permission: true, mentionable: true, canMention: false };
  const role = { id: destination.roleId, guild: { id: config.clanGuildId }, get mentionable() { return state.mentionable; } };
  const channel = { id: destination.channelId, guildId: config.clanGuildId, type: ChannelType.GuildText,
    permissionsFor: () => ({ has: perms => perms === PermissionFlagsBits.MentionEveryone ? state.canMention : state.permission }),
    guild: { roles: { fetch: async () => role } }, messages: { fetch: async () => messages },
    send: async payload => {
      if (state.failSend) throw new Error('offline');
      const message = { id: `sent-${sent.length}`, author: { id: actor }, embeds: payload.embeds.map(e => e.toJSON()) };
      sent.push(payload); messages.set(message.id, message); return message;
    } };
  const bot = { user: { id: actor }, channels: { fetch: async () => channel } };
  const open = () => new ShopNotifier({ store: f.store, bot, clock: () => time, canRun: () => live, onError: e => errors.push(e) });
  return { ...f, open, notifier: open(), sent, errors, bot, channel, role, state, messages,
    advance: ms => { time += ms; }, stop: () => { live = false; } };
}

test('purchase notification pings only the configured role and names buyer, product and order', async () => {
  const f = await notificationFixture(); await Promise.all(Array.from({ length: 5 }, () => f.notifier.tick()));
  assert.equal(f.sent.length, 1); const message = f.sent[0];
  assert.equal(message.content, `<@&${destination.roleId}>`);
  assert.deepEqual(message.allowedMentions, { parse: [], roles: [destination.roleId], users: [] });
  assert.equal(message.enforceNonce, true); assert.equal(message.nonce, request().checkoutId);
  const embed = message.embeds[0].toJSON(); assert.ok(embed.fields.some(field => field.value.includes(`<@${user}>`)));
  assert.ok(embed.fields.some(field => field.value.includes('بطاقة هدية')));
  assert.equal(embed.footer.text, orderFooter(request().checkoutId));
  assert.equal(f.documents.shop_orders[0].notification.sent, true);
  await f.open().tick(); assert.equal(f.sent.length, 1);
});

test('failed send keeps the paid order, retries after delay and never changes balance or stock', async () => {
  const f = await notificationFixture(); f.state.failSend = true; await f.notifier.tick();
  assert.equal(f.documents.shop_orders[0].notification.sent, false); assert.equal(f.sent.length, 0);
  f.state.failSend = false; await f.notifier.tick(); assert.equal(f.sent.length, 0);
  f.advance(61000); await f.open().tick(); assert.equal(f.sent.length, 1);
  assert.equal(f.documents.shop_orders[0].notification.sent, true);
  assert.equal((await f.store.totals(user, 'all', at)).total, 850); assert.equal((await f.store.shop.get()).products[0].stock, 2);
});

test('lost database acknowledgement after Discord send is recovered from recent messages', async () => {
  const f = await notificationFixture(); let failed = false;
  f.intercept(event => {
    if (!failed && event.name === 'shop_orders' && event.method === 'updateOne' && event.phase === 'before' && event.args[1].$set?.['notification.sent']) {
      failed = true; throw new Error('notification save failed');
    }
  });
  await f.notifier.tick(); assert.equal(f.sent.length, 1); assert.equal(f.documents.shop_orders[0].notification.sent, false);
  f.advance(61000); await f.open().tick();
  assert.equal(f.sent.length, 1); assert.equal(f.documents.shop_orders[0].notification.sent, true);
});

test('notification validation rejects wrong guild, wrong channel type, missing permissions and unmentionable role', async () => {
  const f = await notificationFixture();
  f.channel.guildId = user; await assert.rejects(checkShopDestination(f.bot, config.clanGuildId, destination), /سيرفر الكلان/);
  f.channel.guildId = config.clanGuildId; f.channel.type = ChannelType.GuildVoice;
  await assert.rejects(checkShopDestination(f.bot, config.clanGuildId, destination), /كتاب/);
  f.channel.type = ChannelType.GuildText; f.state.permission = false;
  await assert.rejects(checkShopDestination(f.bot, config.clanGuildId, destination), /يحتاج/);
  f.state.permission = true; f.state.mentionable = false;
  await assert.rejects(checkShopDestination(f.bot, config.clanGuildId, destination), /منشن/);
  f.state.canMention = true; assert.equal(await checkShopDestination(f.bot, config.clanGuildId, destination), f.channel);
  f.role.id = config.clanGuildId;
  await assert.rejects(checkShopDestination(f.bot, config.clanGuildId, destination), /رتبة مخصصة/);
});

test('pending notices use updated routing and loss of worker readiness prevents sending', async () => {
  const f = await notificationFixture();
  const changed = { channelId: user, roleId: actor };
  await f.service.manageShop((shop, now) => shop.configure(changed, now));
  f.role.id = actor;
  await f.notifier.tick(); assert.equal(f.sent[0].content, `<@&${actor}>`);
  assert.deepEqual(f.documents.shop_orders[0].notification.destination, changed);
  const stopped = await notificationFixture(); stopped.stop(); await stopped.notifier.tick(); assert.equal(stopped.sent.length, 0);
});
