import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyFixture, dailyConfig as c } from './helpers/daily-fixture.js';
import { at, user, other, snowflake } from './helpers/shop-fixture.js';
import { createDay } from '../src/domain.js';
import { dayKey, nextReset, DAY_MS } from '../src/time.js';
import { netPoints } from '../src/point-adjustments.js';
import { memberNotification } from '../src/notification-views.js';
import { notice } from '../src/notification-events.js';

const task = (state, id) => state.tasks.find(t => t.id === id);
test('all six reference quests run together without requesting/accepting; all rewards total 31000 plus attendance', async () => {
  const f = await dailyFixture(); f.time(at + 1000);
  const messages = Array.from({ length: 110 }, (_, i) => f.message(i % 2 ? c.generalChannelId : c.clanChatChannelId));
  await Promise.all(messages.map(e => f.service.message(e)));
  await Promise.all(messages.map(e => f.service.message(e)));
  await f.post(c.feelingChannelId, { mentionedRoleIds: [c.memberRole] });
  await f.post(c.lookChannelId, { mentionedRoleIds: [c.memberRole], hasMedia: true });
  for (let i = 0; i < 5; i++) {
    const event = { ...f.message(c.gamesChannelId), botId: c.gamesBotId, gameId: snowflake(f.now(), 5000 + i) };
    await f.service.game(event); await f.service.game(event);
  }
  for (let i = 0; i < 180; i++) {
    const from = at + i * 60000, to = from + 60000; f.time(to);
    await f.service.voice({ guildId: c.arenaGuildId, userId: user, eligible: true,
      channelId: [c.voiceChannelId, c.secondVoiceChannelId, c.thirdVoiceChannelId][i % 3], from, to }, c.attendance);
  }
  const state = await f.service.day(user);
  assert.equal(state.tasks.length, 6); assert.ok(state.tasks.every(t => t.completed === 1));
  assert.equal(state.points.tasks, 31000); assert.equal(state.points.attendance, 180);
  assert.equal(state.completionLog.length, 6); assert.equal(state.activity.clanMessages, 55);
  assert.equal(state.activity.voiceMs, 10800000); assert.equal(netPoints(state).total, 31180);
  assert.equal(state.timedQuest, undefined); assert.equal(f.service.offerTimedQuest, undefined);
  assert.equal((await f.service.day(other)).points.tasks, 0);
  const reopened = await f.restart();
  assert.equal((await reopened.service.day(user)).points.tasks, 31000);
  await f.store.notifications.collect(f.now());
  assert.equal(f.documents.member_notifications.filter(e => e.kind === 'daily_completed').length, 6);
  assert.equal(f.documents.member_notifications.filter(e => e.kind === 'daily_all_completed').length, 1);
});

test('Saudi midnight clears unfinished progress, leaves the wallet intact and splits a voice interval exactly', async () => {
  const midnight = nextReset(at), f = await dailyFixture({ start: midnight - 120000 });
  f.time(midnight - 30000);
  await f.post(c.feelingChannelId, { mentionedRoleIds: [c.memberRole] });
  for (let i = 0; i < 49; i++) await f.post(c.generalChannelId);
  f.time(midnight + 15000);
  await f.service.voice({ guildId: c.arenaGuildId, userId: user, eligible: true, channelId: c.voiceChannelId,
    from: midnight - 15000, to: midnight + 15000 }, c.attendance);
  const before = await f.service.day(user, midnight - 1), after = await f.service.day(user);
  assert.notEqual(before.day, after.day); assert.equal(before.points.tasks, 1500); assert.equal(after.points.tasks, 0);
  assert.equal(task(before, 'daily-general-50').progress, 49); assert.equal(task(after, 'daily-general-50').progress, 0);
  assert.equal(task(before, 'daily-voice-180').progress, 15000); assert.equal(task(after, 'daily-voice-180').progress, 15000);
  assert.equal((await f.service.balance(user)).total, 1500);
  assert.equal(nextReset(midnight - 1), midnight); assert.equal(nextReset(midnight), midnight + DAY_MS);
  assert.equal(new Date(midnight).toISOString().slice(11, 19), '21:00:00');
  await f.post(c.feelingChannelId, { mentionedRoleIds: [c.memberRole] });
  assert.equal((await f.service.balance(user)).total, 3000);
});

