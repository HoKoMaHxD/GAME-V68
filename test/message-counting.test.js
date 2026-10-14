import test from 'node:test';
import assert from 'node:assert/strict';
import { createDay, seedTemplates, applyMessage } from '../src/domain.js';
import { splitChatTemplates, CHAT_TASK_IDS, LEGACY_CHAT_TASK_ID } from '../src/split-chat-tasks.js';
import { QuestService } from '../src/service.js';
import { readConfig } from '../src/config.js';
import { MessageFacts } from '../src/message-facts.js';
import { clanMessageChannels, messageChannelsFor, isUserMessage } from '../src/message-channels.js';
import { tasksEmbed, rulesEmbed } from '../src/presentation.js';
import { createHandler } from '../src/commands.js';
import { dayKey, dayStart } from '../src/time.js';

const config = { clanGuildId: '100000000000000001', arenaGuildId: '100000000000000002',
  generalChannelId: '100000000000000003', voiceChannelId: '100000000000000004', clanChatChannelId: '100000000000000005',
  feelingChannelId: '100000000000000006', lookChannelId: '100000000000000007', memberRole: '100000000000000008',
  // These old values must no longer silently exclude messages after upgrading.
  cooldownMs: 10000, minMessageLength: 3 };
const user = '100000000000000010';
const other = '100000000000000011';
const at = dayStart('2026-09-08') + 3600000;
const id = n => String(400000000000000000n + BigInt(n));
const event = (n, extra = {}) => ({ id: id(n), userId: user, guildId: config.arenaGuildId, eligible: true,
  channelId: config.generalChannelId, at, content: '.', ...extra });
const state = (tasks = seedTemplates(config)) => createDay(config.clanGuildId, user, dayKey(at), tasks, at);
const splitTemplates = () => [...splitChatTemplates(config, at), ...seedTemplates(config).filter(t => t.id !== LEGACY_CHAT_TASK_ID)];
const copy = v => structuredClone(v);
const latch = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// Service scheduling is tested independently of MongoDB's already tested CAS.
class MemoryStore {
  constructor(tasks = seedTemplates(config)) {
    this.days = new Map(); this.tasks = tasks; this.active = new Map(); this.peak = new Map(); this.beforeWrite = async () => {};
  }
  async templates() { return copy(this.tasks); }
  async getDay(id) { return copy(this.days.get(id)); }
  async ensureDay(initial) { if (!this.days.has(initial._id)) this.days.set(initial._id, copy(initial)); return this.getDay(initial._id); }
  async mutateDay(id, mutation) {
    const active = (this.active.get(id) || 0) + 1;
    this.active.set(id, active); this.peak.set(id, Math.max(active, this.peak.get(id) || 0));
    try {
      await this.beforeWrite(id);
      const draft = await this.getDay(id);
      if (mutation(draft)) { draft.revision++; this.days.set(id, copy(draft)); }
      return this.getDay(id);
    } finally { this.active.set(id, this.active.get(id) - 1); }
  }
}

test('Arena clan text ID is required and distinct while obsolete filtering variables remain ignored', () => {
  const env = { OBSERVER_MODE: 'official', DISCORD_BOT_TOKEN: 'fixture', MONGODB_URI: 'mongodb://example.invalid/test',
    CLAN_GUILD_ID: config.clanGuildId, ARENA_GUILD_ID: config.arenaGuildId, GENERAL_CHANNEL_ID: config.generalChannelId,
    FEELING_CHANNEL_ID: config.feelingChannelId, LOOK_CHANNEL_ID: config.lookChannelId,
    CLAN_MEMBER_ROLE_ID: config.memberRole, CLAN_VOICE_CHANNEL_ID: config.voiceChannelId,
    MESSAGE_COOLDOWN_SECONDS: '10', MIN_MESSAGE_LENGTH: '3' };
  assert.throws(() => readConfig(env), /CLAN_CHAT_CHANNEL_ID/);
  assert.throws(() => readConfig({ ...env, CLAN_CHAT_CHANNEL_ID: config.generalChannelId }), /يختلف/);
  const read = readConfig({ ...env, CLAN_CHAT_CHANNEL_ID: ` ${config.clanChatChannelId} ` });
  assert.equal(read.clanChatChannelId, config.clanChatChannelId);
  assert.equal(read.cooldownMs, undefined); assert.equal(read.minMessageLength, undefined);
  assert.deepEqual(clanMessageChannels({ ...config, clanChatChannelId: config.generalChannelId }), [config.generalChannelId]);
  assert.throws(() => readConfig({ ...env, CLAN_CHAT_CHANNEL_ID: '#clan-chat' }), /CLAN_CHAT_CHANNEL_ID/);
});

