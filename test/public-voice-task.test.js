import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyFixture, dailyConfig as c } from './helpers/daily-fixture.js';
import { at, user, other } from './helpers/shop-fixture.js';
import { PUBLIC_VOICE_TASK_ID as id, PUBLIC_VOICE_CATEGORY_IDS as categories,
  publicVoiceTemplate } from '../src/public-voice-task.js';
import { createDay, validateTemplate, eligibleVoice, applyVoice } from '../src/domain.js';
import { VoiceTracker } from '../src/voice.js';
import { readVoiceSnapshot, trackedVoiceCategories, trackedVoiceChannels } from '../src/voice-channels.js';
import { tasksEmbed } from '../src/presentation.js';
import { dayKey, nextReset } from '../src/time.js';

const minute = 60000, room = '100000000000000070', secondRoom = '100000000000000071';
const task = state => state.tasks.find(t => t.id === id);
const voice = (from, to, extra = {}) => ({ guildId: c.arenaGuildId, userId: user, eligible: true,
  channelId: room, categoryId: categories[0], from, to, ...extra });
async function setup(options) {
  const f = await dailyFixture(options);
  await f.store.initializePublicVoiceTask(f.now());
  const restart = f.restart;
  f.restart = async () => { const next = await restart(); await next.store.initializePublicVoiceTask(f.now()); return next; };
  return f;
}
async function spend(f, minutes, extra = {}, service = f.service) {
  for (let n = 0; n < minutes; n++) {
    const from = f.now(); f.time(from + minute);
    await service.voice(voice(from, f.now(), extra), c.attendance);
  }
}

test('installation adds a seventh daily slot with the exact categories, 40-minute target and 12000 reward', async () => {
  const f = await setup(), state = await f.service.day(user);
  assert.equal(state.tasks.length, 7);
  assert.equal(state.tasks.filter(t => t.id === id).length, 1);
  assert.deepEqual([task(state).target, task(state).repeat, task(state).reward], [40, 1, 12000]);
  assert.deepEqual(task(state).categoryIds, ['1040414663676014623', '1050377755822395402', '766953290122395659']);
  assert.equal(validateTemplate(publicVoiceTemplate(at)).channelId, null);
  assert.throws(() => validateTemplate({ ...publicVoiceTemplate(at), repeat: 2 }), /مرة واحدة/);
  assert.throws(() => validateTemplate({ ...publicVoiceTemplate(at), categoryIds: ['bad-id'] }), /كاتقوريات/);
  assert.throws(() => validateTemplate({ ...publicVoiceTemplate(at), channelId: room }), /كاتقوريات/);
});

test('upgrading an existing day keeps every old task and balance, and does not backfill clan time', async () => {
  const f = await dailyFixture();
  await spend(f, 10, { channelId: c.voiceChannelId, categoryId: undefined });
  const before = await f.service.day(user);
  await f.store.initializePublicVoiceTask(f.now());
  const after = await f.service.day(user);
  assert.deepEqual(after.tasks.slice(0, 6), before.tasks);
  assert.deepEqual(after.points, before.points);
  assert.deepEqual(after.activity, before.activity);
  assert.equal(task(after).progress, 0);
  await spend(f, 1);
  assert.equal(task(await f.service.day(user)).progress, minute);
});

test('the reserved slot remains present when additional random or personal tasks exist', async () => {
  const f = await setup(), templates = await f.store.templates();
  const many = [...templates, ...Array.from({ length: 30 }, (_, n) => ({ ...templates[0], id: `extra-${n}`, forUser: user }))];
  for (let n = 0; n < 20; n++) {
    const state = createDay(c.clanGuildId, user, `2026-10-${String(n + 1).padStart(2, '0')}`, many, at);
    assert.equal(state.tasks.filter(t => t.id === id).length, 1);
    assert.ok(state.tasks.some(t => t.type === 'games'));
  }
});

