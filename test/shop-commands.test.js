import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { buildCommands, createHandler } from '../src/commands.js';
import { shopPayload, parseShopAction } from '../src/shop-commands.js';
import { fixture, user, other, at, actor, destination, productId, snowflake, config } from './helpers/shop-fixture.js';

function interaction({ name = 'المتجر', customId, select = false, owner = user, admin = false, guildId = config.clanGuildId,
  id = snowflake(at, 5), values = [productId], options = {} } = {}) {
  const i = { commandName: customId ? undefined : name, customId, id, createdTimestamp: at,
    guildId, user: { id: owner }, values, replies: [],
    isButton: () => !!customId && !select, isStringSelectMenu: () => select, isChatInputCommand: () => !customId,
    memberPermissions: { has: () => admin },
    options: Object.fromEntries(['getString', 'getInteger', 'getChannel', 'getRole'].map(method => [method, key => options[key] ?? null])),
    reply: async payload => { i.replies.push(payload); },
    deferReply: async payload => { i.deferred = payload; }, deferUpdate: async () => { i.updated = true; },
    editReply: async payload => { i.replies.push(payload); }
  };
  return i;
}
function context(f, overrides = {}) {
  const errors = [];
  const channel = { id: destination.channelId, guildId: config.clanGuildId, type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    guild: { roles: { fetch: async id => ({ id, mentionable: true, guild: { id: config.clanGuildId } }) } } };
  const ctx = { config, store: f.store, service: f.service, isMember: id => id === user,
    bot: { user: { id: actor }, channels: { fetch: async () => channel } },
    notifyPurchase: () => {}, onError: error => errors.push(error), ...overrides };
  return { ctx, errors, channel, handler: createHandler(ctx) };
}
const controls = payload => payload.components.flatMap(row => row.toJSON().components);

test('shop commands declare bounded required fields and administrative permissions', () => {
  const commands = buildCommands();
  for (const name of ['اضافة_منتج', 'ازالة_منتج', 'اعدادات_المتجر']) assert.equal(commands.find(c => c.name === name).default_member_permissions, null);
  const add = commands.find(c => c.name === 'اضافة_منتج');
  assert.deepEqual(add.options.filter(o => o.required).map(o => o.name), ['الاسم', 'السعر', 'الكمية']);
  assert.ok(!add.options.find(o => o.name === 'الوصف').required);
  assert.equal(add.options.find(o => o.name === 'السعر').min_value, 1);
  assert.equal(add.options.find(o => o.name === 'الكمية').min_value, 0);
});

test('slash, shared button and saved private navigation all open a private shop', async () => {
  const f = await fixture(); await f.seed();
  for (const customId of [undefined, 'clan-panel:v1:shop', `clan-view:v1:${user}:shop`]) {
    const { handler } = context(f);
    const i = interaction({ customId }); await handler(i);
    if (customId?.startsWith('clan-view')) assert.equal(i.updated, true);
    else assert.equal(i.deferred.flags, MessageFlags.Ephemeral);
    assert.match(i.replies[0].embeds[0].toJSON().description, /1,000/);
    assert.ok(controls(i.replies[0]).some(b => b.label === 'شراء'));
    assert.deepEqual(i.replies[0].allowedMentions, { parse: [] });
    assert.equal(f.documents.shop_orders.length, 0);
  }
});

test('buy button opens product select; selecting debits and acknowledges exactly one order after handler restart', async () => {
  const f = await fixture(); await f.seed(); const { handler } = context(f);
  const open = interaction({ customId: `clan-shop:v1:${user}:open:0:1` }); await handler(open);
  const menu = controls(open.replies[0]).find(c => c.type === 3);
  assert.equal(menu.min_values, 1); assert.equal(menu.max_values, 1);
  assert.equal(menu.options[0].value, productId); assert.match(menu.options[0].description, /150/);
  const selected = interaction({ customId: menu.custom_id, select: true });
  await context(f).handler(selected);
  assert.match(selected.replies[0].embeds[0].toJSON().title, /تم الشراء/);
  assert.equal(controls(selected.replies[0]).some(c => c.type === 3), false);
  assert.equal((await f.store.totals(user, 'all', at)).total, 850);
  const retry = interaction({ customId: menu.custom_id, select: true, id: snowflake(at, 9) }); await context(f).handler(retry);
  assert.match(retry.replies[0].embeds[0].toJSON().title, /مسجل مسبقًا/);
  assert.equal(f.documents.shop_orders.length, 1);
});

