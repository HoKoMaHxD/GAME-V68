import test from 'node:test';
import assert from 'node:assert/strict';
import { ClanMembership } from '../src/membership.js';
import { MembershipRecovery, transientMembershipError } from '../src/membership-recovery.js';
import { createDailyQuestHandler } from '../src/daily-quest-views.js';
import { createPointHandler } from '../src/point-commands.js';
import { createHandler } from '../src/commands.js';
import { VoiceTracker } from '../src/voice.js';
import { membershipStatusText, trackingBlocker } from '../src/membership-status.js';

const config = { clanGuildId: 'clan', arenaGuildId: 'arena', memberRole: 'role' };
const member = (guildId, id, roles = [], bot = false) => ({ id, guild: { id: guildId },
  user: { bot }, roles: { cache: new Map(roles.map(id => [id, {}])) } });
const timeout = () => Object.assign(new Error('Members did not arrive'), { code: 'GuildMembersTimeout' });
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };

function fixture(ids = ['alice'], options = {}) {
  const clan = new Map(ids.map(id => [id, member('clan', id)]));
  const arena = new Map(ids.map(id => [id, member('arena', id, ['role'])]));
  const calls = [], warnings = [];
  const guild = { roles: { cache: new Map([['role', {}]]) }, members: { fetch: async request => {
    calls.push(request);
    if (Array.isArray(request.user)) throw timeout();
    assert.equal(request.force, true); assert.equal(request.cache, false);
    if (!arena.has(request.user)) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
    return arena.get(request.user);
  } } };
  const clanGuild = { members: { list: async () => new Map(clan) } };
  const bot = { guilds: { cache: new Map([['clan', clanGuild]]) } };
  const source = { guilds: { cache: new Map([['arena', guild]]) } };
  const membership = new ClanMembership({ bot, source, config, onFallback: e => warnings.push(e), ...options });
  return { membership, bot, source, guild, clanGuild, clan, arena, calls, warnings };
}

test('timed-out bulk lookup recovers through fresh member reads and resumes accurate voice tracking', async () => {
  const f = fixture(), recovery = new MembershipRecovery({ membership: f.membership });
  assert.equal(await recovery.run({ required: true }), true);
  assert.equal(f.membership.has('alice'), true);
  assert.equal(f.warnings.length, 1);
  const credits = [], tracker = new VoiceTracker({ guildId: 'arena', service: { voice: async e => credits.push(e) } });
  await tracker.transition([{ userId: 'alice', channelId: 'voice' }], { minPeople: 1 }, f.membership.members, 0);
  await tracker.tick(15000);
  assert.equal(credits[0].to - credits[0].from, 15000);
  assert.equal(f.membership.diagnostics().ready, true);
});

test('a missing bulk row is checked directly instead of silently excluding an eligible member', async () => {
  const f = fixture(['alice', 'bob']);
  const fetch = f.guild.members.fetch;
  f.guild.members.fetch = async request => Array.isArray(request.user) ? new Map([['alice', f.arena.get('alice')]]) : fetch(request);
  await f.membership.load();
  assert.deepEqual([...f.membership.members], ['alice', 'bob']);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].user, 'bob');
});

test('explicit Unknown Member and a confirmed missing role are excluded without blocking other members', async () => {
  const f = fixture(['alice', 'left', 'no-role']);
  f.arena.delete('left'); f.arena.set('no-role', member('arena', 'no-role'));
  await f.membership.load();
  assert.equal(f.membership.ready, true);
  assert.deepEqual([...f.membership.members], ['alice']);
});

test('a hanging Gateway request reaches its deadline and then recovers via direct reads', async () => {
  const f = fixture(['alice'], { requestTimeoutMs: 15 });
  const fetch = f.guild.members.fetch;
  f.guild.members.fetch = request => Array.isArray(request.user) ? new Promise(() => {}) : fetch(request);
  assert.equal(await f.membership.load(), true);
  assert.equal(f.membership.has('alice'), true);
});

test('a session with failed chunks uses direct reads for later batches and reloads', async () => {
  const ids = Array.from({ length: 205 }, (_, index) => `user-${index}`), f = fixture(ids);
  await f.membership.load(); await f.membership.load();
  assert.equal(f.calls.filter(r => Array.isArray(r.user)).length, 1);
  assert.equal(f.calls.filter(r => typeof r.user === 'string').length, 410);
  assert.equal(f.membership.members.size, 205);
});

