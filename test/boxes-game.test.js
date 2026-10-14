import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, at, user, other, actor, config, snowflake } from './helpers/shop-fixture.js';
import { BOXES_EDGES, boxesScore, connectBoxes } from '../src/boxes-game.js';
import { boxesPayload, createBoxesHandler, BoxesManager, buildBoxesCommand } from '../src/boxes-game-commands.js';
import { createTextCommands, commandsPanel } from '../src/experience-commands.js';
import { buildCommands } from '../src/commands.js';
import { gamesMenuPayload } from '../src/bank-menu.js';
import { commandTimesPayload } from '../src/bank-commands.js';

const channelId = '100000000000000060', yes = async () => true;
const input = (patch = {}) => ({ id: snowflake(at, 1500), x: user, o: other, amount: 300, channelId,
  names: { [user]: 'أنور', [other]: 'الخصم' }, ...patch });
const empty = () => ({ edges: Array(24).fill(null), boxes: Array(9).fill(null) });
const buttons = p => p.components.flatMap(row => row.toJSON().components);
const balances = f => Promise.all([user, other].map(id => f.store.totals(id, 'all', at).then(b => b.total)));
const act = (f, g, move, who = g.status === 'pending' ? g.o : g.turn, patch = {}) => f.service.boxesGame.act({
  id: g.id, revision: g.revision, move: String(move), userId: who, channelId, ...patch
}, yes);
async function setup() {
  const f = await fixture(); await f.seed(user, 1000); await f.seed(other, 1000);
  await f.service.boxesGame.initialize(); return f;
}
async function start(f, patch = {}) { return act(f, await f.service.boxesGame.open(input(patch), yes), 'accept'); }
const complete = Array.from({ length: 24 }, (_, i) => i + 1);
const lastMoverLoses = [23, 5, 3, 6, 16, 8, 22, 10, 19, 13, 9, 2, 12, 21, 15, 17, 4, 7, 11, 20, 24, 1, 18, 14];

