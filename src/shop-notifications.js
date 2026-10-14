import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { themedEmbed } from './appearance.js';
import { number, safe } from './presentation.js';

export async function checkShopDestination(bot, guildId, destination) {
  const channel = await bot.channels.fetch(destination.channelId);
  if (!channel || channel.guildId !== guildId || channel.type !== ChannelType.GuildText) throw new Error('اختر رومًا كتابيًا عاديًا في سيرفر الكلان لتنبيهات الشراء.');
  const permissions = channel.permissionsFor(bot.user);
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory])) throw new Error('البوت يحتاج مشاهدة روم التنبيهات وإرسال الرسائل وتضمين الروابط وقراءة سجل الرسائل.');
  const role = await channel.guild.roles.fetch(destination.roleId);
  if (!role || role.guild.id !== guildId || role.id === guildId) throw new Error('اختر رتبة مخصصة موجودة في سيرفر الكلان للتنبيهات.');
  if (!role.mentionable && !permissions.has(PermissionFlagsBits.MentionEveryone)) throw new Error('فعّل السماح بمنشن رتبة التنبيهات، أو امنح البوت صلاحية منشن جميع الرتب في هذا الروم.');
  return channel;
}

export const orderFooter = id => `طلب المتجر #${id}`;
export function purchaseNotification(order, destination, appearance) {
  return { content: `<@&${destination.roleId}>`, allowedMentions: { parse: [], roles: [destination.roleId], users: [] },
    nonce: order.id, enforceNonce: true,
    embeds: [themedEmbed('طلب شراء جديد', appearance)
      .setDescription('**تم خصم العملة 💵 وحجز المنتج.**\nيرجى متابعة تسليم الطلب للعضو.')
      .addFields(
        { name: 'العضو', value: `<@${order.userId}>\n\`${order.userId}\``, inline: true },
        { name: 'المنتج', value: safe(order.product.name), inline: true },
        { name: 'السعر والكمية', value: `**${number(order.product.price)} $ 💵** • قطعة واحدة`, inline: true },
        { name: 'الوصف', value: order.product.description ? safe(order.product.description) : 'بدون وصف إضافي.' },
        { name: 'وقت الشراء', value: `<t:${Math.floor(order.at / 1000)}:f>`, inline: true },
        { name: 'رقم الطلب', value: `\`${order.id}\``, inline: true }
      ).setFooter({ text: orderFooter(order.id) })]
  };
}

export class ShopNotifier {
  constructor({ bot, store, canRun = () => true, clock = Date.now, onError = () => {} }) {
    Object.assign(this, { bot, store, canRun, clock, onError });
    this.running = null;
  }
  tick() {
    if (this.running) return this.running;
    this.running = this.deliver().finally(() => { this.running = null; });
    return this.running;
  }
  async deliver() {
    if (!this.canRun()) return;
    const orders = await this.store.shop.notifications(this.clock());
    for (const order of orders) {
      if (!this.canRun()) return;
      try {
        const { destination } = await this.store.shop.get();
        if (!destination) return;
        const channel = await checkShopDestination(this.bot, this.store.config.clanGuildId, destination);
        await this.store.shop.notificationAttempt(order, this.clock());
        let message;
        if (order.notification.attempts > 0) {
          // Recover a sent message whose database acknowledgement was lost.
          // Nonce dedup also covers recent ambiguous sends. See README limits.
          const recent = await channel.messages.fetch({ limit: 100 });
          message = [...recent.values()].find(m => m.author?.id === this.bot.user.id
            && m.embeds?.some(e => e.footer?.text === orderFooter(order.id)));
        }
        if (!this.canRun()) return;
        await this.store.requireLease(this.clock());
        if (!message) message = await channel.send(purchaseNotification(order, destination, (await this.store.settings())?.appearance));
        await this.store.shop.notified(order, message, destination, this.clock());
      } catch (error) { this.onError(error); }
    }
  }
  async drain() { await this.running; }
}
