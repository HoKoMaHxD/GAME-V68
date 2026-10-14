import test from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle, MessageFlags } from 'discord.js';
import { buildCommands, createHandler } from '../src/commands.js';
import { createTextCommands, commandsPanel } from '../src/experience-commands.js';
import { robberyPayload, parseRobberyAction } from '../src/robbery-commands.js';
import { newRobberyRound, resolveRobbery, robberyProtection } from '../src/robbery.js';
import { pointsEmbed, tasksEmbed } from '../src/presentation.js';
import { fixture, at, user, other, actor, config, snowflake } from './helpers/shop-fixture.js';

const channelId = '100000000000000060';
const roundId = snowflake(at, 200);
const avatarURL = 'https://cdn.discordapp.com/avatars/100000000000000010/avatar.png';
const visibleText = text => text.replace(/[\u200e\u200f\u2066-\u2069]/g, '');
async function setup() {
  const f = await fixture(); await f.store.robbery.initialize(at); await f.seed(); await f.seed(other, 2000);
  const openRobbery = f.service.openRobbery.bind(f.service);
  f.service.openRobbery = (input, eligible, choose = min => min) => openRobbery(input, eligible, choose);
  const ctx = { config, store: f.store, service: f.service, isMember: () => false,
    isBankMember: async id => [user, other].includes(id),
    status: () => ({ tracking: true }), onError: () => {} };
  return { ...f, ctx, handler: createHandler(ctx) };
}
function interaction({ member = user, target = { id: other }, customId, guildId = config.clanGuildId } = {}) {
  const calls = [];
  const call = name => async payload => { calls.push([name, payload]); };
  return { calls, id: customId ? snowflake(at, 201) : roundId,
    user: { id: member, username: 'big smoke', displayAvatarURL: () => avatarURL },
    guildId, channelId, commandName: customId ? undefined : 'نهب', customId, createdTimestamp: at,
    isChatInputCommand: () => !customId, isButton: () => !!customId, isStringSelectMenu: () => false,
    options: { getUser: () => target },
    reply: call('reply'), deferReply: call('deferReply'), editReply: call('editReply'),
    deferUpdate: call('deferUpdate'), followUp: call('followUp') };
}
const key = (owner = user, move = 'paper') => `clan-robbery:v1:${owner}:${roundId}:${move}`;

test('slash robbery has exactly one required member and commands panel lists its reference description', () => {
  const commands = buildCommands(); const matches = commands.filter(c => c.name === 'نهب');
  assert.equal(matches.length, 1); assert.equal(commands.length, 50);
  assert.equal(matches[0].dm_permission, false);
  assert.deepEqual(matches[0].options.map(o => [o.name, o.type, o.required]), [['العضو', 6, true]]);
  const description = commandsPanel().embeds[0].data.description;
  assert.equal(visibleText(description).split('\n').find(line => line.includes('-نهب')), '`-نهب` : محاولة نهب عضو');
  assert.equal(description.split('\n').find(line => line.includes('نهب')).includes('لاحقًا'), false);
});

