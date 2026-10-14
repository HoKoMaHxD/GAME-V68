import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceTracker } from '../src/voice.js';
import { dailyFixture, dailyConfig as config } from './helpers/daily-fixture.js';
import { user } from './helpers/shop-fixture.js';
import { PUBLIC_VOICE_TASK_ID, PUBLIC_VOICE_CATEGORY_IDS } from '../src/public-voice-task.js';
import { createDailyQuestHandler, dailyQuestPayload } from '../src/daily-quest-views.js';

const minute = 60000;
const rule = { minPeople: 1, ignoreMuted: false, ignoreDeafened: false };
const person = { userId: user, channelId: '100000000000000070',
  categoryId: PUBLIC_VOICE_CATEGORY_IDS[0], bot: false };
const members = new Set([user]);
const turn = () => new Promise(resolve => setImmediate(resolve));
const publicTask = state => state.tasks.find(task => task.id === PUBLIC_VOICE_TASK_ID);

test('a leave observed during a slow save survives a subsequent disconnect', async () => {
  let release;
  let slow = true;
  const saved = [];
  const tracker = new VoiceTracker({ guildId: 'arena', service: { voice: async event => {
    if (slow) { slow = false; await new Promise(resolve => { release = resolve; }); }
    saved.push(structuredClone(event));
  } } });
  await tracker.transition([person], rule, members, 0);
  const first = tracker.tick(15000);
  await turn();
  const left = tracker.transition([], rule, members, 30000);
  tracker.drop();
  release();
  await Promise.all([first, left]);
  await tracker.transition([person], rule, members, 20 * minute);
  await tracker.tick(20 * minute + 15000);
  assert.equal(saved.reduce((sum, event) => sum + event.to - event.from, 0), 45000);
  assert.ok(saved.every(event => event.to <= 30000 || event.from >= 20 * minute));
});

test('snapshot and attendance rules are frozen at receipt, even when the cache objects mutate', async () => {
  const saved = [];
  const tracker = new VoiceTracker({ guildId: 'arena', service: { voice: async event => saved.push(event) } });
  const entry = { ...person };
  const attendance = { ...rule, ignoreDeafened: true };
  await tracker.transition([entry], attendance, members, 0);
  entry.channelId = 'other'; entry.categoryId = 'outside';
  attendance.ignoreDeafened = false;
  await tracker.tick(15000);
  assert.equal(saved[0].channelId, person.channelId);
  assert.equal(saved[0].categoryId, person.categoryId);
});

test('a delayed older observation cannot rewind time or restore a departed member', async () => {
  const saved = [];
  const tracker = new VoiceTracker({ guildId: 'arena', service: { voice: async event => saved.push(event) } });
  await tracker.transition([person], rule, members, 0);
  await tracker.transition([], rule, members, 30000);
  await tracker.transition([person], rule, members, 15000);
  await tracker.tick(45000);
  assert.equal(saved.reduce((sum, event) => sum + event.to - event.from, 0), 30000);
});

test('a genuinely unobserved gap is reported and never replaced with guessed attendance', async () => {
  const gaps = [], saved = [];
  const tracker = new VoiceTracker({ guildId: 'arena', onGap: gap => gaps.push(gap),
    service: { voice: async event => saved.push(event) } });
  await tracker.transition([person], rule, members, 0);
  await tracker.tick(11 * minute);
  await tracker.tick(11 * minute + 15000);
  assert.equal(gaps.length, 1);
  assert.deepEqual(gaps[0], { from: 0, to: 11 * minute, memberCount: 1 });
  assert.equal(saved.reduce((sum, event) => sum + event.to - event.from, 0), 15000);
});

test('18:13–18:52 credits exactly 39 minutes despite an 11-minute save delay; minute 40 pays once', async () => {
  const start = Date.parse('2026-10-10T18:13:00+03:00');
  const f = await dailyFixture({ start });
  await f.store.initializePublicVoiceTask(start);
  let release, slow = true;
  const tracker = new VoiceTracker({ guildId: config.arenaGuildId, service: { voice: async (event, attendance) => {
    if (slow) { slow = false; await new Promise(resolve => { release = resolve; }); }
    return f.service.voice(event, attendance);
  } } });
  const attendance = { ...config.attendance, ...rule };
  await tracker.transition([person], attendance, members, start);
  const pending = [];
  for (let seconds = 15; seconds <= 39 * 60; seconds += 15) {
    f.time(start + seconds * 1000);
    pending.push(tracker.transition([person], attendance, members, f.now()));
    if (seconds === 15) await turn();
    if (seconds === 11 * 60) { release(); await Promise.all(pending); }
  }
  await Promise.all(pending);
  let state = await f.service.day(user);
  assert.equal(publicTask(state).progress, 39 * minute);
  assert.equal(publicTask(state).completed, 0);
  assert.equal(state.points.tasks, 0);
  f.time(start + 40 * minute);
  await tracker.tick(f.now());
  await tracker.tick(f.now());
  state = await f.service.day(user);
  assert.equal(publicTask(state).progress, 40 * minute);
  assert.equal(state.points.tasks, 12000);
  assert.equal(state.completionLog.filter(entry => entry.taskId === PUBLIC_VOICE_TASK_ID).length, 1);
});

test('manual quest refresh saves the current observed interval before reading the counter', async () => {
  const f = await dailyFixture();
  await f.store.initializePublicVoiceTask(f.now());
  const tracker = new VoiceTracker({ guildId: config.arenaGuildId, service: f.service });
  await tracker.transition([person], { ...config.attendance, ...rule }, members, f.now());
  const startedAt = f.now();
  f.time(startedAt + minute);
  let acknowledged = false, payload;
  const handler = createDailyQuestHandler({ ...f, config, isMember: () => true,
    status: () => ({ tracking: true }), refreshVoice: async () => {
      assert.ok(acknowledged);
      await tracker.tick(f.now());
    } });
  await handler({ guildId: config.clanGuildId, user: { id: user }, isButton: () => true,
    customId: `clan-daily:v1:${user}:refresh`, message: { flags: { has: () => true } },
    deferUpdate: async () => { acknowledged = true; }, editReply: async value => { payload = value; } });
  assert.equal(publicTask(await f.service.day(user)).progress, minute);
  assert.match(payload.embeds[0].data.fields.find(field => field.name.includes('40 دقيقة')).value, /1 \/ 40/);
});

test('an expired private card explicitly labels stale progress and shows its last refresh time', async () => {
  const f = await dailyFixture();
  const payload = dailyQuestPayload(await f.service.day(user), f.now(), true, config, {}, false);
  assert.match(payload.embeds[0].data.footer.text, /توقف تحديث هذه البطاقة/);
  assert.equal(payload.embeds[0].data.timestamp, new Date(f.now()).toISOString());
});
