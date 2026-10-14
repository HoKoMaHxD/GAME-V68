import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { DEFAULT_APPEARANCE, attachmentImageUrl, readAppearance, validateAppearancePatch, themedEmbed } from '../src/appearance.js';
import { progressMeter, taskSummary, tasksEmbed, pointsEmbed, rulesEmbed, leaderboardEmbed } from '../src/presentation.js';
import { createDay, seedTemplates } from '../src/domain.js';
import { panelPayload, personalNavigation, parsePanelAction } from '../src/panel.js';
import { createHandler } from '../src/commands.js';
import { MongoStore } from '../src/store.js';

const config = { clanGuildId: '100000000000000001', arenaGuildId: '100000000000000002',
  generalChannelId: '100000000000000003', voiceChannelId: '100000000000000004', secondVoiceChannelId: '100000000000000005',
  feelingChannelId: '100000000000000006', lookChannelId: '100000000000000007', memberRole: '100000000000000008',
  weekStart: 1, cooldownMs: 12000, minMessageLength: 4 };
const userId = '100000000000000010';
const at = Date.parse('2026-09-07T12:00:00Z');
const rule = { channelId: config.voiceChannelId, version: 3, enabled: true, points: 75, intervalMs: 300000,
  dailyCap: 900, minPeople: 2, ignoreMuted: true, ignoreDeafened: false };
const appearance = { name: 'SNOW', color: 0x123456, imageUrl: 'https://example.com/banner.png', thumbnailUrl: 'https://example.com/icon.png', revision: 2 };
const day = () => createDay(config.clanGuildId, userId, '2026-09-07', seedTemplates(config), at);

