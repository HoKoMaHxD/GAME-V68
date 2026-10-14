import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, config, at, user, other, snowflake } from './helpers/shop-fixture.js';
import { MiniGames, MINI_COOLDOWN, MINI_TTL, flood, miniMoney, solveColors } from '../src/mini-games.js';
import { createMiniHandler, miniPayload, parseMiniAction, MiniGameManager } from '../src/mini-game-commands.js';
import { createTextCommands } from '../src/experience-commands.js';
import { dayKey, nextReset } from '../src/time.js';
import { MessageFlags } from 'discord.js';
const channelId = '100000000000000060';
async function setup() {
  const f = await fixture(); let now = at + 1000;
  f.service.clock = () => now;
  await f.seed(user, 10000);
  return { ...f, now: () => now, time: n => { now = n; },
    input: (kind = 'dice', extra = {}) => ({ kind, id: snowflake(now), userId: user, channelId, at: now, ...extra }) };
}
const choose = (min, max) => min;
const yes = () => true;
async function open(f, kind = 'dice', percent = 5) {
  const r = await f.service.mini.open(f.input(kind), yes, (min, max) => min === 5 ? percent : min);
  await f.service.mini.bind(r, snowflake(f.now(), 99)); return r;
}
function action(round, move = 'roll') { return { kind: round.kind, userId: round.userId, id: round.id, channelId: round.channelId, revision: round.revision, move }; }
function dice(a, b) { let first = true; return () => { const n = first ? a : b; first = false; return n; }; }

test('money percent bounds include 5 and 10, uses integer rounding and separate source buckets', () => {
  for (const percent of [5, 10]) for (const outcome of ['win', 'loss', 'tie']) {
    const r = miniMoney({ tasks: 1000, attendance: 9000, total: 10000 }, outcome, percent);
    assert.equal(r.amount, outcome === 'tie' ? 0 : 100 * percent);
    assert.equal(r.after, 10000 + (outcome === 'win' ? r.amount : -r.amount));
  }
  assert.deepEqual(miniMoney({ tasks: 1, attendance: 9999, total: 10000 }, 'loss', 10).amounts, { tasks: -1, attendance: -999 });
  assert.equal(miniMoney({ tasks: 19, attendance: 0, total: 19 }, 'win', 5).amount, 0);
  assert.throws(() => miniMoney({ tasks: 100, attendance: 0, total: 100 }, 'win', 11));
  assert.throws(() => miniMoney({ tasks: Number.MAX_SAFE_INTEGER, attendance: 0, total: Number.MAX_SAFE_INTEGER }, 'win', 10));
});

test('flood changes only the connected top-left area and never wraps between rows', () => {
  const board = Array(81).fill(1); board[0] = 0; board[1] = 0; board[9] = 0; board[8] = 0;
  const next = flood(board, 2);
  assert.deepEqual([next[0], next[1], next[9], next[8]], [2, 2, 2, 0]);
  assert.equal(board[0], 0); assert.deepEqual(flood(board, 0), board);
  assert.throws(() => flood(board, 5));
});

for (const [player, bot, expected] of [[6, 1, 'win'], [1, 6, 'loss'], [3, 3, 'tie']]) test(`dice ${expected} settles once using CURRENT total`, async () => {
  const f = await setup(), round = await open(f, 'dice', 10);
  const currentDay = await f.store.latestMiniGame(user, 'dice');
  await f.store.mutateDay(currentDay._id, draft => { draft.points.tasks += 10000; return true; });
  const result = await f.service.mini.play(action(round), yes, dice(player, bot));
  assert.equal(result.result.before, 20000); assert.equal(result.result.outcome, expected);
  assert.equal(result.result.after, expected === 'win' ? 22000 : expected === 'loss' ? 18000 : 20000);
  const again = await f.service.mini.play(action(round), yes, () => assert.fail('reroll'));
  assert.deepEqual(again.result, result.result);
  assert.equal((await f.service.balance(user)).total, result.result.after);
});

test('separate persistent cooldowns survive midnight and restart; exact 20m boundary permits new round', async () => {
  const f = await setup(); f.time(nextReset(at) - 60000);
  const r = await open(f);
  await f.service.mini.play(action(r), yes, dice(6, 1));
  f.time(f.now() + 1); assert.equal((await open(f, 'colors')).status, 'open');
  const restarted = f.open(r.createdAt + MINI_COOLDOWN - 1);
  const wait = await restarted.service.mini.open({ ...f.input(), id: snowflake(r.createdAt + MINI_COOLDOWN - 1), at: r.createdAt + MINI_COOLDOWN - 1 }, yes, choose);
  assert.equal(wait.status, 'cooldown'); assert.equal(wait.nextAt, r.createdAt + MINI_COOLDOWN);
  f.time(r.nextAt);
  assert.equal((await f.service.mini.open(f.input(), yes, choose)).status, 'open');
});

