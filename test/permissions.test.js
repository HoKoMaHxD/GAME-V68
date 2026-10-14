import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField, PermissionFlagsBits, MessageFlags, ChannelType } from 'discord.js';
import { canManageBot, canConfigurePermissions, BotPermissions } from '../src/permissions.js';
import { buildCommands, createHandler } from '../src/commands.js';
import { createSetupMessageHandler } from '../src/panel.js';
import { fixture as shopFixture, user, other, actor, at, snowflake, config as base, destination } from './helpers/shop-fixture.js';

const roleId = '100000000000000081';
const secondRole = '100000000000000082';
const config = { ...base, generalChannelId: destination.channelId, voiceChannelId: other,
  feelingChannelId: destination.channelId, lookChannelId: destination.channelId };
const privileges = bits => new PermissionsBitField(bits);
function interaction({ name = 'صلاحية', id = snowflake(at, 10), guildId = config.clanGuildId, owner = actor,
  ownerId = other, bits = 0n, roles = [], cached = false, customId, options = {}, sub = 'قائمة' } = {}) {
  const memberRoles = cached ? { cache: new Map(roles.map(id => [id, { id }])) } : roles;
  const guild = { id: guildId, ownerId, roles: { fetch: async id => ({ id, guild: { id: guildId } }) } };
  const i = { id, createdTimestamp: at, guildId, guild, user: { id: owner }, commandName: customId ? undefined : name, customId,
    memberPermissions: privileges(bits), member: { roles: memberRoles, guild, permissions: privileges(bits) },
    isChatInputCommand: () => !customId, isButton: () => !!customId, replies: [],
    options: { ...Object.fromEntries(['getRole', 'getUser', 'getChannel', 'getInteger', 'getString', 'getBoolean', 'getAttachment'].map(method => [method, key => options[key] ?? null])), getSubcommand: () => sub },
    reply: async payload => { i.replies.push(payload); },
    deferReply: async payload => { i.deferred = payload; }, deferUpdate: async () => { i.updated = true; },
    editReply: async payload => { i.replies.push(payload); } };
  return i;
}
async function fixture() {
  const f = await shopFixture(); await f.seed();
  f.documents.settings[0].attendance = { enabled: true, channelId: other, intervalMs: 600000, points: 10, dailyCap: 500, minPeople: 1 };
  const access = new BotPermissions({ config, store: f.store, clock: () => at });
  await access.change({ roleId, actorId: actor, operationId: snowflake() });
  const calls = [], errors = [];
  const record = (object, name) => { const method = object[name].bind(object); object[name] = async (...args) => { calls.push(name); return method(...args); }; };
  for (const method of ['adjustPoints', 'resetPreview', 'reset', 'manageShop']) record(f.service, method);
  record(f.store, 'addTemplate');
  f.store.addSpecialTask = async task => { calls.push('addSpecialTask'); return { task }; };
  f.store.setAppearance = async fields => { calls.push('setAppearance'); return { appearance: fields }; };
  f.store.setAttendance = async fields => { calls.push('setAttendance'); return { attendance: fields }; };
  f.store.db.command = async () => { calls.push('ping'); };
  const channel = { type: ChannelType.GuildText, guildId: config.clanGuildId, permissionsFor: () => ({ has: () => true }),
    guild: { roles: { fetch: async id => ({ id, mentionable: true, guild: { id: config.clanGuildId } }) } } };
  const panel = { setup: async () => { calls.push('setup'); return {}; }, refreshAppearance: async () => true };
  const ctx = { config, store: f.store, service: f.service, access, clock: () => at, isMember: id => id === user,
    panel, bot: { user: { id: actor }, channels: { fetch: async () => channel } },
    validateChannel: async () => {}, refreshSettings: async () => {}, status: () => ({ bot: true, observer: true, tracking: true, memberCount: 1 }),
    onError: e => errors.push(e) };
  return { ...f, access, ctx, handler: createHandler(ctx), calls, errors };
}

