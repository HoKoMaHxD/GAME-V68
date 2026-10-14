import { randomInt } from 'node:crypto';
import { isId } from './config.js';
import { requireBankChannel } from './bank.js';
import { purchaseDebit } from './shop.js';

export const MINI_COOLDOWN = 20 * 60000;
export const MINI_TTL = 2 * 60000;

export const COLOR_SIZE = 9;
export const COLORS = ['🟪', '🟨', '🟫', '🟦', '🟥'];
export const MINI_KINDS = ['colors', 'dice'];
export function flood(board, color) {
  if (!Number.isInteger(color) || color < 0 || color >= COLORS.length) throw new Error('اختر لونًا صالحًا.');
  const next = [...board], old = next[0];
  if (old === color) return next;
  const queue = [0], seen = new Set([0]);
  for (let at = 0; at < queue.length; at++) {
    const i = queue[at]; next[i] = color;
    const x = i % COLOR_SIZE, y = Math.floor(i / COLOR_SIZE);
    for (const j of [x ? i - 1 : -1, x < COLOR_SIZE - 1 ? i + 1 : -1, y ? i - COLOR_SIZE : -1,
      y < COLOR_SIZE - 1 ? i + COLOR_SIZE : -1]) {
      if (j >= 0 && !seen.has(j) && board[j] === old) { seen.add(j); queue.push(j); }
    }
  }
  return next;
}
function regionSize(board) {
  const seen = new Set([0]), queue = [0];
  for (let at = 0; at < queue.length; at++) {
    const i = queue[at], x = i % COLOR_SIZE, y = Math.floor(i / COLOR_SIZE);
    for (const j of [x ? i - 1 : -1, x < COLOR_SIZE - 1 ? i + 1 : -1, y ? i - COLOR_SIZE : -1,
      y < COLOR_SIZE - 1 ? i + COLOR_SIZE : -1]) {
      if (j >= 0 && !seen.has(j) && board[j] === board[0]) { seen.add(j); queue.push(j); }
    }
  }
  return seen.size;
}
// Bounded beam search produces an actual legal solution (not an asserted optimum).
// Every retained move expands the region, so termination needs at most 80 moves.
export function solveColors(board) {
  let beam = [{ board: [...board], path: [], size: regionSize(board) }];
  for (let depth = 0; depth <= COLOR_SIZE ** 2; depth++) {
    const solved = beam.find(node => node.size === board.length);
    if (solved) return solved.path;
    const next = new Map();
    for (const node of beam) for (let color = 0; color < COLORS.length; color++) {
      if (color === node.board[0]) continue;
      const changed = flood(node.board, color), size = regionSize(changed);
      if (size <= node.size) continue;
      const key = changed.join('');
      if (!next.has(key)) next.set(key, { board: changed, size, path: [...node.path, color] });
    }
    beam = [...next.values()].sort((a, b) => b.size - a.size).slice(0, 32);
  }
  throw new Error('تعذر تجهيز شبكة قابلة للحل. حاول مجددًا.');
}

export function miniMoney(balance, outcome, percent) {
  purchaseDebit(balance, 0);
  if (!['win', 'loss', 'tie'].includes(outcome) || !Number.isInteger(percent) || percent < 5 || percent > 10) throw new Error('نتيجة اللعبة غير صالحة.');
  const amount = outcome === 'tie' ? 0 : Number(BigInt(balance.total) * BigInt(percent) / 100n);
  const debit = outcome === 'loss' ? purchaseDebit(balance, amount) : { tasks: 0, attendance: 0 };
  const delta = outcome === 'win' ? amount : -amount;
  if (!Number.isSafeInteger(balance.total + delta) || !Number.isSafeInteger(balance.tasks + delta)) throw new Error('الرصيد يتجاوز الحد الرقمي.');
  return { outcome, percent, amount, before: balance.total, after: balance.total + delta,
    amounts: outcome === 'win' ? { tasks: amount, attendance: 0 } : { tasks: -debit.tasks, attendance: -debit.attendance } };
}

