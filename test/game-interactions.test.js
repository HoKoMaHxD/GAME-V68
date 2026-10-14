import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fixture, at, user, other, actor, config, snowflake } from './helpers/shop-fixture.js';
import { createMiniHandler, MiniGameManager } from '../src/mini-game-commands.js';
import { createMemoryHandler, MemoryManager } from '../src/memory-commands.js';
import { createXoHandler, XoManager } from '../src/xo-commands.js';
import { createButtonHandler } from '../src/button-game-commands.js';
import { createMinesHandler } from '../src/mines-game-commands.js';
import { createNumbersHandler } from '../src/numbers-game-commands.js';
import { createBoxesHandler } from '../src/boxes-game-commands.js';
import { createDotHandler } from '../src/dot-game-commands.js';

const channelId = '100000000000000060';
const yes = async () => true;
const deferred = () => Promise.withResolvers();
const buttons = payload => payload.components?.flatMap(row => row.toJSON().components) || [];
async function setup() {
  const f = await fixture();
  for (const id of [user, other, actor]) await f.seed(id, 1000);
  return f;
}
async function solo(f, kind = 'dice', who = user, sequence = 100) {
  const game = kind === 'memory' ? f.service.memory : f.service.mini;
  const round = await game.open({ kind, id: snowflake(at, sequence), userId: who, channelId, at }, yes, (min, max) => max - 1);
  await game.bind(round, snowflake(at, sequence + 1));
  return (await game.latest(who, kind)).miniGames[kind];
}
function interaction(customId, who = user, messageId = snowflake(at, 101)) {
  const calls = [];
  return { calls, customId, id: snowflake(at, 800), createdTimestamp: at, user: { id: who },
    guildId: config.clanGuildId, channelId, message: { id: messageId }, isButton: () => !!customId,
    deferUpdate: async () => calls.push(['ack']), deferReply: async () => calls.push(['ack']),
    reply: async payload => calls.push(['reply', payload]),
    followUp: async payload => calls.push(['notice', payload]),
    editReply: async payload => { calls.push(['edit', payload]); return { id: messageId }; } };
}

test('a slow background edit cannot overwrite a newer dice result or delay its acknowledgement', async () => {
  const f = await setup(), g = await solo(f), entered = deferred(), release = deferred();
  let visible;
  const message = { author: { id: actor }, edit: async payload => { visible = payload; } };
  const bot = { user: { id: actor }, channels: { fetch: async () => {
    entered.resolve(); await release.promise;
    return { guildId: config.clanGuildId, messages: { fetch: async () => message } };
  } } };
  const manager = new MiniGameManager({ bot, service: f.service, canRun: () => true });
  const ticking = manager.tick(); await entered.promise;
  const i = interaction(`mini:v1:dice:${user}:${g.id}:0:roll`);
  i.editReply = async payload => { visible = payload; return { id: g.messageId }; };
  const clicking = createMiniHandler({ config, service: f.service, isBankMember: yes })(i);
  await nextTurn();
  const acknowledged = i.calls[0]?.[0];
  release.resolve(); await Promise.all([ticking, clicking]); await manager.drain();
  const current = (await f.service.mini.latest(user, 'dice')).miniGames.dice;
  assert.equal(acknowledged, 'ack');
  assert.equal(current.status, 'settled');
  assert.equal(current.displayRevision, current.revision);
  assert.ok(buttons(visible).every(b => b.disabled));
  assert.match(buttons(visible)[0].custom_id, new RegExp(`:${current.revision}:roll$`));
  assert.equal(f.documents.days[0].miniReceipts.length, 1);
});

test('starting an open solo game again links to its original message instead of moving the buttons', async () => {
  const f = await setup(), g = await solo(f);
  const i = interaction(null, user, snowflake(at, 999)); i.commandName = 'نرد';
  await createMiniHandler({ config, service: f.service, isBankMember: yes })(i);
  const current = (await f.service.mini.latest(user, 'dice')).miniGames.dice;
  assert.equal(current.messageId, g.messageId);
  assert.match(i.calls.find(c => c[0] === 'edit')[1].content, new RegExp(g.messageId));
});

