import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { buildCommands, createHandler } from '../src/commands.js';
import { createTextCommands, commandsPanel } from '../src/experience-commands.js';
import { createBankHandler, bankTopPayload, bankMoney } from '../src/bank-commands.js';
import { bankMember } from '../src/bank.js';
import { pointsEmbed, tasksEmbed } from '../src/presentation.js';
import { fixture, at, user, other, actor, config, snowflake } from './helpers/shop-fixture.js';

const channelId = '100000000000000060';
const nextChannel = '100000000000000061';
const role = '100000000000000090';
const guildIcon = 'https://cdn.discordapp.com/icons/100000000000000001/test.png';
const avatar = 'https://cdn.discordapp.com/avatars/100000000000000010/avatar.png';
const visibleText = text => text.replace(/[\u200e\u200f\u2066-\u2069]/g, '');
const commandsDescription = '`-رصيدي` : عرض رصيدك البنكي\n'
  + '`-راتب` : استلام راتبك كل ساعة\n'
  + '`-توب البنك` : جميع المشاركين مع صفحات وتحديث\n'
  + '`-نهب` : محاولة نهب عضو\n'
  + '`-ارقام @عضو المبلغ` : اختر رقمًا أو رقمين؛ النهاية عشوائية بين 15 و25، ومن يأخذ آخر رقم يخسر مبلغ التحدّي\n'
  + '`-الغام @عضو المبلغ` : تحدّي لغم ضد عضو؛ من يختار اللغم يخسر مبلغ التحدّي\n'
  + '`-تشابه` : لعبة ذاكرة: 8 أزواج بمستوى عشوائي (سهل / متوسط / صعب)، الربح والخسارة 5%–10%، كل 20 دقيقة\n'
  + '`-سفينة @عضو المبلغ` : جهّز أسطولك سرًا؛ اختر الصف والعمود لإغراق السفن الست\n'
  + '`-مربعات @عضو المبلغ` : وصّل النقاط؛ من يكمل مربعًا يملكه ويلعب مجددًا، وصاحب أكثر مربعات يفوز\n'
  + '`-دوت @عضو المبلغ` : وصّل 4 أقراص للفوز؛ اختر العمود من الأزرار\n'
  + '`-زر @عضو المبلغ` : أول من يضغط الزر الأخضر يفوز بمبلغ خصمه\n'
  + '`-اكس @عضو المبلغ` : Infinite XO؛ لكل لاعب 3 علامات والرابعة تزيل الأقدم؛ الفائز يأخذ مبلغ خصمه\n'
  + '`-حماية` : عرض سعر ومدة الحماية ثم تأكيد الشراء\n'
  + '`-مهامي` : مهامك اليومية وتقدمك؛ تتجدد 12 ليلًا بتوقيت السعودية\n'
  + '`-جائزة` : الحصول على جائزة عشوائية كل ساعتين\n'
  + '`-الوان` : توحيد الألوان؛ ربح أو خسارة 5–10% كل 20 دقيقة\n'
  + '`-نرد` : النرد ضد البوت؛ ربح أو خسارة 5–10% كل 20 دقيقة\n'
  + '`-وقت` : عرض الوقت المتبقي للأوامر والحماية';
async function setup() {
  const f = await fixture(); await f.store.robbery.initialize(at);
  await f.seed(); await f.seed(other, 2000);
  f.documents.settings[0].bank.salaryAmount = 500;
  const channels = new Map([channelId, nextChannel].map(id => [id, { id, guildId: config.clanGuildId,
    type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }) }]));
  const ctx = { config, store: f.store, service: f.service, isMember: () => false,
    access: { roleId: null }, bot: { user: { id: actor }, channels: { fetch: async id => channels.get(id) } },
    status: () => ({ tracking: true }), onError: () => {} };
  return { ...f, ctx, channels, handler: createHandler(ctx) };
}
function interaction(name, patch = {}) {
  const calls = [], fetched = [];
  const call = method => async payload => { calls.push([method, payload]); };
  const guild = { id: config.clanGuildId, name: 'SNOW Clan', iconURL: () => guildIcon, members: { fetch: async options => {
    fetched.push(options); return { id: options.user, guild: { id: config.clanGuildId }, user: { bot: false } };
  } } };
  return { calls, fetched, id: snowflake(at, 500), user: { id: user, bot: false, username: 'big smoke', displayAvatarURL: () => avatar }, guild, guildId: config.clanGuildId,
    channelId, commandName: name, createdTimestamp: at,
    isChatInputCommand: () => true, isButton: () => false, isStringSelectMenu: () => false,
    options: { getUser: () => ({ id: other, bot: false }), getChannel: () => null, getInteger: () => null },
    reply: call('reply'), deferReply: call('deferReply'), editReply: call('editReply'), ...patch };
}