test('unauthorized administrators, other guilds, other owners and former members cannot mutate or purchase', async () => {
  const f = await fixture(); await f.seed(); const before = structuredClone(f.documents);
  for (const options of [{ name: 'اضافة_منتج' }, { name: 'ازالة_منتج' }, { name: 'اعدادات_المتجر' },
    { guildId: other }, { customId: `clan-view:v1:${other}:shop` },
    { customId: `clan-shop:v1:${other}:select:${snowflake()}:1`, select: true },
    { customId: `clan-shop:v1:${user}:select:${snowflake()}:1`, select: true, owner: other }]) {
    const i = interaction(options); await context(f).handler(i);
    assert.equal(i.deferred, undefined); assert.equal(i.updated, undefined);
    assert.equal(i.replies[0].flags, MessageFlags.Ephemeral);
  }
  const left = interaction({ customId: `clan-shop:v1:${user}:select:${snowflake()}:1`, select: true });
  await context(f, { isMember: () => false }).handler(left);
  assert.match(left.replies[0].content, /أعضاء الكلان/);
  assert.deepEqual(f.documents, before);
});

test('administrators can add optional description, remove by name, and configure role/channel without pings', async () => {
  const f = await fixture(); const { handler, errors } = context(f);
  const add = interaction({ name: 'اضافة_منتج', admin: true, options: { الاسم: 'منتج خاص', السعر: 300, الكمية: 2, الوصف: '@everyone **وصف**' } });
  await handler(add);
  assert.equal((await f.store.shop.get()).products[1].description, '@everyone **وصف**');
  const setup = interaction({ name: 'اعدادات_المتجر', admin: true, options: { الروم: { id: destination.channelId }, الرتبة: { id: destination.roleId } } });
  await handler(setup); assert.match(setup.replies[0].content, /تنبيهات الشراء/);
  const remove = interaction({ name: 'ازالة_منتج', admin: true, options: { المنتج: 'منتج خاص' } }); await handler(remove);
  assert.equal((await f.store.shop.get()).products.length, 1); assert.equal(errors.length, 0);
  for (const i of [add, setup, remove]) assert.deepEqual(i.replies[0].allowedMentions, { parse: [] });
});

test('catalog pagination, stale-page clamping, sold-out filtering and worst-case styling fit Discord limits', () => {
  const view = { balance: { total: 1000000 }, shop: { destination, products: Array.from({ length: 100 }, (_, i) => ({
    id: snowflake(at, i), name: '*'.repeat(80), description: '*'.repeat(300), price: 1000000, stock: i === 0 ? 0 : 100000
  })) } };
  const appearance = { name: 'ن'.repeat(50), imageUrl: 'https://example.com/image.png', thumbnailUrl: 'https://example.com/thumb.png' };
  for (const mode of ['view', 'buy']) for (const page of [1, 2, 20, 99]) {
    const payload = shopPayload(view, user, appearance, { mode, page, ticket: snowflake() });
    const embed = payload.embeds[0]; const json = embed.toJSON();
    assert.ok(embed.length <= 6000, embed.length); assert.ok(json.fields.length <= 25);
    assert.equal(json.image.url, appearance.imageUrl); assert.equal(json.thumbnail.url, appearance.thumbnailUrl);
    const buttons = controls(payload);
    assert.equal(new Set(buttons.map(b => b.custom_id)).size, buttons.length);
    for (const button of buttons) { assert.ok(button.custom_id.length <= 100); assert.ok(parseShopAction(button.custom_id) || button.custom_id.startsWith('clan-view:')); }
    for (const row of payload.components) assert.ok(row.components.length <= 5);
    const select = buttons.find(b => b.type === 3);
    if (mode === 'buy') {
      assert.ok(select.options.length <= 25); assert.ok(select.options.every(o => o.label.length <= 100 && o.description.length <= 100));
      assert.ok(select.options.every(o => o.value !== snowflake(at, 0)));
    }
  }
  assert.equal(parseShopAction(`clan-shop:v1:${user}:view:0:21`), null);
  const empty = shopPayload({ balance: { total: 0 }, shop: { products: [], destination: null } }, user);
  assert.ok(controls(empty).find(c => c.label === 'شراء').disabled);
});

test('invalid select arity and expired menus never claim purchase success', async () => {
  const f = await fixture(); await f.seed();
  for (const [ticket, values] of [[snowflake(), [productId, other]], [snowflake(at - 900001), [productId]]]) {
    const i = interaction({ customId: `clan-shop:v1:${user}:select:${ticket}:1`, select: true, values });
    await context(f).handler(i); assert.match(i.replies[0].content, /❌/);
  }
  assert.equal(f.documents.shop_orders.length, 0); assert.equal((await f.store.totals(user, 'all', at)).total, 1000);
});
