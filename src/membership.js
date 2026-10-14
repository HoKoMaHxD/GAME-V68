import { setTimeout as delay } from 'node:timers/promises';
import { membershipErrorCode, retryableMembershipReadError, transientMembershipError } from './membership-recovery.js';

const FETCH_BATCH_SIZE = 100;
const CLAN_PAGE_SIZE = 1000;
const REST_CONCURRENCY = 3;
const READ_RETRY_DELAYS_MS = [1000, 3000];
const human = member => member?.user?.bot === false && member.partial !== true;
const complete = (member, id, guildId) => member?.id === id && member.guild?.id === guildId
  && typeof member.user?.bot === 'boolean' && member.partial !== true && typeof member.roles?.cache?.has === 'function';

async function bounded(operation, milliseconds) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('انتهت مهلة التحقق من أعضاء السيرفر.'),
        { code: 'MEMBERSHIP_REQUEST_TIMEOUT' })), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

// Commands live in the clan guild. The optional clan role lives in Arena.
export class ClanMembership {
  constructor({ bot, source, config, requestTimeoutMs = 15000, clock = Date.now, onFallback = () => {},
    onReadRetry = () => {}, wait = delay }) {
    this.bot = bot;
    this.source = source;
    this.config = config;
    Object.assign(this, { requestTimeoutMs, clock, onFallback, onReadRetry, wait });
    this.members = new Set();
    this.clan = new Map();
    this.arena = new Map();
    this.revisions = new Map();
    this.ready = false;
    this.epoch = 0;
    this.loading = null;
    this.changes = null;
    this.preferRest = false;
    this.progress = { stage: 'waiting', checked: 0, total: 0, clanLoaded: 0 };
    this.lastFailure = null;
    this.lastSuccessAt = null;
  }

  has(id) { return this.ready && this.members.has(id); }

  diagnostics() {
    return { ...this.progress, ready: this.ready, loading: !!this.loading, eligible: this.members.size,
      lastSuccessAt: this.lastSuccessAt, failure: this.lastFailure };
  }

  invalidate() {
    this.epoch++;
    this.ready = false;
    this.members.clear();
    this.progress = { stage: 'waiting', checked: 0, total: 0, clanLoaded: 0 };
  }

  async read(operation, kind, epoch = this.epoch) {
    for (let attempt = 0; ; attempt++) {
      if (epoch !== this.epoch) {
        throw Object.assign(new Error('أُلغي التحقق بعد تغيّر الاتصال.'), { code: 'MEMBERSHIP_LOAD_CANCELLED' });
      }
      try { return await bounded(operation, this.requestTimeoutMs); }
      catch (error) {
        if (epoch !== this.epoch || !retryableMembershipReadError(error) || attempt >= READ_RETRY_DELAYS_MS.length) throw error;
        const delayMs = READ_RETRY_DELAYS_MS[attempt];
        this.onReadRetry({ operation: kind, code: membershipErrorCode(error), attempt: attempt + 2,
          maxAttempts: READ_RETRY_DELAYS_MS.length + 1, delayMs });
        await this.wait(delayMs);
      }
    }
  }

  hasArenaRole(member) {
    return human(member) && !!member.roles?.cache?.has(this.config.memberRole);
  }

  sync(id) {
    const before = this.members.has(id);
    if (this.ready && this.clan.get(id) && (!this.config.memberRole || this.arena.get(id))) this.members.add(id);
    else this.members.delete(id);
    return before !== this.members.has(id);
  }

  updateClan(member, removed = false) {
    if (member?.guild?.id !== this.config.clanGuildId) return false;
    const eligible = !removed && human(member);
    this.revisions.set(member.id, (this.revisions.get(member.id) || 0) + 1);
    this.clan.set(member.id, eligible);
    this.changes?.clan.set(member.id, eligible);
    return this.sync(member.id);
  }

