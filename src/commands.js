import { buildReaderCommand, createReaderHandler } from './reader-commands.js';
import { buildShipCommand, createShipHandler } from './ship-game-commands.js';
import { buildRuntimeCommand, createRuntimeHandler, PAUSED_MESSAGE } from './runtime-control.js';
import { RESET_RUNNING_MESSAGE } from './full-reset-control.js';
import { buildSpamCommand, createSpamHandler } from './spam-commands.js';
import { buildAnnouncementCommand, createAnnouncementHandler } from './announcement-commands.js';
import { buildBoostCommand, createBoostHandler } from './task-boost-commands.js';
import { buildMemoryCommand, createMemoryHandler } from './memory-commands.js';
import { buildBoxesCommand, createBoxesHandler } from './boxes-game-commands.js';
import { buildDotCommand, createDotHandler } from './dot-game-commands.js';
import { buildNumbersCommand, createNumbersHandler } from './numbers-game-commands.js';
import { buildMinesCommand, createMinesHandler } from './mines-game-commands.js';
import { buildButtonCommand, createButtonHandler } from './button-game-commands.js';
import { buildXoCommand, createXoHandler } from './xo-commands.js';
import { buildMiniCommands, createMiniHandler } from './mini-game-commands.js';
import { createBankMenuHandler } from './bank-menu.js';
import { randomUUID } from 'node:crypto';
import {
  SlashCommandBuilder, MessageFlags,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType
} from 'discord.js';
import { validateTemplate, DAILY_TASK_COUNT } from './domain.js';
import { dayKey } from './time.js';
import { isId } from './config.js';
import { clanVoiceChannels, taskChannels } from './voice-channels.js';
import { PUBLIC_VOICE_TASK_ID } from './public-voice-task.js';
import { messageTaskTitle } from './message-channels.js';
import { createDailyQuestHandler } from './daily-quest-views.js';
import { buildBankTopCommand, createBankLeaderboardHandler } from './bank-leaderboard.js';
import { parsePanelAction, personalNavigation, DEFAULT_PANEL_MINUTES } from './panel.js';
import { attachmentImageUrl, readAppearance, themedEmbed, validateAppearancePatch } from './appearance.js';
import { safe, specialTasksEmbed, rulesEmbed } from './presentation.js';
import { activityView } from './activity-views.js';
import { commandsPanel, buildExperienceCommands, createExperienceHandler } from './experience-commands.js';
import { specialTaskPage, validateSpecialTask, MAX_SPECIAL_REWARD } from './special-tasks.js';
import { buildResetCommands, createResetHandler } from './reset-commands.js';
import { buildPointCommands, createPointHandler } from './point-commands.js';
import { buildShopCommands, createShopHandler } from './shop-commands.js';
import { buildPermissionCommand, createPermissionHandler } from './permission-commands.js';
import { canManageBot, MANAGEMENT_DENIED } from './permissions.js';
import { buildRobberyCommand, createRobberyHandler } from './robbery-commands.js';
import { buildBankCommands, createBankHandler, balancePayload } from './bank-commands.js';
import { buildAuctionCommands, createAuctionHandler } from './auction-commands.js';
import { createNotificationHandler } from './member-notifications.js';
export { tasksEmbed } from './presentation.js';
const countOption = (sub, name, desc, max, required = false) => sub.addIntegerOption(o => o.setName(name).setDescription(desc).setMinValue(1).setMaxValue(max).setRequired(required));