test('duplicate commands and concurrent double clicks neither reroll nor pay twice', async () => {
  const f = await setup(), input = f.input();
  const rounds = await Promise.all([f.service.mini.open(input, yes, choose), f.service.mini.open(input, yes, choose)]);
  assert.equal(rounds[0].id, rounds[1].id);
  const [a, b] = await Promise.all([f.service.mini.play(action(rounds[0]), yes, dice(6, 1)), f.service.mini.play(action(rounds[0]), yes, () => assert.fail())]);
  assert.deepEqual(a.result, b.result); assert.equal((await f.service.balance(user)).total, 10500);
});

test('colors joins neighboring regions, ignores unchanged/stale choices and can win on final move', async () => {
  const f = await setup(), r = await open(f, 'colors');
  const day = await f.store.latestMiniGame(user, 'colors');
  await f.store.mutateDay(day._id, draft => {
    draft.miniGames.colors.board = Array.from({ length: 81 }, (_, i) => i < 9 ? 0 : 1);
    draft.miniGames.colors.maxMoves = 17; draft.miniGames.colors.moves = 16; return true;
  });
  const noOp = await f.service.mini.play(action(r, '0'), yes); assert.equal(noOp.moves, 16);
  const won = await f.service.mini.play(action(r, '1'), yes); assert.equal(won.status, 'settled');
  assert.equal(won.moves, 17); assert.equal(won.result.outcome, 'win');
  assert.equal((await f.service.balance(user)).total, 10500);
  assert.equal((await f.service.mini.play(action(r, '2'), yes)).moves, 17);
});

test('colors remaining nonuniform at move 17 loses; stale double click does not spend another move', async () => {
  const f = await setup(), r = await open(f, 'colors');
  const day = await f.store.latestMiniGame(user, 'colors');
  await f.store.mutateDay(day._id, draft => { draft.miniGames.colors.board = Array.from({ length: 81 }, (_, i) => i % 5); return true; });
  const once = await f.service.mini.play(action(r, '1'), yes);
  const stale = await f.service.mini.play(action(r, '2'), yes); assert.equal(stale.moves, 1);
  await f.store.mutateDay(day._id, draft => { draft.miniGames.colors.maxMoves = 17; draft.miniGames.colors.moves = 16; return true; });
  const lost = await f.service.mini.play(action(once, '2'), yes);
  assert.equal(lost.result.outcome, 'loss'); assert.equal((await f.service.balance(user)).total, 9500);
});

test('timeout after delivered round loses once after restart, undelivered round cancels without debit', async () => {
  for (const delivered of [true, false]) {
    const f = await setup(); const r = delivered ? await open(f) : await f.service.mini.open(f.input(), yes, choose);
    const restart = f.open(r.expiresAt);
    await restart.service.mini.expire(); await restart.service.mini.expire();
    const saved = (await restart.store.latestMiniGame(user, 'dice')).miniGames.dice;
    assert.equal(saved.status, delivered ? 'settled' : 'cancelled');
    assert.equal((await restart.service.balance(user)).total, delivered ? 9500 : 10000);
  }
});

test('bank reset or moving bank channel cancels active game without reviving old balance', async () => {
  for (const mode of ['reset', 'channel']) {
    const f = await setup(), r = await open(f); f.time(f.now() + 1000);
    if (mode === 'reset') await f.service.reset({ target: 'bank', actorId: other, operationId: 'mini-reset', userId: user });
    else f.documents.settings[0].bank.channelId = '100000000000000099';
    const result = await f.service.mini.play(action(r), yes, () => assert.fail());
    assert.equal(result.status, 'cancelled'); assert.equal((await f.service.balance(user)).total, mode === 'reset' ? 0 : 10000);
  }
});

test('committed write with lost acknowledgement returns saved result without duplicate debit', async () => {
  const f = await setup(), r = await open(f); let failed = false;
  f.intercept(e => { if (!failed && e.name === 'days' && e.method === 'replaceOne' && e.phase === 'after' && e.args[1].miniGames?.dice?.status === 'settled') {
    failed = true; throw new Error('ack lost');
  } });
  const result = await f.service.mini.play(action(r), yes, dice(1, 6));
  assert.equal(result.result.after, 9500); assert.equal((await f.service.balance(user)).total, 9500);
  f.intercept(() => {});
  await f.service.mini.play(action(r), yes, () => assert.fail());
  assert.equal((await f.service.balance(user)).total, 9500);
});

