import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { MemberNotifier } from '../src/member-notifications.js';
import { createHandler } from '../src/commands.js';
import { notice, NOTIFICATION_BUTTON } from '../src/notification-events.js';
import { memberNotification } from '../src/notification-views.js';
import { fixture, config as base, at, user, other, actor, snowflake, request } from './helpers/shop-fixture.js';
import { auctionInput, auctionId, liveId } from './helpers/auction-fixture.js';

const channelId = '100000000000000060';
const config = { ...base, clanChatChannelId: '100000000000000041', voiceChannelId: '100000000000000042' };
async function setup({ initialize = true } = {}) {
  const f = await fixture(); let now = at, sequence = 1000;
  f.store.config = { ...config }; f.service.config = f.store.config; f.service.clock = () => now;
  f.documents.settings[0].bank.salaryAmount = 500;
  await f.store.initializeActivity(now); await f.store.robbery.initialize(now); await f.store.auctions.initialize(now);
  if (initialize) await f.store.notifications.initialize(now);
  const sent = [], errors = [], histories = new Map(), channels = new Map();
  const state = { live: true, closed: new Set(), fail: false, lostAck: false, missing: new Set(), calls: 0, beforeSend: null, eligible: true };
  const bot = { user: { id: '100000000000000098' }, guilds: { cache: new Map() } };
  const guild = { members: { fetch: async ({ user: id }) => {
    state.calls++;
    if (state.missing.has(id)) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
    return { user: { id, bot: false, createDM: async () => {
      if (!channels.has(id)) {
        histories.set(id, new Map());
        channels.set(id, { messages: { fetch: async () => histories.get(id) }, send: async payload => {
          if (state.beforeSend) await state.beforeSend();
          if (state.closed.has(id)) throw Object.assign(new Error('Cannot DM'), { code: 50007 });
          if (state.fail) throw new Error('temporary network error');
          const message = { id: snowflake(now, sequence++), author: bot.user, createdTimestamp: now,
            embeds: payload.embeds.map(e => e.toJSON()) };
          histories.get(id).set(message.id, message); sent.push({ userId: id, payload });
          if (state.lostAck) { state.lostAck = false; throw new Error('lost send acknowledgement'); }
          return message;
        } });
      }
      return channels.get(id);
    } } };
  } } };
  bot.guilds.cache.set(config.clanGuildId, guild);
  const runner = (store = f.store, service = f.service) => new MemberNotifier({ bot, store, service,
    clock: () => now, canRun: () => state.live && !service.blocked,
    isMember: () => state.eligible, onError: error => errors.push(error) });
  const notifier = runner();
  const input = () => ({ id: snowflake(now, sequence++), userId: user, channelId, at: now });
  const pump = async (count = 4, worker = notifier) => { for (let i = 0; i < count; i++) await worker.tick(); };
  const restart = async () => {
    const reopened = f.open(now); reopened.service.clock = () => now;
    reopened.store.config = f.store.config; reopened.service.config = f.store.config;
    await reopened.store.notifications.initialize(now);
    await reopened.store.initializeResets(now);
    return { ...reopened, notifier: runner(reopened.store, reopened.service) };
  };
  return { ...f, bot, sent, state, errors, histories, channels, notifier, runner, pump, input, restart,
    now: () => now, time: value => { now = value; }, advance: value => { now += value; },
    events: kind => f.documents.member_notifications.filter(e => !kind || e.kind === kind),
    titles: () => sent.map(s => s.payload.embeds[0].data.title) };
}

test('preferences default on; per-member toggles are persistent, idempotent and survive reset/restart', async () => {
  const f = await setup(), preferences = f.store.notifications;
  assert.equal((await preferences.preference(user)).enabled, true);
  const first = snowflake(at, 10);
  await Promise.all([preferences.toggle(user, first, at), preferences.toggle(user, first, at)]);
  assert.equal((await preferences.preference(user)).enabled, false);
  assert.equal((await preferences.preference(other)).enabled, true);
  await f.service.reset({ userId: user, actorId: actor, operationId: 'notification-reset' });
  const reopened = await f.restart();
  assert.equal((await reopened.store.notifications.toggle(user, first, at)).enabled, false);
  assert.equal((await reopened.store.notifications.toggle(user, snowflake(at, 11), at)).enabled, true);
  assert.equal((await reopened.store.notifications.toggle(user, first, at)).enabled, true);
});