  updateArena(member, removed = false) {
    if (!this.config.memberRole || member?.guild?.id !== this.config.arenaGuildId) return false;
    // Only retain role information for clan members (or while their initial list loads).
    if (!this.clan.has(member.id) && !this.changes) return false;
    const eligible = !removed && this.hasArenaRole(member);
    this.revisions.set(member.id, (this.revisions.get(member.id) || 0) + 1);
    this.arena.set(member.id, eligible);
    this.changes?.arena.set(member.id, eligible);
    return this.sync(member.id);
  }

  roleDeleted(role) {
    if (role?.guild?.id !== this.config.arenaGuildId || role.id !== this.config.memberRole) return false;
    this.invalidate();
    return true;
  }

  async loadArenaMember(id) {
    if (!this.ready || !this.config.memberRole || !this.clan.get(id)) return false;
    const epoch = this.epoch;
    const revision = this.revisions.get(id);
    const guild = this.source.guilds.cache.get(this.config.arenaGuildId);
    if (!guild) return false;
    let member;
    try { member = await this.fetchArenaMember(guild, id, epoch); }
    catch (error) { if (epoch !== this.epoch) return false; throw error; }
    if (epoch !== this.epoch || revision !== this.revisions.get(id)) return false;
    return this.updateArena(member || { id, guild: { id: this.config.arenaGuildId } }, !member);
  }

  async fetchArenaMember(guild, id, epoch = this.epoch) {
    try {
      // force avoids reusing role information cached before a disconnect.
      const member = await this.read(() => guild.members.fetch({ user: id, force: true, cache: false }), 'arena-member', epoch);
      if (!complete(member, id, this.config.arenaGuildId)) {
        throw Object.assign(new Error('لم تصل بيانات كاملة للتحقق من عضو أرينا.'), { code: 'MEMBER_RESPONSE_INCOMPLETE' });
      }
      return member;
    } catch (error) {
      // Only Discord's explicit Unknown Member proves absence. A timeout,
      // permission error or arbitrary 404 is an unavailable check, not denial.
      if (Number(error.code) === 10007) return null;
      throw error;
    }
  }

  async fetchArenaBatch(guild, ids, epoch) {
    let found = new Map();
    if (!this.preferRest) {
      try {
        found = await bounded(() => guild.members.fetch({ user: ids, time: Math.min(10000, this.requestTimeoutMs),
          withPresences: false }), this.requestTimeoutMs);
        if (!found || typeof found.get !== 'function') {
          throw Object.assign(new Error('لم تصل قائمة أعضاء أرينا كاملة.'), { code: 'MEMBER_RESPONSE_INCOMPLETE' });
        }
      } catch (error) {
        if (epoch !== this.epoch) return null;
        if (!transientMembershipError(error) || membershipErrorCode(error) === 429) throw error;
        // A broken chunk request must not be the only way to restore members.
        // Use the ordinary member read endpoint, respecting the SDK rate limit.
        this.preferRest = true;
        found = new Map();
        this.onFallback(error);
      }
    }
    if (epoch !== this.epoch) return null;
    const missing = ids.filter(id => !complete(found.get(id), id, this.config.arenaGuildId));
    this.progress.checked += ids.length - missing.length;
    let cursor = 0, failure;
    const worker = async () => {
      while (cursor < missing.length && epoch === this.epoch && !failure) {
        const id = missing[cursor++];
        try {
          const member = await this.fetchArenaMember(guild, id, epoch);
          if (epoch !== this.epoch) return;
          found.set(id, member); this.progress.checked++;
        }
        catch (error) { failure ||= error; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(REST_CONCURRENCY, missing.length) }, worker));
    if (epoch !== this.epoch) return null;
    if (failure) throw failure;
    return found;
  }

  load() {
    if (this.loading) return this.loading;
    this.loading = this.loadSnapshot().finally(() => { this.loading = null; });
    return this.loading;
  }

