import { isId } from './config.js';

export const MAX_POINT_ADJUSTMENT = 1000000;

// Earned points remain separate so a manual voice credit/debit cannot change
// the attendance cap, carry, observed minutes or quest completion guards.
export function netPoints(state) {
  const tasks = (state.points?.tasks || 0) + (state.pointAdjustments?.tasks || 0) + (state.shopAdjustments?.tasks || 0) + (state.robberyAdjustments?.tasks || 0) + (state.auctionAdjustments?.tasks || 0) + (state.protectionAdjustments?.tasks || 0) + (state.miniAdjustments?.tasks || 0) + (state.bankResetAdjustments?.tasks || 0) + (state.salaryCredits || 0) + (state.prizeCredits || 0);
  const attendance = (state.points?.attendance || 0) + (state.pointAdjustments?.attendance || 0) + (state.shopAdjustments?.attendance || 0) + (state.robberyAdjustments?.attendance || 0) + (state.auctionAdjustments?.attendance || 0) + (state.protectionAdjustments?.attendance || 0) + (state.miniAdjustments?.attendance || 0) + (state.bankResetAdjustments?.attendance || 0);
  return { tasks, attendance, total: tasks + attendance };
}

export function pointSum(category) {
  return { $sum: { $add: [
    { $ifNull: [`$points.${category}`, 0] }, { $ifNull: [`$pointAdjustments.${category}`, 0] },
    { $ifNull: [`$shopAdjustments.${category}`, 0] }, { $ifNull: [`$robberyAdjustments.${category}`, 0] },
    { $ifNull: [`$auctionAdjustments.${category}`, 0] },
    { $ifNull: [`$protectionAdjustments.${category}`, 0] },
    { $ifNull: [`$miniAdjustments.${category}`, 0] },
    { $ifNull: [`$bankResetAdjustments.${category}`, 0] },
    ...(category === 'tasks' ? [{ $ifNull: ['$salaryCredits', 0] }, { $ifNull: ['$prizeCredits', 0] }] : [])
  ] } };
}

export function validatePointAdjustment(input, now) {
  if (!isId(input.userId) || !isId(input.actorId) || !isId(input.operationId)) throw new Error('معرف العضو أو عملية تعديل النقاط غير صالح.');
  if (!['add', 'remove'].includes(input.mode) || !['tasks', 'attendance', 'total'].includes(input.category)) throw new Error('نوع تعديل العملة غير صالح.');
  if (!Number.isSafeInteger(input.amount) || input.amount < 1 || input.amount > MAX_POINT_ADJUSTMENT) {
    throw new Error(`عدد النقاط يجب أن يكون صحيحًا من 1 إلى ${MAX_POINT_ADJUSTMENT.toLocaleString('en-US')}.`);
  }
  if (!Number.isSafeInteger(input.at) || input.at <= 0 || input.at > now + 5000) throw new Error('وقت طلب تعديل النقاط غير صالح.');
  if (input.reason != null && (typeof input.reason !== 'string' || input.reason.length > 200)) throw new Error('سبب التعديل يجب ألا يتجاوز 200 حرف.');
  return { operationId: input.operationId, userId: input.userId, actorId: input.actorId,
    category: input.category, mode: input.mode, amount: input.amount,
    delta: input.mode === 'add' ? input.amount : -input.amount,
    reason: (input.reason || '').trim(), at: input.at };
}

export function applyPointAdjustment(state, entry) {
  if (state.adjustmentLog?.some(item => item.operationId === entry.operationId)) return false;
  if (entry.category === 'total') {
    if (!entry.amounts || !['tasks', 'attendance'].every(key => Number.isSafeInteger(entry.amounts[key]))
      || entry.amounts.tasks + entry.amounts.attendance !== entry.delta) throw new Error('توزيع تعديل العملة غير صالح.');
    const next = Object.fromEntries(['tasks', 'attendance'].map(key => [key,
      (state.pointAdjustments?.[key] || 0) + entry.amounts[key]]));
    if (!Object.values(next).every(Number.isSafeInteger)) throw new Error('التعديل يتجاوز الحد الرقمي المسموح.');
    state.pointAdjustments = next;
    (state.adjustmentLog ||= []).push(structuredClone(entry));
    return true;
  }
  const amount = (state.pointAdjustments?.[entry.category] || 0) + entry.delta;
  if (!Number.isSafeInteger(amount)) throw new Error('نتيجة التعديل تتجاوز الحد الرقمي المسموح.');
  state.pointAdjustments ||= { tasks: 0, attendance: 0 };
  state.pointAdjustments[entry.category] = amount;
  state.adjustmentLog ||= [];
  state.adjustmentLog.push(structuredClone(entry));
  return true;
}
