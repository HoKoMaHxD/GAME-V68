import { eligibleVoice } from './domain.js';

export class VoiceTracker {
  constructor({ service, guildId, onError = () => {}, onGap = () => {} }) {
    Object.assign(this, { service, guildId, onError, onGap });
    this.snapshot = []; this.rule = null; this.last = null;
    this.epoch = 0; this.tail = Promise.resolve();
    // Only intervals captured while eligibility was known are queued. Per-user
    // ordering plus the stored voiceUntil watermark make retries idempotent.
    this.pending = new Map();
    this.memberWrites = new Map();
    this.flushes = new Set();
    this.queued = null;
  }
  enqueue(action) {
    const epoch = this.epoch;
    // Many observations may arrive while a save is busy. One following pass
    // captures them all; do not create a growing promise chain per event.
    if (this.queued?.epoch === epoch) return this.queued.operation;
    const queued = { epoch };
    const operation = this.tail.then(() => {
      if (this.queued === queued) this.queued = null;
      return epoch === this.epoch ? action() : undefined;
    });
    queued.operation = operation; this.queued = queued;
    this.tail = operation.catch(error => {
      if (epoch === this.epoch && !error.voiceRetryable) this.drop();
      this.onError(error);
    });
    return operation;
  }
  transition(snapshot, rule, memberIds, at) {
    this.observe(snapshot, rule, memberIds, at);
    return this.enqueue(() => this.persist());
  }
  observe(snapshot, rule, memberIds, at, { onlyChanges = false } = {}) {
    if (!Number.isFinite(at)) throw new TypeError('Invalid voice observation time');
    if (this.last !== null && at < this.last) return;
    const eligible = structuredClone(eligibleVoice(snapshot, rule, memberIds));
    // Streaming/video and mute changes that do not affect eligibility need no
    // extra intervals. The independent 15-second sample still captures time.
    if (onlyChanges && this.last !== null && JSON.stringify(rule) === JSON.stringify(this.rule)
      && eligible.length === this.snapshot.length) {
      const locations = new Map(this.snapshot.map(member => [member.userId, member]));
      if (eligible.every(member => {
        const previous = locations.get(member.userId);
        return previous?.channelId === member.channelId && previous?.categoryId === member.categoryId;
      })) return;
    }
    // Capture the old interval and the new state synchronously, before waiting
    // for MongoDB. A later disconnect must not erase already received events.
    if (this.capture(at)) {
      this.snapshot = eligible; this.rule = structuredClone(rule);
    }
  }
  tick(at) {
    this.capture(at);
    return this.enqueue(() => this.persist());
  }
  capture(at) {
    if (!Number.isFinite(at)) throw new TypeError('Invalid voice observation time');
    // Old callbacks cannot rewind the cursor or restore an older voice state.
    if (this.last !== null && at < this.last) return false;
    const from = this.last; this.last = at;
    // This limit applies to observation gaps, never to persistence delays.
    if (from !== null && at > from && at - from <= 60000 && this.rule) {
      for (const member of this.snapshot) {
        if (!this.pending.has(member.userId)) this.pending.set(member.userId, []);
        this.pending.get(member.userId).push({ event: {
          guildId: this.guildId, userId: member.userId, channelId: member.channelId,
          ...(member.categoryId ? { categoryId: member.categoryId } : {}),
          from, to: at, eligible: true
        }, rule: structuredClone(this.rule) });
      }
    } else if (from !== null && at - from > 60000 && this.snapshot.length) {
      this.onGap({ from, to: at, memberCount: this.snapshot.length });
    }
    return true;
  }
  async persist() {
    // Freeze each batch at the start. Otherwise fresh observations continually
    // extend the first eight members' work and starve everyone behind them.
    const epoch = this.epoch, jobs = [...this.pending].map(([id, queue]) => [id, [...queue]]), failures = [];
    let cursor = 0;
    // Bounded parallelism avoids one slow member delaying every other member.
    const worker = async () => {
      while (cursor < jobs.length && epoch === this.epoch) {
        const [id, batch] = jobs[cursor++];
        try { await this.saveMember(id, batch, epoch); }
        catch (error) { failures.push(error); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, jobs.length) }, worker));
    if (failures.length) throw Object.assign(new Error(`تعذر حفظ وقت الصوت لـ ${failures.length} عضو؛ ستعاد محاولة الفترات المرصودة.`, { cause: failures[0] }), { voiceRetryable: true });
  }
  async flushUser(userId) {
    // A quest refresh waits for its owner's captured time, not every voice
    // participant. The same per-user writer prevents duplicate/out-of-order I/O.
    const operation = this.saveMember(userId, [...(this.pending.get(userId) || [])], this.epoch);
    this.flushes.add(operation);
    try { return await operation; }
    finally { this.flushes.delete(operation); }
  }
  async saveMember(userId, batch, epoch) {
    for (const item of batch) {
      while (this.memberWrites.has(userId)) await this.memberWrites.get(userId);
      if (epoch !== this.epoch) return;
      const queue = this.pending.get(userId);
      if (queue?.[0] !== item) continue; // Another writer already saved it.
      const writing = Promise.resolve().then(() => this.service.voice(item.event, item.rule));
      this.memberWrites.set(userId, writing);
      try {
        await writing;
        if (queue[0] === item) queue.shift();
        if (!queue.length && this.pending.get(userId) === queue) this.pending.delete(userId);
      } finally {
        if (this.memberWrites.get(userId) === writing) this.memberWrites.delete(userId);
      }
    }
  }
  drop() {
    this.epoch++; this.snapshot = []; this.last = null; this.rule = null;
    // Keep previously observed intervals; never add disconnected time.
  }
  async drain() { await this.tail; await Promise.allSettled([...this.flushes]); }
}