test('native privileges and clan role authorize management; permission delegation stays owner/Administrator only', () => {
  assert.equal(canManageBot(interaction(), config, roleId), false);
  assert.equal(canConfigurePermissions(interaction(), config), false);
  for (const extra of [{ ownerId: actor }, { bits: PermissionFlagsBits.Administrator }, { bits: PermissionFlagsBits.ManageGuild },
    { roles: [roleId] }, { roles: [roleId], cached: true }]) assert.equal(canManageBot(interaction(extra), config, roleId), true);
  for (const extra of [{ roles: [roleId] }, { bits: PermissionFlagsBits.ManageGuild }]) assert.equal(canConfigurePermissions(interaction(extra), config), false);
  for (const extra of [{ ownerId: actor }, { bits: PermissionFlagsBits.Administrator }]) assert.equal(canConfigurePermissions(interaction(extra), config), true);
  assert.equal(canManageBot(interaction({ guildId: other, roles: [roleId], bits: PermissionFlagsBits.Administrator }), config, roleId), false);
  assert.equal(canManageBot(interaction({ roles: [config.clanGuildId] }), config, config.clanGuildId), false);
  const sourceMember = interaction({ roles: [roleId] }); sourceMember.member.guild = { id: config.arenaGuildId };
  assert.equal(canManageBot(sourceMember, config, roleId), false);
});

test('registered administrative commands are invokable by a delegated role; /صلاحية retains Administrator default', () => {
  const commands = buildCommands(); assert.equal(commands.length, 50);
  const names = ['البنك', 'خصم', 'setup', 'ادارة_المهام', 'اعدادات_الحضور', 'حالة_البوت', 'تصميم_الامبد', 'اضافة_نقاط', 'ازالة_نقاط',
    'ريست_الجميع', 'ريست_عضو', 'اضافة_منتج', 'ازالة_منتج', 'اعدادات_المتجر'];
  for (const name of names) assert.equal(commands.find(c => c.name === name).default_member_permissions, null, name);
  const permission = commands.find(c => c.name === 'صلاحية');
  assert.equal(permission.default_member_permissions, String(PermissionFlagsBits.Administrator));
  assert.equal(permission.dm_permission, false); assert.deepEqual(permission.options.map(o => o.name), ['الرتبة', 'ازالة']);
});

test('role setting is durable, changes immediately, is clan scoped and survives member/clan reset', async () => {
  const f = await fixture(); const before = structuredClone(f.documents.settings[0]);
  const reopened = new BotPermissions({ store: f.store, config }); reopened.load(await f.store.settings());
  assert.equal(reopened.roleId, roleId);
  await f.access.change({ roleId: secondRole, actorId: actor, operationId: snowflake(at, 1) });
  assert.equal(canManageBot(interaction({ roles: [roleId] }), config, f.access.roleId), false);
  assert.equal(canManageBot(interaction({ roles: [secondRole] }), config, f.access.roleId), true);
  const settings = await f.store.settings();
  for (const key of ['appearance', 'attendance']) assert.deepEqual(settings[key], before[key]);
  assert.equal(settings._id, `settings:${config.clanGuildId}`);
  await f.service.reset({ userId: user, actorId: actor, operationId: 'role-member-reset' });
  await f.service.reset({ userId: null, actorId: actor, operationId: 'role-all-reset' });
  assert.deepEqual((await f.store.settings()).botPermissions, settings.botPermissions);
  await f.access.change({ roleId: null, actorId: actor, operationId: snowflake(at, 2) });
  assert.equal(f.access.roleId, null);
  reopened.load(await f.store.settings()); assert.equal(reopened.roleId, null);
  assert.equal(canManageBot(interaction({ roles: [secondRole] }), config, reopened.roleId), false);
  assert.equal(canManageBot(interaction({ bits: PermissionFlagsBits.ManageGuild }), config, reopened.roleId), true);
});

test('permission command supports setting, viewing and removing, with private replies and no role ping', async () => {
  const f = await fixture();
  const add = interaction({ bits: PermissionFlagsBits.Administrator, options: { الرتبة: { id: secondRole } } }); await f.handler(add);
  assert.equal(f.access.roleId, secondRole); assert.match(add.replies[0].embeds[0].toJSON().title, /تم حفظ/);
  const view = interaction({ ownerId: actor }); await f.handler(view);
  assert.ok(view.replies[0].embeds[0].toJSON().fields.some(field => field.value.includes(secondRole)));
  const remove = interaction({ id: snowflake(at, 11), ownerId: actor, options: { ازالة: true } }); await f.handler(remove);
  assert.equal(f.access.roleId, null); assert.match(remove.replies[0].embeds[0].toJSON().title, /إزالة/);
  for (const i of [add, view, remove]) { assert.equal(i.deferred.flags, MessageFlags.Ephemeral); assert.deepEqual(i.replies[0].allowedMentions, { parse: [] }); }
  assert.deepEqual(f.errors, []);
});

