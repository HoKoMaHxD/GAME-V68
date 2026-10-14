import test from 'node:test';
import assert from 'node:assert/strict';
import { ClanMembership } from '../src/membership.js';
import { VoiceTracker } from '../src/voice.js';

const config = { clanGuildId: 'clan', arenaGuildId: 'arena', memberRole: 'arena-role' };
const member = (guildId, id, roles = [], bot = false) => ({
  id, guild: { id: guildId }, user: { bot }, roles: { cache: new Map(roles.map(id => [id, { id }])) }
});

function fixture({ clan = [member('clan', 'alice')], arena = [member('arena', 'alice', ['arena-role'])], role = 'arena-role' } = {}) {
  const clanRecords = new Map(clan.map(m => [m.id, m]));
  const arenaRecords = new Map(arena.map(m => [m.id, m]));
  const requests = [];
  const clanGuild = { roles: { cache: new Map() }, members: { list: async () => new Map(clanRecords) } };
  const arenaGuild = { roles: { cache: new Map([['arena-role', {}]]) }, members: {
    fetch: async options => {
      requests.push(options);
      if (typeof options.user === 'string') {
        if (!arenaRecords.has(options.user)) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
        return arenaRecords.get(options.user);
      }
      assert.ok(Array.isArray(options.user) && options.user.length > 0 && options.user.length <= 100);
      return new Map(options.user.filter(id => arenaRecords.has(id)).map(id => [id, arenaRecords.get(id)]));
    }
  } };
  const bot = { guilds: { cache: new Map([['clan', clanGuild]]) } };
  const source = { guilds: { cache: new Map([['arena', arenaGuild]]) } };
  const membership = new ClanMembership({ bot, source, config: { ...config, memberRole: role } });
  return { membership, bot, source, clanGuild, arenaGuild, clanRecords, arenaRecords, requests };
}

test('Arena role qualifies a clan member when the official bot cannot access Arena', async () => {
  const f = fixture();
  assert.equal(f.bot.guilds.cache.has('arena'), false);
  assert.equal(f.clanGuild.roles.cache.has('arena-role'), false);
  assert.equal(await f.membership.load(), true);
  assert.equal(f.membership.has('alice'), true);
});

test('a clan-server role cannot replace the required Arena role', async () => {
  const f = fixture({ clan: [member('clan', 'alice', ['arena-role'])], arena: [member('arena', 'alice')] });
  f.clanGuild.roles.cache.set('arena-role', {});
  await f.membership.load();
  assert.equal(f.membership.has('alice'), false);
  f.membership.updateClan(member('clan', 'alice', ['arena-role']));
  assert.equal(f.membership.has('alice'), false);
});

test('official mode can use one client for both guilds with the Arena role', async () => {
  const f = fixture();
  f.bot.guilds.cache.set('arena', f.arenaGuild);
  const membership = new ClanMembership({ bot: f.bot, source: f.bot, config });
  await membership.load();
  assert.equal(membership.has('alice'), true);
});

test('role validation reports Arena and does not fall back to a role in the clan guild', async () => {
  const f = fixture();
  f.clanGuild.roles.cache.set('arena-role', {});
  f.arenaGuild.roles.cache.clear();
  await assert.rejects(f.membership.load(), /CLAN_MEMBER_ROLE_ID.*أرينا.*ARENA_GUILD_ID/);
  assert.equal(f.membership.ready, false);
  assert.equal(f.requests.length, 0);
});

test('only human clan members with the Arena role qualify; missing Arena members are excluded', async () => {
  const f = fixture({
    clan: [member('clan', 'alice'), member('clan', 'missing'), member('clan', 'bot', [], true)],
    arena: [member('arena', 'alice', ['arena-role']), member('arena', 'outsider', ['arena-role']), member('arena', 'bot', ['arena-role'], true)]
  });
  await f.membership.load();
  assert.deepEqual([...f.membership.members], ['alice']);
  assert.deepEqual(f.requests[0].user, ['alice', 'missing']);
  f.membership.updateArena(member('arena', 'outsider', ['arena-role']));
  assert.equal(f.membership.has('outsider'), false);
});

test('empty role keeps all human clan members eligible without fetching Arena members', async () => {
  const f = fixture({ role: null, clan: [member('clan', 'alice'), member('clan', 'bot', [], true)], arena: [] });
  f.source.guilds.cache.clear();
  await f.membership.load();
  assert.deepEqual([...f.membership.members], ['alice']);
  assert.equal(f.requests.length, 0);
  f.membership.updateClan(member('clan', 'new'));
  assert.equal(f.membership.has('new'), true);
});

test('Arena member fetches stay scoped to clan IDs in batches of at most 100', async () => {
  const clan = Array.from({ length: 205 }, (_, i) => member('clan', `user-${i}`));
  const arena = clan.map(m => member('arena', m.id, ['arena-role']));
  const f = fixture({ clan, arena });
  await f.membership.load();
  assert.deepEqual(f.requests.map(r => r.user.length), [100, 100, 5]);
  assert.ok(f.requests.every(r => r.withPresences === false));
  assert.equal(f.membership.members.size, 205);
});

