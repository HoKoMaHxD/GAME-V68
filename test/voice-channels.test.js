import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import { applyMessage, applyVoice, createDay, seedTemplates } from '../src/domain.js';
import { clanVoiceChannels, taskChannels, trackedVoiceChannels, readVoiceSnapshot } from '../src/voice-channels.js';
import { QuestService } from '../src/service.js';
import { VoiceTracker } from '../src/voice.js';
import { checkSourceChannel, createHandler, tasksEmbed } from '../src/commands.js';
import { nextReset } from '../src/time.js';

const config = {
  clanGuildId: '100000000000000001', arenaGuildId: '100000000000000002',
  generalChannelId: '100000000000000003', voiceChannelId: '100000000000000004',
  feelingChannelId: '100000000000000006', lookChannelId: '100000000000000007',
  memberRole: '100000000000000008', secondVoiceChannelId: '100000000000000009',
  thirdVoiceChannelId: '100000000000000012',
  cooldownMs: 10000, minMessageLength: 3
};
const at = Date.parse('2026-09-07T12:00:00Z');
const userId = '100000000000000010';
const otherRoom = '100000000000000011';
const oneRoom = { ...config, secondVoiceChannelId: null, thirdVoiceChannelId: null };
const rule = (extra = {}) => ({ channelId: config.voiceChannelId, enabled: true, version: 1,
  points: 10, intervalMs: 60000, dailyCap: 500, minPeople: 1,
  ignoreMuted: false, ignoreDeafened: true, ...extra });
const day = () => createDay(config.clanGuildId, userId, '2026-09-07', seedTemplates(oneRoom), at);
const voice = (channelId, from, to) => ({ guildId: config.arenaGuildId, userId, eligible: true, channelId, from, to });

class MemoryStore {
  constructor() { this.days = new Map(); this.templateReads = 0; }
  async getDay(id) { return structuredClone(this.days.get(id) || null); }
  async templates() { this.templateReads++; return seedTemplates(oneRoom); }
  async ensureDay(state) {
    if (!this.days.has(state._id)) this.days.set(state._id, structuredClone(state));
    return this.getDay(state._id);
  }
  async mutateDay(id, fn) {
    const state = await this.getDay(id);
    if (fn(state)) { state.revision++; this.days.set(id, state); }
    return this.getDay(id);
  }
}

test('extra voice rooms are optional, validate IDs and deduplicate all three rooms', () => {
  const env = { OBSERVER_MODE: 'official', DISCORD_BOT_TOKEN: 'fixture', MONGODB_URI: 'mongodb://example.invalid/test',
    CLAN_GUILD_ID: config.clanGuildId, ARENA_GUILD_ID: config.arenaGuildId,
    GENERAL_CHANNEL_ID: config.generalChannelId, CLAN_CHAT_CHANNEL_ID: '100000000000000005', CLAN_VOICE_CHANNEL_ID: config.voiceChannelId,
    FEELING_CHANNEL_ID: config.feelingChannelId, LOOK_CHANNEL_ID: config.lookChannelId, CLAN_MEMBER_ROLE_ID: config.memberRole };
  assert.deepEqual(clanVoiceChannels(readConfig(env)), [config.voiceChannelId]);
  assert.deepEqual(clanVoiceChannels(readConfig({ ...env, CLAN_VOICE_CHANNEL_ID_2: '  ' })), [config.voiceChannelId]);
  assert.deepEqual(clanVoiceChannels(readConfig({ ...env, CLAN_VOICE_CHANNEL_ID_2: ` ${config.secondVoiceChannelId} ` })),
    [config.voiceChannelId, config.secondVoiceChannelId]);
  assert.deepEqual(clanVoiceChannels(readConfig({ ...env, CLAN_VOICE_CHANNEL_ID_2: config.voiceChannelId })), [config.voiceChannelId]);
  assert.throws(() => readConfig({ ...env, CLAN_VOICE_CHANNEL_ID_2: 'room-name' }), /CLAN_VOICE_CHANNEL_ID_2/);
  assert.equal(readConfig(env).thirdVoiceChannelId, null);
  assert.deepEqual(clanVoiceChannels(readConfig({ ...env, CLAN_VOICE_CHANNEL_ID_3: '  ' })), [config.voiceChannelId]);
  assert.deepEqual(clanVoiceChannels(readConfig({ ...env, CLAN_VOICE_CHANNEL_ID_3: ` ${config.thirdVoiceChannelId} ` })),
    [config.voiceChannelId, config.thirdVoiceChannelId]);
  assert.deepEqual(clanVoiceChannels(readConfig({ ...env, CLAN_VOICE_CHANNEL_ID_3: config.voiceChannelId })), [config.voiceChannelId]);
  const withSecond = { ...env, CLAN_VOICE_CHANNEL_ID_2: config.secondVoiceChannelId };
  assert.deepEqual(clanVoiceChannels(readConfig({ ...withSecond, CLAN_VOICE_CHANNEL_ID_3: config.secondVoiceChannelId })),
    [config.voiceChannelId, config.secondVoiceChannelId]);
  assert.deepEqual(clanVoiceChannels(readConfig({ ...withSecond, CLAN_VOICE_CHANNEL_ID_3: config.thirdVoiceChannelId })),
    [config.voiceChannelId, config.secondVoiceChannelId, config.thirdVoiceChannelId]);
  assert.throws(() => readConfig({ ...env, CLAN_VOICE_CHANNEL_ID_3: 'room-name' }), /CLAN_VOICE_CHANNEL_ID_3/);
});

