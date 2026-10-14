import { applyAuctionLeg, MAX_OPEN_AUCTIONS } from './auction.js';
import { auctionNotices } from './notification-events.js';

// All callers use QuestService's exclusive gate. The singleton worker lease,
// durable intent and idempotent legs support standalone MongoDB as well as Atlas.
export class AuctionStore {
  constructor(store) {
    this.store = store; this.clanId = store.config.clanGuildId;
    this.journalId = `auction:${this.clanId}`;
  }
  get collection() { return this.store.db.collection('auctions'); }
  get journals() { return this.store.db.collection('auction_journals'); }
  get events() { return this.store.db.collection('auction_events'); }
  key(id) { return `${this.clanId}:${id}`; }
  async initialize(now = Date.now()) {
    await this.store.requireLease(now);
    await this.journals.updateOne({ _id: this.journalId }, { $setOnInsert: { revision: 0, pending: null } }, { upsert: true });
    await this.collection.createIndex({ clanId: 1, 'delivery.complete': 1, startsAt: 1 });
    await this.collection.createIndex({ clanId: 1, highestBidderId: 1, status: 1 });
    await this.events.createIndex({ clanId: 1, auctionId: 1, at: 1 });
  }
  async get(id) { return this.collection.findOne({ _id: this.key(id) }); }
  async event(id) { return this.events.findOne({ _id: this.key(id) }); }
  async pending() { return this.journals.findOne({ _id: this.journalId }); }
  async unfinished() {
    return this.collection.find({ clanId: this.clanId, 'delivery.complete': false }).sort({ startsAt: 1, _id: 1 }).toArray();
  }
  async holds(userId = null) {
    const rows = await this.collection.find({ clanId: this.clanId, status: 'active',
      ...(userId ? { highestBidderId: userId } : {}) }).toArray();
    return rows.filter(a => a.hold);
  }
  async create(auction, now) {
    const previous = await this.get(auction.id);
    if (previous) return previous;
    if ((await this.unfinished()).length >= MAX_OPEN_AUCTIONS) throw new Error(`الحد الأقصى ${MAX_OPEN_AUCTIONS} مزادًا بانتظار الاستكمال.`);
    await this.store.requireLease(now);
    await this.collection.updateOne({ _id: this.key(auction.id) }, {
      $setOnInsert: { ...auction, clanId: this.clanId }
    }, { upsert: true });
    return this.get(auction.id);
  }
  async save(original, next, now) {
    await this.store.requireLease(now);
    this.store.notifications?.stage(next, auctionNotices(original, next, now));
    const result = await this.collection.replaceOne({ _id: original._id, revision: original.revision },
      { ...next, revision: original.revision + 1 });
    if (result.matchedCount !== 1) throw new Error('تغير سجل المزاد؛ أعد المحاولة.');
    return this.get(original.id);
  }
  async delivery(id, patch, now) {
    await this.store.requireLease(now);
    const fields = Object.fromEntries(Object.entries(patch).map(([key, value]) => [`delivery.${key}`, value]));
    await this.collection.updateOne({ _id: this.key(id) }, { $set: fields });
    return this.get(id);
  }
  async reserve(operation, now) {
    const journal = await this.pending();
    if (!journal || journal.pending) throw new Error('هناك عملية مزاد غير مكتملة؛ أعد تشغيل الخدمة لاستكمالها.');
    await this.store.requireLease(now);
    const result = await this.journals.replaceOne({ _id: this.journalId, revision: journal.revision },
      { ...journal, revision: journal.revision + 1, pending: operation });
    if (result.matchedCount !== 1) throw new Error('تعذر حجز عملية المزاد.');
  }
  async recover(now = Date.now()) {
    const journal = await this.pending();
    if (!journal?.pending) return null;
    const op = journal.pending;
    for (const leg of op.legs) {
      await this.store.requireLease(now);
      await this.store.mutateDay(leg.dayId, state => applyAuctionLeg(state, leg));
    }
    await this.store.requireLease(now);
    await this.events.updateOne({ _id: this.key(op.id) }, {
      $setOnInsert: { ...op.audit, id: op.id, clanId: this.clanId, auctionId: op.next.id, legs: op.legs }
    }, { upsert: true });
    const current = await this.get(op.next.id);
    if (current?.lastOperationId !== op.id) {
      if (current?.revision !== op.previousRevision) throw new Error('تعذر مطابقة سجل استرجاع المزاد.');
      await this.save(current, { ...op.next, lastOperationId: op.id }, now);
    }
    await this.store.requireLease(now);
    const cleared = await this.journals.replaceOne({ _id: this.journalId, revision: journal.revision },
      { ...journal, revision: journal.revision + 1, pending: null });
    if (cleared.matchedCount !== 1) throw new Error('تعذر تأكيد اكتمال عملية المزاد.');
    return this.event(op.id);
  }
}
