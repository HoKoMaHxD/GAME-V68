import test from 'node:test';
import assert from 'node:assert/strict';
import { hasClanBoost, salaryForMember, BOOSTER_JOB, MEMBER_JOB, SALARY_INTERVAL_MS } from '../src/bank.js';
import { salaryPayload } from '../src/bank-commands.js';
import { createHandler } from '../src/commands.js';
import { createTextCommands } from '../src/experience-commands.js';
import { memberNotification } from '../src/notification-views.js';
import { nextReset, dayKey } from '../src/time.js';
import { fixture, config, at, user, other, snowflake } from './helpers/shop-fixture.js';

const channelId = '100000000000000060';
const claim = (time = at, sequence = 100) => ({ id: snowflake(time, sequence), userId: user, channelId, at: time });
const visible = text => text.replace(/[\u200f\u2066-\u2069]/g, '');
async function setup() {
  const f = await fixture(); f.documents.settings[0].bank.salaryAmount = 500;
  return f;
}
function guildFixture() {
  const fetched = [], state = { premiumSinceTimestamp: at - 1000, fail: null };
  const member = { id: user, user: { bot: false }, guild: { id: config.clanGuildId } };
  const guild = { id: config.clanGuildId, members: { fetch: async options => {
    fetched.push(options); if (state.fail) throw state.fail;
    return { ...member, premiumSinceTimestamp: state.premiumSinceTimestamp };
  } } };
  return { guild, member, state, fetched };
}

test('booster salary includes both range endpoints and ordinary salary never performs a random draw', () => {
  const bank = { salaryAmount: 500 };
  assert.deepEqual(salaryForMember(bank, true, (min, max) => {
    assert.equal(min, 2000); assert.equal(max, 3501); return min;
  }), { job: BOOSTER_JOB, boosting: true, baseAmount: 2000 });
  assert.equal(salaryForMember(bank, true, (min, max) => max - 1).baseAmount, 3500);
  for (const boosting of [false, undefined, 'true', 1]) assert.deepEqual(salaryForMember(bank, boosting, () => {
    throw new Error('ordinary salaries are fixed');
  }), { job: MEMBER_JOB, boosting: false, baseAmount: 500 });
  for (const amount of [1999, 3501, 2500.5, NaN]) assert.throws(() => salaryForMember(bank, true, () => amount), /مدير كبير/);
});

test('boost verification force-fetches the correct clan member and ignores role names and stale snapshots', async () => {
  const f = guildFixture();
  assert.equal(await hasClanBoost(f.guild, config.clanGuildId, user), true);
  assert.deepEqual(f.fetched, [{ user, force: true }]);
  f.state.premiumSinceTimestamp = null; f.member.roles = ['Server Booster'];
  assert.equal(await hasClanBoost(f.guild, config.clanGuildId, user), false);
  for (const invalid of [undefined, NaN, 0, '2026-09-01']) {
    f.state.premiumSinceTimestamp = invalid;
    assert.equal(await hasClanBoost(f.guild, config.clanGuildId, user), false);
  }
  await assert.rejects(hasClanBoost({ ...f.guild, id: config.arenaGuildId }, config.clanGuildId, user), /سيرفر الكلان/);
  f.member.id = other; await assert.rejects(hasClanBoost(f.guild, config.clanGuildId, user), /عضويتك/);
  f.member.id = user; f.member.user.bot = true; await assert.rejects(hasClanBoost(f.guild, config.clanGuildId, user), /عضويتك/);
});

test('verification failures and a departed member never silently downgrade to a normal salary', async () => {
  const f = await setup(), g = guildFixture();
  for (const code of [10007, 10013, 503]) {
    g.state.fail = Object.assign(new Error('Discord unavailable'), { code });
    await assert.rejects(f.service.claimSalary(claim(), () => true,
      id => hasClanBoost(g.guild, config.clanGuildId, id)), /عضو|التحقق/);
  }
  assert.equal(await f.store.latestSalary(user), null); assert.equal((await f.service.balance(user)).total, 0);
});