test('bank commands are available in the clan and settings expose one channel and a configurable salary', () => {
  const commands = buildCommands(); assert.equal(commands.length, 50);
  for (const name of ['اوامر', 'توب', 'راتب', 'جائزة', 'حماية', 'وقت', 'نهب', 'رصيدي', 'اعدادات_البنك']) {
    assert.equal(commands.filter(command => command.name === name).length, 1);
    assert.equal(commands.find(command => command.name === name).dm_permission, false);
  }
  const settings = commands.find(command => command.name === 'اعدادات_البنك');
  assert.equal(settings.default_member_permissions, null);
  assert.deepEqual(settings.options.map(o => o.name), ['الروم', 'الراتب', 'حالة_الراتب', 'حالة_النهب']);
  for (const option of settings.options.slice(2)) assert.deepEqual(option.choices.map(({ name, value }) => ({ name, value })),
    [{ name: '🟢 شغال', value: 'on' }, { name: '🔴 طافي', value: 'off' }]);
  assert.deepEqual(settings.options[0].channel_types, [ChannelType.GuildText]);
  assert.equal(settings.options[1].min_value, 0);
  const payload = commandsPanel();
  const panel = payload.embeds[0].toJSON();
  assert.equal(visibleText(panel.description), commandsDescription);
  assert.equal(panel.title, 'أوامر البنك'); assert.equal(panel.author.name, 'SNOW');
  assert.equal(panel.color, 0xffffff); assert.ok(Number.isFinite(Date.parse(panel.timestamp)));
  assert.equal(panel.image, undefined); assert.equal(panel.thumbnail, undefined);
  assert.deepEqual(payload.components, []);
  assert.equal(panel.footer, undefined); assert.equal(panel.fields, undefined);
  assert.doesNotMatch(panel.description, /ترتيبي|المتصدرين|اعدادات|لاحقًا/);
});

test('وقت slash posts an owner-bound launcher without reading private timings', async () => {
  const f = await setup(); await f.handler(interaction('راتب'));
  const before = structuredClone(f.documents), i = interaction('وقت'); await f.handler(i);
  assert.deepEqual(i.calls[0], ['deferReply', {}]);
  const payload = i.calls.at(-1)[1];
  assert.deepEqual(payload.embeds, []);
  assert.equal(payload.components[0].toJSON().components[0].custom_id, `bank-time:v1:${user}`);
  assert.deepEqual(payload.allowedMentions, { parse: [] }); assert.equal(payload.flags, undefined);
  assert.deepEqual(f.documents, before);
});

test('وقت text aliases use the author even when another member is mentioned', async () => {
  const f = await setup(), replies = [], ids = [], text = createTextCommands(f.handler, config);
  const read = f.service.commandTimes.bind(f.service);
  f.service.commandTimes = (...args) => { ids.push(args[0]); return read(...args); };
  const before = structuredClone(f.documents);
  for (const content of ['وقت', '!وقت', '-وقت', '- وقت', `وقت <@${other}>`]) {
    await text({ content, id: snowflake(at, 500), author: { id: user }, guildId: config.clanGuildId,
      channelId, createdTimestamp: at, mentions: { users: new Map([[other, { id: other }]]) },
      reply: async payload => { replies.push(payload); return { edit: async p => replies.push(p) }; } });
    assert.deepEqual(replies.at(-1).embeds, []);
    assert.equal(replies.at(-1).components[0].toJSON().components[0].custom_id, `bank-time:v1:${user}`);
  }
  assert.deepEqual(ids, []); assert.deepEqual(f.documents, before);
});

test('وقت refuses other channels, other guilds and bot accounts without reading member timings', async () => {
  const f = await setup(); let reads = 0; f.service.commandTimes = () => { reads++; };
  for (const patch of [{ channelId: nextChannel }, { guildId: config.arenaGuildId }, { user: { id: user, bot: true } }]) {
    const i = interaction('وقت', patch); await f.handler(i); assert.ok(i.calls.at(-1)[1].content);
  }
  assert.equal(reads, 0);
});

