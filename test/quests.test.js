import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMessage, applyVoice, createDay, seedTemplates, validateTemplate } from '../src/domain.js';
import { MessageFacts, hasImageOrVideo } from '../src/message-facts.js';
import { dayStart, nextReset } from '../src/time.js';
import { readConfig } from '../src/config.js';

const config = {
  clanGuildId: '100000000000000001', arenaGuildId: '100000000000000002',
  generalChannelId: '100000000000000003', voiceChannelId: '100000000000000004',
  feelingChannelId: '100000000000000006', lookChannelId: '100000000000000007', memberRole: '100000000000000008',
  cooldownMs: 10000, minMessageLength: 3
};
const at = dayStart('2026-09-07') + 3600000;
const day = () => createDay(config.clanGuildId, 'user', '2026-09-07', seedTemplates(config), at);
const event = (n, extra = {}) => ({
  id: String(200000000000000000n + BigInt(n)), at: at + n * 10000,
  channelId: config.generalChannelId, content: `رسالة مختلفة ${n}`,
  mentionedRoleIds: [], hasMedia: false, ...extra
});
const look = (n, extra = {}) => event(n, {
  channelId: config.lookChannelId, mentionedRoleIds: [config.memberRole], hasMedia: true, ...extra
});
const discordMessage = (extra = {}) => ({
  id: '200000000000000001', guildId: config.arenaGuildId, channelId: config.lookChannelId,
  author: { id: 'user', bot: false }, createdTimestamp: at, content: `<@&${config.memberRole}>`,
  mentions: { roles: new Map([[config.memberRole, {}]]) }, attachments: new Map(), embeds: [], ...extra
});

test('the four requested defaults have the exact targets, rewards, rooms and one daily completion', () => {
  const tasks = seedTemplates(config);
  assert.equal(tasks.length, 4);
  assert.deepEqual(tasks.map(t => [t.channelId, t.target, t.reward, t.repeat]), [
    [config.generalChannelId, 100, 100, 1], [config.feelingChannelId, 1, 150, 1],
    [config.lookChannelId, 1, 200, 1], [config.voiceChannelId, 180, 180, 1]
  ]);
  assert.equal(tasks.reduce((sum, t) => sum + t.reward, 0), 630);
  for (const task of tasks) validateTemplate(task);
});

test('general chat awards 100 only on the hundredth eligible message and never again that day', () => {
  const state = day();
  for (let n = 1; n <= 99; n++) applyMessage(state, event(n), config);
  assert.equal(state.points.tasks, 0);
  assert.equal(state.tasks[0].progress, 99);
  applyMessage(state, event(100), config);
  applyMessage(state, event(101), config);
  assert.equal(state.points.tasks, 100);
  assert.equal(state.tasks[0].progress, 100);
  assert.equal(state.tasks[0].completed, 1);
});

test('feeling requires an actual clan-role mention in the correct channel and rewards once', () => {
  const state = day();
  const feeling = n => event(n, { channelId: config.feelingChannelId, content: `<@&${config.memberRole}>` });
  assert.equal(applyMessage(state, feeling(1), config), false);
  assert.equal(applyMessage(state, { ...feeling(2), mentionedRoleIds: ['100000000000000099'] }, config), false);
  applyMessage(state, { ...feeling(3), mentionedRoleIds: [config.memberRole] }, config);
  applyMessage(state, { ...feeling(4), mentionedRoleIds: [config.memberRole] }, config);
  assert.equal(state.points.tasks, 150);
  assert.equal(state.tasks[1].completed, 1);
  assert.equal(state.tasks[2].progress, 0);
});

test('look requires media and the clan-role mention together in one message', () => {
  const state = day();
  assert.equal(applyMessage(state, look(1, { hasMedia: false }), config), false);
  assert.equal(applyMessage(state, look(2, { mentionedRoleIds: [] }), config), false);
  assert.equal(applyMessage(state, look(3, { mentionedRoleIds: ['100000000000000099'] }), config), false);
  assert.equal(state.tasks[2].progress, 0);
  assert.equal(applyMessage(state, look(4), config), true);
  assert.equal(applyMessage(state, look(4), config), false);
  assert.equal(applyMessage(state, look(5), config), false);
  assert.equal(state.points.tasks, 200);
});

