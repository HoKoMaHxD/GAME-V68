import test from 'node:test';
import assert from 'node:assert/strict';
import { readBankSettings, bankCommandStatus, MAX_SALARY, SALARY_INTERVAL_MS } from '../src/bank.js';
import { netPoints } from '../src/point-adjustments.js';
import { dayStart } from '../src/time.js';
import { fixture, at, user, other, actor, config, snowflake, request } from './helpers/shop-fixture.js';

const channelId = '100000000000000060';
const nextChannel = '100000000000000061';
const claim = (time = at, sequence = 300, patch = {}) => ({ id: snowflake(time, sequence), userId: user, channelId, at: time, ...patch });
const change = (sequence = 310, patch = {}) => ({ actorId: actor, operationId: snowflake(at, sequence), salaryAmount: 500, ...patch });
const switches = (sequence, fields) => ({ actorId: actor, operationId: snowflake(at, sequence), ...fields });
const robbery = (patch = {}) => ({ id: snowflake(at, 400), userId: user, targetId: other, channelId, at, ...patch });
const choice = (patch = {}) => ({ id: snowflake(at, 400), userId: user, channelId, resolutionId: snowflake(at, 401), move: 'paper', ...patch });
const dice = min => min === 0 ? 0 : min === 40 ? 60 : 30;
async function setup() {
  const f = await fixture(); await f.store.robbery.initialize(at);
  await f.service.configureBank(change());
  return f;
}

test('bank configuration survives restart and salary amount changes preserve old challenges', async () => {
  const f = await fixture();
  delete f.documents.settings[0].bank;
  await assert.rejects(f.service.configureBank(change()), /شات البنك أولًا/);
  const initial = await f.service.configureBank(change(310, { channelId }));
  assert.equal(initial.channelVersion, 1);
  const salary = await f.service.configureBank(change(311, { salaryAmount: 750 }));
  assert.equal(salary.channelVersion, 1); assert.equal(salary.channelId, channelId);
  const moved = await f.service.configureBank(change(312, { channelId: nextChannel, salaryAmount: 750 }));
  assert.equal(moved.channelVersion, 2);
  assert.deepEqual(await f.service.configureBank(change(312, { channelId: nextChannel, salaryAmount: 750 })), moved);
  await assert.rejects(f.service.configureBank(change(311)), /أقدم/);
  const restarted = f.open();
  assert.deepEqual(readBankSettings((await restarted.store.settings()).bank), { protectionPrice: 10000, protectionMinutes: 180, protectionStack: true, channelId: nextChannel, salaryAmount: 750,
    salaryEnabled: true, robberyEnabled: true, channelVersion: 2 });
  assert.equal((await restarted.store.settings()).appearance.name, 'SNOW');
  assert.equal((await restarted.store.shop.get()).products.length, 1);
});

test('invalid settings and lost acknowledgement cannot silently change bank configuration twice', async () => {
  const f = await setup();
  for (const salaryAmount of [-1, 0.5, MAX_SALARY + 1, NaN]) {
    await assert.rejects(f.service.configureBank(change(311, { salaryAmount })), /عددًا صحيحًا/);
  }
  await assert.rejects(f.service.configureBank(change(311, { channelId: 'bad' })), /شات البنك/);
  const before = structuredClone(f.documents.settings);
  for (const field of ['salaryEnabled', 'robberyEnabled']) for (const value of ['false', 0, null, {}]) {
    await assert.rejects(f.service.configureBank(switches(311, { [field]: value })), /قيمة صحيحة/);
  }
  await assert.rejects(f.service.configureBank(change(311, { salaryAmount: 0, salaryEnabled: true })), /أكبر من صفر/);
  assert.deepEqual(f.documents.settings, before);
  let failed = false;
  f.intercept(({ name, method, phase }) => {
    if (!failed && name === 'settings' && method === 'updateOne' && phase === 'after') {
      failed = true; throw new Error('lost acknowledgement');
    }
  });
  const saved = await f.service.configureBank(change(312, { channelId: nextChannel, salaryEnabled: false, robberyEnabled: false }));
  assert.equal(saved.channelVersion, 2); assert.equal(f.service.blocked, false);
  assert.equal((await f.store.settings()).bank.channelId, nextChannel);
  assert.deepEqual(bankCommandStatus((await f.open().store.settings()).bank), { salary: false, robbery: false });
});

