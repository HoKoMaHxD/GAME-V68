import { applyRobberyTransfer, effectiveRobberyProtection, ROBBERY_LOOTED_PROTECTION_MS } from './robbery.js';
import { applyProtectionPurchase } from './protection.js';
import { robberyNotices, protectionNotices } from './notification-events.js';

// A durable transfer intent is committed before either wallet changes. The
// service's exclusive gate and worker lease prevent spending/resetting a
// half-finished transfer. Recovery completes both idempotent legs before startup.
export class RobberyStore {
  constructor(store) {
    this.store = store; this.clanId = store.config.clanGuildId;
    this.id = `robbery:${this.clanId}`;
  }
  get collection() { return this.store.db.collection('robberies'); }
  get rounds() { return this.store.db.collection('robbery_rounds'); }
  get purchases() { return this.store.db.collection('protection_purchases'); }
  async initialize(now = Date.now()) {
    await this.store.requireLease(now);
    await this.collection.updateOne({ _id: this.id }, { $setOnInsert: { clanId: this.clanId, revision: 0, pending: null } }, { upsert: true });
    await this.rounds.createIndex({ clanId: 1, userId: 1, status: 1, expiresAt: 1, createdAt: -1 });
    await this.rounds.createIndex({ clanId: 1, targetId: 1 }, { name: 'one_live_robbery_per_target', unique: true,
      partialFilterExpression: { status: 'open', timeoutLoss: true } });
    await this.rounds.createIndex({ clanId: 1, timeoutLoss: 1, status: 1, expiresAt: 1 });
    await this.rounds.createIndex({ clanId: 1, status: 1, expiresAt: 1 });
    await this.rounds.createIndex({ clanId: 1, 'delivery.complete': 1, status: 1 });
    await this.rounds.createIndex({ clanId: 1, targetId: 1, status: 1, 'protection.expiresAt': -1 });
    await this.rounds.createIndex({ clanId: 1, targetId: 1, status: 1, 'result.outcome': 1, 'protection.startedAt': -1 });
    await this.purchases.createIndex({ clanId: 1, userId: 1, 'protection.expiresAt': -1 });
  }
  get attempts() { return this.store.db.collection('robbery_attempts'); }
  async spamState(userId) { return this.attempts.findOne({ _id: `${this.clanId}:${userId}` }); }
  // Called only inside the service's exclusive gate under the worker lease.
  async checkSpam(userId, requestId, now) {
    await this.store.requireLease(now);
    const previous = await this.spamState(userId);
    const blocked = (until, extended = false) => Object.assign(new Error(`${extended ? 'زادت مدة منعك 5 دقائق إضافية بسبب تكرار النهب أثناء المنع.' : 'تم منعك من النهب بسبب السبام؛ مدة المنع الأساسية 5 دقائق.'} تقدر تستخدمه مجددًا <t:${Math.ceil(until / 1000)}:R>.`),
      { code: 'ROBBERY_SPAM_BLOCKED', nextAt: until });
    const active = previous?.blockedUntil > now;
    // Redelivered Discord events must never add another penalty, including an
    // older request delivered after a newer request within the same block.
    const known = previous?.requestId === requestId || (active && previous?.blockedRequestIds?.includes(requestId));
    if (known) { if (active) throw blocked(previous.blockedUntil); return; }
    const spam = active || (previous && now - previous.lastAt < 10000);
    const next = { _id: `${this.clanId}:${userId}`, clanId: this.clanId, userId, requestId,
      lastAt: now, blockedUntil: active ? previous.blockedUntil + 300000 : spam ? now + 300000 : 0,
      blockedRequestIds: spam ? [...new Set([...(active ? previous.blockedRequestIds || [] : []), previous.requestId, requestId].filter(Boolean))] : [] };
    try { await this.attempts.replaceOne({ _id: next._id }, next, { upsert: true }); }
    catch (error) {
      const saved = await this.spamState(userId).catch(() => null);
      if (saved?.requestId !== requestId || saved?.blockedUntil !== next.blockedUntil) throw error;
    }
    if (spam) throw blocked(next.blockedUntil, active);
  }