export function buildCommands() {
  const setup = new SlashCommandBuilder().setName('setup').setDescription('إرسال لوحة الترتيب الشخصي وزر التنبيهات وتجديدها تلقائيًا')
    .setDefaultMemberPermissions(null)
    .addChannelOption(o => o.setName('الروم').setDescription('روم اللوحة؛ الافتراضي الروم الحالي').addChannelTypes(ChannelType.GuildText))
    .addIntegerOption(o => o.setName('التجديد').setDescription('كل كم دقيقة تعاد الرسالة؛ الافتراضي 60').setMinValue(1).setMaxValue(1440));
  const tasks = new SlashCommandBuilder().setName('مهامي').setDescription('مهامك اليومية وتقدمها والمتبقي؛ تتحدث تلقائيًا كل 15 ثانية');
  const special = new SlashCommandBuilder().setName('مهمات_خاصة').setDescription('عرض المهمات الخاصة ومكافآتها التي تضيفها الإدارة يدويًا')
    .addIntegerOption(o => o.setName('الصفحة').setDescription('صفحة المهمات الخاصة').setMinValue(1).setMaxValue(100));
  const points = new SlashCommandBuilder().setName('نقاطي').setDescription('رصيد عملتك 💵 — الاسم السابق لأمر رصيدي');
  const admin = new SlashCommandBuilder().setName('ادارة_المهام').setDescription('إدارة قوالب المهام اليومية والمهمات الخاصة اليدوية')
    .setDefaultMemberPermissions(null)
    .addSubcommand(s => {
      s.setName('اضافة').setDescription('إضافة قالب للمهام اليومية التلقائية');
      s.addStringOption(o => o.setName('الاسم').setDescription('اسم المهمة').setRequired(true).setMaxLength(100));
      s.addStringOption(o => o.setName('النوع').setDescription('نوع الإنجاز').setRequired(true).setChoices(
        { name: 'عدد الرسائل', value: 'messages' }, { name: 'دقائق الصوت', value: 'voice' }, { name: 'أقيام الألعاب', value: 'games' }));
      s.addStringOption(o => o.setName('الروم').setDescription('ID الروم في أرينا، وليس اسم الروم').setRequired(true));
      countOption(s, 'العدد', 'عدد الرسائل أو الدقائق أو الأقيام المطلوب لكل إنجاز', 100000, true);
      countOption(s, 'النقاط', 'مكافأة كل إنجاز كامل', 100000, true);
      countOption(s, 'التكرار', 'عدد مرات مكافأة هذه المهمة في اليوم؛ الافتراضي 1', 20);
      s.addBooleanOption(o => o.setName('منشن_الكلان').setDescription('يشترط منشن رتبة الكلان في نفس الرسالة'));
      s.addBooleanOption(o => o.setName('صور_او_فيديو').setDescription('يشترط وجود صورة أو فيديو في نفس الرسالة'));
      s.addUserOption(o => o.setName('عضو').setDescription('اختياري: حصر هذا القالب في عضو محدد'));
      return s;
    })
    .addSubcommand(s => {
      s.setName('تعديل').setDescription('تعديل القالب للتعيينات القادمة؛ يحفظ تقدم اليوم والأرصدة');
      s.addStringOption(o => o.setName('المعرف').setDescription('معرف القالب من قائمة المهام').setRequired(true));
      s.addStringOption(o => o.setName('الاسم').setDescription('الاسم الجديد').setMaxLength(100));
      s.addStringOption(o => o.setName('الروم').setDescription('ID الروم الجديد في أرينا'));
      countOption(s, 'العدد', 'العدد أو الدقائق الجديد', 100000);
      countOption(s, 'النقاط', 'المكافأة الجديدة', 100000);
      countOption(s, 'التكرار', 'أقصى تكرار يومي جديد', 20);
      s.addBooleanOption(o => o.setName('منشن_الكلان').setDescription('اشتراط منشن رتبة الكلان في نفس الرسالة'));
      s.addBooleanOption(o => o.setName('صور_او_فيديو').setDescription('اشتراط صورة أو فيديو في نفس الرسالة'));
      return s;
    });
  admin.addSubcommand(s => {
    s.setName('اضافة_مهمة_خاصة').setDescription('إضافة مهمة إلى القائمة الخاصة؛ تمنح عملتها يدويًا')
      .addStringOption(o => o.setName('الاسم').setDescription('اسم المهمة الخاصة').setRequired(true).setMaxLength(100));
    countOption(s, 'النقاط', 'مكافأة العملة التي يمنحها المسؤول عند إنجازها', MAX_SPECIAL_REWARD, true);
    return s;
  });
  for (const name of ['تعطيل', 'تفعيل']) admin.addSubcommand(s => s.setName(name).setDescription(`${name} قالب للتعيينات اليومية القادمة`)
    .addStringOption(o => o.setName('المعرف').setDescription('معرف القالب').setRequired(true)));
  admin.addSubcommand(s => s.setName('قائمة').setDescription('قوالب المهام وأرقامها')
    .addIntegerOption(o => o.setName('الصفحة').setDescription('صفحة القوالب').setMinValue(1).setMaxValue(100)));
  const attendance = new SlashCommandBuilder().setName('اعدادات_الحضور').setDescription('عرض أو تغيير شروط احتساب الوقت للمهام الصوتية وتوب الفويس')
    .setDefaultMemberPermissions(null);
  countOption(attendance, 'اقل_عدد', 'الحد الأدنى للبشر بالروم؛ 1 يسمح بالوجود منفردًا', 100);
  attendance.addBooleanOption(o => o.setName('تجاهل_الميوت').setDescription('عدم احتساب الميكروفون المكتوم في المهام وتوب الفويس'))
    .addBooleanOption(o => o.setName('تجاهل_الديفن').setDescription('عدم احتساب كتم السماعات في المهام وتوب الفويس'));
  const rules = new SlashCommandBuilder().setName('الية_الاحتساب').setDescription('كيف تُحسب المهام وترتيب النشاط ومتى تتجدد');
  const design = new SlashCommandBuilder().setName('تصميم_الامبد').setDescription('تخصيص اسم ولون وصور إيمبدات الكلان أو معاينة التصميم')
    .setDefaultMemberPermissions(null)
    .addStringOption(o => o.setName('الاسم').setDescription('اسم الكلان أعلى الإيمبد').setMaxLength(50))
    .addStringOption(o => o.setName('اللون').setDescription('لون HEX، مثل #8FD6FF').setMaxLength(7))
    .addStringOption(o => o.setName('الصورة').setDescription('رابط HTTPS مباشر لبانر كبير أسفل الإيمبد').setMaxLength(2000))
    .addStringOption(o => o.setName('المصغرة').setDescription('رابط HTTPS مباشر للصورة المصغرة أعلى اليمين').setMaxLength(2000))
    .addAttachmentOption(o => o.setName('ملف_الصورة').setDescription('ارفع صورة البانر مباشرة بدل استخدام رابط'))
    .addAttachmentOption(o => o.setName('ملف_المصغرة').setDescription('ارفع الصورة المصغرة مباشرة بدل استخدام رابط'))
    .addBooleanOption(o => o.setName('حذف_الصورة').setDescription('إزالة البانر الكبير'))
    .addBooleanOption(o => o.setName('حذف_المصغرة').setDescription('إزالة الصورة المصغرة'));
  const status = new SlashCommandBuilder().setName('حالة_البوت').setDescription('فحص القارئ والقنوات والحفظ')
    .setDefaultMemberPermissions(null);
  return [buildReaderCommand(), buildRuntimeCommand(), buildSpamCommand(), tasks, special, points, admin, attendance, status, setup, rules, design, ...buildExperienceCommands(), buildBankTopCommand(), ...buildBankCommands(), ...buildMiniCommands(), buildXoCommand(), buildButtonCommand(), buildMinesCommand(), buildNumbersCommand(), buildDotCommand(), buildBoxesCommand(), buildShipCommand(), buildMemoryCommand(), buildBoostCommand(), buildAnnouncementCommand(), buildRobberyCommand(), ...buildResetCommands(), ...buildPointCommands(), ...buildShopCommands(), buildPermissionCommand(), ...buildAuctionCommands()].map(c => c.setDMPermission(false).toJSON());
}

