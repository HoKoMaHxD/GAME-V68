import { isId } from './config.js';

export const RESET_DB_OPTIONS = Object.freeze({ timeoutMS: 10000, maxTimeMS: 8000 });
export const RESET_GAMES = ['xo', 'button', 'mines', 'numbers', 'dot', 'boxes', 'ship'];
export const RESET_COLLECTIONS = ['days', ...RESET_GAMES.map(name => `${name}_games`), 'robbery_rounds',
  'robbery_attempts', 'protection_purchases', 'auctions', 'auction_events', 'shop_orders', 'task_boosts',
  'spam_messages', 'financial_logs', 'member_notifications', 'quest_views'];
export const fullResetId = store => `full-reset:${store.config.clanGuildId}`;
export function validateFullReset(request) {
  if (request.userId != null || (request.target && request.target !== 'all') || !isId(request.actorId)
    || !/^[a-zA-Z0-9-]{1,64}$/.test(request.operationId || '')) throw new Error('طلب الريست الشامل غير صالح.');
}
export function readFullReset(store) {
  return store.db.collection('full_resets').findOne({ _id: fullResetId(store) }, RESET_DB_OPTIONS);
}
export async function performFullReset(store, request, clock = Date.now) {
  validateFullReset(request);
  const collection = store.db.collection('full_resets'), clanId = store.config.clanGuildId;
  await store.requireLease(clock(), RESET_DB_OPTIONS);
  let record = await readFullReset(store);
  if (record?.operationId === request.operationId && !record.pending) return { ...record, alreadyCompleted: true };
  if (!record?.pending) {
    const count = await store.db.collection('days').countDocuments({ clanId }, RESET_DB_OPTIONS);
    record = { _id: fullResetId(store), clanId, userId: null, target: 'all', actorId: request.actorId,
      operationId: request.operationId, cutoff: clock(), requestedAt: clock(), pending: true, step: 0, deletedDays: count };
    // Durable intent precedes every destructive operation. Retry uncertain writes by reading this same ID.
    await collection.replaceOne({ _id: record._id }, record, { upsert: true, ...RESET_DB_OPTIONS });
  }
  const remove = (name, filter) => () => store.db.collection(name).deleteMany(filter, RESET_DB_OPTIONS);
  const set = (name, id, value) => () => store.db.collection(name).replaceOne({ _id: id }, { _id: id, ...value }, { upsert: true, ...RESET_DB_OPTIONS });
  const steps = [
    ...RESET_GAMES.map(name => set(`${name}_journals`, clanId, { pending: null })),
    set('auction_journals', `auction:${clanId}`, { revision: 0, pending: null }),
    set('robberies', `robbery:${clanId}`, { clanId, revision: 0, pending: null }),
    async () => {
      // Return only an unfinished stock reservation, atomically with clearing it.
      const shops = store.db.collection('shops'), shop = await shops.findOne({ _id: `shop:${clanId}` }, RESET_DB_OPTIONS);
      if (!shop?.pending) return;
      const next = structuredClone(shop), product = next.products.find(p => p.id === next.pending.product?.id);
      if (product) product.stock++;
      next.pending = null; next.revision++;
      const result = await shops.replaceOne({ _id: shop._id, revision: shop.revision }, next, RESET_DB_OPTIONS);
      if (result.matchedCount !== 1) throw new Error('تعذر تأكيد إلغاء حجز المتجر.');
    },
    ...RESET_COLLECTIONS.map(name => remove(name, { clanId })),
    // Arena tracking documents use a namespaced room ID rather than clanId.
    remove('game_events', { roomId: { $regex: `^games:${clanId}:` } }),
    remove('game_rooms', { _id: { $regex: `^games:${clanId}:` } }),
    remove('resets', { clanId })
  ];
  for (let step = record.step || 0; step < steps.length; step++) {
    await store.requireLease(clock(), RESET_DB_OPTIONS);
    await steps[step]();
    const saved = await collection.updateOne({ _id: record._id, operationId: record.operationId, pending: true },
      { $set: { step: step + 1 } }, RESET_DB_OPTIONS);
    if (saved.matchedCount !== 1) throw new Error('تعذر حفظ مرحلة الريست الشامل.');
  }
  // Fence delayed events through the END of the pause, including a failed/retried reset.
  const cutoff = Math.max(record.cutoff, clock());
  const result = { ...record, cutoff, pending: false, step: steps.length, completedAt: cutoff };
  await store.requireLease(clock(), RESET_DB_OPTIONS);
  await store.db.collection('resets').replaceOne({ _id: `reset:${clanId}:all` },
    { ...result, _id: `reset:${clanId}:all`, fullData: true }, { upsert: true, ...RESET_DB_OPTIONS });
  await store.db.collection('settings').updateOne({ _id: store.settingsId }, { $set: {
    'runtimeControl.enabled': true, 'runtimeControl.resumedAt': cutoff, 'runtimeControl.changedAt': cutoff,
    'runtimeControl.actorId': record.actorId, 'runtimeControl.resetOperationId': record.operationId
  } }, { upsert: true, ...RESET_DB_OPTIONS });
  const completed = await collection.updateOne({ _id: record._id, operationId: record.operationId, pending: true },
    { $set: { pending: false, cutoff, completedAt: cutoff } }, RESET_DB_OPTIONS);
  if (completed.matchedCount !== 1) throw new Error('تعذر تأكيد اكتمال الريست الشامل.');
  return result;
}
