import test from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle, MessageFlags } from 'discord.js';
import { newRobberyRound, ROBBERY_TTL_MS } from '../src/robbery.js';
import { advanceMine, MINE_CELLS, mineOutcome } from '../src/robbery-mine.js';
import { robberyPayload, parseRobberyAction, createRobberyHandler } from '../src/robbery-commands.js';
import { createTextCommands } from '../src/experience-commands.js';
import { memberNotification } from '../src/notification-views.js';
import { fixture, at, user, other, actor, config, snowflake } from './helpers/shop-fixture.js';

const channelId = '100000000000000060', id = snowflake(at, 820);
const input = (patch = {}) => ({ id, userId: user, targetId: other, channelId, at, ...patch });
const click = (cell = 1, revision = 0, sequence = 821, patch = {}) => ({ id, userId: user, channelId,
  cell, revision, resolutionId: snowflake(at, sequence), ...patch });
// Identity shuffle, with a separately chosen mine. Production uses crypto.randomInt.
const dice = (cell = 9, percent = 30) => (min, max) => min === 15 ? percent : min === 40 ? 60 : min === 1 ? cell : max - 1;
const key = (cell = 1, revision = 0, owner = user) => `clan-robbery:v1:${owner}:${id}:mine:${revision}:${cell}`;
const balances = f => Promise.all([user, other].map(u => f.store.totals(u, 'all', at).then(b => b.total)));
async function setup(cell = 9, money = 1000, target = 2000) {
  const f = await fixture(); await f.store.robbery.initialize(at); await f.store.notifications.initialize(at);
  await f.seed(user, money); await f.seed(other, target);
  const round = await f.service.openRobbery(input(), () => true, dice(cell));
  return { ...f, round };
}
function interaction({ customId, who = user, sequence = 821 } = {}) {
  const calls = [], record = name => async payload => { calls.push([name, payload]); };
  return { calls, id: customId ? snowflake(at, sequence) : id, createdTimestamp: at,
    guildId: config.clanGuildId, channelId, commandName: customId ? undefined : 'نهب', customId,
    user: { id: who, bot: false, username: 'player', displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/user/photo.png' },
    options: { getUser: () => ({ id: other, bot: false }) },
    reply: record('reply'), deferReply: record('deferReply'), deferUpdate: record('deferUpdate'),
    editReply: record('editReply'), followUp: record('followUp') };
}
const handlerFor = f => createRobberyHandler({ ...f, config, isBankMember: () => true, robberyPause: async () => {} });

test('random game selection covers both games and commits one hidden mine and a complete bot order', () => {
  const rps = newRobberyRound(input(), at, min => min);
  assert.equal(rps.game, 'rps'); assert.equal(rps.mine, undefined); assert.equal(rps.botMove, 'rock');
  const mine = newRobberyRound(input(), at, dice());
  assert.equal(mine.game, 'mine'); assert.equal(mine.botMove, undefined);
  assert.equal(mine.mine.cell, 9); assert.deepEqual(mine.mine.botOrder, MINE_CELLS);
  assert.equal(mine.expiresAt, at + ROBBERY_TTL_MS);
  for (const bad of [-1, 2, 0.5, NaN]) assert.throws(() => newRobberyRound(input(), at, () => bad));
});

test('every possible mine gives exactly one loser within nine alternating picks and can never tie', () => {
  const outcomes = [];
  for (const cell of MINE_CELLS) {
    let round = newRobberyRound(input(), at, dice(cell));
    while (!round.mine.loser) {
      const nextCell = MINE_CELLS.find(c => !round.mine.picks.some(p => p.cell === c));
      round = advanceMine(round, click(nextCell, round.mine.revision, 821 + round.mine.revision));
    }
    assert.equal(round.mine.picks.at(-1).cell, cell);
    assert.equal(round.mine.picks.length, new Set(round.mine.picks.map(p => p.cell)).size);
    assert.ok(round.mine.picks.length <= 9);
    round.mine.picks.forEach((p, i) => assert.equal(p.actor, i % 2 ? 'bot' : 'player'));
    outcomes.push(mineOutcome(round));
  }
  assert.equal(outcomes.filter(o => o === 'win').length, 4);
  assert.equal(outcomes.filter(o => o === 'loss').length, 5);
});

test('bot order is independent of the mine and does not skip it', async () => {
  const a = newRobberyRound(input(), at, dice(2)), b = newRobberyRound(input(), at, dice(9));
  assert.deepEqual(a.mine.botOrder, b.mine.botOrder);
  assert.equal(advanceMine(a, click()).mine.loser, 'bot');
  assert.equal(advanceMine(b, click()).mine.loser, null);
});

test('safe turns persist without touching either balance and survive restart without rerolling', async () => {
  const f = await setup(); const first = await f.service.settleRobbery(click());
  assert.deepEqual(first.mine.picks, [{ actor: 'player', cell: 1 }, { actor: 'bot', cell: 2 }]);
  assert.equal(first.status, 'open'); assert.equal(first.mine.revision, 1); assert.equal(first.result, undefined);
  assert.deepEqual(await balances(f), [1000, 2000]);
  const restarted = f.open(at + 1000);
  assert.equal((await restarted.service.settleRobbery(click())).duplicate, true);
  const saved = await restarted.service.openRobbery(input(), () => true, () => { throw new Error('reroll'); });
  assert.deepEqual(saved.mine, first.mine);
  const next = await restarted.service.settleRobbery(click(3, 1, 822));
  assert.deepEqual(next.mine.picks.slice(2), [{ actor: 'player', cell: 3 }, { actor: 'bot', cell: 4 }]);
  assert.equal(f.documents.robbery_rounds[0].dmEvents, undefined);
});

test('simultaneous different clicks from one board consume only one player/bot turn', async () => {
  const f = await setup();
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => f.service.settleRobbery(click(i % 2 ? 3 : 1, 0, 821 + i))));
  assert.equal(results.filter(r => !r.stale).length, 1);
  assert.ok(results.every(r => r.mine.revision === 1 && r.mine.picks.length === 2));
  assert.equal(f.documents.robbery_rounds[0].mine.receipts.length, 1);
  assert.deepEqual(await balances(f), [1000, 2000]);
});

