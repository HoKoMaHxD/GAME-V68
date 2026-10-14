import test from 'node:test';
import { countVoice } from '../src/activity.js';
import assert from 'node:assert/strict';
import { fixture, config as base, at, user, other, actor, snowflake, request } from './helpers/shop-fixture.js';
import { applyMessage, applyVoice, createDay } from '../src/domain.js';
import { activityView, voiceTime, rankPanel } from '../src/activity-views.js';
import { dayKey, nextReset } from '../src/time.js';
import { VoiceTracker } from '../src/voice.js';

export const settings = { ...base, generalChannelId: '100000000000000040', clanChatChannelId: '100000000000000041',
  voiceChannelId: '100000000000000042', secondVoiceChannelId: '100000000000000043', thirdVoiceChannelId: '100000000000000044' };
export const attendance = { enabled: true, channelId: settings.voiceChannelId, version: 1,
  dailyCap: 10, points: 10, intervalMs: 60000, minPeople: 1, ignoreMuted: false, ignoreDeafened: true };
export async function setup() {
  const f = await fixture(); let now = at;
  f.store.config = { ...settings }; f.service.config = f.store.config;
  f.service.clock = () => now;
  await f.store.initializeActivity(at);
  return { ...f, config: f.store.config, time: value => { now = value; } };
}
const message = (id, extra = {}) => ({ id: snowflake(at, id), at, userId: user, guildId: settings.arenaGuildId,
  channelId: settings.clanChatChannelId, eligible: true, ...extra });

test('activity migration is repeatable and preserves old money, products, appearance and permissions', async () => {
  const f = await fixture(); f.store.config = { ...settings };
  await f.seed(user, 1000, 250); const before = structuredClone(f.documents.days);
  f.documents.settings[0].botPermissions = { roleId: actor };
  const products = structuredClone(f.documents.shops);
  assert.equal(await f.store.initializeActivity(at), at);
  assert.equal(await f.store.initializeActivity(at + 10000), at);
  assert.deepEqual(f.documents.days, before); assert.deepEqual(f.documents.shops, products);
  assert.equal(f.documents.settings[0].botPermissions.roleId, actor);
  assert.equal(f.documents.settings[0].appearance.name, 'SNOW');
  assert.equal((await f.store.totals(user, 'all', at)).total, 1250);
  assert.deepEqual(await f.store.activityRanking('all', 'chat', at), []);
  assert.deepEqual(await f.store.activityRanking('all', 'voice', at), []);
});

test('clan activity continues past a daily task cap; duplicates and edits never pay twice', async () => {
  const f = await setup(); f.time(at + 1000);
  f.service.templateCache = [{ id: 'clan', title: 'clan', type: 'messages', channelId: settings.clanChatChannelId,
    target: 50, reward: 50, repeat: 1, enabled: true }];
  await Promise.all(Array.from({ length: 100 }, (_, i) => f.service.message(message(100 - i))));
  await f.service.message(message(5));
  await f.service.message(message(6, { mediaOnly: true, hasMedia: true }));
  const day = await f.service.day(user);
  assert.equal(day.activity.clanMessages, 100); assert.equal(day.tasks[0].completed, 1);
  assert.equal(day.points.tasks, 50); assert.equal(day.completionLog.length, 1);
});

test('chat ranking excludes other channels, bots, webhooks, system, outsiders and pre-activation messages', async () => {
  const f = await setup();
  for (const [i, extra] of [{ channelId: settings.generalChannelId }, { channelId: settings.voiceChannelId },
    { bot: true }, { system: true }, { webhook: true }, { eligible: false }, { guildId: 'other' },
    { at: at - 1 }, { mediaOnly: true }].entries()) await f.service.message(message(i, extra));
  assert.deepEqual(await f.store.activityRanking('all', 'chat', at), []);
  await f.service.message(message(50, { content: '' }));
  assert.equal((await f.store.activityRanking('all', 'chat', at))[0].chat, 1);
});

test('voice ranking spans three rooms after reward cap, disabled rewards and completed quests, without counting overlap', async () => {
  const f = await setup();
  const state = createDay(settings.clanGuildId, user, dayKey(at), [], at);
  state.points.attendance = attendance.dailyCap;
  for (const [i, channelId] of [settings.voiceChannelId, settings.secondVoiceChannelId, settings.thirdVoiceChannelId].entries()) {
    const event = { channelId, from: at + i * 60000, to: at + (i + 1) * 60000 };
    countVoice(state, event, f.config);
    applyVoice(state, event, { ...attendance, enabled: false }, f.config);
    applyVoice(state, event, attendance, f.config);
  }
  applyVoice(state, { channelId: '100000000000000045', from: at + 180000, to: at + 240000 }, attendance, f.config);
  assert.equal(state.activity.voiceMs, 180000); assert.equal(state.points.attendance, 10);
  assert.equal(state.points.tasks, 0);
});

test('voice eligibility and disconnects continue to bound actual activity independently of currency', async () => {
  const f = await setup(); f.time(at + 150000);
  const tracker = new VoiceTracker({ service: f.service, guildId: settings.arenaGuildId });
  const person = { userId: user, channelId: settings.thirdVoiceChannelId, bot: false };
  await tracker.transition([person], attendance, new Set([user]), at);
  await tracker.transition([{ ...person, deafened: true }], attendance, new Set([user]), at + 30000);
  await tracker.transition([person], attendance, new Set([user]), at + 60000);
  await tracker.tick(at + 90000); tracker.drop(); await tracker.tick(at + 150000);
  assert.equal((await f.service.day(user)).activity.voiceMs, 60000);
});