test('Arena role changes grant and revoke eligibility; clan roles and other guilds do not', async () => {
  const f = fixture();
  await f.membership.load();
  f.membership.updateClan(member('clan', 'alice'));
  assert.equal(f.membership.has('alice'), true);
  f.membership.updateArena(member('other', 'alice'));
  assert.equal(f.membership.has('alice'), true);
  f.membership.updateArena(member('arena', 'alice'));
  assert.equal(f.membership.has('alice'), false);
  f.membership.updateClan(member('clan', 'alice', ['arena-role']));
  assert.equal(f.membership.has('alice'), false);
  f.membership.updateArena(member('arena', 'alice', ['arena-role']));
  assert.equal(f.membership.has('alice'), true);
});

test('leaving either required guild stops eligibility even with a cached role', async () => {
  const f = fixture();
  await f.membership.load();
  f.membership.updateArena(member('arena', 'alice', ['arena-role']), true);
  assert.equal(f.membership.has('alice'), false);
  f.membership.updateArena(member('arena', 'alice', ['arena-role']));
  assert.equal(f.membership.has('alice'), true);
  f.membership.updateClan({ id: 'alice', guild: { id: 'clan' } }, true);
  f.membership.updateArena(member('arena', 'alice', ['arena-role']));
  assert.equal(f.membership.has('alice'), false);
});

test('only deletion of the configured role from Arena invalidates tracking', async () => {
  const f = fixture();
  await f.membership.load();
  for (const role of [{ id: 'arena-role', guild: { id: 'clan' } }, { id: 'other', guild: { id: 'arena' } }]) {
    assert.equal(f.membership.roleDeleted(role), false);
    assert.equal(f.membership.has('alice'), true);
  }
  assert.equal(f.membership.roleDeleted({ id: 'arena-role', guild: { id: 'arena' } }), true);
  assert.equal(f.membership.ready, false);
  assert.equal(f.membership.members.size, 0);
});

test('live role removal and clan leave during a fetch override an older snapshot', async () => {
  const f = fixture({
    clan: [member('clan', 'alice'), member('clan', 'bob')],
    arena: [member('arena', 'alice', ['arena-role']), member('arena', 'bob', ['arena-role'])]
  });
  f.arenaGuild.members.fetch = async () => {
    f.membership.updateArena(member('arena', 'alice'));
    f.membership.updateClan(member('clan', 'bob'), true);
    return new Map(f.arenaRecords);
  };
  await f.membership.load();
  assert.equal(f.membership.ready, true);
  assert.equal(f.membership.members.size, 0);
});

test('a disconnect during member loading cannot make the stale result ready', async () => {
  const f = fixture();
  f.arenaGuild.members.fetch = async () => {
    f.membership.invalidate();
    return new Map(f.arenaRecords);
  };
  assert.equal(await f.membership.load(), false);
  assert.equal(f.membership.ready, false);
  assert.equal(f.membership.has('alice'), false);
});

test('failed Arena member lookup cannot retain eligibility from the previous connection', async () => {
  const f = fixture();
  await f.membership.load();
  f.arenaGuild.members.fetch = async () => { throw new Error('GUILD_MEMBERS_TIMEOUT'); };
  await assert.rejects(f.membership.load(), /GUILD_MEMBERS_TIMEOUT/);
  assert.equal(f.membership.has('alice'), false);
  assert.equal(f.membership.ready, false);
});

test('overlapping reloads share the same member request', async () => {
  const f = fixture();
  await Promise.all([f.membership.load(), f.membership.load()]);
  assert.equal(f.requests.length, 1);
});

test('a new clan member gets a targeted Arena lookup without pausing other members', async () => {
  const f = fixture();
  await f.membership.load();
  f.membership.updateClan(member('clan', 'new'));
  f.arenaRecords.set('new', member('arena', 'new', ['arena-role']));
  assert.equal(f.membership.has('new'), false);
  assert.equal(f.membership.has('alice'), true);
  await f.membership.loadArenaMember('new');
  assert.equal(f.membership.has('new'), true);
  assert.equal(f.membership.has('alice'), true);
  assert.deepEqual(f.requests.at(-1), { user: 'new', force: true, cache: false });
});

test('a live role withdrawal during a single-member lookup cannot be undone by the response', async () => {
  const f = fixture();
  await f.membership.load();
  f.arenaGuild.members.fetch = async () => {
    f.membership.updateArena(member('arena', 'alice'));
    return f.arenaRecords.get('alice');
  };
  await f.membership.loadArenaMember('alice');
  assert.equal(f.membership.has('alice'), false);
});

