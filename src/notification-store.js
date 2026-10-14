import { ActivityGate } from './activity-gate.js';
import { isId } from './config.js';
import { dayKey } from './time.js';
import { SALARY_INTERVAL_MS, bankCommandStatus } from './bank.js';
import { PRIZE_INTERVAL_MS } from './prizes.js';
import { effectiveRobberyProtection } from './robbery.js';
import { notice, NOTICE_DAY_MS } from './notification-events.js';

const SOURCES = ['days', 'robbery_rounds', 'protection_purchases', 'shop_orders', 'auctions', 'resets'];
export class NotificationStore {
  constructor(store) { this.store = store; this.clanId = store.config.clanGuildId; this.startedAt = 0; this.gate = new ActivityGate(); }
  get queue() { return this.store.db.collection('member_notifications'); }
  get preferences() { return this.store.db.collection('notification_preferences'); }
  key(id) { return `${this.clanId}:${id}`; }
  forUser(userId, operation) { return this.gate.runSerial(userId, operation); }
  async initialize(now = Date.now()) {
    await this.store.requireLease(now);
    await this.store.db.collection('settings').updateOne({ _id: this.store.settingsId, notificationsStartedAt: { $exists: false } },
      { $set: { notificationsStartedAt: now } });
    this.startedAt = (await this.store.settings()).notificationsStartedAt;
    if (!Number.isSafeInteger(this.startedAt) || this.startedAt <= 0) throw new Error('تعذر تهيئة التنبيهات الخاصة.');
    await this.queue.createIndex({ clanId: 1, status: 1, dueAt: 1, nextAttemptAt: 1 });
    await this.queue.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 });
    for (const name of SOURCES) await this.store.db.collection(name).createIndex({ clanId: 1, dmPending: 1 });
  }
  stage(record, events) {
    const fresh = events.filter(event => Number.isSafeInteger(event.at) && event.at >= this.startedAt && isId(event.userId));
    if (!this.startedAt || !fresh.length) return record;
    const known = new Set((record.dmEvents || []).map(event => event.id));
    record.dmEvents = [...(record.dmEvents || []), ...fresh.filter(event => !known.has(event.id))];
    record.dmPending = true; record.dmRevision = (record.dmRevision || 0) + 1;
    return record;
  }
  async preference(userId) {
    return { enabled: true, enabledSince: this.startedAt, blockedUntil: 0,
      ...await this.preferences.findOne({ _id: this.key(userId) }) };
  }
  toggle(userId, operationId, now = Date.now()) {
    return this.forUser(userId, async () => {
      if (!isId(userId) || !isId(operationId)) throw new Error('طلب التنبيهات غير صالح.');
      await this.store.requireLease(now);
      const previous = await this.preference(userId);
      if (previous.operationId && BigInt(operationId) <= BigInt(previous.operationId)) return previous;
      const enabled = !previous.enabled;
      const next = { ...previous, _id: this.key(userId), clanId: this.clanId, userId,
        enabled, operationId, changedAt: now, blockedUntil: 0,
        enabledSince: enabled ? now : previous.enabledSince };
      try { await this.preferences.replaceOne({ _id: next._id }, next, { upsert: true }); }
      catch (error) {
        const saved = await this.preference(userId);
        if (saved.operationId !== operationId) throw error;
        return saved;
      }
      return next;
    });
  }
  async enqueue(event) {
    // The stable event identity survives business retries and outbox retries.
    // Timers can move earlier after a prize without generating a second alert.
    if (event.kind === 'timers' || event.dueAt < this.startedAt) return;
    const _id = this.key(event.id), existing = await this.queue.findOne({ _id });
    if (!existing) await this.queue.updateOne({ _id }, { $setOnInsert: { ...event, clanId: this.clanId,
      status: 'pending', attempts: 0, nextAttemptAt: 0 } }, { upsert: true });
    else if (existing.status === 'pending' && !existing.attempts) await this.queue.updateOne({ _id, status: 'pending', attempts: 0 },
      { $set: { dueAt: event.dueAt, expiresAt: event.expiresAt, data: event.data } });
  }
  async refreshTimers(userId, now) {
    const [salary, prize, shield] = await Promise.all([this.store.latestSalary(userId), this.store.latestPrize(userId),
      this.store.robbery.activeProtection(userId, now)]);
    const timers = [];
    for (const [kind, state, field, interval] of [['salary_ready', salary, 'salaryLastAt', SALARY_INTERVAL_MS],
      ['prize_ready', prize, 'prizeLastAt', PRIZE_INTERVAL_MS]]) {
      if (state?.[field]) timers.push(notice(userId, kind, state[field], state[field], { claimedAt: state[field] }, state[field] + interval));
    }
    if (shield) timers.push(notice(userId, 'protection_expired', shield.expiresAt, shield.startedAt,
      { expiresAt: shield.expiresAt }, shield.expiresAt));
    for (const event of timers) await this.enqueue(event);
  }
  async bootstrap(now) {
    if ((await this.store.settings()).notificationsBootstrapped) return;
    const days = await this.store.db.collection('days').find({ clanId: this.clanId, day: { $gte: dayKey(now - 2 * NOTICE_DAY_MS) } }).toArray();
    const purchases = await this.store.db.collection('protection_purchases').find({ clanId: this.clanId, 'protection.expiresAt': { $gt: now } }).toArray();
    const rounds = await this.store.db.collection('robbery_rounds').find({ clanId: this.clanId, 'protection.expiresAt': { $gt: now } }).toArray();
    for (const id of new Set([...days.map(d => d.userId), ...purchases.map(p => p.userId), ...rounds.map(r => r.targetId)])) {
      await this.store.requireLease(now); await this.refreshTimers(id, now);
    }
    await this.store.db.collection('settings').updateOne({ _id: this.store.settingsId }, { $set: { notificationsBootstrapped: true } });
  }
  async collect(now) {
    await this.store.requireLease(now);
    for (const name of SOURCES) {
      const source = this.store.db.collection(name);
      const rows = await source.find({ clanId: this.clanId, dmPending: true, ...(name === 'resets' ? { pending: false } : {}) }).limit(30).toArray();
      for (const row of rows) {
        for (const event of row.dmEvents || []) await this.enqueue(event);
        for (const userId of new Set((row.dmEvents || []).map(event => event.userId))) await this.refreshTimers(userId, now);
        await this.store.requireLease(now);
        await source.updateOne({ _id: row._id, dmRevision: row.dmRevision }, {
          $set: { dmPending: false, dmEvents: [] }, ...(['days', 'auctions'].includes(name) ? { $inc: { revision: 1 } } : {})
        });
      }
    }
  }
  async pending(now) {
    return this.queue.find({ clanId: this.clanId, status: 'pending', dueAt: { $lte: now }, nextAttemptAt: { $lte: now } })
      .sort({ dueAt: 1, _id: 1 }).limit(100).toArray();
  }
  async finish(event, status, now, extra = {}) {
    await this.store.requireLease(now);
    await this.queue.updateOne({ _id: event._id, status: 'pending' }, { $set: { status, finishedAt: now,
      purgeAt: new Date(now + 30 * NOTICE_DAY_MS), ...extra } });
  }
  async attempt(event, now) {
    await this.store.requireLease(now);
    await this.queue.updateOne({ _id: event._id, status: 'pending' }, { $inc: { attempts: 1 },
      $set: { lastAttemptAt: now, nextAttemptAt: now + Math.min(3600000, 60000 * 2 ** Math.min(event.attempts, 6)) } });
  }
  async blockDM(userId, now) {
    await this.preferences.updateOne({ _id: this.key(userId) }, { $set: { blockedUntil: now + 6 * 3600000 },
      $setOnInsert: { clanId: this.clanId, userId, enabled: true, enabledSince: this.startedAt } }, { upsert: true });
  }
  async latestProtectionExpiry(userId) {
    const rounds = await this.store.db.collection('robbery_rounds').find({ clanId: this.clanId, targetId: userId,
      status: 'settled', 'result.outcome': { $in: ['win', 'loss'] },
      'protection.startedAt': { $exists: true } }).sort({ 'protection.startedAt': -1 }).limit(1).toArray();
    const paid = await this.store.db.collection('protection_purchases').find({ clanId: this.clanId, userId })
      .sort({ 'protection.expiresAt': -1 }).limit(1).toArray();
    return Math.max(effectiveRobberyProtection(rounds[0])?.expiresAt || 0, paid[0]?.protection.expiresAt || 0);
  }
  async valid(event, now, isMember = () => true) {
    if (event.expiresAt <= now) return 'skip';
    const { kind, userId, data } = event;
    const bank = (await this.store.settings())?.bank;
    // Obsolete offered/accepted-quest outbox entries must never leak into the
    // daily system (including old completion and rejection notifications).
    if (kind.startsWith('quest_')) return 'skip';
    if (kind.startsWith('daily_')) {
      if (!await isMember(userId)) return 'skip';
      const day = await this.store.getDay(data.dayId);
      if (!day || day.dailyQuestVersion !== 1 || day.dailyQuestStartedAt !== data.startedAt
        || day.dailyQuestStartedAt <= (this.store.resetCutoff?.(userId) || 0)) return 'skip';
      const completed = day.tasks.filter(task => task.completed >= task.repeat).length;
      if (kind === 'daily_warning' && (dayKey(now) !== day.day || completed === day.tasks.length
        || !day.tasks.some(task => task.progress > 0))) return 'skip';
      if (kind === 'daily_completed' && !day.completionLog.some(entry => entry.taskId === data.taskId
        && entry.cycle === data.cycle && entry.at >= data.startedAt)) return 'skip';
      if (kind === 'daily_all_completed' && completed !== day.tasks.length) return 'skip';
      if (kind === 'daily_reset') {
        if (now < data.resetsAt) return 'wait';
        Object.assign(data, { completed, total: day.tasks.length, remaining: day.tasks.length - completed,
          earned: day.tasks.reduce((sum, task) => sum + task.completed * task.reward, 0) });
      }
    }
    if (kind === 'auction_started' && (await this.store.auctions.get(data.auctionId))?.status !== 'active') return 'skip';
    if (kind === 'salary_ready' || kind === 'prize_ready') {
      const salary = kind === 'salary_ready';
      const state = await this.store[salary ? 'latestSalary' : 'latestPrize'](userId);
      if (state?.[salary ? 'salaryLastAt' : 'prizeLastAt'] !== data.claimedAt) return 'skip';
      if (!bank?.channelId || (salary && !bankCommandStatus(bank).salary)) return 'wait';
    }
    if (kind === 'protection_expired' && (await this.latestProtectionExpiry(userId) !== data.expiresAt
      || await this.store.robbery.activeProtection(userId, now))) return 'skip';
    return 'send';
  }
}