test('60 minutes in each of three clan rooms completes the existing three-hour quest exactly once', () => {
  const state = day();
  applyVoice(state, voice(config.voiceChannelId, at, at + 60 * 60000), rule({ enabled: false }), config);
  applyVoice(state, voice(config.secondVoiceChannelId, at + 60 * 60000, at + 120 * 60000), rule({ enabled: false }), config);
  applyVoice(state, voice(config.thirdVoiceChannelId, at + 120 * 60000, at + 179 * 60000), rule({ enabled: false }), config);
  assert.equal(state.points.tasks, 0);
  applyVoice(state, voice(config.thirdVoiceChannelId, at + 179 * 60000, at + 180 * 60000), rule({ enabled: false }), config);
  applyVoice(state, voice(config.voiceChannelId, at + 180 * 60000, at + 240 * 60000), rule({ enabled: false }), config);
  assert.equal(state.tasks.length, 4);
  assert.equal(state.tasks[3].progress, 180 * 60000);
  assert.equal(state.tasks[3].completed, 1);
  assert.equal(state.points.tasks, 180);
  assert.equal(state.points.attendance, 0);
  assert.equal(state.completionLog.length, 1);
});

test('attendance anchored to the third room shares fractions and one daily cap across all three rooms', () => {
  const state = day();
  const capped = rule({ channelId: config.thirdVoiceChannelId, dailyCap: 15 });
  applyVoice(state, voice(config.voiceChannelId, at, at + 20000), capped, config);
  applyVoice(state, voice(config.secondVoiceChannelId, at + 20000, at + 40000), capped, config);
  applyVoice(state, voice(config.thirdVoiceChannelId, at + 40000, at + 60000), capped, config);
  assert.equal(state.points.attendance, 10);
  assert.equal(state.attendance.carryMs, 0);
  applyVoice(state, voice(config.secondVoiceChannelId, at + 60000, at + 120000), capped, config);
  applyVoice(state, voice(config.voiceChannelId, at + 120000, at + 180000), capped, config);
  assert.equal(state.points.attendance, 15);
  assert.equal(state.attendance.milliseconds, 180000);
  assert.equal(state.tasks[3].progress, 180000);
});

test('unconfigured channels do not earn clan rewards and removing the third ID preserves earned progress', () => {
  const state = day();
  applyVoice(state, voice(otherRoom, at, at + 30000), rule(), config);
  assert.equal(state.tasks[3].progress, 0);
  assert.equal(state.attendance.milliseconds, 0);
  const twoRooms = { ...config, thirdVoiceChannelId: null };
  applyVoice(state, voice(config.thirdVoiceChannelId, at + 30000, at + 60000), rule(), config);
  applyVoice(state, voice(config.thirdVoiceChannelId, at + 60000, at + 90000), rule(), twoRooms);
  assert.equal(state.tasks[3].progress, 30000);
  assert.equal(state.attendance.milliseconds, 30000);
  applyVoice(state, voice(config.secondVoiceChannelId, at + 90000, at + 120000), rule(), twoRooms);
  assert.equal(state.points.attendance, 10);
});

