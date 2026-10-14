import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoStore } from '../src/store.js';
import { QuestService } from '../src/service.js';
import { createDay, seedTemplates, TASK_SET_VERSION } from '../src/domain.js';
import { dayKey, dayStart } from '../src/time.js';
import { netPoints } from '../src/point-adjustments.js';

const config = { clanGuildId: '100000000000000001', arenaGuildId: '100000000000000002',
  generalChannelId: '100000000000000003', voiceChannelId: '100000000000000004',
  feelingChannelId: '100000000000000006', lookChannelId: '100000000000000007', memberRole: '100000000000000008',
  cooldownMs: 10000, minMessageLength: 3, weekStart: 0 };
const user = '100000000000000010';
const other = '100000000000000011';
const actorId = '100000000000000099';
const at = dayStart('2026-09-07') + 3600000;
const copy = value => structuredClone(value);
const request = (userId = null, operationId = 'test-reset') => ({ userId, actorId, operationId });
const latch = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// Deterministic atomic-collection double for scope and interruption scenarios.
// The opt-in database.integration.js checks the same operations against real MongoDB.
function fixture() {
  const documents = { ship_games: [], ship_journals: [], boxes_games: [], boxes_journals: [], dot_games: [], dot_journals: [], task_boosts: [], numbers_games: [], numbers_journals: [], mines_games: [], mines_journals: [], button_games: [], button_journals: [], xo_games: [], days: [], resets: [], templates: seedTemplates(config).map(task => ({ ...task,
    clanId: config.clanGuildId, taskSetVersion: TASK_SET_VERSION })),
  settings: [{ _id: `settings:${config.clanGuildId}`, attendance: { points: 77 }, appearance: { name: 'SNOW' } }],
  panels: [{ _id: `panel:${config.clanGuildId}`, messageId: 'saved-panel' }],
  leases: [{ _id: `worker:${config.clanGuildId}`, owner: 'worker', expiresAt: at + 86400000 }] };
  const value = (doc, path) => path.split('.').reduce((current, key) => current?.[key], doc);
  const matches = (doc, filter) => Object.entries(filter).every(([key, expected]) => {
    const actual = value(doc, key);
    if (expected && typeof expected === 'object') return Object.entries(expected).every(([op, rhs]) => {
      if (op === '$gt') return actual > rhs;
      if (op === '$gte') return actual >= rhs;
      if (op === '$lte') return actual <= rhs;
      throw new Error(`Unsupported query ${op}`);
    });
    return actual === expected;
  });
  const expression = (doc, e) => {
    if (typeof e === 'string' && e.startsWith('$')) return value(doc, e.slice(1));
    if (e && typeof e === 'object') {
      if (e.$ifNull) return expression(doc, e.$ifNull[0]) ?? expression(doc, e.$ifNull[1]);
      if (e.$add) return e.$add.reduce((sum, term) => sum + expression(doc, term), 0);
      throw new Error('Unsupported test expression');
    }
    return e;
  };
  const aggregate = (input, pipeline) => pipeline.reduce((rows, stage) => {
    if (stage.$match) return rows.filter(doc => matches(doc, stage.$match));
    if (stage.$group) {
      const groups = new Map();
      for (const doc of rows) {
        const key = expression(doc, stage.$group._id);
        if (!groups.has(key)) groups.set(key, { _id: key });
        const group = groups.get(key);
        for (const [field, e] of Object.entries(stage.$group)) if (field !== '_id') {
          assert.ok(Object.hasOwn(e, '$sum'));
          group[field] = (group[field] || 0) + (expression(doc, e.$sum) || 0);
        }
      }
      return [...groups.values()];
    }
    if (stage.$addFields) return rows.map(doc => ({ ...doc, ...Object.fromEntries(Object.entries(stage.$addFields)
      .map(([field, e]) => [field, e.$add.reduce((sum, term) => sum + expression(doc, term), 0)])) }));
    if (stage.$sort) return rows.sort((a, b) => {
      for (const [key, order] of Object.entries(stage.$sort)) if (a[key] !== b[key]) return (a[key] > b[key] ? 1 : -1) * order;
      return 0;
    });
    if (Object.hasOwn(stage, '$skip')) return rows.slice(stage.$skip);
    if (Object.hasOwn(stage, '$limit')) return rows.slice(0, stage.$limit);
    throw new Error('Unsupported aggregation stage');
  }, copy(input));
  let hook = async () => {};
  const db = { collection: name => ({
    findOne: async filter => { await hook(name, 'findOne'); return copy(documents[name].find(d => matches(d, filter)) || null); },
    find: filter => {
      const cursor = { toArray: async () => copy(documents[name].filter(d => matches(d, filter))), sort: () => cursor };
      return cursor;
    },
    aggregate: pipeline => ({ toArray: async () => aggregate(documents[name], pipeline) }),
    insertOne: async doc => {
      await hook(name, 'insertOne');
      if (documents[name].some(d => d._id === doc._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
      documents[name].push(copy(doc));
    },
    replaceOne: async (filter, doc, options = {}) => {
      await hook(name, 'replaceOne');
      const i = documents[name].findIndex(d => matches(d, filter));
      if (i < 0 && options.upsert) documents[name].push(copy(doc));
      else if (i >= 0) documents[name][i] = copy(doc);
      return { matchedCount: i >= 0 ? 1 : 0 };
    },
    updateOne: async (filter, change) => {
      await hook(name, 'updateOne');
      const doc = documents[name].find(d => matches(d, filter));
      if (doc) Object.assign(doc, copy(change.$set));
      return { matchedCount: doc ? 1 : 0 };
    },
    deleteMany: async filter => {
      await hook(name, 'deleteMany');
      const before = documents[name].length;
      documents[name] = documents[name].filter(d => !matches(d, filter));
      return { deletedCount: before - documents[name].length };
    }
  }) };
  const open = () => Object.assign(Object.create(MongoStore.prototype), {
    db, config, owner: 'worker', settingsId: `settings:${config.clanGuildId}`, leaseId: `worker:${config.clanGuildId}`,
    taskSetActivatedAt: 0, resetAllAt: 0, memberResetAt: new Map()
  });
  const seed = (userId = user, clanId = config.clanGuildId) => {
    for (const day of ['2026-08-31', '2026-09-06', '2026-09-07']) {
      const state = createDay(clanId, userId, day, seedTemplates(config), at - 60000);
      state.points = { tasks: 200, attendance: 40 };
      state.tasks[0].progress = 100; state.tasks[0].completed = 1;
      state.completionLog = [{ taskId: state.tasks[0].id, points: 100 }];
      state.attendance = { milliseconds: 300000, ruleVersion: 1, carryMs: 30000 };
      state.voiceUntil = at - 1000;
      documents.days.push(state);
    }
  };
  return { store: open(), open, documents, seed, intercept: handler => { hook = handler; } };
}
const message = (userId, time, id = '200000000000000001') => ({ guildId: config.arenaGuildId, channelId: config.feelingChannelId,
  userId, eligible: true, id, at: time, content: `<@&${config.memberRole}>`, mentionedRoleIds: [config.memberRole] });
const voice = (userId, from, to) => ({ guildId: config.arenaGuildId, channelId: config.voiceChannelId, userId, eligible: true, from, to });
const rule = { enabled: true, version: 1, points: 10, intervalMs: 60000, dailyCap: 500, channelId: config.voiceChannelId };

test('reset preview includes all dates and both balances, scoped to the clan and optional user', async () => {
  const f = fixture(); f.seed(); f.seed(other); f.seed(user, 'other-clan');
  const before = copy(f.documents);
  assert.deepEqual(await f.store.resetPreview(), { _id: null, members: 2, days: 6, tasks: 1200, attendance: 240, milliseconds: 1800000 });
  assert.equal((await f.store.resetPreview(user)).members, 1);
  assert.equal((await f.store.resetPreview(user)).days, 3);
  assert.deepEqual(f.documents, before);
});

test('member reset clears every leaderboard period, progress and voice carry while preserving other members and configuration', async () => {
  const f = fixture(); f.seed(); f.seed(other); f.seed(user, 'other-clan');
  const untouched = copy({ settings: f.documents.settings, templates: f.documents.templates, panels: f.documents.panels,
    days: f.documents.days.filter(d => d.userId !== user || d.clanId !== config.clanGuildId) });
  const service = new QuestService(f.store, config, () => at);
  const result = await service.reset(request(user));
  assert.equal(result.deletedDays, 3);
  for (const period of ['daily', 'weekly', 'monthly', 'all']) {
    assert.equal((await f.store.totals(user, period, at)).total, 0);
    for (const category of ['tasks', 'attendance', 'total']) assert.equal((await f.store.ranking(period, category, at)).some(r => r._id === user), false);
  }
  assert.deepEqual({ settings: f.documents.settings, templates: f.documents.templates, panels: f.documents.panels, days: f.documents.days }, untouched);
  const state = await service.day(user);
  assert.ok(state.tasks.every(t => t.progress === 0 && t.completed === 0));
  assert.deepEqual(state.points, { tasks: 0, attendance: 0 });
  assert.equal(state.attendance.carryMs, 0); assert.equal(state.attendance.milliseconds, 0);
  assert.deepEqual(state.completionLog, []);
  assert.equal((await f.store.totals(other, 'all', at)).total, 720);
});

test('reset everyone deletes only this clan, including inactive members and historical days', async () => {
  const f = fixture(); f.seed(); f.seed(other); f.seed(user, 'other-clan');
  const otherClan = copy(f.documents.days.filter(d => d.clanId === 'other-clan'));
  assert.equal((await f.store.resetProgress(request(), at)).deletedDays, 6);
  assert.deepEqual(f.documents.days, otherClan);
  assert.deepEqual(await f.store.ranking('all', 'total', at), []);
  assert.equal(f.store.resetCutoff(user), at);
  assert.equal(f.store.resetCutoff('new-member'), at);
});

test('reset requires the current worker lease and rejects malformed member IDs without broadening the scope', async () => {
  const f = fixture(); f.seed();
  for (const userId of ['', '*', { $ne: null }, 123, 'invalid']) await assert.rejects(f.store.resetProgress(request(userId), at));
  await assert.rejects(f.store.resetProgress({ userId: user, actorId }, at));
  f.documents.leases[0].owner = 'another-worker';
  const before = copy(f.documents);
  await assert.rejects(f.store.resetProgress(request(), at), /قفل تشغيل/);
  await assert.rejects(f.store.initializeResets(at), /قفل تشغيل/);
  assert.deepEqual(f.documents, before);
});

test('reset cutoffs survive reopening; delayed messages and media from before or exactly at reset cannot restore rewards', async () => {
  const f = fixture(); f.seed();
  await f.store.resetProgress(request(user), at);
  const reopened = f.open();
  assert.equal(await reopened.initializeResets(at + 1000), 0);
  const service = new QuestService(reopened, config, () => at + 1000);
  for (const time of [at - 1000, at]) {
    assert.equal(await service.message(message(user, time)), null);
    assert.equal(await service.message({ ...message(user, time), channelId: config.lookChannelId, hasMedia: true }), null);
  }
  assert.equal(f.documents.days.length, 0);
  assert.equal((await service.message(message(user, at + 1000))).points.tasks, 150);
  // This member is free to complete the reset quest once, then normal deduplication applies.
  assert.equal((await service.message(message(user, at + 1000))).points.tasks, 150);
  assert.equal((await service.message(message(other, at - 1000))).points.tasks, 150);
});

test('voice crossing reset starts at its cutoff and never reuses old minutes or reward fractions', async () => {
  const f = fixture(); f.seed();
  await f.store.resetProgress(request(user), at);
  const service = new QuestService(f.store, config, () => at + 30000);
  await service.voice(voice(user, at - 30000, at + 30000), rule);
  let state = await service.day(user);
  assert.equal(state.tasks.find(t => t.type === 'voice').progress, 30000);
  assert.equal(state.attendance.milliseconds, 30000); assert.equal(state.attendance.carryMs, 30000);
  assert.equal(state.points.attendance, 0);
  await service.voice(voice(user, at - 30000, at), rule);
  await service.voice(voice(user, at - 30000, at + 30000), rule);
  state = await service.day(user);
  assert.equal(state.attendance.milliseconds, 30000);
  await service.voice(voice(other, at - 30000, at + 30000), rule);
  assert.equal((await service.day(other)).points.attendance, 10);
});

test('reset near Saudi midnight cannot recreate pre-reset day rewards from a queued voice sample', async () => {
  const f = fixture();
  const midnight = dayStart('2026-09-08');
  await f.store.resetProgress(request(), midnight);
  const service = new QuestService(f.store, config, () => midnight + 15000);
  await service.voice(voice(user, midnight - 15000, midnight + 15000), rule);
  assert.equal(f.documents.days.length, 1);
  assert.equal(f.documents.days[0].day, dayKey(midnight));
  assert.equal(f.documents.days[0].attendance.milliseconds, 15000);
});

test('a reset waits for an in-flight credit; queued old events are rejected and newer activity survives', async () => {
  const f = fixture(); await f.store.ensureDay(createDay(config.clanGuildId, user, dayKey(at), seedTemplates(config), at - 1000));
  const entered = latch(); const release = latch();
  f.intercept(async (name, op) => {
    if (name === 'days' && op === 'replaceOne') { entered.resolve(); await release.promise; }
  });
  const service = new QuestService(f.store, config, () => at);
  const write = service.message(message(user, at - 1));
  await entered.promise;
  const resetting = service.reset(request(user));
  const stale = service.message(message(user, at - 1));
  const fresh = service.message(message(user, at + 1, '200000000000000002'));
  assert.equal(f.documents.resets.length, 0);
  release.resolve();
  await write; await resetting;
  assert.equal(await stale, null);
  assert.equal((await fresh).points.tasks, 150);
  assert.equal((await service.day(user)).completionLog.length, 1);
});

test('a pending first-use day insert cannot resurrect a deleted document after reset', async () => {
  const f = fixture(); const entered = latch(); const release = latch();
  f.intercept(async (name, op) => { if (name === 'days' && op === 'insertOne') { entered.resolve(); await release.promise; } });
  const service = new QuestService(f.store, config, () => at);
  const viewing = service.day(user);
  await entered.promise;
  const resetting = service.reset(request());
  release.resolve();
  await viewing; await resetting;
  assert.equal(f.documents.days.length, 0);
});

test('activity arriving during deletion waits until reset completes', async () => {
  const f = fixture(); f.seed(); const entered = latch(); const release = latch();
  f.intercept(async (name, op) => { if (name === 'days' && op === 'deleteMany') { entered.resolve(); await release.promise; } });
  const service = new QuestService(f.store, config, () => at);
  const resetting = service.reset(request(user));
  await entered.promise;
  const fresh = service.message(message(user, at + 1));
  assert.equal(f.documents.days.length, 3);
  release.resolve(); await resetting; await fresh;
  assert.equal((await f.store.totals(user, 'all', at)).total, 150);
});

test('failed activity does not deadlock a later exclusive reset', async () => {
  const f = fixture();
  let fail = true;
  f.intercept(async (name, op) => { if (fail && name === 'days' && op === 'findOne') { fail = false; throw new Error('read failed'); } });
  const service = new QuestService(f.store, config, () => at);
  await assert.rejects(service.day(user), /read failed/);
  assert.equal((await service.reset(request())).pending, false);
});

test('interrupted partial deletion blocks credits and resumes only the saved scope on restart', async () => {
  const f = fixture(); f.seed(); f.seed(other); f.seed(user, 'other-clan');
  let fail = true;
  f.intercept(async (name, op) => {
    if (fail && name === 'days' && op === 'deleteMany') {
      fail = false; f.documents.days.splice(0, 1); throw new Error('interrupted delete');
    }
  });
  const service = new QuestService(f.store, config, () => at);
  await assert.rejects(service.reset(request(user)), /لم يتأكد/);
  assert.equal(service.blocked, true);
  assert.equal(f.documents.resets[0].pending, true);
  await assert.rejects(service.message(message(user, at + 1)), /متوقف/);
  await assert.rejects(service.voice(voice(other, at, at + 1000), rule), /متوقف/);
  await assert.rejects(service.day(user), /متوقف/);
  const reopened = f.open();
  assert.equal(await reopened.initializeResets(at + 1000), 1);
  assert.equal(f.documents.resets[0].pending, false);
  assert.equal(f.documents.days.length, 6);
  assert.ok(f.documents.days.every(d => d.clanId !== config.clanGuildId || d.userId !== user));
  assert.equal(reopened.resetCutoff(user), at);
  const restarted = new QuestService(reopened, config, () => at + 2000);
  assert.equal(await restarted.message(message(user, at)), null);
  assert.equal((await restarted.message(message(user, at + 2000))).points.tasks, 150);
});

test('unconfirmed completion write is retried on restart, and completed resets never delete new credits again', async () => {
  const f = fixture(); f.seed();
  let fail = true;
  f.intercept(async (name, op) => { if (fail && name === 'resets' && op === 'updateOne') { fail = false; throw new Error('lost acknowledgement'); } });
  const service = new QuestService(f.store, config, () => at);
  await assert.rejects(service.reset(request()), /لم يتأكد/);
  assert.equal(f.documents.days.length, 0); assert.equal(f.documents.resets[0].pending, true);
  const reopened = f.open();
  assert.equal(await reopened.initializeResets(at + 1000), 1);
  const restarted = new QuestService(reopened, config, () => at + 2000);
  await restarted.message(message(user, at + 2000));
  assert.equal(await reopened.initializeResets(at + 3000), 0);
  await reopened.resetProgress(request(), at + 3000); // Same operation ID: idempotent.
  assert.equal((await reopened.totals(user, 'all', at)).total, 150);
});

test('a failed intent write never starts deletion', async () => {
  const f = fixture(); f.seed(); const before = copy(f.documents.days);
  f.intercept(async (name, op) => { if (name === 'resets' && op === 'replaceOne') throw new Error('no connection'); });
  const service = new QuestService(f.store, config, () => at);
  await assert.rejects(service.reset(request()), /لم يتأكد/);
  assert.deepEqual(f.documents.days, before);
  assert.equal(f.documents.resets.length, 0);
});

test('new member and global resets keep the strongest cutoff through subsequent restarts', async () => {
  const f = fixture();
  await f.store.resetProgress(request(null, 'global-first'), at);
  await f.store.resetProgress(request(user, 'member-next'), at + 1000);
  let reopened = f.open(); await reopened.initializeResets(at + 2000);
  assert.equal(reopened.resetCutoff(user), at + 1000);
  assert.equal(reopened.resetCutoff(other), at);
  await reopened.resetProgress(request(null, 'global-next'), at + 3000);
  reopened = f.open(); await reopened.initializeResets(at + 4000);
  assert.equal(reopened.resetCutoff(user), at + 3000);
  assert.equal(reopened.resetCutoff(other), at + 3000);
});

const adjustment = (extra = {}) => ({ userId: user, actorId, operationId: '300000000000000001',
  mode: 'add', category: 'tasks', amount: 100, reason: 'مكافأة مشاركة', at, ...extra });

test('manual points update every current period and reset preview, with the same atomic audit record', async () => {
  const f = fixture(); f.seed(); f.seed(other); f.seed(user, 'other-clan');
  const untouched = copy(f.documents.days.filter(d => d.userId !== user || d.clanId !== config.clanGuildId));
  const service = new QuestService(f.store, config, () => at);
  const result = await service.adjustPoints(adjustment());
  assert.equal(result.before, 600); assert.equal(result.after, 700); assert.equal(result.totalAfter, 820);
  const state = await service.day(user);
  assert.equal(state.points.tasks, 200); assert.equal(netPoints(state).tasks, 300);
  assert.equal(state.tasks[0].progress, 100); assert.equal(state.tasks[0].completed, 1);
  assert.equal(state.adjustmentLog.length, 1);
  assert.equal(state.adjustmentLog[0].reason, 'مكافأة مشاركة');
  assert.equal(state.adjustmentLog[0].actorId, actorId);
  assert.equal((await f.store.totals(user, 'daily', at)).tasks, 300);
  assert.equal((await f.store.totals(user, 'weekly', at)).tasks, 500);
  assert.equal((await f.store.totals(user, 'monthly', at)).tasks, 500);
  assert.equal((await f.store.totals(user, 'all', at)).tasks, 700);
  assert.equal((await f.store.ranking('daily', 'tasks', at))[0]._id, user);
  assert.equal((await f.store.resetPreview(user)).tasks, 700);
  assert.deepEqual(f.documents.days.filter(d => d.userId !== user || d.clanId !== config.clanGuildId), untouched);
});

test('manual credit creates a new member day without completing a quest or inventing attendance', async () => {
  const f = fixture(); const service = new QuestService(f.store, config, () => at);
  await service.adjustPoints(adjustment({ category: 'attendance', amount: 1000 }));
  const state = await service.day(user);
  assert.ok(state.tasks.every(task => task.progress === 0 && task.completed === 0));
  assert.deepEqual(state.points, { tasks: 0, attendance: 0 });
  assert.deepEqual(state.completionLog, []);
  assert.equal(state.attendance.milliseconds, 0); assert.equal(state.attendance.carryMs, 0);
  assert.equal(netPoints(state).attendance, 1000);
});

test('debits can use historical balance; the signed adjustment belongs to its issue date', async () => {
  const f = fixture(); f.seed();
  const service = new QuestService(f.store, config, () => at);
  const result = await service.adjustPoints(adjustment({ mode: 'remove', category: 'attendance' }));
  assert.equal(result.before, 120); assert.equal(result.after, 20);
  assert.equal((await f.store.totals(user, 'daily', at)).attendance, -60);
  assert.equal((await f.store.totals(user, 'all', at)).attendance, 20);
  const state = await service.day(user);
  assert.equal(state.points.attendance, 40);
  assert.equal(state.attendance.carryMs, 30000);
  assert.equal(state.attendance.milliseconds, 300000);
});

test('insufficient funds and invalid adjustment inputs make no point or audit writes', async () => {
  const f = fixture(); f.seed(); const before = copy(f.documents);
  const service = new QuestService(f.store, config, () => at);
  for (const extra of [{ mode: 'remove', amount: 601 }, { amount: 0 }, { amount: -1 }, { amount: 1.5 },
    { amount: 1000001 }, { amount: NaN }, { userId: '*' }, { category: 'bad' }, { mode: 'set' },
    { reason: 'x'.repeat(201) }, { operationId: 'bad' }, { at: at + 5001 }]) {
    await assert.rejects(service.adjustPoints(adjustment(extra)));
  }
  assert.deepEqual(f.documents, before);
  assert.equal(service.blocked, false);
  const empty = fixture();
  await assert.rejects(new QuestService(empty.store, config, () => at).adjustPoints(adjustment({ mode: 'remove' })), /الرصيد المتاح/);
  assert.equal(empty.documents.days.length, 0);
});

test('concurrent debits are serialized and cannot overdraw the selected category', async () => {
  const f = fixture(); f.seed(); const service = new QuestService(f.store, config, () => at);
  const outcomes = await Promise.allSettled([
    service.adjustPoints(adjustment({ mode: 'remove', amount: 400 })),
    service.adjustPoints(adjustment({ mode: 'remove', amount: 400, operationId: '300000000000000002' }))
  ]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(r => r.status === 'rejected').length, 1);
  assert.equal((await f.store.totals(user, 'all', at)).tasks, 200);
  assert.equal((await service.day(user)).adjustmentLog.length, 1);
});

test('duplicate commands commit once and a reopened service returns the stored operation', async () => {
  const f = fixture(); f.seed(); const service = new QuestService(f.store, config, () => at);
  const outcomes = await Promise.all(Array.from({ length: 5 }, () => service.adjustPoints(adjustment())));
  assert.equal(outcomes.filter(r => r.duplicate).length, 4);
  const reopened = f.open(); await reopened.initializeResets(at + 1000);
  const restarted = new QuestService(reopened, config, () => at + 1000);
  assert.equal((await restarted.adjustPoints(adjustment())).duplicate, true);
  assert.equal((await restarted.day(user)).adjustmentLog.length, 1);
  assert.equal((await reopened.totals(user, 'all', at)).tasks, 700);
});

test('a concurrent automatic quest credit and manual credit both survive without changing completion limits', async () => {
  const f = fixture(); f.seed(); const service = new QuestService(f.store, config, () => at);
  await Promise.all([service.message(message(user, at)), service.adjustPoints(adjustment())]);
  const state = await service.day(user);
  assert.equal(state.points.tasks, 350); assert.equal(netPoints(state).tasks, 450);
  assert.equal(state.tasks.find(task => task.id === 'daily-feeling-mention').completed, 1);
  assert.equal((await f.store.totals(user, 'all', at)).total, 970);
  await service.message(message(user, at));
  assert.equal((await f.store.totals(user, 'all', at)).total, 970);
});

test('voice additions do not consume the attendance cap and deductions cannot reopen it', async () => {
  const f = fixture(); f.seed(); let clock = at;
  const service = new QuestService(f.store, config, () => clock);
  await service.adjustPoints(adjustment({ category: 'attendance' }));
  clock += 30000;
  await service.voice(voice(user, at, clock), { ...rule, dailyCap: 50 });
  assert.equal((await service.day(user)).points.attendance, 50);
  await service.adjustPoints(adjustment({ mode: 'remove', category: 'attendance', amount: 130,
    operationId: '300000000000000002', at: clock }));
  clock += 60000;
  await service.voice(voice(user, clock - 60000, clock), { ...rule, dailyCap: 50 });
  const state = await service.day(user);
  assert.equal(state.points.attendance, 50);
  assert.equal(netPoints(state).attendance, 20);
  assert.equal(state.attendance.milliseconds, 390000);
});

test('reset deletes manual balances and audit entries; an old command cannot recreate them', async () => {
  const f = fixture(); f.seed(); let clock = at;
  const service = new QuestService(f.store, config, () => clock);
  await service.adjustPoints(adjustment());
  clock += 1000;
  await service.reset(request(user));
  await assert.rejects(service.adjustPoints(adjustment()), /آخر ريست/);
  const state = await service.day(user);
  assert.equal(netPoints(state).total, 0); assert.equal(state.adjustmentLog, undefined);
  clock += 1000;
  await service.adjustPoints(adjustment({ at: clock, operationId: '300000000000000002' }));
  assert.equal((await f.store.totals(user, 'all', clock)).total, 100);
});

test('a reset queued during an administrative write waits and then clears the committed balance', async () => {
  const f = fixture(); f.seed(); const entered = latch(); const release = latch();
  f.intercept(async (name, op) => {
    if (name === 'days' && op === 'replaceOne') { entered.resolve(); await release.promise; }
  });
  const service = new QuestService(f.store, config, () => at);
  const writing = service.adjustPoints(adjustment()); await entered.promise;
  const resetting = service.reset(request());
  release.resolve(); await writing; await resetting;
  assert.equal((await f.store.totals(user, 'all', at)).total, 0);
  assert.equal(f.documents.days.length, 0);
});

test('failed atomic adjustment writes leave no partial audit or balance; lost acknowledgements are verified', async () => {
  const f = fixture(); f.seed(); const service = new QuestService(f.store, config, () => at);
  const before = copy(f.documents.days);
  f.intercept(async (name, op) => { if (name === 'days' && op === 'replaceOne') throw new Error('offline'); });
  await assert.rejects(service.adjustPoints(adjustment()), /offline/);
  assert.deepEqual(f.documents.days, before);
  f.intercept(async () => {});
  const commit = f.store.mutateDay.bind(f.store);
  f.store.mutateDay = async (...args) => { await commit(...args); throw new Error('lost acknowledgement'); };
  assert.equal((await service.adjustPoints(adjustment())).after, 700);
  assert.equal((await service.day(user)).adjustmentLog.length, 1);
  assert.equal((await service.adjustPoints(adjustment())).duplicate, true);
});

test('issue date remains stable across Saudi midnight and rejected expired commands do not write', async () => {
  const f = fixture(); f.seed(); const midnight = dayStart('2026-09-08');
  const service = new QuestService(f.store, config, () => midnight + 1000);
  const oldDate = adjustment({ at: midnight - 1 });
  assert.equal((await service.adjustPoints(oldDate)).day, '2026-09-07');
  assert.equal((await service.adjustPoints(oldDate)).duplicate, true);
  assert.equal((await f.store.totals(user, 'daily', midnight + 1000)).total, 0);
  assert.equal((await f.store.totals(user, 'all', midnight + 1000)).total, 820);
  await assert.rejects(service.adjustPoints(adjustment({ at: midnight - 900001,
    operationId: '300000000000000002' })), /انتهت صلاحية/);
});

test('administrative adjustments require the worker lease and remain blocked during incomplete reset', async () => {
  const f = fixture(); f.seed(); const service = new QuestService(f.store, config, () => at);
  f.documents.leases[0].owner = 'other-worker';
  await assert.rejects(service.adjustPoints(adjustment()), /قفل تشغيل/);
  service.blocked = true;
  await assert.rejects(service.adjustPoints(adjustment()), /متوقف/);
  assert.equal((await f.store.totals(user, 'all', at)).total, 720);
});
