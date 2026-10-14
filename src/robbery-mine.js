// Both hidden choices are committed before the board is shown. The bot follows
// an independently shuffled order, skipping used cells; it never avoids the mine.
export const MINE_CELLS = Object.freeze(Array.from({ length: 9 }, (_, i) => i + 1));
const draw = (choose, min, max) => {
  const n = choose(min, max);
  if (!Number.isInteger(n) || n < min || n >= max) throw new Error('تعذر تجهيز لعبة اللغم.');
  return n;
};

export function newMine(choose) {
  const cell = draw(choose, 1, 10), botOrder = [...MINE_CELLS];
  for (let i = botOrder.length - 1; i > 0; i--) {
    const j = draw(choose, 0, i + 1);
    [botOrder[i], botOrder[j]] = [botOrder[j], botOrder[i]];
  }
  return { cell, botOrder, picks: [], revision: 0, receipts: [], loser: null };
}

export function mineOutcome(round) {
  if (!['player', 'bot'].includes(round.mine?.loser)) throw new Error('لعبة اللغم لم تنتهِ بعد.');
  return round.mine.loser === 'bot' ? 'win' : 'loss';
}

export function advanceMine(round, action) {
  if (round.game !== 'mine' || round.status !== 'open') throw new Error('هذا الزر لا يخص لعبة لغم مفتوحة.');
  if (!MINE_CELLS.includes(action.cell) || !Number.isInteger(action.revision) || action.revision < 0 || action.revision > 5) {
    throw new Error('اختر رقمًا متاحًا من 1 إلى 9.');
  }
  if (round.mine.receipts.includes(action.resolutionId)) return { ...round, duplicate: true };
  // Two presses from the same board must not play two turns, even with different
  // Discord interaction IDs or after a restart. Return the current board instead.
  if (action.revision !== round.mine.revision) return { ...round, stale: true };
  const next = structuredClone(round), m = next.mine;
  if (m.loser || m.picks.some(p => p.cell === action.cell)) throw new Error('هذا الرقم مكشوف. اختر رقمًا آخر.');
  const pick = (actor, cell) => {
    m.picks.push({ actor, cell });
    if (cell === m.cell) m.loser = actor;
  };
  pick('player', action.cell);
  if (!m.loser) {
    const cell = m.botOrder.find(n => !m.picks.some(p => p.cell === n));
    if (!MINE_CELLS.includes(cell)) throw new Error('تعذر استكمال دور البوت في لعبة اللغم.');
    pick('bot', cell);
  }
  m.revision++;
  m.receipts.push(action.resolutionId);
  return next;
}