test('fifty general messages and fifty clan messages complete two independent daily quests', () => {
  const day = state(splitTemplates());
  for (let n = 1; n <= 50; n++) assert.equal(applyMessage(day, event(n), config), true);
  assert.equal(day.tasks[0].progress, 50); assert.equal(day.tasks[1].progress, 0);
  assert.equal(day.points.tasks, 50); assert.equal(day.completionLog.length, 1);
  for (let n = 51; n <= 100; n++) assert.equal(applyMessage(day, event(n, { channelId: config.clanChatChannelId }), config), true);
  assert.equal(day.tasks.length, 5); assert.equal(day.tasks[1].progress, 50);
  assert.equal(day.points.tasks, 100); assert.equal(day.completionLog.length, 2);
  for (let n = 101; n < 150; n++) for (const channelId of [config.generalChannelId, config.clanChatChannelId]) {
    assert.equal(applyMessage(day, event(n, { channelId }), config), false);
  }
  assert.equal(day.points.tasks, 100);
});

test('every message counter uses its own channel including mention and media quests', () => {
  const tasks = seedTemplates(config);
  assert.deepEqual(messageChannelsFor(tasks[0], config), [config.generalChannelId]);
  assert.deepEqual(messageChannelsFor({ ...tasks[0], channelId: config.clanChatChannelId }, config), [config.clanChatChannelId]);
  assert.deepEqual(messageChannelsFor(tasks[1], config), [config.feelingChannelId]);
  assert.deepEqual(messageChannelsFor({ ...tasks[2], channelId: config.generalChannelId }, config), [config.generalChannelId]);
  const day = state();
  applyMessage(day, event(1, { channelId: config.clanChatChannelId, mentionedRoleIds: [config.memberRole], hasMedia: true }), config);
  assert.equal(day.tasks[0].progress, 0); assert.equal(day.tasks[1].progress, 0); assert.equal(day.tasks[2].progress, 0);
  assert.equal(applyMessage(day, event(2, { channelId: '100000000000000099' }), config), false);
});

test('out-of-order unique messages count exactly once in their assigned chat and after JSON persistence', () => {
  let day = state();
  for (const n of [9, 2, 7, 1, 5]) assert.equal(applyMessage(day, event(n), config), true);
  assert.equal(day.tasks[0].progress, 5);
  day = JSON.parse(JSON.stringify(day));
  for (const n of [1, 5, 9, 2, 7]) assert.equal(applyMessage(day, event(n), config), false);
  assert.equal(applyMessage(day, event(3), config), true);
  assert.equal(day.tasks[0].progress, 6);
});

test('short text, repeated text, emoji, stickers and attachments do not require readable content', () => {
  const day = state(); const facts = new MessageFacts(() => at);
  for (const [index, content] of ['ا', '.', '💙', 'نفس النص', 'نفس النص', '', undefined].entries()) {
    const raw = { author: { id: user, bot: false }, type: index % 2 ? 'REPLY' : 0, guildId: config.arenaGuildId,
      channelId: config.generalChannelId, id: id(index + 1), createdTimestamp: at, content,
      attachments: new Map(), stickers: new Map(), mentions: { roles: new Map() } };
    assert.equal(isUserMessage(raw), true);
    assert.equal(applyMessage(day, facts.created(raw), config), true);
  }
  assert.equal(day.tasks[0].progress, 7);
});

test('system, webhook and bot messages are excluded in both SDK representations', async () => {
  const store = new MemoryStore(); const service = new QuestService(store, config, () => at);
  for (const extra of [{ bot: true }, { system: true }, { webhook: true }, { guildId: 'other-guild' }, { eligible: false }]) {
    assert.equal(await service.message(event(1, extra)), null);
  }
  const base = { author: { id: user }, type: 0 };
  for (const extra of [{ author: { id: user, bot: true } }, { webhookId: 'webhook' }, { system: true },
    { type: 7 }, { type: 'GUILD_MEMBER_JOIN' }, { type: 21 }, { type: 'THREAD_STARTER_MESSAGE' }]) {
    assert.equal(isUserMessage({ ...base, ...extra }), false);
  }
  assert.equal(isUserMessage({ ...base, type: 19 }), true);
  assert.equal(isUserMessage({ ...base, type: 'REPLY' }), true);
  assert.equal(store.days.size, 0);
});