for (const kind of ['dice', 'memory']) test(`${kind}: an old copied message cannot steal the live round`, async () => {
  const f = await setup(), g = await solo(f, kind), game = kind === 'memory' ? f.service.memory : f.service.mini;
  await game.bind(g, snowflake(at, 999));
  assert.equal((await game.latest(user, kind)).miniGames[kind].messageId, g.messageId);
  await assert.rejects(game.play({ kind, id: g.id, userId: user, channelId,
    messageId: snowflake(at, 999), revision: g.revision, move: kind === 'dice' ? 'roll' : '0' }, yes), /الأصلية/);
  assert.equal((await f.service.balance(user)).total, 1000);
});

test('rapid memory presses consume one card and explain a rejected stale press', async () => {
  const f = await setup(), g = await solo(f, 'memory'); await f.service.memory.markDisplayed(g);
  const handler = createMemoryHandler({ config, service: f.service, isBankMember: yes });
  const first = interaction(`memory:v1:${user}:${g.id}:0:0`);
  const second = interaction(`memory:v1:${user}:${g.id}:0:1`);
  await Promise.all([handler(first), handler(second)]);
  const current = (await f.service.memory.latest(user)).miniGames.memory;
  assert.deepEqual(current.flipped, [0]); assert.equal(current.attempts, 0);
  assert.equal(second.calls[0][0], 'ack');
  const notice = second.calls.find(c => c[0] === 'notice')?.[1];
  assert.equal(notice?.flags, 64); assert.match(notice.content, /لم تُحسب/);
});

test('a transient memory edit failure is retried and unmatched cards become playable again', async () => {
  const f = await setup(); let g = await solo(f, 'memory'); await f.service.memory.markDisplayed(g);
  for (const cell of [0, 1]) {
    g = await f.service.memory.play({ id: g.id, userId: user, channelId, revision: g.revision, move: String(cell) }, yes);
    if (cell === 0) await f.service.memory.markDisplayed(g);
  }
  let fail = true, visible; const errors = [];
  const message = { author: { id: actor }, edit: async payload => {
    if (fail) { fail = false; throw new Error('temporary Discord failure'); }
    visible = payload;
  } };
  const bot = { user: { id: actor }, channels: { fetch: async () => ({ guildId: config.clanGuildId, messages: { fetch: async () => message } }) } };
  const manager = new MemoryManager({ bot, service: f.service, canRun: () => true, onError: e => errors.push(e) });
  await manager.tick(); await manager.drain(); assert.equal(errors.length, 1);
  await manager.tick(); await manager.drain();
  g = (await f.service.memory.latest(user)).miniGames.memory; assert.equal(g.hideAt, at + 2000);
  f.service.clock = () => at + 2000;
  await manager.tick(); await manager.drain();
  assert.ok(buttons(visible).every(b => !b.disabled));
  assert.deepEqual((await f.service.memory.latest(user)).miniGames.memory.flipped, []);
});

test('one stalled Discord message cannot block other memory boards or the next expiry tick', async () => {
  const f = await setup(), first = await solo(f, 'memory'), second = await solo(f, 'memory', other, 200);
  const entered = deferred(), release = deferred(), shown = [];
  const bot = { user: { id: actor }, channels: { fetch: async () => ({ guildId: config.clanGuildId, messages: { fetch: async id => {
    if (id === first.messageId) { entered.resolve(); await release.promise; }
    return { author: { id: actor }, edit: async payload => shown.push([id, payload]) };
  } } }) } };
  const manager = new MemoryManager({ bot, service: f.service, canRun: () => true });
  const ticking = manager.tick(); await entered.promise; await nextTurn();
  const secondDisplayedWhileFirstWaited = shown.some(([id]) => id === second.messageId);
  f.service.clock = () => at + 30000;
  const nextTick = manager.tick(); await nextTurn();
  const expiredWhileFirstWaited = (await f.service.memory.latest(other)).miniGames.memory.status;
  release.resolve(); await Promise.all([ticking, nextTick]); await manager.drain();
  assert.equal(secondDisplayedWhileFirstWaited, true);
  assert.equal(expiredWhileFirstWaited, 'settled');
  // After the slow fetch returns it must render the current terminal state.
  assert.ok(buttons(shown.findLast(([id]) => id === first.messageId)[1]).every(b => b.disabled));
});

