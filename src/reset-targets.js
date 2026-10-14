import { netPoints } from './point-adjustments.js';

export function resetTarget(target = 'all') {
  if (!['all', 'bank', 'activity'].includes(target)) throw new Error('اختر قسم الريست: توب البنك أو توب الشات والفويس.');
  return target;
}

// Preserve receipts, cooldowns, daily quests and the other leaderboard.
// A per-day operation marker makes a partially completed reset resumable.
export function applyScopedReset(state, record) {
  const target = resetTarget(record.target);
  if (target === 'all') throw new Error('التصفير الشامل لا يستخدم مسار تصفير الأقسام.');
  if (state.scopedResets?.[target]?.operationId === record.operationId) return false;
  if (target === 'bank') {
    const balance = netPoints(state);
    const adjustment = Object.fromEntries(['tasks', 'attendance'].map(key => [key,
      (state.bankResetAdjustments?.[key] || 0) - balance[key]]));
    if (!Object.values(adjustment).every(Number.isSafeInteger)) throw new Error('تعذر تصفير رصيد يتجاوز الحد الرقمي المسموح.');
    state.bankResetAdjustments = adjustment;
  } else {
    state.activity = { ...state.activity, clanMessages: 0, voiceMs: 0 };
  }
  (state.scopedResets ||= {})[target] = { operationId: record.operationId, at: record.cutoff };
  return true;
}