test('time accumulates across all three categories and pays exactly once without adding clan attendance or rank', async () => {
  const f = await setup();
  for (const [index, minutes] of [14, 13, 13].entries()) {
    await spend(f, minutes, { categoryId: categories[index], channelId: index % 2 ? secondRoom : room });
  }
  await spend(f, 45);
  const state = await f.service.day(user);
  assert.deepEqual([task(state).progress, task(state).completed, state.points.tasks], [40 * minute, 1, 12000]);
  assert.equal(state.points.attendance, 0);
  assert.equal(state.activity?.voiceMs || 0, 0);
  assert.equal(state.tasks.find(t => t.id === 'daily-voice-180').progress, 0);
  assert.equal(state.completionLog.filter(e => e.taskId === id).length, 1);
  await f.store.notifications.collect(f.now());
  assert.equal(f.documents.member_notifications.filter(e => e.kind === 'daily_completed' && e.data.taskId === id).length, 1);
});

test('39 minutes and 59.999 seconds do not pay; the final millisecond completes the task', async () => {
  const f = await setup(); await spend(f, 39);
  let from = f.now(); f.time(from + minute - 1);
  await f.service.voice(voice(from, f.now()), c.attendance);
  assert.equal((await f.service.day(user)).points.tasks, 0);
  from = f.now(); f.time(from + 1);
  await f.service.voice(voice(from, f.now()), c.attendance);
  assert.equal((await f.service.day(user)).points.tasks, 12000);
});

test('wrong categories, missing category evidence, another guild and ineligible members cannot earn the task', async () => {
  const f = await setup();
  for (const extra of [{ categoryId: '100000000000000099' }, { categoryId: undefined },
    { guildId: c.clanGuildId }, { eligible: false }]) await spend(f, 40, extra);
  const state = await f.service.day(user);
  assert.equal(task(state).progress, 0); assert.equal(state.points.tasks, 0);
});

test('a clan room in an allowed category advances both missions once and keeps the original attendance rate', async () => {
  const f = await setup(); await spend(f, 40, { channelId: c.voiceChannelId });
  const state = await f.service.day(user);
  assert.equal(task(state).completed, 1);
  assert.equal(state.tasks.find(t => t.id === 'daily-voice-180').progress, 40 * minute);
  assert.equal(state.activity.voiceMs, 40 * minute);
  assert.equal(state.points.attendance, 40);
  assert.equal(state.points.tasks, 12000);
});

test('duplicate and overlapping deliveries cannot accelerate progress or repeat payment', async () => {
  const f = await setup();
  for (let n = 0; n < 40; n++) {
    const from = f.now(); f.time(from + minute);
    const event = voice(from, f.now());
    await Promise.all([f.service.voice(event, c.attendance), f.service.voice(event, c.attendance),
      f.service.voice({ ...event, from: from + 1000 }, c.attendance)]);
  }
  const state = await f.service.day(user);
  assert.equal(state.points.tasks, 12000); assert.equal(task(state).progress, 40 * minute);
  assert.equal(state.completionLog.filter(e => e.taskId === id).length, 1);
});

test('restart retains partial progress and completion, and cannot award the completed task again', async () => {
  const f = await setup(); await spend(f, 20);
  f.time(f.now() + 10 * minute);
  const reopened = await f.restart();
  assert.equal(task(await reopened.service.day(user)).progress, 20 * minute);
  await spend(f, 20, { categoryId: categories[2] }, reopened.service);
  const again = await f.restart();
  await spend(f, 40, {}, again.service);
  const state = await again.service.day(user);
  assert.equal(state.points.tasks, 12000); assert.equal(task(state).completed, 1);
});

test('Saudi midnight creates a new daily counter, splits intervals, and preserves earned money', async () => {
  const midnight = nextReset(at), f = await setup({ start: midnight - 41 * minute });
  await spend(f, 40);
  f.time(midnight + 15000);
  await f.service.voice(voice(midnight - 15000, midnight + 15000), c.attendance);
  const yesterday = await f.service.day(user, midnight - 1), today = await f.service.day(user);
  assert.equal(yesterday.points.tasks, 12000);
  assert.equal(task(today).progress, 15000); assert.equal(task(today).completed, 0);
  await spend(f, 40);
  assert.equal((await f.service.balance(user)).total, 24000);
});

