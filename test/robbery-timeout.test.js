import test from 'node:test';
import assert from 'node:assert/strict';
import { RobberyManager } from '../src/robbery-manager.js';
import { robberyPayload, createRobberyHandler } from '../src/robbery-commands.js';
import { memberNotification } from '../src/notification-views.js';
import { robberyNotices } from '../src/notification-events.js';
import { createTextCommands } from '../src/experience-commands.js';
import { fixture, at, user, other, actor, config, snowflake } from './helpers/shop-fixture.js';

const channelId = '100000000000000060', roundId = snowflake(at, 950), messageId = snowflake(at, 951);
const deadline = at + 120000;
const dice = game => (min, max) => min === 15 ? 30 : min === 40 ? 60 : game === 'mine' ? (min === 1 ? 9 : max - 1) : 0;
const request = (patch = {}) => ({ id: roundId, userId: user, targetId: other, channelId, at, ...patch });
const click = (game = 'rps', patch = {}) => ({ id: roundId, userId: user, channelId, resolutionId: snowflake(at, 952),
  ...(game === 'mine' ? { cell: 1, revision: 0 } : { move: 'paper' }), ...patch });
const balances = f => Promise.all([user, other].map(id => f.store.totals(id, 'all', f.now()).then(b => b.total)));
async function setup(game = 'rps', money = 1000, target = 2000) {
  const f = await fixture(); let now = at;
  f.service.clock = () => now;
  await f.store.robbery.initialize(at); await f.store.notifications.initialize(at);
  await f.seed(user, money); await f.seed(other, target); await f.seed(actor, 1000);
  const round = await f.service.openRobbery(request(), () => true, dice(game));
  return { ...f, round, now: () => now, time: t => { now = t; } };
}

for (const game of ['rps', 'mine']) test(`${game}: no click loses automatically exactly at expiry, grants normal loss shield, and notifies both sides`, async () => {
  const f = await setup(game); f.time(deadline - 1);
  assert.deepEqual(await f.service.expireRobberies(), []); assert.deepEqual(await balances(f), [1000, 2000]);
  f.time(deadline); const [round] = await f.service.expireRobberies();
  assert.equal(round.status, 'settled'); assert.equal(round.endReason, 'timeout'); assert.equal(round.result.outcome, 'loss');
  assert.equal(round.result.percent, 60); assert.equal(round.result.amount, 600); assert.deepEqual(await balances(f), [400, 2600]);
  assert.equal(round.protection.expiresAt, deadline + 900000); assert.equal(round.protection.userId, other);
  assert.deepEqual(await f.service.expireRobberies(), []);
  const replay = await f.service.settleRobbery(click(game)); assert.equal(replay.duplicate, true);
  assert.equal(replay.resolutionId, `timeout:${roundId}`); assert.deepEqual(await balances(f), [400, 2600]);
  const notices = round.dmEvents.filter(e => e.kind === 'robbery_result');
  assert.deepEqual(new Set(notices.map(e => e.userId)), new Set([user, other]));
  for (const event of notices) {
    const text = memberNotification(event, {}, config.clanGuildId).embeds[0].data.description;
    assert.match(text, /انتهاء الوقت/); assert.ok(!text.includes('اختار اللغم'));
  }
  const payload = robberyPayload(round);
  assert.match(payload.embeds[0].data.title, /خسرت التحدي/);
  assert.ok(payload.components.flatMap(r => r.components).every(b => b.data.disabled));
  assert.ok(!payload.embeds[0].data.description.includes('وقعت في اللغم'));
});

test('starting the mine then abandoning it loses without inventing another pick or moving the mine', async () => {
  const f = await setup('mine'); await f.service.settleRobbery(click('mine'));
  const before = structuredClone(f.documents.robbery_rounds[0].mine);
  f.time(deadline); const [round] = await f.service.expireRobberies();
  assert.deepEqual(round.mine, before); assert.deepEqual(await balances(f), [400, 2600]);
  assert.ok(robberyPayload(round).components.flatMap(r => r.components).every(b => b.data.emoji?.name !== '💣'));
});

