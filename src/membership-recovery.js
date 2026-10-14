const RETRY_BASE_MS = 30000;
const RETRY_MAX_MS = 300000;
const READ_RETRY_CODES = new Set(['ECONNABORTED', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
const TRANSIENT_CODES = new Set(['GuildMembersTimeout', 'GUILD_MEMBERS_TIMEOUT',
  'MEMBERSHIP_REQUEST_TIMEOUT', 'MEMBER_RESPONSE_INCOMPLETE',
  'AbortError', 'TimeoutError', ...READ_RETRY_CODES]);

export function membershipErrorCode(error) {
  const seen = new Set(), chain = [];
  while (error && !seen.has(error)) {
    seen.add(error); chain.push(error);
    error = error.cause;
  }
  // An explicit denial/rate limit takes precedence over a nested socket error.
  const denied = chain.find(e => [10007, 50001, 50013].includes(Number(e.code))
    || (e.status >= 400 && e.status < 500 && e.status !== 429));
  if (denied) return [10007, 50001, 50013].includes(Number(denied.code)) ? Number(denied.code) : denied.status;
  if (chain.some(e => e.status === 429 || e.name === 'GatewayRateLimitError')) return 429;
  for (const entry of chain) {
    if (TRANSIENT_CODES.has(entry.code)) return entry.code;
    if (TRANSIENT_CODES.has(entry.name)) return entry.name;
    if (/^(?:GUILD_MEMBERS_TIMEOUT|GuildMembersTimeout)$/.test(entry.message || '')) return entry.message;
    if (entry.status >= 500 && entry.status < 600) return entry.status;
  }
  return chain.find(e => typeof e.code === 'string' || Number.isInteger(e.code))?.code || 'MEMBERSHIP_LOAD_FAILED';
}

export function transientMembershipError(error) {
  const code = membershipErrorCode(error);
  return TRANSIENT_CODES.has(code) || code === 429 || (Number.isInteger(code) && code >= 500 && code < 600);
}

export function retryableMembershipReadError(error) {
  const code = membershipErrorCode(error);
  // Only retry settled read failures, never our deadline while its original
  // SDK request may still be pending, nor a denied/rate-limited request.
  return READ_RETRY_CODES.has(code) || (Number.isInteger(code) && code >= 500 && code < 600);
}

// Both the Gateway resume event and the voice timer use this one attempt.
// Backoff is checked by those callers; no sleeping job holds up a voice tick.
export class MembershipRecovery {
  constructor({ membership, canRun = () => true, beforeLoad = () => {}, onError = () => {}, onReady = () => {}, clock = Date.now }) {
    Object.assign(this, { membership, canRun, beforeLoad, onError, onReady, clock });
    this.pending = null;
    this.failures = 0;
    this.retryAt = 0;
  }

  run({ required = false } = {}) {
    if (!this.canRun()) return Promise.resolve(false);
    if (this.membership.ready) return Promise.resolve(true);
    if (this.pending) return this.pending;
    if (this.clock() < this.retryAt) return Promise.resolve(false);
    this.pending = Promise.resolve().then(() => {
      if (!this.canRun()) return false;
      this.beforeLoad();
      return this.membership.load();
    }).then(ready => {
      if (ready) { this.failures = 0; this.retryAt = 0; this.onReady(); }
      return ready;
    }).catch(error => {
      if (error.code === 'RESET_INTERRUPTED') return false;
      // Invalid IDs, permissions and configuration still fail fast at startup.
      if (required && !transientMembershipError(error)) throw error;
      const delayMs = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(this.failures++, 4));
      this.retryAt = this.clock() + delayMs;
      this.onError(error, delayMs);
      return false;
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
}
