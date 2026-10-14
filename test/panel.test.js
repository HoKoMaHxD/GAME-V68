import { parseRankAction, rankPanel } from '../src/activity-views.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { PanelManager, panelPayload, parseSetup, parsePanelAction, createSetupMessageHandler } from '../src/panel.js';
import { createHandler } from '../src/commands.js';
import { createDay } from '../src/domain.js';

const guildId = '100000000000000001';
const userId = '100000000000000002';
const channelId = '100000000000000003';
const otherChannelId = '100000000000000004';
const botId = '100000000000000009';
const errorCode = code => Object.assign(new Error('Discord error'), { code });

function fixture() {
  let at = 1000000, saved = null, nextId = 1;
  const sent = [], removed = [], edited = [], errors = [], channels = new Map();
  const options = { canRun: true, failSave: false, uncertainCommit: false, appearance: {} };
  const store = {
    getPanel: async () => structuredClone(saved),
    savePanel: async state => {
      if (options.failSave) throw new Error('DB offline');
      saved = structuredClone(state);
      if (options.uncertainCommit) { options.uncertainCommit = false; throw new Error('Acknowledgement lost'); }
    }
  };
  const makeChannel = id => {
    const messages = new Map();
    const channel = {
      id, guildId, type: ChannelType.GuildText, permissions: true, failSend: false, failDelete: false,
      permissionsFor: () => ({ has: () => channel.permissions }),
      messages: { fetch: async id => { if (!messages.has(id)) throw errorCode(10008); return messages.get(id); } },
      send: async payload => {
        if (channel.failSend) throw errorCode(50013);
        const message = { id: `message-${nextId++}`, author: { id: botId },
          components: payload.components.map(c => c.toJSON()),
          edit: async payload => {
            if (channel.failEdit) throw errorCode(50013);
            message.components = payload.components.map(c => c.toJSON());
            edited.push(payload);
          },
          delete: async () => {
            if (channel.failDelete) throw errorCode(50013);
            if (!messages.delete(message.id)) throw errorCode(10008);
            removed.push(message.id);
          }
        };
        messages.set(message.id, message); sent.push({ ...message, channelId: id });
        return message;
      }, live: messages
    };
    channels.set(id, channel);
    return channel;
  };
  const channel = makeChannel(channelId);
  const bot = { user: { id: botId }, channels: { fetch: async id => {
    if (!channels.has(id)) throw errorCode(10003); return channels.get(id);
  } } };
  const args = { bot, store, guildId, canRun: () => options.canRun, clock: () => at, onError: e => errors.push(e),
    getAppearance: async () => structuredClone(options.appearance) };
  const manager = new PanelManager(args);
  return { manager, args, store, channel, makeChannel, channels, sent, removed, edited, errors, options,
    now: () => at, advance: ms => { at += ms; }, saved: () => saved };
}