test('rapid general, feeling and look messages advance their own quests', () => {
  const state = day();
  applyMessage(state, event(1), config);
  applyMessage(state, event(2, { at: at + 10001, channelId: config.feelingChannelId, mentionedRoleIds: [config.memberRole] }), config);
  applyMessage(state, look(3, { at: at + 10002 }), config);
  assert.equal(state.points.tasks, 350);
  assert.equal(state.tasks[0].progress, 1);
});

test('three cumulative voice hours award 180 once and do not mix with attendance points', () => {
  const state = day();
  const rule = { enabled: false, channelId: config.voiceChannelId };
  applyVoice(state, { channelId: config.voiceChannelId, from: at, to: at + 90 * 60000 }, rule);
  applyVoice(state, { channelId: config.voiceChannelId, from: at + 120 * 60000, to: at + 209 * 60000 }, rule);
  assert.equal(state.points.tasks, 0);
  applyVoice(state, { channelId: config.voiceChannelId, from: at + 209 * 60000, to: at + 210 * 60000 }, rule);
  applyVoice(state, { channelId: config.voiceChannelId, from: at + 210 * 60000, to: at + 220 * 60000 }, rule);
  assert.equal(state.points.tasks, 180);
  assert.equal(state.points.attendance, 0);
  assert.equal(state.tasks[3].completed, 1);
});

test('all four rewards total 630 and all four reset at Saudi midnight with independent member progress', () => {
  const state = day();
  for (let n = 1; n <= 100; n++) applyMessage(state, event(n), config);
  applyMessage(state, event(101, { channelId: config.feelingChannelId, mentionedRoleIds: [config.memberRole] }), config);
  applyMessage(state, look(102), config);
  applyVoice(state, { channelId: config.voiceChannelId, from: at, to: at + 180 * 60000 }, { enabled: false });
  assert.equal(state.points.tasks, 630);
  assert.equal(state.completionLog.length, 4);
  assert.ok(state.tasks.every(t => t.completed === 1));
  const midnight = Date.parse('2026-09-07T21:00:00Z');
  assert.equal(nextReset(midnight - 1), midnight);
  const next = createDay(config.clanGuildId, 'user', '2026-09-08', seedTemplates(config), midnight);
  const other = createDay(config.clanGuildId, 'other', state.day, seedTemplates(config), at);
  for (const fresh of [next, other]) {
    assert.ok(fresh.tasks.every(t => t.completed === 0 && t.progress === 0));
    assert.equal(fresh.points.tasks, 0);
  }
  assert.equal(state.points.tasks, 630);
});

test('media detection accepts image/video attachments and media embeds but rejects text, audio and arbitrary links', () => {
  for (const file of [{ contentType: 'image/png' }, { contentType: 'video/mp4' }, { name: 'SPOILER_photo.JPG' }, { filename: 'clip.webm' }]) {
    assert.equal(hasImageOrVideo(discordMessage({ attachments: new Map([['file', file]]) })), true);
  }
  for (const file of [{ contentType: 'audio/ogg', name: 'sound.ogg' }, { contentType: 'text/plain', name: 'fake.png' }, { name: 'notes.txt' }]) {
    assert.equal(hasImageOrVideo(discordMessage({ attachments: new Map([['file', file]]) })), false);
  }
  for (const embed of [{ image: { url: 'https://example.invalid/image.png' } }, { video: { url: 'https://example.invalid/video.mp4' } }, { type: 'gifv', url: 'https://example.invalid/gif' }]) {
    assert.equal(hasImageOrVideo(discordMessage({ embeds: [embed] })), true);
  }
  assert.equal(hasImageOrVideo(discordMessage({ content: 'https://example.invalid/image.png' })), false);
  assert.equal(hasImageOrVideo(discordMessage({ embeds: [{ type: 'rich', thumbnail: { url: 'https://example.invalid/logo.png' } }] })), false);
});

