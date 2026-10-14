import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { buildCommands, createHandler } from '../src/commands.js';
import { createTextCommands, commandsPanel } from '../src/experience-commands.js';
import { activityView, parseRankAction, rankPanel } from '../src/activity-views.js';
import { createDay } from '../src/domain.js';
import { dailyQuestPayload } from '../src/daily-quest-views.js';
import { dayKey } from '../src/time.js';
import { panelPayload } from '../src/panel.js';

const user = '100000000000000010', other = '100000000000000011';
// Assert content independently of the invisible bidi marks used for display.
const visibleText = text => text.replace(/[\u200f\u2066-\u2069]/g, '');
const config = { clanGuildId: '100000000000000001', arenaGuildId: '100000000000000002',
  clanChatChannelId: '100000000000000041', voiceChannelId: '100000000000000042',
  secondVoiceChannelId: '100000000000000043', thirdVoiceChannelId: '100000000000000044' };
const now = Date.now();
const quest = createDay(config.clanGuildId, user, dayKey(now), [], now);
function setup(overrides = {}) {
  const calls = { boards: [], ranks: [], offers: [], answers: [], adjustments: [] };
  const ctx = { config, access: { roleId: null }, isMember: id => id === user, status: () => ({ tracking: true }),
    store: { settings: async () => ({ appearance: { name: 'SNOW' } }),
      activityRanking: async (...args) => { calls.boards.push(args); return Array.from({ length: 6 }, (_, i) => ({ _id: String(BigInt(user) + BigInt(i)), chat: 100 - i, voice: (100 - i) * 60000 })); },
      activityPosition: async (...args) => { calls.ranks.push(args); return { position: 24, value: args[2] === 'chat' ? 175 : 11 * 3600000 + 42 * 60000 + 55000 }; } },
    service: { clock: () => now, day: async id => { calls.offers.push(id); return { ...quest, userId: id }; },
      adjustPoints: async args => { calls.adjustments.push(args); return { ...args, before: 100, after: 200, totalAfter: 200, day: '2026-09-23' }; } },
    onError: error => { throw error; } };
  Object.assign(ctx, overrides);
  return { ctx, calls, handler: createHandler(ctx) };
}
function interaction(name, id, member = user) {
  const calls = [];
  return { calls, id: '100000000000000099', user: { id: member }, createdTimestamp: now,
    guildId: config.clanGuildId, commandName: name, customId: id,
    isButton: () => !!id, isChatInputCommand: () => !id, isStringSelectMenu: () => false,
    options: { getString: () => null, getInteger: () => null },
    reply: async payload => calls.push(['reply', payload]), deferReply: async payload => calls.push(['deferReply', payload]),
    deferUpdate: async () => calls.push(['deferUpdate']), editReply: async payload => calls.push(['editReply', payload]) };
}

test('rank commands publish one combined button; currency and upcoming commands register in the clan', () => {
  const commands = buildCommands();
  const board = commands.find(c => c.name === 'المتصدرين');
  assert.deepEqual(board.options, []);
  assert.equal(board.default_member_permissions, null);
  for (const name of ['اوامر', 'ترتيبي', 'مهمتي', 'توب', 'راتب', 'نهب', 'رصيدي', 'اضافة_عملة', 'ازالة_عملة']) {
    assert.equal(commands.find(c => c.name === name).dm_permission, false);
  }
  const labels = panelPayload(60).components.flatMap(r => r.components.map(b => b.data.label));
  assert.ok(!labels.includes('توب الشات')); assert.ok(!labels.includes('توب الفويس'));
  assert.equal(labels.filter(label => label === 'ترتيبي الشخصي').length, 1);
  assert.ok(!labels.includes('توب المهمات')); assert.ok(!labels.includes('التوب الشامل'));
});