for (const [cell, pick, money, target, outcome, amount, shield] of [
  [2, 1, 1000, 2000, 'win', 600, 3600000],
  [9, 9, 1000, 2000, 'loss', 600, 900000],
  [2, 1, 1000, 0, 'win', 0, 0],
  [9, 9, 0, 2000, 'loss', 0, 900000]
]) test(`mine ${outcome}, amount ${amount}: settles once, keeps current protection, and stages both DMs`, async () => {
  const f = await setup(cell, money, target), result = await f.service.settleRobbery(click(pick));
  assert.equal(result.status, 'settled'); assert.equal(result.result.outcome, outcome); assert.equal(result.result.amount, amount);
  assert.equal(result.protection?.durationMs || 0, shield);
  assert.deepEqual(await balances(f), [result.result.after.user, result.result.after.target]);
  const replay = await f.open(at + 1000).service.settleRobbery(click(3, 0, 899));
  assert.equal(replay.duplicate, true); assert.deepEqual(replay.result, result.result);
  const events = result.dmEvents.filter(e => e.kind === 'robbery_result');
  assert.deepEqual(new Set(events.map(e => e.userId)), new Set([user, other]));
  for (const e of events) {
    assert.equal(e.data.game, 'mine');
    assert.match(memberNotification(e, {}, config.clanGuildId).embeds[0].data.description, /لعبة اللغم/);
  }
});

test('ownership, room, membership, stale cells, cross-game buttons, and bad input cannot spend or advance', async () => {
  const f = await setup();
  for (const patch of [{ userId: other }, { channelId: actor }, { cell: 0 }, { cell: 10 }, { revision: -1 }, { revision: 9 },
    { cell: undefined, move: 'rock' }]) await assert.rejects(f.service.settleRobbery(click(1, 0, 821, patch)));
  const departed = await setup();
  await assert.rejects(departed.service.settleRobbery(click(), () => false), /عضوية/);
  assert.equal(departed.documents.robbery_rounds[0].status, 'cancelled');
  await f.service.settleRobbery(click());
  await assert.rejects(f.service.settleRobbery(click(2, 1, 822)), /مكشوف/);
  assert.equal((await f.service.settleRobbery(click(3, 0, 822))).stale, true);
  f.documents.leases[0].expiresAt = at;
  await assert.rejects(f.service.settleRobbery(click(3, 1, 822)), /قفل تشغيل/);
  assert.deepEqual(await balances(f), [1000, 2000]);
});

test('target protection, bank changes and resets stop ongoing mine turns without a transfer', async () => {
  for (const reason of ['shield', 'channel', 'reset', 'disabled']) {
    const f = await setup(9, 1000, 20000); await f.service.settleRobbery(click());
    if (reason === 'shield') await f.service.buyProtection({ id: snowflake(at, 870), userId: other, channelId, at });
    if (reason === 'channel') f.documents.settings[0].bank.channelVersion++;
    if (reason === 'disabled') f.documents.settings[0].bank.robberyEnabled = false;
    if (reason === 'reset') f.store.scopedResetCutoff = () => at + 1;
    if (reason === 'disabled') await assert.rejects(f.service.settleRobbery(click(9, 1, 822)));
    else assert.equal((await f.service.settleRobbery(click(9, 1, 822))).status, 'cancelled');
    assert.equal(f.documents.robbery_rounds[0].mine.revision, 1);
    assert.ok(f.documents.days.every(d => !d.robberyReceipts?.length));
  }
});