test('a 200-message burst is serialized per member without losing writes to revision contention', async () => {
  const store = new MemoryStore(seedTemplates(config).map(t => t.id === 'daily-general-100' ? { ...t, target: 200 } : t));
  const service = new QuestService(store, config, () => at);
  await Promise.all(Array.from({ length: 200 }, (_, i) => service.message(event(200 - i))));
  const day = await service.day(user);
  assert.equal(day.tasks[0].progress, 200); assert.equal(day.points.tasks, 100);
  assert.equal(day.messageReceipts.length, 200);
  assert.equal(store.peak.get(day._id), 1);
  assert.equal(service.gate.serial.size, 0);
});

test('slow writes do not turn messages received on time into stale messages while queued', async () => {
  let clock = at; const store = new MemoryStore();
  const service = new QuestService(store, config, () => clock);
  store.beforeWrite = async () => { clock = at + 150000; };
  await Promise.all(Array.from({ length: 20 }, (_, i) => service.message(event(i + 1))));
  assert.equal((await service.day(user)).tasks[0].progress, 20);
  // A newly received replay is stale; it must still be rejected before mutation.
  assert.equal(await service.message(event(1)), null);
  assert.equal((await service.day(user)).tasks[0].progress, 20);
});

test('a busy member does not block another member and a failed write does not wedge the queue', async () => {
  const entered = latch(); const release = latch(); const store = new MemoryStore();
  const service = new QuestService(store, config, () => at);
  let fail = true;
  store.beforeWrite = async key => {
    if (key.endsWith(user) && fail) { entered.resolve(); await release.promise; fail = false; throw new Error('simulated write failure'); }
  };
  const first = service.message(event(1)); const handled = assert.rejects(first, /write failure/);
  await entered.promise;
  const second = service.message(event(2));
  assert.equal((await service.message(event(3, { userId: other }))).tasks[0].progress, 1);
  release.resolve(); await handled; await second;
  assert.equal((await service.day(user)).tasks[0].progress, 1);
});

test('legacy progress and old anti-spam data survive; only new messages use the new counting policy', () => {
  const day = state();
  day.tasks[0].progress = 40; day.tasks[0].lastMessageId = id(50);
  day.points.attendance = 80; day.attendance.carryMs = 12000;
  day.messageChannels = { [config.generalChannelId]: { last: { id: id(50), at }, hashes: [{ hash: 'legacy', at }] } };
  assert.equal(applyMessage(day, event(50), config), false);
  assert.equal(applyMessage(day, event(49), config), false);
  for (const n of [60, 52, 59, 51]) assert.equal(applyMessage(day, event(n), config), true);
  assert.equal(day.tasks[0].progress, 44); assert.equal(day.tasks[0].messageIdFloor, id(50));
  assert.equal(day.points.attendance, 80); assert.equal(day.attendance.carryMs, 12000);
  assert.equal(day.tasks[1].progress, 0);
});

test('one message may advance an ordinary quest then its delayed media quest without duplicate ordinary credit', () => {
  const tasks = seedTemplates(config);
  tasks[0].channelId = config.lookChannelId;
  const day = state(tasks);
  const first = event(1, { channelId: config.lookChannelId, mentionedRoleIds: [config.memberRole] });
  applyMessage(day, first, config);
  assert.equal(day.tasks[0].progress, 1); assert.equal(day.tasks[2].progress, 0);
  applyMessage(day, { ...first, mediaOnly: true, hasMedia: true }, config);
  assert.equal(day.tasks[0].progress, 1); assert.equal(day.tasks[2].completed, 1);
  assert.equal(day.points.tasks, 200);
  assert.equal(applyMessage(day, { ...first, hasMedia: true }, config), false);
  assert.equal(day.messageReceipts.length, 1); assert.equal(day.messageReceipts[0].taskIds.length, 2);
});

test('receipt eviction keeps boundary messages deduplicated and rejects older replays', () => {
  const day = state();
  applyMessage(day, event(1), config, at);
  applyMessage(day, event(2, { at: at + 120000 }), config, at + 120000);
  assert.equal(applyMessage(day, event(1), config, at + 120000), false);
  applyMessage(day, event(3, { at: at + 120001 }), config, at + 120001);
  assert.equal(day.messageReceipts.some(item => item.id === id(1)), false);
  assert.equal(applyMessage(day, event(1), config, at + 120001), false);
  assert.equal(day.tasks[0].progress, 3);
});

test('late messages around Saudi midnight belong to their original day without affecting the new day', async () => {
  const midnight = dayStart('2026-09-09'); const store = new MemoryStore();
  const service = new QuestService(store, config, () => midnight + 1000);
  await service.message(event(2, { at: midnight }));
  await service.message(event(1, { at: midnight - 1 }));
  assert.equal((await service.day(user, midnight - 1)).tasks[0].progress, 1);
  assert.equal((await service.day(user, midnight)).tasks[0].progress, 1);
  await service.message(event(1, { at: midnight - 1 }));
  assert.equal((await service.day(user, midnight - 1)).tasks[0].progress, 1);
});

