import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags, PermissionFlagsBits, ApplicationCommandOptionType } from 'discord.js';
import { buildCommands, createHandler } from '../src/commands.js';
import { SpamMonitor, SPAM_CHANNELS, isSpam } from '../src/spam-monitor.js';
import { readSpamSettings, DEFAULT_SPAM_SETTINGS, MAX_SPAM_SECONDS, MAX_SPAM_AMOUNT } from '../src/spam-settings.js';
import { fixture, at, user, actor, other, config, snowflake } from './helpers/shop-fixture.js';

const change = (sequence = 1, patch = {}) => ({ actorId: actor, operationId: snowflake(at, sequence), ...patch });
const roleId = '100000000000000081';
function interaction({ options = {}, permitted = true, guildId = config.clanGuildId, roles = [], sequence = 1 } = {}) {
  const i = { id: snowflake(at, sequence), createdTimestamp: at, commandName: 'خصم', guildId,
    user: { id: actor }, member: { roles }, replies: [],
    memberPermissions: { has: p => permitted && p === PermissionFlagsBits.ManageGuild },
    isChatInputCommand: () => true, isButton: () => false,
    options: { getInteger: name => options[name] ?? null },
    reply: async payload => { i.replies.push(payload); },
    deferReply: async payload => { i.deferred = payload; },
    editReply: async payload => { i.replies.push(payload); } };
  return i;
}
function handler(f, access) {
  return createHandler({ config, store: f.store, service: f.service, access, isMember: () => true });
}
function monitor(f) {
  return new SpamMonitor({ store: f.store, service: f.service, config, canRun: () => true,
    actorId: () => actor, clock: () => f.service.clock() });
}
function message(time, sequence = 1) {
  return { guildId: config.clanGuildId, channelId: SPAM_CHANNELS.clan, author: { id: user, bot: false },
    createdTimestamp: time, id: snowflake(time, sequence) };
}

test('/خصم registers seconds then amount, supports viewing settings, and is guild-only', () => {
  const commands = buildCommands(), command = commands.find(c => c.name === 'خصم');
  assert.equal(commands.filter(c => c.name === 'خصم').length, 1);
  assert.equal(command.dm_permission, false); assert.equal(command.default_member_permissions, null);
  assert.deepEqual(command.options.map(o => o.name), ['المدة', 'المبلغ', 'الرسائل']);
  for (const o of command.options) { assert.equal(o.type, ApplicationCommandOptionType.Integer); assert.ok(!o.required); assert.equal(o.min_value, o.name === 'الرسائل' ? 2 : 1); }
  assert.equal(command.options[0].max_value, MAX_SPAM_SECONDS);
  assert.equal(command.options[1].max_value, MAX_SPAM_AMOUNT);
  assert.match(command.options[0].description, /بالثواني/);
});

test('/خصم rejects ordinary members, DMs and foreign guilds without reading or writing settings', async () => {
  const f = await fixture(), run = handler(f);
  f.intercept(() => { throw new Error('Unauthorized database access'); });
  for (const extra of [{ permitted: false }, { guildId: null }, { guildId: other }]) {
    const i = interaction({ options: { المدة: 5, المبلغ: 800 }, ...extra }); await run(i);
    assert.equal(i.deferred, undefined); assert.equal(i.replies[0].flags, MessageFlags.Ephemeral);
  }
});

test('/خصم with no options privately displays defaults without creating a configuration', async () => {
  const f = await fixture(), before = structuredClone(f.documents.settings), i = interaction();
  await handler(f)(i);
  assert.equal(i.deferred.flags, MessageFlags.Ephemeral);
  const embed = i.replies[0].embeds[0].toJSON();
  assert.match(embed.title, /إعدادات خصم السبام/);
  assert.match(embed.fields[0].value, /3 ثوان/); assert.match(embed.fields[1].value, /500/);
  assert.deepEqual(f.documents.settings, before);
});

test('/خصم saves both options, permits the delegated management role and survives restart', async () => {
  const f = await fixture(), beforeBank = structuredClone(f.documents.settings[0].bank);
  const i = interaction({ permitted: false, roles: [roleId], options: { المدة: 5, المبلغ: 1000 } });
  await handler(f, { roleId })(i);
  assert.equal(i.deferred.flags, MessageFlags.Ephemeral);
  const saved = (await f.open().store.settings()).spam;
  assert.deepEqual(readSpamSettings(saved), { windowMs: 5000, amount: 1000, messageCount: 2 });
  assert.equal(saved.actorId, actor); assert.equal(saved.operationId, i.id);
  assert.deepEqual(f.documents.settings[0].bank, beforeBank);
  assert.match(i.replies[0].embeds[0].data.description, /0/);
  assert.deepEqual(i.replies[0].allowedMentions, { parse: [] });
  const view = interaction({ sequence: 2 }); await handler(f.open())(view);
  assert.match(view.replies[0].embeds[0].data.fields[0].value, /5 ثوان/);
  assert.match(view.replies[0].embeds[0].data.fields[1].value, /1,000/);
});