test('direct recovery uses at most three concurrent requests', async () => {
  const f = fixture(Array.from({ length: 8 }, (_, index) => `user-${index}`)), blocked = deferred();
  const fetch = f.guild.members.fetch; let active = 0, peak = 0;
  f.guild.members.fetch = async request => {
    if (Array.isArray(request.user)) throw timeout();
    active++; peak = Math.max(peak, active);
    await blocked.promise;
    try { return await fetch(request); } finally { active--; }
  };
  const load = f.membership.load(); await turn();
  const whileBlocked = active; blocked.resolve(); await load;
  assert.equal(whileBlocked, 3); assert.equal(peak, 3); assert.equal(f.membership.members.size, 8);
});

for (const code of [50001, 50013]) test(`permission error ${code} is not bypassed by another member endpoint`, async () => {
  const f = fixture(); let calls = 0;
  f.guild.members.fetch = async () => { calls++; throw Object.assign(new Error('Missing Access'), { code, status: 403 }); };
  await assert.rejects(f.membership.load(), { code });
  assert.equal(calls, 1); assert.equal(f.membership.has('alice'), false);
});

test('a failed direct read cannot turn stale cached membership into eligibility or confirmed absence', async () => {
  const f = fixture(); await f.membership.load();
  f.guild.members.fetch = async () => { throw Object.assign(new Error('Not Found'), { status: 404 }); };
  await assert.rejects(f.membership.load(), /Not Found/);
  assert.equal(f.membership.ready, false); assert.equal(f.membership.has('alice'), false);
  assert.equal(f.membership.diagnostics().failure.stage, 'arena');
});

test('live role removal wins over a stale direct lookup response', async () => {
  const f = fixture();
  f.guild.members.fetch = async request => {
    if (Array.isArray(request.user)) throw timeout();
    f.membership.updateArena(member('arena', request.user));
    return f.arena.get(request.user);
  };
  assert.equal(await f.membership.load(), true);
  assert.equal(f.membership.has('alice'), false);
});

test('disconnect during fallback cancels the result and cannot re-enable tracking', async () => {
  const f = fixture();
  f.guild.members.fetch = async request => {
    if (Array.isArray(request.user)) throw timeout();
    f.membership.invalidate(); return f.arena.get(request.user);
  };
  assert.equal(await f.membership.load(), false);
  assert.equal(f.membership.ready, false); assert.equal(f.membership.members.size, 0);
});

test('incomplete direct responses leave eligibility unknown and recover on a later attempt', async () => {
  const f = fixture(); f.arena.get('alice').partial = true;
  const recovery = new MembershipRecovery({ membership: f.membership });
  assert.equal(await recovery.run({ required: true }), false);
  assert.equal(f.membership.has('alice'), false); assert.ok(recovery.retryAt > Date.now());
  assert.equal(f.membership.diagnostics().failure.code, 'MEMBER_RESPONSE_INCOMPLETE');
});

test('a hung clan page is bounded and never marks a partial roster ready', async () => {
  const f = fixture(['alice'], { requestTimeoutMs: 15 });
  f.clanGuild.members.list = () => new Promise(() => {});
  await assert.rejects(f.membership.load(), { code: 'MEMBERSHIP_REQUEST_TIMEOUT' });
  assert.equal(f.membership.ready, false); assert.equal(f.membership.diagnostics().failure.stage, 'clan');
});

test('a hanging direct read also times out and releases the recovery attempt', async () => {
  const f = fixture(['alice'], { requestTimeoutMs: 15 });
  f.guild.members.fetch = request => Array.isArray(request.user) ? Promise.reject(timeout()) : new Promise(() => {});
  const recovery = new MembershipRecovery({ membership: f.membership });
  assert.equal(await recovery.run({ required: true }), false);
  assert.equal(recovery.pending, null); assert.equal(f.membership.loading, null);
  assert.equal(f.membership.has('alice'), false); assert.ok(recovery.retryAt > Date.now());
});

test('explicit Gateway rate limits back off instead of switching endpoints', async () => {
  const f = fixture(); let calls = 0;
  f.guild.members.fetch = async () => { calls++; throw Object.assign(new Error('Rate limited'), { status: 429 }); };
  const recovery = new MembershipRecovery({ membership: f.membership });
  assert.equal(await recovery.run({ required: true }), false);
  assert.equal(calls, 1); assert.equal(f.warnings.length, 0); assert.ok(recovery.retryAt > Date.now());
});

test('the configured role is refreshed before declaring it missing from a cold cache', async () => {
  const f = fixture(); f.guild.roles.cache.clear();
  f.guild.roles.fetch = async () => f.guild.roles.cache.set('role', {});
  assert.equal(await f.membership.load(), true);
  assert.equal(f.membership.has('alice'), true);
});