test('legacy settings keep enabled commands while zero salaries and absent banks report unavailable', () => {
  assert.deepEqual(bankCommandStatus({ channelId, salaryAmount: 500 }), { salary: true, robbery: true });
  assert.deepEqual(bankCommandStatus({ channelId, salaryAmount: 0 }), { salary: false, robbery: true });
  for (const saved of [undefined, null, { salaryAmount: 500 }]) {
    assert.deepEqual(bankCommandStatus(saved), { salary: false, robbery: false });
  }
});

test('salary off/on persists without losing its amount, balance or one-hour cooldown and never disables robbery', async () => {
  const f = await setup(); await f.seed(); await f.seed(other, 2000);
  const paid = await f.service.claimSalary(claim());
  const before = structuredClone(f.documents.days);
  const disabled = await f.service.configureBank(switches(311, { salaryEnabled: false }));
  assert.equal(disabled.salaryAmount, 500); assert.equal(disabled.channelVersion, 1);
  assert.deepEqual(bankCommandStatus(disabled), { salary: false, robbery: true });
  const restarted = f.open(at + 1000);
  await assert.rejects(restarted.service.claimSalary(claim(at + 1000)), /أمر راتب طافي/);
  assert.deepEqual(f.documents.days, before);
  const round = await restarted.service.openRobbery(robbery(), () => true, dice);
  assert.equal(round.status, 'open');
  await restarted.service.configureBank(switches(312, { salaryEnabled: true }));
  const cooldown = await restarted.service.claimSalary(claim(at + 1000));
  assert.equal(cooldown.status, 'cooldown'); assert.equal(cooldown.nextAt, paid.nextAt);
  assert.deepEqual(f.documents.days, before);
  const result = await restarted.service.settleRobbery(choice());
  assert.equal(result.status, 'settled'); // Salary switches did not cancel the challenge.
  const next = f.open(paid.nextAt);
  assert.equal((await next.service.claimSalary(claim(paid.nextAt))).amount, 500);
  assert.equal(f.documents.days[0].salaryReceipts.length, 2);
});

test('disabling robbery blocks new and old buttons, survives restart and cannot revive old rounds after re-enabling', async () => {
  const f = await setup(); await f.seed(); await f.seed(other, 2000);
  await f.service.openRobbery(robbery(), () => true, dice);
  const disabled = await f.service.configureBank(switches(311, { robberyEnabled: false }));
  assert.deepEqual(bankCommandStatus(disabled), { salary: true, robbery: false });
  const restarted = f.open(); const before = structuredClone(f.documents);
  await assert.rejects(restarted.service.openRobbery(robbery({ id: snowflake(at, 410) })), /أمر نهب طافي/);
  await assert.rejects(restarted.service.settleRobbery(choice()), /أمر نهب طافي/);
  assert.deepEqual(f.documents, before);
  assert.equal((await restarted.service.claimSalary(claim())).status, 'paid');
  await restarted.service.configureBank(switches(312, { robberyEnabled: true }));
  assert.equal((await restarted.service.settleRobbery(choice())).status, 'cancelled');
  assert.equal((await restarted.store.totals(user, 'all', at)).total, 1500);
  restarted.service.clock = () => at + 60000;
  const next = await restarted.service.openRobbery(robbery({ id: snowflake(at + 60000, 410), at: at + 60000 }), () => true, dice);
  assert.equal(next.status, 'open'); assert.notEqual(next.bankVersion, 1);
  assert.equal((await restarted.service.settleRobbery(choice({ id: next.id }))).status, 'settled');
  assert.equal((await restarted.store.totals(user, 'all', at)).total, 2100);
});

