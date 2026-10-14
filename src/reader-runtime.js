import { normalizeReaderToken } from './auth.js';

export function readerConnectionHealthy(client, now = Date.now()) {
  if (!client?.isReady()) return false;
  // Do not infer a broken connection from a quiet voice room. v13 exposes its
  // heartbeat clock, including a stopped timer while isReady() still says true.
  for (const shard of client.ws?.shards?.values?.() || []) {
    if (Number.isFinite(shard.lastPingTimestamp) && shard.lastPingTimestamp > 0
      && now - shard.lastPingTimestamp > 120000) return false;
    if (shard.lastHeartbeatAcked === false && shard.lastPingTimestamp > 0
      && now - shard.lastPingTimestamp > 90000) return false;
  }
  return true;
}

export class ReaderRuntime {
  constructor({ token, botToken, getClient, createClient, connect, validate, credentials, activate,
    canRun = () => true, onGap = () => {}, onReady = () => {}, onError = () => {}, protect = () => {}, clock = Date.now }) {
    Object.assign(this, { token, botToken, getClient, createClient, connect, validate, credentials, activate,
      canRun, onGap, onReady, onError, protect, clock });
    this.pending = null; this.candidate = null; this.downSince = null; this.retryAt = 0;
    this.failures = 0; this.authFailed = false; this.lastSuccessAt = null; this.closed = false;
  }
  available() { return !this.closed && this.canRun(); }
  diagnostics() { return { reconnecting: !!this.pending, retryAt: this.retryAt, authFailed: this.authFailed, lastSuccessAt: this.lastSuccessAt }; }
  disconnected(code) {
    this.downSince ??= this.clock();
    if (code === 4004) this.authFailed = true;
    this.onGap();
  }
  tick() {
    if (!this.available() || this.pending) return this.pending || Promise.resolve(false);
    if (readerConnectionHealthy(this.getClient(), this.clock())) {
      this.downSince = null; this.failures = 0; this.retryAt = 0; this.authFailed = false;
      return Promise.resolve(false);
    }
    if (this.downSince === null) this.disconnected();
    // Give the SDK a chance to resume its existing session first.
    if (this.authFailed || this.clock() - this.downSince < 45000 || this.clock() < this.retryAt) return Promise.resolve(false);
    return this.replace(this.token).catch(error => {
      if (error.code === 'AUTHENTICATION_FAILED') this.authFailed = true;
      const delay = Math.min(300000, 30000 * 2 ** Math.min(this.failures++, 4));
      this.retryAt = this.clock() + delay; this.onError(error, delay);
      return false;
    });
  }
  update(raw, metadata) {
    const token = normalizeReaderToken(raw);
    if (token === this.botToken) return Promise.reject(new Error('هذا توكن البوت الرسمي؛ أدخل توكن حساب القارئ.'));
    return this.replace(token, metadata);
  }
  replace(token, metadata = null) {
    if (this.pending) return Promise.reject(new Error('جارٍ اتصال القارئ أو تحديثه. انتظر اكتمال المحاولة ثم أعد الأمر.'));
    if (!this.available()) return Promise.reject(new Error('تحديث القارئ غير متاح أثناء إيقاف الخدمة أو الريست الشامل.'));
    this.protect(token);
    const operation = async () => {
      const candidate = this.createClient(); this.candidate = candidate;
      // Candidate clients are not yet attached to application listeners.
      const ignore = () => {};
      candidate.on('error', ignore); candidate.on('shardError', ignore);
      let adopted = false;
      try {
        await this.connect(candidate, token);
        if (candidate.user?.bot) throw new Error('يلزم توكن حساب القارئ وليس توكن بوت.');
        await this.validate(candidate);
        if (!this.available()) throw new Error('أُلغي التحديث أثناء توقف الخدمة. أعد الأمر بعد تشغيلها.');
        if (metadata) await this.credentials.save(token, { ...metadata, accountId: candidate.user.id });
        if (!this.available() || !candidate.isReady()) throw new Error('انقطع الاتصال أثناء التحديث. أعد المحاولة؛ ستُقرأ آخر قيمة محفوظة عند التشغيل.');
        // Swap synchronously AFTER validation and confirmed durable save. The old
        // reader remains active throughout a failed candidate login/save.
        this.activate(candidate);
        adopted = true; this.token = token;
        this.authFailed = false; this.downSince = null; this.failures = 0; this.retryAt = 0;
        this.lastSuccessAt = this.clock();
        this.onReady();
        return true;
      } finally {
        this.candidate = null;
        if (!adopted) { try { await candidate.destroy(); } catch { /* No SDK secret output. */ } }
        // Keep error sinks on retired candidates: late rejected SDK work must
        // never become an unhandled EventEmitter error.
      }
    };
    this.pending = Promise.resolve().then(operation).finally(() => { this.pending = null; });
    return this.pending;
  }
  close() {
    this.closed = true;
    if (this.candidate) {
      try { void Promise.resolve(this.candidate.destroy()).catch(() => {}); } catch { /* Shutdown will finish cleanup. */ }
    }
  }
}