test('notification button toggles only the clicker and replies privately without editing the public panel', async () => {
  const f = await setup(), handler = createHandler({ config, store: f.store, service: f.service });
  const button = patch => {
    const calls = [], i = { customId: NOTIFICATION_BUTTON, id: snowflake(at, 15), guildId: config.clanGuildId,
      user: { id: user }, isButton: () => true, calls,
      deferReply: async p => calls.push(['deferReply', p]), editReply: async p => calls.push(['editReply', p]),
      reply: async p => calls.push(['reply', p]), ...patch }; return i;
  };
  const i = button(); await handler(i);
  assert.deepEqual(i.calls[0], ['deferReply', { flags: MessageFlags.Ephemeral }]);
  assert.match(i.calls[1][1].content, /إيقاف جميع/);
  assert.equal((await f.store.notifications.preference(other)).enabled, true);
  const enable = button({ id: snowflake(at, 16) }); await handler(enable); assert.match(enable.calls[1][1].content, /تفعيل/);
  for (const patch of [{ guildId: config.arenaGuildId }, { user: { id: user, bot: true } }]) {
    const denied = button(patch); await handler(denied); assert.equal(denied.calls.length, 1);
    assert.equal(denied.calls[0][1].flags, MessageFlags.Ephemeral);
  }
});

test('salary and prize receipts and readiness notify once through retries and restart without paying again', async () => {
  const f = await setup();
  await f.service.claimSalary(f.input()); await f.service.claimPrize(f.input(), () => true, min => min === 0 ? 2 : 1000);
  await Promise.all([f.notifier.tick(), f.notifier.tick()]); assert.equal(f.sent.length, 1);
  await f.pump(); assert.equal(f.sent.length, 2);
  f.time(at + 3600000 - 1); await f.pump(); assert.equal(f.sent.length, 2);
  f.advance(1); const reopened = await f.restart(); await f.pump(2, reopened.notifier);
  assert.equal(f.events('salary_ready')[0].status, 'sent'); assert.equal(f.sent.length, 3);
  f.time(at + 21600000); await f.pump(2, reopened.notifier);
  assert.equal(f.events('prize_ready')[0].status, 'sent'); assert.equal(f.sent.length, 4);
  assert.equal((await f.service.balance(user)).total, 1500);
  for (const { payload } of f.sent) { assert.deepEqual(payload.allowedMentions, { parse: [] }); assert.equal(payload.enforceNonce, true); }
});

test('a new salary claim invalidates the previous ready reminder and disabled salary does not starve prize alerts', async () => {
  const f = await setup(); await f.service.claimSalary(f.input()); await f.pump();
  f.time(at + 3600000); await f.service.claimSalary(f.input()); await f.pump();
  assert.equal(f.events('salary_ready').find(e => e.data.claimedAt === at).status, 'obsolete');
  f.documents.settings[0].bank.salaryEnabled = false;
  f.time(at + 7200000); await f.service.claimPrize(f.input(), () => true, min => min === 0 ? 2 : 500);
  await f.pump(); assert.ok(f.titles().includes('🎁 حصلت على جائزة'));
  assert.equal(f.events('salary_ready').find(e => e.data.claimedAt !== at).status, 'pending');
});

test('opt-out suppresses all due alerts; re-enabling never replays muted history but preserves future timers', async () => {
  const f = await setup(); await f.service.claimSalary(f.input()); await f.service.claimPrize(f.input(), () => true, min => min === 0 ? 2 : 500);
  await f.store.notifications.toggle(user, snowflake(at, 50), at); await f.pump();
  assert.equal(f.sent.length, 0); assert.equal(f.state.calls, 0);
  f.time(at + 3600001); await f.store.notifications.toggle(user, snowflake(f.now(), 51), f.now());
  await f.pump(); assert.equal(f.sent.length, 0);
  f.time(at + 21600000); await f.pump(); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].payload.embeds[0].data.title, '🎁 جائزتك جاهزة');
});

