import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, PermissionFlagsBits, ApplicationCommandOptionType } from 'discord.js';
import { buildCommands, createHandler } from '../src/commands.js';
import { createDay, seedTemplates } from '../src/domain.js';
import { tasksEmbed, pointsEmbed, rulesEmbed } from '../src/presentation.js';
import { applyPointAdjustment, netPoints } from '../src/point-adjustments.js';

const config = { clanGuildId: '100000000000000001', arenaGuildId: '100000000000000002',
  generalChannelId: '100000000000000003', voiceChannelId: '100000000000000004',
  feelingChannelId: '100000000000000006', lookChannelId: '100000000000000007', memberRole: '100000000000000008' };
const member = '100000000000000010';
const admin = '100000000000000099';
const at = Date.parse('2026-09-08T12:00:00Z');
function fixture() {
  const calls = { adjustments: [], errors: [] };
  const ctx = { config, isMember: id => id === member,
    store: { settings: async () => ({ appearance: { name: 'SNOW', color: 0xabcdef,
      imageUrl: 'https://example.com/banner.png', thumbnailUrl: 'https://example.com/clan.png' } }) },
    service: { adjustPoints: async request => {
      calls.adjustments.push(request);
      const after = 500 + (request.mode === 'add' ? request.amount : -request.amount);
      return { ...request, before: 500, after, totalAfter: after + 100, day: '2026-09-08', duplicate: false };
    } }, onError: error => calls.errors.push(error) };
  return { ctx, calls, handler: createHandler(ctx) };
}
function interaction({ commandName = 'اضافة_نقاط', guildId = config.clanGuildId,
  permitted = true, target = member, bot = false, amount = 100, category = null, reason = null } = {}) {
  const calls = [];
  return { calls, commandName, guildId, id: '300000000000000001', createdTimestamp: at, user: { id: admin },
    isButton: () => false, isChatInputCommand: () => true,
    memberPermissions: { has: permission => permitted && permission === PermissionFlagsBits.ManageGuild },
    options: {
      getUser: name => { assert.equal(name, 'العضو'); return { id: target, bot }; },
      getInteger: name => { assert.equal(name, 'النقاط'); return amount; },
      getString: name => name === 'النوع' ? category : name === 'السبب' ? reason : null
    },
    reply: async payload => { calls.push({ type: 'reply', payload }); },
    deferReply: async payload => { calls.push({ type: 'deferReply', payload }); },
    editReply: async payload => { calls.push({ type: 'editReply', payload }); }
  };
}

test('add/remove point commands require management permission, target and a positive bounded integer', () => {
  const commands = buildCommands().filter(c => ['اضافة_نقاط', 'ازالة_نقاط'].includes(c.name));
  assert.equal(commands.length, 2);
  for (const command of commands) {
    assert.equal(command.dm_permission, false);
    assert.equal(command.default_member_permissions, null);
    const [user, points, category, reason] = command.options;
    assert.equal(user.name, 'العضو'); assert.equal(user.type, ApplicationCommandOptionType.User); assert.equal(user.required, true);
    assert.equal(points.name, 'النقاط'); assert.equal(points.min_value, 1); assert.equal(points.max_value, 1000000); assert.equal(points.required, true);
    assert.deepEqual(category.choices.map(c => c.value), ['tasks', 'attendance']); assert.equal(reason.max_length, 200);
  }
});

test('non-admins, DMs and another guild cannot modify points or receive an administrative preview', async () => {
  const f = fixture();
  for (const commandName of ['اضافة_نقاط', 'ازالة_نقاط']) {
    for (const extra of [{ permitted: false }, { guildId: null }, { guildId: 'another-clan' }]) {
      const i = interaction({ commandName, ...extra }); await f.handler(i);
      assert.equal(i.calls[0].type, 'reply'); assert.equal(i.calls[0].payload.flags, MessageFlags.Ephemeral);
    }
  }
  assert.deepEqual(f.calls.adjustments, []);
});

test('default addition is private, targets the selected member and uses the Discord interaction ID and creation time', async () => {
  const f = fixture(); const i = interaction(); await f.handler(i);
  assert.equal(i.calls[0].type, 'deferReply'); assert.equal(i.calls[0].payload.flags, MessageFlags.Ephemeral);
  assert.deepEqual(f.calls.adjustments, [{ userId: member, actorId: admin, operationId: i.id, at,
    mode: 'add', category: 'tasks', amount: 100, reason: '' }]);
  const payload = i.calls.at(-1).payload; const embed = payload.embeds[0].toJSON();
  assert.match(embed.title, /إضافة/); assert.match(embed.description, /\+100/);
  assert.ok(embed.fields.some(field => field.value === '600'));
  assert.ok(embed.fields.some(field => field.value === '700'));
  assert.equal(embed.color, 0xabcdef); assert.equal(embed.image.url, 'https://example.com/banner.png');
  assert.equal(embed.thumbnail.url, 'https://example.com/clan.png');
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.ok(payload.embeds[0].length < 6000);
});