for (const phase of ['before', 'after']) test(`lost ${phase}-commit completion acknowledgement retries without a second reward or notice`, async () => {
  const f = await setup(); await spend(f, 39);
  const from = f.now(); f.time(from + minute); const event = voice(from, f.now());
  let failed = false;
  f.intercept(e => {
    if (!failed && e.name === 'days' && e.method === 'replaceOne' && e.phase === phase && e.args[1].points.tasks === 12000) {
      failed = true; throw new Error('lost acknowledgement');
    }
  });
  await assert.rejects(f.service.voice(event, c.attendance)); f.intercept(() => {});
  const reopened = await f.restart();
  await reopened.service.voice(event, c.attendance); await reopened.service.voice(event, c.attendance);
  const state = await reopened.service.day(user);
  assert.equal(state.points.tasks, 12000);
  assert.equal(state.completionLog.filter(e => e.taskId === id).length, 1);
  await reopened.store.notifications.collect(f.now());
  assert.equal(f.documents.member_notifications.filter(e => e.kind === 'daily_completed' && e.data.taskId === id).length, 1);
});

for (const phase of ['before', 'after']) test(`an interrupted ${phase}-commit installation resumes at the same boundary`, async () => {
  const f = await dailyFixture(); let failed = false;
  f.intercept(e => {
    if (!failed && e.name === 'templates' && e.method === 'updateOne' && e.phase === phase && e.args[0].id === id) {
      failed = true; throw new Error('install interrupted');
    }
  });
  await assert.rejects(f.store.initializePublicVoiceTask(at)); f.intercept(() => {});
  assert.equal(await f.store.initializePublicVoiceTask(at + minute), true);
  const template = (await f.store.templates()).find(t => t.id === id);
  assert.equal(template.createdAt, at);
  assert.equal((await f.store.settings()).publicVoiceTaskInstalledAt, at);
  assert.equal(await f.store.initializePublicVoiceTask(at + 2 * minute), false);
  assert.equal((await f.store.templates()).filter(t => t.id === id).length, 1);
});

test('ordinary restarts preserve catalog edits while existing assignments keep their saved category scope', async () => {
  const f = await setup(); const original = await f.service.day(user);
  Object.assign(f.documents.templates.find(t => t.id === id), { reward: 13000, enabled: false, categoryIds: ['100000000000000088'] });
  const reopened = await f.restart();
  assert.deepEqual(task(await reopened.service.day(user)), task(original));
  const changed = (await reopened.store.templates()).find(t => t.id === id);
  assert.deepEqual([changed.reward, changed.enabled], [13000, false]);
  const observed = [...await reopened.store.templates(), ...await reopened.store.activeTaskSnapshots(f.now())];
  assert.ok(trackedVoiceCategories(observed).has(categories[0]));
  f.time(nextReset(at));
  assert.equal(task(await reopened.service.day(user)), undefined);
});

test('no pre-installation day or already observed voice can be retroactively credited', async () => {
  const f = await setup();
  assert.equal(task(await f.service.day(user, at - minute)), undefined);
  const state = createDay(c.clanGuildId, user, dayKey(at), [publicVoiceTemplate(at + 30000)], at + 30000);
  applyVoice(state, voice(at, at + minute), c.attendance, c);
  assert.equal(task(state).progress, 30000);
});

test('the new task participates in the existing task boost without affecting attendance', async () => {
  const f = await setup();
  f.store.taskBoostAt = async () => ({ id: 'boost', multiplier: 2, startsAt: at, endsAt: at + 60 * minute });
  await spend(f, 40);
  const state = await f.service.day(user);
  assert.equal(state.points.tasks, 24000); assert.equal(state.points.attendance, 0);
  assert.deepEqual([state.completionLog[0].basePoints, state.completionLog[0].multiplier], [12000, 2]);
});

test('the task card shows progress and all category IDs without a null channel', async () => {
  const f = await setup(); await spend(f, 17);
  const card = tasksEmbed(await f.service.day(user), f.now(), true, c).toJSON();
  const field = card.fields.find(field => field.name.includes('40 دقيقة'));
  assert.ok(field); assert.ok(card.description.includes('0 / 7'));
  for (const category of categories) assert.ok(field.value.includes(`<#${category}>`));
  assert.match(field.value, /مرة واحدة يوميًا/);
  assert.ok(!JSON.stringify(card).includes('<#null>'));
  assert.ok(JSON.stringify(card).length < 6000);
});