// Every board step and final balance delta share a single atomic day write.
// The existing economy gate/worker lease also serialize purchases, resets and robberies.
export class MiniGames {
  constructor(service, day) { this.service = service; this.store = service.store; this.day = day; }
  latest(userId, kind) { return this.store.latestMiniGame(userId, kind); }
  async save(day, round, result = null) {
    await this.store.requireLease(this.service.clock());
    try {
      const saved = await this.store.mutateDay(day._id, draft => {
        const old = draft.miniGames?.[round.kind];
        if (old?.id === round.id && old.revision >= round.revision) return false;
        if (result) {
          draft.miniAdjustments ||= { tasks: 0, attendance: 0 };
          for (const key of ['tasks', 'attendance']) {
            const next = draft.miniAdjustments[key] + result.amounts[key];
            if (!Number.isSafeInteger(next)) throw new Error('الرصيد يتجاوز الحد الرقمي.');
            draft.miniAdjustments[key] = next;
          }
          (draft.miniReceipts ||= []).push({ id: round.id, kind: round.kind, at: round.settledAt, ...result });
        }
        (draft.miniGames ||= {})[round.kind] = structuredClone(round);
        draft.miniDirty = Object.values(draft.miniGames).some(r => r.messageId && r.displayRevision !== r.revision);
        return true;
      });
      return saved.miniGames[round.kind];
    } catch (cause) {
      const saved = await this.store.getDay(day._id).catch(() => null);
      const verified = saved?.miniGames?.[round.kind];
      if (verified?.id === round.id && verified.revision >= round.revision) return verified;
      this.service.blocked = true;
      throw new Error('تعذر تأكيد حفظ اللعبة. أعد تشغيل الخدمة للتحقق دون تكرار الخصم.', { cause });
    }
  }
  async open(input, eligible, choose = randomInt) {
    const member = isId(input.userId) && await eligible(input.userId);
    return this.service.gate.exclusive(async () => {
      this.service.assertActive(); const now = this.service.clock();
      if (!MINI_KINDS.includes(input.kind) || ![input.id, input.userId, input.channelId].every(isId)
        || !Number.isSafeInteger(input.at) || input.at > now + 5000 || now - input.at > 900000
        || input.at <= this.service.bankCutoff(input.userId)) throw new Error('طلب اللعبة غير صالح؛ اكتب الأمر مجددًا.');
      const bank = requireBankChannel((await this.store.settings())?.bank, input.channelId);
      if (!member) throw new Error('اللعبة متاحة لأعضاء سيرفر الكلان فقط.');
      await this.store.requireLease(now);
      let previous = await this.latest(input.userId, input.kind);
      let round = previous?.miniGames?.[input.kind];
      if (round?.status === 'open') round = await this.advance(previous, round, { timeout: true }, bank);
      if (round?.id === input.id || (round?.status === 'open' && round.createdAt > this.service.bankCutoff(input.userId))) return round;
      if (round && now < round.nextAt) return { status: 'cooldown', kind: input.kind, nextAt: round.nextAt };
      const balance = await this.store.totals(input.userId, 'all', now);
      if (balance.total <= 0) throw new Error('تحتاج رصيدًا أكبر من صفر للعب.');
      const state = await this.day(input.userId, now);
      const percent = choose(5, 11);
      if (!Number.isInteger(percent) || percent < 5 || percent > 10) throw new Error('تعذر تحديد نسبة اللعبة.');
      const board = input.kind === 'colors' ? Array.from({ length: COLOR_SIZE ** 2 }, () => choose(0, COLORS.length)) : null;
      if (board) {
        if (board.some(n => !Number.isInteger(n) || n < 0 || n >= COLORS.length)) throw new Error('تعذر إنشاء شبكة الألوان.');
        if (board.every(n => n === board[0])) board[board.length - 1] = (board[0] + 1) % COLORS.length;
      }
      const solution = board ? solveColors(board) : null;
      const margin = board ? choose(1, 4) : 0;
      if (board && (!Number.isInteger(margin) || margin < 1 || margin > 3)) throw new Error('تعذر تحديد عدد المحاولات.');
      return this.save(state, { id: input.id, kind: input.kind, userId: input.userId, channelId: input.channelId,
        createdAt: now, expiresAt: now + MINI_TTL, nextAt: now + MINI_COOLDOWN, percent,
        board, maxMoves: solution ? solution.length + margin : null, estimatedMoves: solution?.length || null,
        moves: 0, revision: 0, status: 'open', delivered: false, displayRevision: -1,
        author: input.author || { name: 'عضو الكلان' } });
    });
  }
  async advance(day, saved, input, bank, choose = randomInt) {
    if (saved.status !== 'open') return saved;
    const round = structuredClone(saved), now = this.service.clock();
    if (round.createdAt <= this.service.bankCutoff(round.userId) || bank.channelId !== round.channelId) {
      round.status = 'cancelled'; round.revision++; return this.save(day, round);
    }
    let outcome;
    if (now >= round.expiresAt) {
      if (!round.delivered && input.timeout) { round.status = 'cancelled'; round.revision++; return this.save(day, round); }
      outcome = 'loss'; round.endReason = 'timeout';
    } else if (input.timeout) return saved;
    else {
      if (input.revision !== round.revision) return saved;
      round.delivered = true;
      if (round.kind === 'dice') {
        if (input.move !== 'roll') throw new Error('اضغط رمي النرد.');
        round.playerDie = choose(1, 7); round.botDie = choose(1, 7);
        if (![round.playerDie, round.botDie].every(n => Number.isInteger(n) && n >= 1 && n <= 6)) throw new Error('تعذر رمي النرد.');
        outcome = round.playerDie > round.botDie ? 'win' : round.playerDie < round.botDie ? 'loss' : 'tie';
      } else {
        const color = Number(input.move);
        if (!/^[0-4]$/.test(String(input.move))) throw new Error('اختر لونًا صالحًا.');
        if (round.board[0] === color) return saved;
        round.board = flood(round.board, color); round.moves++;
        if (round.board.every(n => n === round.board[0])) outcome = 'win';
        else if (round.moves >= round.maxMoves) outcome = 'loss';
      }
    }
    round.revision++;
    let result = null;
    if (outcome) {
      const balance = await this.store.totals(round.userId, 'all', now);
      result = miniMoney(balance, outcome, round.percent);
      round.status = 'settled'; round.result = result; round.settledAt = now;
    }
    return this.save(day, round, result);
  }
  async play(input, eligible, choose = randomInt) {
    const member = isId(input.userId) && await eligible(input.userId);
    return this.service.gate.exclusive(async () => {
      this.service.assertActive();
      if (!MINI_KINDS.includes(input.kind) || ![input.id, input.userId, input.channelId].every(isId)) throw new Error('زر اللعبة غير صالح.');
      if (!member) throw new Error('اللعبة متاحة لأعضاء سيرفر الكلان فقط.');
      const day = await this.latest(input.userId, input.kind), round = day?.miniGames?.[input.kind];
      if (!round || round.id !== input.id || round.channelId !== input.channelId) throw new Error('هذه اللعبة قديمة. اكتب الأمر لبدء لعبة جديدة.');
      this.requireMessage(round, input.messageId);
      const bank = (await this.store.settings())?.bank || {};
      return this.advance(day, round, input, bank, choose);
    });
  }
  requireMessage(round, messageId) {
    if (messageId && round.messageId && messageId !== round.messageId) {
      throw new Error(`أكمل الجولة من رسالتها الأصلية: https://discord.com/channels/${this.service.config.clanGuildId}/${round.channelId}/${round.messageId}`);
    }
  }
  bind(round, messageId) {
    return this.service.gate.exclusive(async () => {
      this.service.assertActive();
      const day = await this.latest(round.userId, round.kind), current = day?.miniGames?.[round.kind];
      if (!current || current.id !== round.id) return;
      await this.store.requireLease(this.service.clock());
      return this.store.mutateDay(day._id, draft => {
        const r = draft.miniGames?.[round.kind];
        if (r?.id !== round.id || (r.messageId && r.messageId !== messageId)) return false;
        if (r.delivered && r.messageId === messageId) return false;
        r.delivered = true; r.messageId = messageId; draft.miniDirty = true; return true;
      });
    });
  }
  markDisplayed(round) {
    return this.service.gate.exclusive(async () => {
      this.service.assertActive(); await this.store.requireLease(this.service.clock());
      const day = await this.latest(round.userId, round.kind);
      if (!day) return;
      await this.store.mutateDay(day._id, draft => {
        const current = draft.miniGames?.[round.kind];
        if (current?.id !== round.id || current.revision !== round.revision) return false;
        current.displayRevision = round.revision;
        draft.miniDirty = Object.values(draft.miniGames).some(r => r.messageId && r.displayRevision !== r.revision); return true;
      });
    });
  }
  pending() { return this.store.pendingMiniGames(); }
  get kinds() { return MINI_KINDS; }
  maintenanceDue(round, bank, now) {
    return round.createdAt <= this.service.bankCutoff(round.userId) || bank.channelId !== round.channelId
      || now >= round.expiresAt;
  }
  async expire() {
    this.service.assertActive();
    const pending = await this.pending();
    if (!pending.some(day => this.kinds.some(kind => day.miniGames?.[kind]?.status === 'open'))) return;
    const bank = (await this.store.settings())?.bank || {};
    for (const candidate of pending) for (const kind of this.kinds) {
      const round = candidate.miniGames?.[kind];
      if (round?.status !== 'open' || !this.maintenanceDue(round, bank, this.service.clock())) continue;
      await this.service.gate.exclusive(async () => {
        this.service.assertActive();
        const day = await this.store.getDay(candidate._id), current = day?.miniGames?.[kind];
        if (current?.id !== round.id || current.status !== 'open') return;
        await this.advance(day, current, { timeout: true }, (await this.store.settings())?.bank || {});
      });
    }
  }
}
