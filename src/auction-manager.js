import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { auctionTerminal, AUCTION_DURATION_MS } from './auction.js';
import { auctionPayload, auctionFooter } from './auction-views.js';

export async function checkAuctionChannel(bot, guildId, channelId, roleId = null) {
  const channel = await bot.channels.fetch(channelId);
  if (!channel || channel.guildId !== guildId || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) throw new Error('استخدم رومًا كتابيًا عاديًا في سيرفر الكلان لإنشاء المزاد.');
  const permissions = channel.permissionsFor(bot.user);
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory])) throw new Error('البوت يحتاج مشاهدة روم المزاد وإرسال الرسائل وتضمين الروابط وقراءة سجل الرسائل.');
  if (roleId) {
    const role = await channel.guild.roles.fetch(roleId);
    if (!role || role.id === guildId) throw new Error(`رتبة المزاد ${roleId} غير موجودة في سيرفر الكلان.`);
    if (!role.mentionable && !permissions.has(PermissionFlagsBits.MentionEveryone)) throw new Error('اسمح بمنشن رتبة المزاد أو امنح البوت صلاحية منشن جميع الرتب في هذا الروم.');
  }
  return channel;
}

export class AuctionManager {
  constructor({ bot, store, service, canRun = () => true, clock = Date.now, onError = () => {} }) {
    Object.assign(this, { bot, store, service, canRun, clock, onError });
    this.jobs = new Map(); this.dirty = new Set(); this.retryAt = new Map(); this.checkedAt = new Map(); this.running = null;
  }
  refresh(id) {
    if (this.jobs.has(id)) { this.dirty.add(id); return this.jobs.get(id); }
    const job = (async () => {
      do {
        this.dirty.delete(id);
        if (!this.canRun()) return;
        await this.sync(id);
      } while (this.dirty.has(id) && this.canRun());
    })().finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
    return job;
  }
  tick() {
    if (this.running) return this.running;
    this.running = (async () => {
      if (!this.canRun()) return;
      for (const a of await this.store.auctions.unfinished()) {
        if (!this.canRun()) return;
        // Close monetary state even while Discord publication is backing off.
        if ((this.retryAt.get(a.id) || 0) > this.clock()) { await this.service.settleAuction(a.id); continue; }
        try { await this.refresh(a.id); this.retryAt.delete(a.id); }
        catch (error) { this.retryAt.set(a.id, this.clock() + 10000); this.onError(error); }
      }
    })().finally(() => { this.running = null; });
    return this.running;
  }
  async fetchMessage(channel, id) {
    if (!id) return null;
    try { return await channel.messages.fetch(id); }
    catch (error) { if (error.code === 10008) return null; throw error; }
  }
  async ensureMessage(a, stage, channel, appearance) {
    const saved = a.delivery[stage];
    let message = await this.fetchMessage(channel, saved.messageId);
    if (!message && saved.attempts) {
      const recent = await channel.messages.fetch({ limit: 100 });
      message = [...recent.values()].find(m => m.author?.id === this.bot.user.id
        && m.embeds?.some(e => e.footer?.text === auctionFooter(a.id, stage)));
    }
    if (!message) {
      await this.service.auctionDelivery(a.id, { [`${stage}.attempts`]: saved.attempts + 1 });
      if (!this.canRun()) throw new Error('البوت غير جاهز لإرسال إعلان المزاد.');
      await this.store.requireLease(this.clock());
      message = await channel.send({ ...auctionPayload(a, stage, appearance, { ping: true }),
        nonce: `au${stage[0]}:${a.id}`, enforceNonce: true });
    }
    if (message.id !== saved.messageId) await this.service.auctionDelivery(a.id, { [`${stage}.messageId`]: message.id });
    return message;
  }
  async deleteUpcoming(a, channel) {
    if (a.delivery.upcoming.deleted) return;
    let message = await this.fetchMessage(channel, a.delivery.upcoming.messageId);
    // The announcement may have reached Discord just before a crash prevented
    // its ID being saved. Recover it before deleting and starting the auction.
    if (!message && a.delivery.upcoming.attempts) {
      const recent = await channel.messages.fetch({ limit: 100 });
      message = [...recent.values()].find(m => m.author?.id === this.bot.user.id
        && m.embeds?.some(e => e.footer?.text === auctionFooter(a.id, 'upcoming')));
    }
    if (message) { await this.store.requireLease(this.clock()); await message.delete(); }
    await this.service.auctionDelivery(a.id, { 'upcoming.deleted': true,
      ...(message ? { 'upcoming.messageId': message.id } : {}) });
  }
  async sync(id) {
    let a = await this.service.settleAuction(id);
    if (a.delivery.complete) return;
    if (a.status === 'scheduled' && this.clock() >= a.startsAt) {
      a = await this.service.auctionChange(id, draft => {
        if (draft.status !== 'scheduled') return false;
        draft.status = 'starting'; return true;
      });
    }
    const unchanged = a.status === 'scheduled' && a.delivery.upcoming.messageId
      || a.status === 'active' && a.delivery.live.messageId && a.delivery.live.renderedRevision === a.revision;
    // Relative Discord timestamps update in the client. Only changed bids need
    // immediate edits; verify unchanged saved messages once per 30 seconds.
    if (unchanged && (this.checkedAt.get(id) || 0) > this.clock() - 30000) return;
    const channel = await checkAuctionChannel(this.bot, this.store.config.clanGuildId, a.channelId,
      ['scheduled', 'starting'].includes(a.status) ? a.roleId : null);
    const appearance = (await this.store.settings())?.appearance;
    if (a.status === 'scheduled') {
      await this.ensureMessage(a, 'upcoming', channel, appearance);
      this.checkedAt.set(id, this.clock());
      return;
    }
    if (a.status === 'starting') {
      // Deletion precedes the new announcement, and the full five minutes
      // starts from the actual message creation time, including after downtime.
      await this.deleteUpcoming(a, channel);
      const startedAt = this.clock();
      const message = await this.ensureMessage({ ...a, status: 'active', startedAt, endsAt: startedAt + AUCTION_DURATION_MS }, 'live', channel, appearance);
      a = await this.service.auctionChange(id, draft => {
        if (draft.status !== 'starting') return false;
        draft.status = 'active'; draft.startedAt = message.createdTimestamp || startedAt;
        draft.endsAt = draft.startedAt + AUCTION_DURATION_MS;
        draft.delivery.live.messageId = message.id;
        return true;
      });
      a = await this.service.settleAuction(id);
    }
    // Cancelling a scheduled auction updates its original announcement.
    const stage = a.status === 'cancelled' && !a.delivery.live.messageId ? 'upcoming' : 'live';
    const message = await this.ensureMessage(a, stage, channel, appearance);
    if (a.delivery[stage].renderedRevision !== a.revision) {
      await this.store.requireLease(this.clock());
      // A terminal scheduled announcement uses the result layout, with its
      // original recovery footer so retries still find the same message.
      const payload = auctionPayload(a, stage === 'upcoming' ? 'result' : stage, appearance);
      payload.embeds[0].setFooter({ text: auctionFooter(a.id, stage) });
      await message.edit(payload);
      await this.service.auctionDelivery(id, { [`${stage}.renderedRevision`]: a.revision });
    }
    if (auctionTerminal(a)) {
      await this.ensureMessage(a, 'result', channel, appearance);
      await this.service.auctionDelivery(id, { complete: true });
    }
    this.checkedAt.set(id, this.clock());
  }
  async drain() { await Promise.allSettled([this.running, ...this.jobs.values()]); }
}