test('permission command rejects delegated roles, Manage Guild alone, DMs, foreign guilds and invalid role selections', async () => {
  const f = await fixture(); const before = structuredClone(f.documents);
  for (const extra of [{ roles: [roleId] }, { bits: PermissionFlagsBits.ManageGuild }, { guildId: null, bits: PermissionFlagsBits.Administrator },
    { guildId: other, bits: PermissionFlagsBits.Administrator }]) {
    const i = interaction({ options: { الرتبة: { id: secondRole } }, ...extra }); await f.handler(i);
    assert.equal(i.deferred, undefined); assert.equal(i.replies[0].flags, MessageFlags.Ephemeral);
  }
  for (const options of [{ الرتبة: { id: config.clanGuildId } }, { الرتبة: { id: roleId }, ازالة: true }]) {
    const i = interaction({ bits: PermissionFlagsBits.Administrator, options }); await f.handler(i); assert.match(i.replies[0].content, /❌/);
  }
  const invalid = interaction({ bits: PermissionFlagsBits.Administrator, options: { الرتبة: { id: secondRole } } });
  invalid.guild.roles.fetch = async () => null; await f.handler(invalid); assert.match(invalid.replies[0].content, /رتبة موجودة/);
  assert.deepEqual(f.documents, before); assert.equal(f.access.roleId, roleId);
});

test('serialized updates and late duplicate interactions cannot restore a superseded role', async () => {
  const f = await fixture();
  await Promise.all([
    f.access.change({ roleId: secondRole, actorId: actor, operationId: snowflake(at, 1) }),
    f.access.change({ roleId: null, actorId: actor, operationId: snowflake(at, 2) })
  ]);
  await assert.rejects(f.access.change({ roleId: secondRole, actorId: actor, operationId: snowflake(at, 1) }));
  assert.equal(f.access.roleId, null); assert.equal((await f.store.settings()).botPermissions.roleId, null);
  await f.access.change({ roleId: secondRole, actorId: actor, operationId: snowflake(at, 2) });
  assert.equal(f.access.roleId, null); // Same immutable interaction is a no-op.
});

for (const phase of ['before', 'after']) test(`permission write ${phase === 'before' ? 'failure' : 'lost acknowledgement'} never grants an unconfirmed role`, async () => {
  const f = await fixture(); let failed = false;
  f.intercept(event => { if (!failed && event.name === 'settings' && event.method === 'updateOne' && event.phase === phase) { failed = true; throw new Error('database failure'); } });
  const result = f.access.change({ roleId: secondRole, actorId: actor, operationId: snowflake(at, 1) });
  if (phase === 'before') await assert.rejects(result); else await result;
  assert.equal(failed, true); assert.equal(f.access.roleId, phase === 'before' ? roleId : secondRole);
  assert.equal(f.access.roleId, (await f.store.settings()).botPermissions.roleId);
});

test('unverifiable permission write drops delegated access until a confirmed read; native administrators can recover', async () => {
  const f = await fixture(); let unavailable = false;
  f.intercept(event => {
    if (event.name === 'settings' && event.method === 'updateOne' && event.phase === 'after') unavailable = true;
    if (unavailable && event.name === 'settings') throw new Error('database disconnected');
  });
  await assert.rejects(f.access.change({ roleId: secondRole, actorId: actor, operationId: snowflake(at, 1) }));
  assert.equal(f.access.roleId, null);
  assert.equal(canManageBot(interaction({ roles: [roleId] }), config, f.access.roleId), false);
  assert.equal(canConfigurePermissions(interaction({ bits: PermissionFlagsBits.Administrator }), config), true);
  f.intercept(() => {}); await f.access.read(); assert.equal(f.access.roleId, secondRole);
});

test('an old write delayed across a worker handoff cannot overwrite a newer saved role', async () => {
  const f = await fixture(); let changed = false;
  f.intercept(event => {
    if (!changed && event.name === 'settings' && event.method === 'updateOne' && event.phase === 'before') {
      changed = true;
      f.documents.settings[0].botPermissions = { roleId: secondRole, actorId: actor, operationId: snowflake(at, 20), updatedAt: at };
    }
  });
  await assert.rejects(f.access.change({ roleId: null, actorId: actor, operationId: snowflake(at, 10) }));
  assert.equal(f.access.roleId, secondRole);
  assert.equal((await f.store.settings()).botPermissions.operationId, snowflake(at, 20));
});

