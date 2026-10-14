import { isId } from './config.js';
import { MAX_POINT_ADJUSTMENT } from './point-adjustments.js';

export const DEFAULT_SPAM_SETTINGS = Object.freeze({ windowMs: 3000, amount: 500, messageCount: 2 });
export const MAX_SPAM_MESSAGES = 1000;
export const MAX_SPAM_SECONDS = 3600;
export const MAX_SPAM_AMOUNT = MAX_POINT_ADJUSTMENT;

export function readSpamSettings(saved = {}) {
  return {
    messageCount: Number.isSafeInteger(saved?.messageCount) && saved.messageCount >= 2 && saved.messageCount <= MAX_SPAM_MESSAGES
      ? saved.messageCount : DEFAULT_SPAM_SETTINGS.messageCount,
    windowMs: Number.isSafeInteger(saved?.windowMs) && saved.windowMs >= 1000
      && saved.windowMs <= MAX_SPAM_SECONDS * 1000 && saved.windowMs % 1000 === 0
      ? saved.windowMs : DEFAULT_SPAM_SETTINGS.windowMs,
    amount: Number.isSafeInteger(saved?.amount) && saved.amount >= 1 && saved.amount <= MAX_SPAM_AMOUNT
      ? saved.amount : DEFAULT_SPAM_SETTINGS.amount
  };
}

export function validateSpamChange(input) {
  if (!isId(input.actorId) || !isId(input.operationId)) throw new Error('معرف المسؤول أو أمر الخصم غير صالح.');
  const fields = {};
  if (input.messageCount != null) {
    if (!Number.isSafeInteger(input.messageCount) || input.messageCount < 2 || input.messageCount > MAX_SPAM_MESSAGES) {
      throw new Error(`عدد الرسائل يجب أن يكون عددًا صحيحًا من 2 إلى ${MAX_SPAM_MESSAGES}.`);
    }
    fields.messageCount = input.messageCount;
  }
  if (input.seconds != null) {
    if (!Number.isSafeInteger(input.seconds) || input.seconds < 1 || input.seconds > MAX_SPAM_SECONDS) {
      throw new Error(`مدة السبام يجب أن تكون عددًا صحيحًا من 1 إلى ${MAX_SPAM_SECONDS} ثانية.`);
    }
    fields.windowMs = input.seconds * 1000;
  }
  if (input.amount != null) {
    if (!Number.isSafeInteger(input.amount) || input.amount < 1 || input.amount > MAX_SPAM_AMOUNT) {
      throw new Error(`مبلغ الخصم يجب أن يكون عددًا صحيحًا من 1 إلى ${MAX_SPAM_AMOUNT.toLocaleString('en-US')}.`);
    }
    fields.amount = input.amount;
  }
  if (!Object.keys(fields).length) throw new Error('حدد عدد الرسائل أو المدة أو المبلغ لتعديل خصم السبام.');
  return fields;
}

export function spamDuration(windowMs) {
  const seconds = windowMs / 1000;
  return `${seconds.toLocaleString('en-US')} ${seconds >= 3 && seconds <= 10 ? 'ثوانٍ' : 'ثانية'}`;
}