test('DM-closed members keep their preferences and money, and failures do not affect other members', async () => {
  const f = await setup(); f.state.closed.add(user);
  await f.service.claimSalary(f.input()); await f.service.claimSalary({ ...f.input(), userId: other });
  await f.pump(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].userId, other);
  assert.equal(f.events().find(e => e.kind === 'salary_paid' && e.userId === user).status, 'dm-closed');
  assert.equal((await f.store.notifications.preference(user)).enabled, true); assert.equal(f.service.blocked, false);
  assert.equal((await f.service.balance(user)).total, 500);
});

for (const failure of ['network', 'database']) {
  test(`ambiguous ${failure} acknowledgement recovers the existing DM after restart without duplicates`, async () => {
    const f = await setup(); await f.service.claimSalary(f.input());
    if (failure === 'network') f.state.lostAck = true;
    else {
      let once = true; f.intercept(e => {
        if (once && e.name === 'member_notifications' && e.method === 'updateOne' && e.phase === 'before' && e.args[1].$set?.status === 'sent') {
          once = false; throw new Error('lost database acknowledgement');
        }
      });
    }
    await f.notifier.tick(); assert.equal(f.sent.length, 1); assert.equal(f.events('salary_paid')[0].status, 'pending');
    f.intercept(() => {}); f.advance(60001); const reopened = await f.restart();
    await f.pump(2, reopened.notifier); assert.equal(f.sent.length, 1); assert.equal(f.events('salary_paid')[0].status, 'sent');
  });
}

test('known failed sends back off then recover, and incomplete history never causes a blind duplicate retry', async () => {
  const f = await setup(); await f.service.claimSalary(f.input()); f.state.fail = true;
  await f.pump(); assert.equal(f.sent.length, 0); assert.equal(f.events('salary_paid')[0].attempts, 1);
  f.state.fail = false; f.advance(60001); await f.pump(); assert.equal(f.sent.length, 1);
  const second = await setup(); await second.service.claimSalary(second.input()); second.state.lostAck = true;
  await second.notifier.tick(); second.advance(60001);
  second.channels.get(user).messages.fetch = async () => new Map(Array.from({ length: 100 }, (_, i) => [String(i),
    { id: String(i), author: second.bot.user, embeds: [], createdTimestamp: second.now() }]));
  await second.notifier.tick(); assert.equal(second.sent.length, 1); assert.equal(second.events('salary_paid')[0].status, 'uncertain');
});

test('event staging shares the salary commit and outbox materialization can be retried safely', async () => {
  const f = await setup(); let lost = true;
  f.intercept(e => {
    if (lost && e.name === 'days' && e.method === 'replaceOne' && e.phase === 'after' && e.args[1].salaryReceipts) {
      lost = false; throw new Error('lost salary commit acknowledgement');
    }
  });
  await f.service.claimSalary(f.input()); assert.equal(f.documents.days[0].dmPending, true);
  let failClear = true; f.intercept(e => {
    if (failClear && e.name === 'days' && e.method === 'updateOne' && e.phase === 'before' && e.args[1].$set?.dmPending === false) {
      failClear = false; throw new Error('failed outbox clear');
    }
  });
  await assert.rejects(f.notifier.tick(), /outbox/); assert.equal(f.service.blocked, false);
  f.intercept(() => {}); await f.pump();
  assert.equal(f.events('salary_paid').length, 1); assert.equal(f.sent.length, 1);
  assert.equal((await f.service.balance(user)).total, 500);
});

for (const [move, target, outcome] of [['paper', 10000, 'win'], ['scissors', 10000, 'loss'], ['rock', 10000, 'tie'], ['rock', 20000, 'tie'], ['paper', 0, 'win']]) {
  test(`robbery ${outcome} with target balance ${target} alerts both sides, including zero transfers`, async () => {
    const f = await setup(); await f.seed(user, 10000); await f.seed(other, target);
    const round = await f.service.openRobbery({ ...f.input(), targetId: other }, () => true, min => min);
    await f.service.settleRobbery({ id: round.id, userId: user, resolutionId: f.input().id, channelId, move });
    await f.pump(); assert.equal(f.sent.length, 2); assert.deepEqual(new Set(f.sent.map(s => s.userId)), new Set([user, other]));
    assert.ok(f.events('robbery_result').every(e => e.data.result.outcome === outcome && e.status === 'sent'));
    assert.equal(f.events('protection_expired').length, ((outcome === 'win' && target) || outcome === 'loss') ? 1 : 0);
  });
}