test('independent concurrent edits preserve both settings and stale/duplicate commands cannot restore old values', async () => {
  const f = await fixture();
  await Promise.all([f.service.configureSpam(change(1, { seconds: 10 })), f.service.configureSpam(change(2, { amount: 200 }))]);
  assert.deepEqual(readSpamSettings((await f.store.settings()).spam), { windowMs: 10000, amount: 200, messageCount: 2 });
  await assert.rejects(f.service.configureSpam(change(1, { seconds: 3, amount: 500 })), /أقدم/);
  await f.service.configureSpam(change(2, { seconds: 3, amount: 500 }));
  assert.deepEqual(readSpamSettings((await f.store.settings()).spam), { windowMs: 10000, amount: 200, messageCount: 2 });
});

test('invalid amounts, durations and actor IDs leave persisted rules unchanged', async () => {
  const f = await fixture(); await f.service.configureSpam(change(1, { seconds: 5, amount: 800 }));
  const saved = structuredClone(f.documents.settings);
  for (const patch of [{ seconds: 0 }, { seconds: -1 }, { seconds: 1.5 }, { seconds: 3601 }, { amount: 0 },
    { amount: -1 }, { amount: 1.5 }, { amount: 1000001 }, { seconds: NaN }, { amount: Infinity },
    { seconds: '5' }, { amount: '500' }, { seconds: 5, actorId: 'bad-id' }, {}]) {
    await assert.rejects(f.service.configureSpam(change(2, patch)));
    assert.deepEqual(f.documents.settings, saved);
  }
  const i = interaction({ sequence: 2, options: { المدة: 0, المبلغ: 800 } }); await handler(f)(i);
  assert.match(i.replies[0].content, /❌/); assert.deepEqual(f.documents.settings, saved);
});

test('configured endpoints are accepted and corrupt/missing stored rules use valid defaults', async () => {
  const f = await fixture();
  for (const [sequence, seconds, amount] of [[1, 1, 1], [2, 3600, 1000000]]) {
    const saved = await f.service.configureSpam(change(sequence, { seconds, amount }));
    assert.deepEqual(readSpamSettings(saved), { windowMs: seconds * 1000, amount, messageCount: 2 });
  }
  assert.deepEqual(readSpamSettings(null), DEFAULT_SPAM_SETTINGS);
  assert.deepEqual(readSpamSettings({ windowMs: -1, amount: 0, messageCount: 2 }), DEFAULT_SPAM_SETTINGS);
  assert.equal(isSpam(at, at + 3599999, 3600000), true);
  assert.equal(isSpam(at, at + 3600000, 3600000), false);
});

for (const phase of ['before', 'after']) test(`settings ${phase} write failure never reports an unsaved change or loses a committed change`, async () => {
  const f = await fixture(); let failed = false;
  f.intercept(e => {
    if (!failed && e.name === 'settings' && e.method === 'updateOne' && e.phase === phase) {
      failed = true; throw new Error('lost settings acknowledgement');
    }
  });
  const result = f.service.configureSpam(change(1, { seconds: 7, amount: 250 }));
  if (phase === 'before') {
    await assert.rejects(result, /lost settings acknowledgement/);
    assert.deepEqual(readSpamSettings((await f.store.settings()).spam), DEFAULT_SPAM_SETTINGS);
  } else {
    assert.equal((await result).amount, 250);
    assert.deepEqual(readSpamSettings((await f.open().store.settings()).spam), { windowMs: 7000, amount: 250, messageCount: 2 });
  }
});

test('paused service or lost worker lease cannot change spam settings', async () => {
  const f = await fixture(); f.service.paused = true;
  await assert.rejects(f.service.configureSpam(change(1, { amount: 100 })), /متوقف/);
  const i = interaction({ options: { المدة: 5, المبلغ: 1000 } }); await handler(f)(i);
  assert.equal(i.replies[0].flags, MessageFlags.Ephemeral); assert.match(i.replies[0].content, /متوقف/);
  f.service.paused = false; f.documents.leases[0].owner = 'another-worker';
  await assert.rejects(f.service.configureSpam(change(2, { amount: 100 })), /قفل/);
  assert.equal((await f.store.settings()).spam, undefined);
});

test('custom threshold and fine take effect immediately, respect the exact boundary, and survive restart', async () => {
  const f = await fixture(); await f.seed(user, 2000); let now = at; f.service.clock = () => now;
  const watch = monitor(f); await watch.initialize();
  await f.service.configureSpam(change(1, { seconds: 5, amount: 700 }));
  await watch.receive(message(now));
  now += 4000; await watch.receive(message(now));
  assert.equal((await f.store.totals(user, 'all', now)).total, 1300);
  assert.match((await f.service.day(user)).adjustmentLog[0].reason, /5 ثوان/);
  now += 5000; await watch.receive(message(now));
  assert.equal((await f.store.totals(user, 'all', now)).total, 1300);
  const restarted = f.open(now + 4000); await monitor(restarted).receive(message(now + 4000));
  assert.equal((await f.store.totals(user, 'all', now)).total, 600);
});

