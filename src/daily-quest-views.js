import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { tasksEmbed } from './presentation.js';
import { parsePanelAction } from './panel.js';
import { ActivityGate } from './activity-gate.js';
import { membershipUnavailable } from './membership-status.js';

export const QUEST_REFRESH_MS = 15000;
function questDigest(payload) {
  const data = JSON.parse(JSON.stringify(payload));
  // A new observation timestamp alone must not cause another Discord edit.
  for (const embed of data.embeds || []) delete embed.timestamp;
  return JSON.stringify(data);
}
export function dailyQuestPayload(state, at, tracking, config, settings = {}, live = true) {
  const embed = tasksEmbed(state, at, tracking, config, settings.appearance, settings.attendance);
  embed.setTimestamp(at);
  embed.setFooter({ text: live ? 'آخر تحديث للبطاقة • تحديث تلقائي كل 15 ثانية؛ اضغط تحديث المهام إذا بقي الرقم ثابتًا'
    : 'توقف تحديث هذه البطاقة؛ الرقم من آخر تحديث • اضغط تحديث المهام لاستئناف التحديث' });
  return { content: '', embeds: [embed], allowedMentions: { parse: [] }, components: [
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`clan-daily:v1:${state.userId}:refresh`)
      .setLabel('تحديث المهام').setEmoji('🔄').setStyle(ButtonStyle.Primary))
  ] };
}
export function dailyQuestLauncher(userId) {
  return { content: 'اضغط الزر لاستعراض مهامك؛ تظهر لك وحدك في نفس الشات.',
    allowedMentions: { parse: [] }, components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`clan-daily-open:v1:${userId}`)
        .setLabel('استعراض المهام').setStyle(ButtonStyle.Primary))] };
}
export function parseDailyAction(id) {
  const open = /^clan-daily-open:v1:(\d{17,20})$/.exec(id || '');
  if (open) return { ownerId: open[1], update: false };
  const own = /^(?:clan-daily:v1:|quests:)(\d{17,20})(?::refresh)?$/.exec(id || '');
  if (own) return { ownerId: own[1], update: true };
  const legacy = /^clan-quest:v1:(\d{17,20}):\d{17,20}:(accept|reject|refresh)$/.exec(id || '');
  if (legacy) return { ownerId: legacy[1], update: true };
  if (id === 'clan-economy:quest') return { update: false };
  const panel = parsePanelAction(id);
  return panel?.kind === 'mine' ? panel : null;
}

