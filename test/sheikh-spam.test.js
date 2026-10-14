import test from 'node:test';
import assert from 'node:assert/strict';
import { salaryForMember, hasClanBoost, SHEIKH_ROLE_ID } from '../src/bank.js';
import { SpamMonitor, SPAM_CHANNELS, isSpam } from '../src/spam-monitor.js';
import { fixture, at, user, actor, config, snowflake } from './helpers/shop-fixture.js';
import { dayNotices } from '../src/notification-events.js';

test('sheikh beats booster, inclusive salary bounds, fetched clan role', async () => {
  for (const amount of [3000, 5000]) {
    const salary = salaryForMember({ salaryAmount: 500 }, { sheikh: true, boosting: true }, (min, max) => {
      assert.equal(min, 3000); assert.equal(max, 5001); return amount;
    });
    assert.equal(salary.job, 'شيخ الكلان'); assert.equal(salary.baseAmount, amount);
  }
  assert.equal(salaryForMember({ salaryAmount: 500 }, { sheikh: false, boosting: true }, () => 2000).job, 'مدير كبير');
  assert.equal(salaryForMember({ salaryAmount: 500 }, { sheikh: false, boosting: false }).baseAmount, 500);
  const guild = { id: config.clanGuildId, members: { fetch: async input => {
    assert.equal(input.force, true);
    return { id: user, guild: { id: config.clanGuildId }, user: { bot: false }, roles: { cache: new Map([[SHEIKH_ROLE_ID, {}]]) } };
  } } };
  assert.deepEqual(await hasClanBoost(guild, config.clanGuildId, user, true), { boosting: false, sheikh: true });
});

test('three second boundary and channel scope exclude bots, webhooks, other guilds', () => {
  assert.equal(isSpam(undefined, at), false); assert.equal(isSpam(at, at + 2999), true);
  assert.equal(isSpam(at, at + 3000), false);
  const monitor = new SpamMonitor({ config });
  const m = { guildId: config.clanGuildId, channelId: SPAM_CHANNELS.clan, author: { id: user, bot: false } };
  assert.equal(monitor.accepts(m), true);
  for (const patch of [{ guildId: config.arenaGuildId }, { channelId: '123' }, { webhookId: '123' }, { author: { bot: true } }]) assert.equal(monitor.accepts({ ...m, ...patch }), false);
  assert.equal(monitor.accepts({ ...m, guildId: config.arenaGuildId, channelId: SPAM_CHANNELS.arena }), true);
});

test('rapid messages debit at most 500 down to zero, with duplicate/restart recovery and persistent DM reason', async () => {
  const f = await fixture(); await f.seed(user, 750); f.service.clock = () => at + 10000;
  const create = (service = f.service) => new SpamMonitor({ store: service.store, service, config, canRun: () => true, actorId: () => actor, clock: () => at + 10000 });
  const monitor = create(); await monitor.initialize();
  const message = (offset, seq) => ({ guildId: config.clanGuildId, channelId: SPAM_CHANNELS.clan,
    author: { id: user, bot: false }, createdTimestamp: at + offset, id: snowflake(at + offset, seq) });
  await monitor.receive(message(0, 1));
  assert.equal((await f.store.totals(user, 'all', at)).total, 750);
  await Promise.all([monitor.receive(message(1000, 2)), monitor.receive(message(2000, 3))]);
  assert.equal((await f.store.totals(user, 'all', at)).total, 0);
  await create().receive(message(2000, 3));
  await monitor.receive(message(5000, 4));
  assert.equal((await f.store.totals(user, 'all', at)).total, 0);
  let lost = false;
  f.intercept(({ name, method, phase }) => {
    if (!lost && name === 'spam_messages' && method === 'updateOne' && phase === 'before'
      && f.documents.days[0]?.adjustmentLog?.length === 3) { lost = true; throw new Error('lost acknowledgement'); }
  });
  await assert.rejects(monitor.receive(message(6000, 5)), /lost acknowledgement/);
  f.intercept(() => {});
  await create().tick();
  assert.equal((await f.store.totals(user, 'all', at)).total, 0);
  const notices = dayNotices({}, f.documents.days[0]).filter(x => x.kind === 'spam_penalty');
  assert.equal(notices.length, 3); assert.match(notices[0].data.reason, /3 ثوان/);
  assert.deepEqual(notices.map(n => n.data.amount), [500, 250, 0]);
});

test('sheikh salary persists once and uses ordinary hourly cooldown', async () => {
  const f = await fixture();
  await f.service.configureBank({ actorId: actor, operationId: snowflake(at, 90), salaryAmount: 500 });
  const claim = { id: snowflake(at, 91), userId: user, channelId: '100000000000000060', at };
  const result = await f.service.claimSalary(claim, () => true, () => ({ sheikh: true, boosting: true }), () => 5000);
  assert.equal(result.amount, 5000); assert.equal(result.job, 'شيخ الكلان');
  assert.equal((await f.open().service.claimSalary(claim)).duplicate, true);
  const cooldown = await f.service.claimSalary({ ...claim, id: snowflake(at, 92) });
  assert.equal(cooldown.status, 'cooldown'); assert.equal(cooldown.nextAt, at + 3600000);
});

test('delayed penalty recovery remains valid after fifteen minutes', async () => {
  const f = await fixture(); const restarted = f.open(at + 1200000);
  const input = { userId: user, actorId: actor, operationId: snowflake(at, 95), at, reason: 'سبام' };
  await restarted.service.penalizeSpam(input);
  const duplicate = await restarted.service.penalizeSpam(input);
  assert.equal(duplicate.duplicate, true);
  assert.equal((await f.store.totals(user, 'all', at)).total, 0);
});