export function createHandler(ctx) {
  const { config, service, store, isMember, validateChannel, refreshSettings, status, panel, access } = ctx;
  const adminNames = new Set(['ادارة_المهام', 'اعدادات_الحضور', 'حالة_البوت', 'setup', 'تصميم_الامبد']);
  const resetHandler = createResetHandler(ctx);
  const pointHandler = createPointHandler(ctx);
  const shopHandler = createShopHandler(ctx);
  const permissionHandler = createPermissionHandler(ctx);
  const experienceHandler = createExperienceHandler(ctx);
  const robberyHandler = createRobberyHandler(ctx);
  const bankHandler = createBankHandler(ctx);
  const bankMenuHandler = createBankMenuHandler({ ...ctx, commandList: commandsPanel });
  const miniHandler = createMiniHandler(ctx);
  const xoHandler = createXoHandler(ctx);
  const buttonGameHandler = createButtonHandler(ctx);
  const minesHandler = createMinesHandler(ctx);
  const memoryHandler = createMemoryHandler(ctx);
  const dotHandler = createDotHandler(ctx);
  const shipHandler = createShipHandler(ctx);
  const boxesHandler = createBoxesHandler(ctx);
  const numbersHandler = createNumbersHandler(ctx);
  const announcementHandler = createAnnouncementHandler(ctx);
  const boostHandler = createBoostHandler(ctx);
  const auctionHandler = createAuctionHandler(ctx);
  const notificationHandler = createNotificationHandler(ctx);
  const dailyHandler = createDailyQuestHandler(ctx);
  const bankLeaderboardHandler = createBankLeaderboardHandler(ctx);
  const readerHandler = createReaderHandler(ctx);
  const runtimeHandler = createRuntimeHandler(ctx);
  const spamHandler = createSpamHandler(ctx);
  return async interaction => {
    if (await readerHandler(interaction)) return;
    if (await runtimeHandler(interaction)) return;
    if (await resetHandler(interaction)) return;
    if (service?.paused) {
      if (interaction.isChatInputCommand?.() || interaction.isButton?.() || interaction.isModalSubmit?.() || interaction.isStringSelectMenu?.()) {
        await interaction.reply({ content: service.resetting ? RESET_RUNNING_MESSAGE : PAUSED_MESSAGE, flags: MessageFlags.Ephemeral });
      }
      return;
    }
    if (await spamHandler(interaction)) return;
    if (await notificationHandler(interaction)) return;
    if (await dailyHandler(interaction)) return;
    if (await bankLeaderboardHandler(interaction)) return;
    if (await auctionHandler(interaction)) return;
    if (await boostHandler(interaction)) return;
    if (await announcementHandler(interaction)) return;
    if (await memoryHandler(interaction)) return;
    if (await dotHandler(interaction)) return;
    if (await shipHandler(interaction)) return;
    if (await boxesHandler(interaction)) return;
    if (await numbersHandler(interaction)) return;
    if (await minesHandler(interaction)) return;
    if (await buttonGameHandler(interaction)) return;
    if (await xoHandler(interaction)) return;
    if (await miniHandler(interaction)) return;
    if (await bankMenuHandler(interaction)) return;
    if (await bankHandler(interaction)) return;
    if (await robberyHandler(interaction)) return;
    if (await experienceHandler(interaction)) return;
    if (await permissionHandler(interaction)) return;
    if (await shopHandler(interaction)) return;
    const button = interaction.isButton();
    if (!interaction.isChatInputCommand() && !button) return;
    if (await pointHandler(interaction)) return;
    const action = button ? parsePanelAction(interaction.customId) : null;
    const taskRefresh = button && interaction.customId.startsWith('quests:');
    if (button && !taskRefresh && !action) return;
    const name = button ? (action?.kind === 'top' ? 'المتصدرين' : action?.kind === 'points' ? 'نقاطي'
      : action?.kind === 'rules' ? 'الية_الاحتساب' : action?.kind === 'special' ? 'مهمات_خاصة' : 'مهامي')
      : interaction.commandName;
    if (interaction.guildId !== config.clanGuildId) {
      await interaction.reply({ content: 'هذا البوت مخصص لسيرفر الكلان فقط.', flags: MessageFlags.Ephemeral });
      return;
    }
    if ((taskRefresh && interaction.customId !== `quests:${interaction.user.id}`)
      || (action?.ownerId && action.ownerId !== interaction.user.id)) {
      await interaction.reply({ content: 'هذه لوحة عضو آخر. استخدم /مهامي.', flags: MessageFlags.Ephemeral });
      return;
    }
    const admin = canManageBot(interaction, config, access?.roleId);
    if (adminNames.has(name) && !admin) {
      await interaction.reply({ content: MANAGEMENT_DENIED, flags: MessageFlags.Ephemeral });
      return;
    }
    if (name === 'مهامي' && !isMember(interaction.user.id)) {
      await interaction.reply({ content: membershipUnavailable(status?.()) || (config.memberRole
        ? 'تحتاج رتبة أعضاء الكلان المحددة في سيرفر أرينا، مع عضويتك في سيرفر الكلان. قد يكون تحميل الأعضاء لم يكتمل بعد.'
        : 'لم يكتمل التحقق من عضويتك في سيرفر الكلان بعد.'), flags: MessageFlags.Ephemeral });
      return;
    }
    if (taskRefresh || action?.update) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reply = payload => interaction.editReply({ allowedMentions: { parse: [] }, ...payload });
    try {
      const currentSettings = store.settings ? await store.settings() : {};
      let appearance = readAppearance(currentSettings?.appearance);
      if (name === 'setup') {
        const channelId = interaction.options.getChannel('الروم')?.id || interaction.channelId;
        const minutes = interaction.options.getInteger('التجديد') ?? DEFAULT_PANEL_MINUTES;
        const created = await panel.setup(channelId, minutes);
        if (!created) throw new Error('البوت غير جاهز لتجهيز اللوحة حاليًا.');
        return await reply({ content: `✅ تم إرسال اللوحة في <#${channelId}>. تتجدد كل **${minutes} دقيقة**، وإعدادها محفوظ بعد إعادة التشغيل.` });
      }
      if (name === 'مهمات_خاصة') {
        const tasks = currentSettings?.specialTasks || [];
        const requested = action?.page || (!button ? interaction.options.getInteger('الصفحة') : null) || 1;
        const { page, pages } = specialTaskPage(tasks, requested);
        const components = [personalNavigation(interaction.user.id, 'special')];
        if (pages > 1) components.push(new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`clan-special:v1:${interaction.user.id}:${Math.max(1, page - 1)}:previous`)
            .setLabel('السابق').setStyle(ButtonStyle.Secondary).setDisabled(page === 1),
          new ButtonBuilder().setCustomId(`clan-special:v1:${interaction.user.id}:${Math.min(pages, page + 1)}:next`)
            .setLabel('التالي').setStyle(ButtonStyle.Secondary).setDisabled(page === pages)
        ));
        return await reply({ content: '', embeds: [specialTasksEmbed(tasks, page, appearance)], components });
      }
      if (name === 'نقاطي') {
        return await reply(balancePayload(await service.balance(interaction.user.id), appearance, interaction));
      }
      if (name === 'الية_الاحتساب') {
        return await reply({ content: '', embeds: [rulesEmbed(config, currentSettings?.attendance || config.attendance, appearance)],
          components: [personalNavigation(interaction.user.id, 'rules')] });
      }
      if (name === 'تصميم_الامبد') {
        const input = {};
        for (const [key, option] of [['name', 'الاسم'], ['color', 'اللون'], ['imageUrl', 'الصورة'], ['thumbnailUrl', 'المصغرة']]) {
          const value = interaction.options.getString(option);
          if (value !== null) input[key] = value;
        }
        for (const [key, option] of [['imageUrl', 'ملف_الصورة'], ['thumbnailUrl', 'ملف_المصغرة']]) {
          const attachment = interaction.options.getAttachment?.(option);
          if (attachment) {
            if (Object.hasOwn(input, key)) throw new Error('اختر رابط الصورة أو رفع ملفها، وليس الاثنين للصورة نفسها.');
            input[key] = attachmentImageUrl(attachment);
          }
        }
        for (const [key, option] of [['imageUrl', 'حذف_الصورة'], ['thumbnailUrl', 'حذف_المصغرة']]) {
          if (interaction.options.getBoolean(option)) {
            if (Object.hasOwn(input, key)) throw new Error('اختر إضافة الصورة أو حذفها في الأمر نفسه، وليس الاثنين.');
            input[key] = null;
          }
        }
        const fields = validateAppearancePatch(input);
        let note = 'هذه معاينة التصميم الحالي. يمكنك تحديد الاسم واللون والصور في الأمر نفسه.';
        if (Object.keys(fields).length) {
          const saved = await store.setAppearance(fields);
          appearance = readAppearance(saved.appearance);
          try {
            const updated = await panel.refreshAppearance();
            note = updated ? '✅ تم حفظ التصميم وتحديث لوحة الكلان الحالية.' : '✅ تم حفظ التصميم. استخدم setup لإرسال لوحة الكلان.';
          } catch (error) {
            ctx.onError(error);
            note = '✅ تم حفظ التصميم. تعذر تحديث الرسالة الحالية؛ سيحاول البوت مجددًا في دورة التحديث القادمة.';
          }
        }
        return await reply({ embeds: [themedEmbed('تصميم إيمبدات الكلان', appearance)
          .setDescription(note).addFields(
            { name: 'الاسم', value: safe(appearance.name), inline: true },
            { name: 'اللون', value: `\`#${appearance.color.toString(16).padStart(6, '0').toUpperCase()}\``, inline: true },
            { name: 'الصور', value: `البانر: **${appearance.imageUrl ? 'مضاف' : 'بدون صورة'}** • المصغرة: **${appearance.thumbnailUrl ? 'مضافة' : 'بدون صورة'}**` }
          )], components: [] });
      }
      if (name === 'المتصدرين') {
        const period = action?.period || interaction.options.getString('الفترة') || 'all';
        const page = action?.page || interaction.options.getInteger('الصفحة') || 1;
        return await reply(await activityView({ store, config, ownerId: interaction.user.id, appearance, personal: true, period, page }));
      }
      if (name === 'ادارة_المهام') {
        const sub = interaction.options.getSubcommand();
        if (sub === 'اضافة_مهمة_خاصة') {
          const fields = validateSpecialTask({ title: interaction.options.getString('الاسم'), reward: interaction.options.getInteger('النقاط') });
          const { task, duplicate } = await store.addSpecialTask({ ...fields, id: interaction.id, createdBy: interaction.user.id });
          return await reply({ content: `✅ ${duplicate ? 'المهمة الخاصة مسجلة بالفعل' : 'تمت إضافة المهمة الخاصة'}: **${safe(task.title)}**\n`
            + `المكافأة: **${task.reward} $ 💵**. تظهر في أمر /مهمات_خاصة.\n`
            + 'تمنح عملتها يدويًا بواسطة /اضافة_نقاط بعد التحقق من الإنجاز.',
            components: [personalNavigation(interaction.user.id, 'special')] });
        }
        const templates = await store.templates();
        if (sub === 'قائمة') {
          const page = interaction.options.getInteger('الصفحة') || 1;
          const list = templates.slice((page - 1) * 10, page * 10);
          return await reply({ embeds: [themedEmbed(`قوالب المهام • ${page}`, appearance)
            .setDescription(list.map(t => `${t.enabled ? '🟢' : '⏸️'} **${safe(messageTaskTitle(t, config))}**\n`
              + `المعرف: \`${t.id}\` • ${t.type === 'voice' ? 'دقائق' : t.type === 'games' ? 'أقيام' : 'رسائل'}: ${t.target} • المكافأة: ${t.reward} • تكرار: ${t.repeat}`
              + `\n${t.categoryIds?.length ? 'كاتقوريات الرومات الصوتية' : 'الرومات'}: ${(t.categoryIds || taskChannels(t, config)).map(id => `<#${id}>`).join('، ')}`
              + (t.requiredRoleId ? ` • منشن <@&${t.requiredRoleId}>` : '')
              + (t.requiresMedia ? ' • صورة أو فيديو' : '')
              + (t.forUser ? ` • مخصص لـ <@${t.forUser}>` : '')).join('\n\n') || 'لا توجد قوالب.')
            .setFooter({ text: '5 مهام أساسية + مهمة ألعاب + مهمة الرومات العامة عند تفعيلها. التعديلات تسري على التعيينات الجديدة؛ تقدم اليوم محفوظ.' })] });
        }
        if (sub === 'اضافة') {
          const forUser = interaction.options.getUser('عضو');
          if (forUser && !isMember(forUser.id)) throw new Error('العضو المختار ليس ضمن أعضاء الكلان المؤهلين.');
          const task = validateTemplate({
            id: randomUUID().slice(0, 8), title: interaction.options.getString('الاسم'), type: interaction.options.getString('النوع'),
            channelId: interaction.options.getString('الروم').trim(), target: interaction.options.getInteger('العدد'),
            reward: interaction.options.getInteger('النقاط'), repeat: interaction.options.getInteger('التكرار') || 1,
            enabled: true, forUser: forUser?.id || null, createdAt: Date.now(),
            requiredRoleId: interaction.options.getBoolean('منشن_الكلان') ? config.memberRole : null,
            requiresMedia: interaction.options.getBoolean('صور_او_فيديو') || false
          });
          validateGameChannel(task, config);
          const personalLimit = task.type === 'games' ? 1 : DAILY_TASK_COUNT;
          if (task.forUser && templates.filter(t => t.enabled && t.forUser === task.forUser
            && (t.type === 'games') === (task.type === 'games')).length >= personalLimit) throw new Error(`لهذا العضو ${personalLimit} قوالب خاصة من هذه المجموعة بالفعل. عطل واحدًا أولًا.`);
          await validateChannel(task.channelId, task.type);
          await store.addTemplate(task);
          await refreshSettings();
          return await reply({ content: `✅ حُفظ **${safe(task.title)}** في قوالب المهام اليومية. المعرف: \`${task.id}\`\nيدخل القالب في التعيينات الجديدة تلقائيًا. تقدم المهام المسندة اليوم يبقى محفوظًا.` });
        }
        const id = interaction.options.getString('المعرف').trim();
        const old = templates.find(t => t.id === id);
        if (!old) throw new Error('معرف المهمة غير موجود. استخدم /ادارة_المهام قائمة.');
        const fields = {};
        if (sub === 'تعديل') {
          for (const [key, option] of [['target', 'العدد'], ['reward', 'النقاط'], ['repeat', 'التكرار']]) {
            const value = interaction.options.getInteger(option); if (value !== null) fields[key] = value;
          }
          const title = interaction.options.getString('الاسم'); if (title) fields.title = title;
          const channel = interaction.options.getString('الروم');
          if (channel) { fields.channelId = channel.trim(); await validateChannel(fields.channelId, old.type); }
          const mention = interaction.options.getBoolean('منشن_الكلان');
          if (mention !== null) fields.requiredRoleId = mention ? config.memberRole : null;
          const media = interaction.options.getBoolean('صور_او_فيديو');
          if (media !== null) fields.requiresMedia = media;
          validateTemplate({ ...old, ...fields });
          validateGameChannel({ ...old, ...fields }, config);
          if (!Object.keys(fields).length) throw new Error('حدد قيمة واحدة على الأقل لتعديلها.');
        } else {
          fields.enabled = sub === 'تفعيل';
          if (!fields.enabled && old.type !== 'games' && old.id !== PUBLIC_VOICE_TASK_ID && !old.forUser && templates.filter(t => t.enabled && t.type !== 'games' && t.id !== PUBLIC_VOICE_TASK_ID && !t.forUser && t.id !== id).length < DAILY_TASK_COUNT) throw new Error(`يجب إبقاء ${DAILY_TASK_COUNT} قوالب عامة نشطة على الأقل. أضف بديلًا أولًا.`);
          const personalLimit = old.type === 'games' ? 1 : DAILY_TASK_COUNT;
          if (fields.enabled && old.forUser && templates.filter(t => t.enabled && t.forUser === old.forUser && t.id !== id
            && (t.type === 'games') === (old.type === 'games')).length >= personalLimit) throw new Error(`لا يمكن تفعيل أكثر من ${personalLimit} مهام خاصة من هذه المجموعة للعضو.`);
          if (fields.enabled) validateGameChannel(old, config);
        }
        await store.updateTemplate(id, fields);
        await refreshSettings();
        return await reply({ content: `✅ تم ${sub} القالب. يسري على التعيينات الجديدة. مهام اليوم المسندة وتقدمها ومكافآتها محفوظة.` });
      }
      if (name === 'اعدادات_الحضور') {
        const fields = {};
        const minPeople = interaction.options.getInteger('اقل_عدد');
        if (minPeople !== null) fields.minPeople = minPeople;
        for (const [key, option] of [['ignoreMuted', 'تجاهل_الميوت'], ['ignoreDeafened', 'تجاهل_الديفن']]) {
          const value = interaction.options.getBoolean(option); if (value !== null) fields[key] = value;
        }
        if (Object.keys(fields).length) { await store.setAttendance(fields); await refreshSettings(); }
        const { attendance: a } = await store.settings();
        return await reply({ embeds: [themedEmbed('إعدادات احتساب الصوت', appearance)
          .setDescription(clanVoiceChannels(config).map(id => `<#${id}>`).join('، '))
          .addFields(
            { name: 'أقل عدد بشر', value: `**${a.minPeople}** في الروم`, inline: true },
            { name: 'الميوت', value: a.ignoreMuted ? 'لا يُحتسب' : 'يُحتسب', inline: true },
            { name: 'الديفن', value: a.ignoreDeafened ? 'لا يُحتسب' : 'يُحتسب', inline: true },
            { name: 'مكافأة الحضور', value: a.enabled ? `${a.points} $ لكل ${a.intervalMs / 60000} دقائق • سقف ${a.dailyCap} $ يوميًا` : 'موقوفة', inline: false },
            { name: 'تطبيق الشروط', value: 'تنطبق الشروط على المهام الصوتية والحضور وتوب الفويس تلقائيًا؛ الوقت متراكم بين الرومات ولا يتطلب قبول مهمة. تعديل الشروط لا يصفر التقدم.' }
          )] });
      }
      if (name === 'حالة_البوت') {
        const s = status();
        const errors = [];
        const checks = [...new Set([config.generalChannelId, config.clanChatChannelId, config.feelingChannelId, config.lookChannelId])].map(channelId => ({ channelId, type: 'messages' }));
        checks.push({ channelId: config.gamesChannelId, type: 'games' });
        const voiceChannels = clanVoiceChannels(config);
        checks.push(...voiceChannels.map(channelId => ({ channelId, type: 'voice' })));
        for (const item of checks) {
          try { await validateChannel(item.channelId, item.type); }
          catch (error) { errors.push(error.message); }
        }
        await store.db.command({ ping: 1 });
        return await reply({ embeds: [themedEmbed('حالة البوت والاحتساب', appearance)
          .setDescription(`**${dayKey(Date.now())}** • الأعضاء المؤهلون **${s.memberCount}**`)
          .addFields(
            { name: 'البوت الرسمي', value: s.bot ? '🟢 متصل' : '🔴 متوقف', inline: true },
            { name: 'القارئ', value: s.observer ? '🟢 متصل' : '🔴 متوقف', inline: true },
            { name: 'الاحتساب', value: s.tracking ? '🟢 يعمل' : '🔴 متوقف', inline: true },
            { name: 'قاعدة البيانات', value: '🟢 متصلة', inline: true },
            ...(s.recovery ? [{ name: 'الاستعادة التلقائية', value: s.recovery.running ? '⏳ جارٍ استكمال عمليات الحفظ' : s.recovery.retryAt > Date.now() ? `إعادة المحاولة <t:${Math.ceil(s.recovery.retryAt / 1000)}:R>` : '🟢 المراقبة تعمل' }] : []),
            ...(s.reader?.authFailed ? [{ name: 'توكن القارئ', value: 'رُفض الاتصال. استخدم /تحديث التوكن لإدخال قيمة جديدة.' }] : []),
            ...(s.reader?.reconnecting ? [{ name: 'إعادة اتصال القارئ', value: '⏳ جارٍ فحص اتصال جديد' }] : []),
            ...(s.membership ? [{ name: 'التحقق من الأعضاء', value: membershipStatusText(s.membership) }] : []),
            ...(s.trackingReason ? [{ name: 'سبب توقف الاحتساب', value: s.trackingReason }] : []),
            { name: 'آخر رسالة محتسبة', value: s.lastMessageAt ? `<t:${Math.floor(s.lastMessageAt / 1000)}:R>` : 'لم تُسجل بعد', inline: true },
            { name: 'آخر تحديث صوت', value: s.lastVoiceAt ? `<t:${Math.floor(s.lastVoiceAt / 1000)}:R>` : 'لم يُسجل بعد', inline: true },
            { name: 'الرومات', value: errors.length ? errors.join('\n').slice(0, 1024) : '✅ القنوات الأساسية متاحة للقارئ.' },
            { name: 'شاتات مهمة الرسائل', value: `<#${config.generalChannelId}> • <#${config.clanChatChannelId}>` },
            { name: 'نظام المهام', value: 'جميع المهام تتقدم تلقائيًا وتبدأ من جديد يوميًا الساعة 12 ليلًا بتوقيت السعودية. اكتب مهامي لعرض التقدم. ترتيب النشاط مستقل عن العملة.' },
            { name: 'التحقق من الرصد', value: 'اختبر رسالة ودخول عضو وخروجه. الاتصال وحده لا يثبت وصول جميع أحداث القارئ.' }
          )] });
      }
    } catch (error) {
      ctx.onError(error);
      // Only our validation errors are exposed; remote errors can contain request secrets.
      const text = error instanceof Error && /[\u0600-\u06ff]/.test(error.message) ? error.message : 'تعذر تنفيذ الأمر. راجع حالة الاتصال وسجل Render.';
      await reply({ content: `❌ ${text}`, embeds: [], components: [] });
    }
  };
}