test('shortening then lengthening the threshold affects the next new message', async () => {
  const f = await fixture(); await f.seed(user, 1000); let now = at; f.service.clock = () => now;
  const watch = monitor(f); await watch.receive(message(now));
  await f.service.configureSpam(change(1, { seconds: 1, amount: 100 }));
  now += 2000; await watch.receive(message(now));
  assert.equal((await f.store.totals(user, 'all', now)).total, 1000);
  await f.service.configureSpam(change(2, { seconds: 5 }));
  now += 4000; await watch.receive(message(now));
  assert.equal((await f.store.totals(user, 'all', now)).total, 900);
});

test('pending violations retain their original rule through settings changes, replay and restart', async () => {
  const f = await fixture(); await f.seed(user, 2000); let now = at; f.service.clock = () => now;
  await f.service.configureSpam(change(1, { seconds: 5, amount: 200 }));
  const watch = monitor(f); await watch.receive(message(now));
  const apply = f.service.penalizeSpam.bind(f.service);
  f.service.penalizeSpam = async () => { throw new Error('temporary failure'); };
  now += 4000; const pending = message(now);
  await assert.rejects(watch.receive(pending), /temporary failure/);
  f.service.penalizeSpam = apply;
  await f.service.configureSpam(change(2, { seconds: 1, amount: 900 }));
  const restarted = f.open(now); await monitor(restarted).tick();
  const record = f.documents.spam_messages.find(r => r.messageId === pending.id);
  assert.deepEqual(record.spamRule, { windowMs: 5000, amount: 200, messageCount: 2 }); assert.equal(record.status, 'paid');
  assert.equal((await f.store.totals(user, 'all', now)).total, 1800);
  assert.match((await f.service.day(user)).adjustmentLog[0].reason, /5 ثوان/);
  await monitor(restarted).receive(pending); await monitor(restarted).tick();
  assert.equal((await f.store.totals(user, 'all', now)).total, 1800);
  now += 500; await watch.receive(message(now));
  assert.equal((await f.store.totals(user, 'all', now)).total, 900);
});

test('legacy pending violations keep the former 3-second / 500 rule', async () => {
  const f = await fixture(); await f.seed(user, 1000);
  await f.service.configureSpam(change(1, { seconds: 10, amount: 900 }));
  await f.store.db.collection('spam_messages').insertOne({ _id: 'legacy', clanId: config.clanGuildId, userId: user,
    channelId: SPAM_CHANNELS.clan, messageId: snowflake(at, 20), at, status: 'pending' });
  await monitor(f).tick();
  const entry = (await f.service.day(user)).adjustmentLog[0];
  assert.equal(entry.amount, 500); assert.match(entry.reason, /3 ثوان/);
  assert.equal((await f.store.totals(user, 'all', at)).total, 500);
});

test('a custom fine larger than the wallet stops at zero and reports the actual charge', async () => {
  const f = await fixture(); await f.seed(user, 120); let now = at; f.service.clock = () => now;
  await f.service.configureSpam(change(1, { seconds: 5, amount: 2000 }));
  const watch = monitor(f); await watch.receive(message(now));
  now += 4000; await watch.receive(message(now));
  now += 4000; await watch.receive(message(now));
  const entries = (await f.service.day(user)).adjustmentLog;
  assert.deepEqual(entries.map(e => e.amount), [120, 0]);
  assert.deepEqual(entries.map(e => e.requestedAmount), [2000, 2000]);
  assert.equal((await f.store.totals(user, 'all', now)).total, 0);
});

 test('message count is saved and enforces a rolling window across restarts without duplicate charges', async () => {
  const f = await fixture(); await f.seed(user, 3000); let now = at; f.service.clock = () => now;
  const i = interaction({ options: { الرسائل: 3, المدة: 5, المبلغ: 400 } });
  await handler(f)(i);
  assert.equal((await f.store.settings()).spam.messageCount, 3);
  assert.match(i.replies[0].embeds[0].data.fields[2].value, /3/);
  const watch = monitor(f);
  await watch.receive(message(now)); now += 1000; await watch.receive(message(now));
  assert.equal((await f.store.totals(user, 'all', now)).total, 3000);
  now += 1000; const third = message(now); const restarted = f.open(now);
  await monitor(restarted).receive(third); await monitor(restarted).receive(third);
  assert.equal((await f.store.totals(user, 'all', now)).total, 2600);
  now += 5000; await watch.receive(message(now)); now += 1000; await watch.receive(message(now));
  assert.equal((await f.store.totals(user, 'all', now)).total, 2600);
  for (const messageCount of [1, 0, 1001, 2.5, '3']) {
    await assert.rejects(f.service.configureSpam(change(2, { messageCount })), /عدد الرسائل/);
  }
 });