test('prize slash command awards once, publishes the result and explains its six-hour cooldown', async () => {
  const f = await setup();
  const claim = f.service.claimPrize.bind(f.service);
  f.service.claimPrize = (input, eligible) => claim(input, eligible, min => min === 0 ? 2 : 1500);
  const i = interaction('جائزة'); await f.handler(i);
  assert.deepEqual(i.calls[0], ['deferReply', {}]);
  const card = i.calls.at(-1)[1].embeds[0].toJSON();
  assert.equal(visibleText(card.description), '**💵 هدية عملة**\n\nتحصل على `$1.5K` فورًا');
  assert.equal(card.footer.text, 'SNOW Prize'); assert.equal(card.color, 0xffffff);
  assert.equal(card.author.name, 'big smoke'); assert.equal(card.author.icon_url, avatar);
  assert.equal(card.title, undefined); assert.equal(card.image, undefined); assert.equal(card.thumbnail, undefined);
  assert.equal((await f.service.balance(user)).total, 2500);
  const next = interaction('جائزة', { id: snowflake(at, 501) }); await f.handler(next);
  assert.match(next.calls.at(-1)[1].embeds[0].data.description, /جائزة جديدة/);
  assert.equal((await f.service.balance(user)).total, 2500);
});

test('prize text aliases route to the bank for the author and return a public result', async () => {
  const f = await setup(), replies = [];
  const text = createTextCommands(f.handler, config);
  const claim = f.service.claimPrize.bind(f.service);
  f.service.claimPrize = (input, eligible) => claim(input, eligible, min => min === 0 ? 1 : 70);
  for (const content of ['جائزة', '!جائزة', '- جائزة', 'جائزه', 'جايزه']) {
    await text({ content, id: snowflake(at, 500), author: { id: user }, guildId: config.clanGuildId,
      channelId, createdTimestamp: at, reply: async payload => { replies.push(payload); return { edit: async p => replies.push(p) }; } });
    const reply = replies.at(-1);
    assert.equal(reply.flags, undefined); assert.equal(reply.embeds[0].data.footer.text, 'SNOW Prize');
    assert.match(reply.embeds[0].data.description, /70%/);
  }
  assert.equal((await f.store.latestPrize(user)).prizeReceipts.length, 1);
  assert.equal((await f.service.balance(user)).total, 1000);
});

test('prize refuses other channels, other servers and bot accounts before awarding', async () => {
  const f = await setup();
  for (const patch of [{ channelId: nextChannel }, { guildId: config.arenaGuildId }, { user: { id: user, bot: true } }]) {
    const i = interaction('جائزة', patch); await f.handler(i);
    assert.ok(i.calls.at(-1)[1].content); assert.equal(await f.store.latestPrize(user), null);
  }
});

test('existing bank commands work publicly for an ordinary clan-server member with no Arena reward role', async () => {
  const f = await setup();
  for (const name of ['اوامر', 'توب', 'راتب', 'نهب', 'رصيدي']) {
    const i = interaction(name); await f.handler(i);
    assert.deepEqual(i.calls[0], ['deferReply', {}]);
    const payload = i.calls.at(-1)[1];
    assert.equal(payload.flags, undefined);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    if (name === 'رصيدي') {
      const card = payload.embeds[0].toJSON();
      assert.equal(payload.content, ''); assert.equal(visibleText(card.description), 'رصيدك البنكي');
      assert.deepEqual(card.fields.map(f => [f.name, visibleText(f.value)]), [['الرصيد', '`1.5K$`']]);
      assert.equal(card.author.name, 'big smoke'); assert.equal(card.author.icon_url, avatar);
      assert.equal(card.color, 0xffffff); assert.equal(card.footer.text, 'SNOW Pay');
      assert.equal(card.image, undefined); assert.equal(card.thumbnail, undefined); assert.equal(card.title, undefined);
      assert.deepEqual(payload.components, []);
    } else if (name === 'راتب') {
      assert.match(payload.embeds[0].data.description, /نزل لك راتبك/);
    } else if (name !== 'اوامر') {
      assert.ok(!payload.content);
      assert.match(payload.embeds[0].data.title, /البنك|تحدي النهب/);
    }
    if (name === 'اوامر') {
      assert.ok(payload.content && !payload.content.includes('\n'));
      assert.deepEqual(payload.components.flatMap(r => r.components.map(b => b.data.label)), ['توب البنك', 'اوامر', 'مهمتي', 'العاب', 'وقت', 'رصيدي']);
    }
    if (name === 'توب') {
      assert.equal(payload.embeds[0].data.thumbnail.url, guildIcon);
      assert.equal(payload.embeds[0].data.author.name, 'SNOW Clan');
      assert.match(payload.embeds[0].data.fields[0].value, /عشان توصل للمركز الأول/);
    }
    if (name === 'نهب') assert.deepEqual(i.fetched, [{ user: other, force: true }]);
  }
  assert.equal((await f.store.totals(user, 'all', at)).total, 1500);
});

