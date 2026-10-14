import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import Selfbot from 'discord.js-selfbot-v13';
import { buildCommands, tasksEmbed, createHandler, checkSourceChannel } from '../src/commands.js';
import { createDay, seedTemplates, defaultGameTemplate } from '../src/domain.js';
import { splitChatTemplates, LEGACY_CHAT_TASK_ID } from '../src/split-chat-tasks.js';

test('all slash commands serialize with valid names and manageable options', () => {
  const commands = buildCommands();
  assert.equal(commands.length, 50);
  assert.deepEqual(commands.find(c => c.name === 'اعدادات_الحضور').options.map(o => o.name), ['اقل_عدد', 'تجاهل_الميوت', 'تجاهل_الديفن']);
  for (const c of commands) {
    assert.match(c.name, /^[-_\p{L}\p{N}]{1,32}$/u);
    assert.equal(c.dm_permission, false);
    assert.ok(c.description.length <= 100);
    for (const sub of c.options || []) {
      let optionalSeen = false;
      for (const option of sub.options || []) {
        if (!option.required) optionalSeen = true;
        if (option.required) assert.equal(optionalSeen, false);
      }
    }
  }
});
test('administration is discoverable for delegated roles and guarded at runtime', () => {
  const commands = buildCommands();
  assert.equal(commands.find(x => x.name === 'ادارة_المهام').default_member_permissions, null);
});
test('maximum-size task embed fits Discord 6000-character limit', () => {
  const config = { generalChannelId: '100000000000000001', voiceChannelId: '100000000000000002',
    clanChatChannelId: '100000000000000005', gamesChannelId: '1142961202004234330',
    feelingChannelId: '100000000000000006', lookChannelId: '100000000000000007', memberRole: '100000000000000008',
    attendance: { enabled: true, dailyCap: 1000000, points: 100000, intervalMs: 86400000, version: 1 } };
  const tasks = [...splitChatTemplates(config, 0), ...seedTemplates(config).filter(t => t.id !== LEGACY_CHAT_TASK_ID),
    defaultGameTemplate(config, 0)].map(t => ({ ...t, title: 'ا'.repeat(100),
    target: t.type === 'voice' ? 1440 : t.type === 'games' ? 1000 : 100000, repeat: t.type === 'games' ? 1 : 20 }));
  const state = createDay('clan', 'user', '2026-09-06', tasks, Date.now());
  const embed = tasksEmbed(state, Date.now(), true, config);
  assert.ok(embed.length <= 6000);
  assert.equal(state.tasks.length, 6);
  assert.equal(embed.toJSON().fields.length, 9);
});
test('both installed client libraries initialize without logging in', async () => {
  const bot = new Client({ intents: [GatewayIntentBits.Guilds] });
  const source = new Selfbot.Client({ makeCache: Selfbot.Options.cacheWithLimits({ MessageManager: 0 }), captchaRetryLimit: 0 });
  assert.equal(source.isReady(), false);
  await bot.destroy(); source.destroy();
});
test('source validation uses a permission bit compatible with both libraries', async () => {
  for (const has of [bit => bit === 1024n]) {
    const channel = { guild: { id: 'arena' }, type: 'GUILD_VOICE', permissionsFor: () => ({ has }) };
    const source = { isReady: () => true, channels: { cache: new Map([['100000000000000001', channel]]) } };
    assert.equal(await checkSourceChannel(source, 'arena', '100000000000000001', 'voice'), channel);
    await assert.rejects(checkSourceChannel(source, 'other', '100000000000000001', 'voice'));
    await assert.rejects(checkSourceChannel(source, 'arena', '100000000000000001', 'messages'));
  }
});
test('unauthorized admin command does not mutate state', async () => {
  let denied = false;
  const handler = createHandler({ config: { clanGuildId: 'clan' }, store: {}, service: {}, isMember: () => true });
  await handler({
    isButton: () => false, isChatInputCommand: () => true, commandName: 'ادارة_المهام', guildId: 'clan',
    memberPermissions: { has: () => false }, user: { id: 'member' }, reply: async () => { denied = true; }
  });
  assert.equal(denied, true);
});