test('queued payouts wait for a switch change and cannot spend after both commands are disabled', async () => {
  const f = await setup(); await f.seed(); await f.seed(other, 2000);
  await f.service.openRobbery(robbery(), () => true, dice);
  const before = structuredClone(f.documents.days);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  f.intercept(async ({ name, method, phase }) => {
    if (name === 'settings' && method === 'updateOne' && phase === 'before') { enter(); await paused; }
  });
  const disabling = f.service.configureBank(switches(311, { salaryEnabled: false, robberyEnabled: false }));
  await entered;
  let completed = false;
  const pending = Promise.allSettled([f.service.claimSalary(claim()), f.service.settleRobbery(choice())])
    .then(results => { completed = true; return results; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  release(); await disabling;
  const results = await pending;
  assert.ok(results.every(result => result.status === 'rejected' && /طافي/.test(result.reason.message)));
  assert.deepEqual(f.documents.days, before);
  assert.equal((await f.service.bankTop(user, channelId)).self.value, 1000);
  assert.equal((await f.service.balance(other, channelId)).total, 2000);
});

test('bank service rejects unconfigured and wrong channels for all three commands before changing money', async () => {
  const f = await setup(); await f.seed(); await f.seed(other, 2000);
  for (const invalidChannel of [nextChannel, `${channelId}1`]) {
    await assert.rejects(f.service.bankTop(user, invalidChannel), /فقط/);
    await assert.rejects(f.service.claimSalary(claim(at, 300, { channelId: invalidChannel })), /فقط/);
    await assert.rejects(f.service.openRobbery(robbery({ channelId: invalidChannel })), /فقط/);
  }
  delete f.documents.settings[0].bank;
  await assert.rejects(f.service.bankTop(user, channelId), /اعدادات_البنك/);
  await assert.rejects(f.service.claimSalary(claim()), /اعدادات_البنك/);
  await assert.rejects(f.service.openRobbery(robbery()), /اعدادات_البنك/);
  assert.equal((await f.store.totals(user, 'all', at)).total, 1000);
  assert.equal(f.documents.robbery_rounds.length, 0);
});

test('bank top aggregates current currency across days including quests, salary, robbery, purchases and admin changes', async () => {
  const f = await setup(); await f.seed(user, 1000, 50); await f.seed(other, 2000);
  await f.seed(user, 200, 0, at - 86400000);
  await f.service.claimSalary(claim());
  await f.service.purchase(request());
  await f.service.adjustPoints({ userId: user, actorId: actor, operationId: snowflake(at, 320), at, category: 'total', mode: 'add', amount: 100 });
  await f.service.openRobbery(robbery(), () => true, dice);
  await f.service.settleRobbery(choice());
  const view = await f.service.bankTop(user, channelId);
  assert.deepEqual(view.rows.map(row => [row._id, row.total]), [[user, 2300], [other, 1400]]);
  assert.deepEqual(view.self, { position: 1, value: 2300 }); assert.equal(view.gap, 0);
  assert.equal(view.at, at);
});

test('bank gap targets the immediately preceding member even outside the top ten, with stable ties', async () => {
  const f = await setup();
  for (let i = 0; i < 12; i++) await f.seed(String(BigInt(user) + BigInt(i)), 2000 - 100 * i);
  const id = String(BigInt(user) + 11n);
  const view = await f.service.bankTop(id, channelId);
  assert.equal(view.rows.length, 10); assert.equal(view.rows[9].total, 1100);
  assert.deepEqual(view.self, { position: 12, value: 900 }); assert.equal(view.gap, 101);
  assert.equal(view.nextPosition, 11);
  await f.service.adjustPoints({ userId: id, actorId: actor, operationId: snowflake(at, 320), at, category: 'total', mode: 'add', amount: view.gap });
  assert.equal((await f.service.bankTop(id, channelId)).self.position, 11);
  // A smaller snowflake precedes an equal balance; no extra dollar is needed.
  const older = '100000000000000005'; await f.seed(older, 100);
  const tied = await f.service.bankTop(older, channelId); assert.equal(tied.gap, 900);
  assert.equal(tied.nextPosition, 12);
  await f.service.adjustPoints({ userId: older, actorId: actor, operationId: snowflake(at, 321), at, category: 'total', mode: 'add', amount: tied.gap });
  assert.equal((await f.service.bankTop(older, channelId)).self.position, 12);
});

test('members inside the top ten see the next better rank while first place has no invented target', async () => {
  const f = await setup();
  for (let i = 0; i < 12; i++) await f.seed(String(BigInt(user) + BigInt(i)), 2000 - 100 * i);
  for (const position of [2, 5, 10, 11, 12]) {
    const view = await f.service.bankTop(String(BigInt(user) + BigInt(position - 1)), channelId);
    assert.equal(view.self.position, position);
    assert.equal(view.nextPosition, position - 1); assert.equal(view.gap, 101);
  }
  const leader = await f.service.bankTop(user, channelId);
  assert.equal(leader.nextPosition, null); assert.equal(leader.gap, 0);
});

test('new and zero-balance members have no invented rank or activity-based bank balance', async () => {
  const f = await setup();
  assert.deepEqual((await f.service.bankTop(user, channelId)).self, { position: null, value: 0 });
  await f.seed(user, 0, 0);
  f.documents.days[0].activity = { clanMessages: 900000, voiceMs: 999999999 };
  const view = await f.service.bankTop(user, channelId);
  assert.deepEqual(view.rows, []); assert.equal(view.gap, 1); assert.equal(view.self.position, null);
  assert.equal(view.nextPosition, 1);
  await f.seed(other, 2000); await f.seed(actor, 1000);
  const entry = await f.service.bankTop(user, channelId);
  assert.equal(entry.self.position, null); assert.equal(entry.nextPosition, 2); assert.equal(entry.gap, 1000);
  await f.service.adjustPoints({ userId: user, actorId: actor, operationId: snowflake(at, 320), at,
    category: 'total', mode: 'add', amount: entry.gap });
  assert.equal((await f.service.bankTop(user, channelId)).self.position, 2);
});

test('concurrent salary requests credit each member only once and leave activity and attendance caps unchanged', async () => {
  const f = await setup(); await f.seed(user, 1000, 500);
  f.documents.days[0].activity = { clanMessages: 88, voiceMs: 7200000 };
  const before = structuredClone(f.documents.days[0]);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => f.service.claimSalary(claim(at, 330 + i), async () => true)));
  assert.equal(results.filter(result => result.status === 'paid').length, 1);
  assert.equal(results.filter(result => result.status === 'cooldown').length, 11);
  assert.equal(results[0].after, 2000);
  const state = f.documents.days[0];
  for (const key of ['points', 'attendance', 'activity', 'tasks']) assert.deepEqual(state[key], before[key]);
  assert.equal(state.salaryCredits, 500); assert.equal(state.salaryReceipts.length, 1);
  assert.equal(netPoints(state).total, 2000);
  const repeat = await f.service.claimSalary(claim(at, 330)); assert.equal(repeat.duplicate, true);
  assert.equal((await f.service.claimSalary(claim(at, 350, { userId: other }))).after, 500);
  assert.equal((await f.store.totals(user, 'all', at)).total, 2000);
});