test('a stale mine click at expiry shows only the timeout result, without a phantom bot animation', async () => {
  const f = await setup('mine'); await f.service.settleRobbery(click('mine')); f.time(deadline);
  const edits = [], handler = createRobberyHandler({ ...f, config, isBankMember: () => true,
    robberyPause: async () => { throw new Error('must not animate a closed round'); } });
  await handler({ id: snowflake(deadline, 980), user: { id: user, bot: false }, guildId: config.clanGuildId, channelId,
    customId: `clan-robbery:v1:${user}:${roundId}:mine:0:1`, deferUpdate: async () => {},
    editReply: async p => edits.push(p), followUp: async p => edits.push(p) });
  assert.equal(edits.length, 1); assert.match(edits[0].embeds[0].data.title, /خسرت التحدي/);
  assert.deepEqual(await balances(f), [400, 2600]);
});

for (const game of ['rps', 'mine']) test(`${game}: a press and background expiry racing at the deadline cannot play or charge twice`, async () => {
  const f = await setup(game); f.time(deadline);
  await Promise.all([f.service.settleRobbery(click(game)), f.service.expireRobberies(), f.service.settleRobbery(click(game))]);
  assert.equal(f.documents.robbery_rounds[0].endReason, 'timeout');
  assert.ok(f.documents.days.filter(d => [user, other].includes(d.userId)).every(d => d.robberyReceipts.length === 1));
  assert.deepEqual(await balances(f), [400, 2600]);
});

test('a move committed before the deadline keeps its result and cannot become a later timeout loss', async () => {
  const f = await setup(); f.time(deadline - 1);
  const paid = await f.service.settleRobbery(click()); assert.equal(paid.result.outcome, 'win');
  f.time(deadline); assert.deepEqual(await f.service.expireRobberies(), []);
  assert.equal((await f.service.settleRobbery(click())).result.outcome, 'win'); assert.deepEqual(await balances(f), [1600, 1400]);
});

test('timeout uses available balances, including an empty wallet, without counting it as a tie', async () => {
  for (const money of [0, 1, 1000]) {
    const f = await setup('mine', money); f.time(deadline);
    const [round] = await f.service.expireRobberies(); assert.equal(round.result.outcome, 'loss');
    assert.equal(round.result.amount, Math.floor(money * 0.6)); assert.equal(round.protection.durationMs, 900000);
  }
});

test('bank resets, disabled robbery and moved channels cancel games instead of imposing timeout penalties', async () => {
  for (const change of ['reset', 'off', 'channel']) {
    const f = await setup(); f.time(deadline);
    if (change === 'reset') f.store.scopedResetCutoff = () => at + 1;
    if (change === 'off') f.documents.settings[0].bank.robberyEnabled = false;
    if (change === 'channel') f.documents.settings[0].bank.channelVersion++;
    const [round] = await f.service.expireRobberies(); assert.equal(round.status, 'cancelled');
    assert.deepEqual(await balances(f), [1000, 2000]); assert.equal(round.result, undefined);
  }
});

test('older unplayed rounds never gain a retroactive timeout penalty', async () => {
  const f = await setup(); delete f.documents.robbery_rounds[0].timeoutLoss;
  f.time(deadline); assert.equal((await f.service.expireRobberies())[0].status, 'expired');
  assert.equal((await f.service.settleRobbery(click())).status, 'expired');
  assert.deepEqual(await balances(f), [1000, 2000]);
  assert.equal((await f.service.openRobbery(request({ id: snowflake(deadline), at: deadline }), () => true, dice('rps'))).status, 'open');
});