test('وقت reports the extra slot without creating a day or performing any writes', async () => {
  const f = await setup(), before = structuredClone(f.documents);
  f.intercept(e => { if (['insertOne', 'updateOne', 'replaceOne', 'deleteOne'].includes(e.method)) assert.fail('read-only view wrote state'); });
  const view = await f.service.commandTimes(other, f.documents.settings[0].bank.channelId, true);
  assert.equal(view.quest.total, 7); assert.equal(view.quest.completed, 0);
  assert.deepEqual(f.documents, before);
});

function liveGuild() {
  const channels = new Map();
  const makeChannel = (id, parentId, visible = true) => ({ id, parentId, permissionsFor: () => ({ has: () => visible }) });
  channels.set(room, makeChannel(room, categories[0]));
  channels.set(secondRoom, makeChannel(secondRoom, categories[1], false));
  const states = new Map([[user, { id: user, channelId: room, member: { user: { bot: false } } }],
    [other, { id: other, channelId: secondRoom, member: { user: { bot: false } } }]]);
  const guild = { id: c.arenaGuildId, channels: { cache: channels }, voiceStates: { cache: states }, afkChannelId: null };
  const source = { user: { id: 'reader' }, users: { cache: new Map() } };
  const membership = { updateArena() {}, has: memberId => memberId === user };
  return { guild, source, membership, channels, states, makeChannel };
}

test('category discovery includes new child rooms, excludes hidden rooms, and follows channel moves', () => {
  const f = liveGuild(), templates = [publicVoiceTemplate(at)];
  const tracked = trackedVoiceChannels(c, c.attendance, templates), categorySet = trackedVoiceCategories(templates);
  const snapshot = () => readVoiceSnapshot(f.guild, f.source, f.membership, tracked, categorySet);
  assert.deepEqual(snapshot().map(s => s.channelId), [room]);
  assert.equal(snapshot()[0].categoryId, categories[0]);
  const created = '100000000000000073';
  f.channels.set(created, f.makeChannel(created, categories[2])); f.states.get(user).channelId = created;
  assert.equal(snapshot()[0].categoryId, categories[2]);
  f.channels.get(created).parentId = '100000000000000099';
  assert.deepEqual(snapshot(), []);
});

test('existing member, bot, mute/deafen, AFK and stage suppression rules apply to public voice rooms', () => {
  const person = { userId: user, channelId: room, categoryId: categories[0], bot: false };
  const members = new Set([user]);
  for (const patch of [{ userId: other }, { bot: true }, { muted: true }, { deafened: true }, { afk: true }, { suppressed: true }]) {
    assert.equal(eligibleVoice([{ ...person, ...patch }], { minPeople: 1, ignoreMuted: true, ignoreDeafened: true }, members).length, 0);
  }
  assert.equal(eligibleVoice([person], { minPeople: 2 }, members).length, 0);
  assert.equal(eligibleVoice([{ ...person, muted: true, deafened: true }], { minPeople: 1 }, members).length, 1);
});

test('the tracker freezes category evidence per interval, retains earned time and excludes disconnected time', async () => {
  const f = await setup(), guild = liveGuild();
  const categoriesToTrack = trackedVoiceCategories(await f.store.templates());
  const snapshot = () => readVoiceSnapshot(guild.guild, guild.source, guild.membership, new Set(), categoriesToTrack);
  const tracker = new VoiceTracker({ service: f.service, guildId: c.arenaGuildId });
  const transition = () => tracker.transition(snapshot(), c.attendance, new Set([user]), f.now());
  await transition();
  f.time(at + minute);
  guild.channels.get(room).parentId = '100000000000000099';
  await transition(); // The old snapshot's minute still belongs to the allowed category.
  f.time(at + 2 * minute); await tracker.tick(f.now());
  assert.equal(task(await f.service.day(user)).progress, minute);
  guild.channels.get(room).parentId = categories[2]; await transition();
  f.time(at + 3 * minute); await tracker.tick(f.now()); tracker.drop();
  f.time(at + 20 * minute); await transition();
  f.time(at + 21 * minute); await tracker.tick(f.now());
  assert.equal(task(await f.service.day(user)).progress, 3 * minute);
});
