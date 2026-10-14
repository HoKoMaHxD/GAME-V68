import { ActivityGate } from './activity-gate.js';
import { isUserMessage } from './message-channels.js';
import { DEFAULT_SPAM_SETTINGS, readSpamSettings, spamDuration } from './spam-settings.js';

export const SPAM_WINDOW_MS = DEFAULT_SPAM_SETTINGS.windowMs;
export const SPAM_CHANNELS = { clan: '1552646864682221650', arena: '1470732708559851673' };
export function isSpam(previousAt, at, windowMs = SPAM_WINDOW_MS) {
  return Number.isSafeInteger(previousAt) && at >= previousAt && at - previousAt < windowMs;
}
export class SpamMonitor {
  constructor({ store, service, config, canRun, actorId, clock = Date.now }) {
    Object.assign(this, { store, service, config, canRun, actorId, clock });
    this.gate = new ActivityGate();
  }
  get records() { return this.store.db.collection('spam_messages'); }
  accepts(message) {
    return isUserMessage(message) && ((message.guildId === this.config.clanGuildId && message.channelId === SPAM_CHANNELS.clan)
      || (message.guildId === this.config.arenaGuildId && message.channelId === SPAM_CHANNELS.arena));
  }
  async initialize() {
    await this.records.createIndex({ clanId: 1, userId: 1, channelId: 1, at: -1 });
    await this.records.createIndex({ clanId: 1, status: 1 });
    await this.records.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0 });
  }
  receive(message) {
    if (!this.canRun() || !this.accepts(message) || this.clock() - message.createdTimestamp > 120000) return Promise.resolve();
    return this.gate.runSerial(`${message.channelId}:${message.author.id}`, async () => {
      if (!this.canRun()) return;
      await this.store.requireLease(this.clock());
      const _id = `${this.config.clanGuildId}:${message.id}`;
      let record = await this.records.findOne({ _id });
      if (!record) {
        const spamRule = readSpamSettings((await this.store.settings())?.spam);
        const recent = await this.records.find({ clanId: this.config.clanGuildId, userId: message.author.id,
          channelId: message.channelId, at: { $lte: message.createdTimestamp,
            $gt: Math.max(message.createdTimestamp - spamRule.windowMs, this.service.resumedAt || 0) } })
          .sort({ at: -1 }).limit(spamRule.messageCount - 1).toArray();
        const penalty = recent.length >= spamRule.messageCount - 1;
        record = { _id, clanId: this.config.clanGuildId, userId: message.author.id, channelId: message.channelId,
          messageId: message.id, at: message.createdTimestamp, spamRule, status: penalty ? 'pending' : 'clear',
          purgeAt: new Date(this.clock() + 7 * 86400000) };
        await this.records.updateOne({ _id }, { $setOnInsert: record }, { upsert: true });
      }
      await this.apply(record);
    });
  }
  async apply(record) {
    if (record.status !== 'pending' || !this.canRun()) return;
    // Resets supersede old penalties; successful receipts prevent double debit on retry.
    if (record.at <= Math.max(this.service.bankCutoff(record.userId), this.service.resumedAt || 0)) {
      await this.records.updateOne({ _id: record._id }, { $set: { status: 'reset' } }); return;
    }
    // Keep the original rule on each violation so a settings change or restart
    // cannot change an already-recorded fine. Legacy records retain 3s / 500.
    const rule = readSpamSettings(record.spamRule);
    await this.service.penalizeSpam({ userId: record.userId, actorId: this.actorId(), operationId: record.messageId,
      amount: rule.amount, at: record.at, reason: `سبام: إرسال ${rule.messageCount} رسائل أو أكثر خلال أقل من ${spamDuration(rule.windowMs)} في الشات ${record.channelId}` });
    await this.store.requireLease(this.clock());
    await this.records.updateOne({ _id: record._id }, { $set: { status: 'paid' } });
  }
  async tick() {
    if (!this.canRun()) return;
    for (const record of await this.records.find({ clanId: this.config.clanGuildId, status: 'pending' }).sort({ at: 1 }).limit(100).toArray()) {
      await this.gate.runSerial(`${record.channelId}:${record.userId}`, () => this.apply(record));
    }
  }
}