const pvp = [
  ['xo', 'xo', createXoHandler, () => '0'],
  ['buttonGame', 'button-game', createButtonHandler, g => String(g.green)],
  ['minesGame', 'mines', createMinesHandler, g => String(g.mine === 1 ? 2 : 1)],
  ['numbersGame', 'numbers', createNumbersHandler, () => '1'],
  ['dotGame', 'dot', createDotHandler, () => '1'],
  ['boxesGame', 'boxes', createBoxesHandler, () => '1']
];
async function active(f, property) {
  const game = f.service[property]; await game.initialize();
  let g = await game.open({ id: snowflake(at, 300), x: user, o: other, amount: 100, channelId, requireDelivery: true }, yes);
  await game.bind(g.id, snowflake(at, 301)); await game.displayed(g);
  g = await game.act({ id: g.id, revision: g.revision, move: 'accept', userId: other, channelId }, yes);
  if (property === 'buttonGame') { const time = g.revealAt; f.service.clock = () => time; await game.expire(); g = await game.get(g.id); }
  await game.displayed(g); return game.get(g.id);
}
for (const [property, prefix, handler, move] of pvp) {
  test(`${prefix}: a stale button refreshes the board without spending a move or changing balances`, async () => {
    const f = await setup(), g = await active(f, property), game = f.service[property];
    const i = interaction(`${prefix}:v1:${g.id}:${g.revision - 1}:${move(g)}`, g.turn || user, g.messageId);
    await handler({ config, service: f.service, isBankMember: yes })(i);
    const payload = i.calls.find(c => c[0] === 'edit')?.[1];
    assert.ok(payload, 'the stale public board must be repaired');
    assert.ok(buttons(payload).every(b => b.custom_id.startsWith(`${prefix}:v1:${g.id}:${g.revision}:`)));
    assert.equal(i.calls.find(c => c[0] === 'notice')?.[1].flags, 64);
    assert.equal((await game.get(g.id)).revision, g.revision);
    assert.deepEqual(await Promise.all([user, other].map(id => f.service.balance(id).then(b => b.total))), [900, 900]);
  });
  test(`${prefix}: slow membership lookup does not hold the shared economy queue`, async () => {
    const f = await setup(), g = await active(f, property), entered = deferred(), release = deferred();
    const playing = f.service[property].act({ id: g.id, revision: g.revision, move: move(g), userId: g.turn || user, channelId }, async id => {
      if (id === other) { entered.resolve(); await release.promise; } return true;
    });
    await entered.promise;
    let completed = false;
    const reading = f.service.balance(actor).then(() => { completed = true; });
    await nextTurn(); const completedBeforeDiscord = completed;
    release.resolve(); await Promise.all([playing, reading]);
    assert.equal(completedBeforeDiscord, true);
  });
}

test('a queued background XO snapshot is skipped after the player already displayed that revision', async () => {
  const f = await setup(), g = await active(f, 'xo');
  const row = { ...g, dirty: true }; let edits = 0;
  // Simulate dirty() having been read immediately before a player's edit.
  f.service.xo.dirty = async () => [row];
  const bot = { user: { id: actor }, channels: { fetch: async () => ({ guildId: config.clanGuildId,
    messages: { fetch: async () => ({ author: { id: actor }, edit: async () => { edits++; } }) } }) } };
  const manager = new XoManager({ bot, service: f.service, canRun: () => true });
  await manager.tick(); await manager.drain();
  assert.equal(edits, 0, 'do not resend an already displayed board on every dirty snapshot');
});

test('a button recovers the message binding after the initial send succeeded but binding failed', async () => {
  for (const kind of ['dice', 'memory', 'xo']) {
    const f = await setup();
    let g, i, handler;
    if (kind === 'xo') {
      const game = f.service.xo; await game.initialize();
      g = await game.open({ id: snowflake(at, 600), x: user, o: other, amount: 100, channelId, requireDelivery: true }, yes);
      i = interaction(`xo:v1:${g.id}:${g.revision}:accept`, other); handler = createXoHandler;
    } else {
      const game = kind === 'memory' ? f.service.memory : f.service.mini;
      g = await game.open({ kind, id: snowflake(at, 600), userId: user, channelId, at }, yes);
      i = interaction(kind === 'memory' ? `memory:v1:${user}:${g.id}:0:0` : `mini:v1:dice:${user}:${g.id}:0:roll`);
      handler = kind === 'memory' ? createMemoryHandler : createMiniHandler;
    }
    await handler({ config, service: f.service, isBankMember: yes })(i);
    const saved = kind === 'xo' ? await f.service.xo.get(g.id)
      : (await (kind === 'memory' ? f.service.memory : f.service.mini).latest(user, kind)).miniGames[kind];
    assert.equal(saved.messageId, i.message.id, kind);
    if (kind === 'xo') assert.equal(saved.dirty, false);
    else assert.equal(saved.displayRevision, saved.revision);
  }
});