test('message facts use Discord role-mention metadata rather than role names or raw text', () => {
  const facts = new MessageFacts(() => at);
  const result = facts.created(discordMessage({ mentions: { roles: new Map() } }));
  assert.deepEqual(result.mentionedRoleIds, []);
  assert.deepEqual(facts.created(discordMessage()).mentionedRoleIds, [config.memberRole]);
});

test('a delayed media preview can complete the original look message only once', () => {
  const facts = new MessageFacts(() => at + 1000);
  const state = day();
  const first = facts.created(discordMessage(), true);
  assert.equal(applyMessage(state, first, config), false);
  const preview = { id: first.id, embeds: [{ type: 'video', video: { url: 'https://example.invalid/clip' } }] };
  const updated = facts.updated(preview);
  assert.equal(updated.content, '');
  assert.equal(updated.at, first.at);
  assert.equal(updated.mediaOnly, true);
  assert.equal(applyMessage(state, updated, config), true);
  assert.equal(state.points.tasks, 200);
  assert.equal(facts.updated(preview), null);
});

test('editing to add media or a mention later cannot satisfy the original message', () => {
  const facts = new MessageFacts(() => at);
  const message = discordMessage();
  facts.created(message, true);
  assert.equal(facts.updated({ ...message, editedTimestamp: at + 1, embeds: [{ image: { url: 'https://example.invalid/i' } }] }), null);
  assert.equal(facts.pending.size, 0);
  facts.created(discordMessage({ mentions: { roles: new Map() } }), true);
  const update = facts.updated({ ...message, embeds: [{ image: { url: 'https://example.invalid/i' } }] });
  assert.deepEqual(update.mentionedRoleIds, []);
  assert.equal(applyMessage(day(), update, config), false);
});

test('expired previews, deleted messages and disconnected observations cannot credit a reward', () => {
  let clock = at;
  const facts = new MessageFacts(() => clock);
  const message = discordMessage();
  const preview = { ...message, embeds: [{ image: { url: 'https://example.invalid/i' } }] };
  facts.created(message, true);
  clock += 120001;
  assert.equal(facts.updated(preview), null);
  clock = at; facts.created(message, true); facts.forget(message.id);
  assert.equal(facts.updated(preview), null);
  facts.created(message, true); facts.clear();
  assert.equal(facts.updated(preview), null);
});

test('new rooms and the role are required configuration instead of guessed Discord IDs', () => {
  const env = { OBSERVER_MODE: 'official', DISCORD_BOT_TOKEN: 'fixture', MONGODB_URI: 'mongodb://example.invalid/test',
    CLAN_GUILD_ID: config.clanGuildId, ARENA_GUILD_ID: config.arenaGuildId,
    GENERAL_CHANNEL_ID: config.generalChannelId, CLAN_CHAT_CHANNEL_ID: '100000000000000005', CLAN_VOICE_CHANNEL_ID: config.voiceChannelId,
    CLAN_MEMBER_ROLE_ID: config.memberRole, FEELING_CHANNEL_ID: config.feelingChannelId, LOOK_CHANNEL_ID: config.lookChannelId };
  assert.equal(readConfig(env).lookChannelId, config.lookChannelId);
  for (const key of ['FEELING_CHANNEL_ID', 'LOOK_CHANNEL_ID', 'CLAN_MEMBER_ROLE_ID']) {
    assert.throws(() => readConfig({ ...env, [key]: '' }), new RegExp(key));
  }
});

test('invalid mention/media conditions cannot be attached to voice tasks', () => {
  const task = seedTemplates(config)[3];
  assert.throws(() => validateTemplate({ ...task, requiresMedia: true }), /الرسائل/);
  assert.throws(() => validateTemplate({ ...task, requiredRoleId: config.memberRole }), /الرسائل/);
  assert.throws(() => validateTemplate({ ...seedTemplates(config)[2], requiredRoleId: 'bad' }), /رتبة/);
});