test('upgrade archives active offers and task snapshots, preserving balances, activity, receipts and notification preferences', async () => {
  const f = await dailyFixture({ install: false });
  const old = createDay(c.clanGuildId, user, dayKey(at), [], at - 60000);
  delete old.dailyQuestVersion; delete old.dailyQuestStartedAt;
  old.tasks = [{ id: 'legacy', progress: 499 }]; old.points = { tasks: 250, attendance: 70 };
  old.salaryCredits = 500; old.activity = { clanMessages: 57, voiceMs: 80000 };
  old.timedQuest = { id: snowflake(at - 60000), status: 'active', progress: 19, target: 20, reward: 2000 };
  old.prizeReceipts = [{ id: snowflake(at, 80), type: 'quest_wait', percent: 60, claimedAt: at - 1000 }];
  await f.store.ensureDay(old);
  await f.store.notifications.toggle(user, snowflake(at, 90), at);
  await f.store.initializeDailyQuests(at);
  f.time(at + 1000);
  const state = await f.service.day(user);
  assert.equal(state.tasks.length, 6); assert.ok(state.tasks.every(t => t.progress === 0));
  assert.deepEqual(state.points, old.points); assert.deepEqual(state.activity, old.activity);
  assert.equal(state.salaryCredits, 500); assert.equal(state.timedQuest, undefined);
  assert.deepEqual(state.previousTaskSets[0].timedQuest, old.timedQuest);
  assert.equal((await f.store.notifications.preference(user)).enabled, false);
  const before = await f.service.balance(user);
  await f.service.message(f.message(c.feelingChannelId, { at: at - 1, mentionedRoleIds: [c.memberRole] }));
  assert.deepEqual(await f.service.balance(user), before);
  await f.post(c.feelingChannelId, { mentionedRoleIds: [c.memberRole] });
  assert.equal((await f.service.balance(user)).total, before.total + 1500);
  f.documents.settings[0].bank.salaryAmount = 500;
  const paid = await f.service.claimSalary({ id: snowflake(f.now(), 100), userId: user, at: f.now(), channelId: f.documents.settings[0].bank.channelId });
  assert.equal(paid.amount, 800); assert.equal(paid.bonusId, old.prizeReceipts[0].id);
  assert.equal(await f.store.nextPrizeBonus(user, 'salary'), null);
  assert.equal((await f.service.day(user)).previousTaskSets.length, 1);
});

for (const phase of ['before', 'after']) test(`lost ${phase}-commit task acknowledgement never duplicates the reward or DM`, async () => {
  const f = await dailyFixture(); f.time(at + 1000);
  await f.service.day(user);
  let failed = false;
  f.intercept(e => { if (!failed && e.name === 'days' && e.method === 'replaceOne' && e.phase === phase && e.args[1].points.tasks === 1500) {
    failed = true; throw new Error('simulated acknowledgement failure');
  } });
  const event = f.message(c.feelingChannelId, { mentionedRoleIds: [c.memberRole] });
  await assert.rejects(f.service.message(event)); f.intercept(() => {});
  const restarted = await f.restart(); await restarted.service.message(event); await restarted.service.message(event);
  assert.equal((await restarted.service.balance(user)).total, 1500);
  await restarted.store.notifications.collect(f.now()); await restarted.store.notifications.collect(f.now());
  assert.equal(f.documents.member_notifications.filter(e => e.kind === 'daily_completed').length, 1);
});