test('salary cooldown persists over Saudi midnight and restart and expires at exactly one hour', async () => {
  const f = await setup();
  const firstAt = dayStart('2026-09-12') - 60000;
  const first = f.open(firstAt); const paid = await first.service.claimSalary(claim(firstAt));
  assert.equal(paid.nextAt, firstAt + 3600000);
  for (const time of [firstAt + 120000, firstAt + 30 * 60000, paid.nextAt - 1]) {
    const restarted = f.open(time); const result = await restarted.service.claimSalary(claim(time));
    assert.equal(result.status, 'cooldown'); assert.equal(result.nextAt, paid.nextAt);
  }
  const next = f.open(paid.nextAt);
  assert.equal((await next.service.claimSalary(claim(paid.nextAt))).status, 'paid');
  assert.equal((await next.store.totals(user, 'all', paid.nextAt)).total, 1000);
  assert.equal(f.documents.days.length, 2);
});

test('upgrade applies the one-hour interval to a saved six-hour salary receipt without resetting its last claim time', async () => {
  const f = await setup(); await f.service.claimSalary(claim());
  f.documents.days[0].salaryReceipts[0].nextAt = at + 6 * 3600000;
  const before = f.open(at + 3600000 - 1);
  const waiting = await before.service.claimSalary(claim(at + 3600000 - 1));
  assert.equal(waiting.status, 'cooldown'); assert.equal(waiting.nextAt, at + 3600000);
  const due = f.open(at + 3600000);
  assert.equal((await due.service.claimSalary(claim(at + 3600000))).status, 'paid');
  assert.equal(f.documents.days[0].salaryReceipts.length, 2);
  assert.equal((await due.store.totals(user, 'all', at + 3600000)).total, 1000);
});