  async get() {
    const record = await this.collection.findOne({ _id: this.id });
    if (!record) throw new Error('نظام النهب غير مهيأ. أعد تشغيل النسخة المحدثة.');
    return record;
  }
  async save(original, pending, now) {
    await this.store.requireLease(now);
    const saved = await this.collection.replaceOne({ _id: this.id, revision: original.revision },
      { ...original, revision: original.revision + 1, pending });
    if (saved.matchedCount !== 1) throw new Error('تغير سجل النهب أثناء العملية. أعد تشغيل الخدمة للتحقق من النتيجة.');
  }
  async round(id) {
    let round = await this.rounds.findOne({ _id: `${this.clanId}:${id}` });
    if (round?.timedOut && !round.endReason) round = { ...round, endReason: 'timeout' };
    return round?.status === 'settled' && Object.hasOwn(round, 'protection')
      ? { ...round, protection: effectiveRobberyProtection(round) } : round;
  }
  async protectionPurchase(id) { return this.purchases.findOne({ _id: `${this.clanId}:${id}` }); }
  async activeProtection(userId, now) {
    // Filter outcomes before limiting so an old tie/loss cannot hide a newer
    // successful theft. Old 12-hour shields expire one hour from their start.
    const rows = await this.rounds.find({ clanId: this.clanId, targetId: userId, status: 'settled',
      'result.outcome': { $in: ['win', 'loss'] }, 'protection.startedAt': { $gt: now - ROBBERY_LOOTED_PROTECTION_MS },
      'protection.expiresAt': { $gt: now } }).sort({ 'protection.startedAt': -1 }).limit(1).toArray();
    const paid = await this.purchases.find({ clanId: this.clanId, userId,
      'protection.expiresAt': { $gt: now } }).sort({ 'protection.expiresAt': -1 }).limit(1).toArray();
    return [effectiveRobberyProtection(rows[0]), paid[0]?.protection].filter(protection => protection?.expiresAt > now)
      .sort((a, b) => b.expiresAt - a.expiresAt)[0] || null;
  }
  async activeRound(userId, now) {
    const rows = await this.rounds.find({ clanId: this.clanId, userId, status: 'open', expiresAt: { $gt: now } })
      .sort({ createdAt: -1, _id: -1 }).limit(1).toArray();
    return rows[0] || null;
  }
  async latestRound(userId) {
    return this.rounds.findOne({ clanId: this.clanId, userId }, { sort: { createdAt: -1, _id: -1 } });
  }
  async blockingRounds(userId, targetId) {
    return this.rounds.find({ clanId: this.clanId, status: 'open', $or: [{ userId }, { targetId }] })
      .sort({ createdAt: -1, _id: -1 }).limit(200).toArray();
  }
  async managedOpen() {
    return this.rounds.find({ clanId: this.clanId, status: 'open' })
      .sort({ expiresAt: 1, _id: 1 }).limit(200).toArray();
  }
  async pendingDisplays(now) {
    return this.rounds.find({ clanId: this.clanId, status: { $in: ['open', 'settled', 'cancelled', 'expired'] },
      'delivery.complete': false, $or: [{ 'delivery.nextAttemptAt': { $exists: false } }, { 'delivery.nextAttemptAt': { $lte: now } }] })
      .sort({ 'delivery.nextAttemptAt': 1, createdAt: 1 }).limit(25).toArray();
  }
  async close(round, status, now, endReason) {
    await this.store.requireLease(now);
    try {
      await this.rounds.updateOne({ _id: round._id, status: 'open' }, { $set: { status, closedAt: now,
        'delivery.complete': false, 'delivery.nextAttemptAt': 0, ...(endReason ? { endReason } : {}) } });
    } catch (error) {
      const saved = await this.round(round.id).catch(() => null);
      if (saved?.status !== status) throw error;
    }
    return this.round(round.id);
  }
  async queueLegacyDisplay(round, now) {
    await this.store.requireLease(now);
    await this.rounds.updateOne({ _id: round._id, status: 'open', delivery: { $exists: false } },
      { $set: { delivery: { complete: false, nextAttemptAt: 0 } } });
    return this.round(round.id);
  }
  async bindMessage(id, messageId, author, now) {
    await this.store.requireLease(now);
    await this.rounds.updateOne({ _id: `${this.clanId}:${id}`, 'delivery.messageId': { $exists: false } },
      { $set: { 'delivery.messageId': messageId, 'delivery.complete': false, displayAuthor: author } });
  }
  async displayComplete(round, messageId, now) {
    await this.store.requireLease(now);
    // A late Discord acknowledgement must not mark a newer turn/result as shown.
    await this.rounds.updateOne({ _id: `${this.clanId}:${round.id}`, status: round.status,
      ...(round.game === 'mine' ? { 'mine.revision': round.mine.revision } : {}),
      'delivery.messageId': messageId }, { $set: { 'delivery.complete': true, 'delivery.confirmedAt': now } });
  }
  async displayRetry(id, nextAttemptAt, now) {
    await this.store.requireLease(now);
    await this.rounds.updateOne({ _id: `${this.clanId}:${id}`, 'delivery.complete': false }, { $set: { 'delivery.nextAttemptAt': nextAttemptAt } });
  }
  async create(round, now) {
    await this.store.requireLease(now);
    await this.rounds.updateOne({ _id: `${this.clanId}:${round.id}` },
      { $setOnInsert: { ...round, clanId: this.clanId } }, { upsert: true });
    const saved = await this.round(round.id);
    if (!saved || saved.userId !== round.userId || saved.targetId !== round.targetId || saved.channelId !== round.channelId) {
      throw new Error('تعذر تأكيد حفظ تحدي النهب.');
    }
    return saved;
  }
  async reserve(round, now) {
    const record = await this.get();
    if (record.pending) throw new Error('هناك تحويل نهب غير مكتمل. أعد تشغيل الخدمة لاستكماله.');
    await this.save(record, round, now);
  }
  async advanceMine(original, next, now) {
    await this.store.requireLease(now);
    next = { ...next, delivery: { ...original.delivery, complete: false, nextAttemptAt: 0 } };
    try {
      const saved = await this.rounds.replaceOne({ _id: original._id, status: 'open', 'mine.revision': original.mine.revision }, next);
      if (saved.matchedCount !== 1) throw new Error('تغيّرت لوحة اللغم أثناء الاختيار.');
      return next;
    } catch (cause) {
      // A lost acknowledgement must not roll another bot move or consume a turn.
      const saved = await this.round(original.id).catch(() => null);
      if (saved?.mine?.receipts.includes(next.mine.receipts.at(-1))) return saved;
      throw new Error('لم يتأكد حفظ دور اللغم. اضغط الرقم مجددًا لعرض اللوحة المحفوظة.', { cause });
    }
  }
  async recover(now = Date.now()) {
    const record = await this.get(); const round = record.pending;
    if (!round) return null;
    if (round.kind === 'protection-purchase') return this.recoverProtection(record, now);
    if (round.result.amount) for (const dayId of [round.fromDayId, round.toDayId]) {
      await this.store.requireLease(now);
      await this.store.mutateDay(dayId, state => applyRobberyTransfer(state, round));
    }
    await this.store.requireLease(now);
    const savedRound = structuredClone(round);
    this.store.notifications?.stage(savedRound, robberyNotices(round));
    const saved = await this.rounds.replaceOne({ _id: round._id, status: 'open' }, savedRound);
    if (saved.matchedCount !== 1) {
      const previous = await this.round(round.id);
      if (previous?.status !== 'settled' || previous.resolutionId !== round.resolutionId) throw new Error('تعذر تأكيد نتيجة النهب المحفوظة.');
    }
    await this.save(record, null, now);
    return this.round(round.id);
  }
  async recoverProtection(record, now) {
    const purchase = record.pending;
    await this.store.requireLease(now);
    await this.store.mutateDay(purchase.dayId, state => applyProtectionPurchase(state, purchase));
    await this.store.requireLease(now);
    await this.purchases.updateOne({ _id: `${this.clanId}:${purchase.id}` }, {
      $setOnInsert: this.store.notifications?.stage({ ...purchase, clanId: this.clanId }, protectionNotices(purchase)) || { ...purchase, clanId: this.clanId }
    }, { upsert: true });
    const saved = await this.protectionPurchase(purchase.id);
    if (!saved || saved.userId !== purchase.userId || saved.channelId !== purchase.channelId
      || saved.price !== purchase.price || saved.protection?.expiresAt !== purchase.protection.expiresAt) {
      throw new Error('تعذر تأكيد حفظ الحماية.');
    }
    await this.save(record, null, now);
    return saved;
  }
}
