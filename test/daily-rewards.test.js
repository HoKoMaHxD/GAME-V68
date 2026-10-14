import test from 'node:test';
import assert from 'node:assert/strict';
import { DAILY_REWARDS, updateDailyRewards } from '../src/daily-rewards.js';
import { dailyFixture, dailyConfig as c } from './helpers/daily-fixture.js';
import { at, user, other } from './helpers/shop-fixture.js';
import { createDay } from '../src/domain.js';
import { dayKey, nextReset, DAY_MS } from '../src/time.js';

const oldPrices = { 'daily-general-50': 50, 'daily-clan-chat-50': 50, 'daily-feeling-mention': 150,
  'daily-look-media': 200, 'daily-voice-180': 180, 'daily-games-5': 500 };
async function oldFixture() {
  const f = await dailyFixture({ install: false });
  await f.store.initializeDailyQuests(at);
  for (const row of f.documents.templates) if (oldPrices[row.id]) row.reward = oldPrices[row.id];
  Object.assign(f.documents.settings[0].attendance, { dailyCap: 500, points: 10, intervalMs: 600000, version: 4 });
  const day = await f.service.day(user);
  await f.store.mutateDay(day._id, draft => {
    draft.tasks.find(t => t.id === 'daily-general-50').progress = 49;
    const done = draft.tasks.find(t => t.id === 'daily-feeling-mention'); done.progress = 1; done.completed = 1;
    draft.points.tasks = 150; draft.points.attendance = 500;
    draft.completionLog.push({ taskId: done.id, cycle: 1, points: 150, at: at + 1000 });
    draft.attendance = { milliseconds: 509 * 60000, carryMs: 9 * 60000, ruleVersion: 4 };
    draft.activity = { clanMessages: 49, voiceMs: 509 * 60000 };
    return true;
  });
  f.time(at + 3600000);
  return f;
}

test('live catalog installs all six requested prices and attendance settings for a new installation', async () => {
  const f = await dailyFixture();
  const catalog = await f.store.templates();
  assert.deepEqual(Object.fromEntries(catalog.filter(t => t.enabled).map(t => [t.id, t.reward])), {
    'daily-general-50': 8000, 'daily-clan-chat-50': 6000, 'daily-feeling-mention': 1500,
    'daily-look-media': 1000, 'daily-voice-180': 9000, 'daily-games-5': 5500
  });
  assert.equal(Object.values(DAILY_REWARDS).reduce((a, b) => a + b), 31000);
  const rule = (await f.store.settings()).attendance;
  assert.deepEqual([rule.points, rule.intervalMs, rule.dailyCap], [10, 600000, 4000]);
});

test('upgrade reprices unpaid daily quests without resetting progress, altering prior awards or sending a false completion', async () => {
  const f = await oldFixture(); const before = await f.service.day(user), balance = await f.service.balance(user);
  const pendingNotices = structuredClone(before.dmEvents);
  await f.store.initializeDailyRewards(f.now());
  const after = await f.service.day(user);
  assert.equal(after.tasks.find(t => t.id === 'daily-general-50').progress, 49);
  assert.equal(after.tasks.find(t => t.id === 'daily-general-50').reward, 8000);
  assert.equal(after.tasks.find(t => t.id === 'daily-feeling-mention').reward, 150);
  assert.equal(after.tasks.find(t => t.id === 'daily-feeling-mention').completed, 1);
  assert.deepEqual(after.points, before.points); assert.deepEqual(after.attendance, before.attendance);
  assert.deepEqual(after.activity, before.activity); assert.deepEqual(after.completionLog, before.completionLog);
  assert.deepEqual(after.dmEvents, pendingNotices); assert.deepEqual(await f.service.balance(user), balance);
  assert.equal(after.rewardChanges.length, 1);
  assert.deepEqual(await f.service.day(user), after);
  await f.post(c.generalChannelId);
  assert.equal((await f.service.balance(user)).total, balance.total + 8000);
  await f.post(c.feelingChannelId, { mentionedRoleIds: [c.memberRole] });
  assert.equal((await f.service.balance(user)).total, balance.total + 8000);
  f.time(nextReset(f.now()));
  const tomorrow = await f.service.day(user);
  assert.equal(tomorrow.tasks.find(t => t.id === 'daily-feeling-mention').reward, 1500);
  assert.ok(tomorrow.tasks.every(t => t.completed === 0));
});