test('the same target accepts only the first concurrent attacker, across both game types and restart', async () => {
  const f = await fixture(); await f.store.robbery.initialize(at);
  const calls = Array.from({ length: 12 }, (_, i) => f.service.openRobbery(request({ id: snowflake(at, 950 + i),
    userId: i % 2 ? actor : user }), () => true, dice(i % 2 ? 'mine' : 'rps')));
  const result = await Promise.allSettled(calls);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1); assert.equal(f.documents.robbery_rounds.length, 1);
  assert.ok(result.filter(r => r.status === 'rejected').every(r => /تحدي نهب (قائم|مفتوح)/.test(r.reason.message)));
  await assert.rejects(f.open(at + 1000).service.openRobbery(request({ id: snowflake(at, 980), userId: actor })), /تحدي نهب قائم/);
  assert.equal((await f.open(at + 1000).service.openRobbery(request({ id: snowflake(at, 981), userId: actor, targetId: user }))).status, 'open');
});

test('the target lock is released on settlement while normal protection remains, including for a tie', async () => {
  const f = await setup(); await f.service.settleRobbery(click('rps', { move: 'rock' }));
  assert.equal((await f.service.openRobbery(request({ id: snowflake(at, 980), userId: actor }))).status, 'open');
  const next = await setup(); next.time(deadline);
  await assert.rejects(next.service.openRobbery(request({ id: snowflake(deadline, 980), userId: actor, at: deadline })), /تحت الحماية/);
  assert.equal(next.documents.robbery_rounds[0].endReason, 'timeout'); assert.deepEqual(await balances(next), [400, 2600]);
});

test('invalidated games release the target, and the old player cannot settle them later', async () => {
  const f = await setup(); f.documents.settings[0].bank.channelVersion++;
  assert.equal((await f.service.openRobbery(request({ id: snowflake(at, 980), userId: actor }))).status, 'open');
  assert.equal((await f.service.settleRobbery(click())).status, 'cancelled'); assert.deepEqual(await balances(f), [1000, 2000]);
});

test('an attacker cannot open another target to escape an overdue loss before the timer runs', async () => {
  const f = await setup(); f.time(deadline);
  const next = await f.service.openRobbery(request({ id: snowflake(deadline, 980), targetId: actor, at: deadline }));
  assert.equal(next.status, 'open'); assert.equal(f.documents.robbery_rounds[0].endReason, 'timeout');
  assert.deepEqual(await balances(f), [400, 2600]);
});

test('buying protection mid-game cancels the blocked challenge without imposing a timeout debit', async () => {
  const f = await setup('mine', 1000, 20000);
  await f.service.buyProtection({ id: snowflake(at, 984), userId: other, channelId, at });
  f.time(deadline); const [round] = await f.service.expireRobberies();
  assert.equal(round.status, 'cancelled'); assert.equal(round.endReason, 'protection');
  assert.deepEqual(await balances(f), [1000, 10000]);
  assert.equal((await f.store.robbery.activeProtection(other, deadline)).expiresAt, at + 10800000);
});

test('lost lease blocks expiry and cannot debit or release a target reservation', async () => {
  const f = await setup(); f.time(deadline); f.documents.leases[0].expiresAt = deadline;
  await assert.rejects(f.service.expireRobberies(), /قفل تشغيل/);
  assert.equal(f.documents.robbery_rounds[0].status, 'open'); assert.deepEqual(await balances(f), [1000, 2000]);
});

