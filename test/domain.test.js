import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import { DAY_MS, dayKey, dayStart, nextReset, periodStart, splitDays } from '../src/time.js';
import { createDay, seedTemplates, validateTemplate, applyMessage, applyVoice, eligibleVoice } from '../src/domain.js';
import { QuestService } from '../src/service.js';
import { VoiceTracker } from '../src/voice.js';

const config = {
  clanGuildId: '100000000000000001', arenaGuildId: '100000000000000002',
  generalChannelId: '100000000000000003', voiceChannelId: '100000000000000004',
  feelingChannelId: '100000000000000006', lookChannelId: '100000000000000007', memberRole: '100000000000000008',
  cooldownMs: 10000, minMessageLength: 3
};
const user = '100000000000000005';
const now = dayStart('2026-09-06') + 3600000;
const templates = () => seedTemplates(config);
const messageTask = (extra = {}) => ({ id: 'test-msg', type: 'messages', title: 'رسائل', channelId: config.generalChannelId, target: 2, reward: 100, repeat: 1, enabled: true, ...extra });
const voiceTask = (extra = {}) => ({ ...messageTask(), id: 'test-voice', type: 'voice', title: 'حضور', channelId: config.voiceChannelId, target: 1, ...extra });
const state = (tasks = [messageTask()]) => createDay(config.clanGuildId, user, dayKey(now), tasks, now);
const msg = (n, extra = {}) => ({ id: String(200000000000000000n + BigInt(n)), channelId: config.generalChannelId, at: now + n * 10000, content: `رسالة رقم ${n}`, ...extra });
const rule = (extra = {}) => ({ enabled: true, version: 1, channelId: config.voiceChannelId, points: 10, intervalMs: 60000, dailyCap: 500, minPeople: 1, ignoreMuted: false, ignoreDeafened: true, ...extra });
const voice = (from, to, extra = {}) => ({ channelId: config.voiceChannelId, from, to, ...extra });