test('voice grouping leaves message tasks and custom voice channels bound to their own rooms', () => {
  const state = day();
  const messageTask = { ...state.tasks[0], channelId: config.voiceChannelId };
  state.tasks = [messageTask, { ...state.tasks[3], id: 'other-voice', channelId: otherRoom }];
  assert.deepEqual(taskChannels(messageTask, config), [config.voiceChannelId]);
  assert.equal(applyMessage(state, { id: '200000000000000001', at, channelId: config.secondVoiceChannelId, content: 'رسالة عامة' }, config), false);
  applyVoice(state, voice(config.secondVoiceChannelId, at, at + 60000), rule({ channelId: otherRoom }), config);
  applyVoice(state, voice(config.thirdVoiceChannelId, at + 60000, at + 90000), rule({ channelId: otherRoom }), config);
  assert.equal(state.tasks[1].progress, 0);
  assert.equal(state.points.attendance, 0);
  applyVoice(state, voice(otherRoom, at + 90000, at + 150000), rule({ channelId: otherRoom }), config);
  assert.equal(state.tasks[1].progress, 60000);
  assert.equal(state.points.attendance, 10);
});

for (const [name, channelId] of [['second', config.secondVoiceChannelId], ['third', config.thirdVoiceChannelId]]) {
test(`enabling the ${name} room after restart keeps current assignments, earned rewards and attendance fractions`, async () => {
  const db = new MemoryStore();
  const original = day();
  original.tasks[3].progress = 179 * 60000 + 30000;
  original.points.tasks = 350;
  original.points.attendance = 70;
  original.completionLog = [{ taskId: 'daily-feeling-mention', cycle: 1, points: 150, at }];
  original.attendance = { milliseconds: 450000, ruleVersion: 1, carryMs: 30000 };
  original.voiceUntil = at;
  await db.ensureDay(original);
  const service = new QuestService(db, config, () => at + 30000);
  service.templateCache = seedTemplates(oneRoom);
  await service.voice(voice(channelId, at, at + 30000), rule());
  const updated = await service.day(userId);
  assert.equal(db.templateReads, 0);
  assert.equal(updated.taskSetVersion, original.taskSetVersion);
  assert.deepEqual(updated.tasks.map(t => t.id), original.tasks.map(t => t.id));
  assert.equal(updated.tasks[3].completed, 1);
  assert.equal(updated.points.tasks, 530);
  assert.equal(updated.points.attendance, 80);
  assert.deepEqual(updated.completionLog[0], original.completionLog[0]);
  const restarted = new QuestService(db, config, () => at + 60000);
  restarted.templateCache = seedTemplates(oneRoom);
  await restarted.voice(voice(config.voiceChannelId, at, at + 30000), rule());
  assert.deepEqual(await restarted.day(userId), updated);
});
}

test('tracker moves between all three rooms and leaving credit each elapsed interval only once', async () => {
  const db = new MemoryStore();
  const service = new QuestService(db, config, () => at + 60000);
  const tracker = new VoiceTracker({ service, guildId: config.arenaGuildId });
  const member = { userId, channelId: config.voiceChannelId, bot: false };
  const members = new Set([userId]);
  await tracker.transition([member], rule(), members, at);
  await tracker.tick(at + 15000);
  await tracker.transition([{ ...member, channelId: config.secondVoiceChannelId }], rule(), members, at + 25000);
  await tracker.tick(at + 40000);
  await tracker.transition([{ ...member, channelId: config.thirdVoiceChannelId }], rule(), members, at + 45000);
  await tracker.transition([], rule(), members, at + 55000);
  await tracker.tick(at + 60000);
  const updated = await service.day(userId);
  assert.equal(updated.tasks[3].progress, 55000);
  assert.equal(updated.attendance.milliseconds, 55000);
  assert.equal(updated.attendance.carryMs, 55000);
  assert.deepEqual(updated.points, { tasks: 0, attendance: 0 });
});

test('third-room intervals crossing Saudi midnight split days and never carry yesterday progress into today', async () => {
  const midnight = nextReset(at);
  const db = new MemoryStore();
  const service = new QuestService(db, config, () => midnight + 15000);
  await service.voice(voice(config.voiceChannelId, midnight - 45000, midnight - 15000), rule());
  await service.voice(voice(config.thirdVoiceChannelId, midnight - 15000, midnight + 15000), rule());
  const previous = await service.day(userId, midnight - 1);
  const current = await service.day(userId, midnight);
  assert.equal(previous.day, '2026-09-07');
  assert.equal(current.day, '2026-09-08');
  assert.equal(previous.tasks[3].progress, 45000);
  assert.equal(previous.attendance.carryMs, 45000);
  assert.equal(current.tasks[3].progress, 15000);
  assert.equal(current.attendance.carryMs, 15000);
  assert.equal(current.tasks.length, 4);
});

