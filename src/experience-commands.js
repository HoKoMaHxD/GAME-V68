import { bankMenuPayload } from './bank-menu.js';
import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { readAppearance } from './appearance.js';
import { rankPanel, parseRankAction, activityView } from './activity-views.js';
import { canManageBot, MANAGEMENT_DENIED } from './permissions.js';
import { requireBankChannel } from './bank.js';

const rankCommands = new Set(['ترتيبي', 'المتصدرين']);
const descriptions = { 'اوامر': 'إرسال قائمة أوامر العملة والمهمات في شات البنك', 'ترتيبي': 'للإدارة: إرسال زر الترتيب الشخصي والمتصدرين للجميع',
  'المتصدرين': 'للإدارة: إرسال لوحة ترتيبي الشخصي نفسها للشات والفويس',
  'مهمتي': 'عرض مهامك اليومية التلقائية وتقدمك حتى منتصف الليل السعودي' };
export function buildExperienceCommands() {
  return Object.entries(descriptions).map(([name, description]) => {
    const command = new SlashCommandBuilder().setName(name).setDescription(description);
    // Keep the delegated /صلاحية role able to invoke publishing commands;
    // execution checks the current management permission below.
    if (rankCommands.has(name)) command.setDefaultMemberPermissions(null);
    return command;
  });
}
export function commandsPanel(appearance = {}, guild = null) {
  const name = guild?.name || readAppearance(appearance).name;
  const iconURL = guild?.iconURL?.({ extension: 'png', size: 128 });
  const entries = [
    ['رصيدي', 'عرض رصيدك البنكي'],
    ['راتب', 'استلام راتبك كل ساعة'],
    ['توب البنك', 'جميع المشاركين مع صفحات وتحديث'],
    ['نهب', 'محاولة نهب عضو'],
    ['ارقام @عضو المبلغ', 'اختر رقمًا أو رقمين؛ النهاية عشوائية بين 15 و25، ومن يأخذ آخر رقم يخسر مبلغ التحدّي'],
    ['الغام @عضو المبلغ', 'تحدّي لغم ضد عضو؛ من يختار اللغم يخسر مبلغ التحدّي'],
    ['تشابه', 'لعبة ذاكرة: 8 أزواج بمستوى عشوائي (سهل / متوسط / صعب)، الربح والخسارة 5%–10%، كل 20 دقيقة'],
    ['سفينة @عضو المبلغ', 'جهّز أسطولك سرًا؛ اختر الصف والعمود لإغراق السفن الست'],
    ['مربعات @عضو المبلغ', 'وصّل النقاط؛ من يكمل مربعًا يملكه ويلعب مجددًا، وصاحب أكثر مربعات يفوز'],
    ['دوت @عضو المبلغ', 'وصّل 4 أقراص للفوز؛ اختر العمود من الأزرار'],
    ['زر @عضو المبلغ', 'أول من يضغط الزر الأخضر يفوز بمبلغ خصمه'],
    ['اكس @عضو المبلغ', 'Infinite XO؛ لكل لاعب 3 علامات والرابعة تزيل الأقدم؛ الفائز يأخذ مبلغ خصمه'],
    ['حماية', 'عرض سعر ومدة الحماية ثم تأكيد الشراء'],
    ['مهامي', 'مهامك اليومية وتقدمك؛ تتجدد 12 ليلًا بتوقيت السعودية'],
    ['جائزة', 'الحصول على جائزة عشوائية كل ساعتين'],
    ['الوان', 'توحيد الألوان؛ ربح أو خسارة 5–10% كل 20 دقيقة'],
    ['نرد', 'النرد ضد البوت؛ ربح أو خسارة 5–10% كل 20 دقيقة'],
    ['وقت', 'عرض الوقت المتبقي للأوامر والحماية']
  ];
  const embed = new EmbedBuilder().setColor(0xffffff).setTitle('أوامر البنك')
    .setAuthor({ name, ...(iconURL ? { iconURL } : {}) })
    .setDescription(entries.map(([command, description]) => `\u200f\`\u2067-${command}\u2069\` : ${description}\u200f`).join('\n'))
    .setTimestamp();
  return { content: '', allowedMentions: { parse: [] }, embeds: [embed], components: [] };
}