for (const money of [0, 1000]) test(`a target's 15-minute failed-robbery shield sends its expiry DM, attacker balance ${money}`, async () => {
  const f = await setup(); await f.seed(user, money); await f.seed(other, 2000);
  const round = await f.service.openRobbery({ ...f.input(), targetId: other }, () => true, min => min);
  const settled = await f.service.settleRobbery({ id: round.id, userId: user, resolutionId: f.input().id, channelId, move: 'scissors' });
  await f.pump(); f.time(settled.protection.expiresAt - 1); await f.pump();
  assert.equal(f.events('protection_expired')[0].status, 'pending');
  f.advance(1); const restarted = await f.restart(); await f.pump(2, restarted.notifier);
  assert.equal(f.events('protection_expired')[0].status, 'sent');
  assert.equal(f.sent.filter(s => s.userId === other && s.payload.embeds[0].data.title === '🛡️ انتهت حمايتك من النهب').length, 1);
});

test('stacked protection only reports its final expiration and preserves the paid duration across restart', async () => {
  const f = await setup(); await f.seed(user, 40000);
  await f.service.buyProtection(f.input()); await f.pump(); f.advance(1000);
  const receipt = await f.service.buyProtection(f.input()); await f.pump();
  f.time(at + 10800000); await f.pump(); assert.ok(!f.titles().includes('🛡️ انتهت حمايتك من النهب'));
  f.time(receipt.protection.expiresAt); const reopened = await f.restart(); await f.pump(2, reopened.notifier);
  assert.equal(f.titles().filter(t => t === '🛡️ انتهت حمايتك من النهب').length, 1);
});

test('downtime spanning several superseded shields still produces one final protection expiry', async () => {
  const f = await setup(); await f.seed(user, 40000);
  await f.service.buyProtection(f.input()); f.advance(1000);
  const latest = await f.service.buyProtection(f.input());
  f.time(latest.protection.expiresAt + 1000);
  const reopened = await f.restart(); await f.pump(6, reopened.notifier);
  assert.equal(f.events('protection_expired').filter(e => e.status === 'sent').length, 1);
  assert.equal(f.events('protection_expired').filter(e => e.status === 'obsolete').length, 1);
});

test('losing the worker lease stops notification collection and sending', async () => {
  const f = await setup(); await f.service.claimSalary(f.input());
  f.documents.leases[0].expiresAt = f.now();
  await assert.rejects(f.notifier.tick(), /قفل تشغيل/);
  assert.equal(f.sent.length, 0); assert.equal((await f.service.balance(user)).total, 500);
});

test('store purchases, administrative balance changes and scoped resets notify without altering financial outcomes', async () => {
  const f = await setup(); await f.seed(user, 1000);
  await f.service.purchase(request()); await f.pump(); assert.ok(f.titles().includes('🛍️ تأكد طلبك من المتجر'));
  await f.service.adjustPoints({ userId: user, actorId: actor, operationId: f.input().id, category: 'total', mode: 'add', amount: 100, at: f.now(), reason: 'مهمة خاصة' });
  await f.pump(); assert.ok(f.titles().includes('💵 أُضيفت عملة إلى رصيدك')); assert.equal((await f.service.balance(user)).total, 950);
  await f.service.reset({ userId: null, actorId: actor, operationId: 'all-bank', target: 'bank' }); await f.pump();
  assert.ok(f.titles().includes('🔄 تم تنفيذ ريست')); assert.equal((await f.service.balance(user)).total, 0);
});