// Geometry expectations are independent examples: top-left box = 1,4,13,14;
// its right neighbour = 2,5,14,15; bottom-right = 9,12,23,24.
test('fourth edge captures a box despite all three earlier edges belonging to the opponent', () => {
  let g = empty(); for (const edge of [0, 3, 12]) g = connectBoxes(g, edge, 'R');
  const before = structuredClone(g), moved = connectBoxes(g, 13, 'B');
  assert.deepEqual(moved.captured, [0]); assert.equal(moved.boxes[0], 'B');
  assert.deepEqual(boxesScore(moved.boxes), { B: 1, R: 0 }); assert.deepEqual(g, before);
});
test('one shared vertical edge closes two boxes and a shared horizontal edge does the same', () => {
  for (const [outer, shared, expected] of [ [[0, 3, 12, 1, 4, 14], 13, [0, 1]], [[0, 12, 13, 6, 16, 17], 3, [0, 3]] ]) {
    let g = empty(); for (const edge of outer) g = connectBoxes(g, edge, 'R');
    const moved = connectBoxes(g, shared, 'B'); assert.deepEqual(moved.captured, expected);
    assert.deepEqual(boxesScore(moved.boxes), { B: 2, R: 0 });
  }
});
test('bottom-right box is captured at the boundary without wrapping rows', () => {
  let g = empty(); for (const edge of [8, 11, 22]) g = connectBoxes(g, edge, 'B');
  g = connectBoxes(g, 23, 'R'); assert.deepEqual(g.captured, [8]);
  assert.deepEqual(boxesScore(g.boxes), { B: 0, R: 1 });
});
test('invalid and occupied edges are rejected without mutating either array', () => {
  const g = connectBoxes(empty(), 0, 'B'), before = structuredClone(g);
  for (const edge of [-1, 24, 1.2, NaN, '1', 0]) assert.throws(() => connectBoxes(g, edge, 'R'));
  assert.throws(() => connectBoxes(g, 1, 'X')); assert.deepEqual(g, before);
});
test('only the invited opponent accepts; rejected and expired invitations never debit either wallet', async () => {
  for (const outcome of ['reject', 'timeout']) {
    const f = await setup(), g = await f.service.boxesGame.open(input(), yes);
    await assert.rejects(act(f, g, 'accept', user), /المتحدّى/);
    await assert.rejects(act(f, g, 'accept', actor), /للطرفين/);
    assert.deepEqual(await balances(f), [1000, 1000]);
    if (outcome === 'timeout') f.service.clock = () => at + 30000;
    const result = await act(f, g, outcome === 'reject' ? 'reject' : 'accept');
    assert.equal(result.status, outcome === 'reject' ? 'rejected' : 'cancelled');
    assert.deepEqual(await balances(f), [1000, 1000]);
  }
});
test('self, bots, wrong room, invalid stakes and missing membership cannot open a challenge', async () => {
  const f = await setup();
  for (const patch of [{ o: user }, { bot: true }, { channelId: other }, { amount: 0 }, { amount: -1 }, { amount: 1.5 }, { amount: 1000000001 }]) {
    await assert.rejects(f.service.boxesGame.open(input(patch), yes));
  }
  await assert.rejects(f.service.boxesGame.open(input(), async id => id === user));
  assert.equal(f.documents.boxes_games.length, 0); assert.deepEqual(await balances(f), [1000, 1000]);
});
test('insufficient funds on open or accept never charge the other player', async () => {
  const f = await setup(), day = f.documents.days.find(d => d.userId === other); day.points.tasks = 299;
  await assert.rejects(f.service.boxesGame.open(input(), yes), /لا يكفي/);
  day.points.tasks = 1000; const g = await f.service.boxesGame.open(input(), yes); day.points.tasks = 299;
  const ended = await act(f, g, 'accept'); assert.equal(ended.reason, 'balance');
  assert.deepEqual(await balances(f), [1000, 299]);
});
test('turns alternate without a capture, capturing retains the turn and grants a fresh deadline', async () => {
  const f = await setup(); let g = await start(f);
  assert.deepEqual(await balances(f), [700, 700]);
  for (const move of [1, 4, 13]) {
    const previous = g.turn; g = await act(f, g, move); assert.notEqual(g.turn, previous);
  }
  f.service.clock = () => at + 25000;
  g = await act(f, g, 14); assert.equal(g.turn, other); assert.equal(g.boxes[0], 'R');
  assert.deepEqual(g.captured, [0]); assert.equal(g.expiresAt, at + 55000);
  assert.match(boxesPayload(g).embeds[0].data.description, /دور إضافي/);
  g = await act(f, g, 2); assert.equal(g.turn, user); assert.deepEqual(g.captured, []);
});
test('one move awards two adjacent boxes in a live round without giving up the turn', async () => {
  const f = await setup(); let g = await start(f);
  for (const move of [1, 4, 13, 2, 5, 15]) g = await act(f, g, move);
  g = await act(f, g, 14); assert.deepEqual(g.captured, [0, 1]); assert.equal(g.turn, user);
  assert.deepEqual(boxesScore(g.boxes), { B: 2, R: 0 });
});
for (const [title, order, winner, expected] of [ ['normal finish', complete, other, { B: 3, R: 6 }],
  ['last mover is not the winner', lastMoverLoses, user, { B: 5, R: 4 }] ]) {
  test(`${title}: all edges must be played and only the box majority determines payout`, async () => {
    const f = await setup(); let g = await start(f), last;
    for (const [index, move] of order.entries()) {
      assert.equal(g.status, 'active'); last = g.turn; g = await act(f, g, move);
      if (index < 23) assert.deepEqual(await balances(f), [700, 700]);
    }
    assert.equal(g.status, 'won'); assert.equal(g.winner, winner); assert.deepEqual(boxesScore(g.boxes), expected);
    assert.ok(g.edges.every(Boolean)); assert.ok(g.boxes.every(Boolean));
    if (title.startsWith('last')) assert.notEqual(last, winner);
    const totals = winner === user ? [1300, 700] : [700, 1300]; assert.deepEqual(await balances(f), totals);
    await act(f, g, 1); await f.service.boxesGame.expire(); assert.deepEqual(await balances(f), totals);
    assert.ok(buttons(boxesPayload(g)).every(b => b.disabled));
  });
}
test('outsiders, copied messages, wrong turns, repeated lines and concurrent clicks cannot add moves', async () => {
  const f = await setup(); let g = await start(f); await f.service.boxesGame.bind(g.id, snowflake(at, 1510));
  await assert.rejects(act(f, g, 1, actor), /للطرفين/);
  await assert.rejects(act(f, g, 1, other), /دورك/);
  await assert.rejects(act(f, g, 1, user, { messageId: snowflake(at, 1511) }), /الأصلية/);
  const results = await Promise.allSettled([act(f, g, 1), act(f, g, 2)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(act(f, g, 3, other), e => e.code === 'GAME_STALE_VIEW');
  g = await f.service.boxesGame.get(g.id); assert.equal(g.edges.filter(Boolean).length, 1);
  await assert.rejects(act(f, g, g.edges.findIndex(Boolean) + 1), /مرسوم/);
  for (const move of [0, 25, '01', '1.5', 'v1']) await assert.rejects(act(f, g, move));
  assert.equal((await f.service.boxesGame.get(g.id)).revision, g.revision);
});
test('a capture cannot be replayed through rapid clicks while its new board is undelivered', async () => {
  const f = await setup(); let g = await start(f, { requireDelivery: true });
  for (const move of [1, 4, 13, 14]) { await f.service.boxesGame.displayed(g); g = await act(f, g, move); }
  assert.equal(g.turn, other);
  await assert.rejects(act(f, g, 2), e => e.code === 'GAME_STALE_VIEW');
  await f.service.boxesGame.displayed(g); const next = await act(f, g, 2); assert.equal(next.turn, user);
});
test('30-second turn timeout settles once when a click races the expiry worker', async () => {
  const f = await setup(), g = await start(f, { requireDelivery: true }); await f.service.boxesGame.displayed(g);
  f.service.clock = () => at + 30000;
  await Promise.all([f.service.boxesGame.expire(), act(f, g, 1)]);
  const final = await f.service.boxesGame.get(g.id); assert.equal(final.winner, other); assert.equal(final.reason, 'timeout');
  assert.equal(final.edges.filter(Boolean).length, 0); assert.deepEqual(await balances(f), [700, 1300]);
});
test('an undelivered board times out with refunds instead of player loss', async () => {
  const f = await setup(); let g = await start(f, { requireDelivery: true }); f.service.clock = () => at + 30000;
  g = await act(f, g, 1); assert.equal(g.status, 'cancelled'); assert.deepEqual(await balances(f), [1000, 1000]);
});
test('restart retains the board, captured boxes, extra turn and deadline; changed bank cancels with refunds', async () => {
  const f = await setup(); let g = await start(f);
  for (const move of [1, 4, 13, 14]) g = await act(f, g, move);
  const restarted = f.open(at + 1000); await restarted.service.boxesGame.initialize(); await restarted.service.boxesGame.recover();
  assert.deepEqual(await restarted.service.boxesGame.get(g.id), g);
  f.documents.settings[0].bank.channelVersion++;
  await restarted.service.boxesGame.expire(); assert.deepEqual(await balances(f), [1000, 1000]);
});
test('loss of membership cancels a live game and refunds both stakes', async () => {
  const f = await setup(), g = await start(f);
  const cancelled = await f.service.boxesGame.act({ id: g.id, revision: g.revision, move: '1', userId: user, channelId }, async id => id !== other);
  assert.equal(cancelled.reason, 'membership'); assert.deepEqual(await balances(f), [1000, 1000]);
});
for (const phase of ['before', 'after']) for (const operation of ['hold', 'payout']) {
  test(`interruption ${phase} wallet write during ${operation} recovers exactly once`, async () => {
    const f = await setup(); let g = await f.service.boxesGame.open(input(), yes);
    if (operation === 'payout') { g = await act(f, g, 'accept'); for (const move of complete.slice(0, -1)) g = await act(f, g, move); }
    let hit = false;
    f.intercept(e => { if (!hit && e.name === 'days' && e.method === 'replaceOne' && e.phase === phase) { hit = true; throw new Error('lost connection'); } });
    await assert.rejects(act(f, g, operation === 'hold' ? 'accept' : 24)); assert.equal(f.service.blocked, true);
    f.intercept(() => {}); const restarted = f.open(at); await restarted.service.boxesGame.recover(); await restarted.service.boxesGame.recover();
    assert.deepEqual(await balances(f), operation === 'hold' ? [700, 700] : [700, 1300]);
    assert.equal((await restarted.service.boxesGame.get(g.id)).status, operation === 'hold' ? 'active' : 'won');
  });
}
test('reset protects active stakes and sending cooldown is independent and only applies to challenger', async () => {
  const f = await setup(); let g = await start(f);
  await assert.rejects(f.service.reset({ target: 'bank', userId: user, actorId: actor, operationId: 'reset-boxes' }), /مربعات/);
  assert.equal((await f.service.boxesGame.commandTime(user, at)).nextAt, at + 1200000);
  assert.equal((await f.service.boxesGame.commandTime(other, at)).status, 'ready');
  assert.equal((await f.service.dotGame.commandTime(user, at)).status, 'ready');
  for (const move of complete) g = await act(f, g, move);
  await assert.rejects(f.service.boxesGame.open(input({ id: snowflake(at, 1520) }), yes), /انتظار إرسال/);
  assert.equal((await f.service.boxesGame.open(input({ id: snowflake(at, 1521), x: other, o: user }), yes)).status, 'pending');
  const view = await f.service.commandTimes(user, channelId);
  assert.equal(view.boxes.nextAt, at + 1200000);
  assert.ok(commandTimesPayload(view).embeds[0].data.fields.some(f => f.name.includes('مربعات')));
});
test('board provides exactly one button per numbered line, no more than five rows or buttons per row', async () => {
  const f = await setup(); let g = await start(f); g = await act(f, g, 1);
  const p = boxesPayload(g), controls = buttons(p);
  assert.deepEqual(p.components.map(r => r.toJSON().components.length), [5, 5, 5, 5, 4]);
  assert.equal(controls.length, BOXES_EDGES.length); assert.equal(new Set(controls.map(b => b.custom_id)).size, 24);
  assert.equal(controls[0].disabled, true); assert.ok(controls.slice(1).every(b => !b.disabled));
  assert.ok(controls.every((b, i) => b.custom_id.endsWith(`:${i + 1}`) && b.custom_id.length <= 100));
  assert.equal(p.files[0].attachment.subarray(1, 4).toString(), 'PNG');
  assert.equal(p.embeds[0].data.image.url, `attachment://${p.files[0].name}`);
  assert.deepEqual(p.attachments, []); assert.deepEqual(p.allowedMentions, { parse: [] });
  const next = await act(f, g, 2); assert.notEqual(boxesPayload(next).files[0].name, p.files[0].name);
});
test('slash registration, games menu and instructions include مربعات', () => {
  const command = buildBoxesCommand().toJSON(); assert.equal(command.name, 'مربعات');
  assert.deepEqual(command.options.map(o => [o.name, o.required]), [['العضو', true], ['المبلغ', true]]);
  assert.ok(buildCommands().some(c => c.name === 'مربعات'));
  assert.ok(buttons(gamesMenuPayload()).some(b => b.custom_id === 'boxes:help'));
  assert.match(commandsPanel().embeds[0].data.description, /مربعات @عضو المبلغ/);
});
for (const content of [`مربعات <@${other}> ١٠٠٠`, `!مربعات <@!${other}> 1000`, `-مربعات <@${other}> ۱۰۰۰`]) {
  test(`text parser accepts ${content}`, async () => {
    let parsed;
    await createTextCommands(async i => { parsed = i; }, config)({ content, id: snowflake(at, 1530), author: { id: user },
      guildId: config.clanGuildId, channelId, mentions: { users: new Map([[other, { id: other }]]) } });
    assert.equal(parsed.commandName, 'مربعات'); assert.equal(parsed.options.getInteger('المبلغ'), 1000);
    assert.equal(parsed.options.getUser('العضو').id, other);
  });
}
test('text challenge binds its message; real handler accepts, plays, reports stale presses and blocks spectators', async () => {
  const f = await setup(), errors = [], handler = createBoxesHandler({ config, service: f.service, isBankMember: yes, onError: e => errors.push(e) });
  let payload, notice; const message = { id: snowflake(at, 1540) };
  await createTextCommands(handler, config)({ content: `مربعات <@${other}> 300`, id: input().id, author: { id: user, username: 'أنور' },
    guildId: config.clanGuildId, channelId, createdTimestamp: at, mentions: { users: new Map([[other, { id: other, username: 'الخصم' }]]) },
    reply: async p => { payload = p; return message; } });
  assert.equal(f.documents.boxes_games[0].messageId, message.id);
  const press = (customId, who) => handler({ customId, user: { id: who }, guildId: config.clanGuildId, channelId, message, isButton: () => true,
    deferUpdate: async () => {}, editReply: async p => { payload = p; return message; }, followUp: async p => { notice = p; } });
  await press(buttons(payload)[0].custom_id, other); assert.equal(payload.files.length, 1);
  const first = buttons(payload)[0].custom_id;
  await press(first, actor); assert.match(notice.content, /للطرفين/);
  await press(first, user); assert.equal(f.documents.boxes_games[0].edges[0], 'B'); assert.equal(f.documents.boxes_games[0].dirty, false);
  await press(first, other); assert.match(notice.content, /لم تُحسب/); assert.equal(f.documents.boxes_games[0].edges.filter(Boolean).length, 1);
});
test('background manager disables timeout controls and inaccessible messages refund instead of hanging the stake', async () => {
  for (const failure of [false, true]) {
    const f = await setup(), g = await start(f, { requireDelivery: true }); await f.service.boxesGame.bind(g.id, snowflake(at, 1550));
    if (!failure) { await f.service.boxesGame.displayed(g); f.service.clock = () => at + 30000; }
    let payload;
    const bot = { user: { id: actor }, channels: { fetch: async () => ({ guildId: config.clanGuildId, messages: { fetch: async () => {
      if (failure) throw Object.assign(new Error('unknown message'), { code: 10008 });
      return { author: { id: actor }, edit: async p => { payload = p; } };
    } } }) } };
    const manager = new BoxesManager({ bot, service: f.service, canRun: () => true, onError: () => {} }); await manager.tick(); await manager.drain();
    if (failure) { assert.equal((await f.service.boxesGame.get(g.id)).reason, 'delivery'); assert.deepEqual(await balances(f), [1000, 1000]); }
    else { assert.ok(buttons(payload).every(b => b.disabled)); assert.match(payload.embeds[0].data.description, /انتهت مهلة/); assert.deepEqual(await balances(f), [700, 1300]); }
  }
});
