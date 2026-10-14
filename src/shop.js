import { isId } from './config.js';

export const MAX_PRODUCTS = 100;
export const MAX_SHOP_PRICE = 1000000;
export const MAX_SHOP_STOCK = 100000;
export const CHECKOUT_TTL = 15 * 60000;

export function validateProduct(input) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const description = input.description == null ? '' : typeof input.description === 'string' ? input.description.trim() : null;
  if (!name || name.length > 80) throw new Error('اسم المنتج مطلوب وبحد أقصى 80 حرفًا.');
  if (description === null || description.length > 300) throw new Error('وصف المنتج اختياري وبحد أقصى 300 حرف.');
  if (!Number.isSafeInteger(input.price) || input.price < 1 || input.price > MAX_SHOP_PRICE) throw new Error('سعر المنتج يجب أن يكون عددًا صحيحًا من 1 إلى 1,000,000 $ 💵.');
  if (!Number.isSafeInteger(input.stock) || input.stock < 0 || input.stock > MAX_SHOP_STOCK) throw new Error('الكمية يجب أن تكون عددًا صحيحًا من 0 إلى 100,000.');
  return { name, description, price: input.price, stock: input.stock };
}

export function checkoutTime(id) {
  if (!isId(id)) throw new Error('معرف طلب الشراء غير صالح.');
  return Number(BigInt(id) >> 22n) + 1420070400000;
}

export function validatePurchase(input, now, cutoff) {
  if (!isId(input.userId) || !isId(input.productId)) throw new Error('معرف العضو أو المنتج غير صالح.');
  const openedAt = checkoutTime(input.checkoutId);
  if (openedAt <= cutoff) throw new Error('هذه القائمة أقدم من آخر ريست. افتح المتجر واضغط شراء من جديد.');
  if (openedAt > now + 5000 || now - openedAt > CHECKOUT_TTL) throw new Error('انتهت صلاحية قائمة الشراء. افتح المتجر واضغط شراء من جديد.');
  if (!Number.isSafeInteger(input.at) || input.at < openedAt - 5000 || input.at > now + 5000 || now - input.at > CHECKOUT_TTL) throw new Error('وقت طلب الشراء غير صالح. افتح قائمة شراء جديدة.');
  return { userId: input.userId, productId: input.productId, checkoutId: input.checkoutId, at: input.at };
}

export function purchaseDebit(balance, price) {
  if (![balance.tasks, balance.attendance, balance.total].every(n => Number.isSafeInteger(n) && n >= 0)
    || balance.total !== balance.tasks + balance.attendance) throw new Error('تعذر التحقق من الرصيد. راجع الإدارة قبل الشراء.');
  if (balance.total < price) throw new Error(`رصيدك ${balance.total.toLocaleString('en-US')} $ 💵؛ تحتاج ${(price - balance.total).toLocaleString('en-US')} $ 💵 إضافية لشراء هذا المنتج.`);
  const tasks = Math.min(balance.tasks, price);
  return { tasks, attendance: price - tasks };
}

export function applyPurchase(state, order) {
  if (state._id !== order.dayId || state.userId !== order.userId) throw new Error('سجل العضو لا يطابق طلب الشراء.');
  if (state.shopReceipts?.includes(order.id)) return false;
  const amounts = Object.fromEntries(['tasks', 'attendance'].map(category => [category,
    (state.shopAdjustments?.[category] || 0) - order.debit[category]]));
  if (!Object.values(amounts).every(Number.isSafeInteger)) throw new Error('خصم المتجر يتجاوز الحد الرقمي المسموح.');
  state.shopAdjustments = amounts;
  state.financialContext ||= structuredClone(order);
  state.shopReceipts ||= [];
  state.shopReceipts.push(order.id);
  return true;
}