const cases = [
  ['اضافة_نقاط', { العضو: { id: user }, النقاط: 10 }, 'adjustPoints'],
  ['ازالة_نقاط', { العضو: { id: user }, النقاط: 10 }, 'adjustPoints'],
  ['ريست_الجميع', { القسم: 'bank' }, 'resetPreview'], ['ريست_عضو', { العضو: { id: user } }, 'resetPreview'],
  ['setup', {}, 'setup'], ['حالة_البوت', {}, 'ping'], ['تصميم_الامبد', { الاسم: 'SNOW إدارة' }, 'setAppearance'],
  ['اعدادات_الحضور', { اقل_عدد: 2 }, 'setAttendance'],
  ['ادارة_المهام', { الاسم: 'مهمة', النوع: 'messages', الروم: destination.channelId, العدد: 50, النقاط: 100 }, 'addTemplate', 'اضافة'],
  ['ادارة_المهام', { الاسم: 'مهمة خاصة', النقاط: 100 }, 'addSpecialTask', 'اضافة_مهمة_خاصة'],
  ['اضافة_منتج', { الاسم: 'منتج جديد', السعر: 100, الكمية: 1 }, 'manageShop'],
  ['ازالة_منتج', { المنتج: 'بطاقة هدية' }, 'manageShop'],
  ['اعدادات_المتجر', { الروم: { id: destination.channelId }, الرتبة: { id: destination.roleId } }, 'manageShop']
];
for (const [name, options, expected, sub] of cases) test(`delegated role can execute ${name}${sub ? ` ${sub}` : ''}; an ordinary member cannot`, async () => {
  const f = await fixture();
  const denied = interaction({ name, options, sub }); await f.handler(denied);
  assert.equal(denied.deferred, undefined); assert.equal(f.calls.length, 0);
  const allowed = interaction({ name, options, sub, roles: [roleId], cached: true }); await f.handler(allowed);
  assert.ok(f.calls.includes(expected), f.errors.map(e => e.message).join('\n'));
  if (expected === 'resetPreview') {
    const confirm = allowed.replies[0].components[0].toJSON().components[0].custom_id;
    const button = interaction({ customId: confirm, roles: [roleId] }); await f.handler(button);
    assert.ok(f.calls.includes('reset'));
  }
  assert.equal(f.errors.length, 0, f.errors.map(e => e.message).join('\n'));
});

test('revoking the configured role or removing it from a member prevents an old reset confirmation', async () => {
  for (const revokeSetting of [true, false]) {
    const f = await fixture(); const preview = interaction({ name: 'ريست_الجميع', roles: [roleId], options: { القسم: 'bank' } }); await f.handler(preview);
    const confirm = preview.replies[0].components[0].toJSON().components[0].custom_id;
    if (revokeSetting) await f.access.change({ roleId: null, actorId: actor, operationId: snowflake(at, 11) });
    const button = interaction({ customId: confirm, roles: revokeSetting ? [roleId] : [] }); await f.handler(button);
    assert.equal(button.updated, undefined); assert.match(button.replies[0].content, /رتبة إدارة البوت/);
    assert.equal(f.calls.includes('reset'), false);
  }
});

test('text setup uses the same delegated role and revocation; delegation does not bypass clan purchase membership', async () => {
  const f = await fixture(); const handler = createSetupMessageHandler(f.ctx);
  const member = interaction({ roles: [roleId], cached: true }).member;
  let denied = 0;
  const message = { guildId: config.clanGuildId, channelId: destination.channelId, content: 'setup', member,
    author: { id: actor, bot: false }, reply: async () => { denied++; } };
  await handler(message); assert.equal(f.calls.filter(c => c === 'setup').length, 1);
  f.access.roleId = null; await handler(message); assert.equal(denied, 1);
  f.access.roleId = roleId;
  const purchase = interaction({ name: 'المتجر', roles: [roleId] }); await f.handler(purchase);
  assert.equal(purchase.deferred, undefined); assert.match(purchase.replies[0].content, /أعضاء الكلان/);
});