export function createExperienceHandler(ctx) {
  const { config, store, service, isMember, status, access, onError = () => {} } = ctx;
  return async interaction => {
    const rank = parseRankAction(interaction.customId);
    const name = interaction.commandName;
    if (!rank && !Object.hasOwn(descriptions, name || '')) return false;
    const deny = content => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    if (interaction.guildId !== config.clanGuildId) { await deny('الأوامر متاحة في سيرفر الكلان فقط.'); return true; }
    const publishRank = rankCommands.has(name);
    if (publishRank && !canManageBot(interaction, config, access?.roleId)) {
      await deny(MANAGEMENT_DENIED); return true;
    }
    const owner = rank?.ownerId;
    if (owner && owner !== interaction.user.id) { await deny('هذه بطاقة عضو آخر. افتح بطاقتك من الزر العام أو الأمر.'); return true; }
    if (rank?.update) await interaction.deferUpdate();
    else await interaction.deferReply(name === 'اوامر' || publishRank ? {} : { flags: MessageFlags.Ephemeral });
    try {
      const settings = await store.settings(); const appearance = settings?.appearance;
      let payload;
      if (rank) payload = await activityView({ store, config, ownerId: interaction.user.id, appearance, ...rank });
      else if (name === 'اوامر') {
        requireBankChannel(settings?.bank, interaction.channelId);
        payload = bankMenuPayload();
      }
      else if (publishRank) payload = rankPanel(appearance);
      await interaction.editReply({ allowedMentions: { parse: [] }, ...payload });
    } catch (error) {
      onError(error);
      await interaction.editReply({ content: /[\u0600-\u06ff]/.test(error.message) ? `❌ ${error.message}` : 'تعذر تنفيذ الطلب. حاول مجددًا بعد التحقق من الاتصال.',
        embeds: [], components: [], allowedMentions: { parse: [] } });
    }
    return true;
  };
}

export function createTextCommands(handler, config) {
  return async message => {
    if (message.guildId !== config.clanGuildId || !message.author || message.author.bot || message.webhookId) return;
    const text = String(message.content || '').trim();
    const xo = /^(?:[!-]\s*)?(اكس|زر|الغام|ارقام|دوت|مربعات|سفينة)\s+<@!?(\d{17,20})>\s+(-?[0-9٠-٩۰-۹]+)$/.exec(text);
    const match = xo || /^(?:[!-]\s*)?(اوامر|أوامر|ترتيبي|مهامي|مهمتي|توب البنك|توب_البنك|توب|راتب|جائزة|جائزه|جايزة|جايزه|حماية|حمايه|وقت|نهب|المتصدرين|رصيدي|الوان|ألوان|نرد|تشابه)(?:\s+<@!?(\d{17,20})>)?$/.exec(text);
    if (!match) {
      if (/^(?:[!-]\s*)?(?:اكس|زر|الغام|ارقام|دوت|مربعات|سفينة)(?:\s|$)/.test(text)) await message.reply({ content: 'اكتب اسم اللعبة ثم @عضو والمبلغ، مثال: اكس @عضو 1000 أو زر @عضو 1000 أو الغام @عضو 1000 أو ارقام @عضو 1000 أو دوت @عضو 1000 أو مربعات @عضو 1000 أو سفينة @عضو 1000.', allowedMentions: { parse: [], repliedUser: false } });
      if (/^(?:[!-]\s*)?نهب(?:\s|$)/.test(text)) await message.reply({ content: 'اكتب !نهب @عضو مع منشن عضو واحد فقط.', allowedMentions: { parse: [], repliedUser: false } });
      return;
    }
    let sent;
    const reply = async payload => {
      const { flags, ...body } = payload;
      body.allowedMentions = { parse: [], repliedUser: false, ...(payload.allowedMentions?.users ? { users: payload.allowedMentions.users } : {}) };
      sent = await message.reply(body); return sent;
    };
    const interaction = { textCommand: true, commandName: match[1] === 'توب البنك' ? 'توب_البنك' : match[1] === 'أوامر' ? 'اوامر' : match[1] === 'حمايه' ? 'حماية' : ['جائزه', 'جايزة', 'جايزه'].includes(match[1]) ? 'جائزة' : match[1], id: message.id,
      user: message.author, member: message.member, guild: message.guild, guildId: message.guildId,
      channelId: message.channelId, createdTimestamp: message.createdTimestamp,
      isChatInputCommand: () => true, isButton: () => false, isStringSelectMenu: () => false,
      options: { getString: () => null, getInteger: () => xo ? Number(xo[3].replace(/[٠-٩۰-۹]/g, c => String('٠١٢٣٤٥٦٧٨٩'.includes(c) ? '٠١٢٣٤٥٦٧٨٩'.indexOf(c) : '۰۱۲۳۴۵۶۷۸۹'.indexOf(c)))) : null, getUser: () => match[2] ? message.mentions?.users?.get(match[2]) || null : null },
      deferReply: async () => {}, reply,
      editReply: async payload => sent ? sent.edit({ ...payload, allowedMentions: { parse: [], ...(payload.allowedMentions?.users ? { users: payload.allowedMentions.users } : {}) } }) : reply(payload)
    };
    await handler(interaction);
  };
}