test('raising the attendance cap preserves accrued partial minutes and only pays future observed time', async () => {
  const f = await oldFixture(); await f.store.initializeDailyRewards(f.now());
  const rule = (await f.store.settings()).attendance;
  assert.equal(rule.version, 4); assert.equal(rule.dailyCap, 4000);
  const from = f.now(); f.time(from + 60000);
  const event = { guildId: c.arenaGuildId, userId: user, eligible: true, channelId: c.voiceChannelId, from, to: f.now() };
  await f.service.voice(event, rule); await f.service.voice(event, rule);
  const after = await f.service.day(user);
  assert.equal(after.points.attendance, 510); assert.equal(after.attendance.carryMs, 0);
  assert.equal(after.attendance.milliseconds, 510 * 60000);
});

test('historical days and custom tasks stay unchanged while later catalog edits survive restarts and new assignments', async () => {
  const f = await oldFixture();
  const history = createDay(c.clanGuildId, user, dayKey(at - DAY_MS), await f.store.templates(), at - DAY_MS);
  history.points.tasks = 150; const copy = structuredClone(history);
  assert.equal(updateDailyRewards(history, f.now()), false); assert.deepEqual(history, copy);
  const today = await f.service.day(user);
  await f.store.mutateDay(today._id, draft => { draft.tasks.push({ id: 'custom', reward: 123, progress: 7, completed: 0 }); return true; });
  await f.store.initializeDailyRewards(f.now());
  assert.equal((await f.service.day(user)).tasks.find(t => t.id === 'custom').reward, 123);
  const template = f.documents.templates.find(t => t.id === 'daily-look-media'); template.reward = 777;
  const restarted = await f.restart();
  assert.equal((await restarted.store.templates()).find(t => t.id === template.id).reward, 777);
  assert.equal((await restarted.service.day(other)).tasks.find(t => t.id === template.id).reward, 777);
  f.time(nextReset(f.now()));
  assert.equal((await restarted.service.day(user)).tasks.find(t => t.id === template.id).reward, 777);
});

for (const phase of ['before', 'after']) test(`reward migration resumes after a ${phase}-write failure and keeps its original activation boundary`, async () => {
  const f = await oldFixture(); const started = f.now(); let failed = false;
  f.intercept(e => { if (!failed && e.name === 'templates' && e.method === 'updateOne' && e.phase === phase && e.args[0].id === 'daily-look-media') {
    failed = true; throw new Error('interrupted reward installation');
  } });
  await assert.rejects(f.store.initializeDailyRewards(started)); f.intercept(() => {});
  f.time(started + 1000); const restart = await f.restart();
  assert.equal(restart.store.rewardSetActivatedAt, started);
  const prices = Object.fromEntries((await restart.store.templates()).filter(t => t.enabled).map(t => [t.id, t.reward]));
  assert.deepEqual(prices, DAILY_REWARDS);
  const day = await restart.service.day(user);
  assert.equal(day.rewardChanges.length, 1); assert.equal(day.tasks.find(t => t.id === 'daily-feeling-mention').reward, 150);
});

for (const phase of ['before', 'after']) test(`a ${phase}-commit lost day update cannot double-migrate or change wallet balances`, async () => {
  const f = await oldFixture(); await f.store.initializeDailyRewards(f.now()); let failed = false;
  f.intercept(e => { if (!failed && e.name === 'days' && e.method === 'replaceOne' && e.phase === phase && e.args[1].rewardSetVersion === 1) {
    failed = true; throw new Error('lost day update acknowledgement');
  } });
  await assert.rejects(f.service.day(user)); f.intercept(() => {});
  const reopened = await f.restart(); const day = await reopened.service.day(user);
  assert.equal(day.rewardChanges.length, 1); assert.equal(day.points.tasks, 150); assert.equal(day.points.attendance, 500);
  assert.equal((await reopened.service.balance(user)).total, 650);
});

test('late durable game proofs from a prior Saudi day keep the pre-upgrade reward even when their ledger is first created after upgrade', async () => {
  const f = await oldFixture(); const proofAt = f.now();
  f.time(nextReset(proofAt) + 1000);
  await f.store.initializeDailyRewards(f.now());
  const restarted = await f.restart();
  for (let i = 0; i < 5; i++) {
    await restarted.service.game({ id: String(100000000000001001n + BigInt(i)), gameId: String(100000000000002001n + BigInt(i)),
      at: proofAt, userId: other, guildId: c.arenaGuildId, channelId: c.gamesChannelId, botId: c.gamesBotId, eligible: true });
  }
  assert.equal((await restarted.service.balance(other)).total, 500);
  assert.equal((await restarted.service.day(other, proofAt)).tasks.find(t => t.id === 'daily-games-5').reward, 500);
  assert.equal((await restarted.service.day(other)).tasks.find(t => t.id === 'daily-games-5').reward, 5500);
});