test('currency adjustments and purchases cannot affect either activity ranking', async () => {
  const f = await setup(); await f.seed(user, 100, 100);
  await f.service.message(message(1));
  const before = await f.store.activityRanking('all', 'chat', at);
  const adjust = { userId: user, actorId: actor, operationId: snowflake(at, 90), at,
    category: 'total', mode: 'remove', amount: 150, reason: '' };
  await f.service.adjustPoints(adjust); await f.service.adjustPoints(adjust);
  assert.deepEqual((await f.store.totals(user, 'all', at)), { _id: user, tasks: 0, attendance: 50, total: 50, milliseconds: 0 });
  await f.service.adjustPoints({ ...adjust, operationId: snowflake(at, 91), mode: 'add', amount: 200 });
  await f.service.purchase(request(), () => true);
  assert.equal((await f.store.totals(user, 'all', at)).total, 100);
  assert.deepEqual(await f.store.activityRanking('all', 'chat', at), before);
  assert.deepEqual(await f.store.activityRanking('all', 'voice', at), []);
});

test('ranking is by messages or time only, ties and personal ordinal positions agree with every five-member page', async () => {
  const f = await setup();
  for (let i = 0; i < 12; i++) {
    const id = String(BigInt(user) + BigInt(i));
    const state = await f.seed(id, i * 10000, 0);
    await f.store.mutateDay(state._id, d => { d.activity = { clanMessages: 100 - Math.floor(i / 2), voiceMs: i * 60000 }; return true; });
  }
  const all = await f.store.activityRanking('all', 'chat', at, { limit: 100 });
  assert.equal(all[0]._id, user); assert.equal(all[1]._id, other);
  const visible = [];
  for (let page = 1; page <= 3; page++) {
    const view = await activityView({ store: f.store, config: f.config, ownerId: user, category: 'chat', page, at });
    const value = view.embeds[0].toJSON().fields[0].value;
    visible.push(...[...value.matchAll(/<@(\d+)>/g)].map(m => m[1]));
    assert.equal(view.components[2].components[2].data.disabled, page === 3);
    assert.equal(view.components[2].components[0].data.disabled, page === 1);
  }
  assert.deepEqual(visible, all.map(row => row._id));
  assert.deepEqual(await f.store.activityPosition(other, 'all', 'chat', at), { position: 2, value: 100 });
  assert.deepEqual(await f.store.activityPosition(actor, 'all', 'chat', at), { position: null, value: 0 });
  const personal = await activityView({ store: f.store, config: f.config, ownerId: other, personal: true, at });
  assert.match(personal.embeds[0].data.description, /#2/); assert.equal(personal.embeds[0].data.fields[0].value.split('\n').length, 5);
  assert.equal(personal.embeds[0].data.fields[1].value.split('\n').length, 5);
});

test('five exact results disable next, and an empty leaderboard does not invent a personal rank', async () => {
  const f = await setup();
  for (let i = 0; i < 5; i++) {
    const state = await f.seed(String(BigInt(user) + BigInt(i)));
    await f.store.mutateDay(state._id, d => { d.activity = { clanMessages: 1, voiceMs: 0 }; return true; });
  }
  const view = await activityView({ store: f.store, config: f.config, ownerId: actor, personal: true, category: 'chat', at });
  assert.equal(view.components.at(-1).components[2].data.disabled, true);
  assert.match(view.embeds[0].data.description, /غير مصنف/);
  assert.ok(!view.embeds[0].data.description.includes('#0'));
  assert.equal(voiceTime(90061000), '25س 1د 1ث');
  assert.equal(rankPanel().components[0].components[0].data.custom_id, 'clan-rank:open');
});

test('Saudi midnight divides observed activity by date while all-time totals remain cumulative', async () => {
  const f = await setup(); const midnight = nextReset(at); f.time(midnight + 15000);
  await f.service.voice({ userId: user, eligible: true, guildId: settings.arenaGuildId,
    channelId: settings.thirdVoiceChannelId, from: midnight - 15000, to: midnight + 15000 }, attendance);
  assert.equal((await f.store.activityRanking('daily', 'voice', midnight))[0].voice, 15000);
  assert.equal((await f.store.activityRanking('all', 'voice', midnight))[0].voice, 30000);
});

test('resetting one member clears only their currency, activity and current timed quest', async () => {
  const f = await setup(); await f.seed(); await f.seed(other);
  await f.service.message(message(1)); await f.service.message(message(2, { userId: other }));
  f.time(at + 1);
  await f.service.reset({ userId: user, actorId: actor, operationId: 'activity-reset' });
  assert.deepEqual(await f.store.activityPosition(user, 'all', 'chat', at), { position: null, value: 0 });
  assert.equal((await f.store.activityPosition(other, 'all', 'chat', at)).value, 1);
  assert.equal((await f.store.totals(user, 'all', at)).total, 0);
  assert.equal(f.documents.shops[0].products.length, 1);
});
