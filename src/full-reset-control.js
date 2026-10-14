import { ActivityGate } from './activity-gate.js';
import { ResetFence } from './reset-fence.js';
import { performFullReset, readFullReset, validateFullReset } from './full-reset-store.js';

export const RESET_RUNNING_MESSAGE = 'جارٍ الريست الشامل. البوت متوقف مؤقتًا وسيعود تلقائيًا بعد تأكيد اكتمال المسح.';
export class FullResetControl {
  constructor({ store, service, runtimeControl, clock = Date.now, retryMs = 5000, onStopped = () => {}, onResumed = () => {}, onError = () => {} }) {
    Object.assign(this, { store, service, runtimeControl, clock, retryMs, onStopped, onResumed, onError });
    if (!store.fence) { store.fence = new ResetFence(); store.db = store.fence.wrap(store.db); }
    this.running = null; this.request = null; this.timer = null; this.closed = false;
  }
  background(callback) {
    try { void Promise.resolve(callback()).catch(this.onError); } catch (error) { this.onError(error); }
  }
  start(request, onCompleted = () => {}) {
    validateFullReset(request);
    if (this.request) return Promise.reject(new Error(RESET_RUNNING_MESSAGE));
    this.request = request; this.onCompleted = onCompleted;
    this.service.resetting = true; this.service.paused = true;
    this.store.fence.stop();
    // A stale Discord lookup must not keep every new command behind its old gate.
    // Its captured generation can no longer mutate MongoDB or enter service work.
    this.service.gate = new ActivityGate(operation => this.store.fence.bind(operation));
    this.onStopped();
    return this.attempt();
  }
  attempt(resumeHooks = true) {
    if (this.running) return this.running;
    const execute = () => this.store.fence.control(async () => {
      await this.store.fence.drain();
      const result = await performFullReset(this.store, this.request, this.clock);
      if (!result.alreadyCompleted) {
        this.store.resetAllAt = 0; this.store.memberResetAt = new Map(); this.store.scopedResetCutoffs = new Map();
      }
      this.store.rememberReset(result);
      this.store.walletRevision = (this.store.walletRevision || 0) + 1;
      this.service.blocked = false; this.service.resumedAt = Math.max(this.service.resumedAt || 0, result.cutoff);
      this.service.resetting = false; this.service.paused = false;
      this.store.fence.resume(); this.request = null;
      if (resumeHooks) this.background(() => this.onResumed());
      this.background(() => this.onCompleted?.(result));
      return result;
    });
    const work = this.runtimeControl ? this.runtimeControl.exclusive(execute) : Promise.resolve().then(execute);
    this.running = work.catch(cause => {
      this.service.resetting = true; this.service.paused = true;
      if (!this.closed && resumeHooks) {
        this.timer = setTimeout(() => { this.timer = null; this.attempt().catch(this.onError); }, this.retryMs);
        this.timer.unref?.();
      }
      throw new Error('لم يتأكد اكتمال الريست بسبب تأخر الاتصال. البوت متوقف مؤقتًا وستُعاد المحاولة تلقائيًا؛ لن يعود للعمل قبل اكتمال المسح.', { cause });
    }).finally(() => { this.running = null; });
    return this.running;
  }
  async recover() {
    const record = await this.store.fence.control(() => readFullReset(this.store));
    if (!record?.pending) return false;
    this.request = record; this.service.resetting = true; this.service.paused = true;
    this.store.fence.stop();
    // Called before legacy financial recovery, so discarded journals never recreate old balances.
    await this.attempt(false);
    return true;
  }
  close() { this.closed = true; clearTimeout(this.timer); }
}
