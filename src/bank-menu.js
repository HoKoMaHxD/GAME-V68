import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { bankMember, requireBankChannel } from './bank.js';
import { balancePayload, commandTimesPayload } from './bank-commands.js';

export function bankMenuPayload() {
  const button = (id, label) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Primary);
  return { content: 'اختر من الأزرار لاستعراض أوامر البنك ومهامك وألعابك.', embeds: [],
    allowedMentions: { parse: [] }, components: [
      new ActionRowBuilder().addComponents(button('clan-bank:open', 'توب البنك'), button('bank-menu:v1:commands', 'اوامر'), button('clan-economy:quest', 'مهمتي')),
      new ActionRowBuilder().addComponents(button('bank-menu:v1:games', 'العاب'), button('bank-menu:v1:time', 'وقت'), button('bank-menu:v1:balance', 'رصيدي'))
    ] };
}
export function gamesMenuPayload() {
  const embed = new EmbedBuilder().setColor(0xffffff).setTitle('ألعاب البنك').setDescription(
    '**🔢 ارقام:** اكتب ارقام @عضو المبلغ؛ اختر رقمًا أو رقمين، ومن يصل إلى 15 يخسر.\n**💣 الغام:** اكتب الغام @عضو المبلغ؛ من يختار اللغم يخسر مبلغ التحدّي.\n**🟢 زر:** اكتب زر @عضو المبلغ؛ أول من يضغط الأخضر يفوز بمبلغ خصمه.\n**❌ اكس أو:** اكتب اكس @عضو المبلغ؛ Infinite XO بثلاث علامات لكل لاعب، والرابعة تزيل الأقدم. الفائز يأخذ مبلغ خصمه.\n**🎲 نرد:** ارمِ النرد ضد البوت؛ الرقم الأعلى يفوز.\n'
    + '**🧠 تشابه:** اكتب تشابه؛ اكشف 8 أزواج بمستوى عشوائي: سهل 20، متوسط 16، صعب 12 محاولة، الربح والخسارة 5%–10% من الرصيد وقت النتيجة.\n'
    + '**🚢 سفينة:** اكتب سفينة @عضو المبلغ؛ وزّع سفنك عشوائيًا ثم جاهز. الإصابة تعطي دورًا إضافيًا.\n'
    + '**🔲 مربعات:** اكتب مربعات @عضو المبلغ؛ وصّل النقاط واستحوذ على أكثر مربعات. إكمال مربع يمنحك دورًا إضافيًا.\n'
    + '**🔴 دوت:** اكتب دوت @عضو المبلغ؛ وصّل 4 أقراص أفقيًا أو عموديًا أو قطريًا؛ لكل دور 30 ثانية.\n'
    + '**🎨 ألوان:** وحّد الشبكة بمحاولات محسوبة حسب صعوبتها.\n\n'
    + 'في نرد والوان: الربح والخسارة **5%–10%** من رصيدك وقت النتيجة.\nلكل لعبة انتظار مستقل **20 دقيقة**. في اكس وارقام وزر والغام ودوت ومربعات وسفينة، الانتظار على إرسال التحدّي فقط؛ تقدر تقبل تحديات غيرك أثناءه. اختر لعبة للبدء.');
  return { content: '', embeds: [embed], allowedMentions: { parse: [] }, components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('clan-games:play:dice').setLabel('نرد').setEmoji('🎲').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('clan-games:play:colors').setLabel('الوان').setEmoji('🎨').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('xo:help').setLabel('اكس').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('button-game:help').setLabel('زر').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('mines:help').setLabel('الغام').setStyle(ButtonStyle.Primary)
  ), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('numbers:help').setLabel('ارقام').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('dot:help').setLabel('دوت').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('boxes:help').setLabel('مربعات').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('ship:help').setLabel('سفينة').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId('memory:start').setLabel('تشابه').setStyle(ButtonStyle.Primary))] };
}
export function createBankMenuHandler({ config, service, store, isMember, isBankMember, commandList, onError = () => {} }) {
  return async interaction => {
    if (!interaction.isButton?.()) return false;
    const owner = /^bank-time:v1:(\d{17,20})$/.exec(interaction.customId || '')?.[1];
    const action = owner ? 'time' : /^bank-menu:v1:(commands|games|time|balance)$/.exec(interaction.customId || '')?.[1];
    if (!action) return false;
    if (interaction.guildId !== config.clanGuildId || interaction.user.bot) {
      await interaction.reply({ content: 'القائمة متاحة لأعضاء سيرفر الكلان فقط.', flags: MessageFlags.Ephemeral }); return true;
    }
    if (owner && owner !== interaction.user.id) {
      await interaction.reply({ content: 'هذا الزر لصاحب الأمر فقط؛ اكتب وقت لعرض أوقاتك.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } }); return true;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const settings = await store.settings();
      requireBankChannel(settings?.bank, interaction.channelId);
      const eligible = isBankMember ? await isBankMember(interaction.user.id) : await bankMember(interaction, config, interaction.user.id);
      if (!eligible) throw new Error('القائمة متاحة لأعضاء سيرفر الكلان فقط.');
      let payload;
      if (action === 'commands') payload = commandList(settings?.appearance, interaction.guild);
      else if (action === 'games') payload = gamesMenuPayload();
      else if (action === 'balance') payload = balancePayload(await service.balance(interaction.user.id, interaction.channelId), settings?.appearance, interaction);
      else payload = commandTimesPayload(await service.commandTimes(interaction.user.id, interaction.channelId,
        !!(await isMember?.(interaction.user.id))), settings?.appearance, interaction);
      await interaction.editReply(payload);
    } catch (error) {
      onError(error);
      await interaction.editReply({ content: /[\u0600-\u06ff]/.test(error.message) ? error.message : 'تعذر عرض القائمة. حاول مجددًا.',
        embeds: [], components: [], allowedMentions: { parse: [] } });
    }
    return true;
  };
}