test('legacy RPS rounds remain playable and mine buttons cannot select a different game', async () => {
  const f = await setup(); Object.assign(f.documents.robbery_rounds[0], { botMove: 'rock' });
  delete f.documents.robbery_rounds[0].game; delete f.documents.robbery_rounds[0].mine;
  await assert.rejects(f.service.settleRobbery(click()), /لا يطابق/);
  const round = await f.service.settleRobbery({ ...click(), cell: undefined, move: 'paper' });
  assert.equal(round.result.outcome, 'win'); assert.equal(robberyPayload(round).components.length, 1);
});

for (const phase of ['before', 'after']) test(`safe-turn ${phase}-write interruption preserves the original board or committed pair`, async () => {
  const f = await setup(); let failed = false;
  f.intercept(e => {
    if (!failed && e.name === 'robbery_rounds' && e.method === 'replaceOne' && e.phase === phase) {
      failed = true; throw new Error('interrupted turn');
    }
  });
  if (phase === 'before') await assert.rejects(f.service.settleRobbery(click()), /لم يتأكد حفظ دور/);
  else assert.equal((await f.service.settleRobbery(click())).mine.revision, 1);
  f.intercept(() => {});
  const restarted = f.open(at + 1000), replay = await restarted.service.settleRobbery(click());
  assert.equal(replay.mine.revision, 1); assert.equal(replay.mine.picks.length, 2);
  assert.equal(replay.mine.botOrder[0], 1); assert.deepEqual(await balances(f), [1000, 2000]);
});

for (const [collection, phase, stage] of [
  ['robberies', 'before', 'reserve'], ['robberies', 'after', 'reserve'],
  ['days', 'before', 'debit'], ['days', 'after', 'debit'], ['days', 'before', 'credit'], ['days', 'after', 'credit'],
  ['robbery_rounds', 'before', 'result'], ['robbery_rounds', 'after', 'result'],
  ['robberies', 'before', 'clear'], ['robberies', 'after', 'clear']
]) test(`mine settlement recovery: ${stage} ${phase}`, async () => {
  const f = await setup(2); let failed = false;
  f.intercept(e => {
    const d = e.args[1];
    const match = stage === 'reserve' ? !!d?.pending : stage === 'clear' ? d?.pending === null
      : stage === 'result' ? d?.status === 'settled'
        : d?.robberyReceipts?.includes(id) && d.userId === (stage === 'debit' ? other : user);
    if (!failed && e.name === collection && e.method === 'replaceOne' && e.phase === phase && match) {
      failed = true; throw new Error('lost write');
    }
  });
  await assert.rejects(f.service.settleRobbery(click()), /لم يتأكد/); assert.equal(failed, true);
  await assert.rejects(f.service.balance(user), /الاحتساب متوقف/);
  f.intercept(() => {});
  const restarted = f.open(at + 1000); await restarted.store.robbery.recover(at + 1000);
  const replay = await restarted.service.settleRobbery(click());
  assert.equal(replay.mine.cell, 2); assert.equal(replay.mine.loser, 'bot'); assert.equal(replay.mine.picks.length, 2);
  assert.equal(replay.result.outcome, 'win'); assert.deepEqual(await balances(f), [1600, 1400]);
  assert.ok(f.documents.days.every(d => d.robberyReceipts.length === 1));
  assert.equal(await restarted.store.robbery.recover(at + 1000), null);
});

