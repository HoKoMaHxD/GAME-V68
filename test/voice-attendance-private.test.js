import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { dailyFixture as baseFixture, dailyConfig as c } from './helpers/daily-fixture.js';
import { at, user, other } from './helpers/shop-fixture.js';
import { VoiceTracker } from '../src/voice.js';
import { readVoiceSnapshot } from '../src/voice-channels.js';
import { createDailyQuestHandler } from '../src/daily-quest-views.js';
import { createTextCommands } from '../src/experience-commands.js';

// Add the driver's update-and-return operation to this in-memory collection double.
async function dailyFixture() {
  const f = await baseFixture();
  const collection = f.store.db.collection.bind(f.store.db);
  f.store.db.collection = name => {
    const result = collection(name);
    result.findOneAndUpdate = async (filter, update, options) => {
      await result.updateOne(filter, update, options);
      return result.findOne(filter);
    };
    return result;
  };
  return f;
}

test('voice upgrade preserves balances/progress, enables presence and is idempotent across restarts', async () => {
  const f = await dailyFixture(); await f.post();
  const before = structuredClone(await f.service.day(user));
  assert.equal(await f.store.initializeVoiceAttendance(at), true);
  const settings = await f.store.settings();
  assert.deepEqual([settings.attendance.points, settings.attendance.intervalMs, settings.attendance.dailyCap], [200, 1260000, 4000]);
  assert.deepEqual([settings.attendance.minPeople, settings.attendance.ignoreMuted, settings.attendance.ignoreDeafened], [1, false, true]);
  assert.deepEqual(await f.service.day(user), before);
  const restarted = await f.restart();
  assert.equal(await restarted.store.initializeVoiceAttendance(at + 1000), false);
  assert.deepEqual((await restarted.store.settings()).attendance, settings.attendance);
});

test('a deafened/muted member alone completes voice quest at 3 hours and reaches exactly 4000 at 7 hours', async () => {
  const f = await dailyFixture(); await f.store.initializeVoiceAttendance(at);
  await f.store.setAttendance({ ignoreMuted: false, ignoreDeafened: false });
  const rule = (await f.store.settings()).attendance;
  const tracker = new VoiceTracker({ service: f.service, guildId: c.arenaGuildId });
  await tracker.transition([{ userId: user, channelId: c.voiceChannelId, bot: false, muted: true, deafened: true }], rule, new Set([user]), at);
  for (let minutes = 1; minutes <= 24 * 60 - 61; minutes++) {
    f.time(at + minutes * 60000); await tracker.tick(f.now());
    if (minutes === 180) {
      const day = await f.service.day(user);
      assert.equal(day.tasks.find(t => t.type === 'voice').completed, 1);
      assert.equal(day.points.tasks, 9000); assert.equal(day.points.attendance, 1600);
    }
    if (minutes === 419) assert.equal((await f.service.day(user)).points.attendance, 3800);
    if (minutes >= 420) assert.equal((await f.service.day(user)).points.attendance, 4000);
  }
  const before = await f.service.day(user); await tracker.tick(f.now());
  assert.deepEqual(await f.service.day(user), before);
});

test('voice cache gaps count verified humans but never unknown users or known bots', () => {
  const states = new Map([user, other, 'unknown', 'cached'].map(id => [id, { id, channelId: c.voiceChannelId }]));
  const guild = { voiceStates: { cache: states }, members: { cache: new Map([['cached', { user: { bot: false } }]]) },
    channels: { cache: new Map([[c.voiceChannelId, { permissionsFor: () => ({ has: () => true }) }]]) } };
  const source = { user: {}, users: { cache: new Map([[other, { bot: true }]]) } };
  const snapshot = readVoiceSnapshot(guild, source, { has: id => [user, other].includes(id), updateArena() {} }, new Set([c.voiceChannelId]));
  assert.deepEqual(snapshot.map(m => [m.userId, m.bot]), [[user, false], [other, true], ['unknown', true], ['cached', false]]);
});

async function privateHandler() {
  const f = await dailyFixture();
  return createDailyQuestHandler({ ...f, config: c, isMember: () => true, status: () => ({ tracking: true }) });
}

