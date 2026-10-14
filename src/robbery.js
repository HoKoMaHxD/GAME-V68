import { randomInt } from 'node:crypto';
import { isId } from './config.js';
import { purchaseDebit } from './shop.js';
import { newMine, mineOutcome } from './robbery-mine.js';

// Percentages are inclusive, and are copied into each round before it is shown.
export const ROBBERY_MIN_PERCENT = 15;
export const ROBBERY_MAX_PERCENT = 40;
export const ROBBERY_LOSS_MIN_PERCENT = 40;
export const ROBBERY_LOSS_MAX_PERCENT = 60;
export const ROBBERY_TIE_PERCENT = 0;
export const ROBBERY_TTL_MS = 2 * 60000;
export const ROBBERY_LOOTED_PROTECTION_MS = 3600000;
export const ROBBERY_FAILED_PROTECTION_MS = 15 * 60000;
export const ROBBERY_COMMAND_COOLDOWN_MS = 60000;
export const ROBBERY_MOVES = Object.freeze([
  { id: 'rock', label: 'حجر', emoji: '✊' },
  { id: 'paper', label: 'ورقة', emoji: '✋' },
  { id: 'scissors', label: 'مقص', emoji: '✌️' }
]);

export function validateRobberyRequest(input, now) {
  if (![input.id, input.userId, input.targetId, input.channelId].every(isId)) throw new Error('حدد عضوًا صحيحًا: !نهب @عضو');
  if (input.userId === input.targetId) throw new Error('ما تقدر تنهب نفسك. اختر عضوًا آخر.');
  if (input.targetBot) throw new Error('النهب متاح بين الأعضاء فقط؛ لا يمكن اختيار بوت.');
  if (!Number.isSafeInteger(input.at) || input.at <= 0 || input.at > now + 5000 || now - input.at > 900000) {
    throw new Error('انتهت صلاحية أمر النهب. اكتب !نهب @عضو من جديد.');
  }
}

export function newRobberyRound(input, now, choose = randomInt) {
  validateRobberyRequest(input, now);
  const gameIndex = choose(0, 2);
  if (![0, 1].includes(gameIndex)) throw new Error('تعذر اختيار لعبة النهب.');
  const game = gameIndex === 0 ? 'rps' : 'mine';
  const move = game === 'rps' ? choose(0, ROBBERY_MOVES.length) : null;
  const percent = choose(ROBBERY_MIN_PERCENT, ROBBERY_MAX_PERCENT + 1);
  const lossPercent = choose(ROBBERY_LOSS_MIN_PERCENT, ROBBERY_LOSS_MAX_PERCENT + 1);
  if ((game === 'rps' && (!Number.isInteger(move) || !ROBBERY_MOVES[move])) || !Number.isInteger(percent)
    || percent < ROBBERY_MIN_PERCENT || percent > ROBBERY_MAX_PERCENT
    || !Number.isInteger(lossPercent) || lossPercent < ROBBERY_LOSS_MIN_PERCENT || lossPercent > ROBBERY_LOSS_MAX_PERCENT) throw new Error('تعذر اختيار تحدي النهب.');
  return { id: input.id, userId: input.userId, targetId: input.targetId, channelId: input.channelId,
    requestAt: input.at, createdAt: now, expiresAt: now + ROBBERY_TTL_MS, status: 'open',
    timeoutLoss: true, delivery: { complete: false, required: input.requireDelivery === true },
    game, ...(game === 'mine' ? { mine: newMine(choose) } : { botMove: ROBBERY_MOVES[move].id }),
    percent, lossPercent, percentageVersion: 3, tiePercent: ROBBERY_TIE_PERCENT };
}

export function robberyStatus(round, now, cutoff = () => 0) {
  if (['settled', 'cancelled', 'expired'].includes(round.status)) return round.status;
  if (Math.min(round.createdAt, round.requestAt) <= Math.max(cutoff(round.userId), cutoff(round.targetId))) return 'cancelled';
  return now >= round.expiresAt ? 'expired' : 'open';
}

export function robberyOutcome(player, bot) {
  if (![player, bot].every(id => ROBBERY_MOVES.some(move => move.id === id))) throw new Error('اختر حجر أو ورقة أو مقص.');
  if (player === bot) return 'tie';
  return { rock: 'scissors', paper: 'rock', scissors: 'paper' }[player] === bot ? 'win' : 'loss';
}

