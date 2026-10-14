import { isId } from './config.js';
import { validateAppearancePatch } from './appearance.js';

export const AUCTION_ROLE_ID = '1516418133131268187';
export const AUCTION_DURATION_MS = 5 * 60000;
export const AUCTION_LATE_MS = 15000;
export const AUCTION_EXTENSION_MS = 30000;
export const MAX_AUCTION_AMOUNT = 1000000000;
export const MAX_OPEN_AUCTIONS = 50;
export const auctionTerminal = a => ['ended', 'cancelled'].includes(a.status);
export const latinDigits = value => String(value ?? '').trim().replace(/[٠-٩۰-۹]/g,
  c => String('٠١٢٣٤٥٦٧٨٩'.includes(c) ? '٠١٢٣٤٥٦٧٨٩'.indexOf(c) : '۰۱۲۳۴۵۶۷۸۹'.indexOf(c)));

export function auctionStartTime(date, time) {
  date = latinDigits(date); time = latinDigits(time);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error('اكتب التاريخ YYYY-MM-DD والوقت HH:MM بنظام 24 ساعة وتوقيت السعودية.');
  }
  const at = Date.parse(`${date}T${time}:00+03:00`);
  if (!Number.isFinite(at) || new Date(at + 10800000).toISOString().slice(0, 16) !== `${date}T${time}`) {
    throw new Error('تاريخ بدء المزاد غير صحيح.');
  }
  return at;
}

export function auctionIncrement(value) {
  const text = latinDigits(value);
  const amount = Number(text);
  if (!/^\d{1,10}$/.test(text) || !Number.isSafeInteger(amount) || amount < 1 || amount > MAX_AUCTION_AMOUNT) {
    throw new Error('اكتب مبلغ زيادة صحيحًا موجبًا بدون كسور أو فواصل، بحد أقصى 1,000,000,000.');
  }
  return amount;
}

export function newAuction(input, now) {
  if (![input.id, input.createdBy, input.channelId].every(isId)) throw new Error('معرف إنشاء المزاد غير صالح.');
  const name = String(input.name || '').trim(), description = String(input.description || '').trim();
  if (!name || name.length > 80 || /[\r\n\u0000-\u001f]/.test(name)) throw new Error('اسم المنتج من 1 إلى 80 حرفًا في سطر واحد.');
  if (!description || description.length > 1000) throw new Error('وصف المنتج مطلوب وبحد أقصى 1000 حرف.');
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 100000) throw new Error('العدد من 1 إلى 100,000؛ كامل الكمية صفقة واحدة للفائز.');
  if (!Number.isSafeInteger(input.startPrice) || input.startPrice < 1 || input.startPrice > MAX_AUCTION_AMOUNT) throw new Error('مبلغ البداية من 1 إلى 1,000,000,000.');
  if (!Number.isSafeInteger(input.startsAt) || input.startsAt <= now || input.startsAt > now + 365 * 86400000) throw new Error('حدد موعدًا قادمًا للمزاد خلال سنة من الآن بتوقيت السعودية.');
  const imageUrl = validateAppearancePatch({ imageUrl: input.imageUrl }).imageUrl;
  if (!imageUrl) throw new Error('صورة المنتج مطلوبة.');
  return { id: input.id, createdBy: input.createdBy, channelId: input.channelId, roleId: AUCTION_ROLE_ID,
    name, description, quantity: input.quantity, imageUrl, startPrice: input.startPrice, startsAt: input.startsAt,
    createdAt: now, revision: 0, status: 'scheduled', startedAt: null, endsAt: null,
    amount: input.startPrice, highestBidderId: null, hold: null, bidCount: 0, extensions: 0,
    delivery: { complete: false, upcoming: { attempts: 0 }, live: { attempts: 0 }, result: { attempts: 0 } } };
}

export function bidAmount(auction, { increment, opening, expectedAmount }, now) {
  if (auction.status !== 'active' || now < auction.startedAt || now >= auction.endsAt) throw new Error('المزاد لم يبدأ أو انتهى وقته؛ لا يمكن قبول المزايدة.');
  if (expectedAmount !== undefined && expectedAmount !== auction.amount) throw new Error('تغير السوم أثناء كتابة المبلغ. افتح زر مزايدة من جديد لمراجعة السوم الحالي.');
  if (opening && auction.highestBidderId) throw new Error('سُجلت مزايدة بالفعل؛ استخدم أزرار الزيادة.');
  if (!opening && (!Number.isSafeInteger(increment) || increment < 1)) throw new Error('مبلغ الزيادة يجب أن يكون عددًا صحيحًا موجبًا.');
  const amount = opening ? auction.startPrice : auction.amount + increment;
  if (!Number.isSafeInteger(amount) || amount > MAX_AUCTION_AMOUNT) throw new Error('السوم يتجاوز الحد الأعلى 1,000,000,000.');
  return amount;
}

// Isolated wallet adjustments preserve earned task/activity counters. Each leg
// has a durable receipt, including when the MongoDB acknowledgement is lost.
export function applyAuctionLeg(state, leg) {
  if (state._id !== leg.dayId || state.userId !== leg.userId) throw new Error('سجل الرصيد لا يطابق عملية المزاد.');
  if (state.auctionReceipts?.includes(leg.id)) return false;
  const amounts = Object.fromEntries(['tasks', 'attendance'].map(key => [key,
    (state.auctionAdjustments?.[key] || 0) + leg.amounts[key]]));
  if (!Object.values(amounts).every(Number.isSafeInteger)) throw new Error('عملية المزاد تتجاوز الحد الرقمي للرصيد.');
  state.auctionAdjustments = amounts;
  state.financialContext ||= structuredClone(leg);
  (state.auctionReceipts ||= []).push(leg.id);
  return true;
}
