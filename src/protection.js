export const PROTECTION_CONFIRM_MS = 30000;
export const PROTECTION_PRICE = 10000;
export const PROTECTION_DURATION_MS = 3 * 3600000;

// The journal commits the purchase before this idempotent wallet debit. The
// separate purchase receipt keeps the shield alive across wallet resets.
export function applyProtectionPurchase(state, purchase) {
  if (state._id !== purchase.dayId || state.userId !== purchase.userId) throw new Error('سجل العضو لا يطابق طلب الحماية.');
  if (state.protectionReceipts?.includes(purchase.id)) return false;
  if (!Number.isSafeInteger(purchase.price) || purchase.price <= 0
    || !['tasks', 'attendance'].every(key => Number.isSafeInteger(purchase.debit?.[key]) && purchase.debit[key] >= 0)
    || purchase.debit.tasks + purchase.debit.attendance !== purchase.price) throw new Error('خصم الحماية غير صالح.');
  const amounts = Object.fromEntries(['tasks', 'attendance'].map(key => [key,
    (state.protectionAdjustments?.[key] || 0) - purchase.debit[key]]));
  if (!Object.values(amounts).every(Number.isSafeInteger)) throw new Error('خصم الحماية يتجاوز الحد الرقمي المسموح.');
  state.protectionAdjustments = amounts;
  (state.protectionReceipts ||= []).push(purchase.id);
  state.financialContext ||= structuredClone(purchase);
  return true;
}

export function readProtectionSettings(saved = {}) {
  saved ||= {};
  return {
    protectionPrice: Number.isSafeInteger(saved.protectionPrice) && saved.protectionPrice > 0 && saved.protectionPrice <= 1000000000 ? saved.protectionPrice : PROTECTION_PRICE,
    protectionMinutes: Number.isSafeInteger(saved.protectionMinutes) && saved.protectionMinutes > 0 && saved.protectionMinutes <= 525600 ? saved.protectionMinutes : PROTECTION_DURATION_MS / 60000,
    protectionStack: saved.protectionStack !== false
  };
}
export function validateProtectionChange(input) {
  const fields = {};
  for (const [key, max] of [['protectionPrice', 1000000000], ['protectionMinutes', 525600]]) {
    if (!Object.hasOwn(input, key)) continue;
    if (!Number.isSafeInteger(input[key]) || input[key] < 1 || input[key] > max) throw new Error('سعر الحماية ومدتها يجب أن يكونا عددين صحيحين ضمن الحدود المعروضة.');
    fields[key] = input[key];
  }
  if (Object.hasOwn(input, 'protectionStack')) {
    if (typeof input.protectionStack !== 'boolean') throw new Error('خيار تمديد الحماية غير صالح.');
    fields.protectionStack = input.protectionStack;
  }
  return fields;
}
export function requireProtectionRenewal(settings, protection, now) {
  if (!settings.protectionStack && protection?.expiresAt - now > 60000) throw new Error('لا يمكنك شراء حماية جديدة إلا في آخر دقيقة من الحماية الحالية أو بعد انتهائها.');
}