export function resolveRobbery(round, playerMove, balances) {
  const outcome = round.endReason === 'timeout' ? 'loss'
    : round.game === 'mine' ? mineOutcome(round) : robberyOutcome(playerMove, round.botMove);
  // Reuse the wallet's validation, including nonnegative source buckets.
  for (const balance of [balances.user, balances.target]) purchaseDebit(balance, 0);
  const min = outcome === 'win' ? ROBBERY_MIN_PERCENT : ROBBERY_LOSS_MIN_PERCENT;
  const max = outcome === 'win' ? ROBBERY_MAX_PERCENT : ROBBERY_LOSS_MAX_PERCENT;
  let percent = outcome === 'tie' ? 0 : outcome === 'win' ? round.percent : round.lossPercent;
  // Unsettled pre-upgrade rounds get deterministic, bounded rates; never reroll
  // during settlement retries and never touch already committed results.
  if (outcome !== 'tie' && round.percentageVersion !== 3) {
    const previous = percent ?? round.percent;
    if (!Number.isInteger(previous) || previous < 1 || previous > 100) throw new Error('نسبة النهب المحفوظة غير صالحة.');
    percent = Math.max(min, Math.min(max, previous));
  }
  if (!Number.isInteger(percent) || (outcome !== 'tie' && (percent < min || percent > max))) throw new Error('نسبة النهب المحفوظة غير صالحة.');
  const fromId = outcome === 'tie' ? null : outcome === 'win' ? round.targetId : round.userId;
  const toId = fromId === null ? null : fromId === round.userId ? round.targetId : round.userId;
  const source = fromId === round.userId ? balances.user : balances.target;
  const amount = fromId === null ? 0 : Number(BigInt(source.total) * BigInt(percent) / 100n);
  const after = { user: balances.user.total, target: balances.target.total };
  if (fromId) {
    after[fromId === round.userId ? 'user' : 'target'] -= amount;
    after[toId === round.userId ? 'user' : 'target'] += amount;
  }
  if (!Object.values(after).every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('التحويل يتجاوز الحد الرقمي للرصيد.');
  return { outcome, percent, amount, fromId, toId, debit: fromId ? purchaseDebit(source, amount) : { tasks: 0, attendance: 0 },
    before: { user: balances.user.total, target: balances.target.total }, after };
}

export function robberyProtection(round, result, now) {
  // A successful theft that actually takes money grants the existing 1-hour
  // shield. A failed theft protects the intended target for 15 minutes.
  // Ties grant no automatic protection.
  if (result?.outcome === 'loss') {
    const durationMs = ROBBERY_FAILED_PROTECTION_MS;
    return { userId: round.targetId, durationMs, startedAt: now, expiresAt: now + durationMs };
  }
  if (result?.outcome !== 'win' || result.fromId !== round.targetId || !(result.amount > 0)) return null;
  const durationMs = ROBBERY_LOOTED_PROTECTION_MS;
  return { userId: round.targetId, durationMs, startedAt: now, expiresAt: now + durationMs };
}

export function effectiveRobberyProtection(round) {
  // Apply the current rule to existing automatic shields using their original
  // start time. Do not create shields for legacy results without one, extend
  // a saved expiry, or alter independently purchased protection.
  if (!round?.protection) return null;
  const startedAt = round.protection.startedAt;
  if (!Number.isSafeInteger(startedAt) || startedAt <= 0) return null;
  const protection = robberyProtection(round, round.result, startedAt);
  if (!protection) return null;
  const expiresAt = Math.min(protection.expiresAt, round.protection.expiresAt);
  return Number.isSafeInteger(expiresAt) && expiresAt > startedAt
    ? { ...protection, expiresAt, durationMs: expiresAt - startedAt } : null;
}

export function applyRobberyTransfer(state, round) {
  const result = round.result;
  if (!result.amount) return false;
  const debit = state.userId === result.fromId;
  const expected = debit ? round.fromDayId : round.toDayId;
  if (state._id !== expected || ![result.fromId, result.toId].includes(state.userId)) throw new Error('سجل العضو لا يطابق تحويل النهب.');
  if (state.robberyReceipts?.includes(round.id)) return false;
  const delta = debit ? { tasks: -result.debit.tasks, attendance: -result.debit.attendance }
    : { tasks: result.amount, attendance: 0 };
  const next = Object.fromEntries(['tasks', 'attendance'].map(key => [key, (state.robberyAdjustments?.[key] || 0) + delta[key]]));
  if (!Object.values(next).every(Number.isSafeInteger)) throw new Error('تحويل النهب يتجاوز الحد الرقمي المسموح.');
  state.robberyAdjustments = next;
  state.financialContext ||= structuredClone({id:round.id, userId:round.userId, targetId:round.targetId, result:round.result, game:round.game, settledAt:round.settledAt});
  (state.robberyReceipts ||= []).push(round.id);
  return true;
}