test('personal rank button returns only the clicking member ranks and five leaders per category privately', async () => {
  const f = setup(); const i = interaction(null, 'clan-rank:open'); await f.handler(i);
  assert.deepEqual(i.calls[0], ['deferReply', { flags: MessageFlags.Ephemeral }]);
  assert.equal(f.calls.ranks.length, 2); assert.ok(f.calls.ranks.every(args => args[0] === user));
  const payload = i.calls.at(-1)[1]; const embed = payload.embeds[0].data;
  assert.equal(visibleText(embed.description), '**مركزك في توب الشات: #24** - `175` رسالة\n**مركزك في توب الفويس: #24** - `11س 42د 55ث` صوت');
  assert.deepEqual(embed.fields.map(field => field.name), ['توب الفويس', 'توب الشات']);
  assert.ok(visibleText(embed.fields[0].value).startsWith(`**#1** <@${user}> - \`1س 40د 0ث\``));
  assert.ok(visibleText(embed.fields[1].value).startsWith(`**#1** <@${user}> - \`100\` رسالة`));
  assert.equal(embed.author, undefined); assert.equal(embed.color, 0xffffff);
  assert.equal(payload.components.length, 2);
  assert.ok(embed.fields.every(f => [...f.value.matchAll(/<@/g)].length === 5));
  assert.deepEqual(payload.allowedMentions, { parse: [] });
});

test('next/previous and period controls work in a fresh handler, ownership and guild guards reject cross-use', async () => {
  const id = `clan-rank:v2:${user}:personal:chat:weekly:2:next`;
  const f = setup(); const i = interaction(null, id); await f.handler(i);
  assert.equal(i.calls[0][0], 'deferUpdate'); assert.equal(f.calls.boards[0][3].skip, 5);
  assert.equal(f.calls.boards[0][3].limit, 6); assert.equal(f.calls.boards[0][0], 'weekly');
  const denied = interaction(null, id, other); await f.handler(denied);
  assert.equal(denied.calls[0][0], 'reply'); assert.equal(f.calls.boards.length, 2);
  const outside = interaction(null, 'clan-rank:open'); outside.guildId = config.arenaGuildId;
  await f.handler(outside); assert.equal(outside.calls[0][0], 'reply');
  assert.equal(parseRankAction(`clan-rank:v2:${user}:board:tasks:all:1:next`), null);
  assert.equal(parseRankAction(`clan-rank:v2:${user}:board:chat:all:0:next`), null);
});

test('commands and personal-rank text triggers post two distinct reusable public messages', async () => {
  const f = setup(); const text = createTextCommands(f.handler, config); const replies = [], dms = [];
  const channelId = '100000000000000060';
  f.ctx.store.settings = async () => ({ appearance: { name: 'SNOW' }, bank: { channelId } });
  const message = content => ({ content, guildId: config.clanGuildId, channelId, id: '100000000000000099', author: { id: user, send: async p => { dms.push(p); return { id: 'dm' }; } },
    member: { permissions: { has: flag => flag === PermissionFlagsBits.Administrator } },
    createdTimestamp: now, reply: async payload => { replies.push(payload); return { edit: async () => {} }; } });
  await text(message('اوامر')); await text(message('- ترتيبي')); await text(message('-مهمتي'));
  assert.equal(replies[0].components.flatMap(r => r.components).length, 6);
  assert.equal(replies[1].embeds[0].data.title, 'ترتيبك الشخصي');
  assert.equal(replies[2].components[0].components[0].data.label, 'استعراض المهام');
  assert.equal(replies[2].embeds, undefined);
  assert.equal(dms.length, 0);
  assert.equal(replies.length, 3); assert.ok(replies.every(p => !('flags' in p)));
  await text({ ...message('مهمتي'), author: { id: user, bot: true } });
  await text({ ...message('مهمتي'), guildId: config.arenaGuildId });
  await text({ ...message('مهمتي'), webhookId: 'x' });
  assert.equal(replies.length, 3); assert.equal(f.calls.offers.length, 0);
});