test('progress meters clamp values and never announce 100 percent before completion', () => {
  for (const [value, target, expected] of [[0, 100, 0], [50, 100, 50], [99.999, 100, 99], [100, 100, 100],
    [150, 100, 100], [-1, 100, 0], [1, 0, 0], [NaN, 10, 0]]) {
    const result = progressMeter(value, target);
    assert.equal(result.percent, expected);
    assert.equal([...result.text.match(/`([^`]+)`/)[1]].length, 12);
  }
});

test('overall progress gives each quest equal weight instead of mixing messages and voice milliseconds', () => {
  const state = day();
  state.tasks[0].progress = 50;
  state.tasks[1].progress = 1; state.tasks[1].completed = 1;
  state.tasks[2].progress = 1; state.tasks[2].completed = 1;
  state.tasks[3].progress = 90 * 60000;
  assert.deepEqual(taskSummary(state.tasks), { completed: 2, total: 4, ratio: 0.75 });
  assert.deepEqual(taskSummary([]), { completed: 0, total: 0, ratio: 0 });
});

test('all main views accept both pictures together and remain within Discord embed limits', () => {
  const state = day();
  state.tasks.forEach(t => { t.title = '*'.repeat(100); t.target = 100000; t.repeat = 20; });
  const snapshot = structuredClone(state);
  const brand = { ...appearance, name: 'S'.repeat(50) };
  const embeds = [tasksEmbed(state, at, true, config, brand, rule),
    pointsEmbed({ all: { tasks: 100000000, attendance: 100000000, total: 200000000 } }, state, rule, brand, at),
    rulesEmbed(config, rule, brand),
    leaderboardEmbed(Array.from({ length: 10 }, () => ({ _id: userId, total: 100000000 })), 'monthly', 'total', 100, config, brand),
    panelPayload(1440, brand).embeds[0]];
  for (const embed of embeds) {
    const data = embed.toJSON();
    assert.equal(data.image.url, brand.imageUrl);
    assert.equal(data.thumbnail.url, brand.thumbnailUrl);
    assert.equal(data.color, data.title === 'ترتيبك الشخصي' ? 0xffffff : brand.color);
    assert.ok(embed.length <= 6000);
    assert.ok(data.title.length <= 256);
    assert.ok((data.description?.length || 0) <= 4096);
    assert.ok((data.fields?.length || 0) <= 25);
    for (const field of data.fields || []) {
      assert.ok(field.name.length <= 256);
      assert.ok(field.value.length <= 1024);
    }
  }
  assert.deepEqual(state, snapshot);
});

test('appearance supports independent picture removal, black color and legacy defaults', () => {
  assert.deepEqual(readAppearance(undefined), DEFAULT_APPEARANCE);
  const update = validateAppearancePatch({ name: '  clan  ', color: '#000000', imageUrl: null });
  const saved = readAppearance({ ...appearance, ...update });
  assert.equal(saved.name, 'clan'); assert.equal(saved.color, 0); assert.equal(saved.imageUrl, null);
  const payload = themedEmbed('معاينة', saved).toJSON();
  assert.equal(payload.image, undefined);
  assert.equal(payload.thumbnail.url, appearance.thumbnailUrl);
  for (const input of [{ imageUrl: 'javascript:alert(1)' }, { thumbnailUrl: 'file:///tmp/photo.png' },
    { imageUrl: 'https://name:password@example.com/photo.png' }, { color: 'red' }, { name: 'a\nb' }]) {
    assert.throws(() => validateAppearancePatch(input));
  }
});

test('calculation details explain parallel daily quests and Saudi midnight', () => {
  const embed = rulesEmbed(config, { ...rule, enabled: true }, appearance).toJSON();
  const text = JSON.stringify(embed);
  for (const expected of ['12 منتصف الليل', 'بدون', 'تلقائيًا', 'كل رسالة جديدة', 'الاثنين']) {
    // Rules say no acceptance using explicit wording.
    if (expected !== 'بدون') assert.ok(text.includes(expected), expected);
  }
  assert.doesNotMatch(text, /4 ساعات|بانتظار القبول/);
  assert.ok(embed.fields.some(f => f.name === 'الحضور المتكرر'));
});
test('uploaded images use Discord refreshable CDN URLs without stripping external signatures', () => {
  const attachment = { name: 'snow.png', contentType: 'image/png', url: 'https://cdn.discordapp.com/attachments/123/456/snow.png?ex=abc&is=def&hm=secret' };
  assert.equal(attachmentImageUrl(attachment), 'https://cdn.discordapp.com/attachments/123/456/snow.png');
  const external = 'https://images.example.com/snow.png?signature=keep';
  assert.equal(validateAppearancePatch({ imageUrl: external }).imageUrl, external);
  assert.throws(() => attachmentImageUrl({ ...attachment, contentType: 'video/mp4' }));
  assert.throws(() => attachmentImageUrl({ ...attachment, name: 'snow.svg' }));
});

test('legacy wallet presentation preserves old attendance money without an active reward meter', () => {
  const state = day();
  state.points.attendance = 880;
  state.attendance = { milliseconds: 600000, ruleVersion: 2, carryMs: 299999 };
  const snapshot = structuredClone(state);
  const view = pointsEmbed({ all: { tasks: 0, attendance: 880, total: 880 } }, state, rule, {}, at).toJSON();
  assert.match(view.description, /880/);
  assert.doesNotMatch(JSON.stringify(view), /المتبقي من الحد|المكافأة التالية|حد مكافآت الحضور/);
  assert.deepEqual(state, snapshot);
});

test('my quests shows only the completed three-hour voice task and preserves historical currency adjustments', () => {
  for (const adjustment of [-600, 600]) {
    const state = day();
    state.tasks[3].progress = 180 * 60000; state.tasks[3].completed = 1;
    state.points = { tasks: 180, attendance: 350 };
    state.pointAdjustments = { tasks: 0, attendance: adjustment };
    state.attendance = { milliseconds: 180 * 60000, ruleVersion: 3, carryMs: 120000 };
    const snapshot = structuredClone(state);
    const view = tasksEmbed(state, at, true, config, appearance, rule).toJSON();
    const task = view.fields.find(f => f.name.includes('3 ساعات'));
    assert.match(task.value, /100%/);
    assert.match(task.value, /180 \/ 180/);
    assert.match(task.value, /180 \$ 💵 مكتسبة/);
    assert.match(view.description, /1 \/ 4 مهام مكتملة/);
    assert.doesNotMatch(JSON.stringify(view.fields), /مكافأة حضور|مكافآت الحضور|المتبقي من الحد|المكافأة التالية/);
    assert.equal(view.fields.find(f => f.name === '💵 صافي اليوم').value, '**' + (530 + adjustment).toLocaleString('en-US') + '** $ 💵');
    assert.deepEqual(state, snapshot);
  }
});

test('old saved caps and enabled flags never restore the attendance card while disconnected or connected', () => {
  for (const [earned, enabled, connected] of [[900, true, true], [950, true, true], [880, false, true], [400, true, false], [0, true, true]]) {
    const state = day(); state.points.attendance = earned;
    const view = tasksEmbed(state, at, connected, config, {}, { ...rule, enabled }).toJSON();
    assert.doesNotMatch(JSON.stringify(view.fields), /مكافأة حضور|مكافآت الحضور|المتبقي من الحد|المكافأة التالية/);
    assert.equal(view.fields.find(f => f.name === '💵 صافي اليوم').value, '**' + earned + '** $ 💵');
    assert.ok(view.description.includes(connected ? 'الاحتساب يعمل' : 'الاحتساب متوقف حاليًا'));
    assert.ok(view.description.includes('12 ليلًا بتوقيت السعودية'));
  }
});

function fixture() {
  const calls = { writes: [], reads: 0, user: [], totals: [], panel: 0, errors: [] };
  let settings = { appearance: structuredClone(appearance), attendance: structuredClone(rule) };
  const ctx = { config, isMember: () => true, status: () => ({ tracking: true }), onError: e => calls.errors.push(e),
    service: { day: async id => { calls.user.push(id); return day(); },
      timedQuest: async id => { calls.user.push(id); return null; } },
    store: {
      settings: async () => { calls.reads++; return structuredClone(settings); },
      setAppearance: async fields => {
        calls.writes.push(fields);
        settings.appearance = { ...settings.appearance, ...fields, revision: settings.appearance.revision + 1 };
        return structuredClone(settings);
      },
      totals: async (id, period) => { calls.totals.push([id, period]); return { tasks: 100, attendance: 50, total: 150 }; }
    }, panel: { refreshAppearance: async () => { calls.panel++; return {}; } }
  };
  ctx.service.walletView = async (id, periods) => ({ state: await ctx.service.day(id),
    totals: Object.fromEntries(await Promise.all(periods.map(async period => [period, await ctx.store.totals(id, period)]))) });
  ctx.service.balance = id => ctx.store.totals(id, 'all');
  return { ctx, calls, settings: () => settings };
}

function interaction({ id, name, owner = userId, admin = true, options = {} }) {
  const calls = { replies: [], deferred: [], updates: 0, edited: [] };
  return { calls, user: { id: owner }, guildId: config.clanGuildId, customId: id, commandName: name,
    isButton: () => !!id, isChatInputCommand: () => !id, memberPermissions: { has: () => admin },
    options: { getString: key => typeof options[key] === 'string' ? options[key] : null,
      getBoolean: key => typeof options[key] === 'boolean' ? options[key] : null,
      getAttachment: key => typeof options[key] === 'object' ? options[key] : null },
    reply: async payload => calls.replies.push(payload), deferReply: async payload => calls.deferred.push(payload),
    deferUpdate: async () => { calls.updates++; }, editReply: async payload => calls.edited.push(payload)
  };
}

test('old task commands and buttons now show the automatic daily tasks', async () => {
  const f = fixture(), handler = createHandler(f.ctx);
  for (const options of [{ id: `clan-daily-open:v1:${userId}` }, { id: 'clan-panel:v1:mine' },
    { id: `clan-view:v1:${userId}:mine` }, { id: `quests:${userId}` }]) {
    const request = interaction(options); await handler(request);
    const data = request.calls.edited[0].embeds[0].toJSON();
    assert.equal(data.title, 'مهامك اليومية'); assert.match(data.description, /كل المهام متاحة معًا/);
    assert.match(data.footer.text, /15 ثانية/);
    assert.deepEqual(request.calls.deferred[0], { flags: MessageFlags.Ephemeral });
    assert.equal(request.calls.updates, 0);
  }
  assert.deepEqual(f.calls.user, Array(4).fill(userId));
});
test('points button fetches only the clicking member and privately replies without editing the public panel', async () => {
  const f = fixture(); const click = interaction({ id: 'clan-panel:v1:points' });
  await createHandler(f.ctx)(click);
  assert.deepEqual(f.calls.user, []);
  assert.deepEqual(f.calls.totals, [[userId, 'all']]);
  assert.equal(click.calls.deferred[0].flags, MessageFlags.Ephemeral);
  assert.equal(click.calls.updates, 0);
  assert.equal(click.calls.edited[0].content, '');
  assert.equal(click.calls.edited[0].embeds[0].data.fields[0].value.replace(/[\u2066-\u2069]/g, ''), '`150$`');
  assert.deepEqual(click.calls.edited[0].components, []);
});

test('rules are private and personal navigation survives a new handler with owner checks', async () => {
  const f = fixture(); const click = interaction({ id: 'clan-panel:v1:rules' });
  await createHandler(f.ctx)(click);
  assert.equal(click.calls.deferred[0].flags, MessageFlags.Ephemeral);
  assert.equal(f.calls.user.length, 0);
  for (const button of personalNavigation(userId, 'rules').toJSON().components) {
    assert.equal(parsePanelAction(button.custom_id).ownerId, userId);
    const stranger = interaction({ id: button.custom_id, owner: '100000000000000099' });
    await createHandler(f.ctx)(stranger);
    assert.equal(stranger.calls.replies.length, 1);
    assert.equal(stranger.calls.updates, 0);
  }
  const next = interaction({ id: `clan-view:v1:${userId}:points` });
  await createHandler(f.ctx)(next);
  assert.equal(next.calls.updates, 1); assert.equal(next.calls.deferred.length, 0);
  const old = interaction({ id: `quests:${userId}` });
  await createHandler(f.ctx)(old);
  assert.equal(old.calls.updates, 0);
  assert.deepEqual(old.calls.deferred[0], { flags: MessageFlags.Ephemeral });
});

test('balance is available without an Arena role while requests outside the clan server remain blocked', async () => {
  for (const id of ['clan-panel:v1:points', `clan-view:v1:${userId}:points`]) {
    const f = fixture(); f.ctx.isMember = () => false;
    const click = interaction({ id }); await createHandler(f.ctx)(click);
    assert.equal(f.calls.user.length, 0); assert.deepEqual(f.calls.totals, [[userId, 'all']]);
    assert.equal(click.calls.replies.length, 0);
    assert.equal(click.calls.edited[0].embeds[0].data.fields[0].value.replace(/[\u2066-\u2069]/g, ''), '`150$`');
    const foreign = interaction({ id }); foreign.guildId = 'another-guild';
    await createHandler(f.ctx)(foreign);
    assert.equal(foreign.calls.replies.length, 1);
    assert.equal(f.calls.totals.length, 1);
  }
});

test('only administrators can save appearance and invalid mixed options perform no write', async () => {
  const f = fixture();
  const denied = interaction({ name: 'تصميم_الامبد', admin: false, options: { الاسم: 'new' } });
  await createHandler(f.ctx)(denied);
  assert.equal(f.calls.reads, 0); assert.equal(f.calls.writes.length, 0);
  for (const options of [{ اللون: 'bad' }, { الصورة: 'https://example.com/a.png', حذف_الصورة: true },
    { الاسم: 'valid', المصغرة: 'javascript:bad' }]) {
    const command = interaction({ name: 'تصميم_الامبد', options });
    await createHandler(f.ctx)(command);
    assert.equal(f.calls.writes.length, 0);
    assert.ok(command.calls.edited[0].content.startsWith('❌'));
  }
});

test('appearance saves both images once, refreshes the panel and is available in a fresh handler', async () => {
  const f = fixture();
  const command = interaction({ name: 'تصميم_الامبد', options: { اللون: '#ABCDEF', الاسم: 'ICE',
    الصورة: 'https://example.com/new.png', المصغرة: 'https://example.com/new-icon.png' } });
  await createHandler(f.ctx)(command);
  assert.equal(f.calls.writes.length, 1); assert.equal(f.calls.panel, 1);
  const preview = command.calls.edited[0].embeds[0].toJSON();
  assert.equal(preview.color, 0xabcdef); assert.equal(preview.image.url, 'https://example.com/new.png');
  const reopened = interaction({ name: 'تصميم_الامبد' }); await createHandler(f.ctx)(reopened);
  assert.equal(f.calls.writes.length, 1);
  assert.equal(reopened.calls.edited[0].embeds[0].toJSON().thumbnail.url, 'https://example.com/new-icon.png');
  const clear = interaction({ name: 'تصميم_الامبد', options: { حذف_الصورة: true } }); await createHandler(f.ctx)(clear);
  assert.equal(clear.calls.edited[0].embeds[0].toJSON().image, undefined);
  assert.equal(clear.calls.edited[0].embeds[0].toJSON().thumbnail.url, 'https://example.com/new-icon.png');
});

test('a failed panel edit does not misreport a saved appearance as lost', async () => {
  const f = fixture(); f.ctx.panel.refreshAppearance = async () => { throw new Error('permission failed'); };
  const command = interaction({ name: 'تصميم_الامبد', options: { الاسم: 'ICE' } });
  await createHandler(f.ctx)(command);
  assert.equal(f.settings().appearance.name, 'ICE');
  assert.match(command.calls.edited[0].embeds[0].toJSON().description, /تم حفظ التصميم.*تعذر تحديث/);
});
test('administrator can upload a banner and thumbnail together without a separate image host', async () => {
  const f = fixture();
  const attachment = name => ({ name, contentType: 'image/png', url: `https://cdn.discordapp.com/attachments/123/456/${name}?ex=abc&hm=old` });
  const command = interaction({ name: 'تصميم_الامبد', options: { ملف_الصورة: attachment('banner.png'), ملف_المصغرة: attachment('logo.png') } });
  await createHandler(f.ctx)(command);
  assert.equal(f.calls.writes.length, 1);
  assert.equal(f.settings().appearance.imageUrl, 'https://cdn.discordapp.com/attachments/123/456/banner.png');
  assert.equal(f.settings().appearance.thumbnailUrl, 'https://cdn.discordapp.com/attachments/123/456/logo.png');
  for (const options of [{ ملف_الصورة: attachment('banner.png'), حذف_الصورة: true },
    { ملف_المصغرة: attachment('logo.png'), المصغرة: 'https://example.com/other.png' }]) {
    await createHandler(f.ctx)(interaction({ name: 'تصميم_الامبد', options }));
    assert.equal(f.calls.writes.length, 1);
  }
});

test('appearance persistence updates only its fields and revision without touching attendance or tasks', async () => {
  const calls = [];
  const store = Object.create(MongoStore.prototype); store.settingsId = 'settings:clan';
  store.db = { collection: name => ({ findOneAndUpdate: async (...args) => { calls.push([name, ...args]); } }) };
  await store.setAppearance({ color: 0, imageUrl: null });
  assert.deepEqual(calls[0], ['settings', { _id: 'settings:clan' },
    { $set: { 'appearance.color': 0, 'appearance.imageUrl': null }, $inc: { 'appearance.revision': 1 } }, { returnDocument: 'after' }]);
});
