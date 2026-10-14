import { isId } from './config.js';
import { applyPurchase, validateProduct, MAX_PRODUCTS } from './shop.js';
import { notice } from './notification-events.js';

// One durable reservation serializes stock with its pending order. The worker
// lease and QuestService gate exclude all other balance/reset operations until
// its idempotent debit and immutable order are committed. Startup recovers this
// reservation BEFORE resets or activity. No replica-set-only transactions needed.
export class ShopStore {
  constructor(store) {
    this.store = store;
    this.id = `shop:${store.config.clanGuildId}`;
    this.clanId = store.config.clanGuildId;
  }
  get collection() { return this.store.db.collection('shops'); }
  get orders() { return this.store.db.collection('shop_orders'); }
  async initialize(now = Date.now()) {
    await this.store.requireLease(now);
    await this.collection.updateOne({ _id: this.id }, {
      $setOnInsert: { clanId: this.clanId, revision: 0, products: [], destination: null, pending: null }
    }, { upsert: true });
    await this.orders.createIndex({ clanId: 1, 'notification.sent': 1, 'notification.nextAt': 1, at: 1 });
  }
  async get() {
    const shop = await this.collection.findOne({ _id: this.id });
    if (!shop) throw new Error('المتجر غير مهيأ. أعد تشغيل النسخة المحدثة.');
    return shop;
  }
  async save(original, next, now) {
    await this.store.requireLease(now);
    const result = await this.collection.replaceOne({ _id: this.id, revision: original.revision }, {
      ...next, revision: original.revision + 1
    });
    if (result.matchedCount !== 1) throw new Error('تغير المتجر أثناء العملية. افتح المتجر وحاول مجددًا.');
  }
  async change(mutation, now) {
    const shop = await this.get();
    if (shop.pending) throw new Error('هناك طلب شراء قيد الاستكمال. أعد تشغيل الخدمة لاستكماله أولًا.');
    const next = structuredClone(shop);
    const result = mutation(next);
    await this.save(shop, next, now);
    return result;
  }
  async add(input, now) {
    const product = { id: input.id, ...validateProduct(input), createdBy: input.createdBy, createdAt: now };
    if (!isId(product.id) || !isId(product.createdBy)) throw new Error('معرف إضافة المنتج غير صالح.');
    return this.change(shop => {
      const previous = shop.products.find(p => p.id === product.id);
      if (previous) return previous;
      if (shop.products.length >= MAX_PRODUCTS) throw new Error(`الحد الأقصى ${MAX_PRODUCTS} منتج. أزل منتجًا قبل إضافة آخر.`);
      if (shop.products.some(p => p.name === product.name)) throw new Error('يوجد منتج بهذا الاسم. اختر اسمًا مختلفًا أو أزل المنتج السابق.');
      shop.products.push(product);
      return product;
    }, now);
  }
  async remove(idOrName, now) {
    return this.change(shop => {
      const key = String(idOrName || '').trim();
      const index = shop.products.findIndex(p => p.id === key || p.name === key);
      if (index < 0) throw new Error('لم أجد المنتج. استخدم اسمه المطابق أو معرفه الظاهر في المتجر.');
      return shop.products.splice(index, 1)[0];
    }, now);
  }
  async configure(destination, now) {
    if (!isId(destination.channelId) || !isId(destination.roleId) || destination.roleId === this.clanId) throw new Error('حدد روم التنبيهات ورتبة مخصصة داخل سيرفر الكلان.');
    return this.change(shop => { shop.destination = destination; return destination; }, now);
  }
  orderId(id) { return `${this.clanId}:${id}`; }
  async order(id) { return this.orders.findOne({ _id: this.orderId(id) }); }
  async reserve(shop, order, now) {
    if (shop.pending) throw new Error('هناك طلب شراء قيد الاستكمال.');
    const next = structuredClone(shop);
    const product = next.products.find(p => p.id === order.product.id);
    if (!product || product.stock < 1) throw new Error('نفدت كمية هذا المنتج أو أزيل من المتجر.');
    product.stock--;
    next.pending = order;
    await this.save(shop, next, now);
  }
  async recover(now = Date.now()) {
    const shop = await this.get();
    const pending = shop.pending;
    if (!pending) return null;
    await this.store.requireLease(now);
    // A retry after any lost acknowledgement observes the receipt and does not
    // debit again. Never compensate an uncertain write by refunding blindly.
    await this.store.mutateDay(pending.dayId, state => applyPurchase(state, pending));
    const savedOrder = { ...pending, _id: this.orderId(pending.id), clanId: this.clanId,
      notification: { sent: false, attempts: 0, nextAt: 0 } };
    this.store.notifications?.stage(savedOrder, [notice(pending.userId, 'shop_bought', pending.id, pending.at,
      { orderId: pending.id, product: pending.product, balanceAfter: pending.balanceAfter })]);
    await this.orders.updateOne({ _id: this.orderId(pending.id) }, {
      $setOnInsert: savedOrder
    }, { upsert: true });
    await this.save(shop, { ...shop, pending: null }, now);
    return this.order(pending.id);
  }
  async notifications(now) {
    return this.orders.find({ clanId: this.clanId, 'notification.sent': false, 'notification.nextAt': { $lte: now } })
      .sort({ at: 1, _id: 1 }).limit(10).toArray();
  }
  async notificationAttempt(order, now) {
    await this.store.requireLease(now);
    await this.orders.updateOne({ _id: order._id, 'notification.sent': false }, {
      $inc: { 'notification.attempts': 1 }, $set: { 'notification.nextAt': now + 60000 }
    });
  }
  async notified(order, message, destination, now) {
    await this.store.requireLease(now);
    await this.orders.updateOne({ _id: order._id, 'notification.sent': false }, {
      $set: { 'notification.sent': true, 'notification.messageId': message.id, 'notification.sentAt': now,
        'notification.destination': destination }
    });
  }
}