for (const cancel of [false, true]) {
  test(`auction start, outbid refund and ${cancel ? 'cancellation' : 'winner'} notifications use committed outcomes`, async () => {
    const f = await setup(); await f.seed(user, 5000); await f.seed(other, 5000);
    await f.service.createAuction(auctionInput()); f.time(at + 60000);
    await f.service.auctionChange(auctionId, a => { a.status = 'active'; a.startedAt = f.now(); a.endsAt = f.now() + 300000; a.delivery.live.messageId = liveId; return true; });
    await f.pump(); assert.ok(f.titles().includes('🔨 بدأ مزادك'));
    const bid = id => ({ auctionId, userId: id, operationId: f.input().id, at: f.now(), channelId: auctionInput().channelId, messageId: liveId, increment: 500 });
    await f.service.bidAuction(bid(user)); await f.service.bidAuction(bid(other)); await f.pump();
    assert.ok(f.titles().includes('🔨 تمت المزايدة فوق سومك')); assert.equal((await f.service.balance(user)).total, 5000);
    if (!cancel) f.advance(300000);
    await f.service.settleAuction(auctionId, cancel ? { actorId: actor, operationId: f.input().id, reason: 'اختبار' } : null); await f.pump();
    assert.ok(f.titles().includes(cancel ? '🔨 أُلغي المزاد' : '🏆 فزت بالمزاد'));
    assert.equal((await f.service.balance(other)).total, cancel ? 5000 : 3000);
  });
}

test('first upgrade schedules only future existing timers, without sending historical receipts', async () => {
  const f = await setup({ initialize: false }); await f.service.claimSalary(f.input());
  f.advance(1000); await f.store.notifications.initialize(f.now()); await f.pump(); assert.equal(f.sent.length, 0);
  assert.equal(f.events('salary_ready').length, 1); assert.equal(f.events('salary_paid').length, 0);
  f.time(at + 3600000); await f.pump(); assert.equal(f.sent.length, 1);
});

test('no-mutual-guild DM failures are finalized without error logs or retry loops', async () => {
  const f = await setup();
  await f.service.claimSalary(f.input());
  f.state.beforeSend = async () => {
    throw Object.assign(new Error('Cannot send messages to this user due to having no mutual guilds'), { code: 50278 });
  };
  await f.pump(3);
  assert.equal(f.sent.length, 0);
  assert.equal(f.errors.length, 0);
  assert.equal(f.events('salary_paid')[0].status, 'not-member');
});

test('missing members, lost readiness and expired reminders never cause DMs or change earned balances', async () => {
  const f = await setup(); await f.service.claimSalary(f.input()); f.state.live = false; await f.pump(); assert.equal(f.sent.length, 0);
  f.state.live = true; f.state.missing.add(user); await f.pump(); assert.equal(f.events('salary_paid')[0].status, 'not-member');
  f.state.missing.clear(); f.time(at + 3 * 86400000); await f.pump(); assert.equal(f.sent.length, 0);
  assert.equal((await f.service.balance(user)).total, 500);
});

test('opting out waits for an in-flight send, then prevents any later notification', async () => {
  const f = await setup(); await f.service.claimSalary(f.input());
  let release, entered; const sending = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  f.state.beforeSend = async () => { entered(); await hold; };
  const tick = f.notifier.tick(); await sending;
  let confirmed = false;
  const toggle = f.store.notifications.toggle(user, snowflake(at, 5000), at).then(() => { confirmed = true; });
  await Promise.resolve(); assert.equal(confirmed, false); release(); await Promise.all([tick, toggle]);
  f.state.beforeSend = null; f.time(at + 3600000); await f.pump(); assert.equal(f.sent.length, 1);
});

test('DM payloads escape member-controlled content and fit Discord limits', () => {
  const event = notice(user, 'balance_changed', 'test', at, { mode: 'add', amount: 100, reason: '@everyone **سبب**' });
  const payload = memberNotification(event, { bank: { channelId }, appearance: { name: 'SNOW' } }, config.clanGuildId);
  const embed = payload.embeds[0]; assert.ok(embed.length <= 6000); assert.doesNotMatch(embed.data.description, /@everyone/);
  assert.deepEqual(payload.allowedMentions, { parse: [] }); assert.ok(payload.nonce.length <= 25);
  assert.ok(payload.components.every(row => row.components.length <= 5));
});