test('switch-only settings save each command independently and اوامر keeps its reference wording', async () => {
  const f = await setup();
  const before = structuredClone(f.documents.days);
  let sequence = 600;
  for (const [salary, robbery] of [['off', 'on'], ['on', 'off'], ['off', 'off'], ['on', 'on']]) {
    const admin = interaction('اعدادات_البنك', { id: snowflake(at, sequence++), guild: { ownerId: user },
      options: { getChannel: () => null, getInteger: () => null,
        getString: name => name === 'حالة_الراتب' ? salary : robbery } });
    await f.handler(admin);
    assert.deepEqual(admin.calls[0], ['deferReply', { flags: MessageFlags.Ephemeral }]);
    const saved = (await f.store.settings()).bank;
    assert.equal(saved.salaryEnabled, salary === 'on'); assert.equal(saved.robberyEnabled, robbery === 'on');
    assert.equal(saved.salaryAmount, 500); assert.equal(saved.channelId, channelId);
    const i = interaction('اوامر'); await f.handler(i);
    const payload = i.calls.at(-1)[1];
    assert.equal(payload.components.flatMap(r => r.components).length, 6);
    assert.equal(payload.flags, undefined);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
  }
  assert.deepEqual(f.documents.days, before);
});

test('disabled slash and text commands report publicly and old robbery buttons cannot transfer money', async () => {
  const f = await setup();
  await f.handler(interaction('نهب'));
  await f.service.configureBank({ actorId: actor, operationId: snowflake(at, 601), salaryEnabled: false, robberyEnabled: false });
  const before = structuredClone(f.documents.days);
  for (const name of ['راتب', 'نهب']) {
    const i = interaction(name); await f.handler(i);
    assert.match(i.calls.at(-1)[1].content, /طافي/);
    assert.equal(i.calls.at(-1)[1].flags, undefined);
    assert.deepEqual(i.calls.at(-1)[1].components, []);
  }
  const base = interaction(); const replies = [], text = createTextCommands(f.handler, config);
  for (const content of ['راتب', '!راتب', '- راتب', `نهب <@${other}>`, `!نهب <@${other}>`, `- نهب <@${other}>`]) {
    await text({ id: snowflake(at, 602), content, author: base.user, guild: base.guild, guildId: config.clanGuildId,
      channelId, createdTimestamp: at, mentions: { users: new Map([[other, { id: other, bot: false }]]) },
      reply: async payload => { replies.push(payload); return { edit: async () => {} }; } });
    assert.match(replies.at(-1).content, /طافي/); assert.equal(replies.at(-1).flags, undefined);
  }
  assert.equal(replies.length, 6);
  const button = interaction(undefined, { customId: `clan-robbery:v1:${user}:${snowflake(at, 500)}:paper`,
    isButton: () => true, isChatInputCommand: () => false });
  button.deferUpdate = async () => button.calls.push(['deferUpdate']);
  button.followUp = async payload => button.calls.push(['followUp', payload]);
  await f.handler(button);
  assert.match(button.calls.at(-1)[1].content, /أمر نهب طافي/);
  assert.equal(button.calls.at(-1)[1].flags, MessageFlags.Ephemeral);
  assert.equal(f.documents.robbery_rounds.length, 1);
  assert.deepEqual(f.documents.days, before);
});