test('voice credit stops at Arena role removal and resumes only after the role returns', async () => {
  const f = fixture();
  await f.membership.load();
  const credits = [];
  const tracker = new VoiceTracker({ guildId: 'arena', service: { voice: async e => credits.push(e) } });
  const snapshot = [{ userId: 'alice', channelId: 'voice', bot: false }];
  const rule = { channelId: 'voice', minPeople: 1, ignoreDeafened: true, ignoreMuted: false };
  await tracker.transition(snapshot, rule, new Set(f.membership.members), 0);
  f.membership.updateArena(member('arena', 'alice'));
  await tracker.transition(snapshot, rule, new Set(f.membership.members), 10000);
  await tracker.tick(20000);
  f.membership.updateArena(member('arena', 'alice', ['arena-role']));
  await tracker.transition(snapshot, rule, new Set(f.membership.members), 30000);
  await tracker.tick(40000);
  assert.deepEqual(credits.map(e => [e.from, e.to]), [[0, 10000], [30000, 40000]]);
});

test('clan membership uses complete REST pages when Gateway chunks would time out', async () => {
  const f = fixture({ role: null });
  const people = Array.from({ length: 2005 }, (_, i) => member('clan', String(900000000000000000n + BigInt(i))));
  const calls = [];
  f.clanGuild.members.fetch = async () => { throw Object.assign(new Error('Members did not arrive'), { code: 'GuildMembersTimeout' }); };
  f.clanGuild.members.list = async options => {
    calls.push(options);
    const rows = people.filter(m => !options.after || BigInt(m.id) > BigInt(options.after)).slice(0, options.limit);
    // The highest ID, not collection insertion order, determines the next page.
    return new Map(rows.reverse().map(m => [m.id, m]));
  };
  assert.equal(await f.membership.load(), true);
  assert.equal(f.membership.members.size, people.length);
  assert.deepEqual(calls.map(c => c.after), [undefined, people[999].id, people[1999].id]);
  assert.ok(calls.every(c => c.limit === 1000 && c.cache === false));
});

test('an exact full clan page is followed by the empty terminal page', async () => {
  const f = fixture({ role: null });
  const people = Array.from({ length: 1000 }, (_, i) => member('clan', String(900000000000000000n + BigInt(i))));
  let calls = 0;
  f.clanGuild.members.list = async ({ after }) => { calls++; return new Map((after ? [] : people).map(m => [m.id, m])); };
  assert.equal(await f.membership.load(), true);
  assert.equal(f.membership.members.size, 1000);
  assert.equal(calls, 2);
});

test('a failed later REST page never enables a partial or previously cached roster', async () => {
  const f = fixture({ role: null });
  await f.membership.load();
  const people = Array.from({ length: 1000 }, (_, i) => member('clan', String(900000000000000000n + BigInt(i))));
  f.clanGuild.members.list = async ({ after }) => {
    if (after) throw Object.assign(new Error('write ECONNABORTED'), { code: 'ECONNABORTED' });
    return new Map(people.map(m => [m.id, m]));
  };
  await assert.rejects(f.membership.load(), { code: 'ECONNABORTED' });
  assert.equal(f.membership.ready, false);
  assert.equal(f.membership.members.size, 0);
  f.clanGuild.members.list = async () => new Map(f.clanRecords);
  assert.equal(await f.membership.load(), true);
  assert.deepEqual([...f.membership.members], ['alice']);
});

test('a disconnect while a REST page is in flight cancels the snapshot and further pages', async () => {
  const f = fixture({ role: null });
  let calls = 0;
  f.clanGuild.members.list = async () => {
    calls++;
    f.membership.invalidate();
    return new Map(Array.from({ length: 1000 }, (_, i) => { const id = String(900000000000000000n + BigInt(i)); return [id, member('clan', id)]; }));
  };
  assert.equal(await f.membership.load(), false);
  assert.equal(calls, 1);
  assert.equal(f.membership.members.size, 0);
});

test('a clan leave or join received during REST loading wins over the fetched snapshot', async () => {
  const f = fixture({ role: null });
  f.clanGuild.members.list = async () => {
    f.membership.updateClan(member('clan', 'alice'), true);
    f.membership.updateClan(member('clan', 'new'));
    return new Map(f.clanRecords);
  };
  assert.equal(await f.membership.load(), true);
  assert.deepEqual([...f.membership.members], ['new']);
});

test('a repeated full REST page fails instead of looping or accepting an incomplete roster', async () => {
  const f = fixture({ role: null });
  let calls = 0;
  f.clanGuild.members.list = async () => {
    calls++;
    return new Map(Array.from({ length: 1000 }, (_, i) => { const id = String(900000000000000000n + BigInt(i)); return [id, member('clan', id)]; }));
  };
  await assert.rejects(f.membership.load(), { code: 'MEMBER_PAGINATION_STALLED' });
  assert.equal(calls, 2);
  assert.equal(f.membership.ready, false);
});