test('a changed or disabled salary never retroactively changes an existing claim or its cooldown', async () => {
  const f = await setup(); await f.service.claimSalary(claim());
  await f.service.configureBank(change(311, { salaryAmount: 750 }));
  assert.equal((await f.service.claimSalary(claim())).amount, 500);
  assert.equal((await f.service.claimSalary(claim(at, 301))).status, 'cooldown');
  const time = at + SALARY_INTERVAL_MS; const next = f.open(time);
  assert.equal((await next.service.claimSalary(claim(time))).amount, 750);
  await next.service.configureBank(change(312, { salaryAmount: 0 }));
  const last = f.open(time + SALARY_INTERVAL_MS);
  await assert.rejects(last.service.claimSalary(claim(time + SALARY_INTERVAL_MS)), /أوقفت صرفه/);
  assert.equal((await last.store.totals(user, 'all', time + SALARY_INTERVAL_MS)).total, 1250);
});

test('invalid, stale, foreign, departed and unverified salary claims cannot create credits', async () => {
  const f = await setup();
  for (const patch of [{ id: 'bad' }, { userId: 'bad' }, { at: at - 900001 }, { at: at + 5001 }]) {
    await assert.rejects(f.service.claimSalary(claim(at, 300, patch)), /صلاحية/);
  }
  await assert.rejects(f.service.claimSalary(claim(), async () => false), /سيرفر الكلان/);
  let checks = 0;
  await assert.rejects(f.service.claimSalary(claim(), async () => ++checks === 1), /لم تعد عضوًا/);
  f.documents.leases[0].expiresAt = at;
  await assert.rejects(f.service.claimSalary(claim()), /قفل تشغيل/);
  assert.equal((await f.store.totals(user, 'all', at)).total, 0);
});

test('lost acknowledgement is verified from the salary receipt without paying again', async () => {
  const f = await setup(); await f.seed(); let failed = false;
  f.intercept(({ name, method, phase, args }) => {
    if (!failed && name === 'days' && method === 'replaceOne' && phase === 'after' && args[1].salaryCredits) {
      failed = true; throw new Error('ack lost');
    }
  });
  assert.equal((await f.service.claimSalary(claim())).after, 1500);
  assert.equal(f.service.blocked, false);
  assert.equal((await f.open().service.claimSalary(claim())).duplicate, true);
  assert.equal((await f.store.totals(user, 'all', at)).total, 1500);
});