test('Riyadh date flips exactly at 21:00 UTC', () => {
  assert.equal(dayKey(Date.parse('2026-09-05T20:59:59Z')), '2026-09-05');
  assert.equal(dayKey(Date.parse('2026-09-05T21:00:00Z')), '2026-09-06');
  assert.equal(nextReset(now), dayStart('2026-09-07'));
});
test('week and month boundaries are calendar-based, including year rollover', () => {
  assert.equal(periodStart('weekly', now, 0), '2026-09-06');
  assert.equal(periodStart('weekly', now, 1), '2026-08-31');
  assert.equal(periodStart('monthly', now), '2026-09-01');
  assert.equal(periodStart('weekly', dayStart('2027-01-01'), 0), '2026-12-27');
});
test('voice interval is split without losing or duplicating milliseconds', () => {
  const reset = nextReset(now);
  assert.deepEqual(splitDays(reset - 10000, reset + 15000), [
    { day: '2026-09-06', from: reset - 10000, to: reset },
    { day: '2026-09-07', from: reset, to: reset + 15000 }
  ]);
  assert.deepEqual(splitDays(now, now), []);
});
test('exactly four unique daily tasks, stable after reopening', () => {
  const a = createDay(config.clanGuildId, user, '2026-09-06', templates(), now);
  const b = createDay(config.clanGuildId, user, '2026-09-06', templates().reverse(), now);
  assert.equal(a.tasks.length, 4);
  assert.equal(new Set(a.tasks.map(t => t.id)).size, 4);
  assert.deepEqual(a.tasks, b.tasks);
});
test('personal assignment and progress are isolated between users', () => {
  const a = createDay(config.clanGuildId, user, '2026-09-06', templates(), now);
  const b = createDay(config.clanGuildId, '100000000000000099', '2026-09-06', templates(), now);
  assert.deepEqual(a.tasks.map(t => t.id), b.tasks.map(t => t.id));
  applyMessage(a, msg(1), config);
  assert.equal(b.tasks.every(t => t.progress === 0), true);
});
test('targeted templates have priority but never leak to another member', () => {
  const t = [...templates(), messageTask({ forUser: user })];
  const a = createDay(config.clanGuildId, user, '2026-09-06', t, now);
  const b = createDay(config.clanGuildId, '100000000000000099', '2026-09-06', t, now);
  assert.equal(a.tasks[0].id, 'test-msg');
  assert.equal(b.tasks.some(x => x.id === 'test-msg'), false);
});
test('disabled templates are excluded, existing snapshots remain unchanged', () => {
  const task = messageTask();
  const a = state([task]);
  task.enabled = false; task.reward = 999;
  assert.equal(a.tasks[0].reward, 100);
  assert.equal(a.tasks[0].enabled, true);
  assert.equal(state([task]).tasks.length, 0);
});
test('a completed mission credits points exactly once and caps progress', () => {
  const a = state();
  for (let n = 1; n <= 10; n++) applyMessage(a, msg(n), config);
  assert.equal(a.points.tasks, 100);
  assert.equal(a.tasks[0].progress, 2);
  assert.equal(a.completionLog.length, 1);
});
test('repeat limit grants each completion once', () => {
  const a = state([messageTask({ repeat: 3 })]);
  for (let n = 1; n <= 10; n++) applyMessage(a, msg(n), config);
  assert.equal(a.points.tasks, 300);
  assert.equal(a.tasks[0].completed, 3);
  assert.equal(a.tasks[0].progress, 6);
  assert.equal(a.completionLog.length, 3);
});
test('duplicate gateway message ids do not double count', () => {
  const a = state();
  assert.equal(applyMessage(a, msg(1), config), true);
  assert.equal(applyMessage(a, msg(1, { at: now + 90000, content: 'محتوى مختلف' }), config), false);
  assert.equal(a.tasks[0].progress, 1);
});
test('distinct messages count without text deduplication or a cooldown', () => {
  const a = state([messageTask({ target: 100 })]);
  applyMessage(a, msg(1, { content: 'سلام عليكم' }), config);
  assert.equal(applyMessage(a, msg(2, { at: now + 11000 }), config), true);
  assert.equal(applyMessage(a, msg(3, { content: '  سلام   عليكم\u200b ' }), config), true);
  applyMessage(a, msg(4, { content: 'وش اخباركم' }), config);
  assert.equal(applyMessage(a, msg(5, { content: 'سلام عليكم' }), config), true);
  assert.equal(a.tasks[0].progress, 5);
});
test('symbols and short messages count while unrelated channels do not', () => {
  const a = state([messageTask({ target: 100 })]);
  for (const [n, content] of ['.', 'هه', '💙💙💙', '...'].entries()) assert.equal(applyMessage(a, msg(n, { content }), config), true);
  assert.equal(applyMessage(a, msg(9, { channelId: config.voiceChannelId }), config), false);
  assert.equal(a.tasks[0].progress, 4);
});
test('one event advances all matching assigned tasks, no unrelated task', () => {
  const a = state([messageTask({ target: 1 }), messageTask({ id: 'second', target: 1 }), voiceTask()]);
  applyMessage(a, msg(1), config);
  assert.equal(a.points.tasks, 200);
  assert.equal(a.tasks.find(t => t.type === 'voice').progress, 0);
});
test('voice progress and attendance points are independent', () => {
  const a = state([voiceTask()]);
  applyVoice(a, voice(now, now + 30000), rule());
  assert.equal(a.points.tasks, 0);
  applyVoice(a, voice(now + 30000, now + 60000), rule());
  assert.equal(a.points.tasks, 100);
  assert.equal(a.points.attendance, 10);
});
test('overlapping/replayed voice intervals cannot duplicate rewards', () => {
  const a = state([voiceTask()]);
  applyVoice(a, voice(now, now + 45000), rule());
  applyVoice(a, voice(now + 30000, now + 60000), rule());
  applyVoice(a, voice(now, now + 60000), rule());
  assert.equal(a.attendance.milliseconds, 60000);
  assert.equal(a.points.attendance, 10);
});
test('attendance daily cap is enforced, including non-multiple cap', () => {
  const a = state([]);
  applyVoice(a, voice(now, now + 600000), rule({ dailyCap: 25 }));
  assert.equal(a.points.attendance, 25);
  applyVoice(a, voice(now + 600000, now + 900000), rule({ dailyCap: 25 }));
  assert.equal(a.points.attendance, 25);
});
test('changing attendance rate cannot reprice already credited history', () => {
  const a = state([]);
  applyVoice(a, voice(now, now + 90000), rule());
  assert.equal(a.points.attendance, 10);
  applyVoice(a, voice(now + 90000, now + 120000), rule({ version: 2, points: 100 }));
  assert.equal(a.points.attendance, 10);
  applyVoice(a, voice(now + 120000, now + 150000), rule({ version: 2, points: 100 }));
  assert.equal(a.points.attendance, 110);
});
test('disabled attendance and other voice channels still allow matching voice quests', () => {
  const a = state([voiceTask()]);
  applyVoice(a, voice(now, now + 60000), rule({ enabled: false }));
  assert.equal(a.points.tasks, 100); assert.equal(a.points.attendance, 0);
  const b = state([voiceTask()]);
  applyVoice(b, voice(now, now + 60000), rule({ channelId: '100000000000000099' }));
  assert.equal(b.points.tasks, 100); assert.equal(b.points.attendance, 0);
});
test('voice eligibility respects membership, bots, AFK, deaf, mute and human count', () => {
  const person = { userId: user, channelId: config.voiceChannelId, bot: false };
  const ids = new Set([user]);
  assert.equal(eligibleVoice([person], rule(), ids).length, 1);
  assert.equal(eligibleVoice([person], rule({ minPeople: 2 }), ids).length, 0);
  assert.equal(eligibleVoice([person, { ...person, userId: 'another', bot: true }], rule({ minPeople: 2 }), ids).length, 0);
  assert.equal(eligibleVoice([person, { ...person, userId: 'another' }], rule({ minPeople: 2 }), ids).length, 1);
  for (const flag of ['bot', 'afk', 'suppressed', 'deafened']) assert.equal(eligibleVoice([{ ...person, [flag]: true }], rule(), ids).length, 0);
  assert.equal(eligibleVoice([{ ...person, muted: true }], rule({ ignoreMuted: true }), ids).length, 0);
  assert.equal(eligibleVoice([person], rule(), new Set()).length, 0);
});
test('template input validation rejects invalid or excessive settings', () => {
  assert.doesNotThrow(() => validateTemplate(messageTask()));
  for (const extra of [{ reward: -1 }, { repeat: 0 }, { target: NaN }, { channelId: 'abc' }, { type: 'invalid' }, { target: 1.5 }, { title: 'x'.repeat(101) }]) assert.throws(() => validateTemplate(messageTask(extra)));
  assert.throws(() => validateTemplate(voiceTask({ target: 1441 })));
});