test('buttons bind owner/channel; foreign user cannot roll and cooldown is visible in وقت', async () => {
  const f = await setup(), r = await open(f);
  const handler = createMiniHandler({ config, service: f.service });
  const id = miniPayload(r).components[0].components[0].data.custom_id;
  assert.equal(parseMiniAction(id).userId, user);
  const replies = [];
  await handler({ customId: id, isButton: () => true, guildId: config.clanGuildId, channelId, user: { id: other }, reply: async p => replies.push(p) });
  assert.equal(replies[0].flags, MessageFlags.Ephemeral);
  await assert.rejects(f.service.mini.play({ ...action(r), channelId: '100000000000000099' }, yes), /قديمة/);
  const times = await f.service.commandTimes(user, channelId, false);
  assert.equal(times.dice.status, 'cooldown'); assert.equal(times.colors.status, 'ready');
});

test('text aliases route to games; public result disables controls and display failure cannot change wallet', async () => {
  const received = [];
  const text = createTextCommands(i => received.push(i.commandName), config);
  for (const content of ['الوان', '!ألوان', '-نرد']) await text({ content, guildId: config.clanGuildId, author: { id: user } });
  assert.deepEqual(received, ['الوان', 'ألوان', 'نرد']);
  const f = await setup(), r = await open(f);
  const result = await f.service.mini.play(action(r), yes, dice(6, 1));
  assert.ok(miniPayload(result).components[0].components.every(b => b.data.disabled));
  const manager = new MiniGameManager({ service: f.service, canRun: () => true, bot: { channels: { fetch: async () => { throw Object.assign(new Error('missing'), { code: 10003 }); } } } });
  await manager.tick();await manager.drain(); await manager.tick();await manager.drain(); assert.equal((await f.service.balance(user)).total, 10500);
});

test('adaptive color budgets come from a valid solution plus 1–3 moves for each generated board', async () => {
  let seed = 128312;
  const rand = (min, max) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return min + seed % (max - min); };
  const limits = new Set();
  for (let i = 0; i < 12; i++) {
    const f = await setup();
    const r = await f.service.mini.open(f.input('colors'), yes, rand);
    const path = solveColors(r.board); let board = r.board;
    for (const color of path) board = flood(board, color);
    assert.ok(board.every(n => n === board[0]));
    assert.equal(r.estimatedMoves, path.length);
    assert.ok(r.maxMoves >= path.length + 1 && r.maxMoves <= path.length + 3);
    limits.add(r.maxMoves);
    let current = r;
    for (const color of path) current = await f.service.mini.play(action(current, String(color)), yes);
    assert.equal(current.result.outcome, 'win');
  }
  assert.ok(limits.size > 1);
});

test('a failed pre-commit settlement blocks writes, restart permits a single settlement', async () => {
  const f = await setup(), r = await open(f); let failed = false;
  f.intercept(e => { if (!failed && e.name === 'days' && e.method === 'replaceOne' && e.phase === 'before' && e.args[1].miniGames?.dice?.status === 'settled') {
    failed = true; throw new Error('database unavailable');
  } });
  await assert.rejects(f.service.mini.play(action(r), yes, dice(1, 6)), /تأكيد/);
  assert.equal(f.service.blocked, true);
  f.intercept(() => {});
  const reopened = f.open(f.now());
  await reopened.service.mini.play(action(r), yes, dice(1, 6));
  assert.equal((await reopened.service.balance(user)).total, 9500);
});

test('actual game command sends a usable round and persists the delivered message', async () => {
  const f = await setup(); const payloads = [];
  const handler = createMiniHandler({ config, service: f.service });
  await handler({ commandName: 'نرد', isButton: () => false, guildId: config.clanGuildId, channelId, id: snowflake(f.now()),
    createdTimestamp: f.now(), user: { id: user }, deferReply: async () => {},
    editReply: async p => { payloads.push(p); return { id: snowflake(f.now(), 111) }; } });
  assert.equal(payloads.length, 1); const id = payloads[0].components[0].components[0].data.custom_id;
  const round = (await f.store.latestMiniGame(user, 'dice')).miniGames.dice;
  assert.equal(round.delivered, true); assert.equal(round.revision, parseMiniAction(id).revision);
  await handler({ customId: id, isButton: () => true, guildId: config.clanGuildId, channelId, user: { id: user },
    deferUpdate: async () => {}, editReply: async p => { payloads.push(p); return { id: round.messageId }; }, followUp: async () => assert.fail('unexpected error') });
  assert.equal((await f.store.latestMiniGame(user, 'dice')).miniGames.dice.status, 'settled');
});