test('text bank commands including balance reply publicly to the originating message', async () => {
  const f = await setup(); const handle = createTextCommands(f.handler, config); const replies = [];
  let sequence = 520;
  const message = content => {
    const base = interaction(); const id = snowflake(at, sequence++);
    return { id, content, author: base.user, guild: base.guild, guildId: base.guildId, channelId, createdTimestamp: at,
      mentions: { users: new Map([[other, { id: other, bot: false }]]) },
      reply: async payload => { replies.push({ to: id, payload }); return { edit: async () => {} }; } };
  };
  for (const content of ['اوامر', 'أوامر', '!اوامر', '- اوامر', 'توب', '!توب', '- توب', 'راتب', '!راتب', `نهب <@${other}>`, `!نهب <@${other}>`, 'رصيدي', '!رصيدي', '- رصيدي']) {
    const m = message(content); await handle(m);
    const response = replies.at(-1); assert.equal(response.to, m.id);
    if (content.includes('رصيدي')) {
      assert.equal(response.payload.content, '');
      assert.equal(visibleText(response.payload.embeds[0].data.fields[0].value), '`1.5K$`');
      assert.equal(response.payload.embeds[0].data.author.name, 'big smoke');
      assert.equal(response.payload.embeds[0].data.author.icon_url, avatar);
      assert.deepEqual(response.payload.components, []);
    } else if (content === `!نهب <@${other}>`) assert.match(response.payload.content, /تم منعك من النهب.*5 دقائق/);
    else if (/[اأ]وامر/.test(content)) assert.equal(response.payload.components.flatMap(r => r.components).length, 6);
    else assert.ok(response.payload.embeds[0]);
    if (content.includes('توب')) assert.equal(response.payload.embeds[0].data.thumbnail.url, guildIcon);
    assert.equal(response.payload.flags, undefined);
    assert.deepEqual(response.payload.allowedMentions, { parse: [], repliedUser: false });
  }
  assert.equal(replies.length, 14);
  assert.equal((await f.store.totals(user, 'all', at)).total, 1500);
  const count = replies.length;
  for (const patch of [{ author: { id: user, bot: true } }, { webhookId: actor }, { guildId: config.arenaGuildId }]) {
    await handle({ ...message('راتب'), ...patch });
  }
  assert.equal(replies.length, count);
});

test('all five commands outside the bank return a public pointer without posting a panel, paying or creating a challenge', async () => {
  const f = await setup();
  for (const name of ['اوامر', 'توب', 'راتب', 'نهب', 'رصيدي']) {
    const i = interaction(name, { channelId: nextChannel }); await f.handler(i);
    assert.deepEqual(i.calls[0], ['deferReply', {}]);
    assert.ok(i.calls.at(-1)[1].content.includes(`<#${channelId}>`));
    assert.equal(i.calls.at(-1)[1].flags, undefined);
    assert.deepEqual(i.calls.at(-1)[1].embeds, []);
    assert.deepEqual(i.calls.at(-1)[1].components, []);
  }
  assert.equal(f.documents.robbery_rounds.length, 0);
  assert.equal((await f.store.totals(user, 'all', at)).total, 1000);
});

test('balance buttons and legacy points show only the clicking member balance and never create a daily quest record', async () => {
  const f = await setup();
  for (const customId of ['clan-panel:v1:points', `clan-view:v1:${other}:points`]) {
    const i = interaction(undefined, { user: { id: other, bot: false }, customId,
      isChatInputCommand: () => false, isButton: () => true,
      deferUpdate: async () => i.calls.push(['deferUpdate']) });
    await f.handler(i);
    assert.equal(visibleText(i.calls.at(-1)[1].embeds[0].data.fields[0].value), '`2K$`');
    assert.deepEqual(i.calls.at(-1)[1].components, []);
  }
  const forged = interaction(undefined, { customId: `clan-view:v1:${other}:points`, isChatInputCommand: () => false, isButton: () => true });
  await f.handler(forged); assert.match(forged.calls[0][1].content, /عضو آخر/);
  const before = structuredClone(f.documents.days);
  for (const name of ['رصيدي', 'نقاطي']) {
    const i = interaction(name, { user: { id: actor, bot: false } }); await f.handler(i);
    assert.equal(visibleText(i.calls.at(-1)[1].embeds[0].data.fields[0].value), '`0$`');
    assert.deepEqual(i.calls.at(-1)[1].components, []);
  }
  assert.deepEqual(f.documents.days, before);
});

test('bank configuration is management-only, works outside the bank and honors delegated role revocation', async () => {
  const f = await setup();
  const options = { getChannel: () => ({ id: nextChannel }), getInteger: () => 750, getString: () => 'off' };
  const denied = interaction('اعدادات_البنك', { options }); await f.handler(denied);
  assert.equal(denied.calls.length, 1); assert.equal(denied.calls[0][1].flags, MessageFlags.Ephemeral);
  assert.match(denied.calls[0][1].content, /إدارة/);
  f.ctx.access.roleId = role;
  const admin = interaction('اعدادات_البنك', { options, channelId: actor, member: { roles: [role] } });
  await f.handler(admin); assert.deepEqual(admin.calls[0], ['deferReply', { flags: MessageFlags.Ephemeral }]);
  assert.equal((await f.store.settings()).bank.channelId, nextChannel);
  assert.equal((await f.store.settings()).bank.salaryAmount, 750);
  assert.equal((await f.store.settings()).bank.salaryEnabled, false);
  assert.equal((await f.store.settings()).bank.robberyEnabled, false);
  assert.match(admin.calls.at(-1)[1].embeds[0].data.description, /حالة راتب: 🔴 طافي\nحالة نهب: 🔴 طافي/);
  f.ctx.access.roleId = null;
  const revoked = interaction('اعدادات_البنك', { options, member: { roles: [role] } }); await f.handler(revoked);
  assert.equal(revoked.calls.length, 1); assert.match(revoked.calls[0][1].content, /إدارة/);
  const native = interaction('اعدادات_البنك', { memberPermissions: { has: flag => flag === PermissionFlagsBits.ManageGuild } });
  await f.handler(native); assert.ok(native.calls.at(-1)[1].embeds[0].data.description.includes(nextChannel));
});

