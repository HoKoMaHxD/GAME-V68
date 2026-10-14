import { SlashCommandBuilder, MessageFlags, ChannelType, PermissionFlagsBits } from 'discord.js';
import { themedEmbed, attachmentImageUrl } from './appearance.js';
import { BOOST_ROLE_ID } from './task-boost.js';
import { canManageBot, MANAGEMENT_DENIED } from './permissions.js';

export function buildAnnouncementCommand() {
  return new SlashCommandBuilder().setName('اعلان').setDescription('للإدارة: نشر إعلان بصورة بتنسيق إيمبد المزاد').setDefaultMemberPermissions(null)
    .addStringOption(o => o.setName('الاسم').setDescription('اسم الإعلان').setRequired(true).setMinLength(1).setMaxLength(200))
    .addAttachmentOption(o => o.setName('الصورة').setDescription('صورة الإعلان').setRequired(true))
    .addStringOption(o => o.setName('الوصف').setDescription('تفاصيل الإعلان (اختياري)').setMaxLength(4000));
}

export function announcementPayload({ name, imageUrl, description, appearance, now }) {
  const embed = themedEmbed(`📢 ${name}`, appearance, 'إعلانات الكلان').setColor(0xf2b84b)
    .setImage(imageUrl).setTimestamp(now);
  if (description) embed.setDescription(description);
  return { content: `<@&${BOOST_ROLE_ID}>`, embeds: [embed], allowedMentions: { parse: [], roles: [BOOST_ROLE_ID] } };
}

export function createAnnouncementHandler({ config, service, bot, access, onError = () => {} }) {
  return async i => {
    if (!i.isChatInputCommand?.() || i.commandName !== 'اعلان') return false;
    if (i.user.bot || !canManageBot(i, config, access?.roleId)) {
      await i.reply({ content: MANAGEMENT_DENIED, flags: MessageFlags.Ephemeral });
      return true;
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    let sent = false;
    try {
      const name = i.options.getString('الاسم', true).trim();
      if (!name || name.length > 200 || /[\r\n\u0000-\u001f]/.test(name)) throw new Error('اكتب اسم الإعلان في سطر واحد، من 1 إلى 200 حرف.');
      const imageUrl = attachmentImageUrl(i.options.getAttachment('الصورة', true));
      const description = i.options.getString('الوصف')?.trim();
      const channel = await bot.channels.fetch(i.channelId);
      if (!channel || channel.guildId !== config.clanGuildId || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) throw new Error('استخدم الأمر في شات كتابي داخل سيرفر الكلان.');
      if (!channel.permissionsFor(bot.user)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) throw new Error('البوت يحتاج صلاحيات مشاهدة الشات وإرسال الرسائل وتضمين الروابط.');
      const role = await channel.guild.roles.fetch(BOOST_ROLE_ID);
      if (!role) throw new Error('رتبة الإعلان المحددة غير موجودة في السيرفر.');
      if (!role.mentionable && !channel.permissionsFor(bot.user)?.has(PermissionFlagsBits.MentionEveryone)) throw new Error('اسمح بمنشن رتبة الإعلان أو امنح البوت صلاحية منشن جميع الرتب في هذا الشات.');
      const appearance = (await service.store.settings())?.appearance;
      await channel.send({ ...announcementPayload({ name, imageUrl, description, appearance, now: service.clock() }), nonce: i.id, enforceNonce: true });
      sent = true;
      await i.editReply({ content: '✅ تم نشر الإعلان في هذا الشات.', allowedMentions: { parse: [] } });
    } catch (e) {
      onError(e);
      await i.editReply({ content: sent ? '✅ تم نشر الإعلان؛ تعذر تأكيد العملية سابقًا.' : (/[\u0600-\u06ff]/.test(e.message) ? e.message : 'تعذر تأكيد نشر الإعلان؛ راجع الشات قبل المحاولة مجددًا.'), allowedMentions: { parse: [] } });
    }
    return true;
  };
}
