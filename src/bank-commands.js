import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { themedEmbed, readAppearance } from './appearance.js';
import { number, safe } from './presentation.js';
import { readBankSettings, requireBankChannel, bankCommandStatus, commandStatusLabel, bankMember, hasClanBoost, MEMBER_JOB, MAX_SALARY } from './bank.js';
import { PROTECTION_CONFIRM_MS, readProtectionSettings, requireProtectionRenewal } from './protection.js';
import { canManageBot, MANAGEMENT_DENIED } from './permissions.js';

const NAMES = new Set(['توب', 'راتب', 'جائزة', 'حماية', 'وقت', 'رصيدي', 'اعدادات_البنك']);
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const compactGap = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2, roundingMode: 'ceil' });
export const bankMoney = value => `${compact.format(value || 0)}$`;
const codeMoney = value => `$${compact.format(value || 0)}`;
const rtl = text => `\u200f${text}\u200f`;
const code = text => `\`\u2066${text}\u2069\``;
function memberCard(appearance, actor, footer, timestamp = Date.now()) {
  const name = actor.member?.displayName || actor.member?.nick || actor.user?.globalName || actor.user?.username || 'عضو الكلان';
  const iconURL = actor.member?.displayAvatarURL?.({ extension: 'png', size: 128 })
    || actor.user?.displayAvatarURL?.({ extension: 'png', size: 128 });
  return new EmbedBuilder().setColor(0xffffff)
    .setAuthor({ name: name.slice(0, 256), ...(iconURL ? { iconURL } : {}) })
    .setFooter({ text: `${readAppearance(appearance).name} ${footer}` }).setTimestamp(timestamp);
}
const rankNames = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع', 'الثامن', 'التاسع', 'العاشر',
  'الحادي عشر', 'الثاني عشر', 'الثالث عشر', 'الرابع عشر', 'الخامس عشر', 'السادس عشر', 'السابع عشر', 'الثامن عشر', 'التاسع عشر', 'العشرين'];
export function buildBankCommands() {
  return [new SlashCommandBuilder().setName('توب').setDescription('توب البنك: أعلى 10 أرصدة عملة وترتيبك الشخصي'),
    new SlashCommandBuilder().setName('راتب').setDescription('استلام راتبك كل ساعة؛ مدير كبير لمبوست سيرفر الكلان براتب أساسي 2000–3500'),
    new SlashCommandBuilder().setName('جائزة').setDescription('اسحب جائزة عشوائية مرة كل ساعتين'),
    new SlashCommandBuilder().setName('حماية').setDescription('للإدارة: إعداد سعر الحماية ومدتها والسماح بتمديدها')
      .addIntegerOption(o => o.setName('السعر').setDescription('سعر شراء الحماية').setMinValue(1).setMaxValue(1000000000))
      .addIntegerOption(o => o.setName('المدة_بالدقائق').setDescription('مدة الحماية المضافة بالدقائق؛ 180 تعني 3 ساعات').setMinValue(1).setMaxValue(525600))
      .addBooleanOption(o => o.setName('السماح_بالتمديد').setDescription('نعم: شراء متكرر وإضافة الوقت؛ لا: الشراء في آخر دقيقة فقط')),
    new SlashCommandBuilder().setName('وقت').setDescription('استعراض وقت الأوامر والألعاب والحماية برسالة خاصة لك في الشات'),
    new SlashCommandBuilder().setName('رصيدي').setDescription('عرض رصيد عملتك الحالي فقط'),
    new SlashCommandBuilder().setName('اعدادات_البنك').setDescription('للإدارة: ضبط شات البنك والراتب وتشغيل أو إيقاف راتب ونهب')
      .setDefaultMemberPermissions(null)
      .addChannelOption(option => option.setName('الروم').setDescription('الشات المخصص لأوامر البنك في سيرفر الكلان').addChannelTypes(ChannelType.GuildText))
      .addIntegerOption(option => option.setName('الراتب').setDescription('راتب عضو الكلان كل ساعة؛ راتب المبـوست 2000–3500، وصفر يوقف الجميع').setMinValue(0).setMaxValue(MAX_SALARY))
      .addStringOption(option => option.setName('حالة_الراتب').setDescription('تشغيل أو إيقاف أمر راتب مع حفظ المبلغ ومهلة الأعضاء')
        .setChoices({ name: '🟢 شغال', value: 'on' }, { name: '🔴 طافي', value: 'off' }))
      .addStringOption(option => option.setName('حالة_النهب').setDescription('تشغيل أو إيقاف النهب؛ الإيقاف يمنع أزرار التحديات السابقة')
        .setChoices({ name: '🟢 شغال', value: 'on' }, { name: '🔴 طافي', value: 'off' }))];
}