test('configuration validates destination type, server and send permissions and accepts zero salary explicitly', async () => {
  const f = await setup();
  for (const patch of [{ type: ChannelType.GuildVoice }, { guildId: config.arenaGuildId },
    { permissionsFor: () => ({ has: () => false }) }]) {
    const original = f.channels.get(nextChannel); f.channels.set(nextChannel, { ...original, ...patch });
    const i = interaction('اعدادات_البنك', { guild: { ownerId: user },
      options: { getChannel: () => ({ id: nextChannel }), getInteger: () => 750 } });
    await f.handler(i); assert.ok(i.calls.at(-1)[1].content.startsWith('❌'));
    assert.equal((await f.store.settings()).bank.channelId, channelId);
    f.channels.set(nextChannel, original);
  }
  const i = interaction('اعدادات_البنك', { guild: { ownerId: user },
    options: { getChannel: () => null, getInteger: () => 0 } });
  await f.handler(i); assert.equal((await f.store.settings()).bank.salaryAmount, 0);
  const salary = interaction('راتب'); await f.handler(salary);
  assert.match(salary.calls.at(-1)[1].content, /أوقفت صرفه/);
});

test('default membership check validates the target in the clan guild and treats lookup failures as failures', async () => {
  const i = interaction('نهب'); assert.equal(await bankMember(i, config, user), true);
  assert.equal(await bankMember(i, config, other), true);
  assert.equal(await bankMember({ ...i, guildId: config.arenaGuildId }, config, user), false);
  assert.equal(await bankMember({ ...i, user: { id: user, bot: true } }, config, user), false);
  for (const member of [{ id: other, guild: { id: config.arenaGuildId }, user: { bot: false } },
    { id: other, guild: { id: config.clanGuildId }, user: { bot: true } }, null]) {
    i.guild.members.fetch = async () => member; assert.equal(await bankMember(i, config, other), false);
  }
  i.guild.members.fetch = async () => { throw Object.assign(new Error('not a member'), { code: 10007 }); };
  assert.equal(await bankMember(i, config, other), false);
  i.guild.members.fetch = async () => { throw new Error('network unavailable'); };
  await assert.rejects(bankMember(i, config, other), /تعذر التحقق/);
});

test('a departed target or temporary membership lookup failure cannot start or settle robbery', async () => {
  const f = await setup();
  for (const code of [10007, 500]) {
    const i = interaction('نهب');
    i.guild.members.fetch = async () => { throw Object.assign(new Error('failed'), { code }); };
    await f.handler(i); assert.ok(i.calls.at(-1)[1].content.startsWith('❌'));
    assert.equal(f.documents.robbery_rounds.length, 0);
  }
  await f.handler(interaction('نهب'));
  const move = f.documents.robbery_rounds[0].game === 'mine' ? 'mine:0:1' : 'paper';
  const customId = `clan-robbery:v1:${user}:${snowflake(at, 500)}:${move}`;
  const i = interaction(undefined, { customId, isChatInputCommand: () => false, isButton: () => true });
  i.guild.members.fetch = async () => { throw Object.assign(new Error('left'), { code: 10007 }); };
  i.deferUpdate = async () => i.calls.push(['deferUpdate']);
  i.followUp = async p => i.calls.push(['followUp', p]);
  await f.handler(i); assert.match(i.calls.at(-1)[1].content, /عضوية/);
  assert.equal((await f.store.totals(user, 'all', at)).total, 1000);
});