test('quest view shows separate room links, targets and progress for the two chat tasks', () => {
  const day = state(splitTemplates()); day.tasks[0].progress = 42;
  const embed = tasksEmbed(day, at, true, config).toJSON();
  assert.match(embed.fields[0].name, /الشات العام/); assert.match(embed.fields[1].name, /شات الكلان/);
  assert.ok(embed.fields[0].value.includes(config.generalChannelId));
  assert.ok(!embed.fields[0].value.includes(config.clanChatChannelId));
  assert.ok(embed.fields[1].value.includes(config.clanChatChannelId));
  assert.ok(!embed.fields[1].value.includes(config.generalChannelId));
  assert.match(embed.fields[0].value, /42 \/ 50/); assert.match(embed.fields[1].value, /0 \/ 50/);
  day.tasks[0].title = 'تحدي مخصص';
  assert.match(tasksEmbed(day, at, true, config).toJSON().fields[0].name, /تحدي مخصص/);
  const description = rulesEmbed(config, null).toJSON().fields.find(field => field.name.startsWith('03')).value;
  assert.ok(description.includes(config.clanChatChannelId)); assert.match(description, /لكل شات مهمة مستقلة/);
});

test('bot status checks the configured Arena clan text chat and displays both counter channels', async () => {
  const checked = []; let response;
  const handler = createHandler({ config, store: { settings: async () => ({ attendance: { channelId: config.voiceChannelId } }),
    db: { command: async () => ({ ok: 1 }) } }, service: {}, isMember: () => true,
    validateChannel: async (id, type) => { checked.push([id, type]); },
    status: () => ({ bot: true, observer: true, tracking: true, memberCount: 1 }), onError: error => { throw error; } });
  await handler({ isButton: () => false, isChatInputCommand: () => true, commandName: 'حالة_البوت',
    guildId: config.clanGuildId, user: { id: user }, memberPermissions: { has: () => true },
    deferReply: async () => {}, editReply: async payload => { response = payload; } });
  assert.ok(checked.some(([id, type]) => id === config.clanChatChannelId && type === 'messages'));
  assert.ok(response.embeds[0].toJSON().fields.find(field => field.name === 'شاتات مهمة الرسائل').value.includes(config.clanChatChannelId));
});

test('a concurrent mixed-channel burst preserves separate receipts and awards each 50-message task once', async () => {
  const store = new MemoryStore(splitTemplates()); const service = new QuestService(store, config, () => at);
  const events = Array.from({ length: 100 }, (_, i) => event(100 - i,
    { channelId: i % 2 ? config.generalChannelId : config.clanChatChannelId }));
  await Promise.all(events.map(e => service.message(e)));
  await Promise.all(events.map(e => service.message(e)));
  const day = await service.day(user);
  assert.deepEqual(day.tasks.slice(0, 2).map(t => t.progress), [50, 50]);
  assert.equal(day.points.tasks, 100); assert.equal(day.completionLog.length, 2);
  assert.equal(day.messageReceipts.length, 100);
  assert.ok(day.messageReceipts.every(r => r.taskIds.length === 1));
  assert.equal(store.peak.get(day._id), 1);
  const reopened = new QuestService(store, config, () => at);
  assert.equal((await reopened.day(user)).points.tasks, 100);
});
test('Saudi midnight renews both chat tasks independently while preserving yesterday rewards', async () => {
  const store = new MemoryStore(splitTemplates()); let clock = at;
  const service = new QuestService(store, config, () => clock);
  for (let n = 1; n <= 50; n++) await service.message(event(n));
  assert.equal((await service.day(user)).points.tasks, 50);
  const midnight = dayStart('2026-09-09'); clock = midnight;
  const next = await service.day(user);
  assert.deepEqual(next.tasks.slice(0, 2).map(t => t.progress), [0, 0]);
  await service.message(event(51, { at: midnight, channelId: config.clanChatChannelId }));
  assert.deepEqual((await service.day(user)).tasks.slice(0, 2).map(t => t.progress), [0, 1]);
  assert.equal((await service.day(user, at)).points.tasks, 50);
});
test('split chat tasks retain both slots when extra personal or general templates are present', () => {
  const templates = [...splitTemplates(), ...Array.from({ length: 8 }, (_, n) => ({
    ...splitTemplates()[0], id: 'extra-' + n, forUser: user, order: 100 + n
  }))];
  const day = state(templates);
  assert.equal(day.tasks.length, 5);
  assert.deepEqual(day.tasks.slice(0, 2).map(t => t.id), CHAT_TASK_IDS);
});