for (const [collection, phase, stage] of [
  ['robberies', 'before', 'reserve'], ['robberies', 'after', 'reserve'],
  ['days', 'before', 'debit'], ['days', 'after', 'debit'], ['days', 'before', 'credit'], ['days', 'after', 'credit'],
  ['robbery_rounds', 'before', 'result'], ['robbery_rounds', 'after', 'result'],
  ['robberies', 'before', 'clear'], ['robberies', 'after', 'clear']
]) test(`timeout journal recovery: ${stage} ${phase}`, async () => {
  const f = await setup('mine'); f.time(deadline); let failed = false;
  f.intercept(e => {
    const d = e.args[1];
    const match = stage === 'reserve' ? !!d?.pending : stage === 'clear' ? d?.pending === null
      : stage === 'result' ? d?.status === 'settled'
        : d?.robberyReceipts?.includes(roundId) && d.userId === (stage === 'debit' ? user : other);
    if (!failed && e.name === collection && e.method === 'replaceOne' && e.phase === phase && match) {
      failed = true; throw new Error('interrupted timeout');
    }
  });
  await assert.rejects(f.service.expireRobberies(), /لم يتأكد/); assert.equal(failed, true);
  await assert.rejects(f.service.balance(user), /الاحتساب متوقف/);
  f.intercept(() => {});
  const restart = f.open(deadline + 1000); await restart.store.notifications.initialize(deadline + 1000);
  await restart.store.robbery.recover(deadline + 1000); await restart.service.expireRobberies();
  assert.deepEqual(await balances(f), [400, 2600]);
  const round = await restart.store.robbery.round(roundId);
  assert.equal(round.endReason, 'timeout'); assert.equal(round.resolutionId, `timeout:${roundId}`);
  assert.equal(round.mine.picks.length, 0); assert.equal(round.dmEvents.filter(e => e.kind === 'robbery_result').length, 2);
  assert.equal((await restart.service.settleRobbery(click('mine'))).duplicate, true);
  assert.deepEqual(await restart.service.expireRobberies(), []);
});

async function managed(game = 'rps') {
  const f = await setup(game), edits = [], errors = [];
  const state = { ready: true, enabled: true, failEdit: false, missing: false, editWait: null };
  const message = { id: messageId, author: { id: actor }, components: robberyPayload(f.round).components,
    edit: async payload => {
      if (state.editWait) await state.editWait;
      if (state.failEdit) throw new Error('Discord edit failed');
      edits.push(payload); message.components = payload.components; return message;
    } };
  const channel = { guildId: config.clanGuildId, messages: { fetch: async value => {
    if (state.missing) throw Object.assign(new Error('deleted'), { code: 10008 });
    return typeof value === 'string' ? message : new Map([[messageId, message]]);
  } } };
  const bot = { user: { id: actor }, isReady: () => state.ready, channels: { fetch: async () => channel } };
  const open = (service = f.service, store = f.store) => new RobberyManager({ bot, store, service, clock: f.now,
    canRun: () => state.enabled && !service.blocked, onError: e => errors.push(e) });
  const manager = open(); await f.service.bindRobberyMessage(roundId, messageId, { name: 'اسم اللاعب' });
  return { ...f, message, manager, openManager: open, state, bot, edits, errors };
}

for (const game of ['rps', 'mine']) test(`${game}: the worker updates the original public message without a click and survives restarting`, async () => {
  const f = await managed(game); f.time(deadline);
  const restart = f.open(deadline), worker = f.openManager(restart.service, restart.store);
  await worker.tick(); await worker.drain();
  assert.equal(f.edits.length, 1); assert.match(f.edits[0].embeds[0].data.title, /انتهى الوقت/);
  assert.equal(f.edits[0].embeds[0].data.author.name, 'اسم اللاعب');
  assert.equal(f.documents.robbery_rounds[0].delivery.complete, true);
  await worker.tick(); await worker.drain(); assert.equal(f.edits.length, 1); assert.deepEqual(await balances(f), [400, 2600]);
});

test('Discord being offline or refusing edits never postpones settlement or repeats the debit', async () => {
  const f = await managed(); f.state.ready = false; f.time(deadline);
  await f.manager.tick(); await f.manager.drain(); assert.deepEqual(await balances(f), [400, 2600]); assert.equal(f.edits.length, 0);
  f.state.ready = true; f.state.failEdit = true;
  await f.manager.tick(); await f.manager.drain(); assert.equal(f.errors.length, 1);
  f.state.failEdit = false; await f.manager.tick(); await f.manager.drain(); assert.equal(f.edits.length, 0);
  f.time(deadline + 10000); await f.manager.tick(); await f.manager.drain();
  assert.equal(f.edits.length, 1); assert.deepEqual(await balances(f), [400, 2600]);
});