for (const amount of [2000, 3500]) {
  test(`a booster receives ${amount}, the persisted job and one-hour cooldown with no ordinary salary added`, async () => {
    const f = await setup(); await f.seed(user, 1000);
    const paid = await f.service.claimSalary(claim(), () => true, () => true, () => amount);
    assert.equal(paid.amount, amount); assert.equal(paid.baseAmount, amount); assert.equal(paid.job, 'مدير كبير');
    assert.equal(paid.nextAt, at + SALARY_INTERVAL_MS); assert.equal(paid.after, 1000 + amount);
    const saved = (await f.store.latestSalary(user)).salaryReceipts[0]; assert.equal(saved.job, BOOSTER_JOB);
    assert.match(visible(salaryPayload(paid, user).embeds[0].data.description), /الوظيفة:\*\* مدير كبير/);
  });
}

test('concurrent claims, duplicate delivery and restart keep a single random result and payment', async () => {
  const f = await setup(); let draws = 0, checks = 0;
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => f.service.claimSalary(claim(at, 100 + index), () => true,
    () => { checks++; return true; }, () => { draws++; return 2345; })));
  assert.equal(results.filter(r => r.status === 'paid').length, 1); assert.equal(draws, 1); assert.equal(checks, 1);
  const duplicate = await f.open(at + 1000).service.claimSalary(claim(), () => true,
    () => { throw new Error('a saved claim does not recheck boost'); }, () => { throw new Error('must not reroll'); });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.job, BOOSTER_JOB); assert.equal(duplicate.amount, 2345);
  assert.equal((await f.service.balance(user)).total, 2345);
});

test('starting or stopping boost does not reset the cooldown and affects the next successful claim', async () => {
  const f = await setup(); await f.service.claimSalary(claim());
  const waiting = await f.service.claimSalary(claim(at, 101), () => true, () => true, () => 3000);
  assert.equal(waiting.status, 'cooldown');
  const nextAt = at + SALARY_INTERVAL_MS, next = f.open(nextAt);
  const promoted = await next.service.claimSalary(claim(nextAt), () => true, () => true, () => 3000);
  assert.equal(promoted.job, BOOSTER_JOB); assert.equal(promoted.amount, 3000);
  const stillWaiting = await f.open(nextAt + 1).service.claimSalary(claim(nextAt + 1), () => true, () => false);
  assert.equal(stillWaiting.status, 'cooldown');
  const ordinary = await f.open(nextAt + SALARY_INTERVAL_MS).service.claimSalary(claim(nextAt + SALARY_INTERVAL_MS), () => true, () => false);
  assert.equal(ordinary.job, MEMBER_JOB); assert.equal(ordinary.amount, 500);
  assert.equal((await f.service.balance(user)).total, 4000);
});

test('salary prize applies once on the booster base and appears in both the card and saved DM event', async () => {
  const f = await setup(); await f.store.notifications.initialize(at);
  await f.service.claimPrize({ ...claim(), id: snowflake(at, 99) }, () => true, min => min === 0 ? 1 : 70);
  const paid = await f.service.claimSalary(claim(), () => true, () => true, () => 3500);
  assert.equal(paid.baseAmount, 3500); assert.equal(paid.bonusAmount, 2450); assert.equal(paid.amount, 5950);
  assert.equal(await f.store.nextPrizeBonus(user, 'salary'), null);
  assert.match(salaryPayload(paid, user).embeds[0].data.fields.at(-1).value, /70%/);
  const event = f.documents.days[0].dmEvents.find(e => e.kind === 'salary_paid');
  const payload = memberNotification(event, f.documents.settings[0], config.clanGuildId);
  assert.match(payload.embeds[0].data.description, /مدير كبير/); assert.match(payload.embeds[0].data.description, /5,950/);
  await f.service.claimSalary(claim(), () => true, () => false);
  assert.equal((await f.service.balance(user)).total, 5950);
});

