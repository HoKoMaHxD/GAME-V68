import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, PermissionFlagsBits, ApplicationCommandOptionType, ButtonStyle } from 'discord.js';
import { buildCommands, createHandler } from '../src/commands.js';

const clan = '100000000000000001';
const admin = '100000000000000090';
const member = '100000000000000010';
const otherAdmin = '100000000000000091';
const start = Date.parse('2026-09-07T12:00:00Z');
function fixture() {
  let now = start;
  const calls = { previews: [], targets: [], resets: [], errors: [] };
  const ctx = { config: { clanGuildId: clan }, clock: () => now, isMember: () => false,
    store: { settings: async () => ({ appearance: { name: 'SNOW', thumbnailUrl: 'https://example.com/clan.png' } }) },
    service: {
      resetPreview: async (userId, target) => { calls.previews.push(userId); calls.targets.push(target); return { members: userId ? 1 : 17, days: 40, tasks: 630, attendance: 250, chat: 1234, voice: 120000 }; },
      reset: async request => { calls.resets.push(request); return { cutoff: now, deletedDays: request.target === 'all' ? 40 : 0, changedDays: 40 }; }
    }, onError: error => calls.errors.push(error) };
  return { ctx, calls, handler: createHandler(ctx), advance: ms => { now += ms; } };
}
function interaction({ commandName = 'ريست_الجميع', customId, guildId = clan, userId = admin, permitted = true, target = member, section = 'bank' } = {}) {
  const calls = [];
  return { calls, commandName, customId, guildId, user: { id: userId },
    isButton: () => !!customId, isChatInputCommand: () => !customId,
    memberPermissions: { has: permission => permitted && permission === PermissionFlagsBits.ManageGuild },
    options: { getUser: name => { assert.equal(name, 'العضو'); return { id: target }; },
      getString: name => { assert.equal(name, 'القسم'); return section; } },
    reply: async payload => { calls.push({ type: 'reply', payload }); },
    deferReply: async payload => { calls.push({ type: 'deferReply', payload }); },
    deferUpdate: async () => { calls.push({ type: 'deferUpdate' }); },
    editReply: async payload => { calls.push({ type: 'editReply', payload }); }
  };
}
async function preview(f, options = {}) {
  const i = interaction(options); await f.handler(i);
  const payload = i.calls.find(c => c.type === 'editReply').payload;
  const buttons = payload.components[0].toJSON().components;
  return { interaction: i, payload, confirm: buttons[0].custom_id, cancel: buttons[1].custom_id, buttons };
}

test('both reset commands are guild-only administration commands with a required user selector for member reset', () => {
  const commands = buildCommands().filter(c => c.name.startsWith('ريست_'));
  assert.equal(commands.length, 2);
  for (const command of commands) {
    assert.equal(command.default_member_permissions, null);
    assert.equal(command.dm_permission, false);
  }
  const option = commands.find(c => c.name === 'ريست_عضو').options[0];
  assert.equal(option.name, 'العضو'); assert.equal(option.type, ApplicationCommandOptionType.User); assert.equal(option.required, true);
  const section = commands.find(c => c.name === 'ريست_الجميع').options[0];
  assert.equal(section.name, 'القسم'); assert.equal(section.required, true); assert.equal(section.type, ApplicationCommandOptionType.String);
  assert.deepEqual(section.choices.map(({ name, value }) => ({ name, value })), [{ name: 'توب البنك', value: 'bank' }, { name: 'توب الشات والفويس', value: 'activity' }, { name: 'القسمين معًا (تصفير شامل والمهام)', value: 'all' }]);
});

test('preview is private, shows both point categories and the irreversible scope, and never changes data', async () => {
  const f = fixture(); const p = await preview(f);
  assert.equal(p.interaction.calls[0].payload.flags, MessageFlags.Ephemeral);
  assert.deepEqual(f.calls.previews, [null]); assert.deepEqual(f.calls.resets, []);
  const embed = p.payload.embeds[0].toJSON();
  assert.match(embed.description, /لا يمكن التراجع/);
  assert.match(embed.description, /الأسبوعي والشهري والشامل/);
  assert.ok(embed.fields.some(field => field.value === '630'));
  assert.ok(embed.fields.some(field => field.value === '250'));
  assert.equal(embed.thumbnail.url, 'https://example.com/clan.png');
  assert.ok(p.payload.embeds[0].length < 6000);
  assert.equal(p.buttons[0].style, ButtonStyle.Danger);
  assert.ok(p.buttons.every(button => button.custom_id.length <= 100));
  assert.deepEqual(p.payload.allowedMentions, { parse: [] });
});