test('public challenge contains only the three player options and no hidden bot move or selected rate', async () => {
  const f = await setup(); const i = interaction();
  const guildAvatar = 'https://cdn.discordapp.com/guilds/100000000000000001/users/100000000000000010/avatars/member.png';
  i.member = { displayName: 'اسم العضو في السيرفر', displayAvatarURL: () => guildAvatar };
  await f.handler(i);
  assert.deepEqual(i.calls[0], ['deferReply', {}]);
  const payload = i.calls.at(-1)[1];
  const saved = f.documents.robbery_rounds[0]; assert.ok(saved.botMove); assert.ok(saved.percent >= 15 && saved.percent <= 40 && saved.lossPercent >= 40 && saved.lossPercent <= 60);
  assert.equal(payload.components.length, 1);
  assert.deepEqual(payload.components[0].components.map(b => b.data.label), ['حجر', 'ورقة', 'مقص']);
  assert.deepEqual(payload.components[0].components.map(b => b.data.custom_id), ['rock', 'paper', 'scissors'].map(move => key(user, move)));
  assert.ok(!JSON.stringify(payload).includes('botMove')); assert.ok(!JSON.stringify(payload).includes('النسبة: **'));
  const embed = payload.embeds[0].toJSON();
  assert.equal(embed.title, 'تحدي النهب');
  assert.equal(visibleText(embed.description), `اختر حجر أو ورقة أو مقص ضد البوت.\nإذا فزت، تنجح عملية نهب <@${other}>.\n**الوقت المتبقي:** <t:${Math.ceil(saved.expiresAt / 1000)}:R>\n⏳ عدم اختيار حركة قبل انتهاء الوقت يُحسب خسارة.`);
  assert.equal(embed.author.name, i.member.displayName); assert.equal(embed.author.icon_url, guildAvatar);
  assert.equal(embed.color, 0xffffff); assert.equal(embed.footer.text, 'SNOW Pay');
  assert.equal(embed.fields, undefined);
  assert.deepEqual(payload.components[0].components.map(b => b.data.emoji.name), ['✊', '✋', '✌️']);
  assert.ok(payload.components[0].components.every(b => b.data.style === ButtonStyle.Secondary && !b.data.disabled));
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.equal((await f.store.totals(user, 'all', at)).total, 1000);
});

test('a member cannot start a second robbery command while the first challenge is open', async () => {
  const f = await setup();
  await f.handler(interaction());

  const second = interaction(); second.id = snowflake(at, 202);
  await f.handler(second);

  assert.equal(second.calls.at(-1)[0], 'editReply');
  assert.match(second.calls.at(-1)[1].content, /تم منعك من النهب لمدة 5 دقائق/);
  assert.equal(f.documents.robbery_rounds.length, 1);
  assert.equal(f.documents.robbery_rounds[0].status, 'open');
});

test('victim and other members cannot press, and a forged owner in the custom ID still cannot settle', async () => {
  const f = await setup(); await f.handler(interaction());
  for (const member of [other, actor]) {
    const i = interaction({ member, customId: key() }); await f.handler(i);
    assert.equal(i.calls.length, 1); assert.equal(i.calls[0][0], 'reply');
    assert.equal(i.calls[0][1].flags, MessageFlags.Ephemeral);
  }
  const forged = interaction({ member: other, customId: key(other) }); await f.handler(forged);
  assert.equal(forged.calls.at(-1)[0], 'followUp'); assert.equal(forged.calls.at(-1)[1].flags, MessageFlags.Ephemeral);
  assert.equal(f.documents.robbery_rounds[0].status, 'open');
  assert.equal((await f.store.totals(user, 'all', at)).total, 1000);
});

test('owner selection reveals both moves, pays once and edits the public challenge with disabled buttons', async () => {
  const f = await setup();
  await f.service.openRobbery({ id: roundId, userId: user, targetId: other, channelId, at }, () => true, min => min === 0 ? 0 : min === 40 ? 60 : 30);
  const i = interaction({ customId: key() }); await f.handler(i);
  assert.equal(i.calls[0][0], 'deferUpdate'); const payload = i.calls.at(-1)[1];
  const embed = payload.embeds[0].toJSON();
  assert.equal(embed.title, 'كفو زرفته'); assert.equal(payload.components.length, 1);
  assert.ok(payload.components[0].components.every(b => b.data.disabled));
  assert.equal(visibleText(embed.description), `<@${user}> 🏃 <@${other}>`);
  assert.deepEqual(embed.fields.map(field => field.name), ['اختيارك', 'اختيار البوت', 'النسبة', 'المبلغ', 'رصيدك', 'حماية الضحية']);
  assert.deepEqual(embed.fields.slice(0, 5).map(field => visibleText(field.value)), ['✋ ورقة', '✊ حجر', '`30%`', '`600$`', '`1.6K$`']);
  assert.equal(visibleText(embed.fields[5].value), '`1 hour`');
  assert.ok(embed.fields.every(field => !field.inline));
  assert.equal(embed.author.name, 'big smoke'); assert.equal(embed.author.icon_url, avatarURL);
  const repeat = interaction({ customId: key(user, 'scissors') }); await f.handler(repeat);
  assert.deepEqual(repeat.calls.at(-1)[1].embeds[0].toJSON(), payload.embeds[0].toJSON());
  const expiry = at + 3600000;
  for (const [now, remaining] of [[expiry - 2826000, '47 minutes 6 seconds'], [expiry - 1, '1 second'], [expiry, '0 seconds']]) {
    const restarted = f.open(now), handler = createHandler({ ...f.ctx, ...restarted });
    const oldButton = interaction({ customId: key(user, 'rock') }); await handler(oldButton);
    const shown = oldButton.calls.at(-1)[1].embeds[0].toJSON();
    assert.equal(visibleText(shown.fields[5].value), `\`${remaining}\``);
    assert.deepEqual(shown.fields.slice(0, 5), embed.fields.slice(0, 5));
    assert.equal((await restarted.store.robbery.round(roundId)).protection.expiresAt, expiry);
  }
  assert.equal((await f.store.totals(user, 'all', at)).total, 1600);
});