test('a lost salary-write acknowledgement preserves the booster amount and job without another draw', async () => {
  const f = await setup(); let once = true;
  f.intercept(e => {
    if (once && e.name === 'days' && e.method === 'replaceOne' && e.phase === 'after' && e.args[1].salaryReceipts) {
      once = false; throw new Error('lost acknowledgement');
    }
  });
  const paid = await f.service.claimSalary(claim(), () => true, () => true, () => 2456);
  assert.equal(paid.amount, 2456); assert.equal(f.service.blocked, false);
  const repeated = await f.open().service.claimSalary(claim(), () => true, () => false);
  assert.equal(repeated.job, BOOSTER_JOB); assert.equal((await f.service.balance(user)).total, 2456);
});

test('boosters obey bank disable switches and a lease lost during verification prevents payment', async () => {
  const f = await setup(); f.documents.settings[0].bank.salaryEnabled = false;
  await assert.rejects(f.service.claimSalary(claim(), () => true, () => true), /طافي/);
  f.documents.settings[0].bank.salaryEnabled = true; f.documents.settings[0].bank.salaryAmount = 0;
  await assert.rejects(f.service.claimSalary(claim(), () => true, () => true), /أوقفت صرفه/);
  f.documents.settings[0].bank.salaryAmount = 500;
  await assert.rejects(f.service.claimSalary(claim(), () => true, () => {
    f.documents.leases[0].expiresAt = at; return true;
  }), /قفل تشغيل/);
  assert.equal(await f.store.latestSalary(user), null);
});

test('a boost check crossing midnight records the actual payment time and preserves the cooldown after restart', async () => {
  const f = await setup(); const start = nextReset(at) - 500, paymentAt = start + 1000;
  f.service.clock = () => start;
  const paid = await f.service.claimSalary(claim(start), () => true, () => {
    f.service.clock = () => paymentAt; return true;
  }, () => 2222);
  assert.equal(paid.claimedAt, paymentAt); assert.equal(paid.nextAt, paymentAt + SALARY_INTERVAL_MS);
  assert.equal((await f.store.latestSalary(user)).day, dayKey(paymentAt));
  const waiting = await f.open(paid.nextAt - 1).service.claimSalary(claim(paid.nextAt - 1), () => true, () => true);
  assert.equal(waiting.status, 'cooldown');
});

test('slash and text salary use the author’s fresh clan boost state, even if the cached state says otherwise', async () => {
  for (const textCommand of [false, true]) {
    const f = await setup(), g = guildFixture(), replies = [];
    const handler = createHandler({ config, store: f.store, service: f.service });
    const original = f.service.claimSalary.bind(f.service);
    f.service.claimSalary = (input, eligible, boosting) => original(input, eligible, boosting, () => 2500);
    const base = { id: claim().id, guildId: config.clanGuildId, guild: g.guild, channelId, createdTimestamp: at,
      user: { id: user, bot: false }, member: { premiumSinceTimestamp: null }, options: { getUser: () => ({ id: other }) },
      commandName: 'راتب', isButton: () => false, isChatInputCommand: () => true, isStringSelectMenu: () => false,
      reply: async p => { replies.push(p); return { edit: async p => replies.push(p) }; },
      deferReply: async () => {}, editReply: async p => replies.push(p) };
    if (textCommand) await createTextCommands(handler, config)({ ...base, author: base.user, content: '!راتب' });
    else await handler(base);
    assert.deepEqual(g.fetched, [{ user, force: true }]);
    assert.match(replies.at(-1).embeds[0].data.description, /مدير كبير/);
    assert.equal((await f.service.balance(user)).total, 2500); assert.equal(await f.store.latestSalary(other), null);
    g.state.premiumSinceTimestamp = null; f.service.clock = () => at + SALARY_INTERVAL_MS;
    const next = { ...base, id: claim(at + SALARY_INTERVAL_MS).id, createdTimestamp: at + SALARY_INTERVAL_MS,
      member: { premiumSinceTimestamp: at - 1000 } };
    await handler(next); assert.match(replies.at(-1).embeds[0].data.description, /عضو الكلان/);
  }
});
