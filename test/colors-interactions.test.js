import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fixture, at, user, other, actor, config, snowflake } from './helpers/shop-fixture.js';
import { createMiniHandler, MiniGameManager } from '../src/mini-game-commands.js';

const channelId = '100000000000000060';
const yes = async () => true;
const current = async f => (await f.service.mini.latest(user, 'colors')).miniGames.colors;
const buttons = payload => payload.components.flatMap(row => row.toJSON().components);

async function setup() {
  const f = await fixture();
  await f.seed(user, 10000);
  const round = await f.service.mini.open({ kind: 'colors', id: snowflake(at, 100),
    userId: user, channelId, at }, yes, min => min);
  await f.service.mini.bind(round, snowflake(at, 101));
  const day = await f.service.mini.latest(user, 'colors');
  await f.store.mutateDay(day._id, draft => {
    // Eight legal moves; the seventh leaves exactly two colors on the board.
    draft.miniGames.colors.board = Array.from({ length: 81 }, (_, i) => Math.floor(i / 9) % 5);
    draft.miniGames.colors.maxMoves = 8;
    return true;
  });
  await f.service.mini.markDisplayed(await current(f));
  return f;
}

function press(round, move, overrides = {}) {
  const calls = [];
  return { calls, customId: `mini:v1:colors:${user}:${round.id}:${round.revision}:${move}`,
    id: snowflake(at, 800), createdTimestamp: at, user: { id: user }, guildId: config.clanGuildId,
    channelId, message: { id: round.messageId }, isButton: () => true,
    update: async payload => { calls.push(['update', payload]); },
    deferUpdate: async () => { calls.push(['ack']); },
    reply: async payload => { calls.push(['reply', payload]); },
    followUp: async payload => { calls.push(['notice', payload]); },
    editReply: async payload => { calls.push(['edit', payload]); return { id: round.messageId }; },
    ...overrides };
}

test('a complete colors round including its final two colors uses one callback per move and pays once', async () => {
  const f = await setup();
  const handler = createMiniHandler({ config, service: f.service, isBankMember: yes });
  const interactions = [];
  for (let move = 1; move <= 8; move++) {
    const i = press(await current(f), move % 5); interactions.push(i);
    await handler(i);
    const saved = await current(f);
    assert.equal(saved.moves, move);
    assert.equal(saved.displayRevision, saved.revision);
    if (move === 7) assert.equal(new Set(saved.board).size, 2);
  }
  const saved = await current(f);
  assert.equal(saved.result.outcome, 'win');
  assert.equal(saved.moves, saved.maxMoves);
  assert.equal((await f.service.balance(user)).total, 10500);
  assert.equal(f.documents.days[0].miniReceipts.length, 1);
  assert.deepEqual(interactions.map(i => i.calls.map(call => call[0])), Array.from({ length: 8 }, () => ['update']));
  assert.ok(buttons(interactions.at(-1).calls[0][1]).every(button => button.disabled));
});

test('a burst from the same displayed revision never builds a queue of duplicate edits or database actions', async () => {
  const f = await setup(), round = await current(f);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let actions = 0;
  const original = f.service.mini.play.bind(f.service.mini);
  f.service.mini.play = async (...args) => { actions++; entered.resolve(); await release.promise; return original(...args); };
  const handler = createMiniHandler({ config, service: f.service, isBankMember: yes });
  const first = press(round, 1), playing = handler(first);
  await entered.promise;
  const repeated = Array.from({ length: 30 }, (_, i) => press(round, (i % 4) + 1));
  const duplicates = repeated.map(i => handler(i));
  await nextTurn();
  const acknowledgedBeforeSave = repeated.every(i => i.calls.length > 0);
  release.resolve(); await Promise.all([playing, ...duplicates]);
  assert.equal(acknowledgedBeforeSave, true);
  assert.equal(actions, 1, 'duplicate presses must not enter the game/economy queues');
  assert.equal((await current(f)).moves, 1);
  assert.equal(repeated.flatMap(i => i.calls).filter(([kind]) => ['edit', 'update'].includes(kind)).length, 0);
  assert.equal((await f.service.balance(user)).total, 10000);
});

test('a stale press on an already displayed board sends its notice outside the display queue', async () => {
  const f = await setup(), old = await current(f);
  const handler = createMiniHandler({ config, service: f.service, isBankMember: yes });
  await handler(press(old, 1));
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const slowNotice = async () => { entered.resolve(); await release.promise; };
  const stale = press(old, 2, { followUp: slowNotice, reply: slowNotice });
  const warning = handler(stale); await entered.promise;
  const next = press(await current(f), 2), playing = handler(next);
  await nextTurn();
  const movesBeforeNotice = (await current(f)).moves;
  release.resolve(); await Promise.all([warning, playing]);
  assert.equal(movesBeforeNotice, 2, 'a private notice must not stall the next color');
  assert.equal(stale.calls.filter(([kind]) => ['edit', 'update'].includes(kind)).length, 0);
});

