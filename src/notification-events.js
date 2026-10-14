import { createHash } from 'node:crypto';
import { dayStart, nextReset } from './time.js';

export const NOTIFICATION_BUTTON = 'clan-notifications:toggle';
export const NOTICE_DAY_MS = 86400000;
export const noticeId = (userId, key) => createHash('sha256').update(`${userId}:${key}`).digest('hex').slice(0, 24);
export function notice(userId, kind, key, at, data = {}, dueAt = at) {
  return { id: noticeId(userId, `${kind}:${key}`), userId, kind, at, dueAt, data,
    expiresAt: dueAt + (kind.endsWith('_ready') || kind.startsWith('quest_') ? NOTICE_DAY_MS : 7 * NOTICE_DAY_MS) };
}
export function dayNotices(before, after) {
  const events = [], userId = after.userId;
  if (after.dailyQuestVersion === 1 && after.tasks?.length) {
    const key = `${after._id}:${after.dailyQuestStartedAt}`;
    const data = { dayId: after._id, day: after.day, startedAt: after.dailyQuestStartedAt,
      resetsAt: nextReset(dayStart(after.day)) };
    if (before.dailyQuestVersion !== 1) {
      events.push({ ...notice(userId, 'daily_warning', key, after.dailyQuestStartedAt, data, data.resetsAt - 600000), expiresAt: data.resetsAt });
      events.push({ ...notice(userId, 'daily_reset', key, after.dailyQuestStartedAt, data, data.resetsAt), expiresAt: data.resetsAt + NOTICE_DAY_MS });
    }
    const known = new Set((before.completionLog || []).map(entry => `${entry.taskId}:${entry.cycle}:${entry.at}`));
    for (const entry of after.completionLog || []) {
      const task = after.tasks.find(task => task.id === entry.taskId);
      if (!task || entry.at < after.dailyQuestStartedAt || known.has(`${entry.taskId}:${entry.cycle}:${entry.at}`)) continue;
      events.push(notice(userId, 'daily_completed', `${key}:${entry.taskId}:${entry.cycle}`, entry.at,
        { ...data, taskId: task.id, cycle: entry.cycle, title: task.title, reward: entry.points }));
    }
    if (after.tasks.every(task => task.completed >= task.repeat) &&
      (before.dailyQuestVersion !== 1 || !before.tasks?.length || !before.tasks.every(task => task.completed >= task.repeat))) {
      const at = Math.max(...after.completionLog.filter(entry => entry.at >= after.dailyQuestStartedAt).map(entry => entry.at));
      events.push(notice(userId, 'daily_all_completed', key, at, { ...data, total: after.tasks.length }));
    }
  }
  for (const [field, kind] of [['salaryReceipts', 'salary_paid'], ['prizeReceipts', 'prize_claimed'], ['adjustmentLog', 'balance_changed']]) {
    const known = new Set((before[field] || []).map(entry => entry.id || entry.operationId));
    for (const entry of after[field] || []) if (!known.has(entry.id || entry.operationId)) {
      events.push(notice(userId, entry.spamPenalty ? 'spam_penalty' : kind, entry.id || entry.operationId, entry.claimedAt || entry.at, { ...entry }));
    }
  }
  return events;
}
export function robberyNotices(round) {
  const endReason = round.endReason || (round.timedOut ? 'timeout' : undefined);
  const events = [round.userId, round.targetId].map(userId => notice(userId, 'robbery_result', round.id, round.settledAt,
    { roundId: round.id, initiatorId: round.userId, targetId: round.targetId, game: round.game || 'rps',
      endReason,
      ...(round.game === 'mine' && endReason !== 'timeout' ? { mineCell: round.mine.cell, mineLoser: round.mine.loser } : {}),
      result: round.result, protection: round.protection }));
  if (round.protection) events.push(notice(round.targetId, 'protection_expired', round.protection.expiresAt, round.settledAt,
    { expiresAt: round.protection.expiresAt }, round.protection.expiresAt));
  return events;
}
export function protectionNotices(purchase) {
  return [notice(purchase.userId, 'protection_bought', purchase.id, purchase.purchasedAt,
    { addedDurationMs: purchase.addedDurationMs, price: purchase.price, after: purchase.after, expiresAt: purchase.protection.expiresAt, extended: !!purchase.previousExpiresAt }),
  notice(purchase.userId, 'protection_expired', purchase.protection.expiresAt, purchase.purchasedAt,
    { expiresAt: purchase.protection.expiresAt }, purchase.protection.expiresAt)];
}
export function auctionNotices(before, after, now) {
  const events = [], data = { auctionId: after.id, name: after.name, quantity: after.quantity,
    channelId: after.channelId, messageId: after.delivery.live.messageId,
    amount: after.amount, endsAt: after.endsAt, winnerId: after.settlement?.winnerId,
    reason: after.settlement?.reason, refundedUserId: before.highestBidderId, refundedAmount: after.settlement?.refundedAmount || 0 };
  if (before.status !== after.status && after.status === 'active') {
    events.push(notice(after.createdBy, 'auction_started', after.id, now, data));
  }
  if (after.status === 'active' && before.highestBidderId && before.highestBidderId !== after.highestBidderId) {
    events.push(notice(before.highestBidderId, 'auction_outbid', after.lastOperationId, now, { ...data, refundedAmount: before.amount }));
  }
  if (before.status !== after.status && ['ended', 'cancelled'].includes(after.status)) {
    for (const userId of new Set([after.createdBy, before.highestBidderId].filter(Boolean))) {
      events.push(notice(userId, `auction_${after.status}`, after.id, after.endedAt, data));
    }
  }
  return events;
}
