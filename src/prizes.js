import { randomInt } from 'node:crypto';

export const PRIZE_INTERVAL_MS = 2 * 3600000;
export const PRIZE_MIN_PERCENT = 50;
export const PRIZE_MAX_PERCENT = 70;
export const PRIZE_MIN_MONEY = 500;
export const PRIZE_MAX_MONEY = 2000;
// Retired quest-wait rewards become salary bonuses; keep the cash odds (1/3).
const TYPES = ['salary', 'salary', 'money'];

export function drawPrize(choose = randomInt) {
  const type = TYPES[choose(0, TYPES.length)];
  if (!type) throw new Error('تعذر اختيار نوع الجائزة.');
  const min = type === 'money' ? PRIZE_MIN_MONEY : PRIZE_MIN_PERCENT;
  const max = type === 'money' ? PRIZE_MAX_MONEY : PRIZE_MAX_PERCENT;
  const value = choose(min, max + 1);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('قيمة الجائزة غير صالحة.');
  return type === 'money' ? { type, amount: value } : { type, percent: value, amount: 0 };
}

export function applyPrize(state, receipt) {
  if (state.userId !== receipt.userId || state._id !== receipt.dayId) throw new Error('سجل الجائزة لا يطابق العضو.');
  if (state.prizeReceipts?.some(item => item.id === receipt.id)) return false;
  const credits = (state.prizeCredits || 0) + receipt.amount;
  if (!Number.isSafeInteger(credits) || credits < 0) throw new Error('الجائزة تتجاوز الحد الرقمي للرصيد.');
  state.prizeCredits = credits;
  state.prizeLastAt = receipt.claimedAt;
  (state.prizeReceipts ||= []).push(structuredClone(receipt));
  return true;
}

// Store the use alongside its effect (salary credit).
// This avoids a second write to the day on which the prize was originally won.
export function usePrizeBonus(state, id, type, at) {
  if (state.prizeUses?.some(item => item.id === id)) throw new Error('استُخدمت هذه الجائزة سابقًا.');
  (state.prizeUses ||= []).push({ id, type, at });
}
