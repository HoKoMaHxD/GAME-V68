// Historical parser/catalog helpers remain covered here. Automatic quest delivery
// has been retired; its replacement is tested in accepted-only.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MongoStore } from '../src/store.js';
import { QuestService } from '../src/service.js';
import { createDay, seedTemplates, TASK_SET_VERSION, DEFAULT_GAME_TASK_ID, DEFAULT_GAME_TASK_VERSION } from '../src/domain.js';
import { dayStart, dayKey } from '../src/time.js';
import { splitChatTemplates, CHAT_TASK_IDS, CHAT_SPLIT_VERSION, LEGACY_CHAT_TASK_ID } from '../src/split-chat-tasks.js';

const config = {
  clanGuildId: '100000000000000001', arenaGuildId: '100000000000000002',
  generalChannelId: '100000000000000003', clanChatChannelId: '100000000000000005', voiceChannelId: '100000000000000004',
  feelingChannelId: '100000000000000006', lookChannelId: '100000000000000007', memberRole: '100000000000000008',
  gamesChannelId: '1142961202004234330', gamesBotId: '995439183650889888',
  cooldownMs: 10000, minMessageLength: 3
};
const at = dayStart('2026-09-07') + 3600000;
const copy = value => structuredClone(value);

// A collection double verifies migration scope, interrupted writes and our CAS.
// It does not replace the opt-in integration test against an actual MongoDB server.
function fixture() {
  const store = Object.create(MongoStore.prototype);
  Object.assign(store, { config, owner: 'worker', settingsId: `settings:${config.clanGuildId}`,
    leaseId: `worker:${config.clanGuildId}`, taskSetActivatedAt: 0 });
  const documents = { task_boosts: [],
    settings: [{ _id: store.settingsId, seeded: true, attendance: { points: 77, carry: 'preserved' } }],
    leases: [{ _id: store.leaseId, owner: store.owner, expiresAt: at + 45000 }],
    templates: [{ clanId: config.clanGuildId, id: 'old-custom', enabled: true, reward: 300 },
      { clanId: 'other-clan', id: 'other-task', enabled: true, taskSetVersion: TASK_SET_VERSION }], days: []
  };
  let failAfter = null;
  let failGamePublish = false;
  let failChatPublish = false;
  const matches = (document, filter) => Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object') {
      if ('$ne' in value) return document[key] !== value.$ne;
      if ('$gt' in value) return document[key] > value.$gt;
      throw new Error('Unexpected test query operator');
    }
    return document[key] === value;
  });
  const update = (document, changes) => {
    Object.assign(document, copy(changes.$set || {}));
    for (const key of Object.keys(changes.$unset || {})) delete document[key];
  };
  store.db = { collection: name => ({
    findOne: async filter => copy(documents[name].find(d => matches(d, filter)) || null),
    find: filter => ({ sort: () => ({ toArray: async () => copy(documents[name].filter(d => matches(d, filter))) }) }),
    updateOne: async (filter, changes, options = {}) => {
      if (name === 'settings' && failChatPublish && changes.$set?.chatSplitVersion) {
        failChatPublish = false; throw new Error('simulated interrupted chat publish');
      }
      if (name === 'settings' && failGamePublish && changes.$set?.defaultGameTaskVersion) {
        failGamePublish = false; throw new Error('simulated interrupted game publish');
      }
      if (name === 'templates' && failAfter !== null) {
        if (failAfter-- === 0) { failAfter = null; throw new Error('simulated interrupted migration'); }
      }
      let document = documents[name].find(d => matches(d, filter));
      if (!document && options.upsert) { document = copy(filter); documents[name].push(document); }
      if (document) update(document, changes);
    },
    updateMany: async (filter, changes) => {
      for (const document of documents[name].filter(d => matches(d, filter))) update(document, changes);
    },
    insertOne: async document => {
      if (document._id && documents[name].some(d => d._id === document._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
      documents[name].push(copy(document));
    },
    replaceOne: async (filter, replacement) => {
      const index = documents[name].findIndex(d => matches(d, filter));
      if (index < 0) return { matchedCount: 0 };
      documents[name][index] = copy(replacement);
      return { matchedCount: 1 };
    }
  }) };
  return { store, documents, interruptAfter: n => { failAfter = n; }, interruptGamePublish: () => { failGamePublish = true; }, interruptChatPublish: () => { failChatPublish = true; } };
}

test('catalog replacement requires the active worker lease', async () => {
  const f = fixture();
  f.documents.leases[0].owner = 'another-worker';
  const before = copy(f.documents);
  await assert.rejects(f.store.initializeTasks(at), /قفل تشغيل/);
  assert.deepEqual(f.documents, before);
});

test('migration replaces old and custom templates with the exact four defaults even if already seeded', async () => {
  const f = fixture();
  const attendance = copy(f.documents.settings[0].attendance);
  assert.equal(await f.store.initializeTasks(at), true);
  const active = await f.store.templates();
  assert.deepEqual(active.map(t => t.id).sort(), seedTemplates(config).map(t => t.id).sort());
  assert.ok(active.every(t => t.enabled && t.repeat === 1));
  assert.equal(active.reduce((sum, t) => sum + t.reward, 0), 630);
  const old = f.documents.templates.find(t => t.id === 'old-custom');
  assert.equal(old.enabled, false);
  assert.equal(old.archived, true);
  assert.equal(f.documents.templates.find(t => t.clanId === 'other-clan').enabled, true);
  assert.deepEqual(f.documents.settings[0].attendance, attendance);
  assert.equal(f.store.taskSetActivatedAt, at);
});

test('restarts do not reinstall the set, overwrite later edits, or change activation time', async () => {
  const f = fixture();
  await f.store.initializeTasks(at);
  f.documents.templates.find(t => t.id === 'daily-feeling-mention').reward = 175;
  const before = copy(f.documents);
  assert.equal(await f.store.initializeTasks(at + 1000), false);
  assert.deepEqual(f.documents, before);
  assert.equal(f.store.taskSetActivatedAt, at);
});

test('an interrupted migration resumes without publishing a partial set or duplicating templates', async () => {
  const f = fixture();
  f.interruptAfter(2);
  await assert.rejects(f.store.initializeTasks(at), /interrupted/);
  assert.notEqual(f.documents.settings[0].taskSetVersion, TASK_SET_VERSION);
  assert.equal(f.documents.settings[0].pendingTaskSet.at, at);
  assert.equal(await f.store.initializeTasks(at + 1000), true);
  const active = await f.store.templates();
  assert.equal(active.length, 4);
  assert.equal(new Set(active.map(t => t.id)).size, 4);
  assert.equal(f.documents.settings[0].pendingTaskSet, undefined);
  assert.equal(f.store.taskSetActivatedAt, at);
});

function legacyDay(day = '2026-09-07') {
  const state = createDay(config.clanGuildId, 'user', day, [{
    id: 'old-custom', title: 'مهمة سابقة', channelId: config.generalChannelId,
    type: 'messages', target: 1, reward: 300, repeat: 1, enabled: true
  }], at - 60000);
  delete state.taskSetVersion;
  state.tasks[0].progress = state.tasks[0].completed = 1;
  state.points = { tasks: 300, attendance: 77 };
  state.completionLog = [{ taskId: 'old-custom', cycle: 1, points: 300, at: at - 30000 }];
  state.attendance.carryMs = 12345;
  return state;
}







test('installing the daily 5-game quest preserves the base catalog, custom tasks, settings and balances', async () => {
  const f = fixture(); await f.store.initializeTasks(at);
  f.documents.templates.find(t => t.id === 'daily-feeling-mention').reward = 175;
  f.documents.templates.push({ clanId: config.clanGuildId, id: 'custom-game', type: 'games', enabled: true, taskSetVersion: TASK_SET_VERSION });
  f.documents.settings[0].appearance = { banner: 'https://example.invalid/banner.png' };
  f.documents.days.push(legacyDay());
  const before = copy(f.documents);
  assert.equal(await f.store.initializeGameTask(at + 1), true);
  const installed = (await f.store.templates()).find(t => t.id === DEFAULT_GAME_TASK_ID);
  assert.deepEqual([installed.target, installed.reward, installed.repeat, installed.channelId], [5, 500, 1, config.gamesChannelId]);
  assert.equal(installed.createdAt, at + 1); assert.equal(installed.defaultInstalledAt, at + 1);
  assert.deepEqual(f.documents.templates.filter(t => t.id !== DEFAULT_GAME_TASK_ID), before.templates);
  assert.deepEqual(f.documents.days, before.days);
  for (const key of ['attendance', 'appearance', 'taskSetVersion', 'taskSetActivatedAt']) {
    assert.deepEqual(f.documents.settings[0][key], before.settings[0][key]);
  }
  assert.equal(f.documents.settings[0].defaultGameTaskVersion, DEFAULT_GAME_TASK_VERSION);
});
test('daily game installation requires both the worker lease and initialized base catalog', async () => {
  const f = fixture();
  await assert.rejects(f.store.initializeGameTask(at), /تهيئة المهام/);
  await f.store.initializeTasks(at);
  f.documents.leases[0].owner = 'other-worker';
  const before = copy(f.documents);
  await assert.rejects(f.store.initializeGameTask(at + 1), /قفل تشغيل/);
  assert.deepEqual(f.documents, before);
});
test('game installation resumes after failure before template write or final publication without duplicates', async () => {
  for (const failPublish of [false, true]) {
    const f = fixture(); await f.store.initializeTasks(at);
    if (failPublish) f.interruptGamePublish(); else f.interruptAfter(0);
    await assert.rejects(f.store.initializeGameTask(at + 1), /interrupted/);
    assert.equal(f.documents.settings[0].defaultGameTaskVersion, undefined);
    assert.equal(f.documents.settings[0].pendingDefaultGameTask.at, at + 1);
    assert.equal(await f.store.initializeGameTask(at + 10), true);
    const games = f.documents.templates.filter(t => t.id === DEFAULT_GAME_TASK_ID);
    assert.equal(games.length, 1); assert.equal(games[0].createdAt, at + 1);
    assert.equal(f.documents.settings[0].pendingDefaultGameTask, undefined);
    assert.equal(f.documents.settings[0].defaultGameTaskInstalledAt, at + 1);
  }
});
test('ordinary restarts do not overwrite later game admin edits or activation timestamps', async () => {
  const f = fixture(); await f.store.initializeTasks(at); await f.store.initializeGameTask(at + 1);
  const game = f.documents.templates.find(t => t.id === DEFAULT_GAME_TASK_ID);
  game.reward = 600; game.enabled = false;
  const before = copy(f.documents);
  assert.equal(await f.store.initializeTasks(at + 2), false);
  assert.equal(await f.store.initializeGameTask(at + 2), false);
  assert.deepEqual(f.documents, before);
});


test('chat split installs exactly two independent templates and retains all other templates, settings and days', async () => {
  const f = fixture(); await f.store.initializeTasks(at); await f.store.initializeGameTask(at + 1);
  f.documents.templates.find(t => t.id === 'daily-feeling-mention').reward = 175;
  f.documents.days.push(legacyDay());
  f.documents.settings[0].appearance = { color: 0xaabbcc };
  const before = copy(f.documents);
  assert.equal(await f.store.initializeChatTasks(at + 2), true);
  const active = (await f.store.templates()).filter(t => t.enabled);
  assert.equal(active.length, 6);
  const pair = CHAT_TASK_IDS.map(id => active.find(t => t.id === id));
  assert.deepEqual(pair.map(t => [t.channelId, t.target, t.reward, t.repeat]), [
    [config.generalChannelId, 50, 50, 1], [config.clanChatChannelId, 50, 50, 1]
  ]);
  assert.ok(pair.every(t => t.createdAt === at + 2));
  assert.equal(f.documents.templates.find(t => t.id === LEGACY_CHAT_TASK_ID).enabled, false);
  assert.deepEqual(f.documents.templates.filter(t => !CHAT_TASK_IDS.includes(t.id) && t.id !== LEGACY_CHAT_TASK_ID),
    before.templates.filter(t => t.id !== LEGACY_CHAT_TASK_ID));
  assert.deepEqual(f.documents.days, before.days);
  for (const key of ['appearance', 'attendance', 'taskSetActivatedAt', 'taskSetVersion', 'defaultGameTaskVersion']) {
    assert.deepEqual(f.documents.settings[0][key], before.settings[0][key]);
  }
});
test('chat split requires an active lease, a initialized base set and two valid distinct room IDs', async () => {
  const f = fixture();
  await assert.rejects(f.store.initializeChatTasks(at), /تهيئة المهام/);
  await f.store.initializeTasks(at);
  for (const chatId of [undefined, 'bad', config.generalChannelId]) {
    assert.throws(() => splitChatTemplates({ ...config, clanChatChannelId: chatId }, at), /CLAN_CHAT_CHANNEL_ID/);
  }
  f.documents.leases[0].owner = 'other';
  const before = copy(f.documents);
  await assert.rejects(f.store.initializeChatTasks(at + 1), /قفل تشغيل/);
  assert.deepEqual(f.documents, before);
});
test('chat installation resumes every partial-write stage without duplicates or a changed activation time', async () => {
  for (const stage of [0, 1, 2, 'publish']) {
    const f = fixture(); await f.store.initializeTasks(at);
    if (stage === 'publish') f.interruptChatPublish(); else f.interruptAfter(stage);
    await assert.rejects(f.store.initializeChatTasks(at + 1), /interrupted/);
    assert.equal(f.documents.settings[0].chatSplitVersion, undefined);
    assert.equal(f.documents.settings[0].pendingChatSplit.at, at + 1);
    assert.equal(await f.store.initializeChatTasks(at + 2), true);
    const active = (await f.store.templates()).filter(t => t.enabled);
    assert.equal(active.length, 5);
    assert.equal(new Set(active.map(t => t.id)).size, 5);
    assert.ok(active.filter(t => CHAT_TASK_IDS.includes(t.id)).every(t => t.createdAt === at + 1));
    assert.equal(f.documents.settings[0].pendingChatSplit, undefined);
  }
});
test('restarting after chat split does not reinstall old chat or overwrite later administrator edits', async () => {
  const f = fixture(); await f.store.initializeTasks(at); await f.store.initializeGameTask(at + 1);
  await f.store.initializeChatTasks(at + 2);
  f.documents.templates.find(t => t.id === CHAT_TASK_IDS[0]).reward = 65;
  const before = copy(f.documents);
  assert.equal(await f.store.initializeTasks(at + 3), false);
  assert.equal(await f.store.initializeGameTask(at + 3), false);
  assert.equal(await f.store.initializeChatTasks(at + 3), false);
  assert.deepEqual(f.documents, before);
});
async function splitFixture({ paid = false } = {}) {
  const f = fixture(); await f.store.initializeTasks(at); await f.store.initializeGameTask(at + 1);
  const userId = '100000000000000010';
  const current = createDay(config.clanGuildId, userId, dayKey(at), await f.store.templates(), at + 2);
  const old = current.tasks.find(t => t.id === LEGACY_CHAT_TASK_ID);
  old.progress = paid ? 100 : 42; old.completed = paid ? 1 : 0;
  current.tasks.find(t => t.id === 'daily-feeling-mention').progress = 1;
  current.tasks.find(t => t.id === 'daily-feeling-mention').completed = 1;
  current.tasks.find(t => t.type === 'games').progress = 3;
  current.tasks.find(t => t.type === 'voice').progress = 60000;
  current.points = { tasks: paid ? 250 : 150, attendance: 70 };
  current.attendance = { milliseconds: 350000, ruleVersion: 1, carryMs: 45000 };
  current.completionLog = [{ taskId: 'daily-feeling-mention', cycle: 1, points: 150, at: at + 2 }];
  if (paid) current.completionLog.push({ taskId: old.id, cycle: 1, points: 100, at: at + 2 });
  current.gameReceipts = [{ gameId: '500000000000000001', messageId: '500000000000000002', at: at + 2 }];
  current.messageReceipts = [{ id: '400000000000000001', at: at + 2, taskIds: [old.id] }];
  f.documents.days.push(copy(current));
  await f.store.initializeChatTasks(at + 100);
  let clock = at + 101;
  const service = new QuestService(f.store, config, () => clock);
  service.templateCache = await f.store.templates();
  return { ...f, current, userId, service, clock: value => { clock = value; } };
}




