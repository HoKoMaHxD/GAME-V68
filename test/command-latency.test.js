import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyFixture, dailyConfig as config } from './helpers/daily-fixture.js';
import { user, other, at, snowflake } from './helpers/shop-fixture.js';
import { VoiceTracker } from '../src/voice.js';
import { DailyQuestViews } from '../src/daily-quest-views.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const attendance = { minPeople: 1, ignoreMuted: false, ignoreDeafened: false };
const person = userId => ({ userId, channelId: config.voiceChannelId, bot: false });

test('new voice observations cannot extend the currently saving batch ahead of the ninth member', async () => {
  const blocked = deferred(), started = [];
  const ids = Array.from({ length: 9 }, (_, index) => String(index));
  const tracker = new VoiceTracker({ guildId: config.arenaGuildId, service: { voice: async event => {
    started.push(`${event.userId}:${event.from}`);
    if (event.from === 0) await blocked.promise;
  } } });
  await tracker.transition(ids.map(person), attendance, new Set(ids), 0);
  const first = tracker.tick(15000);
  await turn();
  const next = tracker.tick(30000);
  blocked.resolve();
  await Promise.all([first, next]);
  assert.ok(started.indexOf('8:0') < started.indexOf('0:15000'), started.join(', '));
});

for (const kind of ['xo', 'buttonGame', 'mini', 'memory', 'robbery']) {
  test(`a slow idle ${kind} scan does not block a balance command`, async () => {
    const f = await dailyFixture();
    await f.seed(user, 5000);
    if (kind === 'robbery') await f.store.robbery.initialize(f.now());
    const game = kind === 'robbery' ? { expire: () => f.service.expireRobberies() } : f.service[kind];
    const originalDb = f.store.db, blocked = deferred(), entered = deferred();
    const collectionName = { xo: 'xo_games', buttonGame: 'button_games', robbery: 'robbery_rounds' }[kind] || 'days';
    f.store.db = { collection(name) {
      const collection = originalDb.collection(name);
      if (name !== collectionName) return collection;
      return new Proxy(collection, { get(target, key) {
        if (key !== 'find') return typeof target[key] === 'function' ? target[key].bind(target) : target[key];
        return (...args) => {
          const cursor = target.find(...args);
          cursor.toArray = async () => { entered.resolve(); await blocked.promise; return []; };
          return cursor;
        };
        } });
    } };
    const scan = game.expire();
    await entered.promise;
    let responded = false;
    const command = f.service.balance(user).then(result => { responded = true; return result; });
    await turn();
    const beforeRelease = responded;
    blocked.resolve();
    await Promise.all([scan, command]);
    assert.equal(beforeRelease, true);
  });
}

test('a requester can flush their own observed voice time while another member has a slow save', async () => {
  const blocked = deferred(), saved = new Map();
  const tracker = new VoiceTracker({ guildId: config.arenaGuildId, service: { voice: async event => {
    if (event.userId === other) await blocked.promise;
    saved.set(event.userId, (saved.get(event.userId) || 0) + event.to - event.from);
  } } });
  await tracker.transition([person(other), person(user)], attendance, new Set([user, other]), 0);
  const first = tracker.tick(15000);
  await turn();
  const next = tracker.transition([person(other), person(user)], attendance, new Set([user, other]), 30000);
  let refreshed = false;
  const refresh = (tracker.flushUser ? tracker.flushUser(user) : next).then(() => { refreshed = true; });
  await turn();
  const beforeRelease = refreshed, ownTime = saved.get(user);
  blocked.resolve();
  await Promise.all([first, next, refresh]);
  assert.equal(beforeRelease, true);
  assert.equal(ownTime, 30000);
  assert.equal(saved.get(user), 30000);
});

test('irrelevant voice-state changes create no extra writes and leaving still stops time exactly', async () => {
  const saved = [], members = new Set([user]);
  const tracker = new VoiceTracker({ guildId: config.arenaGuildId, service: { voice: async event => saved.push(event) } });
  await tracker.transition([person(user)], attendance, members, 0);
  for (let index = 1; index <= 100; index++) {
    const snapshot = [{ ...person(user), muted: index % 2 === 0 }];
    if (tracker.observe) tracker.observe(snapshot, attendance, members, index * 100, { onlyChanges: true });
    else await tracker.transition(snapshot, attendance, members, index * 100);
  }
  await tracker.tick(15000);
  if (tracker.observe) tracker.observe([], attendance, members, 18000, { onlyChanges: true });
  else await tracker.transition([], attendance, members, 18000);
  await tracker.tick(30000);
  assert.equal(saved.length, 2);
  assert.equal(saved.reduce((total, event) => total + event.to - event.from, 0), 18000);
});

for (const privateMessage of [false, true]) {
  test(`${privateMessage ? 'private' : 'public'} quest cards edit only when their displayed progress changes`, async () => {
    const f = await dailyFixture(), edits = [];
    const bot = { user: { id: other } };
    const message = { id: snowflake(at), author: bot.user, flags: { has: () => privateMessage },
      edit: async payload => { edits.push(payload); return message; } };
    bot.channels = { fetch: async () => ({ guildId: config.clanGuildId, messages: { fetch: async () => message } }) };
    const manager = new DailyQuestViews({ ...f, config, bot, clock: f.now, isMember: () => true,
      status: () => ({ tracking: true }), onError: error => { throw error; } });
    const interaction = { user: { id: user }, channelId: '100000000000000060', editReply: async payload => edits.push(payload) };
    await manager.track(interaction, message, await manager.payload(user));
    f.time(at + 15000); await manager.tick();
    assert.equal(edits.length, 0);
    f.time(at + 30000); await f.post(); await manager.tick();
    assert.equal(edits.length, 1);
    assert.equal(edits[0].embeds[0].data.timestamp, new Date(f.now()).toISOString());
  });
}

test('idle robbery discovery still blocks an unresolved financial journal', async () => {
  const f = await dailyFixture();
  f.store.robbery.get = async () => ({ pending: { id: 'unfinished-transfer' } });
  await assert.rejects(f.service.expireRobberies(), /قيد الاستكمال/);
  assert.equal(f.service.blocked, true);
});

test('shutdown drains every interval in a manual refresh, including its later writes', async () => {
  const first = deferred(), second = deferred(), members = new Set([user]);
  const tracker = new VoiceTracker({ guildId: config.arenaGuildId, service: { voice: async event => {
    await (event.from === 0 ? first.promise : second.promise);
  } } });
  await tracker.transition([person(user)], attendance, members, 0);
  tracker.observe([person(user)], attendance, members, 15000);
  tracker.observe([person(user)], attendance, members, 30000);
  const refresh = tracker.flushUser(user);
  let drained = false;
  const stopping = tracker.drain().then(() => { drained = true; });
  await turn(); first.resolve(); await turn();
  const beforeLastWrite = drained;
  second.resolve(); await Promise.all([refresh, stopping]);
  assert.equal(beforeLastWrite, false);
  assert.equal(tracker.pending.size, 0);
});