class MemoryStore {
  constructor(tasks = templates()) { this.days = new Map(); this.list = tasks; }
  async getDay(id) { return structuredClone(this.days.get(id) || null); }
  async templates() { return structuredClone(this.list); }
  async ensureDay(day) { if (!this.days.has(day._id)) this.days.set(day._id, structuredClone(day)); return this.getDay(day._id); }
  async mutateDay(id, fn) {
    const day = structuredClone(this.days.get(id));
    if (fn(day)) { day.revision++; this.days.set(id, day); }
    return this.getDay(id);
  }
}
test('service ignores other servers, bots, outsiders, old/future events', async () => {
  const db = new MemoryStore();
  const s = new QuestService(db, config, () => now);
  const good = { ...msg(0), guildId: config.arenaGuildId, userId: user, eligible: true, bot: false };
  for (const extra of [{ guildId: config.clanGuildId }, { bot: true }, { eligible: false }, { at: now - 130000 }, { at: now + 6000 }, { id: 'bad' }]) assert.equal(await s.message({ ...good, ...extra }), null);
  assert.equal(db.days.size, 0);
});
test('daily renewal creates a new independent record, keeps previous points', async () => {
  const db = new MemoryStore([messageTask({ target: 1 })]);
  const s = new QuestService(db, config, () => now);
  await s.message({ ...msg(0), guildId: config.arenaGuildId, userId: user, eligible: true });
  assert.equal((await s.day(user)).points.tasks, 100);
  assert.equal((await s.day(user, now + DAY_MS)).points.tasks, 0);
  assert.equal((await s.day(user)).points.tasks, 100);
});
test('restarting service retains assignment, progress and attendance fraction', async () => {
  const db = new MemoryStore([voiceTask()]);
  const s = new QuestService(db, config, () => now + 120000);
  const event = { guildId: config.arenaGuildId, userId: user, eligible: true, channelId: config.voiceChannelId };
  await s.voice({ ...event, from: now, to: now + 30000 }, rule());
  const restarted = new QuestService(db, config, () => now + 120000);
  await restarted.voice({ ...event, from: now + 60000, to: now + 90000 }, rule());
  const result = await restarted.day(user);
  assert.equal(result.attendance.milliseconds, 60000);
  assert.equal(result.points.attendance, 10);
});
test('voice straddling midnight is allocated to the correct day', async () => {
  const reset = nextReset(now);
  const db = new MemoryStore([voiceTask()]);
  const s = new QuestService(db, config, () => reset + 30000);
  await s.voice({ guildId: config.arenaGuildId, userId: user, eligible: true,
    ...voice(reset - 15000, reset + 30000) }, rule());
  assert.equal((await s.day(user, reset - 1)).attendance.milliseconds, 15000);
  assert.equal((await s.day(user, reset)).attendance.milliseconds, 30000);
});
test('voice tracker accounts join/leave exactly and never credits disconnected gaps', async () => {
  const intervals = [];
  const tracker = new VoiceTracker({ service: { voice: async e => intervals.push(e) }, guildId: config.arenaGuildId });
  const person = { userId: user, channelId: config.voiceChannelId, bot: false };
  await tracker.transition([person], rule(), new Set([user]), now);
  await tracker.tick(now + 15000);
  await tracker.transition([], rule(), new Set([user]), now + 20000);
  await tracker.tick(now + 40000);
  tracker.drop();
  await tracker.transition([person], rule(), new Set([user]), now + 100000);
  await tracker.tick(now + 115000);
  assert.equal(intervals.reduce((total, e) => total + e.to - e.from, 0), 35000);
});
test('voice move does not credit time in the old room after transition', async () => {
  const intervals = [];
  const tracker = new VoiceTracker({ service: { voice: async e => intervals.push(e) }, guildId: config.arenaGuildId });
  const person = { userId: user, channelId: config.voiceChannelId, bot: false };
  await tracker.transition([person], rule(), new Set([user]), now);
  await tracker.transition([{ ...person, channelId: config.generalChannelId }], rule(), new Set([user]), now + 10000);
  await tracker.tick(now + 30000);
  assert.equal(intervals[0].channelId, config.voiceChannelId);
  assert.equal(intervals[0].to - intervals[0].from, 10000);
  assert.equal(intervals[1].channelId, config.generalChannelId);
  assert.equal(intervals[1].to - intervals[1].from, 20000);
});
test('a stalled event loop interval over 60 seconds is discarded', async () => {
  const intervals = [];
  const tracker = new VoiceTracker({ service: { voice: async e => intervals.push(e) }, guildId: config.arenaGuildId });
  await tracker.transition([{ userId: user, channelId: config.voiceChannelId, bot: false }], rule(), new Set([user]), now);
  await tracker.tick(now + 61000);
  assert.equal(intervals.length, 0);
});
test('voice persistence failure retries all observed time on the next snapshot', async () => {
  let failing = true;
  let errors = 0;
  let counted = 0;
  const tracker = new VoiceTracker({ service: { voice: async e => {
    if (failing) throw new Error('DB offline'); counted += e.to - e.from;
  } }, guildId: config.arenaGuildId, onError: () => errors++ });
  const snapshot = [{ userId: user, channelId: config.voiceChannelId, bot: false }];
  await tracker.transition(snapshot, rule(), new Set([user]), now);
  await assert.rejects(tracker.tick(now + 15000));
  await tracker.drain();
  assert.equal(errors, 1);
  failing = false;
  await tracker.transition(snapshot, rule(), new Set([user]), now + 30000);
  await tracker.tick(now + 45000);
  assert.equal(counted, 45000);
});
test('disconnect while a flush is pending cannot restore the stale voice snapshot', async () => {
  let resolve;
  const tracker = new VoiceTracker({ service: { voice: () => new Promise(done => { resolve = done; }) }, guildId: config.arenaGuildId });
  const snapshot = [{ userId: user, channelId: config.voiceChannelId, bot: false }];
  await tracker.transition(snapshot, rule(), new Set([user]), now);
  const operation = tracker.transition(snapshot, rule(), new Set([user]), now + 10000);
  await new Promise(done => setImmediate(done));
  tracker.drop(); resolve(); await operation;
  assert.equal(tracker.last, null);
  assert.equal(tracker.snapshot.length, 0);
});
test('explicit risk acknowledgement and valid environment are required', () => {
  assert.throws(() => readConfig({}), /ACKNOWLEDGE/);
  const env = {
    OBSERVER_MODE: 'official', DISCORD_BOT_TOKEN: 'example', MONGODB_URI: 'mongodb://localhost',
    CLAN_GUILD_ID: config.clanGuildId, ARENA_GUILD_ID: config.arenaGuildId,
    GENERAL_CHANNEL_ID: config.generalChannelId, CLAN_CHAT_CHANNEL_ID: '100000000000000005', CLAN_VOICE_CHANNEL_ID: config.voiceChannelId,
    FEELING_CHANNEL_ID: config.feelingChannelId, LOOK_CHANNEL_ID: config.lookChannelId, CLAN_MEMBER_ROLE_ID: config.memberRole
  };
  assert.equal(readConfig(env).attendance.ignoreMuted, false);
  assert.throws(() => readConfig({ ...env, MONGODB_URI: 'https://bad' }));
  assert.throws(() => readConfig({ ...env, VOICE_POINTS: '-1' }));
  assert.throws(() => readConfig({ ...env, VOICE_IGNORE_MUTED: 'yes' }));
});