test('an uncertain salary write stops further spending and restart resolves both committed and uncommitted cases', async () => {
  for (const phase of ['before', 'after']) {
    const f = await setup(); await f.seed(); let failed = false;
    f.intercept(event => {
      if (event.name === 'days' && event.method === 'replaceOne' && event.phase === phase && event.args[1].salaryCredits) {
        failed = true; throw new Error('connection lost');
      }
      if (failed && event.name === 'days' && event.method === 'findOne') throw new Error('read unavailable');
    });
    await assert.rejects(f.service.claimSalary(claim()), /لم يتأكد صرف الراتب/);
    assert.equal(f.service.blocked, true);
    await assert.rejects(f.service.bankTop(user, channelId), /الاحتساب متوقف/);
    await assert.rejects(f.service.purchase(request()), /الاحتساب متوقف/);
    f.intercept(() => {});
    const next = f.open(); const result = await next.service.claimSalary(claim());
    assert.equal(result.duplicate, phase === 'after');
    assert.equal((await next.store.totals(user, 'all', at)).total, 1500);
    assert.equal(f.documents.days[0].salaryReceipts.length, 1);
  }
});

test('bank top and salary wait for both legs of a robbery and see a consistent balance', async () => {
  const f = await setup(); await f.seed(); await f.seed(other, 2000);
  await f.service.openRobbery(robbery(), () => true, dice);
  let release, signal; const entered = new Promise(resolve => { signal = resolve; });
  const pause = new Promise(resolve => { release = resolve; }); let stopped = false;
  f.intercept(async ({ name, method, phase, args }) => {
    if (!stopped && name === 'days' && method === 'replaceOne' && phase === 'after' && args[1].userId === other) {
      stopped = true; signal(); await pause;
    }
  });
  const settlement = f.service.settleRobbery(choice()); await entered;
  let topDone = false, salaryDone = false;
  const top = f.service.bankTop(user, channelId).then(result => { topDone = true; return result; });
  const salary = f.service.claimSalary(claim()).then(result => { salaryDone = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(topDone, false); assert.equal(salaryDone, false);
  release(); await settlement;
  assert.deepEqual((await top).rows.map(row => row.total), [1600, 1400]);
  assert.equal((await salary).after, 2100);
});

test('moving the bank channel cancels previous robbery buttons even if the channel is later restored', async () => {
  const f = await setup(); await f.seed(); await f.seed(other, 2000);
  await f.service.openRobbery(robbery(), () => true, dice);
  await f.service.configureBank(change(311, { channelId: nextChannel }));
  await assert.rejects(f.service.settleRobbery(choice()), /فقط/);
  f.service.clock = () => at + 60000;
  const newRound = await f.service.openRobbery(robbery({ id: snowflake(at + 60000, 410), at: at + 60000, channelId: nextChannel }), () => true, dice);
  assert.equal(newRound.status, 'open'); assert.equal(newRound.bankVersion, 2);
  await f.service.configureBank(change(312, { channelId }));
  assert.equal((await f.service.settleRobbery(choice())).status, 'cancelled');
  assert.equal((await f.store.totals(user, 'all', at)).total, 1000);
});

test('salary and configuration survive a regular new day, while an explicit member reset clears that member only', async () => {
  const f = await setup(); await f.service.claimSalary(claim());
  await f.service.claimSalary(claim(at, 301, { userId: other }));
  const resetAt = at + 1000; const current = f.open(resetAt);
  await current.service.reset({ userId: user, actorId: actor, operationId: 'reset-salary' });
  assert.equal((await current.store.settings()).bank.salaryAmount, 500);
  await assert.rejects(current.service.claimSalary(claim()), /صلاحية/);
  const later = f.open(resetAt + 1); await later.store.initializeResets(resetAt + 1);
  assert.equal((await later.service.claimSalary(claim(resetAt + 1))).after, 500);
  assert.equal((await later.service.claimSalary(claim(resetAt + 1, 301, { userId: other }))).status, 'cooldown');
});
