// Recover under the SAME wallet gate as transfers. Never just clear blocked:
// an uncertain debit/credit must finish from its durable journal first.
export class AccountingRecovery {
  constructor({ service, store, canRun = () => true, onReady = () => {}, onError = () => {}, clock = Date.now }) {
    Object.assign(this, { service, store, canRun, onReady, onError, clock });
    this.pending = null; this.retryAt = 0; this.failures = 0; this.lastSuccessAt = null;
  }
  run() {
    if (this.pending) return this.pending;
    if (!this.service.blocked || !this.canRun() || this.clock() < this.retryAt) return Promise.resolve(false);
    this.pending = this.service.gate.exclusive(async () => {
      if (!this.canRun() || !this.service.blocked) return false;
      const requireActiveLease = async () => {
        this.store.fence?.assertCurrent();
        if (!this.canRun()) throw Object.assign(new Error('Recovery cancelled'), { code: 'RESET_INTERRUPTED' });
        await this.store.requireLease(this.clock());
      };
      const recoveries = [
        () => this.store.shop.recover(this.clock()), () => this.store.robbery.recover(this.clock()),
        ...['shipGame', 'boxesGame', 'dotGame', 'numbersGame', 'minesGame', 'buttonGame', 'xo']
          .map(name => () => this.service[name].recover()),
        () => this.store.auctions.recover(this.clock()), () => this.store.initializeResets(this.clock())
      ];
      for (const recover of recoveries) { await requireActiveLease(); await recover(); }
      await requireActiveLease();
      this.service.blocked = false;
      this.failures = 0; this.retryAt = 0; this.lastSuccessAt = this.clock();
      this.onReady();
      return true;
    }).catch(error => {
      if (error.code !== 'RESET_INTERRUPTED') {
        const delay = Math.min(120000, 10000 * 2 ** Math.min(this.failures++, 4));
        this.retryAt = this.clock() + delay; this.onError(error, delay);
      }
      return false;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
  diagnostics() { return { running: !!this.pending, retryAt: this.retryAt, lastSuccessAt: this.lastSuccessAt }; }
}