test('slash and text aliases post a public launcher without tasks or DM; owner opens privately in same channel', async () => {
  const handler = await privateHandler();
  for (const commandName of ['مهمتي', 'مهامي']) {
    const replies = [];
    await handler({ commandName, user: { id: user }, guildId: c.clanGuildId,
      isButton: () => false, reply: async p => replies.push(p) });
    assert.equal(replies.length, 1); assert.equal(replies[0].flags, undefined);
    assert.equal(replies[0].embeds, undefined);
    assert.equal(replies[0].components[0].components[0].data.label, 'استعراض المهام');
    const id = replies[0].components[0].components[0].data.custom_id;
    const calls = [];
    await handler({ customId: id, isButton: () => true, user: { id: user }, guildId: c.clanGuildId,
      channelId: c.clanChatChannelId, deferReply: async p => calls.push(['defer', p]),
      editReply: async p => calls.push(['edit', p]) });
    assert.deepEqual(calls[0], ['defer', { flags: MessageFlags.Ephemeral }]);
    assert.equal(calls[1][1].embeds[0].data.title, 'مهامك اليومية');
    const denied = [];
    await handler({ customId: id, isButton: () => true, user: { id: other }, guildId: c.clanGuildId,
      reply: async p => denied.push(p) });
    assert.equal(denied.length, 1); assert.equal(denied[0].flags, MessageFlags.Ephemeral);
  }
  const text = createTextCommands(handler, c);
  for (const content of ['مهمتي', '-مهامي', '!مهمتي']) {
    const replies = [];
    await text({ content, guildId: c.clanGuildId, channelId: c.clanChatChannelId,
      author: { id: user, send: () => assert.fail('must not DM') }, reply: async p => replies.push(p) });
    assert.equal(replies.length, 1); assert.equal(replies[0].embeds, undefined);
    assert.equal(replies[0].components[0].components[0].data.label, 'استعراض المهام');
  }
});

test('private refresh updates privately and public legacy refresh opens a new private response', async () => {
  const handler = await privateHandler();
  for (const isPrivate of [true, false]) {
    let updated = 0, deferred = [];
    await handler({ customId: `clan-daily:v1:${user}:refresh`, isButton: () => true, user: { id: user }, guildId: c.clanGuildId,
      message: { flags: { has: () => isPrivate } }, deferUpdate: async () => { updated++; },
      deferReply: async p => deferred.push(p), editReply: async () => {} });
    assert.equal(updated, isPrivate ? 1 : 0);
    assert.deepEqual(deferred, isPrivate ? [] : [{ flags: MessageFlags.Ephemeral }]);
  }
});

test('upgrade and restarts preserve saved mute/deafen and minimum people settings', async () => {
  const f = await dailyFixture();
  await f.store.setAttendance({ ignoreMuted: true, ignoreDeafened: true, minPeople: 2 });
  await f.store.initializeVoiceAttendance(at);
  let rule = (await f.store.settings()).attendance;
  assert.deepEqual([rule.ignoreMuted, rule.ignoreDeafened, rule.minPeople], [true, true, 2]);
  await f.store.setAttendance({ ignoreMuted: false, ignoreDeafened: true, minPeople: 3 });
  const restarted = await f.restart(); await restarted.store.initializeVoiceAttendance(at + 1000);
  rule = (await restarted.store.settings()).attendance;
  assert.deepEqual([rule.ignoreMuted, rule.ignoreDeafened, rule.minPeople], [false, true, 3]);
  assert.deepEqual([rule.points, rule.intervalMs, rule.dailyCap], [200, 1260000, 4000]);
});

test('live mute/deafen settings control new voice time without losing already counted progress', async () => {
  for (const field of ['ignoreMuted', 'ignoreDeafened']) {
    const f = await dailyFixture(); await f.store.initializeVoiceAttendance(at);
    const tracker = new VoiceTracker({ service: f.service, guildId: c.arenaGuildId });
    const snapshot = [{ userId: user, channelId: c.voiceChannelId, bot: false,
      muted: field === 'ignoreMuted', deafened: field === 'ignoreDeafened' }];
    await f.store.setAttendance({ ignoreMuted: false, ignoreDeafened: false, [field]: true });
    await tracker.transition(snapshot, (await f.store.settings()).attendance, new Set([user]), at);
    f.time(at + 60000); await tracker.tick(f.now());
    assert.equal((await f.service.day(user)).attendance.milliseconds, 0);
    await f.store.setAttendance({ [field]: false });
    await tracker.transition(snapshot, (await f.store.settings()).attendance, new Set([user]), f.now());
    f.time(at + 120000); await tracker.tick(f.now());
    assert.equal((await f.service.day(user)).attendance.milliseconds, 60000);
    await f.store.setAttendance({ [field]: true });
    await tracker.transition(snapshot, (await f.store.settings()).attendance, new Set([user]), f.now());
    f.time(at + 180000); await tracker.tick(f.now());
    const day = await f.service.day(user);
    assert.equal(day.attendance.milliseconds, 60000);
    assert.equal(day.tasks.find(t => t.type === 'voice').progress, 60000);
    assert.equal(day.activity.voiceMs, 60000);
  }
});