// Public command cards are durable: the latest card per member/channel keeps
// refreshing after restarts and Saudi midnight. Private legacy cards have a
// bounded webhook session; pressing refresh starts a fresh session.
export class DailyQuestViews {
  constructor({ bot, store, service, config, isMember, status, canRun = () => true, clock = Date.now, onError = () => {} }) {
    Object.assign(this, { bot, store, service, config, isMember, status, canRun, clock, onError });
    this.gate = new ActivityGate(); this.privateViews = new Map(); this.running = null;
  }
  get records() { return this.store.db.collection('quest_views'); }
  async payload(userId, live = true) {
    const [state, settings] = await Promise.all([this.service.day(userId, this.clock()), this.store.settings()]);
    return dailyQuestPayload(state, this.clock(), this.status().tracking, this.config, settings, live);
  }
  async track(interaction, message, payload) {
    this.store.fence?.assertCurrent();
    if (!message?.id) return;
    const userId = interaction.user.id;
    const privateMessage = interaction.ephemeral || message.flags?.has?.(MessageFlags.Ephemeral);
    if (privateMessage) {
      this.privateViews.set(message.id, { userId, interaction, until: this.clock() + 14 * 60000, digest: questDigest(payload) });
      return;
    }
    const id = `${this.config.clanGuildId}:${interaction.channelId}:${userId}`;
    await this.gate.runSerial(id, async () => {
      await this.store.requireLease(this.clock());
      const old = await this.records.findOne({ _id: id });
      if (old?.messageId && old.messageId !== message.id) {
        try {
          const channel = await this.bot.channels.fetch(old.channelId);
          const previous = await channel.messages.fetch(old.messageId);
          await previous.edit(await this.payload(userId, false));
        } catch (error) { if (![10008, 10003, 50001, 50013].includes(Number(error.code))) this.onError(error); }
      }
      await this.store.requireLease(this.clock());
      await this.records.updateOne({ _id: id }, { $set: { clanId: this.config.clanGuildId, userId,
        channelId: interaction.channelId, messageId: message.id, digest: questDigest(payload) } }, { upsert: true });
    });
  }
  tick() {
    if (this.running) return this.running;
    this.running = this.update().finally(() => { this.running = null; }); return this.running;
  }
  async update() {
    if (!this.canRun()) return;
    for (const entry of await this.records.find({ clanId: this.config.clanGuildId }).toArray()) {
      if (!this.canRun()) return;
      await this.gate.runSerial(entry._id, async () => {
        const current = await this.records.findOne({ _id: entry._id });
        if (current?.messageId !== entry.messageId) return;
        try {
          // A reader reconnect is not evidence that a member has left.
          if (this.status().tracking && !this.isMember(entry.userId)) return;
          const payload = await this.payload(entry.userId), digest = questDigest(payload);
          if (digest === current.digest) return;
          const channel = await this.bot.channels.fetch(entry.channelId);
          if (!channel || channel.guildId !== this.config.clanGuildId) throw Object.assign(new Error('Missing quest channel'), { code: 10003 });
          const message = await channel.messages.fetch(entry.messageId);
          if (message.author?.id !== this.bot.user.id) throw Object.assign(new Error('Invalid quest message'), { code: 10008 });
          if (!this.canRun()) return;
          await this.store.requireLease(this.clock());
          await message.edit(payload);
          await this.store.requireLease(this.clock());
          await this.records.updateOne({ _id: entry._id, messageId: entry.messageId }, { $set: { digest } });
        } catch (error) {
          if ([10003, 10008, 50001, 50013].includes(Number(error.code))) {
            await this.records.deleteOne({ _id: entry._id, messageId: entry.messageId });
          } else this.onError(error);
        }
      });
    }
    for (const [id, entry] of this.privateViews) {
      if (!this.canRun()) return;
      try {
        if (this.privateViews.get(id) !== entry) continue;
        if (this.status().tracking && !this.isMember(entry.userId)) continue;
        const live = this.clock() < entry.until;
        const payload = await this.payload(entry.userId, live), digest = questDigest(payload);
        if (digest !== entry.digest) { await entry.interaction.editReply(payload); entry.digest = digest; }
        if (!live && this.privateViews.get(id) === entry) this.privateViews.delete(id);
      } catch (error) {
        if ([10008, 10015, 50027].includes(Number(error.code))) this.privateViews.delete(id);
        else this.onError(error);
      }
    }
  }
  async drain() { await this.running; await Promise.allSettled([...this.gate.active]); }
}

export function createDailyQuestHandler({ config, service, store, status, isMember, questViews, refreshVoice = async () => {}, onError = () => {} }) {
  return async interaction => {
    const action = interaction.isButton?.() ? parseDailyAction(interaction.customId) : null;
    if (!action && !['مهامي', 'مهمتي'].includes(interaction.commandName)) return false;
    const deny = content => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    if (interaction.guildId !== config.clanGuildId || interaction.user.bot) { await deny('المهام متاحة في سيرفر الكلان فقط.'); return true; }
    if (action?.ownerId && action.ownerId !== interaction.user.id) { await deny('هذه بطاقة عضو آخر. استخدم /مهامي لعرض مهامك.'); return true; }
    if (!await isMember(interaction.user.id)) {
      await deny(membershipUnavailable(status?.()) || 'تحتاج عضوية الكلان ورتبته في سيرفر أرينا لاستخدام المهام.'); return true;
    }
    if (!action) {
      await interaction.reply(dailyQuestLauncher(interaction.user.id));
      return true;
    }
    const privateUpdate = action?.update && interaction.message?.flags?.has?.(MessageFlags.Ephemeral);
    if (privateUpdate) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      // Finish the current observed interval before displaying manual refreshes.
      await refreshVoice(interaction.user.id);
      const [state, settings] = await Promise.all([service.day(interaction.user.id), store.settings()]);
      const payload = dailyQuestPayload(state, (service.clock?.() ?? Date.now()), status().tracking, config, settings);
      const message = await interaction.editReply(payload);
      // A delivery bookkeeping error must not replace a successfully rendered card.
      try { await questViews?.track(interaction, message || interaction.message, payload); } catch (error) { onError(error); }
    } catch (error) {
      onError(error);
      await interaction.editReply({ content: /[\u0600-\u06ff]/.test(error.message) ? `❌ ${error.message}` : 'تعذر تحميل مهامك. حاول مجددًا.',
        embeds: [], components: [], allowedMentions: { parse: [] } });
    }
    return true;
  };
}