function validateGameChannel(task, config) {
  if (task.type === 'games' && task.channelId !== config.gamesChannelId) throw new Error('مهمة الألعاب يجب أن تستخدم شات الألعاب المحدد في ARENA_GAMES_CHANNEL_ID.');
}

export async function checkSourceChannel(source, guildId, id, type) {
  if (!isId(id)) throw new Error('ID الروم غير صالح.');
  if (!source?.isReady()) throw new Error('القارئ غير متصل بأرينا حاليًا.');
  const channel = source.channels.cache.get(id);
  if (!channel || channel.guild?.id !== guildId) throw new Error(`الروم ${id} غير متاح للحساب داخل أرينا.`);
  const view = channel.permissionsFor(source.user)?.has(1024n) ?? false;
  if (!view) throw new Error(`الحساب لا يملك صلاحية مشاهدة الروم ${id}.`);
  const voiceType = [2, 13, 'GUILD_VOICE', 'GUILD_STAGE_VOICE'].includes(channel.type);
  const textType = [0, 5, 10, 11, 12, 'GUILD_TEXT', 'GUILD_NEWS', 'GUILD_NEWS_THREAD', 'GUILD_PUBLIC_THREAD', 'GUILD_PRIVATE_THREAD'].includes(channel.type);
  if (type === 'voice' ? !voiceType : !textType) throw new Error('نوع الروم لا يطابق نوع المهمة.');
  return channel;
}
import { membershipUnavailable, membershipStatusText } from './membership-status.js';
