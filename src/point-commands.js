import { SlashCommandBuilder, MessageFlags } from 'discord.js';
import { themedEmbed } from './appearance.js';
import { number, safe } from './presentation.js';
import { MAX_POINT_ADJUSTMENT } from './point-adjustments.js';
import { canManageBot, MANAGEMENT_DENIED } from './permissions.js';
import { membershipUnavailable } from './membership-status.js';

const MODES = { 'اضافة_نقاط': 'add', 'ازالة_نقاط': 'remove', 'اضافة_عملة': 'add', 'ازالة_عملة': 'remove' };
export function buildPointCommands() {
  return Object.entries(MODES).map(([name, mode]) => {
    const currency = name.endsWith('عملة');
    const command = new SlashCommandBuilder().setName(name)
    .setDescription(mode === 'add' ? 'إضافة عملة 💵 إلى رصيد عضو من الكلان' : 'خصم عملة 💵 من رصيد عضو محدد')
    .setDefaultMemberPermissions(null)
    .addUserOption(o => o.setName('العضو').setDescription('العضو المطلوب تعديل رصيده').setRequired(true))
    .addIntegerOption(o => o.setName(currency ? 'المبلغ' : 'النقاط').setDescription('مبلغ العملة المراد إضافته أو خصمه').setRequired(true)
      .setMinValue(1).setMaxValue(MAX_POINT_ADJUSTMENT));
    if (!currency) command.addStringOption(o => o.setName('النوع').setDescription('مصدر العملة؛ الافتراضي مكافآت المهام')
      .setChoices({ name: 'مكافآت المهام', value: 'tasks' }, { name: 'مكافآت الحضور', value: 'attendance' }));
    return command.addStringOption(o => o.setName('السبب').setDescription('اختياري: سبب التعديل، يحفظ مع العملية').setMaxLength(200));
  });
}

export function createPointHandler({ config, store, service, isMember, status = () => ({}), access, onError = () => {} }) {
  return async interaction => {
    if (interaction.isButton() || !Object.hasOwn(MODES, interaction.commandName)) return false;
    const deny = content => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    if (interaction.guildId !== config.clanGuildId) {
      await deny('تعديل العملة متاح داخل سيرفر الكلان فقط.'); return true;
    }
    if (!canManageBot(interaction, config, access?.roleId)) {
      await deny(MANAGEMENT_DENIED); return true;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reply = payload => interaction.editReply({ content: '', embeds: [], components: [], allowedMentions: { parse: [] }, ...payload });
    let result;
    try {
      const member = interaction.options.getUser('العضو', true);
      const mode = MODES[interaction.commandName];
      if (member.bot) throw new Error('اختر عضوًا بشريًا لتعديل عملته.');
      if (mode === 'add' && !isMember(member.id)) throw new Error(membershipUnavailable(status())
        || 'إضافة العملة متاحة لأعضاء الكلان المؤهلين فقط. تحقق من عضويته ورتبته في أرينا واكتمال تحميل الأعضاء.');
      const appearance = (await store.settings())?.appearance;
      result = await service.adjustPoints({ userId: member.id, actorId: interaction.user.id,
        operationId: interaction.id, at: interaction.createdTimestamp, mode,
        amount: interaction.options.getInteger(interaction.commandName.endsWith('عملة') ? 'المبلغ' : 'النقاط', true),
        category: interaction.commandName.endsWith('عملة') ? 'total' : interaction.options.getString('النوع') || 'tasks',
        reason: interaction.options.getString('السبب') || '' });
      const label = result.category === 'total' ? 'العملة' : result.category === 'attendance' ? 'مكافآت الحضور' : 'مكافآت المهام';
      const embed = themedEmbed(result.duplicate ? 'العملية مسجلة سابقًا' : mode === 'add' ? 'تمت إضافة العملة' : 'تم خصم العملة', appearance)
        .setDescription(`${result.duplicate ? 'هذه نتيجة العملية المحفوظة؛ لم تتكرر.' : 'تم حفظ تعديل الرصيد.'}\n<@${member.id}> • **${mode === 'add' ? '+' : '−'}${number(result.amount)} $ 💵**`)
        .addFields(
          { name: `رصيد ${label} قبل التعديل`, value: number(result.before), inline: true },
          { name: `رصيد ${label} بعد التعديل`, value: number(result.after), inline: true },
          { name: 'الإجمالي بعد التعديل', value: number(result.totalAfter), inline: true },
          { name: 'تاريخ الاحتساب', value: `${result.day} • بتوقيت السعودية\nتعديل العملة لا يغيّر ترتيب الشات أو الفويس.` },
          { name: 'السبب', value: result.reason ? safe(result.reason) : 'لم يُحدد سبب.' },
          { name: 'منفذ التعديل', value: `<@${result.actorId}>`, inline: true },
          { name: 'معرف العملية', value: `\`${result.operationId}\``, inline: true }
        ).setFooter({ text: 'الأرصدة وقت العملية • التعديل لا يغيّر تقدم المهام أو حد الحضور' });
      await reply({ embeds: [embed] });
    } catch (error) {
      onError(error);
      const message = result ? 'حُفظ تعديل العملة، لكن تعذر عرض النتيجة. راجع /رصيدي قبل إصدار أمر آخر.'
        : error instanceof Error && /[\u0600-\u06ff]/.test(error.message) ? error.message
          : 'تعذر تأكيد نتيجة تعديل العملة. راجع رصيد العضو وسجل Render قبل إعادة الأمر.';
      await reply({ content: `❌ ${message}` });
    }
    return true;
  };
}
