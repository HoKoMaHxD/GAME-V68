import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { themedEmbed } from './appearance.js';
import { canConfigurePermissions } from './permissions.js';

export function buildPermissionCommand() {
  return new SlashCommandBuilder().setName('صلاحية').setDescription('تحديد أو إزالة رتبة إدارة البوت؛ لمالك السيرفر أو Administrator')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addRoleOption(o => o.setName('الرتبة').setDescription('رتبة من سيرفر الكلان تمنح التحكم بكل وظائف إدارة البوت'))
    .addBooleanOption(o => o.setName('ازالة').setDescription('إزالة صلاحية الرتبة الحالية؛ تبقى صلاحيات إدارة السيرفر الأصلية'));
}

export function createPermissionHandler({ config, access, onError = () => {} }) {
  return async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'صلاحية') return false;
    const deny = content => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    if (interaction.guildId !== config.clanGuildId) { await deny('أمر الصلاحية متاح داخل سيرفر الكلان فقط.'); return true; }
    if (!canConfigurePermissions(interaction, config)) {
      await deny('تحديد رتبة إدارة البوت أو تغييرها متاح لمالك السيرفر أو من لديه Administrator فقط.'); return true;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reply = payload => interaction.editReply({ content: '', embeds: [], components: [], allowedMentions: { parse: [] }, ...payload });
    let saved;
    try {
      const selected = interaction.options.getRole('الرتبة');
      const remove = interaction.options.getBoolean('ازالة') === true;
      if (selected && remove) throw new Error('اختر رتبة جديدة أو إزالة الصلاحية في الأمر نفسه، وليس الاثنين.');
      if (selected) {
        const role = await interaction.guild?.roles.fetch(selected.id);
        if (!role || role.guild?.id !== config.clanGuildId) throw new Error('اختر رتبة موجودة في سيرفر الكلان. رتبة أعضاء الكلان في أرينا لا تستخدم هنا.');
        if (role.id === config.clanGuildId) throw new Error('اختر رتبة مخصصة؛ لا يمكن منح صلاحية إدارة البوت إلى @everyone.');
      }
      if (selected || remove) saved = await access.change({ roleId: remove ? null : selected.id,
        actorId: interaction.user.id, operationId: interaction.id });
      const settings = await access.read();
      const current = settings?.botPermissions;
      const role = current?.roleId ? `<@&${current.roleId}>\n\`${current.roleId}\`` : 'لم تُحدد رتبة إضافية لإدارة البوت.';
      await reply({ embeds: [themedEmbed(saved ? (remove ? 'تمت إزالة صلاحية الرتبة' : 'تم حفظ صلاحية إدارة البوت') : 'صلاحية إدارة البوت', settings?.appearance)
        .setDescription(saved ? 'يسري التغيير على الأوامر التالية مباشرة، وهو محفوظ بعد إعادة التشغيل.' : 'استخدم خيار الرتبة لتحديدها، أو ازالة:True لإلغاء صلاحيتها.')
        .addFields(
          { name: 'الرتبة المخولة في سيرفر الكلان', value: role },
          { name: 'التحكم المتاح', value: 'إضافة النقاط وخصمها • ريست عضو أو الجميع\nإدارة المهام اليومية والخاصة • إدارة المنتجات وتنبيهات المتجر\nإعدادات الحضور • إعدادات خصم السبام • تصميم الإيمبد • setup • حالة البوت' },
          { name: 'من يملك التحكم أيضًا؟', value: 'مالك السيرفر ومن لديه إدارة السيرفر أو Administrator. أهلية كسب النقاط والشراء مستقلة عن رتبة الإدارة.' },
          { name: 'تغيير رتبة الإدارة', value: 'مالك السيرفر أو Administrator فقط؛ رتبة إدارة البوت وحدها لا تسمح بتفويض رتبة أخرى.' }
        )] });
    } catch (error) {
      onError(error.cause || error);
      await reply({ content: '❌ ' + (saved ? 'حُفظت الصلاحية، لكن تعذر عرض النتيجة. استخدم /صلاحية للتحقق.'
        : /[\u0600-\u06ff]/.test(error.message) ? error.message : 'تعذر تحديث صلاحية البوت. راجع اتصال قاعدة البيانات وصلاحية الوصول إلى الرتبة.') });
    }
    return true;
  };
}