test('slow storage gets an early acknowledgement, and never edits before that acknowledgement finishes', async t => {
  const f = await setup(), round = await current(f);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const ackStarted = Promise.withResolvers(), ackFinished = Promise.withResolvers();
  const handler = createMiniHandler({ config, service: f.service,
    isBankMember: async () => { entered.resolve(); await release.promise; return true; } });
  const i = press(round, 1);
  i.deferUpdate = async () => { i.calls.push(['ack']); ackStarted.resolve(); await ackFinished.promise; };
  const playing = handler(i); await entered.promise;
  t.mock.timers.tick(1000); await ackStarted.promise;
  assert.deepEqual(i.calls.map(call => call[0]), ['ack']);
  release.resolve(); await nextTurn();
  const editsBeforeAck = i.calls.filter(([kind]) => kind === 'edit').length;
  ackFinished.resolve(); await playing;
  assert.equal(editsBeforeAck, 0);
  assert.deepEqual(i.calls.map(call => call[0]), ['ack', 'edit']);
  assert.equal((await current(f)).displayRevision, 1);
  t.mock.timers.tick(10000); await nextTurn();
  assert.equal(i.calls.length, 2, 'the response timer must not acknowledge twice');
});

test('a lost response to the final color is recovered in the background without paying twice', async () => {
  const f = await setup(), errors = [];
  const handler = createMiniHandler({ config, service: f.service, isBankMember: yes, onError: e => errors.push(e) });
  for (let move = 1; move <= 7; move++) await handler(press(await current(f), move % 5));
  const lastTwo = await current(f);
  const last = press(lastTwo, 3, { update: async () => { throw new Error('Discord connection lost'); } });
  await handler(last);
  const settled = await current(f);
  assert.equal(settled.status, 'settled');
  assert.notEqual(settled.displayRevision, settled.revision);
  assert.equal(errors.length, 1);
  assert.equal(last.calls.length, 0, 'do not try a second callback after an ambiguous failure');
  let visible;
  const bot = { user: { id: actor }, channels: { fetch: async () => ({ guildId: config.clanGuildId,
    messages: { fetch: async () => ({ author: { id: actor }, edit: async p => { visible = p; } }) } }) } };
  const manager = new MiniGameManager({ bot, service: f.service, canRun: () => true });
  await manager.tick(); await manager.drain();
  assert.ok(buttons(visible).every(button => button.disabled));
  const replay = press(lastTwo, 3); await handler(replay);
  assert.deepEqual(replay.calls.map(call => call[0]), ['ack']);
  assert.equal((await current(f)).displayRevision, settled.revision);
  assert.equal((await f.service.balance(user)).total, 10500);
  assert.equal(f.documents.days[0].miniReceipts.length, 1);
});

test('a stale color repairs a failed display, but never applies its choice to the newer board', async () => {
  const f = await setup(), old = await current(f);
  await f.service.mini.play({ kind: 'colors', userId: user, id: old.id, channelId,
    messageId: old.messageId, revision: old.revision, move: '1' }, yes);
  const i = press(old, 2);
  await createMiniHandler({ config, service: f.service, isBankMember: yes })(i);
  const saved = await current(f);
  assert.equal(saved.moves, 1);
  assert.equal(saved.board[0], 1);
  assert.equal(saved.displayRevision, 1);
  assert.deepEqual(i.calls.map(call => call[0]), ['update', 'notice']);
  assert.equal(i.calls[1][1].flags, 64);
});

test('colors reject another owner and copied messages without changing the board or balance', async () => {
  const f = await setup(), round = await current(f);
  const handler = createMiniHandler({ config, service: f.service, isBankMember: yes });
  for (const overrides of [{ user: { id: other } }, { message: { id: snowflake(at, 999) } }]) {
    const i = press(round, 1, overrides); await handler(i);
    assert.deepEqual(i.calls.map(call => call[0]), ['reply']);
    assert.equal(i.calls[0][1].flags, 64);
  }
  assert.equal((await current(f)).moves, 0);
  assert.equal((await f.service.balance(user)).total, 10000);
});

test('a same-color no-op avoids editing the board and does not leave a pending response timer', async t => {
  const f = await setup(), round = await current(f);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const i = press(round, round.board[0]);
  await createMiniHandler({ config, service: f.service, isBankMember: yes })(i);
  t.mock.timers.tick(3000); await nextTurn();
  assert.deepEqual(i.calls.map(call => call[0]), ['ack']);
  assert.equal((await current(f)).moves, 0);
});