test('setup text accepts default, custom and Arabic minutes', () => {
  assert.deepEqual(parseSetup('setup'), { minutes: 60 });
  assert.deepEqual(parseSetup('  SETUP 30 '), { minutes: 30 });
  assert.deepEqual(parseSetup('setup ٣٠'), { minutes: 30 });
  assert.deepEqual(parseSetup('setup ۶۰'), { minutes: 60 });
  assert.equal(parseSetup('I want setup'), null);
  assert.equal(parseSetup('setup 30 ignored words'), null);
});
test('setup panel matches the rank message with rank and notification buttons and no former task buttons', () => {
  const appearance = { name: 'SNOW', thumbnailUrl: 'https://example.com/logo.png' };
  const payload = panelPayload(60, appearance);
  const expected = rankPanel(appearance);
  const serialize = value => ({ ...value, embeds: value.embeds.map(e => {
    const data = e.toJSON(); delete data.timestamp; return data;
  }), components: value.components.map(row => row.toJSON()) });
  assert.deepEqual(serialize(payload), serialize(expected));
  const buttons = payload.components.flatMap(row => row.toJSON().components);
  assert.equal(payload.components.length, 1);
  assert.ok(payload.components.every(row => row.toJSON().components.length <= 5));
  assert.deepEqual(buttons.map(b => b.label), ['ترتيبي الشخصي', 'تنبيه', 'توب البنك']);
  assert.equal(new Set(buttons.map(b => b.custom_id)).size, 3);
  assert.equal(buttons.every(b => b.custom_id.length <= 100), true);
  assert.equal(buttons.every(b => parsePanelAction(b.custom_id) || parseRankAction(b.custom_id) || ['clan-notifications:toggle', 'clan-bank:open'].includes(b.custom_id)), true);
});
test('setup persists channel, message and custom schedule', async () => {
  const f = fixture(); await f.manager.setup(channelId, 30);
  assert.equal(f.sent.length, 1);
  assert.equal(f.saved().channelId, channelId);
  assert.equal(f.saved().messageId, f.sent[0].id);
  assert.equal(f.saved().nextRefreshAt, f.now() + 30 * 60000);
});
test('due timer replaces one panel and does not resend early', async () => {
  const f = fixture(); await f.manager.setup(channelId, 1);
  f.advance(59999); await f.manager.tick(); assert.equal(f.sent.length, 1);
  f.advance(1); await f.manager.tick();
  assert.equal(f.sent.length, 2); assert.deepEqual(f.removed, [f.sent[0].id]);
  assert.equal(f.channel.live.size, 1); assert.equal(f.saved().messageId, f.sent[1].id);
});
test('restarted manager retains schedule and restores one overdue panel', async () => {
  const f = fixture(); await f.manager.setup(channelId, 30);
  const restarted = new PanelManager(f.args);
  f.advance(60000); await restarted.tick({ checkMessage: true }); assert.equal(f.sent.length, 1);
  f.advance(5 * 60 * 60000); await restarted.tick({ checkMessage: true });
  assert.equal(f.sent.length, 2); assert.equal(f.channel.live.size, 1);
  assert.equal(f.saved().intervalMinutes, 30);
});
test('manually deleted panel is restored without waiting for its deadline', async () => {
  const f = fixture(); await f.manager.setup(channelId, 60);
  f.channel.live.delete(f.saved().messageId);
  await f.manager.tick({ checkMessage: true });
  assert.equal(f.sent.length, 2); assert.equal(f.channel.live.size, 1);
});
test('send failure keeps the previous usable panel and saved reference', async () => {
  const f = fixture(); await f.manager.setup(channelId, 1);
  const old = structuredClone(f.saved());
  f.channel.failSend = true; f.advance(60000);
  await assert.rejects(f.manager.tick());
  assert.deepEqual(f.saved(), old); assert.equal(f.removed.length, 0); assert.equal(f.channel.live.size, 1);
});
test('failed database save rolls back only the newly sent panel', async () => {
  const f = fixture(); await f.manager.setup(channelId, 1);
  const oldId = f.saved().messageId;
  f.options.failSave = true; f.advance(60000);
  await assert.rejects(f.manager.tick());
  assert.equal(f.saved().messageId, oldId);
  assert.equal(f.channel.live.size, 1); assert.ok(f.channel.live.has(oldId));
  assert.deepEqual(f.removed, [f.sent[1].id]);
});
test('uncertain database acknowledgement does not delete a committed replacement', async () => {
  const f = fixture(); await f.manager.setup(channelId, 1);
  f.options.uncertainCommit = true; f.advance(60000); await f.manager.tick();
  assert.equal(f.saved().messageId, f.sent[1].id);
  assert.ok(f.channel.live.has(f.saved().messageId)); assert.equal(f.channel.live.size, 1);
});
test('failed old-message deletion is retried and cannot multiply panels indefinitely', async () => {
  const f = fixture(); await f.manager.setup(channelId, 1);
  f.channel.failDelete = true; f.advance(60000); await f.manager.tick();
  assert.equal(f.channel.live.size, 2); assert.equal(f.saved().staleMessages.length, 1);
  f.advance(60000); await f.manager.tick(); await f.manager.tick();
  assert.equal(f.sent.length, 2);
  f.channel.failDelete = false; await f.manager.tick();
  assert.equal(f.channel.live.size, 1); assert.equal(f.saved().staleMessages.length, 0);
});
test('simultaneous timer invocations cannot post duplicate replacements', async () => {
  const f = fixture(); await f.manager.setup(channelId, 1); f.advance(60000);
  await Promise.all(Array.from({ length: 20 }, () => f.manager.tick()));
  assert.equal(f.sent.length, 2); assert.equal(f.channel.live.size, 1);
});
test('setup moves the single panel to another clan text channel', async () => {
  const f = fixture(); const other = f.makeChannel(otherChannelId);
  await f.manager.setup(channelId); await f.manager.setup(otherChannelId, 45);
  assert.equal(f.channel.live.size, 0); assert.equal(other.live.size, 1);
  assert.equal(f.saved().channelId, otherChannelId); assert.equal(f.saved().intervalMinutes, 45);
});
test('invalid channel, permissions and periods cannot post a panel', async () => {
  const f = fixture();
  for (const minutes of [0, -1, 1.5, 1441, NaN]) assert.throws(() => f.manager.setup(channelId, minutes));
  f.channel.permissions = false; await assert.rejects(f.manager.setup(channelId));
  f.channel.permissions = true; f.channel.guildId = 'other'; await assert.rejects(f.manager.setup(channelId));
  f.channel.guildId = guildId; f.channel.type = ChannelType.GuildVoice; await assert.rejects(f.manager.setup(channelId));
  assert.equal(f.sent.length, 0);
});
test('cleanup refuses to delete another author or unrelated bot message', async () => {
  const f = fixture(); await f.manager.setup(channelId);
  const id = f.saved().messageId;
  const message = f.channel.live.get(id);
  message.author.id = userId;
  await assert.rejects(f.manager.remove({ channelId, messageId: id }));
  message.author.id = botId; message.components = [];
  await assert.rejects(f.manager.remove({ channelId, messageId: id }));
  assert.equal(f.channel.live.size, 1);
});
test('loss of active-worker permission stops scheduled posts', async () => {
  const f = fixture(); await f.manager.setup(channelId, 1); f.advance(60000);
  f.options.canRun = false; await f.manager.tick();
  assert.equal(f.sent.length, 1);
});
test('empty setup state is idle instead of creating unsolicited panels', async () => {
  const f = fixture(); await f.manager.tick({ checkMessage: true }); assert.equal(f.sent.length, 0);
});
test('appearance edit changes the current panel without reposting or resetting its schedule', async () => {
  const f = fixture(); await f.manager.setup(channelId, 30);
  const saved = structuredClone(f.saved());
  f.options.appearance = { name: 'ICE', color: 0, revision: 1, imageUrl: 'https://example.com/banner.png' };
  await f.manager.refreshAppearance();
  assert.equal(f.sent.length, 1); assert.equal(f.removed.length, 0); assert.equal(f.edited.length, 1);
  assert.equal(f.saved().messageId, saved.messageId); assert.equal(f.saved().nextRefreshAt, saved.nextRefreshAt);
  assert.equal(f.saved().appearanceRevision, 1);
  assert.equal(f.edited[0].embeds[0].toJSON().image.url, f.options.appearance.imageUrl);
  assert.equal(f.edited[0].embeds[0].toJSON().color, 0xffffff);
});
test('new manager upgrades the old panel layout and retries an appearance edit after a permission failure', async () => {
  const f = fixture(); await f.manager.setup(channelId, 30);
  const scheduled = f.saved().nextRefreshAt;
  const message = f.channel.live.get(f.saved().messageId);
  message.components = [{ type: 1, components: [
    { custom_id: 'clan-panel:v1:mine', label: 'مهامي' }, { custom_id: 'clan-panel:v1:shop', label: 'المتجر' }
  ] }, { type: 1, components: [{ custom_id: 'clan-rank:open', label: 'ترتيبي الشخصي' }] }];
  await f.store.savePanel({ ...f.saved(), layoutVersion: 7 });
  const restarted = new PanelManager(f.args);
  await restarted.tick({ checkMessage: true });
  assert.equal(f.saved().layoutVersion, 10); assert.equal(f.edited.length, 1); assert.equal(f.sent.length, 1);
  assert.equal(f.saved().nextRefreshAt, scheduled);
  assert.equal(message.components.some(row => row.components.some(button => button.custom_id === 'clan-panel:v1:points')), false);
  assert.equal(message.components.some(row => row.components.some(button => button.custom_id.startsWith('clan-panel:'))), false);
  assert.equal(message.components.length, 1);
  assert.deepEqual(message.components[0].components.map(button => button.custom_id), ['clan-rank:open', 'clan-notifications:toggle', 'clan-bank:open']);
  f.options.appearance = { revision: 5, name: 'SNOW NEW' }; f.channel.failEdit = true;
  await assert.rejects(restarted.refreshAppearance());
  assert.equal(f.saved().appearanceRevision, 0);
  f.channel.failEdit = false; await restarted.tick();
  assert.equal(f.saved().appearanceRevision, 5); assert.equal(f.edited.length, 2);
});
test('appearance refresh cannot edit another author or unrelated message and an unset panel stays idle', async () => {
  const f = fixture(); assert.equal(await f.manager.refreshAppearance(), null); assert.equal(f.sent.length, 0);
  await f.manager.setup(channelId);
  const message = f.channel.live.get(f.saved().messageId);
  message.author.id = userId; await assert.rejects(f.manager.refreshAppearance());
  message.author.id = botId; message.components = []; await assert.rejects(f.manager.refreshAppearance());
  assert.equal(f.edited.length, 0);
});
test('text setup ignores outsiders, bots and non-admins', async () => {
  let calls = 0, denied = 0;
  const handler = createSetupMessageHandler({ config: { clanGuildId: guildId }, panel: { setup: async () => { calls++; return {}; } } });
  const message = { guildId, channelId, content: 'setup 30', author: { id: userId },
    member: { permissions: { has: () => false } }, reply: async () => { denied++; } };
  await handler({ ...message, guildId: 'other' }); await handler({ ...message, author: { bot: true } });
  await handler(message); assert.equal(calls, 0); assert.equal(denied, 1);
  await handler({ ...message, member: { permissions: { has: bit => bit === PermissionFlagsBits.ManageGuild } } });
  assert.equal(calls, 1); assert.equal(denied, 1);
});