  async loadClanMembers(guild, epoch) {
    const loaded = new Map();
    let after;
    // The official bot can page through REST without waiting for Gateway
    // member chunks. Do not trust a partial cache after a lost connection.
    while (epoch === this.epoch) {
      const page = await this.read(() => guild.members.list({ limit: CLAN_PAGE_SIZE, after, cache: false }), 'clan-page', epoch);
      if (epoch !== this.epoch) return null;
      for (const member of page.values()) loaded.set(member.id, member);
      this.progress.clanLoaded = loaded.size;
      if (page.size < CLAN_PAGE_SIZE) return loaded;
      const next = [...page.keys()].reduce((highest, id) => BigInt(id) > BigInt(highest) ? id : highest, '0');
      if (BigInt(next) <= BigInt(after || '0')) {
        throw Object.assign(new Error('تعذر استكمال صفحات أعضاء الكلان؛ لم تتقدم الصفحة التالية.'), { code: 'MEMBER_PAGINATION_STALLED' });
      }
      after = next;
    }
    return null;
  }

  async loadSnapshot() {
    this.invalidate();
    const epoch = this.epoch;
    const changes = { clan: new Map(), arena: new Map() };
    this.changes = changes;
    try {
      this.progress.stage = 'configuration';
      const clanGuild = this.bot.guilds.cache.get(this.config.clanGuildId);
      if (!clanGuild) throw Object.assign(new Error('البوت الرسمي غير موجود في سيرفر الكلان المحدد.'), { code: 'CLAN_GUILD_MISSING' });
      const arenaGuild = this.source.guilds.cache.get(this.config.arenaGuildId);
      if (this.config.memberRole) {
        if (!arenaGuild) throw Object.assign(new Error('حساب القارئ غير موجود في سيرفر أرينا المحدد.'), { code: 'ARENA_GUILD_MISSING' });
        if (!arenaGuild.roles.cache.has(this.config.memberRole) && arenaGuild.roles.fetch) {
          await this.read(() => arenaGuild.roles.fetch(), 'arena-roles', epoch);
          if (epoch !== this.epoch) return false;
        }
        if (!arenaGuild.roles.cache.has(this.config.memberRole)) {
          throw Object.assign(new Error('رتبة CLAN_MEMBER_ROLE_ID غير موجودة في سيرفر أرينا المحدد بواسطة ARENA_GUILD_ID.'),
            { code: 'MEMBERSHIP_ROLE_MISSING' });
        }
      }
      this.progress.stage = 'clan';
      const loaded = await this.loadClanMembers(clanGuild, epoch);
      if (!loaded || epoch !== this.epoch) return false;
      const clan = new Map([...loaded.values()].map(member => [member.id, human(member)]));
      for (const [id, eligible] of changes.clan) clan.set(id, eligible);
      const arena = new Map();
      this.progress = { stage: 'arena', checked: 0, total: [...clan.values()].filter(Boolean).length, clanLoaded: loaded.size };
      if (this.config.memberRole) {
        const ids = [...clan].filter(([, eligible]) => eligible).map(([id]) => id);
        // Target known clan IDs instead of requesting every member of Arena.
        for (let offset = 0; offset < ids.length; offset += FETCH_BATCH_SIZE) {
          const batch = ids.slice(offset, offset + FETCH_BATCH_SIZE);
          const found = await this.fetchArenaBatch(arenaGuild, batch, epoch);
          if (!found || epoch !== this.epoch) return false;
          for (const id of batch) arena.set(id, this.hasArenaRole(found.get(id)));
        }
      }
      // A role removal/leave received during a fetch must win over its older snapshot.
      for (const [id, eligible] of changes.clan) clan.set(id, eligible);
      for (const [id, eligible] of changes.arena) arena.set(id, eligible);
      this.clan = clan;
      this.arena = arena;
      // A join after the requested ID list was built needs another bounded refresh.
      this.ready = !this.config.memberRole || [...clan].every(([id, eligible]) => !eligible || arena.has(id));
      if (this.ready) {
        for (const id of clan.keys()) this.sync(id);
        this.progress = { ...this.progress, stage: 'ready', checked: this.progress.total };
        this.lastFailure = null; this.lastSuccessAt = this.clock();
      }
      return this.ready;
    } catch (error) {
      if (epoch !== this.epoch) return false;
      this.lastFailure = { stage: this.progress.stage, code: membershipErrorCode(error) };
      this.progress.stage = 'failed';
      throw error;
    } finally {
      if (this.changes === changes) this.changes = null;
    }
  }
}