test('failed theft displays a 15-minute target shield while ties display none', async () => {
  {
    const f = await setup();
    await f.service.openRobbery({ id: roundId, userId: user, targetId: other, channelId, at }, () => true, min => min === 0 ? 0 : min === 40 ? 60 : 30);
    const i = interaction({ customId: key(user, 'scissors') }); await f.handler(i);
    const field = i.calls.at(-1)[1].embeds[0].toJSON().fields.find(field => field.name === 'حماية الضحية');
    assert.equal(visibleText(field.value), '`15 minutes`');
  }
  {
    const f = await setup();
    await f.service.openRobbery({ id: roundId, userId: user, targetId: other, channelId, at }, () => true, min => min === 0 ? 0 : min === 40 ? 60 : 30);
    const i = interaction({ customId: key(user, 'rock') }); await f.handler(i);
    const field = i.calls.at(-1)[1].embeds[0].toJSON().fields.find(field => field.name === 'حماية الضحية');
    assert.equal(visibleText(field.value), 'لا توجد حماية تلقائية لهذه النتيجة.');
  }
});

test('a protected target gets the reference reply with its remaining minutes and seconds and no currency changes', async () => {
  const f = await setup();
  await f.service.openRobbery({ id: roundId, userId: user, targetId: other, channelId, at }, () => true, min => min === 0 ? 0 : min === 40 ? 60 : 30);
  await f.handler(interaction({ customId: key() }));
  const expiry = at + 3600000;
  for (const [now, duration] of [[at, '60 دقائق 0 ثانية'], [expiry - 2826000, '47 دقائق 6 ثانية'], [expiry - 1, '0 دقائق 1 ثانية']]) {
    const restarted = f.open(now), handler = createHandler({ ...f.ctx, ...restarted });
    const next = interaction(); next.id = snowflake(now, 220); next.createdTimestamp = now;
    await handler(next);
    const payload = next.calls.at(-1)[1];
    assert.equal(visibleText(payload.content), `🛡️ <@${other}> محمي من النهب لمدة \`${duration}\``);
    assert.deepEqual(payload.embeds, []); assert.deepEqual(payload.components, []);
    assert.deepEqual(payload.allowedMentions, { parse: [] }); assert.equal(payload.flags, undefined);
    const replies = [], text = createTextCommands(handler, config);
    await text({ id: snowflake(now, 221), guildId: config.clanGuildId, channelId, content: `-نهب <@${other}>`,
      createdTimestamp: now, author: { id: user }, mentions: { users: new Map([[other, { id: other }]]) },
      reply: async p => { replies.push(p); return { edit: async () => {} }; } });
    assert.match(replies[0].content, /تم منعك من النهب لمدة 5 دقائق/);
    assert.deepEqual(replies[0].allowedMentions, { parse: [], repliedUser: false });
  }
  assert.equal(f.documents.robbery_rounds.length, 1);
  assert.equal((await f.store.totals(other, 'all', at)).total, 1400);
});