test('partial catalog installation resumes at the original boundary and ordinary restarts preserve later admin edits', async () => {
  const f = await dailyFixture({ install: false }); let writes = 0;
  f.intercept(e => { if (e.name === 'templates' && e.method === 'updateOne' && e.phase === 'after' && ++writes === 2) throw new Error('interrupted install'); });
  await assert.rejects(f.store.initializeDailyQuests(at)); f.intercept(() => {});
  f.time(at + 1000); const restarted = await f.restart();
  assert.equal(restarted.store.taskSetActivatedAt, at);
  assert.equal((await restarted.store.templates()).filter(t => t.enabled).length, 6);
  const template = f.documents.templates.find(t => t.id === 'daily-look-media'); template.reward = 444; template.enabled = false;
  await restarted.store.initializeDailyQuests(at + 2000);
  assert.equal(template.reward, 444); assert.equal(template.enabled, false);
  assert.equal(f.documents.settings[0].attendance.points, 10); assert.equal(f.documents.settings[0].attendance.intervalMs, 600000);
});

test('daily warnings, completion and reset summaries use the final saved state; old quest alerts become obsolete', async () => {
  const midnight = nextReset(at), f = await dailyFixture(); f.time(at + 1000);
  await f.post(c.feelingChannelId, { mentionedRoleIds: [c.memberRole] });
  await f.post(c.generalChannelId);
  await f.store.notifications.collect(f.now());
  const find = kind => f.documents.member_notifications.find(e => e.kind === kind);
  const warning = find('daily_warning'), reset = find('daily_reset'), completed = find('daily_completed');
  assert.equal(warning.dueAt, midnight - 600000); assert.equal(reset.dueAt, midnight);
  assert.equal(await f.store.notifications.valid(completed, f.now(), () => true), 'send');
  assert.equal(await f.store.notifications.valid(warning, midnight - 600000, () => true), 'send');
  assert.equal(await f.store.notifications.valid(warning, midnight, () => true), 'skip');
  assert.equal(await f.store.notifications.valid(reset, midnight, () => true), 'send');
  assert.deepEqual([reset.data.completed, reset.data.total, reset.data.remaining, reset.data.earned], [1, 6, 5, 1500]);
  assert.equal(await f.store.notifications.valid(reset, midnight, () => false), 'skip');
  for (const event of [completed, warning, reset]) {
    const payload = memberNotification(event, f.documents.settings[0], c.clanGuildId);
    assert.ok(payload.embeds[0].length < 6000); assert.deepEqual(payload.allowedMentions, { parse: [] });
  }
  for (const kind of ['quest_active', 'quest_completed', 'quest_ready', 'quest_rejected', 'quest_expired']) {
    assert.equal(await f.store.notifications.valid(notice(user, kind, 'old', at), at + 1000, () => true), 'skip');
  }
  f.time(midnight + 1000); await f.service.day(user); await f.store.notifications.collect(f.now());
  assert.equal(f.documents.member_notifications.filter(e => e.kind === 'daily_reset').length, 2);
  await f.store.notifications.collect(f.now()); assert.equal(f.documents.member_notifications.filter(e => e.kind === 'daily_reset').length, 2);
});

test('daily assignment snapshots keep their old observation channels after a catalog edit', async () => {
  const f = await dailyFixture(); await f.service.day(user);
  const template = f.documents.templates.find(t => t.id === 'daily-look-media');
  const previousChannel = template.channelId; template.channelId = '100000000000000077';
  const snapshots = await f.store.activeTaskSnapshots(at);
  assert.ok(snapshots.some(t => t.id === template.id && t.channelId === previousChannel));
  assert.equal((await f.service.day(user)).tasks.find(t => t.id === template.id).channelId, previousChannel);
  const next = nextReset(at); f.time(next);
  assert.equal((await f.service.day(user)).tasks.find(t => t.id === template.id).channelId, template.channelId);
});

test('unsafe task reward totals fail atomically without a progress commit or a false completion DM', async () => {
  const f = await dailyFixture(); const day = await f.service.day(user); f.time(at + 1000);
  await f.store.mutateDay(day._id, state => { state.points.tasks = Number.MAX_SAFE_INTEGER; return true; });
  await assert.rejects(f.post(c.feelingChannelId, { mentionedRoleIds: [c.memberRole] }), /الحد الرقمي/);
  const saved = await f.service.day(user);
  assert.equal(saved.points.tasks, Number.MAX_SAFE_INTEGER);
  assert.equal(task(saved, 'daily-feeling-mention').completed, 0); assert.equal(saved.completionLog.length, 0);
});
