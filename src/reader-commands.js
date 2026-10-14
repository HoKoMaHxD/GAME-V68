import { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { canConfigurePermissions } from './permissions.js';

const MODAL = 'reader-token-update:';
export function buildReaderCommand() {
  return new SlashCommandBuilder().setName('تحديث').setDescription('تحديث إعدادات اتصال القارئ')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('التوكن').setDescription('تحديث توكن القارئ وفحص الاتصال وحفظه'));
}

export function createReaderHandler({ config, readerRuntime }) {
  return async interaction => {
    const command = interaction.isChatInputCommand?.() && interaction.commandName === 'تحديث';
    const modal = interaction.isModalSubmit?.() && interaction.customId?.startsWith(MODAL);
    if (!command && !modal) return false;
    const reply = content => interaction.reply({ content, flags: MessageFlags.Ephemeral });
    if (!canConfigurePermissions(interaction, config)) {
      await reply('هذا الأمر لمالك سيرفر الكلان أو من لديه صلاحية Administrator فقط.'); return true;
    }
    if (!readerRuntime || config.mode !== 'selfbot') {
      await reply('تحديث توكن القارئ متاح في وضع selfbot فقط.'); return true;
    }
    if (command) {
      if (interaction.options.getSubcommand() !== 'التوكن') return true;
      await interaction.showModal(new ModalBuilder().setCustomId(`${MODAL}${interaction.user.id}`).setTitle('تحديث توكن القارئ')
        .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('token')
          .setLabel('توكن حساب القارئ الجديد').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(512))));
      return true;
    }
    if (interaction.customId !== `${MODAL}${interaction.user.id}`) { await reply('افتح الأمر من حسابك مجددًا.'); return true; }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      await readerRuntime.update(interaction.fields.getTextInputValue('token'), { actorId: interaction.user.id, operationId: interaction.id });
      await interaction.editReply({ content: '✅ تم فحص التوكن وحفظه مشفرًا وتوصيل القارئ الجديد. يجري التحقق من الأعضاء ثم يستأنف الاحتساب تلقائيًا. لا تحتاج ريستارت Render.' });
    } catch {
      // Never echo the token or arbitrary SDK/database error details to Discord.
      await interaction.editReply({ content: '❌ لم يكتمل تحديث القارئ. تحقق من توكن حساب عادي موجود في أرينا ويستطيع مشاهدة الرومات المحددة، وانتظر انتهاء أي محاولة اتصال ثم أعد الأمر. لم يُستبدل القارئ الحالي بمحاولة فاشلة.' });
    }
    return true;
  };
}