test('bank embed follows the reference with the server icon, boxed balance and next-rank gap', () => {
  const appearance = { name: 'SNOW', imageUrl: 'https://example.com/banner.png', thumbnailUrl: 'https://example.com/icon.png' };
  const rows = Array.from({ length: 10 }, (_, i) => ({ _id: String(BigInt(user) + BigInt(i)), total: 2100000 - i * 100000 }));
  const guild = { name: 'SNOW Clan', iconURL: options => {
    assert.deepEqual(options, { extension: 'png', size: 256 }); return guildIcon;
  } };
  const view = { rows, self: { position: 14, value: 935890 }, nextPosition: 13, gap: 71430, at };
  const payload = bankTopPayload(view, appearance, guild);
  const embed = payload.embeds[0]; const data = embed.toJSON();
  assert.equal(data.title, 'توب البنك'); assert.equal(data.color, 0xffffff);
  assert.equal(data.author.name, guild.name); assert.equal(data.author.icon_url, guildIcon);
  assert.equal(data.thumbnail.url, guildIcon); assert.equal(data.footer.icon_url, guildIcon);
  assert.equal(data.footer.text, guild.name); assert.equal(data.image, undefined);
  assert.equal(data.description.split('\n').length, 10);
  assert.ok(data.description.startsWith(`\`#1\` <@${user}> 💵 **2.1M$**`));
  assert.equal(data.fields[0].name, 'ترتيبك');
  assert.equal(data.fields[0].value, '\u200f`#14` - رصيدك: `$935.89K`\nمتبقي `$71.43K` عشان توصل للمركز الثالث عشر');
  const rounded = bankTopPayload({ ...view, gap: 71431 }, appearance, guild);
  assert.match(rounded.embeds[0].data.fields[0].value, /متبقي `\$71\.44K`/); // Never display less than the required gap.
  assert.doesNotMatch(data.fields[0].value, /<@|المركز العاشر/);
  const tenth = bankTopPayload({ ...view, self: { position: 11, value: 935890 }, nextPosition: 10 }, appearance, guild);
  assert.match(tenth.embeds[0].data.fields[0].value, /عشان توصل للمركز العاشر$/);
  const first = bankTopPayload({ ...view, self: { position: 1, value: 935890 }, nextPosition: null, gap: 0 }, appearance);
  assert.match(first.embeds[0].data.fields[0].value, /أنت في المركز الأول/);
  assert.doesNotMatch(first.embeds[0].data.fields[0].value, /متبقي/);
  assert.equal(first.embeds[0].data.thumbnail, undefined);
  assert.ok(embed.length < 6000); assert.ok(data.fields[0].value.length <= 1024);
  assert.equal(payload.flags, undefined); assert.deepEqual(payload.components, []);
  assert.equal(bankMoney(4000), '4K$'); assert.equal(bankMoney(0), '0$');
});

test('salary card shows credit and balance in reference order, and cooldown still reports the next claim time', async () => {
  const f = await setup(); const i = interaction('راتب', { member: { displayName: 'اسم العضو بالسيرفر' } }); await f.handler(i);
  const card = i.calls.at(-1)[1].embeds[0].toJSON();
  assert.equal(visibleText(card.description), 'نزل لك راتبك\n\n**الوظيفة:** عضو الكلان');
  assert.deepEqual(card.fields.map(f => [f.name, visibleText(f.value)]), [['الراتب', '`500$`'], ['رصيدك', '`1.5K$`']]);
  assert.ok(card.fields.every(f => !f.inline));
  assert.equal(card.author.name, 'اسم العضو بالسيرفر'); assert.equal(card.author.icon_url, avatar);
  assert.equal(card.color, 0xffffff); assert.equal(card.footer.text, 'SNOW Pay');
  assert.equal(card.title, undefined); assert.equal(card.image, undefined); assert.equal(card.thumbnail, undefined);
  const next = interaction('راتب', { id: snowflake(at, 501) }); await f.handler(next);
  assert.match(next.calls.at(-1)[1].embeds[0].data.description, /استلمت راتبك بالفعل/);
  assert.ok(next.calls.at(-1)[1].embeds[0].data.description.includes(`<t:${Math.ceil((at + 3600000) / 1000)}:R>`));
  const state = await f.service.day(user);
  const rule = { enabled: true, points: 10, intervalMs: 600000, dailyCap: 500, version: 1 };
  for (const embed of [pointsEmbed({ all: await f.store.totals(user, 'all', at) }, state, rule, {}, at), tasksEmbed(state, at, true, config, {}, rule)]) {
    const field = embed.data.fields.find(field => field.name.includes('رواتب اليوم')); assert.match(field.value, /500/);
  }
});