function interaction(id, owner = userId) {
  const calls = { reply: [], deferReply: [], deferUpdate: [], edit: [] };
  return { calls, user: { id: owner }, guildId, customId: id,
    isButton: () => true, isChatInputCommand: () => false,
    reply: async p => calls.reply.push(p), deferReply: async p => calls.deferReply.push(p),
    deferUpdate: async () => calls.deferUpdate.push(true), editReply: async p => calls.edit.push(p)
  };
}
function commandContext() {
  const calls = { user: [], ranking: [] };
  return { calls, ctx: { config: { clanGuildId: guildId, weekStart: 0 },
    isMember: () => true, status: () => ({ tracking: true }), onError: e => { throw e; },
    service: { day: async id => { calls.user.push(id); return { userId: id, day: '2026-09-27', tasks: [], points: { tasks: 0, attendance: 0 } }; } },
    store: { settings: async () => ({}), activityRanking: async (...args) => { calls.ranking.push(args); return [{ _id: userId, chat: 10, voice: 20000 }]; },
      activityPosition: async (id, period, metric) => ({ position: 1, value: metric === 'chat' ? 10 : 20000 }) }
  } };
}
test('shared my-tasks button displays the clicking member without modifying the panel', async () => {
  const f = commandContext(); const click = interaction('clan-panel:v1:mine');
  await createHandler(f.ctx)(click);
  assert.deepEqual(f.calls.user, [userId]);
  assert.deepEqual(click.calls.deferReply[0], { flags: MessageFlags.Ephemeral });
  assert.equal(click.calls.deferUpdate.length, 0);
  assert.equal(click.calls.edit[0].components[0].components[0].data.label, 'تحديث المهام');
  assert.equal(click.calls.edit[0].embeds[0].data.title, 'مهامك اليومية');
});
test('current and legacy top buttons request activity metrics and display private period controls', async () => {
  for (const category of ['total', 'attendance', 'tasks', 'chat', 'voice']) {
    const f = commandContext(); const click = interaction(`clan-panel:v1:${category}`);
    await createHandler(f.ctx)(click);
    assert.equal(f.calls.ranking[0][0], 'all');
    assert.deepEqual(f.calls.ranking.map(args => args[1]), ['voice', 'chat']);
    assert.equal(click.calls.deferReply[0].flags, MessageFlags.Ephemeral);
    assert.equal(click.calls.deferUpdate.length, 0);
    const controls = click.calls.edit[0].components.flatMap(row => row.toJSON().components);
    const ids = controls.map(x => x.custom_id);
    assert.equal(new Set(ids).size, ids.length); assert.equal(ids.every(x => x.length <= 100), true);
    assert.equal(controls.length, 7); assert.equal(controls.every(x => parseRankAction(x.custom_id)), true);
  }
});
test('period and pagination controls survive a fresh handler with no collector state', async () => {
  const f = commandContext();
  const click = interaction(`clan-top:v1:${userId}:attendance:weekly:2:next`);
  await createHandler(f.ctx)(click);
  assert.equal(f.calls.ranking[0][0], 'weekly'); assert.equal(f.calls.ranking[0][1], 'voice');
  assert.equal(f.calls.ranking[0][3].skip, 5); assert.equal(click.calls.deferUpdate.length, 1);
  assert.equal(click.calls.deferReply.length, 0);
});
test('another member cannot edit someone else’s leaderboard response', async () => {
  const f = commandContext();
  const click = interaction(`clan-top:v1:${userId}:tasks:all:1:period`, '100000000000000099');
  await createHandler(f.ctx)(click);
  assert.equal(f.calls.ranking.length, 0); assert.equal(click.calls.reply.length, 1);
});
test('non-clan member cannot use the public my-tasks button to bypass role eligibility', async () => {
  const f = commandContext(); f.ctx.isMember = () => false;
  f.ctx.config.memberRole = 'arena-role';
  const click = interaction('clan-panel:v1:mine'); await createHandler(f.ctx)(click);
  assert.equal(f.calls.user.length, 0); assert.equal(click.calls.reply.length, 1);
  assert.match(click.calls.reply[0].content, /سيرفر أرينا/);
});
test('malformed top routes and out-of-range pages are ignored', () => {
  for (const id of [`clan-top:v1:${userId}:tasks:all:0`, `clan-top:v1:${userId}:tasks:all:101`,
    `clan-top:v1:${userId}:invalid:all:1`, `clan-top:v1:${userId}:tasks:never:1`, 'clan-panel:v1:delete']) {
    assert.equal(parsePanelAction(id), null);
  }
});