test('a slow Discord edit cannot block other rounds from losing at their deadline', async () => {
  const f = await managed(); let release;
  f.state.editWait = new Promise(resolve => { release = resolve; });
  f.time(at + 1000);
  const nextId = snowflake(at + 1000, 988);
  await f.service.openRobbery(request({ id: nextId, userId: actor, targetId: user, at: at + 1000 }));
  f.time(deadline); await f.manager.tick();
  f.time(deadline + 1000); await f.manager.tick();
  assert.equal((await f.store.robbery.round(nextId)).endReason, 'timeout');
  release(); await f.manager.drain();
});

test('deleted messages are not re-sent, and an unbound sent message is recovered by its saved button IDs', async () => {
  const missing = await managed(); missing.state.missing = true; missing.time(deadline);
  await missing.manager.tick(); await missing.manager.drain();
  assert.equal(missing.edits.length, 0); assert.equal(missing.documents.robbery_rounds[0].delivery.complete, true);
  const unbound = await managed('mine'); delete unbound.documents.robbery_rounds[0].delivery.messageId; unbound.time(deadline);
  await unbound.manager.tick(); await unbound.manager.drain();
  assert.equal(unbound.edits.length, 1); assert.equal(unbound.documents.robbery_rounds[0].delivery.messageId, messageId);
  assert.deepEqual(await balances(unbound), [400, 2600]);
});

test('a stopped worker cannot settle or edit until it resumes', async () => {
  const f = await managed(); f.state.enabled = false; f.time(deadline);
  await f.manager.tick(); await f.manager.drain(); assert.equal(f.documents.robbery_rounds[0].status, 'open');
  f.state.enabled = true; await f.manager.tick(); await f.manager.drain(); assert.equal(f.edits.length, 1);
});

test('slash and text commands save their reply identity for automatic timeout edits', async () => {
  for (const text of [false, true]) {
    const f = await managed(); delete f.documents.robbery_rounds[0].delivery.messageId;
    const handler = createRobberyHandler({ ...f, config, robberies: f.manager, isBankMember: () => true });
    const i = { id: roundId, createdTimestamp: at, guildId: config.clanGuildId, channelId,
      commandName: 'نهب', user: { id: user, bot: false, username: 'صاحب الأمر' },
      options: { getUser: () => ({ id: other, bot: false }) }, deferReply: async () => {},
      editReply: f.message.edit, reply: f.message.edit };
    if (text) await createTextCommands(handler, config)({ ...i, author: i.user, content: `نهب <@${other}>`,
      mentions: { users: new Map([[other, { id: other, bot: false }]]) } });
    else await handler(i);
    assert.equal(f.documents.robbery_rounds[0].delivery.messageId, messageId);
    assert.equal(f.documents.robbery_rounds[0].displayAuthor.name, 'صاحب الأمر');
  }
});

test('a failed safe-turn edit recovers automatically without another click, including after restart', async () => {
  const f = await managed('mine');
  f.documents.robbery_rounds[0].delivery.required = true;
  await f.service.confirmRobberyDisplay(f.round, messageId);
  const handler = createRobberyHandler({ ...f, config, robberies: f.manager, isBankMember: () => true });
  await handler({ id: snowflake(at, 985), user: { id: user, bot: false }, guildId: config.clanGuildId, channelId,
    customId: `clan-robbery:v1:${user}:${roundId}:mine:0:1`, message: f.message,
    deferUpdate: async () => {}, editReply: async () => { throw new Error('Discord unavailable'); }, followUp: async () => {} });
  const saved = await f.store.robbery.round(roundId);
  assert.equal(saved.mine.revision, 1); assert.equal(saved.delivery.complete, false);
  const restarted = f.open(at + 1000), worker = f.openManager(restarted.service, restarted.store);
  await worker.tick(); await worker.drain();
  const buttons = f.edits.at(-1).components.flatMap(r => r.components);
  assert.equal(buttons.filter(b => b.data.emoji?.name === '👁️').length, 2);
  assert.equal(buttons.filter(b => !b.data.disabled).length, 7);
  assert.equal(f.documents.robbery_rounds[0].delivery.complete, true);
  assert.deepEqual(f.documents.robbery_rounds[0].mine, saved.mine);
  assert.deepEqual(await balances(f), [1000, 2000]);
});