test('bang command resolves the mentioned member and cannot start for bots, webhook or another guild', async () => {
  const f = await setup(); const text = createTextCommands(f.handler, config); const replies = [];
  const message = content => ({ id: roundId, guildId: config.clanGuildId, channelId, content, createdTimestamp: at,
    author: { id: user, username: 'big smoke', displayAvatarURL: () => avatarURL }, mentions: { users: new Map([[other, { id: other }]]) },
    reply: async payload => { replies.push(payload); return { edit: async p => replies.push(p) }; } });
  for (const content of [`!نهب <@${other}>`, `!نهب <@!${other}>`, `! نهب <@${other}>`, `-نهب <@${other}>`]) {
    await text(message(content)); assert.equal(replies.at(-1).embeds[0].data.title, 'تحدي النهب');
    assert.equal(replies.at(-1).embeds[0].data.author.name, 'big smoke');
    assert.equal(replies.at(-1).embeds[0].data.author.icon_url, avatarURL);
    assert.equal(f.documents.robbery_rounds[0].targetId, other);
  }
  assert.equal(f.documents.robbery_rounds.length, 1); const count = replies.length;
  await text({ ...message(`!نهب <@${other}>`), author: { id: user, bot: true } });
  await text({ ...message(`!نهب <@${other}>`), webhookId: actor });
  await text({ ...message(`!نهب <@${other}>`), guildId: config.arenaGuildId });
  assert.equal(replies.length, count);
  await text(message('!نهب')); assert.match(replies.at(-1).content, /منشن/);
  await text(message(`!نهب <@${other}> <@${actor}>`)); assert.match(replies.at(-1).content, /عضو واحد/);
});

test('missing, self, bot, ineligible and foreign-server targets never create a challenge', async () => {
  const f = await setup();
  for (const options of [{ target: null }, { target: { id: user } }, { target: { id: other, bot: true } },
    { target: { id: actor } }, { member: actor }, { guildId: config.arenaGuildId }]) {
    const i = interaction(options); await f.handler(i);
    assert.ok(['reply', 'editReply'].includes(i.calls.at(-1)[0]));
    assert.equal(i.calls.at(-1)[1].flags, undefined);
    assert.ok(i.calls.at(-1)[1].content);
  }
  const malformed = interaction({ customId: key(user, 'invalid') }); await f.handler(malformed);
  assert.equal(malformed.calls[0][0], 'reply');
  assert.equal(f.documents.robbery_rounds.length, 0);
});

test('an uncertain payment leaves the public challenge intact and reports privately for recovery', async () => {
  const f = await setup(); await f.handler(interaction());
  f.ctx.service.settleRobbery = async () => { throw new Error('لم يتأكد التحويل. أعد تشغيل الخدمة.'); };
  const i = interaction({ customId: key() }); await f.handler(i);
  assert.deepEqual(i.calls.map(([method]) => method), ['deferUpdate', 'followUp']);
  assert.equal(i.calls.at(-1)[1].flags, MessageFlags.Ephemeral);
  assert.equal(f.documents.robbery_rounds[0].status, 'open');
});

test('failed Discord result edit does not refund or repeat the already committed transfer', async () => {
  const f = await setup();
  await f.service.openRobbery({ id: roundId, userId: user, targetId: other, channelId, at }, () => true, min => min === 0 ? 0 : min === 40 ? 60 : 30);
  const i = interaction({ customId: key() }); i.editReply = async () => { throw new Error('Discord unavailable'); };
  await f.handler(i);
  assert.equal(i.calls.at(-1)[0], 'followUp'); assert.match(i.calls.at(-1)[1].content, /محفوظة/);
  await f.handler(interaction({ customId: key(user, 'rock') }));
  assert.equal((await f.store.totals(user, 'all', at)).total, 1600);
  assert.equal((await f.store.totals(other, 'all', at)).total, 1400);
});

