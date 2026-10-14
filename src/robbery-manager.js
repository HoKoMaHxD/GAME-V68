import { ActivityGate } from './activity-gate.js';
import { robberyPayload, parseRobberyAction } from './robbery-commands.js';

// Settlement never waits for a Discord edit. Message retries are separate from
// the durable debit/credit journal and cannot charge a member again.
export class RobberyManager {
  constructor({ bot, store, service, canRun = () => true, clock = Date.now, onError = () => {} }) {
    Object.assign(this, { bot, store, service, canRun, clock, onError });
    this.displays = new ActivityGate(); this.jobs = new Map(); this.running = null;
  }
  tick() {
    if (this.running) return this.running;
    this.running = (async () => {
      if (!this.canRun()) return;
      await this.service.expireRobberies();
      if (!this.canRun() || !this.bot.isReady()) return;
      for (const round of await this.store.robbery.pendingDisplays(this.clock())) {
        if (this.jobs.size >= 5) break;
        if (this.jobs.has(round.id)) continue;
        const job = this.displays.runSerial(round.id, () => this.refresh(round.id)).catch(async error => {
          this.onError(error);
          if (this.canRun()) await this.store.robbery.displayRetry(round.id, this.clock() + 10000, this.clock());
        }).catch(error => this.onError(error)).finally(() => this.jobs.delete(round.id));
        this.jobs.set(round.id, job);
      }
    })().finally(() => { this.running = null; });
    return this.running;
  }
  async refresh(id) {
    if (!this.canRun() || !this.bot.isReady()) return;
    let round = await this.store.robbery.round(id);
    if (!round || round.delivery?.complete) return;
    let messageId = round.delivery?.messageId;
    let channel, message;
    try {
      channel = await this.bot.channels.fetch(round.channelId);
      if (!channel || channel.guildId !== this.store.config.clanGuildId) throw new Error('تعذر الوصول إلى روم تحدي النهب.');
      if (messageId) message = await channel.messages.fetch(messageId);
    } catch (error) {
      if ([10003, 10008].includes(Number(error.code)) && messageId) {
        round = await this.service.missingRobberyMessage(id);
        await this.service.confirmRobberyDisplay(round, messageId); return;
      }
      throw error;
    }
    if (!message) {
      // Recover the original message after a crash between send and ID binding.
      // Its persisted component IDs uniquely identify this round; never publish
      // a second result message if the original cannot be located.
      const recent = await channel.messages.fetch({ limit: 100 });
      message = [...recent.values()].find(m => m.author?.id === this.bot.user.id && m.components?.some(row =>
        row.components?.some(button => {
          const action = parseRobberyAction(button.customId || button.data?.custom_id);
          return action?.id === id && action.userId === round.userId;
        })));
      if (!message) { await this.store.robbery.displayRetry(id, this.clock() + 60000, this.clock()); return; }
      messageId = message.id;
      await this.service.bindRobberyMessage(id, messageId, round.displayAuthor || { name: 'عضو الكلان' });
      round = await this.store.robbery.round(id);
    }
    if (message.author?.id !== this.bot.user.id) throw new Error('رسالة التحدي المحفوظة لا تخص البوت.');
    if (!this.canRun() || !this.bot.isReady()) return;
    const appearance = (await this.store.settings())?.appearance;
    await this.store.requireLease(this.clock());
    round = await this.store.robbery.round(id);
    await message.edit(robberyPayload(round, appearance, {}, this.clock()));
    await this.service.confirmRobberyDisplay(round, messageId);
  }
  async drain() {
    await this.running;
    await Promise.allSettled([...this.jobs.values()]);
  }
}
