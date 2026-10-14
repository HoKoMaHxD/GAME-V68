import { SlashCommandBuilder, MessageFlags, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { attachmentImageUrl } from './appearance.js';
import { number, safe } from './presentation.js';
import { canManageBot, MANAGEMENT_DENIED } from './permissions.js';
import { AUCTION_ROLE_ID, MAX_AUCTION_AMOUNT, auctionStartTime, auctionIncrement, auctionTerminal } from './auction.js';
import { auctionKey } from './auction-views.js';
import { checkAuctionChannel } from './auction-manager.js';

export function buildAuctionCommands() {
  return [
    new SlashCommandBuilder().setName('مزاد').setDescription('إنشاء مزاد مجدول لمدة 5 دقائق بتوقيت السعودية')
      .setDefaultMemberPermissions(null)
      .addStringOption(o => o.setName('الاسم').setDescription('اسم المنتج').setRequired(true).setMaxLength(80))
      .addStringOption(o => o.setName('الوصف').setDescription('وصف المنتج وشروط التسليم').setRequired(true).setMaxLength(1000))
      .addAttachmentOption(o => o.setName('الصورة').setDescription('صورة المنتج PNG أو JPEG أو GIF أو WebP').setRequired(true))
      .addIntegerOption(o => o.setName('العدد').setDescription('كامل العدد صفقة واحدة للفائز').setRequired(true).setMinValue(1).setMaxValue(100000))
      .addStringOption(o => o.setName('التاريخ').setDescription('تاريخ البدء YYYY-MM-DD بتوقيت السعودية').setRequired(true).setMinLength(10).setMaxLength(10))
      .addStringOption(o => o.setName('الوقت').setDescription('وقت البدء HH:MM بنظام 24 ساعة بتوقيت السعودية').setRequired(true).setMinLength(5).setMaxLength(5))
      .addIntegerOption(o => o.setName('مبلغ_البداية').setDescription('سعر افتتاح المزاد لكامل العدد').setRequired(true).setMinValue(1).setMaxValue(MAX_AUCTION_AMOUNT)),
    new SlashCommandBuilder().setName('الغاء_مزاد').setDescription('إلغاء مزاد وإرجاع أي مبلغ محجوز لأعلى مزايد')
      .setDefaultMemberPermissions(null)
      .addStringOption(o => o.setName('المعرف').setDescription('رقم المزاد الظاهر أسفل الإيمبد').setRequired(true).setMinLength(17).setMaxLength(20))
      .addStringOption(o => o.setName('السبب').setDescription('سبب الإلغاء الذي يظهر للأعضاء').setMaxLength(200))
  ];
}

export function parseAuctionAction(id) {
  const button = /^clan-auction:v1:(\d{17,20}):(opening|500|1000|custom)$/.exec(id || '');
  if (button) return { auctionId: button[1], kind: button[2] };
  const modal = /^clan-auction:v1:(\d{17,20}):submit:(\d{17,20}):(\d{1,10})$/.exec(id || '');
  return modal ? { auctionId: modal[1], kind: 'submit', ownerId: modal[2], expectedAmount: Number(modal[3]) } : null;
}

export function createAuctionHandler({ config, service, bot, isMember, access, auctions, onError = () => {} }) {
  return async interaction => {
    const command = interaction.isChatInputCommand?.() && ['مزاد', 'الغاء_مزاد'].includes(interaction.commandName);
    const scoped = interaction.customId?.startsWith('clan-auction:');
    if (!command && !scoped) return false;
    const deny = content => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    if (interaction.guildId !== config.clanGuildId) { await deny('المزادات متاحة داخل سيرفر الكلان فقط.'); return true; }
    if (command && !canManageBot(interaction, config, access?.roleId)) { await deny(MANAGEMENT_DENIED); return true; }
    if (!command && (!isMember(interaction.user.id) || interaction.user.bot)) { await deny('المزايدة متاحة لأعضاء الكلان المؤهلين فقط.'); return true; }
    const action = scoped ? parseAuctionAction(interaction.customId) : null;
    if (scoped && (!action || (action.ownerId && action.ownerId !== interaction.user.id)
      || (action.kind === 'submit' ? !interaction.isModalSubmit?.() : !interaction.isButton?.()))) {
      await deny('زر المزايدة غير صالح. استخدم رسالة المزاد الحالية.'); return true;
    }
    let saved = false;
    try {
      if (action?.kind === 'custom') {
        const a = await service.auctionRead(action.auctionId);
        if (!a || a.channelId !== interaction.channelId || a.delivery.live.messageId !== interaction.message?.id
          || a.status !== 'active' || service.clock() >= a.endsAt) throw new Error('المزاد غير متاح للمزايدة الآن.');
        await interaction.showModal(new ModalBuilder()
          .setCustomId(`${auctionKey(a.id, 'submit')}:${interaction.user.id}:${a.amount}`)
          .setTitle(`زيادة على السوم ${number(a.amount)}`)
          .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
            .setCustomId('increment').setLabel('كم تريد أن تزيد على السوم الحالي؟')
            .setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(10)
            .setPlaceholder('مثال: 750 تعني إضافة 750 إلى السوم'))));
        return true;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      let message;
      let auctionId = action?.auctionId;
      if (command && interaction.commandName === 'مزاد') {
        await checkAuctionChannel(bot, config.clanGuildId, interaction.channelId, AUCTION_ROLE_ID);
        const options = interaction.options;
        const a = await service.createAuction({ id: interaction.id, createdBy: interaction.user.id, channelId: interaction.channelId,
          name: options.getString('الاسم', true), description: options.getString('الوصف', true),
          imageUrl: attachmentImageUrl(options.getAttachment('الصورة', true)), quantity: options.getInteger('العدد', true),
          startsAt: auctionStartTime(options.getString('التاريخ', true), options.getString('الوقت', true)),
          startPrice: options.getInteger('مبلغ_البداية', true) });
        saved = true; auctionId = a.id;
        message = `✅ حُفظ مزاد **${safe(a.name)}** في هذا الروم. يبدأ <t:${Math.floor(a.startsAt / 1000)}:F> بتوقيت العرض لديك.\n`
          + `الوقت المُدخل بتوقيت السعودية. كامل العدد **${number(a.quantity)}** للفائز.\nرقم المزاد: \`${a.id}\`.`;
      } else if (command) {
        auctionId = interaction.options.getString('المعرف', true).trim();
        if (!/^\d{17,20}$/.test(auctionId)) throw new Error('انسخ رقم المزاد من أسفل الإيمبد.');
        const before = await service.auctionRead(auctionId);
        if (!before) throw new Error('لم أجد هذا المزاد.');
        if (auctionTerminal(before)) throw new Error('هذا المزاد انتهى أو أُلغي بالفعل.');
        const a = await service.settleAuction(auctionId, { actorId: interaction.user.id, operationId: interaction.id,
          reason: interaction.options.getString('السبب') });
        if (a.status !== 'cancelled') throw new Error('انتهى المزاد بالفعل وثُبتت نتيجته.');
        saved = true;
        message = `✅ أُلغي المزاد \`${a.id}\`. المبلغ المُعاد: **${number(a.settlement.refundedAmount)} $ 💵**.`;
      } else {
        const result = await service.bidAuction({ auctionId, userId: interaction.user.id, operationId: interaction.id,
          channelId: interaction.channelId, messageId: interaction.message?.id, at: interaction.createdTimestamp,
          opening: action.kind === 'opening',
          increment: action.kind === 'submit' ? auctionIncrement(interaction.fields.getTextInputValue('increment')) : Number(action.kind),
          ...(action.kind === 'submit' ? { expectedAmount: action.expectedAmount } : {}) }, () => isMember(interaction.user.id));
        saved = true;
        message = `✅ ${result.duplicate ? 'مزايدتك مسجلة مسبقًا' : 'قُبلت مزايدتك'}: **${number(result.amount)} $ 💵**.\n`
          + `حُجز من رصيدك في هذه العملية **${number(result.chargedNow)}**. رصيدك بعدها **${number(result.balanceAfter)}**.`
          + (result.extended ? '\n⏱️ تمدد المزاد 30 ثانية إضافية.' : '');
      }
      await interaction.editReply({ content: message, allowedMentions: { parse: [] } });
      // A Discord outage must not turn a committed bid into a reported failure.
      // Periodic recovery republishes the current state after restart or API errors.
      if (auctions) {
        try { await auctions.refresh(auctionId); }
        catch (error) {
          onError(error);
          await interaction.editReply({ content: `${message}\n⏳ العملية محفوظة؛ تعذر تحديث إعلان المزاد الآن وسيُعاد تلقائيًا.`, allowedMentions: { parse: [] } });
        }
      }
    } catch (error) {
      onError(error);
      const content = saved ? 'العملية محفوظة. راجع رسالة المزاد ورصيدك قبل إرسال طلب جديد.'
        : /[\u0600-\u06ff]/.test(error.message) ? error.message : 'تعذر تأكيد الطلب. راجع حالة المزاد وسجل البوت قبل المحاولة مجددًا.';
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: `❌ ${content}`, allowedMentions: { parse: [] } });
      else await deny(`❌ ${content}`);
    }
    return true;
  };
}