test('all result variants fit embed limits, retain the footer brand and disable completed choices', () => {
  const appearance = { name: 'SNOW', imageUrl: 'https://example.com/banner.png', thumbnailUrl: 'https://example.com/icon.png' };
  const round = newRobberyRound({ id: roundId, userId: user, targetId: other, channelId, at }, at, min => min === 0 ? 0 : min === 40 ? 60 : 15);
  for (const status of ['open', 'expired', 'cancelled', 'settled']) for (const playerMove of ['rock', 'paper', 'scissors']) {
    const result = resolveRobbery(round, playerMove, { user: { tasks: 1000, attendance: 0, total: 1000 }, target: { tasks: 2000, attendance: 0, total: 2000 } });
    const payload = robberyPayload({ ...round, status, playerMove, result, settledAt: at,
      protection: robberyProtection(round, result, at) }, appearance, {}, at);
    const embed = payload.embeds[0]; const data = embed.toJSON(); assert.ok(embed.length < 6000);
    assert.equal(data.image, undefined); assert.equal(data.thumbnail, undefined);
    assert.equal(data.color, 0xffffff); assert.equal(data.footer.text, 'SNOW Pay');
    assert.equal(data.author.name, 'عضو الكلان');
    assert.equal(payload.components.length, 1);
    if (status === 'settled') {
      assert.deepEqual([...data.description.matchAll(/<@(\d+)>/g)].map(m => m[1]), result.amount ? [result.toId, result.fromId] : [round.userId, round.targetId]);
      assert.equal(visibleText(data.fields.find(f => f.name === 'رصيدك').value), `\`${result.after.user < 1000 ? result.after.user : result.after.user / 1000 + 'K'}$\``);
      assert.equal(visibleText(data.fields.find(f => f.name === 'النسبة').value), `\`${result.percent}%\``);
    }
    for (const row of payload.components) for (const button of row.components) {
      assert.ok(button.data.custom_id.length <= 100); assert.ok(parseRobberyAction(button.data.custom_id));
      assert.equal(button.data.disabled, status !== 'open');
      assert.equal(button.data.style, ButtonStyle.Secondary);
    }
  }
  for (const [a, b, playerMove] of [[2000, 1000, 'rock'], [1000, 1000, 'rock'], [0, 0, 'paper']]) {
    const result = resolveRobbery(round, playerMove, { user: { tasks: a, attendance: 0, total: a }, target: { tasks: b, attendance: 0, total: b } });
    const data = robberyPayload({ ...round, status: 'settled', playerMove, result, settledAt: at,
      protection: robberyProtection(round, result, at) }, {}, {}, at).embeds[0].toJSON();
    if (result.amount) assert.deepEqual([...data.description.matchAll(/<@(\d+)>/g)].map(m => m[1]), result.amount ? [result.toId, result.fromId] : [round.userId, round.targetId]);
    else { assert.match(data.description, /لم يتم تحويل(?: أو خصم)? أي عملة/); assert.notEqual(data.title, 'كفو زرفته'); }
  }
  const result = resolveRobbery(round, 'paper', { user: { tasks: 1000, attendance: 0, total: 1000 }, target: { tasks: 2000, attendance: 0, total: 2000 } });
  const legacy = robberyPayload({ ...round, status: 'settled', playerMove: 'paper', result, settledAt: at }).embeds[0].toJSON();
  assert.equal(legacy.fields.find(f => f.name === 'حماية الضحية').value, 'لا توجد حماية تلقائية لهذه النتيجة.');
});

test('wallet and task views disclose net robbery while activity and attendance caps stay separate', async () => {
  const f = await setup();
  await f.service.openRobbery({ id: roundId, userId: user, targetId: other, channelId, at }, () => true, min => min === 0 ? 0 : min === 40 ? 60 : 30);
  await f.service.settleRobbery({ id: roundId, userId: user, channelId, resolutionId: snowflake(at, 201), move: 'paper' });
  const state = await f.service.day(user);
  const rule = { enabled: true, points: 10, intervalMs: 600000, dailyCap: 500, version: 1 };
  const wallet = pointsEmbed({ all: await f.store.totals(user, 'all', at) }, state, rule, {}, at);
  const tasks = tasksEmbed(state, at, true, config, {}, rule);
  for (const embed of [wallet, tasks]) {
    const field = embed.data.fields.find(f => f.name.includes('صافي النهب'));
    assert.match(field.value, /\+600/); assert.ok(embed.length <= 6000);
  }
});
