import { MessageFlags } from 'discord.js';
import { NOTIFICATION_BUTTON } from './notification-events.js';
import { memberNotification, notificationFooter } from './notification-views.js';

export function createNotificationHandler({ config, store, onError = () => {} }) {
  return async interaction => {
    if (!interaction.isButton?.() || interaction.customId !== NOTIFICATION_BUTTON) return false;
    if (interaction.guildId !== config.clanGuildId || interaction.user.bot) {
      await interaction.reply({ content: 'زر التنبيهات متاح لأعضاء سيرفر الكلان فقط.', flags: MessageFlags.Ephemeral });
      return true;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const preference = await store.notifications.toggle(interaction.user.id, interaction.id);
      await interaction.editReply({ content: preference.enabled
        ? '🔔 تم تفعيل تنبيهاتك بالخاص. تأكد أن رسائل أعضاء السيرفر الخاصة مسموحة عندك. اضغط تنبيه مرة ثانية لإيقافها.'
        : '🔕 تم إيقاف جميع تنبيهات البوت بالخاص لك. اضغط تنبيه مرة ثانية لتفعيلها.',
      embeds: [], components: [], allowedMentions: { parse: [] } });
    } catch (error) {
      onError(error);
      await interaction.editReply({ content: 'تعذر حفظ إعداد التنبيهات. حاول مرة ثانية.', allowedMentions: { parse: [] } });
    }
    return true;
  };
}

export class MemberNotifier {
  constructor({ bot, store, service, isMember = () => true, canRun = () => true, clock = Date.now, onError = () => {} }) {
    Object.assign(this, { bot, store, service, isMember, canRun, clock, onError }); this.running = null;
  }
  tick() {
    if (this.running) return this.running;
    this.running = this.deliver().finally(() => { this.running = null; }); return this.running;
  }
  async recoverMessage(channel, event) {
    // Before any retry, prove the send window is covered. A bounded history
    // that cannot cover it is left uncertain instead of risking duplicate DMs.
    let before;
    for (let page = 0; page < 5; page++) {
      const batch = [...(await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) })).values()];
      const found = batch.find(message => message.author?.id === this.bot.user.id
        && message.embeds?.some(embed => embed.footer?.text === notificationFooter(event.id)));
      if (found) return { message: found, covered: true };
      const last = batch.at(-1);
      if (batch.length < 100 || last?.createdTimestamp < event.lastAttemptAt - 60000) return { covered: true };
      if (!last?.id || before === last.id) break;
      before = last.id;
    }
    return { covered: false };
  }
  async deliver() {
    if (!this.canRun()) return;
    const notices = this.store.notifications;
    await this.service.gate.exclusive(async () => {
      if (!this.canRun()) return;
      this.service.assertActive();
      await notices.bootstrap(this.clock()); await notices.collect(this.clock());
    });
    const seen = new Set();
    for (const event of await notices.pending(this.clock())) {
      if (!this.canRun()) return;
      // One DM per member per cycle avoids bursts when several events coincide.
      if (seen.has(event.userId)) continue;
      try {
        await notices.forUser(event.userId, async () => {
          if (!this.canRun()) return;
          const now = this.clock(), preference = await notices.preference(event.userId);
          if (!preference.enabled || event.dueAt < preference.enabledSince || preference.blockedUntil > now) {
            await notices.finish(event, 'suppressed', now); return;
          }
          const validate = () => this.service.gate.exclusive(() => {
            this.service.assertActive(); return notices.valid(event, this.clock(), this.isMember);
          });
          const valid = await validate();
          if (valid === 'skip') { await notices.finish(event, 'obsolete', now); return; }
          if (valid === 'wait') return;
          seen.add(event.userId);
          await this.store.requireLease(this.clock());
          const guild = this.bot.guilds.cache.get(this.store.config.clanGuildId);
          if (!guild || guild.available === false) return;
          const member = await guild.members.fetch({ user: event.userId, force: true });
          if (!member || member.user.bot) { await notices.finish(event, 'not-member', this.clock()); return; }
          const channel = await member.user.createDM();
          let message;
          if (event.attempts) {
            const recovered = await this.recoverMessage(channel, event);
            message = recovered.message;
            if (!recovered.covered) { await notices.finish(event, 'uncertain', this.clock()); return; }
          }
          if (message) { await notices.finish(event, 'sent', this.clock(), { messageId: message.id }); return; }
          if (!this.canRun() || await validate() !== 'send') return;
          const settings = await this.store.settings();
          await notices.attempt(event, this.clock());
          if (!this.canRun()) return;
          await this.store.requireLease(this.clock());
          message = await channel.send(memberNotification(event, settings, this.store.config.clanGuildId));
          await notices.finish(event, 'sent', this.clock(), { messageId: message.id });
        });
      } catch (error) {
        // Delivery failures never roll back or block earned money/tasks.
        try {
          if (Number(error.code) === 50007) {
            await this.store.requireLease(this.clock());
            await notices.blockDM(event.userId, this.clock());
            await notices.finish(event, 'dm-closed', this.clock());
          } else if ([10007, 10013, 50278].includes(Number(error.code))) {
            // Discord can report 50278 when the user has no mutual guilds at send time.
            // Treat it like a member that is no longer reachable instead of retrying/logging forever.
            await notices.finish(event, 'not-member', this.clock());
          } else {
            // Failures before the send attempt need backoff too.
            const saved = await notices.queue.findOne({ _id: event._id });
            if (saved?.status === 'pending' && saved.nextAttemptAt <= this.clock()) await notices.attempt(saved, this.clock());
            this.onError(error);
          }
        } catch (saveError) { this.onError(saveError); }
      }
    }
  }
  async drain() { await this.running; }
}