test('legacy boards stuck on the old bot preview are restored from the saved pair', async () => {
  const f = await managed('mine'); await f.service.settleRobbery(click('mine'));
  delete f.documents.robbery_rounds[0].timeoutLoss; delete f.documents.robbery_rounds[0].delivery;
  f.message.components = robberyPayload({ ...f.documents.robbery_rounds[0], displayBotTurn: true }).components;
  assert.ok(f.message.components.flatMap(r => r.components).every(b => b.data.disabled));
  await f.manager.tick(); await f.manager.drain();
  assert.ok(f.edits.at(-1).components.flatMap(r => r.components).some(b => !b.data.disabled));
  assert.equal(f.documents.robbery_rounds[0].mine.revision, 1);
  assert.deepEqual(await balances(f), [1000, 2000]);
});

for (const game of ['mine', 'rps']) test(`${game}: an unpublished game never incurs an inactivity debit`, async () => {
  const f = await fixture(); await f.store.robbery.initialize(at); await f.seed(user); await f.seed(other, 2000);
  const round = await f.service.openRobbery(request({ requireDelivery: true }), () => true, dice(game));
  assert.equal(round.delivery.required, true);
  const restarted = f.open(deadline), [closed] = await restarted.service.expireRobberies();
  assert.equal(closed.status, 'cancelled'); assert.equal(closed.endReason, 'delivery');
  assert.equal(closed.result, undefined); assert.ok(f.documents.days.every(d => !d.robberyReceipts?.length));
  assert.match(robberyPayload(closed).embeds[0].data.description, /لم يُخصم/);
});

test('an undelivered safe turn cancels at expiry rather than fining a player who cannot see the current board', async () => {
  const f = await managed('mine'); f.documents.robbery_rounds[0].delivery.required = true;
  await f.service.confirmRobberyDisplay(f.round, messageId);
  await f.service.settleRobbery(click('mine')); f.state.failEdit = true;
  await f.manager.tick(); await f.manager.drain();
  f.time(deadline); await f.manager.tick(); await f.manager.drain();
  const saved = await f.store.robbery.round(roundId);
  assert.equal(saved.status, 'cancelled'); assert.equal(saved.endReason, 'delivery');
  assert.deepEqual(await balances(f), [1000, 2000]);
  f.state.failEdit = false; f.time(deadline + 10000); await f.manager.tick(); await f.manager.drain();
  assert.match(f.edits.at(-1).embeds[0].data.description, /لم يُخصم/);
});

test('a recovered, confirmed board still applies the normal inactivity loss exactly once', async () => {
  const f = await managed('mine'); f.documents.robbery_rounds[0].delivery.required = true;
  await f.service.settleRobbery(click('mine'));
  await f.manager.tick(); await f.manager.drain();
  assert.equal(f.documents.robbery_rounds[0].delivery.complete, true);
  f.time(deadline); await f.manager.tick(); await f.manager.drain();
  assert.equal(f.documents.robbery_rounds[0].endReason, 'timeout');
  assert.deepEqual(await balances(f), [400, 2600]);
  await f.manager.tick(); await f.manager.drain(); assert.deepEqual(await balances(f), [400, 2600]);
});

test('an old display acknowledgement cannot hide an unrendered newer mine turn', async () => {
  const f = await managed('mine'); await f.service.confirmRobberyDisplay(f.round, messageId);
  const next = await f.service.settleRobbery(click('mine'));
  await f.service.confirmRobberyDisplay(f.round, messageId);
  assert.equal(f.documents.robbery_rounds[0].delivery.complete, false);
  await f.service.confirmRobberyDisplay(next, messageId);
  assert.equal(f.documents.robbery_rounds[0].delivery.complete, true);
});