export function balancePayload(balance, appearance = {}, actor = {}) {
  const embed = memberCard(appearance, actor, 'Pay').setDescription(rtl('رصيدك البنكي'))
    .addFields({ name: 'الرصيد', value: code(bankMoney(balance.total)) });
  return { content: '', embeds: [embed], components: [], allowedMentions: { parse: [] } };
}

export function commandTimesLauncher(userId) {
  return { content: 'اضغط الزر لاستعراض أوقاتك المتبقية.', embeds: [], allowedMentions: { parse: [] },
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`bank-time:v1:${userId}`).setLabel('استعراض الوقت').setStyle(ButtonStyle.Primary))] };
}
export function commandTimesPayload(view, appearance = {}, actor = {}) {
  const deadline = at => {
    const seconds = Math.ceil(Math.max(0, at - view.at) / 1000);
    const duration = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
      .map(value => String(value).padStart(2, '0')).join(':');
    return `باقي ${code(duration)}\n<t:${Math.ceil(at / 1000)}:R> — <t:${Math.ceil(at / 1000)}:t>`;
  };
  const available = entry => entry.status === 'disabled' ? '🔴 الأمر موقوف حاليًا من الإدارة.'
    : entry.status === 'cooldown' ? `⏳ ${deadline(entry.nextAt)}` : '✅ متاح الآن';
  const quest = view.quest.status === 'ineligible' ? 'تحتاج عضوية الكلان ورتبته في أرينا لاستخدام المهام.'
    : `📋 المهام متاحة تلقائيًا • ${view.quest.completed || 0} / ${view.quest.total || 6} مكتملة.\nالتجديد 12 ليلًا بتوقيت السعودية.\n${deadline(view.quest.resetsAt)}\nاكتب مهامي لعرض تقدمك.`;
  const robbery = view.robbery.status === 'blocked'
    ? `🚫 ممنوع من بدء نهب جديد بسبب تكرار الأمر بسرعة.\n${deadline(view.robbery.nextAt)}${view.robbery.expiresAt ? '\nتقدر تكمل تحديك المفتوح.' : ''}`
    : view.robbery.status === 'open'
    ? `عندك تحدي نهب مفتوح. أكمله قبل انتهاء الوقت.\n${deadline(view.robbery.expiresAt)}`
    : view.robbery.status === 'ready' ? '✅ ما عليك انتظار. تقدر تبدأ تحديًا ضد عضو غير محمي.' : available(view.robbery);
  const protection = view.protection.status === 'active' ? `🛡️ حمايتك سارية.\n${deadline(view.protection.expiresAt)}`
    : 'لا توجد حماية سارية.';
  const embed = memberCard(appearance, actor, 'Time', view.at)
    .setTitle('وقت أوامرك').setDescription(rtl('الوقت المتبقي بصيغة ساعات:دقائق:ثوانٍ عند إرسال البطاقة. اضغط زر استعراض الوقت مرة أخرى لتحديثها. انتظار ألعاب التحدّي على الإرسال فقط، واستقبال تحديات الآخرين متاح أثناءه؛ يلزم انتهاء أي جولة نشطة أولًا.'))
    .addFields(
      { name: '💵 راتب — كل ساعة', value: rtl(available(view.salary)) },
      { name: '🎁 جائزة — كل ساعتين', value: rtl(available(view.prize)) },
      { name: '📋 مهامي', value: rtl(quest) },
      ...(view.memory ? [{ name: '🧠 تشابه — كل 20 دقيقة', value: rtl(available(view.memory)) }] : []),
      ...(view.colors ? [{ name: '🎨 ألوان — كل 20 دقيقة', value: rtl(available(view.colors)) }] : []),
      ...(view.dice ? [{ name: '🎲 نرد — كل 20 دقيقة', value: rtl(available(view.dice)) }] : []),
      ...[['xo', '❌ اكس'], ['numbers', '🔢 ارقام'], ['buttonGame', '🟢 زر'], ['mines', '💣 الغام'], ['dot', '🔴 دوت'], ['boxes', '🔲 مربعات'], ['ship', '🚢 سفينة']].filter(([key]) => view[key]).map(([key, name]) => ({ name: `${name} — إرسال تحدّي`, value: rtl(available(view[key])) })),
      { name: 'نهب', value: rtl(robbery) },
      { name: 'حماية من النهب', value: rtl(`${protection}\nاكتب حماية لعرض سعر ومدة الحماية وشروط التجديد الحالية.`) }
    );
  return { content: '', embeds: [embed], components: [], allowedMentions: { parse: [] } };
}