test('visible voice states count with Connect denied, while hidden and untracked channels are excluded', async () => {
  const permissions = new Map([[config.voiceChannelId, true], [config.secondVoiceChannelId, true], [config.thirdVoiceChannelId, true], [otherRoom, false]]);
  const channels = new Map([...permissions].map(([id]) => [id, { id, guild: { id: config.arenaGuildId }, type: 'GUILD_VOICE',
    permissionsFor: () => ({ has: bit => bit === 1024n && permissions.get(id) }) }]));
  const states = new Map([config.voiceChannelId, config.secondVoiceChannelId, config.thirdVoiceChannelId, otherRoom, config.generalChannelId]
    .map((channelId, i) => [String(i), { id: String(i), channelId, member: { user: { id: String(i), bot: false } } }]));
  const source = { user: { id: 'observer' }, users: { cache: new Map() }, isReady: () => true, channels: { cache: channels } };
  const guild = { channels: { cache: channels }, voiceStates: { cache: states } };
  const membership = { updateArena: () => {} };
  const tracked = trackedVoiceChannels(config, rule(), [{ type: 'voice', channelId: otherRoom, enabled: false }]);
  await checkSourceChannel(source, config.arenaGuildId, config.secondVoiceChannelId, 'voice');
  await checkSourceChannel(source, config.arenaGuildId, config.thirdVoiceChannelId, 'voice');
  assert.equal(channels.get(config.secondVoiceChannelId).permissionsFor().has(1048576n), false);
  assert.equal(channels.get(config.thirdVoiceChannelId).permissionsFor().has(1048576n), false);
  assert.deepEqual(readVoiceSnapshot(guild, source, membership, tracked).map(e => e.channelId),
    [config.voiceChannelId, config.secondVoiceChannelId, config.thirdVoiceChannelId]);
  permissions.set(config.thirdVoiceChannelId, false);
  await assert.rejects(checkSourceChannel(source, config.arenaGuildId, config.thirdVoiceChannelId, 'voice'), /مشاهدة/);
  assert.deepEqual(readVoiceSnapshot(guild, source, membership, tracked).map(e => e.channelId),
    [config.voiceChannelId, config.secondVoiceChannelId]);
});

test('legacy four-quest display lists all three voice rooms and the current availability notice', () => {
  const state = day();
  state.tasks[3].progress = 90 * 60000;
  const embed = tasksEmbed(state, at, true, config).toJSON();
  assert.equal(embed.fields.length, 7);
  assert.equal(embed.fields[4].name, 'المهام المتاحة');
  assert.ok(embed.fields[3].value.includes(`<#${config.voiceChannelId}>`));
  assert.ok(embed.fields[3].value.includes(`<#${config.secondVoiceChannelId}>`));
  assert.ok(embed.fields[3].value.includes(`<#${config.thirdVoiceChannelId}>`));
  assert.ok(embed.fields[3].value.includes('90 / 180'));
  assert.ok(embed.fields.slice(0, 3).every(f => !f.value.includes(config.secondVoiceChannelId)));
  assert.match(embed.description, /12 ليلًا بتوقيت السعودية/);
});

test('attendance settings show all three effective channels and status checks each once', async () => {
  const validated = [];
  const responses = [];
  const handler = createHandler({ config,
    store: { settings: async () => ({ attendance: rule() }), db: { command: async () => ({ ok: 1 }) } },
    status: () => ({ bot: true, observer: true, tracking: true, memberCount: 1 }),
    validateChannel: async id => { validated.push(id); },
    onError: error => { throw error; }
  });
  const interaction = commandName => ({ isButton: () => false, isChatInputCommand: () => true,
    commandName, guildId: config.clanGuildId, user: { id: userId }, memberPermissions: { has: () => true },
    options: { getString: () => null, getInteger: () => null, getBoolean: () => null },
    deferReply: async () => {}, editReply: async value => { responses.push(value); }
  });
  await handler(interaction('اعدادات_الحضور'));
  assert.ok(responses[0].embeds[0].toJSON().description.includes(`<#${config.voiceChannelId}>`));
  assert.ok(responses[0].embeds[0].toJSON().description.includes(`<#${config.secondVoiceChannelId}>`));
  assert.ok(responses[0].embeds[0].toJSON().description.includes(`<#${config.thirdVoiceChannelId}>`));
  await handler(interaction('حالة_البوت'));
  assert.equal(validated.filter(id => id === config.secondVoiceChannelId).length, 1);
  assert.equal(validated.filter(id => id === config.voiceChannelId).length, 1);
  assert.equal(validated.filter(id => id === config.thirdVoiceChannelId).length, 1);
});