test('unauthorized commands and commands from another guild never query or mutate balances', async () => {
  const f = fixture();
  for (const options of [{ permitted: false }, { guildId: 'another-clan' }, { guildId: null }]) {
    const i = interaction(options); await f.handler(i);
    assert.equal(i.calls[0].type, 'reply'); assert.equal(i.calls[0].payload.flags, MessageFlags.Ephemeral);
  }
  assert.deepEqual(f.calls.previews, []); assert.deepEqual(f.calls.resets, []);
});

test('member reset uses the selected member even when the administrator is not an eligible clan member', async () => {
  const f = fixture(); const p = await preview(f, { commandName: 'ريست_عضو' });
  assert.deepEqual(f.calls.previews, [member]);
  assert.ok(p.payload.embeds[0].toJSON().fields.some(field => field.value.includes(member)));
  const confirm = interaction({ customId: p.confirm }); await f.handler(confirm);
  assert.equal(f.calls.resets.length, 1);
  assert.equal(f.calls.resets[0].userId, member); assert.equal(f.calls.resets[0].actorId, admin);
  assert.equal(confirm.calls[0].type, 'deferUpdate');
  assert.deepEqual(confirm.calls.at(-1).payload.components, []);
  assert.match(confirm.calls.at(-1).payload.embeds[0].toJSON().title, /بنجاح/);
});

test('everyone confirmation resets the whole clan exactly once even with simultaneous double clicks', async () => {
  const f = fixture(); const p = await preview(f);
  const first = interaction({ customId: p.confirm }); const second = interaction({ customId: p.confirm });
  await Promise.all([f.handler(first), f.handler(second)]);
  assert.equal(f.calls.resets.length, 1); assert.equal(f.calls.resets[0].userId, null);
  assert.equal(f.calls.resets[0].target, 'bank');
  assert.ok([first, second].some(i => i.calls.some(c => c.type === 'reply' && c.payload.content.includes('استُخدم'))));
});

test('another administrator cannot confirm or cancel the owner’s request, even with its exact button ID', async () => {
  const f = fixture(); const p = await preview(f);
  for (const customId of [p.confirm, p.cancel]) {
    const stolen = interaction({ customId, userId: otherAdmin }); await f.handler(stolen);
    assert.match(stolen.calls[0].payload.content, /لصاحب الأمر/);
  }
  assert.equal(f.calls.resets.length, 0);
  await f.handler(interaction({ customId: p.confirm }));
  assert.equal(f.calls.resets.length, 1);
});

test('permission loss and a different guild are rechecked at confirmation time', async () => {
  const f = fixture(); const p = await preview(f);
  for (const options of [{ permitted: false }, { guildId: 'other-clan' }]) {
    const i = interaction({ customId: p.confirm, ...options }); await f.handler(i);
    assert.equal(i.calls[0].type, 'reply');
  }
  assert.equal(f.calls.resets.length, 0);
});

test('cancellation consumes the confirmation without resetting data', async () => {
  const f = fixture(); const p = await preview(f);
  const cancel = interaction({ customId: p.cancel }); await f.handler(cancel);
  assert.deepEqual(cancel.calls.at(-1).payload.components, []);
  assert.match(cancel.calls.at(-1).payload.embeds[0].toJSON().title, /إلغاء/);
  await f.handler(interaction({ customId: p.confirm }));
  assert.equal(f.calls.resets.length, 0);
});

test('confirmation expires after two minutes and a process restart invalidates any outstanding request', async () => {
  const f = fixture(); const p = await preview(f);
  f.advance(120000);
  const expired = interaction({ customId: p.confirm }); await f.handler(expired);
  assert.match(expired.calls[0].payload.content, /انتهت صلاحية/);
  const next = await preview(f);
  const restarted = createHandler(f.ctx);
  const old = interaction({ customId: next.confirm }); await restarted(old);
  assert.match(old.calls[0].payload.content, /انتهت صلاحية/);
  assert.equal(f.calls.resets.length, 0);
});

test('a newer preview replaces this admin’s previous scope, so the older confirmation cannot delete unintended data', async () => {
  const f = fixture(); const all = await preview(f); const selected = await preview(f, { commandName: 'ريست_عضو' });
  await f.handler(interaction({ customId: all.confirm }));
  assert.equal(f.calls.resets.length, 0);
  await f.handler(interaction({ customId: selected.confirm }));
  assert.equal(f.calls.resets[0].userId, member);
});