test('3×3 board hides the mine, marks safe numbers with green eyes and the hit with a red bomb', async () => {
  const f = await setup(), open = robberyPayload(f.round, {}, interaction());
  assert.equal(open.components.length, 3);
  assert.deepEqual(open.components.flatMap(r => r.components.map(b => b.data.label)), MINE_CELLS.map(String));
  assert.ok(open.components.every(r => r.components.length === 3));
  assert.ok(!JSON.stringify(open).includes('botOrder'));
  assert.ok(!JSON.stringify(open).includes('💣 رقم 9'));
  const first = await f.service.settleRobbery(click());
  const next = robberyPayload(first), buttons = next.components.flatMap(r => r.components.map(b => b.toJSON()));
  assert.ok(buttons.slice(0, 2).every(b => b.emoji.name === '👁️' && b.style === ButtonStyle.Success && b.disabled));
  assert.ok(buttons.slice(2).every(b => !b.disabled && b.style === ButtonStyle.Secondary));
  const settled = await f.service.settleRobbery(click(9, 1, 822));
  const end = robberyPayload(settled), all = end.components.flatMap(r => r.components.map(b => b.toJSON()));
  assert.ok(all.every(b => b.disabled)); assert.equal(all[8].emoji.name, '💣'); assert.equal(all[8].style, ButtonStyle.Danger);
  assert.match(end.embeds[0].data.description, /وقعت في اللغم/);
  assert.deepEqual(end.embeds[0].data.fields.map(f => f.name), ['اختيارك', 'اختيار البوت', 'النسبة', 'المبلغ', 'رصيدك', 'حماية الضحية']);
  assert.ok(all.every(b => b.custom_id.length <= 100)); assert.equal(end.embeds[0].toJSON().color, 0xffffff);
  assert.deepEqual(end.allowedMentions, { parse: [] });
});

test('mine component parser rejects malformed cells/revisions and keeps RPS IDs compatible', () => {
  assert.deepEqual(parseRobberyAction(key()), { userId: user, id, cell: 1, revision: 0 });
  for (const bad of [key(0), key(10), key(1, -1), key(1, 6), key() + ':extra']) assert.equal(parseRobberyAction(bad), null);
  assert.equal(parseRobberyAction(`clan-robbery:v1:${user}:${id}:paper`).move, 'paper');
});

test('slash and text render the committed player and bot turns in one usable board', async () => {
  for (const textCommand of [false, true]) {
    const f = await setup(), handler = handlerFor(f), i = interaction();
    if (textCommand) await createTextCommands(handler, config)({ ...i, author: i.user, content: `نهب <@${other}>`,
      mentions: { users: new Map([[other, { id: other, bot: false }]]) } });
    else await handler(i);
    assert.equal(i.calls.at(-1)[1].components.length, 3);
    const press = interaction({ customId: key() }); await handler(press);
    const edits = press.calls.filter(c => c[0] === 'editReply').map(c => c[1]);
    assert.equal(edits.length, 1);
    assert.ok(edits[0].components.flatMap(r => r.components).some(b => !b.data.disabled));
    assert.match(edits[0].embeds[0].data.description, /البوت اختار.*2/); assert.match(edits[0].embeds[0].data.description, /دورك/);
    const intruder = interaction({ customId: key(3, 1), who: other }); await handler(intruder);
    assert.equal(intruder.calls[0][1].flags, MessageFlags.Ephemeral);
  }
});

test('failed Discord edit and replay cannot repeat a safe bot turn or financial transfer', async () => {
  for (const mine of [2, 9]) {
    const f = await setup(mine), handler = handlerFor(f), first = interaction({ customId: key() });
    first.editReply = async () => { throw new Error('Discord unavailable'); };
    await handler(first); assert.equal(first.calls.at(-1)[0], 'followUp');
    const retry = interaction({ customId: key(), sequence: 899 }); await handler(retry);
    assert.equal(f.documents.robbery_rounds[0].mine.picks.length, 2);
    assert.equal(retry.calls.filter(c => c[0] === 'editReply').length, 1);
    assert.deepEqual(await balances(f), mine === 2 ? [1600, 1400] : [1000, 2000]);
  }
});

test('a mine result keeps the one-minute cooldown, including restart and a different target', async () => {
  const f = await setup(2); await f.service.settleRobbery(click());
  assert.deepEqual((await f.service.commandTimes(user, channelId)).robbery, { status: 'cooldown', nextAt: at + 60000 });
  const early = at + 60000 - 1;
  await assert.rejects(f.open(early).service.openRobbery(input({ id: snowflake(early), at: early, targetId: actor })), /1 ثانية كاملة/);
  const later = at + 60000;
  const current = f.open(later);
  assert.equal((await current.service.commandTimes(user, channelId)).robbery.status, 'ready');
  const next = await current.service.openRobbery(input({ id: snowflake(later), at: later, targetId: actor }), () => true, dice());
  assert.equal(next.game, 'mine');
  assert.deepEqual((await current.service.commandTimes(user, channelId)).robbery, { status: 'open', expiresAt: next.expiresAt });
  await current.service.settleRobbery(click(9, 0, 850, { id: next.id }));
  assert.deepEqual((await current.service.commandTimes(user, channelId)).robbery, { status: 'cooldown', nextAt: later + 60000 });
  await assert.rejects(f.open(later + 1000).service.openRobbery(input({ id: snowflake(later + 1000), at: later + 1000, targetId: actor }), () => true), /تحت الحماية|59 ثانية/);
});