test('expiry during an in-flight old board edit leaves the final result queued for display', async () => {
  const f = await managed('mine'); let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const edit = f.message.edit;
  f.message.edit = async payload => { entered(); await wait; return edit(payload); };
  await f.manager.tick(); await started;
  f.time(deadline); await f.service.expireRobberies(); release(); await f.manager.drain();
  assert.equal(f.documents.robbery_rounds[0].delivery.complete, false);
  f.message.edit = edit; await f.manager.tick(); await f.manager.drain();
  assert.match(f.edits.at(-1).embeds[0].data.title, /انتهى الوقت/);
  assert.deepEqual(await balances(f), [400, 2600]);
});

test('a deleted active message closes the challenge and releases its target without charging', async () => {
  const f = await managed('mine'); f.state.missing = true;
  await f.manager.tick(); await f.manager.drain();
  assert.equal(f.documents.robbery_rounds[0].status, 'cancelled');
  assert.equal(f.documents.robbery_rounds[0].delivery.complete, true);
  f.time(deadline); await f.service.expireRobberies(); assert.deepEqual(await balances(f), [1000, 2000]);
  assert.equal((await f.service.openRobbery(request({ id: snowflake(deadline, 982), userId: actor, at: deadline }))).status, 'open');
});

test('old abandoned rounds cannot starve current expiry or impose retroactive debits', async () => {
  const f = await setup();
  for (let i = 0; i < 60; i++) {
    const old = structuredClone(f.documents.robbery_rounds[0]);
    old.id = snowflake(at - 600000, i); old._id = `${config.clanGuildId}:${old.id}`;
    old.createdAt = old.requestAt = at - 600000; old.expiresAt = at - 480000;
    delete old.timeoutLoss; delete old.delivery; f.documents.robbery_rounds.push(old);
  }
  f.time(deadline); await f.service.expireRobberies();
  assert.equal(f.documents.robbery_rounds.filter(r => r.status === 'expired').length, 60);
  assert.equal(f.documents.robbery_rounds.filter(r => r.status === 'settled').length, 1);
  assert.deepEqual(await balances(f), [400, 2600]);
});

test('the uploaded timedOut result format displays honestly without inventing a mine hit', async () => {
  for (const game of ['mine', 'rps']) {
    const f = await setup(game); f.time(deadline); await f.service.expireRobberies();
    const doc = f.documents.robbery_rounds[0]; delete doc.endReason; doc.timedOut = true;
    if (game === 'mine') doc.mine.loser = 'player'; else doc.playerMove = null;
    const result = await f.store.robbery.round(roundId);
    assert.equal(result.endReason, 'timeout');
    const payload = robberyPayload(doc); assert.match(payload.embeds[0].data.title, /انتهى الوقت/);
    assert.ok(!payload.embeds[0].data.description.includes('وقعت في اللغم'));
    for (const event of robberyNotices(doc).filter(e => e.kind === 'robbery_result')) {
      const text = memberNotification(event, {}, config.clanGuildId).embeds[0].data.description;
      assert.match(text, /انتهاء الوقت/); assert.ok(!text.includes('اختار اللغم'));
    }
    assert.deepEqual(await balances(f), [400, 2600]);
  }
});

for (const game of ['mine', 'rps']) test(`${game}: a confirmed departure cancels durably and cannot become a later inactivity debit`, async () => {
  const f = await setup(game);
  await assert.rejects(f.service.settleRobbery(click(game), id => id === user), /عضوية/);
  assert.equal(f.documents.robbery_rounds[0].endReason, 'membership');
  f.time(deadline); await f.service.expireRobberies();
  assert.deepEqual(await balances(f), [1000, 2000]);
  const retry = await f.service.settleRobbery(click(game)); assert.equal(retry.status, 'cancelled');
});