test('rank publishing is management-only for both slash aliases and checks delegated permission changes', async () => {
  const f = setup(); const role = '100000000000000090';
  for (const name of ['ترتيبي', 'المتصدرين']) {
    const denied = interaction(name); await f.handler(denied);
    assert.equal(denied.calls.length, 1); assert.equal(denied.calls[0][0], 'reply');
    assert.equal(denied.calls[0][1].flags, MessageFlags.Ephemeral);
    assert.match(denied.calls[0][1].content, /إدارة/);
    for (const permission of [PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild]) {
      const admin = interaction(name); admin.memberPermissions = { has: flag => flag === permission };
      await f.handler(admin);
      assert.deepEqual(admin.calls[0], ['deferReply', {}]);
      const payload = admin.calls.at(-1)[1];
      assert.equal(payload.embeds[0].data.title, 'ترتيبك الشخصي');
      assert.deepEqual(payload.components.flatMap(row => row.components.map(b => b.data.custom_id)), ['clan-rank:open', 'clan-notifications:toggle', 'clan-bank:open']);
    }
    const owner = interaction(name); owner.guild = { ownerId: user }; await f.handler(owner);
    assert.equal(owner.calls.at(-1)[1].embeds[0].data.title, 'ترتيبك الشخصي');
    f.ctx.access.roleId = role;
    const delegated = interaction(name); delegated.member = { roles: [role] }; await f.handler(delegated);
    assert.equal(delegated.calls.at(-1)[1].embeds[0].data.title, 'ترتيبك الشخصي');
    f.ctx.access.roleId = null;
    const revoked = interaction(name); revoked.member = { roles: [role] }; await f.handler(revoked);
    assert.equal(revoked.calls.length, 1); assert.equal(revoked.calls[0][0], 'reply');
  }
  assert.equal(f.calls.boards.length, 0); assert.equal(f.calls.ranks.length, 0);
});

test('spaced text publishing denies regular users and accepts all exact rank aliases for administrators', async () => {
  const f = setup(); const text = createTextCommands(f.handler, config); const replies = [], dms = [];
  const message = content => ({ content, guildId: config.clanGuildId, id: '100000000000000099',
    author: { id: user }, createdTimestamp: now,
    reply: async payload => { replies.push(payload); return { edit: async () => {} }; } });
  for (const command of ['- ترتيبي', '-ترتيبي', 'ترتيبي', '- المتصدرين']) {
    await text(message(command));
    assert.match(replies.at(-1).content, /إدارة/); assert.equal(replies.at(-1).embeds, undefined);
    await text({ ...message(command), member: { permissions: { has: flag => flag === PermissionFlagsBits.Administrator } } });
    assert.equal(replies.at(-1).embeds[0].data.title, 'ترتيبك الشخصي');
    assert.ok(!('flags' in replies.at(-1)));
  }
  const count = replies.length;
  await text(message('كلام - ترتيبي')); await text(message('- ترتيبي كلام'));
  assert.equal(replies.length, count); assert.equal(f.calls.boards.length, 0);
});

test('every member can click the shared button and receives their own ephemeral ranks without publishing permission', async () => {
  const f = setup();
  f.ctx.store.activityPosition = async (id, period, metric) => {
    f.calls.ranks.push([id, period, metric]);
    return { position: id === user ? 24 : 33, value: metric === 'chat' ? 175 : 11 * 3600000 + 42 * 60000 + 55000 };
  };
  for (const id of [user, other]) {
    const i = interaction(null, 'clan-rank:open', id); await f.handler(i);
    assert.deepEqual(i.calls[0], ['deferReply', { flags: MessageFlags.Ephemeral }]);
    const embed = i.calls.at(-1)[1].embeds[0].data;
    assert.ok(visibleText(embed.description).startsWith(`**مركزك في توب الشات: #${id === user ? 24 : 33}**`));
    assert.deepEqual(embed.fields.map(field => field.name), ['توب الفويس', 'توب الشات']);
    assert.ok(i.calls.every(([method]) => method !== 'deferUpdate'));
  }
  assert.deepEqual(f.calls.ranks.map(args => args[0]), [user, user, other, other]);
});