test('protection text shows confirmation without charging; only the author can confirm and retries debit once', async () => {
  const f = await setup(); f.documents.days.find(d => d.userId === user).points.tasks = 25000;
  const text = createTextCommands(f.handler, config), replies = [];
  await text({ content: 'حماية', id: snowflake(at, 500), author: { id: user }, guildId: config.clanGuildId,
    channelId, createdTimestamp: at, reply: async payload => { replies.push(payload); } });
  const customId = replies[0].components[0].toJSON().components[0].custom_id;
  assert.ok(customId.length <= 100);
  assert.equal((await f.service.balance(user)).total, 25000);
  const confirm = (patch = {}) => interaction(undefined, { customId, isButton: () => true,
    isChatInputCommand: () => false, deferUpdate: async () => {}, ...patch });
  const stranger = confirm({ user: { id: other, bot: false } }); await f.handler(stranger);
  assert.match(stranger.calls.at(-1)[1].content, /صاحب طلب/);
  const clicks = [confirm(), confirm()]; await Promise.all(clicks.map(i => f.handler(i)));
  assert.equal((await f.service.balance(user)).total, 15000);
  assert.equal(f.documents.protection_purchases.length, 1);
  for (const i of clicks) assert.equal(i.calls.at(-1)[1].components[0].toJSON().components[0].disabled, true);
  assert.equal((await f.store.robbery.activeProtection(user, at)).expiresAt, at + 10800000);
});

test('protection slash command is management only and saves its settings without buying', async () => {
  const f = await setup();
  const denied = interaction('حماية'); await f.handler(denied);
  assert.match(denied.calls.at(-1)[1].content, /صلاحية|مسموح|الإدارة/);
  const admin = interaction('حماية', { memberPermissions: { has: () => true },
    options: { getInteger: name => name === 'السعر' ? 2500 : 60, getBoolean: () => false } });
  await f.handler(admin);
  assert.equal((await f.store.settings()).bank.protectionPrice, 2500);
  assert.equal((await f.store.settings()).bank.protectionMinutes, 60);
  assert.equal((await f.store.settings()).bank.protectionStack, false);
  assert.equal(f.documents.protection_purchases.length, 0);
});

test('protection refuses other channels, other servers and bots before debiting', async () => {
  const f = await setup(); f.documents.days.find(d => d.userId === user).points.tasks = 10000;
  for (const patch of [{ channelId: nextChannel }, { guildId: config.arenaGuildId }, { user: { id: user, bot: true } }]) {
    const i = interaction('حماية', { textCommand: true, ...patch }); await f.handler(i);
    assert.ok(i.calls.at(-1)[1].content);
  }
  assert.equal((await f.service.balance(user)).total, 10000);
  assert.equal(f.documents.protection_purchases.length, 0);
});


test('protection confirmation disables at 30 seconds and a late click cannot debit', async () => {
  const f = await setup(); f.documents.days.find(d => d.userId === user).points.tasks = 25000;
  let expire, delay;
  const handler = createBankHandler({ ...f.ctx, scheduleProtectionExpiry: (fn, ms) => { expire = fn; delay = ms; } });
  const request = interaction('حماية', { textCommand: true }); await handler(request);
  const customId = request.calls.at(-1)[1].components[0].toJSON().components[0].custom_id;
  assert.equal(delay, 30000);
  f.service.clock = () => at + 30000; await expire();
  assert.equal(request.calls.at(-1)[1].components[0].toJSON().components[0].disabled, true);
  const click = interaction(undefined, { customId, isButton: () => true, deferUpdate: async () => {} });
  await handler(click);
  assert.match(click.calls.at(-1)[1].content, /انتهت صلاحية/);
  assert.equal((await f.service.balance(user)).total, 25000);
  assert.equal(f.documents.protection_purchases.length, 0);
});

test('confirmation before 30 seconds succeeds and expiry cannot overwrite its success button', async () => {
  const f = await setup(); f.documents.days.find(d => d.userId === user).points.tasks = 25000;
  let expire;
  const handler = createBankHandler({ ...f.ctx, scheduleProtectionExpiry: fn => { expire = fn; } });
  const request = interaction('حماية', { textCommand: true }); await handler(request);
  const customId = request.calls.at(-1)[1].components[0].toJSON().components[0].custom_id;
  f.service.clock = () => at + 29999;
  const click = interaction(undefined, { customId, isButton: () => true, deferUpdate: async () => {} }); await handler(click);
  assert.equal((await f.service.balance(user)).total, 15000);
  const editsBefore = request.calls.length;
  f.service.clock = () => at + 30000; await expire();
  assert.equal(request.calls.length, editsBefore);
  assert.equal(click.calls.at(-1)[1].components[0].toJSON().components[0].label, 'تم شراء الحماية');
});