test('voice subtraction preserves the reason and only changes the selected member/category', async () => {
  const f = fixture(); const i = interaction({ commandName: 'ازالة_نقاط', category: 'attendance', amount: 50, reason: 'تصحيح نقاط' });
  await f.handler(i);
  assert.equal(f.calls.adjustments[0].mode, 'remove'); assert.equal(f.calls.adjustments[0].category, 'attendance');
  assert.equal(f.calls.adjustments[0].amount, 50); assert.equal(f.calls.adjustments[0].reason, 'تصحيح نقاط');
  const embed = i.calls.at(-1).payload.embeds[0].toJSON();
  assert.match(embed.title, /خصم/); assert.match(embed.description, /−50/);
  assert.ok(embed.fields.some(field => field.value === '450'));
});

test('additions require a human eligible clan member; historic deductions are allowed for a former member', async () => {
  const f = fixture();
  for (const extra of [{ target: '100000000000000011' }, { bot: true }]) {
    const i = interaction(extra); await f.handler(i);
    assert.ok(i.calls.at(-1).payload.content.startsWith('❌'));
  }
  assert.equal(f.calls.adjustments.length, 0);
  const former = interaction({ commandName: 'ازالة_نقاط', target: '100000000000000011' }); await f.handler(former);
  assert.equal(f.calls.adjustments.length, 1);
  assert.equal(f.calls.adjustments[0].userId, '100000000000000011');
});

test('reasons cannot trigger mentions or break the embed formatting', async () => {
  const f = fixture(); const i = interaction({ reason: '**bonus** @everyone <@123>' }); await f.handler(i);
  const payload = i.calls.at(-1).payload;
  const reason = payload.embeds[0].toJSON().fields.find(field => field.name === 'السبب').value;
  assert.ok(!reason.includes('@everyone')); assert.ok(reason.includes('\\*'));
  assert.deepEqual(payload.allowedMentions, { parse: [] });
});

test('insufficient balance and uncertain writes never show a success result', async () => {
  const f = fixture();
  for (const error of [new Error('الرصيد المتاح 10 نقاط فقط؛ لم يتم الخصم.'), new Error('socket closed')]) {
    f.ctx.service.adjustPoints = async () => { throw error; };
    const i = interaction({ commandName: 'ازالة_نقاط' }); await f.handler(i);
    assert.deepEqual(i.calls.at(-1).payload.embeds, []);
    assert.ok(i.calls.at(-1).payload.content.startsWith('❌'));
    assert.ok(!i.calls.at(-1).payload.content.includes('socket closed'));
  }
});

test('a reply failure after a successful commit does not repeat the adjustment or claim the commit failed', async () => {
  const f = fixture(); const i = interaction(); const edit = i.editReply; let failed = false;
  i.editReply = async payload => { if (!failed) { failed = true; throw new Error('Discord unavailable'); } return edit(payload); };
  await f.handler(i);
  assert.equal(f.calls.adjustments.length, 1);
  assert.match(i.calls.at(-1).payload.content, /حُفظ تعديل العملة/);
});

test('duplicate-operation responses identify the stored result without another credit', async () => {
  const f = fixture(); const apply = f.ctx.service.adjustPoints;
  f.ctx.service.adjustPoints = async request => ({ ...await apply(request), duplicate: true });
  const i = interaction(); await f.handler(i);
  assert.match(i.calls.at(-1).payload.embeds[0].toJSON().title, /مسجلة سابقًا/);
});

test('member embeds include signed adjustments while the voice progress meter uses earned points only', () => {
  const state = createDay(config.clanGuildId, member, '2026-09-08', seedTemplates(config), at);
  state.points = { tasks: 100, attendance: 40 };
  const beforeTasks = structuredClone(state.tasks);
  applyPointAdjustment(state, { operationId: '300000000000000001', category: 'attendance', delta: 100 });
  applyPointAdjustment(state, { operationId: '300000000000000002', category: 'tasks', delta: -200 });
  assert.deepEqual(netPoints(state), { tasks: -100, attendance: 140, total: 40 });
  const rule = { enabled: true, channelId: config.voiceChannelId, intervalMs: 60000, points: 10, dailyCap: 50, version: 1 };
  const tasks = tasksEmbed(state, at, true, config).toJSON();
  assert.equal(tasks.fields.find(field => field.name === '💵 صافي اليوم').value, '**40** $ 💵');
  assert.match(tasks.fields.find(field => field.name === 'تعديلات الإدارة اليوم').value, /الرصيد السالب/);
  const points = pointsEmbed({ all: { tasks: 200, attendance: 200, total: 400 } }, state, rule, {}, at).toJSON();
  assert.match(points.fields.find(field => field.name === 'يومي').value, /مهام -100 • فويس 140/);
  assert.equal(points.fields.some(field => field.name === 'حد مكافآت الحضور اليوم'), false);
  assert.deepEqual(state.tasks, beforeTasks);
  assert.ok(rulesEmbed(config, rule).toJSON().fields.some(field => field.name === '💵 الرصيد والمتجر'));
});
