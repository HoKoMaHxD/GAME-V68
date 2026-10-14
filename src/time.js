// Riyadh is UTC+03:00 year-round. Explicit arithmetic avoids host time-zone drift.
export const DAY_MS = 86400000;
export const OFFSET_MS = 3 * 3600000;
export const dayKey = at => new Date(Number(at) + OFFSET_MS).toISOString().slice(0, 10);
export const dayStart = key => Date.parse(`${key}T00:00:00+03:00`);
export const nextReset = at => dayStart(dayKey(at)) + DAY_MS;

export function periodStart(period, at, weekStart = 0) {
  const key = dayKey(at);
  if (period === 'daily') return key;
  if (period === 'monthly') return `${key.slice(0, 7)}-01`;
  if (period === 'weekly') {
    const date = new Date(`${key}T12:00:00Z`);
    const days = (date.getUTCDay() - weekStart + 7) % 7;
    return dayKey(dayStart(key) - days * DAY_MS);
  }
  if (period === 'all') return '0000-00-00';
  throw new Error('فترة غير صحيحة.');
}

export function splitDays(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const result = [];
  for (let start = from; start < to;) {
    const end = Math.min(to, nextReset(start));
    result.push({ day: dayKey(start), from: start, to: end });
    start = end;
  }
  return result;
}
