import test from 'node:test';
import assert from 'node:assert/strict';
import { DailyQuestViews, createDailyQuestHandler, dailyQuestPayload } from '../src/daily-quest-views.js';
import { createBankLeaderboardHandler, bankPagePayload, parseBankAction } from '../src/bank-leaderboard.js';
import { createTextCommands } from '../src/experience-commands.js';
import { dailyFixture, dailyConfig as c } from './helpers/daily-fixture.js';
import { fixture, at, user, other, snowflake } from './helpers/shop-fixture.js';
import { nextReset } from '../src/time.js';
import { MessageFlags } from 'discord.js';

const channelId = '100000000000000060';
function interaction({ name = 'مهامي', id, owner = user } = {}) {
  const calls = [];
  return { calls, commandName: id ? undefined : name, customId: id, guildId: c.clanGuildId, channelId,
    user: { id: owner }, isButton: () => !!id, isChatInputCommand: () => !id,
    reply: async p => calls.push(['reply', p]), deferReply: async p => calls.push(['deferReply', p]),
    deferUpdate: async () => calls.push(['deferUpdate']), editReply: async p => { calls.push(['editReply', p]); return { id: snowflake(at) }; } };
}

test('all bank participants have stable positions across pages, including zeros; stale pages clamp after reset', async () => {
  const f = await fixture();
  for (let i = 0; i < 27; i++) await f.seed(String(BigInt(user) + BigInt(i)), i < 20 ? 1000 - Math.floor(i / 2) : 0);
  const seen = [], pages = [];
  for (let i = 1; i <= 3; i++) {
    const view = await f.service.bankLeaderboard(user, i); pages.push(view); seen.push(...view.rows.map(r => r._id));
    assert.equal(view.count, 27); assert.equal(view.pages, 3); assert.equal(view.self.position, 1);
  }
  assert.equal(seen.length, 27); assert.equal(new Set(seen).size, 27);
  assert.equal(pages[2].rows.length, 7); assert.ok(pages[2].rows.every(r => r.total === 0));
  assert.equal((await f.service.bankLeaderboard(String(BigInt(user) + 26n), 3)).self.position, 27);
  const payload = bankPagePayload(pages[2], user, {}), buttons = payload.components[0].toJSON().components;
  assert.match(payload.embeds[0].data.description, /#21/); assert.equal(buttons[0].disabled, false); assert.equal(buttons[2].disabled, true);
  assert.deepEqual(buttons.map(b => b.label), ['السابق', 'تحديث', 'التالي']);
  const first = bankPagePayload(pages[0], user, {}).components[0].toJSON().components;
  assert.equal(first[0].disabled, true); assert.equal(first[2].disabled, false);
  await f.service.reset({ target: 'all', actorId: other, operationId: 'reset-bank-pages', userId: null });
  const empty = await f.service.bankLeaderboard(user, 3);
  assert.equal(empty.page, 1); assert.equal(empty.pages, 1); assert.equal(empty.count, 0); assert.equal(empty.self.position, null);
  assert.equal(parseBankAction(`clan-bank:v1:${user}:0:next`), null);
});

test('shared bank button opens a private result anywhere in the clan; pagination is owner-bound and read-only', async () => {
  const f = await fixture(); await f.seed(user, 1000); const before = structuredClone(f.documents);
  const handler = createBankLeaderboardHandler({ config: c, service: f.service, store: f.store });
  const open = interaction({ id: 'clan-bank:open' }); open.channelId = c.lookChannelId;
  await handler(open); assert.deepEqual(open.calls[0], ['deferReply', { flags: MessageFlags.Ephemeral }]);
  const page = interaction({ id: `clan-bank:v1:${user}:1:refresh` }); await handler(page);
  assert.equal(page.calls[0][0], 'deferUpdate');
  const wrong = interaction({ id: `clan-bank:v1:${user}:1:next`, owner: other }); await handler(wrong);
  assert.equal(wrong.calls[0][0], 'reply'); assert.equal(wrong.calls.length, 1);
  const foreign = interaction({ id: 'clan-bank:open' }); foreign.guildId = c.arenaGuildId; await handler(foreign);
  assert.equal(foreign.calls[0][0], 'reply'); assert.deepEqual(f.documents, before);
});

test('مهامي, مهمتي and old quest buttons show all daily tasks without acceptance; owners and guilds remain enforced', async () => {
  const f = await dailyFixture(); const handler = createDailyQuestHandler({ ...f, config: c, isMember: id => id === user, status: () => ({ tracking: true }) });
  for (const options of [{ id: `clan-daily-open:v1:${user}` }, { id: 'clan-economy:quest' },
    { id: `clan-quest:v1:${user}:${snowflake(at)}:accept` }, { id: `clan-quest:v1:${user}:${snowflake(at)}:reject` },
    { id: `clan-daily:v1:${user}:refresh` }]) {
    const i = interaction(options); await handler(i);
    const payload = i.calls.at(-1)[1]; assert.equal(payload.embeds[0].data.title, 'مهامك اليومية');
    assert.ok(payload.embeds[0].data.fields.length >= 6);
    assert.deepEqual(payload.components[0].components.map(b => b.data.label), ['تحديث المهام']);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
  }
  assert.equal((await f.service.day(user)).points.tasks, 0);
  const denied = interaction({ id: `clan-daily:v1:${user}:refresh`, owner: other }); await handler(denied);
  assert.equal(denied.calls.length, 1); assert.equal(denied.calls[0][0], 'reply');
  const foreign = interaction(); foreign.guildId = c.arenaGuildId; await handler(foreign); assert.equal(foreign.calls.length, 1);
});

test('Arabic text aliases resolve مهامي and توب البنك into the same registered commands', async () => {
  const received = []; const handler = createTextCommands(i => received.push(i.commandName), c);
  for (const content of ['مهامي', '-مهامي', '!مهمتي', 'توب البنك', '- توب البنك', 'توب_البنك']) {
    await handler({ guildId: c.clanGuildId, channelId, content, id: snowflake(at), author: { id: user } });
  }
  assert.deepEqual(received, ['مهامي', 'مهامي', 'مهمتي', 'توب_البنك', 'توب_البنك', 'توب_البنك']);
});

test('public daily card updates on progress and Saudi midnight, survives restart, and cleans up deleted messages', async () => {
  const f = await dailyFixture(); let connected = true; const edits = [], errors = [];
  const bot = { user: { id: '100000000000000098' } };
  const message = { id: snowflake(at), author: bot.user, edit: async p => { edits.push(p); return message; } };
  let missing = false;
  bot.channels = { fetch: async () => ({ guildId: c.clanGuildId, messages: { fetch: async () => {
    if (missing) throw Object.assign(new Error('deleted'), { code: 10008 }); return message;
  } } }) };
  const options = { bot, config: c, store: f.store, service: f.service, clock: f.now,
    isMember: () => true, status: () => ({ tracking: connected }), onError: e => errors.push(e) };
  const manager = new DailyQuestViews(options);
  const initial = await manager.payload(user);
  await manager.track({ user: { id: user }, channelId }, message, initial);
  await manager.tick(); assert.equal(edits.length, 0);
  f.time(at + 1000); await f.post(); await manager.tick();
  assert.match(edits.at(-1).embeds[0].data.fields[1].value, /1 \/ 50/);
  const after = edits.length; await manager.tick(); assert.equal(edits.length, after);
  const restart = new DailyQuestViews(options); connected = false; await restart.tick();
  assert.match(edits.at(-1).embeds[0].data.description, /متوقف حاليًا/);
  connected = true; f.time(nextReset(at)); await restart.tick();
  assert.match(edits.at(-1).embeds[0].data.fields[1].value, /0 \/ 50/);
  assert.equal(f.documents.quest_views.length, 1);
  missing = true; await f.post(); await restart.tick();
  assert.equal(f.documents.quest_views.length, 0); assert.equal(errors.length, 0);
});

test('a legacy private daily card expires before its webhook and re-arms when refreshed', async () => {
  const f = await dailyFixture(); const edits = [];
  const manager = new DailyQuestViews({ ...f, config: c, bot: {}, clock: f.now,
    isMember: () => true, status: () => ({ tracking: true }) });
  const message = { id: snowflake(at), flags: { has: () => true } };
  const i = { user: { id: user }, channelId, editReply: async p => edits.push(p) };
  await manager.track(i, message, await manager.payload(user));
  f.time(at + 14 * 60000); await manager.tick();
  assert.match(edits.at(-1).embeds[0].data.footer.text, /استئناف التحديث/); assert.equal(manager.privateViews.size, 0);
  await manager.track(i, message, await manager.payload(user)); assert.equal(manager.privateViews.size, 1);
});