test('legacy public leaderboard controls open private combined ranks and never edit the shared board', async () => {
  const f = setup();
  const old = interaction(null, `clan-rank:v2:${user}:board:voice:all:2:next`);
  await f.handler(old);
  assert.deepEqual(old.calls[0], ['deferReply', { flags: MessageFlags.Ephemeral }]);
  assert.equal(old.calls.at(-1)[1].embeds[0].data.title, 'ترتيبك الشخصي');
  assert.ok(old.calls.at(-1)[1].embeds[0].data.fields.every(field => visibleText(field.value).startsWith('**#6**')));
  for (const category of ['chat', 'voice', 'total', 'attendance', 'tasks']) {
    const oldPanel = interaction(null, `clan-panel:v1:${category}`, other); await f.handler(oldPanel);
    assert.deepEqual(oldPanel.calls[0], ['deferReply', { flags: MessageFlags.Ephemeral }]);
    assert.deepEqual(oldPanel.calls.at(-1)[1].embeds[0].data.fields.map(field => field.name), ['توب الفويس', 'توب الشات']);
  }
});

test('bank top and salary require bank setup and report publicly without modifying money', async () => {
  const f = setup({ onError: () => {} });
  for (const name of ['توب', 'راتب']) {
    const i = interaction(name); await f.handler(i);
    assert.deepEqual(i.calls[0], ['deferReply', {}]);
    assert.match(i.calls.at(-1)[1].content, /اعدادات_البنك/);
  }
  assert.equal(f.calls.offers.length, 0); assert.equal(f.calls.adjustments.length, 0);
  assert.equal(f.calls.boards.length, 0);
});

test('unified currency administration uses the total wallet and retains existing role authorization', async () => {
  const f = setup();
  for (const name of ['اضافة_عملة', 'ازالة_عملة']) {
    const i = interaction(name); i.memberPermissions = { has: flag => flag === PermissionFlagsBits.ManageGuild };
    i.options = { getUser: () => ({ id: user }), getInteger: name => { assert.equal(name, 'المبلغ'); return 100; }, getString: () => null };
    await f.handler(i); assert.equal(f.calls.adjustments.at(-1).category, 'total');
    assert.equal(f.calls.adjustments.at(-1).mode, name === 'اضافة_عملة' ? 'add' : 'remove');
    assert.ok(i.calls.at(-1)[1].embeds[0].data.description.includes('💵'));
    const denied = interaction(name); await f.handler(denied); assert.equal(denied.calls[0][0], 'reply');
  }
  assert.equal(f.calls.adjustments.length, 2);
});

test('new embeds and controls retain intended branding and fit Discord limits', async () => {
  const f = setup(); const appearance = { name: 'S'.repeat(50), color: 0x123456,
    imageUrl: 'https://example.com/banner.png', thumbnailUrl: 'https://example.com/icon.png' };
  const payloads = [commandsPanel(appearance), rankPanel(appearance), dailyQuestPayload(quest, now, true, config, { appearance }),
    await activityView({ store: f.ctx.store, config: { ...config, activityStartedAt: now }, ownerId: user, personal: true, appearance })];
  assert.equal(payloads[3].embeds[0].data.fields.length, 2);
  assert.equal(payloads[1].embeds[0].data.description, 'اضغط ترتيبي الشخصي لمعرفة ترتيبك في توب الشات وتوب الفويس.\nزر تنبيه يوقف أو يفعّل تنبيهاتك بالخاص؛ مفعّلة افتراضيًا.\nتوب البنك يعرض جميع المشاركين مع السابق والتالي والتحديث.');
  for (const payload of payloads) {
    for (const embed of payload.embeds) {
      const data = embed.toJSON(); assert.ok(embed.length <= 6000);
      if (data.footer?.text === 'نظام المهام' || data.title === 'أوامر البنك') {
        assert.equal(data.image, undefined); assert.equal(data.thumbnail, undefined); assert.equal(data.color, 0xffffff);
      } else { assert.equal(data.image.url, appearance.imageUrl); assert.equal(data.thumbnail.url, appearance.thumbnailUrl); }
      for (const field of data.fields || []) assert.ok(field.value.length <= 1024);
    }
    const ids = payload.components.flatMap(row => { assert.ok(row.components.length <= 5); return row.components.map(c => c.data.custom_id); });
    assert.equal(new Set(ids).size, ids.length); assert.ok(ids.every(id => id.length <= 100));
  }
});