export function bankTopPayload(view, appearance = {}, guild = null) {
  const brand = readAppearance(appearance);
  const name = guild?.name || brand.name;
  const iconURL = guild?.iconURL?.({ extension: 'png', size: 256 }) || null;
  const embed = new EmbedBuilder().setTitle('توب البنك').setColor(0xffffff)
    .setAuthor({ name, ...(iconURL ? { iconURL } : {}) })
    .setFooter({ text: name, ...(iconURL ? { iconURL } : {}) }).setTimestamp(view.at)
    .setThumbnail(iconURL)
    .setDescription(view.rows.length ? view.rows.map((row, i) => `\`#${i + 1}\` <@${row._id}> 💵 **${bankMoney(row.total)}**`).join('\n')
      : 'لا توجد أرصدة عملة في البنك حتى الآن.');
  const position = view.self.position ? `#${number(view.self.position)}` : 'غير مصنف';
  const note = view.self.position === 1 ? 'أنت في المركز الأول 🏆'
    : `متبقي \`$${compactGap.format(view.gap)}\` عشان توصل للمركز ${rankNames[view.nextPosition - 1] || number(view.nextPosition)}`;
  embed.addFields({ name: 'ترتيبك', value: `\u200f\`${position}\` - رصيدك: \`${codeMoney(view.self.value)}\`\n${note}` });
  return { content: '', embeds: [embed], components: [], allowedMentions: { parse: [] } };
}
export function salaryPayload(result, userId, appearance = {}, actor = {}) {
  const embed = memberCard(appearance, actor, 'Pay', result.claimedAt);
  if (result.status === 'cooldown') embed.setDescription(rtl(`⏳ استلمت راتبك بالفعل. تقدر تستلمه مجددًا <t:${Math.ceil(result.nextAt / 1000)}:R>.`));
  else {
    embed.setDescription([
      rtl(result.duplicate ? 'راتب هذا الطلب مسجل مسبقًا' : 'نزل لك راتبك'),
      rtl(`**الوظيفة:** ${safe(result.job || MEMBER_JOB)}`)
    ].join('\n\n')).addFields(
      { name: 'الراتب', value: code(bankMoney(result.amount)) },
      { name: 'رصيدك', value: code(bankMoney(result.after)) }
    );
    if (result.bonusId) embed.addFields({ name: 'زيادة الجائزة', value: rtl(
      `${code(`${result.bonusPercent}%`)} — ${code(bankMoney(result.bonusAmount))} زيادة على الراتب الأساسي، استُخدمت لمرة واحدة.`) });
  }
  return { content: '', embeds: [embed], components: [], allowedMentions: { parse: [] } };
}
export function prizePayload(result, userId, appearance = {}, actor = {}) {
  const embed = memberCard(appearance, actor, 'Prize', result.claimedAt);
  if (result.status === 'cooldown') {
    embed.setDescription(rtl(`⏳ تقدر تطلب جائزة جديدة <t:${Math.ceil(result.nextAt / 1000)}:R>.`));
  } else {
    const descriptions = {
      quest_wait: ['💵 زيادة الراتب', `تحولت جائزة انتظار المهمة إلى زيادة ${code(`${result.percent}%`)} على الراتب لمرة واحدة.`],
      salary: ['💵 زيادة الراتب', `يزيد راتبك القادم ${code(`${result.percent}%`)} لمرة واحدة.`],
      money: ['💵 هدية عملة', `تحصل على ${code(codeMoney(result.amount))} فورًا`]
    };
    const [label, detail] = descriptions[result.type];
    embed.setDescription([rtl(`**${label}**`), rtl(detail),
      ...(result.duplicate ? [rtl('جائزة هذا الطلب محفوظة مسبقًا.')] : [])].join('\n\n'));
  }
  return { content: '', embeds: [embed], components: [], allowedMentions: { parse: [] } };
}
export function protectionPayload(result, appearance = {}, actor = {}) {
  const expires = Math.ceil(result.protection.expiresAt / 1000);
  const embed = memberCard(appearance, actor, 'Protection', result.purchasedAt || Date.now())
    .setDescription(rtl(result.duplicate ? '🛡️ شراء الحماية لهذا الطلب مسجل مسبقًا. لم يتكرر الخصم أو التمديد.'
      : result.previousExpiresAt ? '🛡️ تم تمديد حمايتك من النهب وإضافة المدة إلى الوقت المتبقي.'
        : '🛡️ تم شراء الحماية من النهب.'))
    .addFields(
      { name: 'انتهاء الحماية', value: `<t:${expires}:f>\n<t:${expires}:R>` },
      { name: 'المدة المضافة', value: `${(result.addedDurationMs || 10800000) / 60000} دقيقة` },
      { name: 'سعر الحماية', value: code(`${number(result.price)} $`) },
      { name: 'الرصيد بعد الشراء', value: code(bankMoney(result.after)) }
    );
  return { content: '', embeds: [embed], components: [], allowedMentions: { parse: [] } };
}
export async function checkBankChannel(bot, config, channelId) {
  const channel = await bot.channels.fetch(channelId);
  if (!channel || channel.guildId !== config.clanGuildId || channel.type !== ChannelType.GuildText) throw new Error('اختر شاتًا كتابيًا عاديًا في سيرفر الكلان للبنك.');
  if (!channel.permissionsFor(bot.user)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory])) throw new Error('البوت يحتاج مشاهدة شات البنك وقراءة الرسائل وإرسالها وتضمين الروابط.');
}
export function createBankHandler({ config, store, service, bot, access, isBankMember, isMember, onError = () => {}, scheduleProtectionExpiry = setTimeout }) {
  return async interaction => {
    const purchaseAction = /^protect:(\d{17,20}):(\d{17,20}):(\d{13}):(\d{1,10}):(\d{1,6}):([01])$/.exec(interaction.customId || '');
    const name = interaction.commandName;
    if (!NAMES.has(name) && !purchaseAction) return false;
    const protectionAdmin = name === 'حماية' && !interaction.textCommand;
    const admin = name === 'اعدادات_البنك' || protectionAdmin;
    const replyError = content => interaction.reply({ content, ...(admin ? { flags: MessageFlags.Ephemeral } : {}), allowedMentions: { parse: [] } });
    if (interaction.guildId !== config.clanGuildId || interaction.user.bot) { await replyError('أوامر البنك متاحة لأعضاء سيرفر الكلان فقط.'); return true; }
    if (admin && !canManageBot(interaction, config, access?.roleId)) { await replyError(MANAGEMENT_DENIED); return true; }
    if (purchaseAction && purchaseAction[1] !== interaction.user.id) {
      await interaction.reply({ content: 'زر التأكيد خاص بصاحب طلب الحماية فقط.', flags: MessageFlags.Ephemeral }); return true;
    }
    if (purchaseAction) await interaction.deferUpdate();
    else await interaction.deferReply(admin ? { flags: MessageFlags.Ephemeral } : {});
    const reply = payload => interaction.editReply({ content: '', embeds: [], components: [], allowedMentions: { parse: [] }, ...payload });
    try {
      const settings = await store.settings(); const appearance = settings?.appearance;
      if (purchaseAction) {
        const [, userId, id, at, price, minutes, stack] = purchaseAction;
        const eligible = uid => isBankMember ? isBankMember(uid) : bankMember(interaction, config, uid);
        const result = await service.buyProtection({ id, userId, channelId: interaction.channelId, at: Number(at),
          quote: { protectionPrice: Number(price), protectionMinutes: Number(minutes), protectionStack: stack === '1' } }, eligible);
        const payload = protectionPayload(result, appearance, interaction);
        payload.components = [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(interaction.customId)
          .setLabel('تم شراء الحماية').setStyle(ButtonStyle.Success).setDisabled(true))];
        await reply(payload);
      } else if (protectionAdmin) {
        const fields = {};
        for (const [option, key] of [['السعر', 'protectionPrice'], ['المدة_بالدقائق', 'protectionMinutes']]) {
          const value = interaction.options.getInteger(option);
          if (value !== null) fields[key] = value;
        }
        const stack = interaction.options.getBoolean('السماح_بالتمديد');
        if (stack !== null) fields.protectionStack = stack;
        const bank = Object.keys(fields).length ? await service.configureBank({ actorId: interaction.user.id,
          operationId: interaction.id, ...fields }) : readBankSettings(settings?.bank);
        const p = readProtectionSettings(bank);
        await reply({ embeds: [themedEmbed('إعدادات الحماية', appearance).setDescription(
          `السعر: **${number(p.protectionPrice)} $**\nالمدة: **${p.protectionMinutes} دقيقة**\nالتجديد: **${p.protectionStack ? 'مسموح في أي وقت، وتُضاف المدة إلى المتبقي' : 'مسموح في آخر دقيقة فقط أو بعد انتهاء الحماية'}**\nيكتب العضو حماية ثم يضغط تأكيد الشراء.`)] });
      } else if (admin) {
        const channel = interaction.options.getChannel('الروم');
        const salary = interaction.options.getInteger('الراتب');
        const switches = {};
        for (const [option, field] of [['حالة_الراتب', 'salaryEnabled'], ['حالة_النهب', 'robberyEnabled']]) {
          const value = interaction.options.getString?.(option) ?? null;
          if (value === null) continue;
          if (!['on', 'off'].includes(value)) throw new Error('اختر شغال أو طافي لحالة الأمر.');
          switches[field] = value === 'on';
        }
        let bank = readBankSettings(settings?.bank);
        if (channel || salary !== null || Object.keys(switches).length) {
          if (channel) await checkBankChannel(bot, config, channel.id);
          bank = await service.configureBank({ actorId: interaction.user.id, operationId: interaction.id,
            ...(channel ? { channelId: channel.id } : {}), ...(salary !== null ? { salaryAmount: salary } : {}), ...switches });
        }
        const enabled = bankCommandStatus(bank);
        await reply({ embeds: [themedEmbed('إعدادات البنك', appearance).setDescription(
          `شات الأوامر: ${bank.channelId ? `<#${bank.channelId}>` : '**لم يحدد**'}\n`
          + `حالة راتب: ${commandStatusLabel(enabled.salary)}\nحالة نهب: ${commandStatusLabel(enabled.robbery)}\n`
          + `مبلغ الراتب المحفوظ: ${bank.salaryAmount ? `**${number(bank.salaryAmount)} $** كل **ساعة**` : '**لم يحدد؛ يلزم مبلغ أكبر من صفر لتشغيل راتب**'}\n\n`
          + '**مدير كبير:** للمبوست الفعلي لسيرفر الكلان؛ الراتب الأساسي عشوائي من **2,000 إلى 3,500 $** كل ساعة، ثم تُضاف جائزة زيادة الراتب إن وجدت.\n\n'
          + 'الأوامر المشغلة متاحة للجميع في شات البنك فقط. اكتب اوامر لعرض حالتها الحالية.')] });
      } else {
        requireBankChannel(settings?.bank, interaction.channelId);
        const eligible = id => isBankMember ? isBankMember(id) : bankMember(interaction, config, id);
        if (name === 'توب') await reply(bankTopPayload(await service.bankTop(interaction.user.id, interaction.channelId), appearance,
          interaction.guild || bot?.guilds?.cache?.get(config.clanGuildId)));
        else if (name === 'رصيدي') await reply(balancePayload(await service.balance(interaction.user.id, interaction.channelId), appearance, interaction));
        else if (name === 'وقت') await reply(commandTimesLauncher(interaction.user.id));
        else if (name === 'جائزة') await reply(prizePayload(await service.claimPrize({ id: interaction.id, userId: interaction.user.id,
          channelId: interaction.channelId, at: interaction.createdTimestamp }, eligible), interaction.user.id, appearance, interaction));
        else if (name === 'حماية') {
          if (!await eligible(interaction.user.id)) throw new Error('الحماية متاحة لأعضاء سيرفر الكلان فقط.');
          const p = readProtectionSettings(settings?.bank);
          const now = service.clock();
          const current = await store.robbery.activeProtection(interaction.user.id, now);
          requireProtectionRenewal(p, current, now);
          const quoteAt = service.clock();
          const customId = `protect:${interaction.user.id}:${interaction.id}:${quoteAt}:${p.protectionPrice}:${p.protectionMinutes}:${p.protectionStack ? 1 : 0}`;
          await reply({ embeds: [memberCard(appearance, interaction, 'Protection').setDescription(rtl(
            `🛡️ هل تريد شراء الحماية؟\nالسعر: **${number(p.protectionPrice)} $**\nالمدة المضافة: **${p.protectionMinutes} دقيقة**\n${p.protectionStack ? 'يمكنك الشراء مجددًا وتُضاف المدة إلى الوقت المتبقي.' : 'التجديد متاح في آخر دقيقة من الحماية الحالية فقط أو بعد انتهائها.'}\n${current ? `حمايتك الحالية تنتهي <t:${Math.ceil(current.expiresAt / 1000)}:R>.\n` : ''}يُخصم المبلغ عند التأكيد فقط. الطلب صالح لمدة 30 ثانية.`))],
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(customId).setLabel('تأكيد الشراء').setStyle(ButtonStyle.Success))] });
          const timer = scheduleProtectionExpiry(() => {
            // Serialize expiry with wallet operations so it cannot overwrite a successful confirmation.
            return service.gate.exclusive(async () => {
              if (service.paused) return;
              if (await store.robbery.protectionPurchase(interaction.id)) return;
              await interaction.editReply({ components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(customId).setLabel('انتهت مهلة التأكيد')
                  .setStyle(ButtonStyle.Secondary).setDisabled(true))] });
            }).catch(onError);
          }, Math.max(0, quoteAt + PROTECTION_CONFIRM_MS - service.clock()));
          timer?.unref?.();
        }
        else await reply(salaryPayload(await service.claimSalary({ id: interaction.id, userId: interaction.user.id,
          channelId: interaction.channelId, at: interaction.createdTimestamp }, eligible,
        id => hasClanBoost(interaction.guild || bot?.guilds?.cache?.get(config.clanGuildId), config.clanGuildId, id, true)), interaction.user.id, appearance, interaction));
      }
    } catch (error) {
      onError(error);
      await reply({ content: '❌ ' + (/[\u0600-\u06ff]/.test(error.message) ? error.message : 'تعذر تنفيذ أمر البنك. تحقق من الاتصال وحاول مجددًا.') });
    }
    return true;
  };
}
