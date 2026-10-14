import { ActivityGate } from './activity-gate.js';

// Every writer of a game's Discord message must use the same queue, including
// handlers created without a manager (text commands and tests use that path).
const gates = new WeakMap();
export function gameDisplays(game) {
  if (!gates.has(game)) gates.set(game, new ActivityGate());
  return gates.get(game);
}

export const STALE_GAME_NOTICE = 'تحدّثت اللوحة. لم تُحسب هذه الضغطة؛ اختر من الأزرار المحدّثة.';
export class StaleGameViewError extends Error {
  constructor(round, message = 'تغيّرت اللوحة؛ انتظر تحديثها واضغط من جديد.') {
    super(message);
    this.code = 'GAME_STALE_VIEW';
    this.round = round;
  }
}

export async function playGameAction(game, input, eligible) {
  try { return { round: await game.act(input, eligible), stale: false }; }
  catch (error) {
    if (error.code !== 'GAME_STALE_VIEW') throw error;
    // Repair the controls without replaying a move against a different turn.
    return { round: error.round, stale: true };
  }
}

// A Discord fetch/edit can wait on a rate limit. It must not stop the next
// timeout tick or updates for every other player. Jobs stay bounded and each
// game has at most one background update in flight.
export class GameDisplayJobs {
  constructor(onError, limit = 4) { this.onError = onError; this.limit = limit; this.jobs = new Map(); }
  add(key, operation) {
    if (this.jobs.has(key) || this.jobs.size >= this.limit) return;
    const job = Promise.resolve().then(operation).catch(error => this.onError(error))
      .finally(() => this.jobs.delete(key));
    // Also observe a reporting callback that throws, without discarding it
    // from drain() while it is still running.
    void job.catch(() => {});
    this.jobs.set(key, job);
  }
  async drain() { await Promise.allSettled([...this.jobs.values()]); }
}