test('failed reset consumes its button and reports failure without showing a success embed', async () => {
  const f = fixture(); const p = await preview(f);
  f.ctx.service.reset = async () => { throw new Error('لم يتأكد اكتمال الريست. أُوقف الاحتساب مؤقتًا.'); };
  const confirm = interaction({ customId: p.confirm }); await f.handler(confirm);
  assert.equal(f.calls.errors.length, 1);
  assert.match(confirm.calls.at(-1).payload.content, /لم يتأكد/);
  assert.deepEqual(confirm.calls.at(-1).payload.embeds, []);
  assert.deepEqual(confirm.calls.at(-1).payload.components, []);
  const again = interaction({ customId: p.confirm }); await f.handler(again);
  assert.match(again.calls[0].payload.content, /استُخدم/);
});

test('malformed or unknown reset buttons never execute a reset', async () => {
  const f = fixture();
  for (const customId of ['clan-reset:v1:everyone:confirm', 'clan-reset:v1:00000000-0000-0000-0000-000000000000:confirm']) {
    const i = interaction({ customId }); await f.handler(i);
    assert.match(i.calls[0].payload.content, /انتهت صلاحية/);
  }
  assert.equal(f.calls.resets.length, 0);
});

test('activity selection displays its counters and the confirmation retains the selected target', async () => {
  const f = fixture(); const p = await preview(f, { section: 'activity' });
  const embed = p.payload.embeds[0].toJSON();
  assert.deepEqual(f.calls.targets, ['activity']);
  assert.ok(embed.fields.some(field => field.name === 'القسم المطلوب' && field.value === 'توب الشات والفويس'));
  assert.ok(embed.fields.some(field => field.name === 'رسائل الشات' && field.value === '1,234'));
  assert.ok(embed.fields.some(field => field.name === 'وقت الفويس' && field.value === '120 ثانية'));
  assert.ok(!embed.fields.some(field => field.name === 'عملة المهام'));
  const confirm = interaction({ customId: p.confirm, section: 'bank' }); await f.handler(confirm);
  assert.equal(f.calls.resets[0].target, 'activity');
  assert.match(confirm.calls.at(-1).payload.embeds[0].toJSON().description, /توب الشات والفويس/);
});

test('missing or unsupported global selection cannot silently perform a full reset', async () => {
  const f = fixture();
  for (const section of [null, 'invalid']) {
    const i = interaction({ section }); await f.handler(i);
    assert.match(i.calls.at(-1).payload.content, /اختر القسم/);
  }
  assert.deepEqual(f.calls.previews, []); assert.deepEqual(f.calls.resets, []);
});

test('changing from bank to activity expires the old bank confirmation', async () => {
  const f = fixture(); const bank = await preview(f, { section: 'bank' });
  const activity = await preview(f, { section: 'activity' });
  await f.handler(interaction({ customId: bank.confirm }));
  assert.equal(f.calls.resets.length, 0);
  await f.handler(interaction({ customId: activity.confirm }));
  assert.equal(f.calls.resets.length, 1); assert.equal(f.calls.resets[0].target, 'activity');
});

 test('everyone can confirm both sections with a full task reset', async () => {
  const f = fixture(), p = await preview(f, { section: 'all' });
  assert.match(p.payload.embeds[0].data.description, /تقدم المهام/);
  await f.handler(interaction({ customId: p.confirm }));
  assert.equal(f.calls.resets[0].target, 'all');
  assert.equal(f.calls.resets[0].userId, null);
 });

test('full reset stays accessible while paused, uses the full controller and shows progress before completion', async () => {
  const f = fixture(); f.ctx.service.paused = true;
  let started = 0;
  f.ctx.fullReset = { start: async input => {
    started++; assert.equal(input.userId, null); assert.equal(input.target, 'all');
    return { cutoff: start, deletedDays: 40 };
  } };
  f.handler = createHandler(f.ctx);
  const p = await preview(f, { section: 'all' });
  assert.match(p.payload.embeds[0].data.description, /الجولات والمزايدات المفتوحة/);
  const confirm = interaction({ customId: p.confirm }); await f.handler(confirm);
  assert.equal(started, 1); assert.equal(f.calls.resets.length, 0);
  assert.ok(confirm.calls.some(c => c.payload?.content?.includes('جارٍ الريست')));
  assert.match(confirm.calls.at(-1).payload.embeds[0].data.description, /تشغيل البوت تلقائيًا/);
});

test('while a full reset is pending, another reset returns clear status without starting or previewing work', async () => {
  const f = fixture(); f.ctx.service.resetting = true; f.ctx.service.paused = true;
  const i = interaction({ section: 'all' }); await f.handler(i);
  assert.match(i.calls[0].payload.content, /جارٍ الريست الشامل/); assert.equal(f.calls.previews.length, 0);
});