test('an actually missing configured role is diagnosed and never removed as a requirement', async () => {
  const f = fixture(); f.guild.roles.cache.clear();
  await assert.rejects(f.membership.load(), { code: 'MEMBERSHIP_ROLE_MISSING' });
  assert.equal(f.membership.members.size, 0);
  assert.match(membershipStatusText(f.membership.diagnostics()), /CLAN_MEMBER_ROLE_ID/);
});

test('message-only SDK timeouts are transient, and recovery remains distinct from permission failure', () => {
  assert.equal(transientMembershipError(new Error('GUILD_MEMBERS_TIMEOUT')), true);
  assert.equal(transientMembershipError({ status: 403, code: 50001 }), false);
});

test('daily quests explain unavailable verification without claiming the member lacks a role', async () => {
  const replies = [];
  const handler = createDailyQuestHandler({ config, isMember: () => false, status: () => ({ membership: { ready: false } }),
    service: { day: () => assert.fail('No data read while eligibility is unknown') }, store: {} });
  await handler({ commandName: 'مهمتي', guildId: 'clan', user: { id: 'alice' }, reply: async payload => replies.push(payload) });
  assert.match(replies[0].content, /التحقق.*غير جاهز/);
  assert.doesNotMatch(replies[0].content, /^تحتاج عضوية/);
});

test('verified ineligible members still receive the membership denial', async () => {
  let reply;
  const handler = createDailyQuestHandler({ config, isMember: () => false, status: () => ({ membership: { ready: true } }) });
  await handler({ commandName: 'مهمتي', guildId: 'clan', user: { id: 'alice' }, reply: async payload => { reply = payload; } });
  assert.match(reply.content, /^تحتاج عضوية الكلان/);
});

test('administrative currency additions remain blocked with an explicit verification-unavailable message', async () => {
  let reply, adjusted = false;
  const handler = createPointHandler({ config, store: {}, service: { adjustPoints: () => { adjusted = true; } },
    isMember: () => false, status: () => ({ membership: { ready: false } }) });
  await handler({ commandName: 'اضافة_عملة', guildId: 'clan', user: { id: 'admin' }, isButton: () => false,
    memberPermissions: { has: () => true }, options: { getUser: () => ({ id: 'alice', bot: false }) },
    deferReply: async () => {}, editReply: async payload => { reply = payload; } });
  assert.equal(adjusted, false); assert.match(reply.content, /التحقق.*غير جاهز/);
});

test('connected clients are not reported as tracking while membership is unavailable', () => {
  const healthy = { stopping: false, paused: false, current: true, blocked: false, leaseHeld: true,
    taskSetReady: true, bot: true, observer: true, membershipReady: true, arenaAvailable: true };
  assert.equal(trackingBlocker(healthy), null);
  assert.match(trackingBlocker({ ...healthy, membershipReady: false }), /التحقق من أعضاء/);
  assert.match(trackingBlocker({ ...healthy, blocked: true }), /تأكيد حفظ/);
  assert.match(trackingBlocker({ ...healthy, paused: true }), /تحكم البنك/);
});

test('status command displays the membership failure and tracking reason without exposing raw errors', async () => {
  let reply;
  const state = { bot: true, observer: true, tracking: false, memberCount: 0, trackingReason: 'لم يكتمل التحقق من أعضاء الكلان.',
    membership: { ready: false, stage: 'failed', checked: 0, total: 35,
      failure: { code: 'MEMBERSHIP_REQUEST_TIMEOUT', message: 'private-token' } } };
  const handler = createHandler({ config, store: { settings: async () => ({}), db: { command: async () => ({ ok: 1 }) } },
    service: {}, isMember: () => false, status: () => state, validateChannel: async () => {}, onError: e => { throw e; } });
  await handler({ commandName: 'حالة_البوت', guildId: 'clan', user: { id: 'admin' },
    isButton: () => false, isChatInputCommand: () => true, memberPermissions: { has: () => true },
    deferReply: async () => {}, editReply: async payload => { reply = payload; } });
  const embed = reply.embeds[0].toJSON();
  assert.match(embed.fields.find(f => f.name === 'التحقق من الأعضاء').value, /انتهت مهلة/);
  assert.match(embed.fields.find(f => f.name === 'سبب توقف الاحتساب').value, /التحقق من أعضاء/);
  assert.doesNotMatch(JSON.stringify(reply), /private-token/);
});
